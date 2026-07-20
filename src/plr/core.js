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
  const UINT16_MIN = 0;
  const UINT16_MAX = 65535;
  const UINT16_MODULUS = 65536;
  const REALISTIC_COMBUSTION_PRESETS = Object.freeze({
    sample_heating: Object.freeze({
      label: "真实样本·升温（推荐）",
      description: "依据真实升温段约1.9～2.9℃残差、较强惯性和非固定燃料扰动设置；周期成分较弱。",
      parameters: Object.freeze({ phase: "heating", amplitude: 2.2, preserveRatio: 0.62, sharedRatio: 0.78, trendSyncRatio: 0.82, channelVariation: 0.12, correlationMinutes: 14, trendMinutes: 75, eventsPerHour: 1.1, cycleRatio: 0.10, pulseStrength: 1.0, transitionMinutes: 12 }),
    }),
    sample_holding: Object.freeze({
      label: "真实样本·保温稳态",
      description: "依据真实保温段约1.4～1.7℃残差和0.72～0.88通道联动设置；波动收敛但不形成规则正弦。",
      parameters: Object.freeze({ phase: "holding", amplitude: 1.5, preserveRatio: 0.72, sharedRatio: 0.82, trendSyncRatio: 0.68, channelVariation: 0.08, correlationMinutes: 20, trendMinutes: 60, eventsPerHour: 0.55, cycleRatio: 0.06, pulseStrength: 0.7, transitionMinutes: 10 }),
    }),
    sample_cooling: Object.freeze({
      label: "真实样本·降温余热",
      description: "依据真实自然降温段约4.8℃残差、长相关惯性和0.74通道联动设置；保留散热滞后与偶发扰动。",
      parameters: Object.freeze({ phase: "cooling", amplitude: 3.8, preserveRatio: 0.76, sharedRatio: 0.76, trendSyncRatio: 0.88, channelVariation: 0.15, correlationMinutes: 32, trendMinutes: 120, eventsPerHour: 0.35, cycleRatio: 0.05, pulseStrength: 0.75, transitionMinutes: 16 }),
    }),
    original_first: Object.freeze({
      label: "原曲线优先·轻修复",
      description: "最大程度保留原有细节，只削弱违规或机械重复部分，适合原始曲线总体可信的情况。",
      parameters: Object.freeze({ amplitude: 1.2, preserveRatio: 0.85, sharedRatio: 0.68, trendSyncRatio: 0.65, channelVariation: 0.12, correlationMinutes: 12, trendMinutes: 45, eventsPerHour: 0.8, cycleRatio: 0.04, pulseStrength: 0.8, transitionMinutes: 8 }),
    }),
    irregular_strong: Object.freeze({
      label: "强扰动·弱周期",
      description: "降低周期占比、增加非对称燃料脉冲和通道差异，适合原曲线过于平滑或规律的区段。",
      parameters: Object.freeze({ amplitude: 2.8, preserveRatio: 0.48, sharedRatio: 0.70, trendSyncRatio: 0.74, channelVariation: 0.18, correlationMinutes: 9, trendMinutes: 55, eventsPerHour: 1.8, cycleRatio: 0.03, pulseStrength: 1.35, transitionMinutes: 12 }),
    }),
  });

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
    const maximumFieldIndex = layout.recordSize / 2 - 1;
    const requestedChannels = layout.validChannels
      ? [...layout.validChannels]
      : Array.from({ length: Math.min(9, maximumFieldIndex) }, (_, index) => index + 1);
    const validChannels = [...new Set(requestedChannels.map(Number))].sort((a, b) => a - b);
    assert(validChannels.length > 0, "至少需要一个可编辑温度通道");
    assert(validChannels.every(channel => Number.isInteger(channel) && channel >= 1 && channel <= maximumFieldIndex),
      `温度通道超出记录结构：${layout.recordSize} 字节记录最多容纳通道 ${maximumFieldIndex}`);
    return { data, layout, signature, validChannels };
  }

  function rawOffset(plr, recordIndex, fieldIndex) {
    const { data, layout } = plr;
    assert(Number.isInteger(recordIndex) && recordIndex >= 0 && recordIndex < layout.totalRecords, `recordIndex 越界：${recordIndex}`);
    assert(Number.isInteger(fieldIndex) && fieldIndex >= 0 && fieldIndex * 2 + 2 <= layout.recordSize, `fieldIndex 越界：${fieldIndex}`);
    return layout.dataOffset + recordIndex * layout.recordSize + fieldIndex * 2;
  }

  function readRaw(plr, recordIndex, fieldIndex) {
    return new DataView(plr.data.buffer, plr.data.byteOffset, plr.data.byteLength).getUint16(rawOffset(plr, recordIndex, fieldIndex), true);
  }

  function writeRaw(plr, recordIndex, fieldIndex, value) {
    const n = Number(value);
    assert(Number.isFinite(n) && n >= UINT16_MIN && n <= UINT16_MAX, `raw 字超出 uint16 范围：${value}`);
    const offset = rawOffset(plr, recordIndex, fieldIndex);
    new DataView(plr.data.buffer, plr.data.byteOffset, plr.data.byteLength).setUint16(offset, Math.round(n), true);
    return Math.round(n);
  }

  function normalizeRawWord(value) {
    return ((Math.round(value) % UINT16_MODULUS) + UINT16_MODULUS) % UINT16_MODULUS;
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

  function normalizeCombustionPhase(phase) {
    return phase === "holding" || phase === "cooling" ? phase : "heating";
  }

  function phaseLimit(phase, maxRise, maxFall, maxFluctuation) {
    if (phase === "cooling") return maxFall;
    if (phase === "holding") return maxFluctuation;
    return maxRise;
  }

  function nearestFiniteRateAnchor(values, lo, currentIndex, windowPoints) {
    const count = Math.max(1, windowPoints);
    const desired = Math.max(lo, currentIndex - count);
    const maxRadius = Math.min(count, currentIndex - lo);
    for (let radius = 0; radius <= maxRadius; radius++) {
      const before = desired - radius;
      if (before >= lo && before < currentIndex && Number.isFinite(values[before])) return { index: before, value: values[before] };
      const after = desired + radius;
      if (radius > 0 && after >= lo && after < currentIndex && Number.isFinite(values[after])) return { index: after, value: values[after] };
    }
    return null;
  }

  function detectViolationMask(values, lo, hi, phase, windowPoints, limit) {
    const mask = Array(values.length).fill(false);
    if (phase === "heating" || phase === "cooling") {
      const directedChange = (previous, current) => phase === "cooling" ? previous - current : current - previous;
      if (hi - lo < windowPoints) {
        const durationPoints = Math.max(1, hi - lo);
        const allowed = limit * durationPoints / windowPoints;
        if (Number.isFinite(values[lo]) && Number.isFinite(values[hi]) && directedChange(values[lo], values[hi]) > allowed) {
          for (let i = lo; i <= hi; i++) mask[i] = true;
        }
      } else {
        for (let i = lo + windowPoints; i <= hi; i++) {
          const current = values[i], anchor = nearestFiniteRateAnchor(values, lo, i, windowPoints);
          if (!anchor || !Number.isFinite(current)) continue;
          const allowed = limit * (i - anchor.index) / windowPoints;
          if (directedChange(anchor.value, current) <= allowed) continue;
          for (let j = anchor.index; j <= i; j++) mask[j] = true;
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
    for (let i = lo + 1; i <= hi; i++) {
      if (!Number.isFinite(result[i])) continue;
      const anchor = nearestFiniteRateAnchor(result, lo, i, count);
      const shouldConstrain = i - lo >= count || !activeMask || activeMask[i];
      const upper = anchor && shouldConstrain
        ? anchor.value + maxRise * (i - anchor.index) / count
        : null;
      if (upper == null || result[i] <= upper + 1e-12) continue;
      const overshoot = result[i] - upper;
      const irregularHeadroom = random
        ? Math.min(maxRise * 0.28 * random(), overshoot * 0.45)
        : 0;
      result[i] = upper - irregularHeadroom;
    }
    return result;
  }

  function enforceCoolingRate(values, lo, hi, windowPoints, maxFall, random = null, activeMask = null) {
    const result = values.slice();
    const count = Math.max(1, windowPoints);
    for (let i = lo + 1; i <= hi; i++) {
      if (!Number.isFinite(result[i])) continue;
      const anchor = nearestFiniteRateAnchor(result, lo, i, count);
      const shouldConstrain = i - lo >= count || !activeMask || activeMask[i];
      const lower = anchor && shouldConstrain
        ? anchor.value - maxFall * (i - anchor.index) / count
        : null;
      if (lower == null || result[i] >= lower - 1e-12) continue;
      const undershoot = lower - result[i];
      const irregularHeadroom = random
        ? Math.min(maxFall * 0.28 * random(), undershoot * 0.45)
        : 0;
      result[i] = lower + irregularHeadroom;
    }
    return result;
  }

  function generateCombustionDriver(length, lo, hi, operation, number, random, phase, amplitude, interval, correlationMinutes) {
    const cycleRatio = clamp(number("cycleRatio", 0.10), 0, 0.6);
    const pulseStrength = clamp(number("pulseStrength", 1), 0, 3);
    const eventsPerHour = Math.max(0, number("eventsPerHour", 0.7));
    const rho = Math.exp(-interval / correlationMinutes);
    const slowRho = Math.exp(-interval / (correlationMinutes * 5));
    let ou = gaussianRandom(random) * amplitude * 0.35;
    let slow = gaussianRandom(random) * amplitude * 0.15;
    let pulse = 0, phaseAngle = random() * 2 * Math.PI, secondaryAngle = random() * 2 * Math.PI;
    let wanderingPeriod = 35 + random() * 100, secondaryPeriod = 55 + random() * 150, envelope = 0.65 + random() * 0.45;
    const driver = Array(length).fill(0);
    for (let i = lo; i <= hi; i++) {
      ou = rho * ou + Math.sqrt(Math.max(0, 1 - rho * rho)) * gaussianRandom(random) * amplitude;
      slow = slowRho * slow + Math.sqrt(Math.max(0, 1 - slowRho * slowRho)) * gaussianRandom(random) * amplitude * 0.45;
      wanderingPeriod = clamp(wanderingPeriod + gaussianRandom(random) * 2.4 + (random() < 0.012 ? gaussianRandom(random) * 14 : 0), 24, 210);
      secondaryPeriod = clamp(secondaryPeriod + gaussianRandom(random) * 1.6, 45, 260);
      phaseAngle += 2 * Math.PI * interval / wanderingPeriod;
      secondaryAngle += 2 * Math.PI * interval / secondaryPeriod;
      envelope = clamp(envelope * 0.965 + (0.45 + random() * 0.75) * 0.035, 0.35, 1.25);
      if (random() < eventsPerHour * interval / 60) {
        const preferredDirection = phase === "heating" ? 1 : phase === "cooling" ? -1 : 0;
        const direction = preferredDirection && random() < 0.64 ? preferredDirection : (random() < 0.5 ? -1 : 1);
        pulse += direction * amplitude * pulseStrength * (0.28 + random() * 0.82);
      }
      pulse *= 0.80 + random() * 0.15;
      const irregularCycle = (Math.sin(phaseAngle + 0.24 * Math.sin(secondaryAngle)) + 0.34 * Math.sin(secondaryAngle + 0.19 * Math.sin(phaseAngle)))
        * amplitude * cycleRatio * envelope;
      const micro = gaussianRandom(random) * amplitude * 0.055;
      driver[i] = clamp(ou * 0.52 + slow * 0.24 + irregularCycle + pulse + micro, -amplitude * 2.35, amplitude * 2.35);
    }
    return driver;
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
    const phase = normalizeCombustionPhase(operation.phase);
    const windowMinutes = Math.max(interval, number("windowMinutes", 60));
    const windowPoints = Math.max(1, Math.round(windowMinutes / interval));
    const maxRise = Math.max(0, number("maxRisePerHour", 5)) * windowMinutes / 60;
    const maxFall = Math.max(0, number("maxFallPerHour", 5)) * windowMinutes / 60;
    const maxFluctuation = Math.max(0, number("maxFluctuation", 5));
    const defaultAmplitude = phase === "holding" ? 1.2 : phase === "cooling" ? 3.2 : 1.8;
    const amplitude = Math.max(0, number("amplitude", defaultAmplitude));
    const preserve = clamp(number("preserveRatio", 0.65), 0, 1);
    const correlationMinutes = Math.max(interval, number("correlationMinutes", 18));
    const defaultTrendMinutes = phase === "holding" ? 45 : phase === "cooling" ? 120 : 90;
    const trendMinutes = Math.max(interval, number("trendMinutes", defaultTrendMinutes));
    const transitionMinutes = Math.max(0, number("transitionMinutes", 10));
    const transitionPoints = Math.round(transitionMinutes / interval);
    const onlyViolations = operation.onlyViolations === true || String(operation.onlyViolations).toLowerCase() === "true";
    const random = seededRandom(operation.seed == null || operation.seed === "" ? "20260719" : operation.seed);
    const trendWindow = Math.max(3, Math.round(trendMinutes / interval) | 1);
    const baseline = movingAverageSegment(values, lo, hi, trendWindow);
    const syntheticDriver = generateCombustionDriver(values.length, lo, hi, operation, number, random, phase, amplitude, interval, correlationMinutes);
    const generated = values.slice();
    for (let i = lo; i <= hi; i++) {
      if (!Number.isFinite(values[i])) continue;
      const originalResidual = clamp(values[i] - baseline[i], -amplitude * 1.8, amplitude * 1.8);
      const syntheticResidual = syntheticDriver[i];
      generated[i] = baseline[i] + preserve * originalResidual + (1 - preserve) * syntheticResidual;
    }

    let mask = Array(values.length).fill(true);
    if (onlyViolations) mask = expandMask(detectViolationMask(values, lo, hi, phase, windowPoints, phaseLimit(phase, maxRise, maxFall, maxFluctuation)), lo, hi, transitionPoints);
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
    if (phase === "heating") return enforceHeatingRate(result, lo, hi, windowPoints, maxRise, random, onlyViolations ? mask : null);
    if (phase === "cooling") return enforceCoolingRate(result, lo, hi, windowPoints, maxFall, random, onlyViolations ? mask : null);
    return enforceHoldingFluctuation(result, lo, hi, windowPoints, maxFluctuation);
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
    const phase = normalizeCombustionPhase(operation.phase);
    const windowMinutes = Math.max(interval, number("windowMinutes", 60));
    const windowPoints = Math.max(1, Math.round(windowMinutes / interval));
    const maxRise = Math.max(0, number("maxRisePerHour", 5)) * windowMinutes / 60;
    const maxFall = Math.max(0, number("maxFallPerHour", 5)) * windowMinutes / 60;
    const maxFluctuation = Math.max(0, number("maxFluctuation", 5));
    const defaultAmplitude = phase === "holding" ? 1.2 : phase === "cooling" ? 3.2 : 1.8;
    const amplitude = Math.max(0, number("amplitude", defaultAmplitude));
    const preserve = clamp(number("preserveRatio", 0.45), 0, 1);
    const sharedRatio = clamp(number("sharedRatio", 0.85), 0, 1);
    const trendSyncRatio = clamp(number("trendSyncRatio", 0.8), 0, 1);
    const channelVariation = clamp(number("channelVariation", 0.08), 0, 0.5);
    const commonOffset = number("commonOffset", 0);
    const correlationMinutes = Math.max(interval, number("correlationMinutes", 18));
    const defaultTrendMinutes = phase === "holding" ? 45 : phase === "cooling" ? 120 : 90;
    const trendMinutes = Math.max(interval, number("trendMinutes", defaultTrendMinutes));
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

    const sharedResidual = generateCombustionDriver(length, lo, hi, operation, number, random, phase, amplitude, interval, correlationMinutes);

    let mask = Array(length).fill(true);
    if (onlyViolations) {
      mask = Array(length).fill(false);
      for (const [, values] of entries) {
        const channelMask = detectViolationMask(values, lo, hi, phase, windowPoints, phaseLimit(phase, maxRise, maxFall, maxFluctuation));
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
    const enforceRate = phase === "cooling" ? enforceCoolingRate : enforceHeatingRate;
    const rateLimit = phase === "cooling" ? maxFall : maxRise;
    const constrainedGroupDriver = enforceRate(
      rawGroupDriver, lo, hi, windowPoints, rateLimit * 0.82,
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
      output[channel] = enforceRate(
        output[channel], lo, hi, windowPoints, rateLimit,
        seededRandom(`${seed}|final-constraint`), onlyViolations ? mask : null,
      );
    }
    return output;
  }

  function applyCoordinatedStroke(baseSeriesByChannel, currentSeriesByChannel, fromIndex, fromDelta, toIndex, toDelta) {
    const entries = Object.entries(baseSeriesByChannel || {}).filter(([, values]) => Array.isArray(values));
    assert(entries.length > 0, "协同绘制至少需要一个通道");
    const length = entries[0][1].length;
    assert(entries.every(([, values]) => values.length === length), "协同绘制的各通道点数必须一致");
    const output = {};
    for (const [channel, baseValues] of entries) {
      const current = currentSeriesByChannel && Array.isArray(currentSeriesByChannel[channel]) ? currentSeriesByChannel[channel] : baseValues;
      assert(current.length === length, `协同绘制通道 ${channel} 的当前点数不一致`);
      output[channel] = current.slice();
    }
    const first = Math.max(0, Math.min(length - 1, Math.round(Number(fromIndex))));
    const last = Math.max(0, Math.min(length - 1, Math.round(Number(toIndex))));
    const firstDelta = Number(fromDelta), lastDelta = Number(toDelta);
    assert(Number.isFinite(firstDelta) && Number.isFinite(lastDelta), "协同绘制温差必须是有效数字");
    const lo = Math.min(first, last), hi = Math.max(first, last), denominator = last - first;
    for (let index = lo; index <= hi; index++) {
      const ratio = denominator === 0 ? 1 : (index - first) / denominator;
      const delta = firstDelta + (lastDelta - firstDelta) * ratio;
      for (const [channel, baseValues] of entries) {
        if (Number.isFinite(baseValues[index])) output[channel][index] = baseValues[index] + delta;
      }
    }
    return output;
  }

  /**
   * 补全热电偶断连产生的空白点。
   *
   * 默认使用空白段前后的有效温度做线性插值；如果空白位于曲线开头或结尾，
   * 则使用唯一一侧的有效温度。maxGapPoints 为 0 时不限制空白长度。
   */
  function fillMissingValues(values, start = 0, end = values.length - 1, options = {}) {
    assert(Array.isArray(values), "空白补全需要温度数组");
    if (!values.length) return [];
    const result = values.slice();
    const lo = Math.max(0, Math.min(values.length - 1, Math.min(start, end)));
    const hi = Math.max(0, Math.min(values.length - 1, Math.max(start, end)));
    const method = ["linear", "nearest", "constant"].includes(options.method) ? options.method : "linear";
    const interval = Math.max(0.000001, Number(options.intervalMinutes) || 1);
    const minuteLimit = Number(options.maxGapMinutes);
    const configuredPointLimit = Math.max(0, Math.floor(Number(options.maxGapPoints) || 0));
    const hasPointLimit = Number.isFinite(minuteLimit) && minuteLimit > 0 || configuredPointLimit > 0;
    const pointLimit = Number.isFinite(minuteLimit) && minuteLimit > 0
      ? Math.max(0, Math.floor(minuteLimit / interval + 1e-9))
      : configuredPointLimit;
    const constantValue = Number(options.constantValue);
    if (method === "constant") assert(Number.isFinite(constantValue), "指定温度必须是有效数字");

    let index = lo;
    while (index <= hi) {
      if (Number.isFinite(result[index])) { index++; continue; }
      const selectedGapStart = index;
      let fullGapStart = selectedGapStart;
      while (fullGapStart > 0 && !Number.isFinite(result[fullGapStart - 1])) fullGapStart--;
      let fullGapEnd = selectedGapStart;
      while (fullGapEnd + 1 < result.length && !Number.isFinite(result[fullGapEnd + 1])) fullGapEnd++;
      const selectedGapEnd = Math.min(hi, fullGapEnd);
      index = selectedGapEnd + 1;
      const gapLength = fullGapEnd - fullGapStart + 1;
      if (hasPointLimit && gapLength > pointLimit) continue;

      const left = fullGapStart - 1;
      const right = fullGapEnd + 1;
      const hasLeft = left >= 0;
      const hasRight = right < result.length;
      if (method !== "constant" && !hasLeft && !hasRight) continue;

      for (let current = selectedGapStart; current <= selectedGapEnd; current++) {
        if (method === "constant") {
          result[current] = constantValue;
        } else if (method === "nearest") {
          if (!hasLeft) result[current] = result[right];
          else if (!hasRight) result[current] = result[left];
          else result[current] = current - left <= right - current ? result[left] : result[right];
        } else if (!hasLeft) {
          result[current] = result[right];
        } else if (!hasRight) {
          result[current] = result[left];
        } else {
          result[current] = result[left] + (result[right] - result[left]) * (current - left) / (right - left);
        }
      }
    }
    return result;
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
      case "fill_gaps": {
        return fillMissingValues(values, lo, hi, operation);
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
      const phase = normalizeCombustionPhase(requirement.phase);
      const [start, end] = resolveRequirementRange(session, requirement);
      const interval = session.excel.intervalMinutes || session.plr.layout.intervalMinutes || 2;
      const windowMinutes = Math.max(interval, Number(requirement.windowMinutes || 60));
      const windowPoints = Math.max(1, Math.round(windowMinutes / interval));
      const values = session.channels[channel].targets;
      const ruleResult = {
        ruleIndex, id: requirement.id || `rule-${ruleIndex + 1}`,
        name: requirement.name || (phase === "heating" ? "升温要求" : phase === "cooling" ? "降温要求" : "保温要求"),
        channel, phase, start, end, startTime: session.rows[start].time, endTime: session.rows[end].time,
        windowMinutes, checkedWindows: 0, violationCount: 0, maximumObserved: null, limit: null, passed: true,
      };
      if (phase === "heating" || phase === "cooling") {
        const limitValue = phase === "cooling" ? requirement.maxFallPerHour : requirement.maxRisePerHour;
        const limit = Math.max(0, Number(limitValue == null ? 5 : limitValue));
        const directedChange = (previous, current) => phase === "cooling" ? previous - current : current - previous;
        ruleResult.limit = limit;
        if (end - start < windowPoints) {
          const hours = Math.max(interval, (end - start) * interval) / 60;
          if (Number.isFinite(values[start]) && Number.isFinite(values[end])) {
            const observed = Math.max(0, directedChange(values[start], values[end])) / hours;
            ruleResult.checkedWindows = 1; ruleResult.maximumObserved = observed;
            if (observed > limit + 1e-9) violations.push({ ruleIndex, channel, phase, startIndex: start, endIndex: end, time: session.rows[end].time, observed, limit });
          }
        } else {
          for (let i = start + windowPoints; i <= end; i++) {
            const current = values[i], anchor = nearestFiniteRateAnchor(values, start, i, windowPoints);
            if (!anchor || !Number.isFinite(current)) continue;
            const elapsedMinutes = (i - anchor.index) * interval;
            const observed = Math.max(0, directedChange(anchor.value, current)) * 60 / elapsedMinutes;
            ruleResult.checkedWindows++;
            ruleResult.maximumObserved = Math.max(ruleResult.maximumObserved == null ? -Infinity : ruleResult.maximumObserved, observed);
            if (observed > limit + 1e-9) violations.push({ ruleIndex, channel, phase, startIndex: anchor.index, endIndex: i, time: session.rows[i].time, observed, limit });
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
        if (!Number.isFinite(target) || (Number.isFinite(original) && Math.abs(target - original) < 1e-12)) continue;
        const physicalRecordIndex = session.rows[rowIndex].physicalRecordIndex;
        const rawOld = readRaw(session.plr, physicalRecordIndex, channel);
        const gapFilled = !Number.isFinite(original);
        let deltaRaw, rawUnwrapped, rawNew;
        if (gapFilled) {
          rawUnwrapped = Math.round(target * session.scale);
          assert(rawUnwrapped >= UINT16_MIN && rawUnwrapped <= UINT16_MAX,
            `通道 ${channel} ${session.rows[rowIndex].time} 的补全温度超出16位原始字可表达范围`);
          rawNew = rawUnwrapped;
          deltaRaw = rawNew - rawOld;
        } else {
          deltaRaw = Math.round((target - original) * session.scale);
          assert(Math.abs(deltaRaw) < UINT16_MODULUS,
            `通道 ${channel} ${session.rows[rowIndex].time} 单次修改温差过大，超出16位原始字的唯一可表达范围`);
          rawUnwrapped = rawOld + deltaRaw;
          rawNew = normalizeRawWord(rawUnwrapped);
        }
        edits.push({
          rowIndex, time: session.rows[rowIndex].time, channel, physicalRecordIndex, fieldIndex: channel,
          originalTemp: gapFilled ? null : original, targetTemp: target, deltaTemp: gapFilled ? null : target - original,
          rawOld, rawNew, deltaRaw, rawWrapped: rawNew !== rawUnwrapped, gapFilled,
        });
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
    const header = ["time", "channel", "physical_record_index", "original_temp", "target_temp", "delta_temp", "raw_old", "raw_new", "delta_raw", "raw_wrapped", "gap_filled"];
    const lines = [header.join(",")];
    for (const e of edits) lines.push([e.time, e.channel, e.physicalRecordIndex, e.originalTemp, e.targetTemp, e.deltaTemp, e.rawOld, e.rawNew, e.deltaRaw, e.rawWrapped ? "yes" : "no", e.gapFilled ? "yes" : "no"].map(csvEscape).join(","));
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
        if (!Number.isFinite(expected)) continue;
        const actual = exportedRow.channels[channel];
        const planned = !Number.isFinite(original) || Math.abs(expected - original) > 1e-12;
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
      if (Number.isFinite(series.targets[i]) && (!Number.isFinite(series.original[i]) || Math.abs(series.targets[i] - series.original[i]) > 1e-12)) changed++;
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
    REALISTIC_COMBUSTION_PRESETS,
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
    fillMissingValues,
    applyCoordinatedOperation,
    applyCoordinatedStroke,
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
