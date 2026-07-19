"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");
const core = require("../src/plr/core");
const { createServer } = require("../src/server");

function syntheticPlr() {
  const dataOffset = 4, recordSize = 6, totalRecords = 8;
  const bytes = new Uint8Array(dataOffset + recordSize * totalRecords);
  bytes.set(Buffer.from("MCA\0"));
  const view = new DataView(bytes.buffer);
  const start = 6;
  const temperatures = [10, 20, 30, 40];
  temperatures.forEach((temperature, row) => {
    const physical = (start + row) % totalRecords;
    view.setInt16(dataOffset + physical * recordSize + 2, temperature * 48, true);
    view.setInt16(dataOffset + physical * recordSize + 4, (temperature + 5) * 48, true);
  });
  return core.parsePlr(bytes, { dataOffset, recordSize, totalRecords, rawPerCelsius: 48, validChannels: [1, 2] });
}

function syntheticExcel() {
  const base = new Date(2024, 0, 1, 8, 0, 0);
  return {
    rows: [10, 20, 30, 40].map((temperature, index) => ({
      index, date: new Date(base.getTime() + index * 120000),
      time: core.formatDate(new Date(base.getTime() + index * 120000)),
      channels: { 1: temperature, 2: temperature + 5 },
    })),
    channels: [1, 2], start: base, end: new Date(base.getTime() + 360000), intervalMinutes: 2,
  };
}

function complianceSession(values, intervalMinutes = 2) {
  const base = new Date(2024, 0, 1, 8, 0, 0);
  const rows = values.map((temperature, index) => {
    const date = new Date(base.getTime() + index * intervalMinutes * 60000);
    return { index, date, time: core.formatDate(date), physicalRecordIndex: index };
  });
  return {
    createdAt: "2024-01-01T00:00:00.000Z",
    rows,
    channels: { 1: { original: values.slice(), targets: values.slice() } },
    usableChannels: [1],
    customerRequirements: [],
    excel: {
      rows,
      channels: [1],
      start: rows[0].date,
      end: rows[rows.length - 1].date,
      intervalMinutes,
    },
    plr: {
      signature: "MCA",
      data: new Uint8Array(64),
      layout: { intervalMinutes },
    },
    alignment: { startRecordIndex: 0 },
    scale: 48,
  };
}

function maximumWindowRise(values, start, end, windowPoints) {
  let maximum = -Infinity;
  for (let i = start + windowPoints; i <= end; i++) {
    maximum = Math.max(maximum, values[i] - values[i - windowPoints]);
  }
  return maximum;
}

function maximumWindowFluctuation(values, start, end, windowPoints) {
  let maximum = 0;
  for (let i = start; i <= end; i++) {
    const samples = values.slice(Math.max(start, i - windowPoints), i + 1).filter(Number.isFinite);
    if (samples.length > 1) maximum = Math.max(maximum, Math.max(...samples) - Math.min(...samples));
  }
  return maximum;
}

test("解析 DMR Excel，识别通道和无效温度", () => {
  const rows = [
    ["编号", "时间", "通道01(℃)", "通道02(℃)"],
    [1, "2024/01/01 08:00:00", 20, -32640],
    [2, "2024/01/01 08:02:00", 21, 22],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows), workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "sheet1");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xls" });
  const parsed = core.parseExcelBytes(buffer);
  assert.deepEqual(parsed.channels, [1, 2]);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].time, "2024-01-01 08:00:00");
  assert.equal(parsed.rows[0].channels[1], 20);
  assert.equal(parsed.rows[0].channels[2], null);
});

test("自动对齐可识别跨环形缓冲区的物理起点", () => {
  const plr = syntheticPlr(), excel = syntheticExcel();
  const alignment = core.alignExcelToPlr(excel, plr, { sampleCount: 10 });
  assert.equal(alignment.startRecordIndex, 6);
  assert.equal(alignment.meanAbsError, 0);
  const session = core.buildSession(plr, excel, alignment);
  assert.deepEqual(session.rows.map(row => row.physicalRecordIndex), [6, 7, 0, 1]);
});

test("按真实温差修改 raw，且只改变计划字段", () => {
  const plr = syntheticPlr(), excel = syntheticExcel();
  const session = core.buildSession(plr, excel, core.alignExcelToPlr(excel, plr));
  session.channels[1].targets[2] = 35;
  const result = core.createModifiedPlr(session);
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].physicalRecordIndex, 0);
  assert.equal(result.edits[0].deltaRaw, 5 * 48);
  assert.equal(result.diff.headerChanged, false);
  assert.equal(result.diff.unexpectedBytes, 0);
  const modified = { ...plr, data: result.buffer };
  assert.equal(core.readRaw(modified, 0, 1), 35 * 48);
  assert.equal(core.readRaw(modified, 0, 2), 35 * 48);
});

