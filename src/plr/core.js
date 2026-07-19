/*
 * DMR Curve Studio 的无框架核心。
 *
 * 这个文件同时在 Node.js 和浏览器运行：Node.js 通过 require("xlsx") 读旧式
 * BIFF .xls，浏览器由 public/vendor/xlsx.full.min.js 注入 XLSX 全局变量。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("xlsx"));
  } else {
    root.DmrCore = factory(root.XLSX);
  }
})(typeof self !== "undefined" ? self : globalThis, function (XLSX) {
  "use strict";

  const DEFAULT_LAYOUT = Object.freeze({
    dataOffset: null,
    recordSize: 24,
    totalRecords: 3001,
    intervalMinutes: 2,
    rawPerCelsius: 48,
    validChannels: null,
  });
  const INVALID_VALUES = new Set([-32640, -32768, null, undefined, ""]);
  const INT16_MIN = -32768;
  const INT16_MAX = 32767;

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function toUint8Array(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError("PLR 输入必须是 ArrayBuffer 或 Uint8Array");
  }

  function parseDateText(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getTime());
    const text = String(value == null ? "" : value).trim();
    const m = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) throw new Error(`无法解析时间：${text || "(空)"}`);
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    assert(!Number.isNaN(date.getTime()), `无效时间：${text}`);
    return date;
  }

  function formatDate(date) {
    const pad = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function dateFromExcel(value) {
    if (value instanceof Date) return parseDateText(value);
    if (typeof value === "number" && XLSX && XLSX.SSF && XLSX.SSF.parse_date_code) {
      const p = XLSX.SSF.parse_date_code(value);
      if (p) return new Date(p.y, p.m - 1, p.d, p.H || 0, p.M || 0, Math.floor(p.S || 0));
    }
    return parseDateText(value);
  }

  function finiteTemperature(value) {
    const n = Number(value);
    return Number.isFinite(n) && !INVALID_VALUES.has(n) ? n : null;
  }

  function parseExcelBytes(input) {
    assert(XLSX, "未加载 XLSX 解析器，请检查 public/vendor/xlsx.full.min.js");
    const bytes = toUint8Array(input);
    const workbook = XLSX.read(bytes, { type: "array", cellDates: true, raw: false, cellNF: true });
    const sheetName = workbook.SheetNames[0];
    assert(sheetName, "Excel 中没有工作表");
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });
    assert(matrix.length >= 2, "Excel 中没有可读取的数据行");
    const headers = matrix[0].map(value => String(value == null ? "" : value).trim());
    const timeColumn = headers.findIndex(h => /^(时间|日期时间|datetime|time)$/i.test(h) || /时间/i.test(h));
    assert(timeColumn >= 0, "Excel 表头中未找到时间列");
    const channelColumns = {};
    headers.forEach((header, column) => {
      const match = header.match(/(?:通道|channel)\s*0*(\d+)/i);
      if (match) channelColumns[Number(match[1])] = column;
    });
    assert(Object.keys(channelColumns).length > 0, "Excel 表头中未找到通道列（例如 通道01(℃)）");

    const rows = [];
    for (let rowIndex = 1; rowIndex < matrix.length; rowIndex++) {
      const row = matrix[rowIndex];
      if (row[timeColumn] == null || String(row[timeColumn]).trim() === "") continue;
      const date = dateFromExcel(row[timeColumn]);
      const channels = {};
      for (const [channel, column] of Object.entries(channelColumns)) channels[Number(channel)] = finiteTemperature(row[column]);
      rows.push({ rowIndex: rowIndex - 1, date, time: formatDate(date), channels });
    }
    assert(rows.length > 0, "Excel 中没有解析到任何温度数据");
    rows.sort((a, b) => a.date - b.date);
    return {
      sheetName,
      rows,
      channels: Object.keys(channelColumns).map(Number).sort((a, b) => a - b),
      start: rows[0].date,
      end: rows[rows.length - 1].date,
      intervalMinutes: rows.length > 1 ? Math.round((rows[1].date - rows[0].date) / 60000) : null,
    };
  }

  function inferLayout(bytes, options = {}) {
    const layout = { ...DEFAULT_LAYOUT, ...options };
    const length = bytes.length;
    if (layout.dataOffset == null) {
      layout.dataOffset = length - layout.recordSize * layout.totalRecords;
    }
    assert(Number.isInteger(layout.dataOffset) && layout.dataOffset >= 0, "dataOffset 无效");
    assert(Number.isInteger(layout.recordSize) && layout.recordSize >= 2 && layout.recordSize % 2 === 0, "recordSize 必须是正偶数");
    assert(Number.isInteger(layout.totalRecords) && layout.totalRecords > 0, "totalRecords 必须大于 0");
    assert(layout.dataOffset + layout.recordSize * layout.totalRecords <= length,
      `PLR 长度不足：需要至少 ${layout.dataOffset + layout.recordSize * layout.totalRecords} 字节，实际 ${length} 字节`);
    assert(Number.isFinite(layout.rawPerCelsius) && layout.rawPerCelsius > 0, "rawPerCelsius 必须大于 0");
    return layout;
  }

  function parsePlr(input, options = {}) {
    const bytes = toUint8Array(input);
    const data = new Uint8Array(bytes); // 与原始 File 分离，便于撤销和多次导出
    const layout = inferLayout(data, options);
    const signature = new TextDecoder("ascii").decode(data.slice(0, 16)).replace(/\0.*$/, "");
    const validChannels = layout.validChannels ? [...layout.validChannels] : Array.from({ length: layout.recordSize / 2 }, (_, i) => i).filter(i => i > 0 && i <= 9);
    return { data, layout, signature, validChannels };
  }

  function rawOffset(plr, recordIndex, fieldIndex) {
    const { data, layout } = plr;
    assert(Number.isInteger(recordIndex) && recordIndex >= 0 && recordIndex < layout.totalRecords, `recordIndex 越界：${recordIndex}`);
    assert(Number.isInteger(fieldIndex) && fieldIndex >= 0 && fieldIndex * 2 + 2 <= layout.recordSize, `fieldIndex 越界：${fieldIndex}`);
    return layout.dataOffset + recordIndex * layout.recordSize + fieldIndex * 2;
  }

  function readRaw(plr, recordIndex, fieldIndex) {
    return new DataView(plr.data.buffer, plr.data.byteOffset, plr.data.byteLength).getInt16(rawOffset(plr, recordIndex, fieldIndex), true);
  }

  function writeRaw(plr, recordIndex, fieldIndex, value) {
    const n = Number(value);
    assert(Number.isFinite(n) && n >= INT16_MIN && n <= INT16_MAX, `raw 值超出 int16 范围：${value}`);
    const offset = rawOffset(plr, recordIndex, fieldIndex);
    new DataView(plr.data.buffer, plr.data.byteOffset, plr.data.byteLength).setInt16(offset, Math.round(n), true);
    return Math.round(n);
  }

  function addSampleIndices(length, count) {
    if (length <= count) return Array.from({ length }, (_, i) => i);
    const result = new Set([0, length - 1]);
    for (let i = 0; i < count; i++) result.add(Math.round(i * (length - 1) / (count - 1)));
    return [...result].sort((a, b) => a - b);
  }

  function scoreAlignment(excel, plr, startRecordIndex, options = {}) {
    const scale = Number(options.rawPerCelsius || plr.layout.rawPerCelsius || 48);
    const channels = (options.channels || excel.channels).filter(channel =>
      excel.channels.includes(channel) && plr.validChannels.includes(channel) && channel * 2 + 2 <= plr.layout.recordSize);
    const sampleRows = addSampleIndices(excel.rows.length, options.sampleCount || 180);
    let total = 0, error = 0, squared = 0, exact = 0;
    for (const rowIndex of sampleRows) {
      const physical = (startRecordIndex + rowIndex) % plr.layout.totalRecords;
      for (const channel of channels) {
        const expected = excel.rows[rowIndex].channels[channel];
        if (expected == null) continue;
        const raw = readRaw(plr, physical, channel);
        if (raw === 0 && expected !== 0) continue;
        const actual = raw / scale;
        const delta = actual - expected;
        total++;
        error += Math.abs(delta);
        squared += delta * delta;
        if (Math.round(actual) === Math.round(expected)) exact++;
      }
    }
    return {
      startRecordIndex,
      sampleCount: total,
      meanAbsError: total ? error / total : Infinity,
      rmse: total ? Math.sqrt(squared / total) : Infinity,
      exactRate: total ? exact / total : 0,
    };
  }

  function alignExcelToPlr(excel, plr, options = {}) {
    assert(excel && excel.rows && excel.rows.length, "Excel 数据为空");
    const total = plr.layout.totalRecords;
    const candidates = [];
    for (let start = 0; start < total; start++) candidates.push(scoreAlignment(excel, plr, start, options));
    candidates.sort((a, b) => a.meanAbsError - b.meanAbsError || b.exactRate - a.exactRate);
    const best = candidates[0];
    const second = candidates[1] || best;
    assert(best.sampleCount > 0, "PLR 与 Excel 没有可比较的有效温度点");
    const gap = second.meanAbsError - best.meanAbsError;
    const confidence = best.meanAbsError <= 1.2 && gap >= 0.35 ? "high" : best.meanAbsError <= 3 ? "medium" : "low";
    return { ...best, secondBest: second, gap, confidence, candidates: candidates.slice(0, 10) };
  }

  function buildSession(plr, excel, alignment, options = {}) {
    const scale = Number(options.rawPerCelsius || plr.layout.rawPerCelsius || 48);
    const rows = excel.rows.map((row, index) => ({
      ...row,
      index,
      physicalRecordIndex: (alignment.startRecordIndex + index) % plr.layout.totalRecords,
    }));
    const channels = {};
    const usableChannels = excel.channels.filter(channel => plr.validChannels.includes(channel) && channel * 2 + 2 <= plr.layout.recordSize);
    assert(usableChannels.length > 0, "Excel 通道与 PLR 可编辑字段没有交集");
    for (const channel of usableChannels) {
      const original = rows.map(row => row.channels[channel] == null ? null : row.channels[channel]);
      channels[channel] = {
        channel,
        original,
        targets: original.slice(),
        raw: rows.map(row => readRaw(plr, row.physicalRecordIndex, channel)),
      };
    }
    return {
      plr,
      excel,
      alignment,
      rows,
      channels,
      usableChannels,
      scale,
      createdAt: new Date().toISOString(),
      metadata: { deviceSignature: plr.signature, sourceRows: rows.length },
      customerRequirements: [],
    };
  }

  function cloneTargets(session) {
    const copy = {};
    for (const [channel, value] of Object.entries(session.channels)) copy[channel] = value.targets.slice();
    return copy;
  }

  function restoreTargets(session, snapshot) {
    for (const [channel, values] of Object.entries(snapshot)) if (session.channels[channel]) session.channels[channel].targets = values.slice();
  }

  function clamp(value, minimum = null, maximum = null) {
    let result = value;
    if (minimum != null && result < minimum) result = minimum;
    if (maximum != null && result > maximum) result = maximum;
    return result;
  }

  function seedToUint32(seed) {
    const text = String(seed == null ? "DMR" : seed);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seededRandom(seed) {
    let state = seedToUint32(seed);
    return function random() {
      state |= 0;
      state = state + 0x6D2B79F5 | 0;
      let value = Math.imul(state ^ state >>> 15, 1 | state);
      value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  function gaussianRandom(random) {
    const u = Math.max(Number.EPSILON, random());
    const v = Math.max(Number.EPSILON, random());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function movingAverageSegment(values, lo, hi, window) {
    const radius = Math.floor(Math.max(1, window) / 2);
    const result = values.slice();
    for (let i = lo; i <= hi; i++) {
      if (!Number.isFinite(values[i])) continue;
      let sum = 0, count = 0;
      for (let j = Math.max(lo, i - radius); j <= Math.min(hi, i + radius); j++) {
        if (Number.isFinite(values[j])) { sum += values[j]; count++; }
      }
      if (count) result[i] = sum / count;
    }
    return result;
  }

  function expandMask(mask, lo, hi, points) {
    if (points <= 0) return mask;
    const expanded = mask.slice();
    for (let i = lo; i <= hi; i++) {
      if (!mask[i]) continue;
      for (let j = Math.max(lo, i - points); j <= Math.min(hi, i + points); j++) expanded[j] = true;
    }
    return expanded;
  }

  function detectViolationMask(values, lo, hi, phase, windowPoints, limit) {
    const mask = Array(values.length).fill(false);
    if (phase === "heating") {
      if (hi - lo < windowPoints) {
        const durationPoints = Math.max(1, hi - lo);
        const allowed = limit * durationPoints / windowPoints;
        if (Number.isFinite(values[lo]) && Number.isFinite(values[hi]) && values[hi] - values[lo] > allowed) {
          for (let i = lo; i <= hi; i++) mask[i] = true;
        }
      } else {
        for (let i = lo + windowPoints; i <= hi; i++) {
          const previous = values[i - windowPoints], current = values[i];
          if (!Number.isFinite(previous) || !Number.isFinite(current) || current - previous <= limit) continue;
          for (let j = i - windowPoints; j <= i; j++) mask[j] = true;
        }
      }
    } else {
      for (let i = lo; i <= hi; i++) {
        const samples = [];
        for (let j = Math.max(lo, i - windowPoints); j <= i; j++) if (Number.isFinite(values[j])) samples.push({ index: j, value: values[j] });
        if (samples.length < 2) continue;
        const minimum = Math.min(...samples.map(item => item.value));
        const maximum = Math.max(...samples.map(item => item.value));
        if (maximum - minimum <= limit) continue;
        const center = (minimum + maximum) / 2;
        for (const item of samples) if (Math.abs(item.value - center) > limit / 2) mask[item.index] = true;
        mask[i] = true;
      }
    }
    return mask;
  }

  function enforceHeatingRate(values, lo, hi, windowPoints, maxRise, random = null, activeMask = null) {
    const result = values.slice();
    const count = Math.max(1, windowPoints);
    const anchor = result[lo];
    for (let i = lo + 1; i <= hi; i++) {
      if (!Number.isFinite(result[i])) continue;
      let upper = null;
      if (i - lo < count && Number.isFinite(anchor) && (!activeMask || activeMask[i])) upper = anchor + maxRise * (i - lo) / count;
      else if (Number.isFinite(result[i - count])) upper = result[i - count] + maxRise;
      if (upper == null || result[i] <= upper + 1e-12) continue;
      const overshoot = result[i] - upper;
      const irregularHeadroom = random
        ? Math.min(maxRise * 0.08 * random(), overshoot * 0.35)
        : 0;
      result[i] = upper - irregularHeadroom;
    }
    return result;
  }

  function enforceHoldingFluctuation(values, lo, hi, windowPoints, maxFluctuation) {
    const result = values.slice();
    for (let i = lo; i <= hi; i++) {
      if (!Number.isFinite(result[i])) continue;
      const recent = [];
      for (let j = Math.max(lo, i - windowPoints); j < i; j++) if (Number.isFinite(result[j])) recent.push(result[j]);
      if (!recent.length) continue;
      let lower = Math.max(...recent) - maxFluctuation;
      let upper = Math.min(...recent) + maxFluctuation;
      if (lower > upper) {
        const center = recent.reduce((sum, value) => sum + value, 0) / recent.length;
        lower = center - maxFluctuation / 2;
        upper = center + maxFluctuation / 2;
      }
      result[i] = clamp(result[i], lower, upper);
    }
    return result;
  }

  function realisticCombustion(values, lo, hi, operation, number) {
    const interval = Math.max(0.01, number("intervalMinutes", 2));
    const phase = operation.phase === "holding" ? "holding" : "heating";
    const windowMinutes = Math.max(interval, number("windowMinutes", 60));
    const windowPoints = Math.max(1, Math.round(windowMinutes / interval));
    const maxRise = Math.max(0, number("maxRisePerHour", 5)) * windowMinutes / 60;
    const maxFluctuation = Math.max(0, number("maxFluctuation", 5));
    const amplitude = Math.max(0, number("amplitude", phase === "holding" ? 1.2 : 1.8));
    const preserve = clamp(number("preserveRatio", 0.65), 0, 1);
    const correlationMinutes = Math.max(interval, number("correlationMinutes", 18));
    const trendMinutes = Math.max(interval, number("trendMinutes", phase === "holding" ? 45 : 90));
    const eventsPerHour = Math.max(0, number("eventsPerHour", 0.7));
    const transitionMinutes = Math.max(0, number("transitionMinutes", 10));
    const transitionPoints = Math.round(transitionMinutes / interval);
    const onlyViolations = operation.onlyViolations === true || String(operation.onlyViolations).toLowerCase() === "true";
    const random = seededRandom(operation.seed == null || operation.seed === "" ? "20260719" : operation.seed);
    const trendWindow = Math.max(3, Math.round(trendMinutes / interval) | 1);
    const baseline = movingAverageSegment(values, lo, hi, trendWindow);
    const rho = Math.exp(-interval / correlationMinutes);
    const slowRho = Math.exp(-interval / (correlationMinutes * 5));
    let ou = gaussianRandom(random) * amplitude * 0.35;
    let slow = gaussianRandom(random) * amplitude * 0.15;
    let pulse = 0;
    let phaseAngle = random() * 2 * Math.PI;
    let wanderingPeriod = 35 + random() * 100;
    const generated = values.slice();
    for (let i = lo; i <= hi; i++) {
      if (!Number.isFinite(values[i])) continue;
      ou = rho * ou + Math.sqrt(Math.max(0, 1 - rho * rho)) * gaussianRandom(random) * amplitude;
      slow = slowRho * slow + Math.sqrt(Math.max(0, 1 - slowRho * slowRho)) * gaussianRandom(random) * amplitude * 0.45;
      wanderingPeriod = clamp(wanderingPeriod + gaussianRandom(random) * 1.8, 25, 180);
      phaseAngle += 2 * Math.PI * interval / wanderingPeriod;
      if (random() < eventsPerHour * interval / 60) pulse += (random() * 2 - 1) * amplitude * (0.35 + random() * 0.75);
      pulse *= 0.82 + random() * 0.14;
      const irregularCycle = Math.sin(phaseAngle + 0.28 * Math.sin(phaseAngle * 0.37)) * amplitude * 0.32;
      const originalResidual = clamp(values[i] - baseline[i], -amplitude * 1.8, amplitude * 1.8);
      const syntheticResidual = clamp(ou * 0.48 + slow * 0.22 + irregularCycle + pulse, -amplitude * 2.1, amplitude * 2.1);
      generated[i] = baseline[i] + preserve * originalResidual + (1 - preserve) * syntheticResidual;
    }

    let mask = Array(values.length).fill(true);
    if (onlyViolations) mask = expandMask(detectViolationMask(values, lo, hi, phase, windowPoints, phase === "heating" ? maxRise : maxFluctuation), lo, hi, transitionPoints);
    const result = values.slice();
    for (let i = lo; i <= hi; i++) if (mask[i] && Number.isFinite(generated[i])) result[i] = generated[i];

    if (transitionPoints > 0) {
      for (let i = lo; i <= Math.min(hi, lo + transitionPoints); i++) {
        if (!mask[i] || !Number.isFinite(result[i]) || !Number.isFinite(values[i])) continue;
        const weight = (i - lo) / Math.max(1, transitionPoints);
        result[i] = values[i] * (1 - weight) + result[i] * weight;
      }
      for (let i = Math.max(lo, hi - transitionPoints); i <= hi; i++) {
        if (!mask[i] || !Number.isFinite(result[i]) || !Number.isFinite(values[i])) continue;
        const weight = (hi - i) / Math.max(1, transitionPoints);
        result[i] = values[i] * (1 - weight) + result[i] * weight;
      }
    }
    return phase === "heating"
      ? enforceHeatingRate(result, lo, hi, windowPoints, maxRise, random, onlyViolations ? mask : null)
      : enforceHoldingFluctuation(result, lo, hi, windowPoints, maxFluctuation);
  }

  function applyCoordinatedOperation(seriesByChannel, start, end, operation = {}) {
    const entries = Object.entries(seriesByChannel || {}).filter(([, values]) => Array.isArray(values));
    assert(entries.length > 0, "多通道协同修复至少需要一个通道");
    const length = entries[0][1].length;
    assert(entries.every(([, values]) => values.length === length), "协同修复的各通道点数必须一致");
    if (operation.mode !== "realistic_combustion" || entries.length === 1) {
      return Object.fromEntries(entries.map(([channel, values]) => [channel, applyOperation(values, start, end, operation)]));
    }

    const lo = Math.max(0, Math.min(length - 1, Math.min(start, end)));
    const hi = Math.max(0, Math.min(length - 1, Math.max(start, end)));
    const number = (key, fallback = 0) => Number.isFinite(Number(operation[key])) ? Number(operation[key]) : fallback;
    const interval = Math.max(0.01, number("intervalMinutes", 2));
    const phase = operation.phase === "holding" ? "holding" : "heating";
    const windowMinutes = Math.max(interval, number("windowMinutes", 60));
    const windowPoints = Math.max(1, Math.round(windowMinutes / interval));
    const maxRise = Math.max(0, number("maxRisePerHour", 5)) * windowMinutes / 60;
    const maxFluctuation = Math.max(0, number("maxFluctuation", 5));
    const amplitude = Math.max(0, number("amplitude", phase === "holding" ? 1.2 : 1.8));
    const preserve = clamp(number("preserveRatio", 0.45), 0, 1);
    const sharedRatio = clamp(number("sharedRatio", 0.85), 0, 1);
    const trendSyncRatio = clamp(number("trendSyncRatio", 0.8), 0, 1);
    const channelVariation = clamp(number("channelVariation", 0.08), 0, 0.5);
    const commonOffset = number("commonOffset", 0);
    const correlationMinutes = Math.max(interval, number("correlationMinutes", 18));
    const trendMinutes = Math.max(interval, number("trendMinutes", phase === "holding" ? 45 : 90));
    const eventsPerHour = Math.max(0, number("eventsPerHour", 0.7));
    const transitionMinutes = Math.max(0, number("transitionMinutes", 10));
    const transitionPoints = Math.round(transitionMinutes / interval);
    const onlyViolations = operation.onlyViolations === true || String(operation.onlyViolations).toLowerCase() === "true";
    const seed = operation.seed == null || operation.seed === "" ? "20260719" : operation.seed;
    const random = seededRandom(`${seed}|coordinated`);
    const trendWindow = Math.max(3, Math.round(trendMinutes / interval) | 1);

    const baselines = {}, ownResiduals = {}, amplitudeScales = {}, baselineAnchors = {};
    for (const [channel, values] of entries) {
      const baseline = movingAverageSegment(values, lo, hi, trendWindow);
      baselines[channel] = baseline;
      ownResiduals[channel] = values.map((value, index) => Number.isFinite(value) && Number.isFinite(baseline[index])
        ? clamp(value - baseline[index], -amplitude * 1.8, amplitude * 1.8)
        : 0);
      const variationRandom = seededRandom(`${seed}|variation|${channel}`);
      amplitudeScales[channel] = 1 + (variationRandom() * 2 - 1) * channelVariation;
      let anchorIndex = lo;
      while (anchorIndex <= hi && (!Number.isFinite(values[anchorIndex]) || !Number.isFinite(baseline[anchorIndex]))) anchorIndex++;
      baselineAnchors[channel] = anchorIndex <= hi ? { index: anchorIndex, value: values[anchorIndex] } : null;
    }

    const commonTrend = Array(length).fill(0);
    for (let i = lo; i <= hi; i++) {
      const deltas = [];
      for (const [channel] of entries) {
        const anchor = baselineAnchors[channel];
        if (anchor && i >= anchor.index && Number.isFinite(baselines[channel][i])) deltas.push(baselines[channel][i] - anchor.value);
      }
      commonTrend[i] = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;
    }

    const rho = Math.exp(-interval / correlationMinutes);
    const slowRho = Math.exp(-interval / (correlationMinutes * 5));
    let ou = gaussianRandom(random) * amplitude * 0.35;
    let slow = gaussianRandom(random) * amplitude * 0.15;
    let pulse = 0, phaseAngle = random() * 2 * Math.PI, wanderingPeriod = 35 + random() * 100;
    const sharedResidual = Array(length).fill(0);
    for (let i = lo; i <= hi; i++) {
      ou = rho * ou + Math.sqrt(Math.max(0, 1 - rho * rho)) * gaussianRandom(random) * amplitude;
      slow = slowRho * slow + Math.sqrt(Math.max(0, 1 - slowRho * slowRho)) * gaussianRandom(random) * amplitude * 0.45;
      wanderingPeriod = clamp(wanderingPeriod + gaussianRandom(random) * 1.8, 25, 180);
      phaseAngle += 2 * Math.PI * interval / wanderingPeriod;
      if (random() < eventsPerHour * interval / 60) pulse += (random() * 2 - 1) * amplitude * (0.35 + random() * 0.75);
      pulse *= 0.82 + random() * 0.14;
      const irregularCycle = Math.sin(phaseAngle + 0.28 * Math.sin(phaseAngle * 0.37)) * amplitude * 0.32;
      sharedResidual[i] = clamp(ou * 0.48 + slow * 0.22 + irregularCycle + pulse, -amplitude * 2.1, amplitude * 2.1);
    }

    let mask = Array(length).fill(true);
    if (onlyViolations) {
      mask = Array(length).fill(false);
      for (const [, values] of entries) {
        const channelMask = detectViolationMask(values, lo, hi, phase, windowPoints, phase === "heating" ? maxRise : maxFluctuation);
        for (let i = lo; i <= hi; i++) mask[i] = mask[i] || channelMask[i];
      }
      mask = expandMask(mask, lo, hi, transitionPoints);
    }

    const output = {};
    for (const [channel, values] of entries) {
      const result = values.slice();
      const individualRandom = seededRandom(`${seed}|individual|${channel}`);
      const individualRho = Math.exp(-interval / Math.max(interval, correlationMinutes * 0.7));
      let individual = gaussianRandom(individualRandom) * amplitude * 0.25;
      const baselineAnchor = baselineAnchors[channel];
      if (!baselineAnchor) { output[channel] = result; continue; }
      for (let i = lo; i <= hi; i++) {
        if (!mask[i] || !Number.isFinite(values[i]) || !Number.isFinite(baselines[channel][i])) continue;
        individual = individualRho * individual + Math.sqrt(Math.max(0, 1 - individualRho * individualRho)) * gaussianRandom(individualRandom) * amplitude * 0.55;
        const synchronizedTrend = baselineAnchor.value + commonTrend[i] - commonTrend[baselineAnchor.index];
        const trend = (1 - trendSyncRatio) * baselines[channel][i] + trendSyncRatio * synchronizedTrend;
        const independentResidual = preserve * ownResiduals[channel][i] + (1 - preserve) * individual;
        const residual = sharedRatio * sharedResidual[i] * amplitudeScales[channel] + (1 - sharedRatio) * independentResidual;
        result[i] = trend + commonOffset + residual;
      }

      if (transitionPoints > 0) {
        for (let i = lo; i <= Math.min(hi, lo + transitionPoints); i++) {
          if (!mask[i] || !Number.isFinite(result[i]) || !Number.isFinite(values[i])) continue;
          const weight = (i - lo) / Math.max(1, transitionPoints);
          result[i] = values[i] * (1 - weight) + result[i] * weight;
        }
        for (let i = Math.max(lo, hi - transitionPoints); i <= hi; i++) {
          if (!mask[i] || !Number.isFinite(result[i]) || !Number.isFinite(values[i])) continue;
          const weight = (hi - i) / Math.max(1, transitionPoints);
          result[i] = values[i] * (1 - weight) + result[i] * weight;
        }
      }
      output[channel] = result;
    }

    if (phase === "holding") {
      for (const [channel] of entries) output[channel] = enforceHoldingFluctuation(output[channel], lo, hi, windowPoints, maxFluctuation);
      return output;
    }

    const outputAnchors = {};
    for (const [channel] of entries) {
      let index = lo;
      while (index <= hi && !Number.isFinite(output[channel][index])) index++;
      outputAnchors[channel] = index <= hi ? { index, value: output[channel][index] } : null;
    }
    const rawGroupDriver = Array(length).fill(0);
    for (let i = lo; i <= hi; i++) {
      const deltas = [];
      for (const [channel] of entries) {
        const anchor = outputAnchors[channel];
        if (anchor && i >= anchor.index && Number.isFinite(output[channel][i])) deltas.push(output[channel][i] - anchor.value);
      }
      rawGroupDriver[i] = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : (i > lo ? rawGroupDriver[i - 1] : 0);
    }
    const constrainedGroupDriver = enforceHeatingRate(
      rawGroupDriver, lo, hi, windowPoints, maxRise * 0.82,
      seededRandom(`${seed}|group-constraint`), onlyViolations ? mask : null,
    );
    const independentWeight = Math.max(0.06, Math.min(0.25, 1 - sharedRatio));
    for (const [channel] of entries) {
      const anchor = outputAnchors[channel];
      if (!anchor) continue;
      for (let i = lo; i <= hi; i++) {
        if ((onlyViolations && !mask[i]) || i < anchor.index || !Number.isFinite(output[channel][i])) continue;
        const rawCommon = anchor.value + rawGroupDriver[i] - rawGroupDriver[anchor.index];
        const independent = clamp(output[channel][i] - rawCommon, -amplitude * 1.5, amplitude * 1.5);
        output[channel][i] = anchor.value + constrainedGroupDriver[i] - constrainedGroupDriver[anchor.index] + independent * independentWeight;
      }
      output[channel] = enforceHeatingRate(
        output[channel], lo, hi, windowPoints, maxRise,
        seededRandom(`${seed}|final-constraint`), onlyViolations ? mask : null,
      );
    }
    return output;
  }

  function applyOperation(values, start, end, operation = {}) {
    const result = values.slice();
    const lo = Math.max(0, Math.min(values.length - 1, Math.min(start, end)));
    const hi = Math.max(0, Math.min(values.length - 1, Math.max(start, end)));
    const valid = i => Number.isFinite(result[i]);
    const number = (key, fallback = 0) => Number.isFinite(Number(operation[key])) ? Number(operation[key]) : fallback;
    switch (operation.mode) {
      case "offset": {
        const amount = number("value");
        for (let i = lo; i <= hi; i++) if (valid(i)) result[i] += amount;
        break;
      }
      case "set": {
        const value = number("value");
        for (let i = lo; i <= hi; i++) if (valid(i)) result[i] = value;
        break;
      }
      case "linear": {
        const first = number("startValue", valid(lo) ? result[lo] : 0);
        const last = number("endValue", valid(hi) ? result[hi] : first);
        const span = hi - lo || 1;
        for (let i = lo; i <= hi; i++) if (valid(i) || (i === lo || i === hi)) result[i] = first + (last - first) * (i - lo) / span;
        break;
      }
      case "clamp": {
        const min = operation.minimum === "" || operation.minimum == null ? null : number("minimum");
        const max = operation.maximum === "" || operation.maximum == null ? null : number("maximum");
        for (let i = lo; i <= hi; i++) if (valid(i)) result[i] = clamp(result[i], min, max);
        break;
      }
      case "smooth": {
        const window = Math.max(1, Math.round(number("window", 5)));
        const radius = Math.floor(window / 2);
        for (let i = lo; i <= hi; i++) {
          if (!valid(i)) continue;
          const samples = [];
          for (let j = Math.max(lo, i - radius); j <= Math.min(hi, i + radius); j++) if (valid(j)) samples.push(values[j]);
          if (samples.length) result[i] = samples.reduce((a, b) => a + b, 0) / samples.length;
        }
        break;
      }
      case "sine": {
        const amplitude = number("amplitude");
        const period = Math.max(1, number("period", 10));
        for (let i = lo; i <= hi; i++) if (valid(i)) result[i] += amplitude * Math.sin(2 * Math.PI * (i - lo) / period);
        break;
      }
      case "realistic_combustion": {
        return realisticCombustion(values, lo, hi, operation, number);
      }
      case "window_delta_clamp": {
        const minutes = Math.max(1, number("windowMinutes", 10));
        const maxDelta = Math.max(0, number("maxDelta", 5));
        const interval = number("intervalMinutes", 2);
        const count = Math.max(1, Math.round(minutes / interval));
        for (let i = lo; i <= hi; i++) {
          if (!valid(i)) continue;
          const recent = [];
          for (let j = Math.max(lo, i - count); j < i; j++) if (Number.isFinite(result[j])) recent.push(result[j]);
          if (!recent.length) continue;
          let lower = Math.max(...recent) - maxDelta;
          let upper = Math.min(...recent) + maxDelta;
          if (lower > upper) { const center = recent.reduce((a, b) => a + b, 0) / recent.length; lower = center - maxDelta / 2; upper = center + maxDelta / 2; }
          result[i] = clamp(result[i], lower, upper);
        }
        break;
      }
      default: throw new Error(`不支持的曲线编辑模式：${operation.mode}`);
    }
    return result;
  }

  function resolveRequirementRange(session, requirement) {
    const max = session.rows.length - 1;
    let start = Number.isInteger(requirement.startIndex) ? requirement.startIndex : null;
    let end = Number.isInteger(requirement.endIndex) ? requirement.endIndex : null;
    if (start == null && requirement.startTime) {
      const time = parseDateText(requirement.startTime).getTime();
      start = session.rows.findIndex(row => row.date.getTime() >= time);
    }
    if (end == null && requirement.endTime) {
      const time = parseDateText(requirement.endTime).getTime();
      for (let i = max; i >= 0; i--) if (session.rows[i].date.getTime() <= time) { end = i; break; }
    }
    start = Math.max(0, Math.min(max, start == null || start < 0 ? 0 : start));
    end = Math.max(0, Math.min(max, end == null || end < 0 ? max : end));
    if (start > end) [start, end] = [end, start];
    return [start, end];
  }

  function validateCustomerRequirements(session, requirements = []) {
    const rules = [], violations = [];
    for (let ruleIndex = 0; ruleIndex < requirements.length; ruleIndex++) {
      const requirement = requirements[ruleIndex];
      const channel = Number(requirement.channel);
      assert(session.channels[channel], `客户要求中的通道 ${channel} 不可编辑`);
      const phase = requirement.phase === "holding" ? "holding" : "heating";
      const [start, end] = resolveRequirementRange(session, requirement);
      const interval = session.excel.intervalMinutes || session.plr.layout.intervalMinutes || 2;
      const windowMinutes = Math.max(interval, Number(requirement.windowMinutes || 60));
      const windowPoints = Math.max(1, Math.round(windowMinutes / interval));
      const values = session.channels[channel].targets;
      const ruleResult = {
        ruleIndex, id: requirement.id || `rule-${ruleIndex + 1}`,
        name: requirement.name || (phase === "heating" ? "升温要求" : "保温要求"),
        channel, phase, start, end, startTime: session.rows[start].time, endTime: session.rows[end].time,
        windowMinutes, checkedWindows: 0, violationCount: 0, maximumObserved: null, limit: null, passed: true,
      };
      if (phase === "heating") {
        const limit = Math.max(0, Number(requirement.maxRisePerHour == null ? 5 : requirement.maxRisePerHour));
        ruleResult.limit = limit;
        if (end - start < windowPoints) {
          const hours = Math.max(interval, (end - start) * interval) / 60;
          if (Number.isFinite(values[start]) && Number.isFinite(values[end])) {
            const observed = Math.max(0, values[end] - values[start]) / hours;
            ruleResult.checkedWindows = 1; ruleResult.maximumObserved = observed;
            if (observed > limit + 1e-9) violations.push({ ruleIndex, channel, phase, startIndex: start, endIndex: end, time: session.rows[end].time, observed, limit });
          }
        } else {
          for (let i = start + windowPoints; i <= end; i++) {
            const previous = values[i - windowPoints], current = values[i];
            if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
            const observed = Math.max(0, current - previous) * 60 / windowMinutes;
            ruleResult.checkedWindows++;
            ruleResult.maximumObserved = Math.max(ruleResult.maximumObserved == null ? -Infinity : ruleResult.maximumObserved, observed);
            if (observed > limit + 1e-9) violations.push({ ruleIndex, channel, phase, startIndex: i - windowPoints, endIndex: i, time: session.rows[i].time, observed, limit });
          }
        }
      } else {
        const limit = Math.max(0, Number(requirement.maxFluctuation == null ? 5 : requirement.maxFluctuation));
        ruleResult.limit = limit;
        for (let i = start; i <= end; i++) {
          const samples = [];
          for (let j = Math.max(start, i - windowPoints); j <= i; j++) if (Number.isFinite(values[j])) samples.push(values[j]);
          if (samples.length < 2) continue;
          const observed = Math.max(...samples) - Math.min(...samples);
          ruleResult.checkedWindows++;
          ruleResult.maximumObserved = Math.max(ruleResult.maximumObserved == null ? -Infinity : ruleResult.maximumObserved, observed);
          if (observed > limit + 1e-9) violations.push({ ruleIndex, channel, phase, startIndex: Math.max(start, i - windowPoints), endIndex: i, time: session.rows[i].time, observed, limit });
        }
      }
      ruleResult.violationCount = violations.filter(item => item.ruleIndex === ruleIndex).length;
      ruleResult.passed = ruleResult.violationCount === 0;
      if (ruleResult.maximumObserved == null) ruleResult.maximumObserved = 0;
      rules.push(ruleResult);
    }
    return {
      passed: rules.length > 0 && violations.length === 0,
      hasRequirements: rules.length > 0,
      rules,
      violations,
      checkedRules: rules.length,
    };
  }

  function buildEditPlan(session) {
    const edits = [];
    for (const [channelText, series] of Object.entries(session.channels)) {
      const channel = Number(channelText);
      for (let rowIndex = 0; rowIndex < session.rows.length; rowIndex++) {
        const original = series.original[rowIndex];
        const target = series.targets[rowIndex];
        if (original == null || target == null || !Number.isFinite(target) || Math.abs(target - original) < 1e-12) continue;
        const physicalRecordIndex = session.rows[rowIndex].physicalRecordIndex;
        const rawOld = readRaw(session.plr, physicalRecordIndex, channel);
        const deltaRaw = Math.round((target - original) * session.scale);
        const rawNew = rawOld + deltaRaw;
        assert(rawNew >= INT16_MIN && rawNew <= INT16_MAX, `通道 ${channel} ${session.rows[rowIndex].time} 修改后超出 int16 范围`);
        edits.push({ rowIndex, time: session.rows[rowIndex].time, channel, physicalRecordIndex, fieldIndex: channel, originalTemp: original, targetTemp: target, deltaTemp: target - original, rawOld, rawNew, deltaRaw });
      }
    }
    return edits.sort((a, b) => a.physicalRecordIndex - b.physicalRecordIndex || a.channel - b.channel);
  }

  function createModifiedPlr(session) {
    const output = new Uint8Array(session.plr.data);
    const modified = { data: output, layout: session.plr.layout, signature: session.plr.signature };
    const edits = buildEditPlan(session);
    for (const edit of edits) writeRaw(modified, edit.physicalRecordIndex, edit.fieldIndex, edit.rawNew);
    const diff = validateModifiedPlr(session.plr, modified, edits);
    return { buffer: output, edits, diff };
  }

  function validateModifiedPlr(original, modified, edits = []) {
    assert(original.data.length === modified.data.length, "输出 PLR 长度发生变化");
    const allowed = new Set();
    for (const edit of edits) {
      const offset = rawOffset(original, edit.physicalRecordIndex, edit.fieldIndex);
      allowed.add(offset); allowed.add(offset + 1);
    }
    const changedOffsets = [];
    for (let i = 0; i < original.data.length; i++) if (original.data[i] !== modified.data[i]) changedOffsets.push(i);
    const unexpected = changedOffsets.filter(offset => !allowed.has(offset));
    assert(unexpected.length === 0, `检测到 ${unexpected.length} 个非计划字节变化`);
    const headerChanged = changedOffsets.some(offset => offset < original.layout.dataOffset);
    assert(!headerChanged, "PLR 头部/索引区被意外修改");
    return {
      fileSize: modified.data.length,
      changedBytes: changedOffsets.length,
      changedWords: Math.ceil(changedOffsets.length / 2),
      plannedEdits: edits.length,
      unexpectedBytes: unexpected.length,
      headerChanged,
      compatible: true,
    };
  }

  function exportCsv(session, edits) {
    const header = ["time", "channel", "physical_record_index", "original_temp", "target_temp", "delta_temp", "raw_old", "raw_new", "delta_raw"];
    const lines = [header.join(",")];
    for (const e of edits) lines.push([e.time, e.channel, e.physicalRecordIndex, e.originalTemp, e.targetTemp, e.deltaTemp, e.rawOld, e.rawNew, e.deltaRaw].map(csvEscape).join(","));
    return "\ufeff" + lines.join("\r\n") + "\r\n";
  }

  function csvEscape(value) {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function sessionProject(session) {
    const targets = {};
    for (const [channel, series] of Object.entries(session.channels)) targets[channel] = series.targets;
    return {
      schema: "dmr-curve-studio/project-1",
      createdAt: session.createdAt,
      source: { signature: session.plr.signature, fileSize: session.plr.data.length, layout: session.plr.layout },
      excel: { start: formatDate(session.excel.start), end: formatDate(session.excel.end), rows: session.excel.rows.length, channels: session.excel.channels },
      alignment: session.alignment,
      scale: session.scale,
      customerRequirements: Array.isArray(session.customerRequirements) ? session.customerRequirements : [],
      targets,
    };
  }

  function applyProject(session, project) {
    assert(project && project.schema === "dmr-curve-studio/project-1", "不是 DMR Curve Studio 项目文件");
    for (const [channel, values] of Object.entries(project.targets || {})) {
      if (!session.channels[channel] || !Array.isArray(values)) continue;
      assert(values.length === session.rows.length, `项目通道 ${channel} 的点数与当前 Excel 不一致`);
      session.channels[channel].targets = values.map(value => value == null ? null : Number(value));
    }
    session.customerRequirements = Array.isArray(project.customerRequirements)
      ? project.customerRequirements.map(item => ({ ...item }))
      : [];
    return session;
  }

  function verifyDmrExport(session, exportedExcel, options = {}) {
    const tolerance = Number(options.tolerance == null ? 1 : options.tolerance);
    assert(Number.isFinite(tolerance) && tolerance >= 0, "回读容差必须是非负数");
    const exportedByTime = new Map(exportedExcel.rows.map(row => [row.time, row]));
    const result = {
      tolerance, validCompared: 0, matched: 0, mismatched: 0, missing: 0,
      plannedTotal: 0, plannedMatched: 0, unchangedTotal: 0, unchangedMatched: 0,
      mismatches: [], missingRows: [],
    };
    for (let rowIndex = 0; rowIndex < session.rows.length; rowIndex++) {
      const sourceRow = session.rows[rowIndex];
      const exportedRow = exportedByTime.get(sourceRow.time);
      if (!exportedRow) {
        result.missing++;
        if (result.missingRows.length < 100) result.missingRows.push(sourceRow.time);
        continue;
      }
      for (const channel of session.usableChannels) {
        const original = session.channels[channel].original[rowIndex];
        const expected = session.channels[channel].targets[rowIndex];
        if (!Number.isFinite(original) || !Number.isFinite(expected)) continue;
        const actual = exportedRow.channels[channel];
        const planned = Math.abs(expected - original) > 1e-12;
        result.validCompared++;
        if (planned) result.plannedTotal++; else result.unchangedTotal++;
        const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
        if (ok) {
          result.matched++;
          if (planned) result.plannedMatched++; else result.unchangedMatched++;
        } else {
          result.mismatched++;
          if (result.mismatches.length < 500) result.mismatches.push({
            time: sourceRow.time, channel, original, expected, actual,
            delta: Number.isFinite(actual) ? actual - expected : null, planned,
          });
        }
      }
    }
    result.passed = result.mismatched === 0 && result.missing === 0 && result.plannedMatched === result.plannedTotal;
    return result;
  }

  function sessionStats(session, channel, start = 0, end = session.rows.length - 1) {
    const series = session.channels[channel];
    if (!series) return null;
    const values = [], original = [];
    let changed = 0;
    for (let i = start; i <= end; i++) {
      if (Number.isFinite(series.targets[i])) values.push(series.targets[i]);
      if (Number.isFinite(series.original[i])) original.push(series.original[i]);
      if (Number.isFinite(series.targets[i]) && Number.isFinite(series.original[i]) && Math.abs(series.targets[i] - series.original[i]) > 1e-12) changed++;
    }
    if (!values.length) return { count: 0 };
    return {
      count: values.length,
      min: Math.min(...values), max: Math.max(...values),
      average: values.reduce((a, b) => a + b, 0) / values.length,
      changed,
      deltaMin: original.length ? Math.min(...values) - Math.min(...original) : null,
      deltaMax: original.length ? Math.max(...values) - Math.max(...original) : null,
    };
  }

  return {
    DEFAULT_LAYOUT,
    INVALID_VALUES,
    formatDate,
    parseDateText,
    parseExcelBytes,
    inferLayout,
    parsePlr,
    readRaw,
    writeRaw,
    scoreAlignment,
    alignExcelToPlr,
    buildSession,
    cloneTargets,
    restoreTargets,
    applyOperation,
    applyCoordinatedOperation,
    validateCustomerRequirements,
    buildEditPlan,
    createModifiedPlr,
    validateModifiedPlr,
    exportCsv,
    sessionProject,
    applyProject,
    verifyDmrExport,
    sessionStats,
    rawOffset,
  };
});
