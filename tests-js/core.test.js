"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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

function maximumWindowFall(values, start, end, windowPoints) {
  let maximum = -Infinity;
  for (let i = start + windowPoints; i <= end; i++) {
    maximum = Math.max(maximum, values[i - windowPoints] - values[i]);
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

function correlation(left, right) {
  const count = Math.min(left.length, right.length);
  const leftMean = left.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
  const rightMean = right.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
  let covariance = 0, leftVariance = 0, rightVariance = 0;
  for (let index = 0; index < count; index++) {
    const a = left[index] - leftMean, b = right[index] - rightMean;
    covariance += a * b; leftVariance += a * a; rightVariance += b * b;
  }
  return covariance / Math.sqrt(leftVariance * rightVariance);
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

test("断连空白支持线性、最近值、指定温度及最长空白限制", () => {
  const source = [null, 10, null, null, 16, null, 20, null];
  assert.deepEqual(core.fillMissingValues(source, 0, source.length - 1, { method: "linear" }), [10, 10, 12, 14, 16, 18, 20, 20]);
  assert.deepEqual(core.fillMissingValues(source, 2, 5, { method: "nearest" }), [null, 10, 10, 16, 16, 16, 20, null]);
  assert.deepEqual(core.fillMissingValues(source, 2, 5, { method: "constant", constantValue: 88 }), [null, 10, 88, 88, 16, 88, 20, null]);
  assert.deepEqual(core.fillMissingValues(source, 0, source.length - 1, { method: "linear", maxGapPoints: 1 }), [10, 10, null, null, 16, 18, 20, 20]);
  assert.deepEqual(core.applyOperation(source, 0, source.length - 1, { mode: "fill_gaps", method: "linear", intervalMinutes: 2, maxGapMinutes: 2 }), [10, 10, null, null, 16, 18, 20, 20]);
  assert.deepEqual(core.fillMissingValues([10, null, null, null, null, 20], 2, 3, { method: "linear", maxGapPoints: 2 }), [10, null, null, null, null, 20], "局部选区不能绕过整段空白长度限制");
  assert.deepEqual(core.fillMissingValues([10, null, null, null, 20], 0, 4, { method: "linear", intervalMinutes: 2, maxGapMinutes: 5 }), [10, null, null, null, 20], "分钟限制不能通过四舍五入放宽到更长空白");
  assert.deepEqual(source, [null, 10, null, null, 16, null, 20, null], "补全不能修改输入数组");
});

test("扩展记录结构支持16个及更多温度通道且不发生字段越界", () => {
  const channelCount = 24, dataOffset = 4, recordSize = (channelCount + 1) * 2, totalRecords = 3;
  const bytes = new Uint8Array(dataOffset + recordSize * totalRecords); bytes.set(Buffer.from("MCA\0"));
  const view = new DataView(bytes.buffer), base = new Date(2024, 0, 1, 8, 0, 0);
  const rows = [];
  for (let rowIndex = 0; rowIndex < totalRecords; rowIndex++) {
    const channels = {};
    for (let channel = 1; channel <= channelCount; channel++) {
      const temperature = 20 + channel + rowIndex;
      view.setInt16(dataOffset + rowIndex * recordSize + channel * 2, temperature * 48, true);
      channels[channel] = temperature;
    }
    const date = new Date(base.getTime() + rowIndex * 120000);
    rows.push({ index: rowIndex, date, time: core.formatDate(date), channels });
  }
  const validChannels = Array.from({ length: channelCount }, (_, index) => index + 1);
  const plr = core.parsePlr(bytes, { dataOffset, recordSize, totalRecords, rawPerCelsius: 48, validChannels });
  const excel = { rows, channels: validChannels, start: rows[0].date, end: rows.at(-1).date, intervalMinutes: 2 };
  const session = core.buildSession(plr, excel, { startRecordIndex: 0 });
  assert.deepEqual(session.usableChannels, validChannels);
  session.channels[channelCount].targets[1] += 2;
  const output = core.createModifiedPlr(session);
  assert.equal(output.edits.length, 1);
  assert.equal(output.edits[0].channel, channelCount);
  assert.equal(output.diff.unexpectedBytes, 0);
  assert.throws(() => core.parsePlr(bytes, { dataOffset, recordSize: 24, totalRecords, validChannels }), /最多容纳通道 11/);
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

test("补全无原始温度的断连点时按目标绝对温度写入 PLR", () => {
  const plr = syntheticPlr(), excel = syntheticExcel();
  const session = core.buildSession(plr, excel, core.alignExcelToPlr(excel, plr));
  session.channels[1].original[1] = null;
  session.channels[1].targets[1] = 25;
  const output = core.createModifiedPlr(session), edit = output.edits[0];
  assert.equal(output.edits.length, 1);
  assert.equal(edit.gapFilled, true);
  assert.equal(edit.originalTemp, null);
  assert.equal(edit.targetTemp, 25);
  assert.equal(edit.rawNew, 25 * 48);
  assert.equal(core.readRaw({ ...plr, data: output.buffer }, edit.physicalRecordIndex, 1), 25 * 48);
  assert.match(core.exportCsv(session, output.edits), /gap_filled/);
  assert.match(core.exportCsv(session, output.edits), /yes\r?\n$/);
  session.channels[1].targets[1] = -1;
  assert.throws(() => core.createModifiedPlr(session), /补全温度超出16位原始字可表达范围/);
  session.channels[1].targets[1] = 1400;
  assert.throws(() => core.createModifiedPlr(session), /补全温度超出16位原始字可表达范围/);
});

test("真实 DAT0131 断连点批量补全后只生成安全的绝对温度写入", () => {
  const root = path.join(__dirname, "..");
  const plr = core.parsePlr(fs.readFileSync(path.join(root, "fixtures", "DAT0131.PLR")));
  const excel = core.parseExcelBytes(fs.readFileSync(path.join(root, "fixtures", "curve.xls")));
  const session = core.buildSession(plr, excel, core.alignExcelToPlr(excel, plr));
  const series = session.channels[3];
  const gaps = series.original.map((value, index) => Number.isFinite(value) ? -1 : index).filter(index => index >= 0);
  assert.deepEqual(gaps, [0, 1, 2271, 2272, 2324, 2325, 2326, 2327, 2328]);

  const before = series.targets.slice();
  series.targets = core.applyOperation(series.targets, 0, series.targets.length - 1, {
    mode: "fill_gaps", method: "linear", intervalMinutes: 2, maxGapMinutes: 0,
  });
  assert.ok(series.targets.every(Number.isFinite));
  for (let index = 0; index < before.length; index++) {
    if (Number.isFinite(before[index])) assert.equal(series.targets[index], before[index], `有效点 ${index} 不应改变`);
  }

  const output = core.createModifiedPlr(session);
  assert.equal(output.edits.length, gaps.length);
  assert.ok(output.edits.every(edit => edit.channel === 3 && edit.gapFilled));
  assert.ok(output.edits.every(edit => edit.rawNew === Math.round(edit.targetTemp * session.scale)));
  assert.equal(output.diff.unexpectedBytes, 0);
  assert.equal(output.diff.headerChanged, false);
  assert.equal(output.buffer.length, plr.data.length);
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

test("真实燃烧预设来自升温保温降温样本并降低规则周期占比", () => {
  const presets = core.REALISTIC_COMBUSTION_PRESETS;
  assert.equal(presets.sample_heating.parameters.phase, "heating");
  assert.equal(presets.sample_holding.parameters.phase, "holding");
  assert.equal(presets.sample_cooling.parameters.phase, "cooling");
  assert.ok(presets.sample_heating.parameters.cycleRatio <= 0.1);
  assert.ok(presets.sample_cooling.parameters.preserveRatio > presets.irregular_strong.parameters.preserveRatio);
  assert.ok(presets.sample_cooling.parameters.correlationMinutes > presets.sample_heating.parameters.correlationMinutes);
});

test("真实燃烧降温修复满足每小时最大降温限制且客户规则可通过", () => {
  const source = Array.from({ length: 240 }, (_, index) => 320 - index * 0.22 + Math.sin(index / 8) * 2.4);
  const start = 12, end = 220, windowPoints = 30;
  const requirement = { id: "cool", channel: 1, phase: "cooling", startIndex: start, endIndex: end, windowMinutes: 60, maxFallPerHour: 5 };
  assert.equal(core.validateCustomerRequirements(complianceSession(source), [requirement]).passed, false);
  const result = core.applyOperation(source, start, end, {
    mode: "realistic_combustion", phase: "cooling", intervalMinutes: 2,
    windowMinutes: 60, maxFallPerHour: 5, amplitude: 3.8, preserveRatio: 0.76,
    correlationMinutes: 32, trendMinutes: 120, eventsPerHour: 0.35,
    cycleRatio: 0.05, pulseStrength: 0.75, transitionMinutes: 12, seed: "cooling-limit",
  });
  assert.ok(maximumWindowFall(result, start, end, windowPoints) <= 5 + 1e-9);
  assert.deepEqual(result.slice(0, start), source.slice(0, start));
  assert.deepEqual(result.slice(end + 1), source.slice(end + 1));
  const session = complianceSession(result);
  const validation = core.validateCustomerRequirements(session, [requirement]);
  assert.equal(validation.passed, true);
  assert.equal(validation.rules[0].phase, "cooling");
  assert.ok(validation.rules[0].maximumObserved <= 5 + 1e-9);
});

test("降温修复遇到缺失采样点时使用临近有效锚点而不会产生断崖跳变", () => {
  const source = Array.from({ length: 150 }, (_, index) => 250 - index * 0.25 + Math.sin(index / 7));
  source[70] = null;
  source[71] = null;
  const result = core.applyOperation(source, 10, 130, {
    mode: "realistic_combustion", phase: "cooling", intervalMinutes: 2,
    windowMinutes: 60, maxFallPerHour: 5, amplitude: 3.8, preserveRatio: 0.76,
    correlationMinutes: 32, trendMinutes: 120, eventsPerHour: 0.35,
    cycleRatio: 0.05, pulseStrength: 0.75, transitionMinutes: 12,
    onlyViolations: true, seed: "cooling-missing-anchor",
  });
  assert.equal(result[70], null);
  assert.equal(result[71], null);
  assert.ok(result[100] - result[101] < 5);
  const requirement = { id: "cool-gap", channel: 1, phase: "cooling", startIndex: 10, endIndex: 130, windowMinutes: 60, maxFallPerHour: 5 };
  const validation = core.validateCustomerRequirements(complianceSession(result), [requirement]);
  assert.equal(validation.passed, true);
  assert.ok(validation.rules[0].maximumObserved <= 5 + 1e-9);
});

test("多通道协同降温保持共同余热趋势并逐通道满足降温限制", () => {
  const count = 220;
  const source = {
    1: Array.from({ length: count }, (_, index) => 360 - index * 0.2 + Math.sin(index / 9) * 2),
    3: Array.from({ length: count }, (_, index) => 372 - index * 0.21 + Math.sin(index / 9 + 0.25) * 1.8),
    5: Array.from({ length: count }, (_, index) => 348 - index * 0.19 + Math.sin(index / 9 - 0.2) * 2.2),
  };
  const result = core.applyCoordinatedOperation(source, 10, 205, {
    mode: "realistic_combustion", phase: "cooling", intervalMinutes: 2,
    windowMinutes: 60, maxFallPerHour: 5, amplitude: 3.8, preserveRatio: 0.76,
    sharedRatio: 0.76, trendSyncRatio: 0.88, channelVariation: 0.15,
    correlationMinutes: 32, trendMinutes: 120, eventsPerHour: 0.35,
    cycleRatio: 0.05, pulseStrength: 0.75, transitionMinutes: 12,
    onlyViolations: false, seed: "coordinated-cooling",
  });
  for (const channel of [1, 3, 5]) assert.ok(maximumWindowFall(result[channel], 10, 205, 30) <= 5 + 1e-9);
  const increments = channel => result[channel].slice(11, 206).map((value, index) => value - result[channel][index + 10]);
  assert.ok(correlation(increments(1), increments(3)) > 0.8);
  assert.ok(correlation(increments(1), increments(5)) > 0.8);
});

test("多通道协同燃烧修复产生高度相关但不完全相同的共同波动", () => {
  const count = 240;
  const source = {
    1: Array.from({ length: count }, (_, index) => 100 + index * 0.045 + 1.1 * Math.sin(index / 11) + 0.35 * Math.sin(index / 3)),
    2: Array.from({ length: count }, (_, index) => 107 + index * 0.052 + 1.4 * Math.sin((index + 2) / 12) + 0.3 * Math.sin(index / 4)),
    3: Array.from({ length: count }, (_, index) => 94 + index * 0.04 + 0.9 * Math.sin((index - 3) / 10) + 0.4 * Math.sin(index / 5)),
  };
  const operation = {
    mode: "realistic_combustion", phase: "heating", intervalMinutes: 2,
    windowMinutes: 60, maxRisePerHour: 5, amplitude: 1.5, preserveRatio: 0.4,
    sharedRatio: 0.88, trendSyncRatio: 0.82, channelVariation: 0.08,
    correlationMinutes: 18, eventsPerHour: 0.8, transitionMinutes: 8,
    onlyViolations: false, seed: "coordinated-heating",
  };
  const first = core.applyCoordinatedOperation(source, 20, 220, operation);
  const repeated = core.applyCoordinatedOperation(source, 20, 220, operation);
  assert.deepEqual(repeated, first);

  const increments = channel => first[channel].slice(21, 221).map((value, index) => value - first[channel][index + 20]);
  assert.ok(correlation(increments(1), increments(2)) > 0.9);
  assert.ok(correlation(increments(1), increments(3)) > 0.9);
  assert.notDeepEqual(first[1].slice(20, 221), first[2].slice(20, 221));
  for (const channel of [1, 2, 3]) {
    assert.ok(maximumWindowRise(first[channel], 20, 220, 30) <= 5 + 1e-9);
    assert.deepEqual(first[channel].slice(0, 20), source[channel].slice(0, 20));
    assert.deepEqual(first[channel].slice(221), source[channel].slice(221));
  }
});

test("多通道仅修复违规段使用联合违规掩码并保持远端数据", () => {
  const source = { 1: Array(180).fill(800), 2: Array(180).fill(812), 3: Array(180).fill(794) };
  for (let index = 75; index <= 100; index++) source[1][index] += 9 * Math.sin((index - 75) / 4);
  const result = core.applyCoordinatedOperation(source, 0, 179, {
    mode: "realistic_combustion", phase: "holding", intervalMinutes: 2,
    windowMinutes: 60, maxFluctuation: 5, amplitude: 1.3, preserveRatio: 0.4,
    sharedRatio: 0.9, trendSyncRatio: 0.85, channelVariation: 0.06,
    transitionMinutes: 6, onlyViolations: true, seed: "joint-mask",
  });
  for (const channel of [1, 2, 3]) {
    assert.deepEqual(result[channel].slice(0, 40), source[channel].slice(0, 40));
    assert.deepEqual(result[channel].slice(145), source[channel].slice(145));
    assert.ok(maximumWindowFluctuation(result[channel], 0, 179, 30) <= 5 + 1e-9);
  }
  assert.ok(result[2].slice(40, 145).some((value, index) => Math.abs(value - source[2][index + 40]) > 1e-9));
  assert.ok(result[3].slice(40, 145).some((value, index) => Math.abs(value - source[3][index + 40]) > 1e-9));
});

test("多通道协同修复正确处理通道开头的无效温度", () => {
  const source = {
    1: Array.from({ length: 100 }, (_, index) => 100 + index * 0.04),
    2: Array.from({ length: 100 }, (_, index) => index < 8 ? null : 112 + index * 0.04),
  };
  const result = core.applyCoordinatedOperation(source, 0, 99, {
    mode: "realistic_combustion", phase: "holding", intervalMinutes: 2,
    windowMinutes: 60, maxFluctuation: 5, amplitude: 1.2, sharedRatio: 0.9,
    trendSyncRatio: 0.85, onlyViolations: false, transitionMinutes: 6, seed: "missing-prefix",
  });
  assert.deepEqual(result[2].slice(0, 8), source[2].slice(0, 8));
  assert.ok(result[2].slice(8).every(value => value == null || value > 100));
  assert.ok(maximumWindowFluctuation(result[2], 8, 99, 30) <= 5 + 1e-9);
});

test("多通道协同绘制对所有通道应用同一插值温差并保留通道差", () => {
  const base = { 1: [10, 11, 12, 13, 14], 3: [20, 22, 24, 26, 28], 5: [null, 31, 32, 33, 34] };
  let current = Object.fromEntries(Object.entries(base).map(([channel, values]) => [channel, values.slice()]));
  current = core.applyCoordinatedStroke(base, current, 1, 2, 3, 4);
  assert.deepEqual(current[1], [10, 13, 15, 17, 14]);
  assert.deepEqual(current[3], [20, 24, 27, 30, 28]);
  assert.deepEqual(current[5], [null, 33, 35, 37, 34]);
  assert.equal(current[3][2] - current[1][2], base[3][2] - base[1][2]);
  current = core.applyCoordinatedStroke(base, current, 4, -1, 3, -2);
  assert.equal(current[1][3], 11);
  assert.equal(current[1][4], 13);
  assert.equal(current[3][3] - current[1][3], base[3][3] - base[1][3]);
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

test("高温通道跨越int16有符号边界时仍可按uint16原始字写入", () => {
  const root = path.join(__dirname, "..");
  const plr = core.parsePlr(fs.readFileSync(path.join(root, "fixtures", "DAT0131.PLR")));
  const excel = core.parseExcelBytes(fs.readFileSync(path.join(root, "fixtures", "curve.xls")));
  const session = core.buildSession(plr, excel, core.alignExcelToPlr(excel, plr));
  const rowIndex = session.rows.findIndex(row => row.time === "2023-11-09 15:30:00");
  assert.equal(session.channels[2].original[rowIndex], 1284);
  assert.equal(session.channels[2].raw[rowIndex], 61320);
  session.channels[2].targets[rowIndex] = 100;
  const output = core.createModifiedPlr(session), edit = output.edits[0];
  assert.equal(edit.deltaRaw, -56832);
  assert.equal(edit.rawNew, 4488);
  assert.equal(edit.rawWrapped, false);
  assert.equal(core.readRaw({ ...plr, data: output.buffer }, edit.physicalRecordIndex, 2), 4488);
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

test("DMR 3.20.0 回读通过单通道和多通道协同合规曲线", () => {
  const root = path.join(__dirname, "..");
  const plr = core.parsePlr(fs.readFileSync(path.join(root, "fixtures", "DAT0131.PLR")));
  const excel = core.parseExcelBytes(fs.readFileSync(path.join(root, "fixtures", "curve.xls")));
  const alignment = core.alignExcelToPlr(excel, plr);
  const cases = [
    ["DAT0131_linear_90_to_110", 20, 1],
    ["DAT0131_smooth_window_11", 119, 1],
    ["DAT0131_realistic_heating_5Cph", 100, 1],
    ["DAT0131_coordinated_heating_ch1_ch3_ch5", 299, 1.25],
  ];
  for (const [name, planned, tolerance] of cases) {
    const session = core.buildSession(plr, excel, alignment);
    core.applyProject(session, JSON.parse(fs.readFileSync(path.join(root, "fixtures", "e2e", `${name}_project.json`), "utf8")));
    const exported = core.parseExcelBytes(fs.readFileSync(path.join(root, "fixtures", "e2e", `${name}_DMR_export.xls`)));
    const result = core.verifyDmrExport(session, exported, { tolerance });
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
    if (name === "DAT0131_coordinated_heating_ch1_ch3_ch5") {
      const compliance = core.validateCustomerRequirements(session, session.customerRequirements);
      assert.equal(compliance.passed, true, name);
      assert.equal(compliance.rules.length, 3, name);
      assert.ok(compliance.rules.every(rule => rule.maximumObserved <= 5 + 1e-9), name);
      const increments = channel => session.channels[channel].targets.slice(4, 101).map((value, index) => value - session.channels[channel].targets[index + 3]);
      assert.ok(correlation(increments(1), increments(3)) > 0.95, name);
      assert.ok(correlation(increments(1), increments(5)) > 0.95, name);
      assert.equal(result.unchangedMatched, result.unchangedTotal, name);
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
  assert.match(indexHtml, /id="operationScope"/);
  assert.match(indexHtml, /id="coordinatedDrawBtn"/);
  assert.match(indexHtml, /id="gapDrawBtn"/);
  assert.match(indexHtml, /id="yAxisMin"/);
  assert.match(indexHtml, /id="yAxisMax"/);
  assert.match(indexHtml, /id="yAxisStep"/);
  assert.match(indexHtml, /value="fill_gaps"/);
  assert.match(indexHtml, /id="channelCount"/);
  assert.match(indexHtml, /id="addCoolingRequirementBtn"/);
  const appScript = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
  assert.match(appScript, /displayChannels/);
  assert.match(appScript, /normalizedDisplayChannels/);
  assert.match(appScript, /applyCoordinatedOperation/);
  assert.match(appScript, /applyCoordinatedStroke/);
  assert.match(appScript, /buildExportLegendLayout/);
  assert.match(appScript, /configureChartTooltip/);
  assert.match(appScript, /applyYAxis/);
  assert.match(appScript, /fillMissingValues/);
  assert.match(appScript, /sample_cooling/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/../package.json`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/%zz`)).status, 404, "畸形百分号编码应返回 404 而不是让服务崩溃");
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200, "畸形请求后服务必须仍然存活");
});

// ===== 多通道协同真实燃烧 v2（通道波动联动度） =====

// 确定性伪噪声：不依赖 Math.random，保证测试可复现
function pseudoNoise(index, key) {
  const value = Math.sin(index * 12.9898 + key * 78.233) * 43758.5453;
  return value - Math.floor(value) - 0.5;
}

function detrendedResiduals(values, start, end, windowPoints = 37) {
  const radius = Math.floor(windowPoints / 2), segment = values.slice(start, end + 1);
  return segment.map((value, index) => {
    if (!Number.isFinite(value)) return null;
    let sum = 0, count = 0;
    for (let j = Math.max(0, index - radius); j <= Math.min(segment.length - 1, index + radius); j++) {
      if (Number.isFinite(segment[j])) { sum += segment[j]; count++; }
    }
    return count ? value - sum / count : null;
  });
}

function residualStd(values, start, end) {
  const residual = detrendedResiduals(values, start, end).filter(Number.isFinite);
  const mean = residual.reduce((a, b) => a + b, 0) / residual.length;
  return Math.sqrt(residual.reduce((a, b) => a + (b - mean) ** 2, 0) / residual.length);
}

function residualCorrelation(left, right, start, end) {
  const a = detrendedResiduals(left, start, end), b = detrendedResiduals(right, start, end);
  const pairsA = [], pairsB = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { pairsA.push(a[i]); pairsB.push(b[i]); }
  return correlation(pairsA, pairsB);
}

test("协同真实燃烧不带联动度参数时与 v1 金标逐位一致", () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "legacy_coordinated_golden.json"), "utf8")).cases;
  const sha = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const heatingSource = {
    1: Array.from({ length: 240 }, (_, i) => 100 + i * 0.045 + 1.1 * Math.sin(i / 11) + 0.35 * Math.sin(i / 3)),
    2: Array.from({ length: 240 }, (_, i) => 107 + i * 0.052 + 1.4 * Math.sin((i + 2) / 12) + 0.3 * Math.sin(i / 4)),
    3: Array.from({ length: 240 }, (_, i) => 94 + i * 0.04 + 0.9 * Math.sin((i - 3) / 10) + 0.4 * Math.sin(i / 5)),
  };
  assert.equal(sha(core.applyCoordinatedOperation(heatingSource, 20, 220, {
    mode: "realistic_combustion", phase: "heating", intervalMinutes: 2,
    windowMinutes: 60, maxRisePerHour: 5, amplitude: 1.5, preserveRatio: 0.4,
    sharedRatio: 0.88, trendSyncRatio: 0.82, channelVariation: 0.08,
    correlationMinutes: 18, eventsPerHour: 0.8, transitionMinutes: 8,
    onlyViolations: false, seed: "coordinated-heating",
  })), golden.coordinated_heating);
  const coolingSource = {
    1: Array.from({ length: 220 }, (_, i) => 360 - i * 0.2 + Math.sin(i / 9) * 2),
    3: Array.from({ length: 220 }, (_, i) => 372 - i * 0.21 + Math.sin(i / 9 + 0.25) * 1.8),
    5: Array.from({ length: 220 }, (_, i) => 348 - i * 0.19 + Math.sin(i / 9 - 0.2) * 2.2),
  };
  assert.equal(sha(core.applyCoordinatedOperation(coolingSource, 10, 205, {
    mode: "realistic_combustion", phase: "cooling", intervalMinutes: 2,
    windowMinutes: 60, maxFallPerHour: 5, amplitude: 3.8, preserveRatio: 0.76,
    sharedRatio: 0.76, trendSyncRatio: 0.88, channelVariation: 0.15,
    correlationMinutes: 32, trendMinutes: 120, eventsPerHour: 0.35,
    cycleRatio: 0.05, pulseStrength: 0.75, transitionMinutes: 12,
    onlyViolations: false, seed: "coordinated-cooling",
  })), golden.coordinated_cooling);
  const maskSource = { 1: Array(180).fill(800), 2: Array(180).fill(812), 3: Array(180).fill(794) };
  for (let i = 75; i <= 100; i++) maskSource[1][i] += 9 * Math.sin((i - 75) / 4);
  assert.equal(sha(core.applyCoordinatedOperation(maskSource, 0, 179, {
    mode: "realistic_combustion", phase: "holding", intervalMinutes: 2,
    windowMinutes: 60, maxFluctuation: 5, amplitude: 1.3, preserveRatio: 0.4,
    sharedRatio: 0.9, trendSyncRatio: 0.85, channelVariation: 0.06,
    transitionMinutes: 6, onlyViolations: true, seed: "joint-mask",
  })), golden.holding_joint_mask);
  const prefixSource = {
    1: Array.from({ length: 100 }, (_, i) => 100 + i * 0.04),
    2: Array.from({ length: 100 }, (_, i) => i < 8 ? null : 112 + i * 0.04),
  };
  assert.equal(sha(core.applyCoordinatedOperation(prefixSource, 0, 99, {
    mode: "realistic_combustion", phase: "holding", intervalMinutes: 2,
    windowMinutes: 60, maxFluctuation: 5, amplitude: 1.2, sharedRatio: 0.9,
    trendSyncRatio: 0.85, onlyViolations: false, transitionMinutes: 6, seed: "missing-prefix",
  })), golden.holding_missing_prefix);
  const singleSource = Array.from({ length: 240 }, (_, i) => 320 - i * 0.22 + Math.sin(i / 8) * 2.4);
  assert.equal(sha(core.applyOperation(singleSource, 12, 220, {
    mode: "realistic_combustion", phase: "cooling", intervalMinutes: 2,
    windowMinutes: 60, maxFallPerHour: 5, amplitude: 3.8, preserveRatio: 0.76,
    correlationMinutes: 32, trendMinutes: 120, eventsPerHour: 0.35,
    cycleRatio: 0.05, pulseStrength: 0.75, transitionMinutes: 12, seed: "cooling-limit",
  })), golden.single_cooling);
});

test("v2 触发判定：UI 字符串触发新路径，空值与非法值走旧路径", () => {
  const source = {
    1: Array.from({ length: 200 }, (_, i) => 100 + i * 0.05 + pseudoNoise(i, 1)),
    2: Array.from({ length: 200 }, (_, i) => 108 + i * 0.05 + pseudoNoise(i, 2)),
  };
  const base = {
    mode: "realistic_combustion", phase: "heating", intervalMinutes: 2,
    windowMinutes: 60, maxRisePerHour: 20, amplitude: 2, preserveRatio: 0.5,
    sharedRatio: 0.8, trendSyncRatio: 0.8, channelVariation: 0.1,
    correlationMinutes: 14, transitionMinutes: 6, onlyViolations: false, seed: "trigger-check",
  };
  const legacy = core.applyCoordinatedOperation(source, 10, 190, base);
  assert.notDeepEqual(core.applyCoordinatedOperation(source, 10, 190, { ...base, channelCorrelation: "0.9" }), legacy, "字符串联动度必须触发 v2");
  for (const invalid of ["", " ", "abc", null, undefined]) {
    assert.deepEqual(core.applyCoordinatedOperation(source, 10, 190, { ...base, channelCorrelation: invalid }), legacy, `channelCorrelation=${JSON.stringify(invalid)} 应走旧路径`);
  }
  assert.deepEqual(
    core.applyCoordinatedOperation(source, 10, 190, { ...base, channelCorrelation: 1.5 }),
    core.applyCoordinatedOperation(source, 10, 190, { ...base, channelCorrelation: 1 }),
    "超界联动度应 clamp 到 [0,1] 后仍走 v2");
});

test("v2 通道波动联动度直接对应通道间残差相关性且不再克隆", () => {
  const count = 700, start = 30, end = 660;
  const channels = [1, 2, 3, 4, 5, 6];
  const source = Object.fromEntries(channels.map(channel => [channel,
    Array.from({ length: count }, (_, i) => 100 + channel * 8 + i * 0.05 + pseudoNoise(i, channel) * 0.8),
  ]));
  const base = {
    mode: "realistic_combustion", phase: "heating", intervalMinutes: 2,
    windowMinutes: 60, maxRisePerHour: 30, amplitude: 2.2, preserveRatio: 0,
    channelCorrelation: 0.9, trendSyncRatio: 0.8, channelVariation: 0,
    matchChannelAmplitude: false, correlationMinutes: 14, trendMinutes: 75,
    eventsPerHour: 1.1, cycleRatio: 0.1, pulseStrength: 1, transitionMinutes: 10,
    onlyViolations: false, seed: "calibration",
  };
  const high = core.applyCoordinatedOperation(source, start, end, base);
  const highCorrs = [], stds = [];
  for (let a = 0; a < channels.length; a++) {
    stds.push(residualStd(high[channels[a]], start + 20, end - 20));
    for (let b = a + 1; b < channels.length; b++) highCorrs.push(residualCorrelation(high[channels[a]], high[channels[b]], start + 20, end - 20));
  }
  const highMean = highCorrs.reduce((x, y) => x + y, 0) / highCorrs.length;
  assert.ok(highMean > 0.8 && highMean < 0.97, `联动度0.9的实际相关性均值应落在(0.8,0.97)，实测 ${highMean.toFixed(3)}`);
  assert.ok(Math.max(...highCorrs) < 0.995, `任意通道对都不应克隆，最大相关 ${Math.max(...highCorrs).toFixed(4)}`);
  for (const sigma of stds) assert.ok(sigma > 1.3 && sigma < 3.2, `amplitude=2.2 时残差σ应接近目标，实测 ${sigma.toFixed(2)}`);

  const low = core.applyCoordinatedOperation(source, start, end, { ...base, channelCorrelation: 0.3 });
  const lowCorrs = [];
  for (let a = 0; a < channels.length; a++) for (let b = a + 1; b < channels.length; b++) {
    lowCorrs.push(residualCorrelation(low[channels[a]], low[channels[b]], start + 20, end - 20));
  }
  const lowMean = lowCorrs.reduce((x, y) => x + y, 0) / lowCorrs.length;
  assert.ok(lowMean < highMean - 0.3, `低联动度(0.3)相关性应显著低于高联动度(0.9)：${lowMean.toFixed(3)} vs ${highMean.toFixed(3)}`);
});

test("v2 波动过大的通道压到目标强度，波动较小的通道保持原有水平", () => {
  const count = 500, start = 20, end = 480;
  const source = {
    1: Array.from({ length: count }, (_, i) => 200 + i * 0.02 + pseudoNoise(i, 11) * 1.2),
    2: Array.from({ length: count }, (_, i) => 212 + i * 0.02 + pseudoNoise(i, 22) * 10),
  };
  const base = {
    mode: "realistic_combustion", phase: "heating", intervalMinutes: 2,
    windowMinutes: 60, maxRisePerHour: 30, amplitude: 2, preserveRatio: 0,
    channelCorrelation: 0.85, trendSyncRatio: 0.8, channelVariation: 0,
    correlationMinutes: 14, transitionMinutes: 8, onlyViolations: false, seed: "amplitude-cap",
  };
  const quietBefore = residualStd(source[1], start + 15, end - 15);
  const loudBefore = residualStd(source[2], start + 15, end - 15);
  assert.ok(quietBefore < 0.6 && loudBefore > 2.4, `测试前提：通道1安静(${quietBefore.toFixed(2)})、通道2超标(${loudBefore.toFixed(2)})`);

  const capped = core.applyCoordinatedOperation(source, start, end, { ...base, matchChannelAmplitude: true });
  const quietAfter = residualStd(capped[1], start + 15, end - 15);
  const loudAfter = residualStd(capped[2], start + 15, end - 15);
  assert.ok(loudAfter < loudBefore * 0.85, `超标通道必须被减小：${loudBefore.toFixed(2)} → ${loudAfter.toFixed(2)}`);
  assert.ok(loudAfter > 1.2 && loudAfter < 2.6, `超标通道应压到目标强度2℃附近，实测 ${loudAfter.toFixed(2)}`);
  assert.ok(quietAfter < quietBefore * 1.7 + 0.15, `安静通道不应被放大：${quietBefore.toFixed(2)} → ${quietAfter.toFixed(2)}`);
  assert.ok(quietAfter < loudAfter * 0.45, "安静通道修复后仍应明显小于超标通道");

  const preserved = core.applyCoordinatedOperation(source, start, end, { ...base, preserveRatio: 0.6, matchChannelAmplitude: true });
  assert.ok(residualStd(preserved[2], start + 15, end - 15) < loudBefore * 0.9, "保留原曲线特征时超标通道同样被减小（保形状、减幅度）");

  const uniform = core.applyCoordinatedOperation(source, start, end, { ...base, matchChannelAmplitude: false });
  const uniformRatio = residualStd(uniform[2], start + 15, end - 15) / residualStd(uniform[1], start + 15, end - 15);
  assert.ok(uniformRatio > 0.75 && uniformRatio < 1.3, `关闭开关后各通道统一使用目标强度，实测比例 ${uniformRatio.toFixed(2)}`);
});

test("v2 保持限速、联合掩码与随机种子可复现", () => {
  const heatingSource = {
    1: Array.from({ length: 260 }, (_, i) => 100 + i * 0.06 + pseudoNoise(i, 31) * 0.9),
    2: Array.from({ length: 260 }, (_, i) => 109 + i * 0.055 + pseudoNoise(i, 32) * 1.1),
    3: Array.from({ length: 260 }, (_, i) => 96 + i * 0.058 + pseudoNoise(i, 33) * 0.8),
  };
  const heatingOp = {
    mode: "realistic_combustion", phase: "heating", intervalMinutes: 2,
    windowMinutes: 60, maxRisePerHour: 5, amplitude: 1.8, preserveRatio: 0.5,
    channelCorrelation: 0.9, trendSyncRatio: 0.82, channelVariation: 0.1,
    correlationMinutes: 14, transitionMinutes: 8, onlyViolations: false, seed: "v2-rate",
  };
  const heated = core.applyCoordinatedOperation(heatingSource, 15, 245, heatingOp);
  for (const channel of [1, 2, 3]) {
    assert.ok(maximumWindowRise(heated[channel], 15, 245, 30) <= 5 + 1e-9, `通道${channel}必须满足每小时升温限制`);
    assert.deepEqual(heated[channel].slice(0, 15), heatingSource[channel].slice(0, 15));
    assert.deepEqual(heated[channel].slice(246), heatingSource[channel].slice(246));
  }
  assert.deepEqual(core.applyCoordinatedOperation(heatingSource, 15, 245, heatingOp), heated, "同种子必须逐位可复现");
  assert.notDeepEqual(core.applyCoordinatedOperation(heatingSource, 15, 245, { ...heatingOp, seed: "v2-rate-other" }), heated, "不同种子应产生不同曲线");

  const maskSource = { 1: Array(180).fill(800), 2: Array(180).fill(812), 3: Array(180).fill(794) };
  for (let i = 75; i <= 100; i++) maskSource[1][i] += 9 * Math.sin((i - 75) / 4);
  const masked = core.applyCoordinatedOperation(maskSource, 0, 179, {
    mode: "realistic_combustion", phase: "holding", intervalMinutes: 2,
    windowMinutes: 60, maxFluctuation: 5, amplitude: 1.3, preserveRatio: 0.4,
    channelCorrelation: 0.86, trendSyncRatio: 0.85, channelVariation: 0.06,
    transitionMinutes: 6, onlyViolations: true, seed: "v2-mask",
  });
  for (const channel of [1, 2, 3]) {
    assert.deepEqual(masked[channel].slice(0, 40), maskSource[channel].slice(0, 40), `通道${channel}掩码外前段必须不变`);
    assert.deepEqual(masked[channel].slice(145), maskSource[channel].slice(145), `通道${channel}掩码外后段必须不变`);
    assert.ok(maximumWindowFluctuation(masked[channel], 0, 179, 30) <= 5 + 1e-9, `通道${channel}必须满足保温窗口温差限制`);
  }
});