test("校验器拒绝头部或非目标字节变化", () => {
  const plr = syntheticPlr(), modified = { ...plr, data: new Uint8Array(plr.data) };
  modified.data[0] ^= 1;
  assert.throws(() => core.validateModifiedPlr(plr, modified, []), /非计划字节变化/);
});

test("批量曲线工具支持偏移、线性、限幅、平滑和窗口温差", () => {
  assert.deepEqual(core.applyOperation([1, 2, 3], 0, 2, { mode: "offset", value: 2 }), [3, 4, 5]);
  assert.deepEqual(core.applyOperation([1, 2, 3], 0, 2, { mode: "linear", startValue: 10, endValue: 20 }), [10, 15, 20]);
  assert.deepEqual(core.applyOperation([1, 7, 12], 0, 2, { mode: "clamp", minimum: 3, maximum: 10 }), [3, 7, 10]);
  assert.deepEqual(core.applyOperation([0, 10, 0], 0, 2, { mode: "smooth", window: 3 }).map(n => Number(n.toFixed(3))), [5, 3.333, 5]);
  const limited = core.applyOperation([100, 120, 101, 130], 0, 3, { mode: "window_delta_clamp", windowMinutes: 10, maxDelta: 5, intervalMinutes: 2 });
  assert.ok(Math.max(...limited) - Math.min(...limited) <= 5);
});

test("真实燃烧波动使用相同种子可复现、不同种子产生不同结果", () => {
  const source = Array.from({ length: 240 }, (_, index) => 50 + index * 0.05);
  const operation = {
    mode: "realistic_combustion", phase: "heating", intervalMinutes: 2,
    windowMinutes: 60, maxRisePerHour: 5, amplitude: 1.5, preserveRatio: 0,
    correlationMinutes: 17, eventsPerHour: 0.9, transitionMinutes: 0, seed: "batch-A",
  };
  const first = core.applyOperation(source, 0, source.length - 1, operation);
  const repeated = core.applyOperation(source, 0, source.length - 1, operation);
  const another = core.applyOperation(source, 0, source.length - 1, { ...operation, seed: "batch-B" });
  assert.deepEqual(repeated, first);
  assert.ok(another.some((value, index) => Math.abs(value - first[index]) > 1e-9));
});

test("真实燃烧波动不是固定周期重复信号", () => {
  const source = Array.from({ length: 240 }, (_, index) => 100 + index * 0.04);
  const result = core.applyOperation(source, 0, source.length - 1, {
    mode: "realistic_combustion", phase: "heating", intervalMinutes: 2,
    windowMinutes: 60, maxRisePerHour: 5, amplitude: 1.8, preserveRatio: 0,
    correlationMinutes: 19, eventsPerHour: 1.1, transitionMinutes: 0, seed: "irregularity",
  });
  const increments = result.slice(1).map((value, index) => value - result[index]);
  for (let period = 2; period <= 60; period++) {
    const exactlyRepeated = increments.slice(period).every((value, index) => Math.abs(value - increments[index]) < 1e-10);
    assert.equal(exactlyRepeated, false, `不应以 ${period} 点为固定周期重复`);
  }
  assert.ok(new Set(increments.map(value => value.toFixed(6))).size > 180);
});

test("真实燃烧升温修复满足每小时升温不超过 5℃且只修改选区", () => {
  const source = Array.from({ length: 240 }, (_, index) => 50 + index * 0.12 + Math.sin(index / 7) * 1.5);
  const start = 20, end = 210, windowPoints = 30;
  const result = core.applyOperation(source, start, end, {
    mode: "realistic_combustion", phase: "heating", intervalMinutes: 2,
    windowMinutes: 60, maxRisePerHour: 5, amplitude: 1.5, preserveRatio: 0.5,
    correlationMinutes: 17, eventsPerHour: 0.9, transitionMinutes: 8, seed: "heating-limit",
  });
  assert.ok(maximumWindowRise(result, start, end, windowPoints) <= 5 + 1e-9);
  assert.ok(Math.min(...result.slice(start, end + 1)) > 0, "修复结果不应因重叠窗口投影发生数值发散");
  assert.ok(Math.max(...result.slice(start, end + 1)) < 100, "升温限制应保持在合理温度数量级");
  assert.deepEqual(result.slice(0, start), source.slice(0, start));
  assert.deepEqual(result.slice(end + 1), source.slice(end + 1));
});

test("真实燃烧保温修复满足每小时窗口温差不超过 5℃", () => {
  const source = Array.from({ length: 180 }, (_, index) => 800 + 8 * Math.sin(index / 4) + (index % 23 === 0 ? 5 : 0));
  const start = 10, end = 160, windowPoints = 30;
  const result = core.applyOperation(source, start, end, {
    mode: "realistic_combustion", phase: "holding", intervalMinutes: 2,
    windowMinutes: 60, maxFluctuation: 5, amplitude: 2, preserveRatio: 0.6,
    correlationMinutes: 16, eventsPerHour: 0.8, transitionMinutes: 10, seed: "holding-limit",
  });
  assert.ok(maximumWindowFluctuation(result, start, end, windowPoints) <= 5 + 1e-9);
});

test("仅修复违规段时保留远离违规窗口的合规区", () => {
  const source = Array(200).fill(100);
  for (let index = 90; index <= 110; index++) source[index] = 100 + (index - 90) * 0.5;
  const result = core.applyOperation(source, 0, source.length - 1, {
    mode: "realistic_combustion", phase: "holding", intervalMinutes: 2,
    windowMinutes: 60, maxFluctuation: 5, amplitude: 1.5, preserveRatio: 0.6,
    correlationMinutes: 16, eventsPerHour: 0.8, transitionMinutes: 6,
    onlyViolations: true, seed: "only-violations",
  });
  assert.deepEqual(result.slice(0, 60), source.slice(0, 60));
  assert.deepEqual(result.slice(150), source.slice(150));
  assert.ok(result.slice(60, 150).some((value, index) => Math.abs(value - source[index + 60]) > 1e-9));
  assert.ok(maximumWindowFluctuation(result, 0, result.length - 1, 30) <= 5 + 1e-9);
});

test("仅修复违规段不会把合规升温曲线中的短时起伏误判为小时违规", () => {
  const source = Array(100).fill(100);
  for (let index = 8; index <= 15; index++) source[index] += (index - 7) * 0.8;
  for (let index = 16; index <= 23; index++) source[index] += (24 - index) * 0.8;
  const result = core.applyOperation(source, 0, source.length - 1, {
    mode: "realistic_combustion", phase: "heating", intervalMinutes: 2,
    windowMinutes: 60, maxRisePerHour: 5, amplitude: 1.5, preserveRatio: 0.6,
    correlationMinutes: 16, eventsPerHour: 0.8, transitionMinutes: 6,
    onlyViolations: true, seed: "compliant-short-pulse",
  });
  assert.deepEqual(result, source);
});

test("客户要求校验能发现违规，并在合规修复后通过", () => {
  const source = Array.from({ length: 121 }, (_, index) => index < 61 ? 100 + index * 0.2 : 112 + 7 * Math.sin(index / 3));
  const session = complianceSession(source);
  const requirements = [
    { id: "heat", name: "升温阶段", channel: 1, phase: "heating", startIndex: 0, endIndex: 60, windowMinutes: 60, maxRisePerHour: 5 },
    { id: "hold", name: "保温阶段", channel: 1, phase: "holding", startIndex: 61, endIndex: 120, windowMinutes: 60, maxFluctuation: 5 },
  ];
  const failed = core.validateCustomerRequirements(session, requirements);
  assert.equal(failed.passed, false);
  assert.equal(failed.rules.length, 2);
  assert.ok(failed.rules.every(rule => !rule.passed));

  session.channels[1].targets = core.applyOperation(session.channels[1].targets, 0, 60, {
    mode: "realistic_combustion", phase: "heating", intervalMinutes: 2,
    windowMinutes: 60, maxRisePerHour: 5, amplitude: 1.2, preserveRatio: 0.6, seed: "customer-heating",
  });
  session.channels[1].targets = core.applyOperation(session.channels[1].targets, 61, 120, {
    mode: "realistic_combustion", phase: "holding", intervalMinutes: 2,
    windowMinutes: 60, maxFluctuation: 5, amplitude: 1.2, preserveRatio: 0.6, seed: "customer-holding",
  });
  const passed = core.validateCustomerRequirements(session, requirements);
  assert.equal(passed.passed, true);
  assert.ok(passed.rules.every(rule => rule.passed));
});

test("项目 JSON 往返保留客户要求", () => {
  const session = complianceSession(Array.from({ length: 40 }, (_, index) => 100 + index / 10));
  session.customerRequirements = [{
    id: "customer-1", name: "客户升温要求", channel: 1, phase: "heating",
    startIndex: 3, endIndex: 35, windowMinutes: 60, maxRisePerHour: 5,
  }];
  const project = JSON.parse(JSON.stringify(core.sessionProject(session)));
  const restored = complianceSession(Array.from({ length: 40 }, (_, index) => 100 + index / 10));
  core.applyProject(restored, project);
  assert.deepEqual(restored.customerRequirements, session.customerRequirements);
});

test("真实 DAT0131 样本自动纠正旧脚本的一点偏移", () => {
  const plr = core.parsePlr(fs.readFileSync(path.join(__dirname, "..", "fixtures", "DAT0131.PLR")));
  const excel = core.parseExcelBytes(fs.readFileSync(path.join(__dirname, "..", "fixtures", "curve.xls")));
  const alignment = core.alignExcelToPlr(excel, plr);
  assert.equal(alignment.startRecordIndex, 530);
  assert.ok(alignment.meanAbsError < 1);
  const session = core.buildSession(plr, excel, alignment);
  const row = session.rows.findIndex(item => item.time === "2023-11-06 15:42:00");
  assert.equal(session.rows[row].physicalRecordIndex, 701);
  session.channels[1].targets[row] = 100;
  const output = core.createModifiedPlr(session);
  assert.equal(output.edits[0].rawNew, output.edits[0].rawOld + 11 * 48);
  assert.equal(output.buffer.length, plr.data.length);
  assert.equal(output.diff.unexpectedBytes, 0);
});

test("DMR 3.20.0 真实回读 Excel 与编辑目标逐点一致", () => {
  const root = path.join(__dirname, "..");
  const plr = core.parsePlr(fs.readFileSync(path.join(root, "fixtures", "DAT0131.PLR")));
  const excel = core.parseExcelBytes(fs.readFileSync(path.join(root, "fixtures", "curve.xls")));
  const session = core.buildSession(plr, excel, core.alignExcelToPlr(excel, plr));
  session.channels[1].targets[0] = 25;
  const dmrExport = core.parseExcelBytes(fs.readFileSync(path.join(root, "fixtures", "e2e", "DAT0131_one_point_25C_DMR_export.xls")));
  const result = core.verifyDmrExport(session, dmrExport, { tolerance: 1 });
  assert.equal(result.passed, true);
  assert.equal(result.plannedTotal, 1);
  assert.equal(result.plannedMatched, 1);
  assert.equal(result.mismatched, 0);
  assert.equal(result.missing, 0);
});

test("DMR 3.20.0 回读通过线性、11 点平滑和真实燃烧合规曲线", () => {
  const root = path.join(__dirname, "..");
  const plr = core.parsePlr(fs.readFileSync(path.join(root, "fixtures", "DAT0131.PLR")));
  const excel = core.parseExcelBytes(fs.readFileSync(path.join(root, "fixtures", "curve.xls")));
  const alignment = core.alignExcelToPlr(excel, plr);
  const cases = [
    ["DAT0131_linear_90_to_110", 20],
    ["DAT0131_smooth_window_11", 119],
    ["DAT0131_realistic_heating_5Cph", 100],
  ];
  for (const [name, planned] of cases) {
    const session = core.buildSession(plr, excel, alignment);
    core.applyProject(session, JSON.parse(fs.readFileSync(path.join(root, "fixtures", "e2e", `${name}_project.json`), "utf8")));
    const exported = core.parseExcelBytes(fs.readFileSync(path.join(root, "fixtures", "e2e", `${name}_DMR_export.xls`)));
    const result = core.verifyDmrExport(session, exported, { tolerance: 1 });
    assert.equal(result.passed, true, name);
    assert.equal(result.plannedTotal, planned, name);
    assert.equal(result.plannedMatched, planned, name);
    assert.equal(result.mismatched, 0, name);
    assert.equal(result.missing, 0, name);
    if (name === "DAT0131_realistic_heating_5Cph") {
      const compliance = core.validateCustomerRequirements(session, session.customerRequirements);
      assert.equal(compliance.passed, true, name);
      assert.ok(compliance.rules[0].maximumObserved <= 5 + 1e-9, name);
    }
  }
});

test("本地服务提供健康检查、核心脚本和示例", async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).application, "DMR Curve Studio");
  assert.equal((await fetch(`http://127.0.0.1:${port}/core.js`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/fixtures/DAT0131.PLR`)).status, 200);
  const indexHtml = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(indexHtml, /id="channelDisplayList"/);
  assert.match(indexHtml, /id="showAllChannelsBtn"/);
  assert.match(indexHtml, /id="chartChannelLegend"/);
  const appScript = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
  assert.match(appScript, /displayChannels/);
  assert.match(appScript, /normalizedDisplayChannels/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/../package.json`)).status, 404);
});
