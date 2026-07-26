(() => {
  "use strict";
  const core = window.DmrCore;
  const $ = id => document.getElementById(id);
  const state = {
    plrFile: null, excelFile: null, session: null,
    activeChannel: 1, selection: [0, 0], view: [0, 0], page: 0, pageSize: 50,
    displayChannels: [],
    undo: [], redo: [], drawEnabled: true, gapDrawEnabled: true, coordinatedDrawEnabled: false, drag: null, panDrag: null, hoverIndex: null,
    yAxis: { mode: "auto", min: null, max: null, step: null },
    chartMeta: null, latestOutput: null, requirementResult: null,
  };

  const CHANNEL_COLORS = [
    "#e96d2f", "#0d8f83", "#3f78b5", "#8b5fbf", "#d39a19", "#d24f73", "#4d9a57", "#7b6b55",
    "#536f8d", "#b05a9d", "#1685a9", "#9b6d18", "#6b63c7", "#c4473a", "#2f8f52", "#ad6a3f",
    "#347c8c", "#7d4f9f", "#718b28", "#c05f87", "#4266a9", "#a47729", "#32817a", "#8a6254",
  ];
  const channelColor = channel => {
    const index = Math.max(0, Number(channel) - 1);
    if (index < CHANNEL_COLORS.length) return CHANNEL_COLORS[index];
    return `hsl(${Math.round((index * 137.508 + 18) % 360)} 58% 43%)`;
  };
  const channelLabel = channel => `通道${String(channel).padStart(2, "0")}`;
  const REALISTIC_PRESETS = core.REALISTIC_COMBUSTION_PRESETS || {};
  const REALISTIC_PRESET_OPTIONS = Object.entries(REALISTIC_PRESETS)
    .map(([id, preset]) => `<option value="${id}">${preset.label}</option>`).join("");

  const operationDefinitions = {
    offset: `<label class="full">温度变化（℃）<input data-op="value" type="number" value="5" step="0.1"></label>`,
    set: `<label class="full">目标温度（℃）<input data-op="value" type="number" value="100" step="0.1"></label>`,
    linear: `<label>起点温度（℃）<input data-op="startValue" type="number" value="90" step="0.1"></label><label>终点温度（℃）<input data-op="endValue" type="number" value="130" step="0.1"></label>`,
    clamp: `<label>最低温度（℃）<input data-op="minimum" type="number" value="95" step="0.1"></label><label>最高温度（℃）<input data-op="maximum" type="number" value="105" step="0.1"></label>`,
    smooth: `<label class="full">平滑窗口（采样点）<input data-op="window" type="number" value="7" min="1" step="2"></label>`,
    fill_gaps: `
      <label class="full">补全方式<select data-op="method"><option value="linear">前后有效点直线插值（推荐）</option><option value="nearest">保持最近有效温度</option><option value="constant">填入指定温度</option></select></label>
      <label class="full" data-gap-constant>指定温度（℃）<input data-op="constantValue" type="number" value="100" step="0.1"></label>
      <label class="full">最长补全空白（分钟）<input data-op="maxGapMinutes" type="number" value="0" min="0" step="1"><small>0 表示不限长度；超过限制的断连区保留空白。</small></label>
      <div class="full operation-note">只填充选中范围内的无效/断连点，不改变已有有效温度。空白位于曲线首尾时会沿用最近的有效温度。</div>`,
    realistic_combustion: `
      <label class="full">真实波动预设<select data-op="curvePreset">${REALISTIC_PRESET_OPTIONS}<option value="custom">自定义参数</option></select></label>
      <div class="full operation-note" data-preset-hint></div>
      <label>工艺阶段<select data-op="phase"><option value="heating">升温阶段</option><option value="holding">保温阶段</option><option value="cooling">降温阶段</option></select></label>
      <label>校验窗口（分钟）<input data-op="windowMinutes" type="number" value="60" min="1"></label>
      <label data-phase-limit="heating">每小时最大升温（℃/h）<input data-op="maxRisePerHour" type="number" value="5" min="0" step="0.1"></label>
      <label data-phase-limit="cooling" class="hidden">每小时最大降温（℃/h）<input data-op="maxFallPerHour" type="number" value="5" min="0" step="0.1"></label>
      <label data-phase-limit="holding" class="hidden">窗口最大温差（℃）<input data-op="maxFluctuation" type="number" value="5" min="0" step="0.1"></label>
      <label>自然波动强度（℃）<input data-op="amplitude" type="number" value="2.2" min="0" step="0.1"></label>
      <label>保留原曲线特征（0～1）<input data-op="preserveRatio" type="number" value="0.62" min="0" max="1" step="0.01"></label>
      <label>共同波动比例（0～1）<input data-op="sharedRatio" type="number" value="0.78" min="0" max="1" step="0.01"></label>
      <label>趋势同步比例（0～1）<input data-op="trendSyncRatio" type="number" value="0.82" min="0" max="1" step="0.01"></label>
      <label>通道响应差异（0～0.5）<input data-op="channelVariation" type="number" value="0.12" min="0" max="0.5" step="0.01"></label>
      <label>共同温度调整（℃）<input data-op="commonOffset" type="number" value="0" step="0.1"></label>
      <label>波动相关时间（分钟）<input data-op="correlationMinutes" type="number" value="14" min="1"></label>
      <label>趋势提取时间（分钟）<input data-op="trendMinutes" type="number" value="75" min="1"></label>
      <label>扰动次数（次/小时）<input data-op="eventsPerHour" type="number" value="1.1" min="0" step="0.05"></label>
      <label>周期成分比例（0～0.6）<input data-op="cycleRatio" type="number" value="0.10" min="0" max="0.6" step="0.01"></label>
      <label>脉冲扰动强度（0～3）<input data-op="pulseStrength" type="number" value="1" min="0" max="3" step="0.05"></label>
      <label>随机种子<input data-op="seed" value="20260719"></label>
      <label>边界过渡（分钟）<input data-op="transitionMinutes" type="number" value="12" min="0"></label>
      <label class="full check-field"><input data-op="onlyViolations" type="checkbox" checked> 只修复任一已选通道检测到的违规窗口及过渡区</label>
      <label class="full check-field"><input data-op="createRequirement" type="checkbox" checked> 为每个协同修改通道加入客户验收要求</label>
      <div class="full operation-note">共同驱动由多时间尺度随机惯性、变周期弱成分、非对称脉冲和微扰组成；周期占比已显著降低，避免生成规则正弦曲线。</div>`,
    sine: `<label>波动幅度（℃）<input data-op="amplitude" type="number" value="3" step="0.1"></label><label>一个周期点数<input data-op="period" type="number" value="20" min="1"></label>`,
    window_delta_clamp: `<label>时间窗口（分钟）<input data-op="windowMinutes" type="number" value="10" min="1"></label><label>最大温差（℃）<input data-op="maxDelta" type="number" value="5" min="0" step="0.1"></label>`,
  };

  function showToast(message, duration = 2600) {
    const el = $("toast"); el.textContent = message; el.classList.remove("hidden");
    clearTimeout(showToast.timer); showToast.timer = setTimeout(() => el.classList.add("hidden"), duration);
  }

  function setMessage(message, kind = "neutral") {
    const el = $("importMessage"); el.textContent = message; el.className = `message ${kind}`;
  }

  function updateImportButton() { $("importBtn").disabled = !(state.plrFile && state.excelFile); }

  function bindFileInput(id, stateKey, nameId) {
    const input = $(id), drop = input.closest(".file-drop");
    input.addEventListener("change", () => {
      const file = input.files[0]; if (!file) return;
      state[stateKey] = file; $(nameId).textContent = `${file.name} · ${formatBytes(file.size)}`; updateImportButton();
    });
    for (const event of ["dragenter", "dragover"]) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.add("dragover"); });
    for (const event of ["dragleave", "drop"]) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.remove("dragover"); });
    drop.addEventListener("drop", e => {
      const file = e.dataTransfer.files[0]; if (!file) return;
      state[stateKey] = file; $(nameId).textContent = `${file.name} · ${formatBytes(file.size)}`; updateImportButton();
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function loadFiles() {
    if (!state.plrFile || !state.excelFile) return;
    const button = $("importBtn"); button.disabled = true; button.textContent = "正在解析并自动对齐…";
    setMessage("正在分析 PLR 环形缓冲区，并与 Excel 温度轨迹做相关匹配…");
    await new Promise(resolve => setTimeout(resolve, 40));
    try {
      const [plrBuffer, excelBuffer] = await Promise.all([state.plrFile.arrayBuffer(), state.excelFile.arrayBuffer()]);
      const dataOffsetText = $("dataOffset").value.trim();
      const channelCount = Number($("channelCount").value);
      if (!Number.isInteger(channelCount) || channelCount < 1) throw new Error("温度通道数必须是正整数");
      const options = {
        dataOffset: dataOffsetText === "" ? null : Number(dataOffsetText),
        recordSize: Number($("recordSize").value), totalRecords: Number($("totalRecords").value),
        rawPerCelsius: Number($("rawScale").value),
        validChannels: Array.from({ length: channelCount }, (_, index) => index + 1),
      };
      const excel = core.parseExcelBytes(excelBuffer);
      const plr = core.parsePlr(plrBuffer, options);
      const alignment = core.alignExcelToPlr(excel, plr, { rawPerCelsius: options.rawPerCelsius });
      state.session = core.buildSession(plr, excel, alignment, { rawPerCelsius: options.rawPerCelsius });
      state.activeChannel = state.session.usableChannels[0];
      state.displayChannels = [state.activeChannel];
      state.selection = [0, state.session.rows.length - 1]; state.view = [...state.selection]; state.page = 0;
      state.undo = []; state.redo = []; state.latestOutput = null; state.requirementResult = null; state.hoverIndex = null; state.coordinatedDrawEnabled = false;
      state.gapDrawEnabled = true; state.yAxis = { mode: "auto", min: null, max: null, step: null };
      initializeWorkspace();
      setMessage(`解析成功：${excel.rows.length} 个时间点、${state.session.usableChannels.length} 个温度通道，自动定位到物理记录 ${alignment.startRecordIndex}`, "success");
      $("workspace").classList.remove("hidden"); $("step1").classList.add("done"); $("step2").classList.add("active");
      setTimeout(() => { resizeAndDraw(); $("workspace").scrollIntoView({ behavior: "smooth", block: "start" }); }, 60);
    } catch (error) {
      console.error(error); setMessage(error.message, "error"); showToast(`载入失败：${error.message}`, 5000);
    } finally { button.disabled = false; button.textContent = "解析并建立可编辑曲线"; }
  }

  function initializeWorkspace() {
    const session = state.session, max = session.rows.length - 1;
    const select = $("channelSelect"); select.innerHTML = session.usableChannels.map(ch => `<option value="${ch}">通道${String(ch).padStart(2, "0")}</option>`).join("");
    select.value = state.activeChannel;
    state.displayChannels = normalizedDisplayChannels();
    for (const id of ["rangeStart", "rangeEnd"]) { $(id).max = max; $(id).step = 1; }
    $("rangeStart").value = 0; $("rangeEnd").value = max;
    $("manualStartRecord").value = session.alignment.startRecordIndex;
    $("imageNote").value = `${core.formatDate(session.excel.start)} 至 ${core.formatDate(session.excel.end)}`;
    $("timeWindowSelect").value = "all";
    renderYAxisControls(); renderGapDrawState(); renderOperationFields(); renderRequirements(); renderAll(); updateHistoryButtons();
  }

  function renderAll(invalidateValidation = true) {
    if (!state.session) return;
    if (invalidateValidation) { state.latestOutput = null; state.requirementResult = null; }
    normalizeSelection(); renderRange(); renderStats(); renderDiagnostics(); renderTable(); renderRequirements(); renderChannelControls(); drawChart();
    renderChartTitle();
    $("saveState").textContent = `${totalChangedPoints()} 个点已修改`;
    if (invalidateValidation) setValidationWaiting();
  }

  function normalizeSelection() {
    const max = state.session.rows.length - 1;
    let start = Math.max(0, Math.min(max, Number($("rangeStart").value || 0)));
    let end = Math.max(0, Math.min(max, Number($("rangeEnd").value || max)));
    if (start > end) { if (document.activeElement === $("rangeStart")) end = start; else start = end; }
    state.selection = [start, end]; $("rangeStart").value = start; $("rangeEnd").value = end;
  }

  function renderRange() {
    const [a, b] = state.selection, rows = state.session.rows;
    $("rangeStartText").textContent = rows[a].time; $("rangeEndText").textContent = rows[b].time;
  }

  function renderYAxisControls() {
    const axis = state.yAxis;
    $("yAxisMin").value = axis.mode === "manual" ? axis.min : "";
    $("yAxisMax").value = axis.mode === "manual" ? axis.max : "";
    $("yAxisStep").value = axis.mode === "manual" ? axis.step : "";
    $("yAxisStatus").textContent = axis.mode === "manual"
      ? `固定 ${axis.min} ～ ${axis.max} ℃，每格 ${axis.step} ℃`
      : "自动跟随当前显示曲线";
    $("yAxisStatus").classList.toggle("manual", axis.mode === "manual");
  }

  function applyYAxis() {
    const min = Number($("yAxisMin").value), max = Number($("yAxisMax").value), step = Number($("yAxisStep").value);
    if (![min, max, step].every(Number.isFinite)) return showToast("请完整填写纵轴最低、最高和每格温度", 3600);
    if (max <= min) return showToast("纵轴最高温度必须大于最低温度", 3600);
    if (step <= 0 || step > max - min) return showToast("每格温度必须大于 0 且不超过纵轴范围", 3600);
    const divisions = (max - min) / step;
    if (Math.abs(divisions - Math.round(divisions)) > 1e-8) return showToast("最高与最低温差必须是每格温度的整数倍", 4200);
    if (divisions > 80) return showToast("纵轴网格不能超过 80 格，请增大每格温度", 4200);
    state.yAxis = { mode: "manual", min, max, step };
    renderYAxisControls(); drawChart();
    showToast(`纵轴已固定为 ${min} ～ ${max} ℃，每格 ${step} ℃`);
  }

  function resetYAxis() {
    state.yAxis = { mode: "auto", min: null, max: null, step: null };
    renderYAxisControls(); drawChart(); showToast("纵轴已恢复自动范围");
  }

  function totalChangedPoints() {
    if (!state.session) return 0;
    let count = 0;
    for (const series of Object.values(state.session.channels)) for (let i = 0; i < series.targets.length; i++) {
      if (Number.isFinite(series.targets[i]) && (!Number.isFinite(series.original[i]) || Math.abs(series.original[i] - series.targets[i]) > 1e-9)) count++;
    }
    return count;
  }

  function renderStats() {
    const series = state.session.channels[state.activeChannel], [a, b] = state.selection;
    const values = [], original = []; let changed = 0;
    for (let i = a; i <= b; i++) {
      if (Number.isFinite(series.targets[i])) values.push(series.targets[i]);
      if (Number.isFinite(series.original[i])) original.push(series.original[i]);
      if (Number.isFinite(series.targets[i]) && (!Number.isFinite(series.original[i]) || Math.abs(series.original[i] - series.targets[i]) > 1e-9)) changed++;
    }
    const fmt = n => Number.isFinite(n) ? `${n.toFixed(1)}°` : "—";
    $("statMin").textContent = fmt(values.length ? Math.min(...values) : NaN);
    $("statMax").textContent = fmt(values.length ? Math.max(...values) : NaN);
    $("statAvg").textContent = fmt(values.length ? values.reduce((x, y) => x + y, 0) / values.length : NaN);
    $("statChanged").textContent = changed;
  }

  function renderDiagnostics() {
    const s = state.session, a = s.alignment;
    const confidence = { high: "高", medium: "中", low: "低" }[a.confidence] || a.confidence;
    $("diagnostics").innerHTML = [
      ["设备签名", s.plr.signature || "未知"], ["文件字节", s.plr.data.length], ["数据区偏移", s.plr.layout.dataOffset],
      ["记录结构", `${s.plr.layout.totalRecords} × ${s.plr.layout.recordSize} B`], ["温度通道", `${s.usableChannels.length} 个`], ["自动物理起点", a.startRecordIndex],
      ["对齐平均误差", `${a.meanAbsError.toFixed(3)} ℃`], ["对齐置信度", confidence], ["raw / ℃", s.scale],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  }

  function normalizedDisplayChannels() {
    if (!state.session) return [];
    const usable = state.session.usableChannels;
    const selected = new Set((state.displayChannels || []).map(Number).filter(channel => usable.includes(channel)));
    selected.add(state.activeChannel);
    return usable.filter(channel => selected.has(channel));
  }

  function setActiveChannel(channel) {
    channel = Number(channel);
    if (!state.session.usableChannels.includes(channel)) return;
    state.activeChannel = channel;
    state.displayChannels = normalizedDisplayChannels();
    $("channelSelect").value = channel;
    state.page = 0;
    renderAll(false);
  }

  function renderChartTitle() {
    const channels = normalizedDisplayChannels();
    $("chartTitle").textContent = channels.length === 1
      ? `${channelLabel(state.activeChannel)} 温度曲线`
      : `${channels.length} 通道叠加 · 编辑${channelLabel(state.activeChannel)}`;
    $("tableTitle").textContent = `${channelLabel(state.activeChannel)} 温度数据表`;
    renderOperationScopeHint();
  }

  function renderChannelControls() {
    if (!state.session) return;
    state.displayChannels = normalizedDisplayChannels();
    const selected = new Set(state.displayChannels), root = $("channelDisplayList");
    root.innerHTML = state.session.usableChannels.map(channel => {
      const active = channel === state.activeChannel;
      return `<label class="channel-chip ${active ? "active" : ""}" style="--channel-color:${channelColor(channel)}" title="${active ? "当前编辑通道始终显示" : `叠加显示${channelLabel(channel)}`}"><input type="checkbox" data-display-channel="${channel}" ${selected.has(channel) ? "checked" : ""} ${active ? "disabled" : ""}><span class="channel-swatch"></span><span>${String(channel).padStart(2, "0")}</span></label>`;
    }).join("");
    root.querySelectorAll("[data-display-channel]").forEach(input => input.addEventListener("change", () => {
      const channel = Number(input.dataset.displayChannel), next = new Set(state.displayChannels);
      if (input.checked) next.add(channel); else next.delete(channel);
      state.displayChannels = state.session.usableChannels.filter(item => next.has(item));
      renderChannelControls(); renderChartTitle(); drawChart();
    }));

    const legend = $("chartChannelLegend");
    legend.innerHTML = state.displayChannels.map(channel => `<button type="button" class="chart-legend-item ${channel === state.activeChannel ? "active" : ""}" data-edit-channel="${channel}" style="--channel-color:${channelColor(channel)}" title="设为编辑通道"><span class="channel-swatch"></span>${channelLabel(channel)}${channel === state.activeChannel ? " · 编辑中" : ""}</button>`).join("")
      + `<span class="chart-legend-original"><span class="legend-dash"></span>当前编辑通道原始值</span>`;
    legend.querySelectorAll("[data-edit-channel]").forEach(button => button.addEventListener("click", () => setActiveChannel(button.dataset.editChannel)));
    renderCoordinatedDrawState();
  }

  function setDrawEnabled(enabled) {
    state.drawEnabled = Boolean(enabled);
    $("drawModeBtn").classList.toggle("active", state.drawEnabled);
    $("drawModeBtn").textContent = state.drawEnabled ? "✦ 绘制" : "↔ 平移";
    $("curveCanvas").style.cursor = state.drawEnabled ? "crosshair" : "grab";
    renderCoordinatedDrawState();
  }

  function renderGapDrawState() {
    const button = $("gapDrawBtn");
    if (!button) return;
    button.classList.toggle("active", state.gapDrawEnabled);
    button.textContent = state.gapDrawEnabled ? "断点补绘：开" : "断点补绘：关";
    button.title = state.gapDrawEnabled
      ? "拖动绘制可以穿过并补全热电偶断连空白"
      : "当前不会修改热电偶断连空白";
  }

  function toggleGapDraw() {
    state.gapDrawEnabled = !state.gapDrawEnabled;
    renderGapDrawState();
    showToast(state.gapDrawEnabled ? "已允许在图上直接补绘断连空白" : "已关闭断连空白补绘");
  }

  function renderCoordinatedDrawState() {
    const button = $("coordinatedDrawBtn"), status = $("drawScopeStatus");
    if (!button || !status) return;
    const channels = normalizedDisplayChannels(), available = channels.length > 1;
    if (!available) state.coordinatedDrawEnabled = false;
    button.disabled = !available;
    button.classList.toggle("active", state.coordinatedDrawEnabled);
    button.textContent = state.coordinatedDrawEnabled ? `协同绘制：${channels.length}通道` : "协同绘制：关";
    status.classList.toggle("coordinated", state.coordinatedDrawEnabled);
    if (state.coordinatedDrawEnabled) status.textContent = state.drawEnabled ? `${channels.length} 通道协同绘制` : `协同已开启 · 当前平移`;
    else status.textContent = `单通道绘制：${channelLabel(state.activeChannel)}`;
  }

  function toggleCoordinatedDraw() {
    const channels = normalizedDisplayChannels();
    if (channels.length < 2) return showToast("请先勾选至少两个展示通道", 3200);
    state.coordinatedDrawEnabled = !state.coordinatedDrawEnabled;
    if (state.coordinatedDrawEnabled) setDrawEnabled(true); else renderCoordinatedDrawState();
    showToast(state.coordinatedDrawEnabled
      ? `已开启 ${channels.map(channelLabel).join("、")} 图表协同编辑`
      : "已关闭多通道协同编辑");
  }

  function operationChannels() {
    if (!state.session || $("operationScope").value !== "displayed") return [state.activeChannel];
    return normalizedDisplayChannels();
  }

  function renderOperationScopeHint() {
    const scope = $("operationScope"), hint = $("operationScopeHint"), applyButton = $("applyOperationBtn"), restoreButton = $("restoreSelectionBtn");
    if (!scope || !hint || !applyButton || !restoreButton) return;
    const channels = state.session ? operationChannels() : [state.activeChannel];
    const coordinated = scope.value === "displayed" && channels.length > 1;
    const realistic = $("operationMode").value === "realistic_combustion";
    hint.classList.toggle("coordinated", coordinated);
    if (!coordinated) {
      hint.textContent = `当前操作只修改${channelLabel(state.activeChannel)}；其他展示通道仅用于对比。`;
      applyButton.textContent = `应用到${channelLabel(state.activeChannel)}选中范围`;
      restoreButton.textContent = `恢复${channelLabel(state.activeChannel)}选中范围原始值`;
    } else {
      hint.textContent = realistic
        ? `将协同修改 ${channels.map(channelLabel).join("、")}：共享燃烧趋势和波动，同时保留各通道温差与少量独立响应。`
        : `将同一参数同步应用到 ${channels.length} 个已展示通道；恒温和线性模式会使用相同绝对目标温度。`;
      applyButton.textContent = realistic ? `协同修复 ${channels.length} 个已展示通道` : `同步应用到 ${channels.length} 个已展示通道`;
      restoreButton.textContent = `恢复 ${channels.length} 个已展示通道原始值`;
    }
  }

  function updateRealisticPhaseFields() {
    const root = $("operationFields"), phase = root.querySelector('[data-op="phase"]')?.value;
    root.querySelectorAll("[data-phase-limit]").forEach(label => label.classList.toggle("hidden", label.dataset.phaseLimit !== phase));
  }

  function applyRealisticPreset(presetId) {
    const root = $("operationFields"), preset = REALISTIC_PRESETS[presetId], hint = root.querySelector("[data-preset-hint]");
    if (!preset) { if (hint) hint.textContent = "自定义参数：修改后可继续调整各比例；客户限值不会被预设覆盖。"; updateRealisticPhaseFields(); return; }
    for (const [key, value] of Object.entries(preset.parameters || {})) {
      const input = root.querySelector(`[data-op="${key}"]`); if (input) input.value = value;
    }
    if (hint) hint.textContent = preset.description;
    updateRealisticPhaseFields();
  }

  function bindRealisticPresetFields() {
    const root = $("operationFields"), presetSelect = root.querySelector('[data-op="curvePreset"]'), phaseSelect = root.querySelector('[data-op="phase"]');
    if (!presetSelect || !phaseSelect) return;
    const phasePresets = { heating: "sample_heating", holding: "sample_holding", cooling: "sample_cooling" };
    presetSelect.addEventListener("change", () => applyRealisticPreset(presetSelect.value));
    phaseSelect.addEventListener("change", () => {
      presetSelect.value = phasePresets[phaseSelect.value] || "custom";
      applyRealisticPreset(presetSelect.value);
    });
    root.querySelectorAll("[data-op]").forEach(input => {
      if (input === presetSelect || input === phaseSelect) return;
      input.addEventListener("change", () => {
        presetSelect.value = "custom";
        const hint = root.querySelector("[data-preset-hint]");
        if (hint) hint.textContent = "已基于预设转为自定义参数；客户升温、保温或降温限值保持独立。";
      });
    });
    applyRealisticPreset(presetSelect.value);
  }

  function renderOperationFields() {
    $("operationFields").innerHTML = operationDefinitions[$("operationMode").value];
    if ($("operationMode").value === "realistic_combustion") bindRealisticPresetFields();
    if ($("operationMode").value === "fill_gaps") {
      const method = $("operationFields").querySelector('[data-op="method"]');
      const sync = () => $("operationFields").querySelector("[data-gap-constant]").classList.toggle("hidden", method.value !== "constant");
      method.addEventListener("change", sync); sync();
    }
    renderOperationScopeHint();
  }

  function readOperation() {
    const operation = { mode: $("operationMode").value, intervalMinutes: state.session.excel.intervalMinutes || 2 };
    $("operationFields").querySelectorAll("[data-op]").forEach(input => operation[input.dataset.op] = input.type === "checkbox" ? input.checked : input.value);
    return operation;
  }

  function pushUndo(snapshot, label) {
    state.undo.push({ snapshot, label }); if (state.undo.length > 30) state.undo.shift();
    state.redo = []; updateHistoryButtons(); $("step2").classList.add("done");
  }

  function captureEditState() {
    return {
      targets: core.cloneTargets(state.session),
      requirements: (state.session.customerRequirements || []).map(item => ({ ...item })),
    };
  }

  function restoreEditState(snapshot) {
    core.restoreTargets(state.session, snapshot.targets || snapshot);
    state.session.customerRequirements = Array.isArray(snapshot.requirements) ? snapshot.requirements.map(item => ({ ...item })) : [];
  }

  function updateHistoryButtons() { $("undoBtn").disabled = !state.undo.length; $("redoBtn").disabled = !state.redo.length; }

  function undo() {
    if (!state.undo.length) return;
    const entry = state.undo.pop(); state.redo.push({ snapshot: captureEditState(), label: entry.label });
    restoreEditState(entry.snapshot); updateHistoryButtons(); renderAll(); showToast(`已撤销：${entry.label}`);
  }

  function redo() {
    if (!state.redo.length) return;
    const entry = state.redo.pop(); state.undo.push({ snapshot: captureEditState(), label: entry.label });
    restoreEditState(entry.snapshot); updateHistoryButtons(); renderAll(); showToast(`已重做：${entry.label}`);
  }

  function applyBatchOperation() {
    const snapshot = captureEditState(), [a, b] = state.selection, operation = readOperation(), channels = operationChannels();
    try {
      const missingBefore = operation.mode === "fill_gaps"
        ? channels.reduce((count, channel) => count + state.session.channels[channel].targets.slice(a, b + 1).filter(value => !Number.isFinite(value)).length, 0)
        : 0;
      if (channels.length > 1 && operation.mode === "realistic_combustion") {
        const input = Object.fromEntries(channels.map(channel => [channel, state.session.channels[channel].targets]));
        const output = core.applyCoordinatedOperation(input, a, b, operation);
        for (const channel of channels) state.session.channels[channel].targets = output[channel];
      } else {
        for (const channel of channels) state.session.channels[channel].targets = core.applyOperation(state.session.channels[channel].targets, a, b, operation);
      }
      if (operation.mode === "realistic_combustion" && operation.createRequirement) {
        for (const channel of channels) addRequirement(operation.phase, {
            maxRisePerHour: Number(operation.maxRisePerHour), maxFallPerHour: Number(operation.maxFallPerHour), maxFluctuation: Number(operation.maxFluctuation),
            windowMinutes: Number(operation.windowMinutes), startIndex: a, endIndex: b, channel,
          }, false);
      }
      const label = channels.length > 1 ? `多通道协同：${$("operationMode").selectedOptions[0].textContent.trim()}` : $("operationMode").selectedOptions[0].textContent.trim();
      pushUndo(snapshot, label); renderAll();
      if (operation.mode === "fill_gaps") {
        const missingAfter = channels.reduce((count, channel) => count + state.session.channels[channel].targets.slice(a, b + 1).filter(value => !Number.isFinite(value)).length, 0);
        showToast(`已为 ${channels.map(channelLabel).join("、")} 补全 ${missingBefore - missingAfter} 个断连点`);
      } else showToast(`已处理 ${channels.map(channelLabel).join("、")} 的 ${b - a + 1} 个时间点`);
    } catch (error) {
      restoreEditState(snapshot); renderAll(); // 出错时回滚，避免留下改了一半且无法撤销的数据
      showToast(error.message, 4200);
    }
  }

  function restoreSelection() {
    const snapshot = captureEditState(), [a, b] = state.selection, channels = operationChannels();
    for (const channel of channels) {
      const series = state.session.channels[channel];
      for (let i = a; i <= b; i++) series.targets[i] = series.original[i];
    }
    pushUndo(snapshot, `恢复 ${channels.map(channelLabel).join("、")} 原始值`); renderAll();
  }

  function requirementId() { return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }

  function toDateTimeLocal(date) {
    const pad = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function nearestRowIndex(value) {
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return 0;
    let low = 0, high = state.session.rows.length - 1;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (state.session.rows[mid].date.getTime() < time) low = mid + 1; else high = mid; }
    if (low > 0 && Math.abs(state.session.rows[low - 1].date.getTime() - time) < Math.abs(state.session.rows[low].date.getTime() - time)) return low - 1;
    return low;
  }

  function addRequirement(phase, overrides = {}, shouldRender = true) {
    const [selectionStart, selectionEnd] = state.selection;
    phase = phase === "holding" || phase === "cooling" ? phase : "heating";
    const phaseName = phase === "holding" ? "保温阶段窗口波动" : phase === "cooling" ? "降温阶段每小时速度" : "升温阶段每小时速度";
    const requirement = {
      id: requirementId(), name: phaseName,
      channel: state.activeChannel, phase, startIndex: selectionStart, endIndex: selectionEnd,
      windowMinutes: 60, maxRisePerHour: 5, maxFallPerHour: 5, maxFluctuation: 5, ...overrides,
    };
    const list = state.session.customerRequirements || (state.session.customerRequirements = []);
    const same = list.find(item => item.channel === requirement.channel && item.phase === requirement.phase && item.startIndex === requirement.startIndex && item.endIndex === requirement.endIndex);
    if (same) Object.assign(same, requirement, { id: same.id }); else list.push(requirement);
    state.requirementResult = null;
    if (shouldRender) { renderRequirements(); setValidationWaiting(); }
    return requirement;
  }

  function mutateRequirement(index, mutation, label) {
    const requirement = state.session.customerRequirements[index]; if (!requirement) return;
    const before = captureEditState(); mutation(requirement); state.requirementResult = null;
    pushUndo(before, label); renderRequirements(); setValidationWaiting();
  }

  function renderRequirements() {
    if (!state.session) return;
    const list = state.session.customerRequirements || (state.session.customerRequirements = []), root = $("requirementList");
    if (!list.length) {
      root.innerHTML = `<div class="empty-requirements">尚未添加要求。可先选中不合格时间段，再添加对应规则。</div>`;
      $("requirementSummary").className = ""; $("requirementSummary").textContent = "等待填写和校验"; return;
    }
    root.innerHTML = "";
    list.forEach((rule, index) => {
      rule.startIndex = Math.max(0, Math.min(state.session.rows.length - 1, Number(rule.startIndex || 0)));
      rule.endIndex = Math.max(rule.startIndex, Math.min(state.session.rows.length - 1, Number(rule.endIndex == null ? state.session.rows.length - 1 : rule.endIndex)));
      const result = state.requirementResult && state.requirementResult.rules[index];
      const card = document.createElement("div"); card.className = `requirement-card ${rule.phase}`;
      const limitLabel = rule.phase === "holding" ? "最大温差 ℃" : rule.phase === "cooling" ? "最大降温 ℃/h" : "最大升温 ℃/h";
      const limitValue = rule.phase === "holding" ? rule.maxFluctuation : rule.phase === "cooling" ? rule.maxFallPerHour : rule.maxRisePerHour;
      card.innerHTML = `<label>要求名称<input data-key="name" value="${escapeHtml(rule.name || "")}"></label><label>通道<select data-key="channel">${state.session.usableChannels.map(ch => `<option value="${ch}" ${Number(rule.channel) === ch ? "selected" : ""}>通道${String(ch).padStart(2, "0")}</option>`).join("")}</select></label><label>阶段<select data-key="phase"><option value="heating" ${rule.phase === "heating" ? "selected" : ""}>升温</option><option value="holding" ${rule.phase === "holding" ? "selected" : ""}>保温</option><option value="cooling" ${rule.phase === "cooling" ? "selected" : ""}>降温</option></select></label><label>开始<input data-key="start" type="datetime-local" value="${toDateTimeLocal(state.session.rows[rule.startIndex].date)}"></label><label>结束<input data-key="end" type="datetime-local" value="${toDateTimeLocal(state.session.rows[rule.endIndex].date)}"></label><label>窗口 min<input data-key="windowMinutes" type="number" min="1" value="${Number(rule.windowMinutes || 60)}"></label><label class="requirement-limit">${limitLabel}<input data-key="limit" type="number" min="0" step="0.1" value="${Number(limitValue == null ? 5 : limitValue)}"></label><button class="ghost remove-rule" title="删除要求">删除</button><div class="use-selection"><button class="ghost small">使用当前选中时间段</button><span class="rule-result ${result ? (result.passed ? "ok" : "bad") : ""}">${result ? (result.passed ? `通过 · 最大 ${result.maximumObserved.toFixed(2)}` : `${result.violationCount} 个违规 · 最大 ${result.maximumObserved.toFixed(2)}`) : "尚未校验"}</span></div>`;
      const update = (key, value) => mutateRequirement(index, item => {
        if (key === "start") item.startIndex = Math.min(item.endIndex, nearestRowIndex(value));
        else if (key === "end") item.endIndex = Math.max(item.startIndex, nearestRowIndex(value));
        else if (key === "limit") { if (item.phase === "holding") item.maxFluctuation = Number(value); else if (item.phase === "cooling") item.maxFallPerHour = Number(value); else item.maxRisePerHour = Number(value); }
        else if (["channel", "windowMinutes"].includes(key)) item[key] = Number(value);
        else item[key] = value;
      }, "修改客户验收要求");
      card.querySelectorAll("[data-key]").forEach(input => input.addEventListener("change", () => update(input.dataset.key, input.value)));
      card.querySelector(".remove-rule").addEventListener("click", () => { const before = captureEditState(); list.splice(index, 1); pushUndo(before, "删除客户验收要求"); state.requirementResult = null; renderRequirements(); setValidationWaiting(); });
      card.querySelector(".use-selection button").addEventListener("click", () => mutateRequirement(index, item => { item.startIndex = state.selection[0]; item.endIndex = state.selection[1]; }, "更新要求时间段"));
      root.appendChild(card);
    });
    const summary = $("requirementSummary");
    if (!state.requirementResult) { summary.className = ""; summary.textContent = `已设置 ${list.length} 条，等待校验`; }
    else if (state.requirementResult.passed) { summary.className = "ok"; summary.textContent = `${list.length}/${list.length} 条要求通过`; }
    else { summary.className = "bad"; summary.textContent = `${state.requirementResult.rules.filter(rule => rule.passed).length}/${list.length} 条通过，${state.requirementResult.violations.length} 个违规窗口`; }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function runRequirementValidation(notify = true) {
    const requirements = state.session.customerRequirements || [];
    if (!requirements.length) {
      state.requirementResult = { passed: false, hasRequirements: false, rules: [], violations: [] };
      renderRequirements();
      if (notify) showToast("请先添加至少一条客户验收要求", 3800);
      return state.requirementResult;
    }
    try {
      state.requirementResult = core.validateCustomerRequirements(state.session, requirements);
    } catch (error) {
      state.requirementResult = null; renderRequirements();
      const badge = $("validationBadge"); badge.className = "badge error"; badge.textContent = "客户要求无法校验";
      $("validationSummary").textContent = error.message;
      showToast(`客户要求校验失败：${error.message}`, 4500);
      return { passed: false, hasRequirements: true, rules: [], violations: [] };
    }
    renderRequirements();
    const badge = $("validationBadge");
    if (state.requirementResult.passed) {
      badge.className = "badge ok"; badge.textContent = "客户要求全部通过";
      $("validationSummary").innerHTML = `已检查 <b>${state.requirementResult.checkedRules}</b> 条客户要求；所有升温速度、保温窗口温差和降温速度均在限制内。`;
      if (notify) showToast("客户验收要求全部通过");
    } else {
      badge.className = "badge error"; badge.textContent = "客户要求未通过";
      const first = state.requirementResult.violations[0];
      $("validationSummary").innerHTML = `共发现 <b>${state.requirementResult.violations.length}</b> 个违规窗口。${first ? `首个：${first.time} 通道${String(first.channel).padStart(2, "0")}，实测 ${first.observed.toFixed(2)}，限制 ${first.limit.toFixed(2)}。` : ""}`;
      if (notify) showToast("仍有客户要求未满足，可选中违规时段继续修复", 4200);
    }
    return state.requirementResult;
  }

  function requirementsAllowExport() {
    if (!$("requirementGate").checked) return true;
    const result = runRequirementValidation(false);
    if (!result.hasRequirements) { showToast("导出门禁已开启：请先填写客户验收要求", 4200); return false; }
    if (!result.passed) { showToast("导出门禁已阻止导出：客户要求尚未全部通过", 4500); return false; }
    return true;
  }

  function setValidationWaiting() {
    const badge = $("validationBadge"); badge.className = "badge waiting"; badge.textContent = "等待校验";
    const count = state.session && state.session.customerRequirements ? state.session.customerRequirements.length : 0;
    $("validationSummary").textContent = `${totalChangedPoints() ? "已有曲线修改" : "曲线尚未修改"}；${count ? `已填写 ${count} 条客户要求，导出前需要重新校验。` : "尚未填写客户要求。"}`;
  }

  function renderTable() {
    const [viewStart, viewEnd] = state.view, total = viewEnd - viewStart + 1;
    const pages = Math.max(1, Math.ceil(total / state.pageSize)); state.page = Math.max(0, Math.min(pages - 1, state.page));
    const start = viewStart + state.page * state.pageSize, end = Math.min(viewEnd, start + state.pageSize - 1);
    const rows = state.session.rows, series = state.session.channels[state.activeChannel], body = $("dataBody"); body.innerHTML = "";
    for (let i = start; i <= end; i++) {
      const original = series.original[i], target = series.targets[i], delta = !Number.isFinite(original) || !Number.isFinite(target) ? null : target - original;
      const gapFilled = !Number.isFinite(original) && Number.isFinite(target);
      const tr = document.createElement("tr");
      tr.classList.toggle("gap-row", !Number.isFinite(original));
      tr.innerHTML = `<td>${i + 1}</td><td>${rows[i].time}</td><td>${rows[i].physicalRecordIndex}</td><td>${original == null ? '<span class="gap-label">断连</span>' : original.toFixed(2)}</td><td></td><td class="${gapFilled ? "gap-filled" : delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : ""}">${gapFilled ? "已补全" : delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`}</td>`;
      const cell = tr.children[4], input = document.createElement("input"); input.type = "number"; input.step = "0.1"; input.value = target == null ? "" : Number(target.toFixed(4));
      if (!Number.isFinite(original)) { input.placeholder = "输入温度补全"; input.title = "原始热电偶断连，可直接填写目标温度"; }
      let before = null; input.addEventListener("focus", () => before = captureEditState());
      input.addEventListener("change", () => {
        if (input.value.trim() === "") {
          if (!Number.isFinite(original)) { series.targets[i] = null; pushUndo(before || captureEditState(), `清除补全 ${rows[i].time}`); renderAll(); }
          else input.value = target;
          return;
        }
        const value = Number(input.value); if (!Number.isFinite(value)) { input.value = target == null ? "" : target; return; }
        series.targets[i] = value; pushUndo(before || captureEditState(), `${Number.isFinite(original) ? "逐点修改" : "逐点补全"} ${rows[i].time}`); renderAll();
      });
      cell.appendChild(input); body.appendChild(tr);
    }
    $("pageText").textContent = `${state.page + 1} / ${pages}`; $("prevPage").disabled = state.page === 0; $("nextPage").disabled = state.page >= pages - 1;
  }

  function resizeAndDraw() { if (!state.session) return; drawChart(); }

  function setViewRange(start, end, preset = "custom") {
    const max = state.session.rows.length - 1;
    let span = Math.max(9, Math.min(max, Math.round(end - start)));
    let lo = Math.round(start), hi = lo + span;
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > max) { lo -= hi - max; hi = max; }
    lo = Math.max(0, lo); state.view = [lo, hi]; state.page = 0;
    $("timeWindowSelect").value = preset; renderTable(); drawChart();
  }

  function zoomView(factor, centerIndex = null) {
    const [start, end] = state.view, oldSpan = end - start;
    const newSpan = Math.max(9, Math.min(state.session.rows.length - 1, Math.round(oldSpan * factor)));
    const center = centerIndex == null ? (start + end) / 2 : centerIndex;
    const ratio = oldSpan ? (center - start) / oldSpan : 0.5;
    setViewRange(center - newSpan * ratio, center + newSpan * (1 - ratio), newSpan >= state.session.rows.length - 2 ? "all" : "custom");
  }

  function panView(points) {
    const [start, end] = state.view; setViewRange(start + points, end + points, "custom");
  }

  function applyTimeWindow(value) {
    if (value === "all") return setViewRange(0, state.session.rows.length - 1, "all");
    const minutes = Number(value), interval = state.session.excel.intervalMinutes || 2;
    const points = Math.max(10, Math.round(minutes / interval));
    const center = state.hoverIndex == null ? (state.view[0] + state.view[1]) / 2 : state.hoverIndex;
    setViewRange(center - points / 2, center + points / 2, value);
  }

  function handleChartWheel(event) {
    if (!state.session || !state.chartMeta) return;
    event.preventDefault();
    if (event.shiftKey) {
      const direction = event.deltaY > 0 ? 1 : -1;
      panView(direction * Math.max(1, Math.round((state.view[1] - state.view[0]) * 0.12)));
      return;
    }
    const point = canvasPoint(event);
    zoomView(event.deltaY > 0 ? 1.22 : 0.82, point.index);
  }

  function setupCanvas(canvas, exportWidth = null, exportHeight = null) {
    const dpr = exportWidth ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const width = exportWidth || Math.max(600, canvas.clientWidth); const height = exportHeight || Math.max(360, canvas.clientHeight);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
    const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, width, height, dpr };
  }

  function buildExportLegendLayout(channels, canvasWidth, left, right) {
    const items = channels.map(channel => ({ type: "channel", channel, width: channel === state.activeChannel ? 150 : 108 }));
    items.push({ type: "original", width: 190 });
    let x = left, baseline = 112;
    for (const item of items) {
      if (x > left && x + item.width > canvasWidth - right) { x = left; baseline += 32; }
      item.x = x; item.y = baseline; x += item.width;
    }
    return { items, plotTop: baseline + 36, extraHeight: baseline - 112 };
  }

  function drawChart(canvas = $("curveCanvas"), exportMode = false) {
    if (!state.session) return;
    const channels = normalizedDisplayChannels();
    const exportLegend = exportMode ? buildExportLegendLayout(channels, 1800, 92, 48) : null;
    const dimensions = setupCanvas(canvas, exportMode ? 1800 : null, exportMode ? 1000 + exportLegend.extraHeight : null);
    const { ctx, width, height } = dimensions, activeSeries = state.session.channels[state.activeChannel], [start, end] = state.view;
    ctx.clearRect(0, 0, width, height); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
    const top = exportMode ? exportLegend.plotTop : 25, bottom = exportMode ? 82 : 48, left = exportMode ? 92 : 62, right = exportMode ? 48 : 24;
    if (exportMode) {
      ctx.fillStyle = "#153038"; ctx.font = "700 32px 'Microsoft YaHei', sans-serif"; ctx.fillText($("imageTitle").value || "温度记录曲线", left, 46);
      ctx.fillStyle = "#537078"; ctx.font = "18px 'Microsoft YaHei', sans-serif"; ctx.fillText([$("customerName").value, $("imageNote").value].filter(Boolean).join("  ·  "), left, 80);
      const channelText = channels.length === state.session.usableChannels.length
        ? `全部 ${channels.length} 通道`
        : channels.length <= 8 ? channels.map(channelLabel).join(" / ") : `已选 ${channels.length} 通道 · ${channels.slice(0, 3).map(channelLabel).join(" / ")} …`;
      ctx.textAlign = "right"; ctx.fillStyle = "#0d776d"; ctx.font = "700 18px 'Segoe UI', sans-serif"; ctx.fillText(`${channelText}  /  DMR Curve Studio`, width - right, 48); ctx.textAlign = "left";
      ctx.font = "600 15px 'Microsoft YaHei', sans-serif";
      for (const item of exportLegend.items) {
        if (item.type === "channel") {
          const channel = item.channel;
          ctx.strokeStyle = channelColor(channel); ctx.lineWidth = channel === state.activeChannel ? 4 : 2.5; ctx.beginPath(); ctx.moveTo(item.x, item.y); ctx.lineTo(item.x + 28, item.y); ctx.stroke();
          ctx.fillStyle = "#40575f"; ctx.fillText(`${channelLabel(channel)}${channel === state.activeChannel ? "（编辑）" : ""}`, item.x + 35, item.y + 5);
        } else {
          ctx.save(); ctx.setLineDash([7, 5]); ctx.strokeStyle = "#98a6ac"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(item.x, item.y); ctx.lineTo(item.x + 28, item.y); ctx.stroke(); ctx.restore();
          ctx.fillStyle = "#687a82"; ctx.fillText("当前通道原始值", item.x + 35, item.y + 5);
        }
      }
    }
    const values = [];
    for (const channel of channels) {
      const series = state.session.channels[channel];
      for (let i = start; i <= end; i++) if (Number.isFinite(series.targets[i])) values.push(series.targets[i]);
    }
    for (let i = start; i <= end; i++) if (Number.isFinite(activeSeries.original[i])) values.push(activeSeries.original[i]);
    if (!values.length && state.yAxis.mode !== "manual") return;
    let min, max, yTicks;
    if (state.yAxis.mode === "manual") {
      min = state.yAxis.min; max = state.yAxis.max;
      const divisions = Math.round((max - min) / state.yAxis.step);
      yTicks = Array.from({ length: divisions + 1 }, (_, index) => min + state.yAxis.step * index).reverse();
    } else {
      min = Math.min(...values); max = Math.max(...values); const pad = Math.max(2, (max - min) * .09); min -= pad; max += pad; if (min === max) { min -= 1; max += 1; }
      yTicks = Array.from({ length: 7 }, (_, index) => max - (max - min) * index / 6);
    }
    const plotW = width - left - right, plotH = height - top - bottom, xOf = i => left + (i - start) / Math.max(1, end - start) * plotW, yOf = v => top + (max - v) / (max - min) * plotH;
    ctx.strokeStyle = "#e4eaec"; ctx.lineWidth = 1; ctx.fillStyle = "#60727b"; ctx.font = `${exportMode ? 16 : 10}px 'Segoe UI', sans-serif`;
    const tickDecimals = state.yAxis.mode === "manual" && Math.abs(state.yAxis.step - Math.round(state.yAxis.step)) > 1e-9 ? Math.min(4, Math.max(1, String(state.yAxis.step).split(".")[1]?.length || 1)) : 1;
    for (const tick of yTicks) { const y = yOf(tick); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke(); const label = state.yAxis.mode === "manual" ? tick.toFixed(tickDecimals).replace(/\.0+$/, "") : tick.toFixed(1); ctx.textAlign = "right"; ctx.fillText(label, left - 9, y + 4); }
    for (let g = 0; g <= 8; g++) { const x = left + plotW * g / 8, index = Math.min(end, Math.round(start + (end - start) * g / 8)); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.stroke(); ctx.textAlign = g === 0 ? "left" : g === 8 ? "right" : "center"; const label = state.session.rows[index].time.slice(5, 16); ctx.fillText(label, x, top + plotH + (exportMode ? 31 : 21)); }
    const [selA, selB] = state.selection;
    if (!exportMode && selB >= start && selA <= end) { const x1 = xOf(Math.max(start, selA)), x2 = xOf(Math.min(end, selB)); ctx.fillStyle = "rgba(13,119,109,.055)"; ctx.fillRect(x1, top, Math.max(2, x2 - x1), plotH); ctx.strokeStyle = "rgba(13,119,109,.35)"; ctx.strokeRect(x1, top, Math.max(2, x2 - x1), plotH); }
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, plotW, plotH); ctx.clip();
    drawSeries(ctx, activeSeries.original, start, end, xOf, yOf, "#98a6ac", exportMode ? 2 : 1.35, plotW, { dash: exportMode ? [8, 6] : [5, 4], alpha: .9 });
    for (const channel of channels.filter(channel => channel !== state.activeChannel)) {
      drawSeries(ctx, state.session.channels[channel].targets, start, end, xOf, yOf, channelColor(channel), exportMode ? 2.6 : 1.55, plotW, { alpha: .88 });
    }
    drawSeries(ctx, activeSeries.targets, start, end, xOf, yOf, channelColor(state.activeChannel), exportMode ? 4.5 : 2.7, plotW);
    if (!exportMode && state.hoverIndex != null && state.hoverIndex >= start && state.hoverIndex <= end && Number.isFinite(activeSeries.targets[state.hoverIndex])) {
      const hx = xOf(state.hoverIndex), hy = yOf(activeSeries.targets[state.hoverIndex]);
      ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(13,119,109,.45)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, top); ctx.lineTo(hx, top + plotH); ctx.moveTo(left, hy); ctx.lineTo(left + plotW, hy); ctx.stroke();
      ctx.setLineDash([]);
      for (const channel of channels) {
        const value = state.session.channels[channel].targets[state.hoverIndex]; if (!Number.isFinite(value)) continue;
        ctx.fillStyle = "#fff"; ctx.strokeStyle = channelColor(channel); ctx.lineWidth = channel === state.activeChannel ? 2.4 : 1.7;
        ctx.beginPath(); ctx.arc(hx, yOf(value), channel === state.activeChannel ? 4.8 : 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
    ctx.strokeStyle = "#9caaaf"; ctx.lineWidth = 1; ctx.strokeRect(left, top, plotW, plotH);
    ctx.save(); ctx.translate(exportMode ? 28 : 17, top + plotH / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = "#526870"; ctx.font = `${exportMode ? 17 : 10}px 'Microsoft YaHei', sans-serif`; ctx.textAlign = "center"; ctx.fillText("温度（℃）", 0, 0); ctx.restore();
    if (!exportMode) {
      state.chartMeta = { left, right: width - right, top, bottom: top + plotH, min, max, start, end, width, height };
      const rows = state.session.rows;
      const axisText = state.yAxis.mode === "manual" ? ` · Y轴 ${min}～${max}℃ / ${state.yAxis.step}℃` : "";
      $("zoomStatus").textContent = `${rows[start].time.slice(5, 16)} ～ ${rows[end].time.slice(5, 16)} · ${end - start + 1} 点${axisText}`;
    }
  }

  function drawSeries(ctx, values, start, end, xOf, yOf, color, lineWidth, plotWidth, options = {}) {
    const step = Math.max(1, Math.floor((end - start + 1) / Math.max(300, plotWidth * 1.5)));
    ctx.save(); ctx.beginPath(); ctx.strokeStyle = color; ctx.globalAlpha = options.alpha == null ? 1 : options.alpha; ctx.setLineDash(options.dash || []); ctx.lineWidth = lineWidth; ctx.lineJoin = "round"; ctx.lineCap = "round"; let drawing = false;
    for (let i = start; i <= end; i += step) {
      const value = values[i]; if (!Number.isFinite(value)) { drawing = false; continue; }
      const x = xOf(i), y = yOf(value); if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
      // 抽稀跳过的点里若有断连空白，也要断开线段，避免连线跨过空白
      if (step > 1) for (let j = i + 1; j < i + step && j <= end; j++) if (!Number.isFinite(values[j])) { drawing = false; break; }
    }
    if (drawing && Number.isFinite(values[end])) ctx.lineTo(xOf(end), yOf(values[end])); ctx.stroke(); ctx.restore();
  }

  function canvasPoint(event) {
    const canvas = $("curveCanvas"), rect = canvas.getBoundingClientRect(), meta = state.chartMeta;
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const index = Math.max(meta.start, Math.min(meta.end, Math.round(meta.start + (x - meta.left) / (meta.right - meta.left) * (meta.end - meta.start))));
    const value = meta.max - (y - meta.top) / (meta.bottom - meta.top) * (meta.max - meta.min);
    return { x, y, index, value };
  }

  function beginDraw(event) {
    if (!state.session || !state.chartMeta) return;
    const p = canvasPoint(event); if (p.x < state.chartMeta.left || p.x > state.chartMeta.right || p.y < state.chartMeta.top || p.y > state.chartMeta.bottom) return;
    const wantsPan = !state.drawEnabled || event.button === 1 || event.button === 2 || event.shiftKey;
    if (wantsPan) {
      dismissChartTooltip(); drawChart();
      $("curveCanvas").setPointerCapture(event.pointerId);
      state.panDrag = { startX: event.clientX, view: [...state.view] };
      $("curveCanvas").style.cursor = "grabbing"; event.preventDefault(); return;
    }
    if (event.button !== 0) return;
    const series = state.session.channels[state.activeChannel];
    if (!Number.isFinite(series.targets[p.index]) && !state.gapDrawEnabled) {
      showToast("这里是热电偶断连空白，请先开启“断点补绘”", 3000); return;
    }
    const before = captureEditState(), channels = normalizedDisplayChannels();
    dismissChartTooltip();
    $("curveCanvas").setPointerCapture(event.pointerId);
    if (state.coordinatedDrawEnabled && channels.length > 1) {
      const baseTargets = Object.fromEntries(channels.map(channel => [channel, state.gapDrawEnabled
        ? core.fillMissingValues(before.targets[channel], 0, before.targets[channel].length - 1, { method: "linear" })
        : before.targets[channel].slice()]));
      const baseActive = baseTargets[state.activeChannel][p.index];
      if (!Number.isFinite(baseActive)) {
        try { $("curveCanvas").releasePointerCapture(event.pointerId); } catch (_) {}
        showToast("当前通道没有可用于协同补绘的有效温度，请先单通道绘制", 3600); return;
      }
      const delta = p.value - baseActive;
      const currentTargets = Object.fromEntries(channels.map(channel => [channel, state.session.channels[channel].targets]));
      const output = core.applyCoordinatedStroke(baseTargets, currentTargets, p.index, delta, p.index, delta);
      for (const channel of channels) state.session.channels[channel].targets = output[channel];
      state.drag = { before, last: { ...p, delta }, coordinated: true, channels, baseTargets };
    } else {
      state.drag = { before, last: p, coordinated: false };
      series.targets[p.index] = p.value;
    }
    drawChart(); event.preventDefault();
  }

  function continueDraw(event) {
    if (!state.session || !state.chartMeta) return;
    if (state.panDrag) {
      const span = state.panDrag.view[1] - state.panDrag.view[0];
      const pixels = Math.max(1, state.chartMeta.right - state.chartMeta.left);
      const offset = -Math.round((event.clientX - state.panDrag.startX) / pixels * span);
      setViewRange(state.panDrag.view[0] + offset, state.panDrag.view[1] + offset, "custom"); event.preventDefault(); return;
    }
    const p = canvasPoint(event), series = state.session.channels[state.activeChannel];
    if (state.drag) {
      if (state.drag.coordinated) {
        const baseActive = state.drag.baseTargets[state.activeChannel][p.index];
        if (!Number.isFinite(baseActive)) return;
        const delta = p.value - baseActive, last = state.drag.last;
        const currentTargets = Object.fromEntries(state.drag.channels.map(channel => [channel, state.session.channels[channel].targets]));
        const output = core.applyCoordinatedStroke(state.drag.baseTargets, currentTargets, last.index, last.delta, p.index, delta);
        for (const channel of state.drag.channels) state.session.channels[channel].targets = output[channel];
        state.drag.last = { ...p, delta }; drawChart(); event.preventDefault(); return;
      }
      const last = state.drag.last, from = Math.min(last.index, p.index), to = Math.max(last.index, p.index), span = p.index - last.index || 1;
      for (let i = from; i <= to; i++) if (Number.isFinite(series.targets[i]) || state.gapDrawEnabled) series.targets[i] = last.value + (p.value - last.value) * (i - last.index) / span;
      state.drag.last = p; drawChart(); event.preventDefault(); return;
    }
    state.hoverIndex = p.index; showChartTooltip(event, p); drawChart();
  }

  function endDraw(event) {
    if (state.panDrag) {
      state.panDrag = null; $("curveCanvas").style.cursor = state.drawEnabled ? "crosshair" : "grab";
      try { $("curveCanvas").releasePointerCapture(event.pointerId); } catch (_) {}
      return;
    }
    if (!state.drag) return;
    const before = state.drag.before, coordinated = state.drag.coordinated, channels = state.drag.channels || [state.activeChannel]; state.drag = null;
    pushUndo(before, coordinated ? `协同拖动绘制 ${channels.map(channelLabel).join("、")}` : "拖动绘制曲线"); renderAll();
    try { $("curveCanvas").releasePointerCapture(event.pointerId); } catch (_) {}
  }

  function showChartTooltip(event, p) {
    const row = state.session.rows[p.index], tip = $("chartTooltip");
    const channels = normalizedDisplayChannels();
    const lines = channels.map(channel => {
      const series = state.session.channels[channel], original = series.original[p.index], target = series.targets[p.index];
      const changed = Number.isFinite(target) && (!Number.isFinite(original) || Math.abs(original - target) > 1e-9);
      const gapFilled = !Number.isFinite(original) && Number.isFinite(target);
      const value = target == null ? "—" : `${target.toFixed(2)} ℃`;
      const detail = channel === state.activeChannel
        ? ` <em>编辑</em> · 原始 ${original == null ? "断连" : original.toFixed(2) + " ℃"} → ${value}${gapFilled ? " · 已补全" : ""}`
        : ` · ${value}${gapFilled ? " · 已补全" : changed ? " · 已修改" : ""}`;
      return `<span class="tooltip-channel" style="--channel-color:${channelColor(channel)}"><i></i><b>${channelLabel(channel)}</b>${detail}</span>`;
    }).join("");
    const editHint = state.coordinatedDrawEnabled && channels.length > 1
      ? `<br>拖动将以相同温差联动 ${channels.length} 个通道`
      : `<br>拖动只修改 ${channelLabel(state.activeChannel)}`;
    tip.innerHTML = `<strong>${row.time}</strong><div class="tooltip-channel-list">${lines}</div><small>物理记录：${row.physicalRecordIndex}${editHint}</small>`;
    configureChartTooltip(tip, channels.length);
    tip.classList.remove("hidden"); positionChartTooltip(tip, p);
  }

  function configureChartTooltip(tip, channelCount) {
    const wrap = $("curveCanvas").parentElement.getBoundingClientRect();
    const maximumColumns = Math.max(1, Math.min(4, Math.floor((wrap.width - 20) / 215)));
    const columns = Math.max(1, Math.min(maximumColumns, Math.ceil(channelCount / 8)));
    tip.classList.toggle("dense", channelCount > 32);
    tip.style.setProperty("--tooltip-columns", columns);
    tip.style.width = `${Math.min(wrap.width - 20, columns === 1 ? 270 : columns * 250)}px`;
  }

  function positionChartTooltip(tip, p) {
    const wrap = $("curveCanvas").parentElement.getBoundingClientRect(), margin = 10;
    const width = Math.min(tip.offsetWidth, Math.max(0, wrap.width - margin * 2));
    const height = Math.min(tip.offsetHeight, Math.max(0, wrap.height - margin * 2));
    const left = p.x < wrap.width / 2 ? wrap.width - width - margin : margin;
    const top = p.y < wrap.height / 2 ? wrap.height - height - margin : margin;
    tip.style.left = `${Math.max(margin, left)}px`;
    tip.style.top = `${Math.max(margin, top)}px`;
    tip.dataset.placement = `${p.y < wrap.height / 2 ? "bottom" : "top"}-${p.x < wrap.width / 2 ? "right" : "left"}`;
  }

  function dismissChartTooltip() {
    state.hoverIndex = null; $("chartTooltip").classList.add("hidden");
  }

  function hideTooltip() { if (!state.drag && !state.panDrag) { dismissChartTooltip(); drawChart(); } }

  function remapSession() {
    const start = Number($("manualStartRecord").value), total = state.session.plr.layout.totalRecords;
    if (!Number.isInteger(start) || start < 0 || start >= total) return showToast(`物理记录必须在 0 到 ${total - 1} 之间`);
    if (totalChangedPoints() && !confirm("重新映射会清空当前编辑，是否继续？")) return;
    const score = core.scoreAlignment(state.session.excel, state.session.plr, start, { rawPerCelsius: state.session.scale });
    const alignment = { ...score, secondBest: state.session.alignment.secondBest, gap: 0, confidence: score.meanAbsError <= 1.2 ? "high" : score.meanAbsError <= 3 ? "medium" : "low", candidates: [score] };
    state.session = core.buildSession(state.session.plr, state.session.excel, alignment, { rawPerCelsius: state.session.scale });
    state.selection = [0, state.session.rows.length - 1]; state.view = [...state.selection]; state.undo = []; state.redo = []; initializeWorkspace(); showToast(`已改用物理记录 ${start}，平均误差 ${score.meanAbsError.toFixed(3)} ℃`);
  }

  function validateOutput(downloadPlr = false, enforceRequirements = true) {
    if (enforceRequirements && !requirementsAllowExport()) return null;
    try {
      const output = core.createModifiedPlr(state.session); state.latestOutput = output;
      const d = output.diff, badge = $("validationBadge"); badge.className = "badge ok"; badge.textContent = "兼容性检查通过";
      const customer = state.requirementResult && state.requirementResult.passed ? `客户要求 <b>${state.requirementResult.rules.length}/${state.requirementResult.rules.length}</b> 通过；` : "";
      $("validationSummary").innerHTML = `${customer}文件长度 <b>${d.fileSize}</b> 字节保持不变；头部/索引区 <b>0</b> 字节变化；计划修改 <b>${d.plannedEdits}</b> 个温度点；实际变化 <b>${d.changedBytes}</b> 个字节；非目标字节 <b>${d.unexpectedBytes}</b> 个。`;
      $("step3").classList.add("active", "done"); $("step4").classList.add("active");
      if (downloadPlr) { download(output.buffer, `${sourceStem()}_edited.PLR`, "application/octet-stream"); $("step4").classList.add("done"); }
      return output;
    } catch (error) {
      const badge = $("validationBadge"); badge.className = "badge error"; badge.textContent = "校验失败"; $("validationSummary").textContent = error.message; showToast(error.message, 4500); return null;
    }
  }

  function sourceStem() { return (state.plrFile ? state.plrFile.name : "DMR_curve").replace(/\.plr$/i, ""); }

  function download(data, filename, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type }); const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportCsv() {
    const output = state.latestOutput || validateOutput(false, false); if (!output) return;
    download(core.exportCsv(state.session, output.edits), `${sourceStem()}_changes.csv`, "text/csv;charset=utf-8");
  }

  function exportProject() {
    const json = JSON.stringify(core.sessionProject(state.session), null, 2); download(json, `${sourceStem()}_project.json`, "application/json;charset=utf-8");
  }

  async function importProject(file) {
    try { const project = JSON.parse(await file.text()), before = captureEditState(); core.applyProject(state.session, project); pushUndo(before, "载入编辑项目"); renderAll(); showToast("项目编辑值已载入"); }
    catch (error) { showToast(`项目载入失败：${error.message}`, 4500); }
  }

  async function verifyWithDmrExcel(file) {
    try {
      const exported = core.parseExcelBytes(await file.arrayBuffer());
      const result = core.verifyDmrExport(state.session, exported, { tolerance: 1 });
      const badge = $("validationBadge");
      if (result.passed) {
        badge.className = "badge ok"; badge.textContent = "DMR 回读验证通过";
        $("validationSummary").innerHTML = `DMR 回读共对比 <b>${result.validCompared}</b> 个有效通道点；计划修改 <b>${result.plannedMatched}/${result.plannedTotal}</b> 命中；未修改点 <b>${result.unchangedMatched}/${result.unchangedTotal}</b> 保持；不一致 <b>0</b>；缺少时间行 <b>0</b>。`;
        $("step3").classList.add("active", "done"); $("step4").classList.add("active", "done");
        showToast("DMR 回读 Excel 与目标曲线一致");
      } else {
        badge.className = "badge error"; badge.textContent = "DMR 回读存在差异";
        const first = result.mismatches[0];
        $("validationSummary").innerHTML = `已对比 <b>${result.validCompared}</b> 个有效点；不一致 <b>${result.mismatched}</b>；缺少时间行 <b>${result.missing}</b>。${first ? `首个差异：${first.time} 通道${String(first.channel).padStart(2, "0")}，目标 ${first.expected}℃，DMR ${first.actual == null ? "无值" : first.actual + "℃"}。` : ""}`;
        showToast("DMR 回读存在差异，请查看校验摘要", 4500);
      }
    } catch (error) { showToast(`DMR 回读失败：${error.message}`, 4500); }
  }

  function exportPng() {
    if (!requirementsAllowExport()) return;
    const canvas = document.createElement("canvas"); drawChart(canvas, true);
    canvas.toBlob(blob => { if (blob) download(blob, `${sourceStem()}_curve.png`, "image/png"); }, "image/png", 1);
  }

  async function loadDemo() {
    const button = $("loadDemoBtn"); button.disabled = true; button.textContent = "正在读取…";
    try {
      const [plr, xls] = await Promise.all([fetch("/fixtures/DAT0131.PLR"), fetch("/fixtures/curve.xls")]);
      if (!plr.ok || !xls.ok) throw new Error("示例文件未安装");
      state.plrFile = new File([await plr.blob()], "DAT0131.PLR"); state.excelFile = new File([await xls.blob()], "curve.xls");
      $("plrFileName").textContent = `${state.plrFile.name} · ${formatBytes(state.plrFile.size)}`; $("excelFileName").textContent = `${state.excelFile.name} · ${formatBytes(state.excelFile.size)}`; updateImportButton(); await loadFiles();
    } catch (error) { showToast(error.message, 4200); }
    finally { button.disabled = false; button.textContent = "载入项目示例"; }
  }

  bindFileInput("plrFile", "plrFile", "plrFileName"); bindFileInput("excelFile", "excelFile", "excelFileName");
  $("importBtn").addEventListener("click", loadFiles); $("loadDemoBtn").addEventListener("click", loadDemo);
  $("channelSelect").addEventListener("change", e => setActiveChannel(e.target.value));
  $("showOnlyActiveBtn").addEventListener("click", () => { state.displayChannels = [state.activeChannel]; renderChannelControls(); renderChartTitle(); drawChart(); });
  $("showAllChannelsBtn").addEventListener("click", () => { state.displayChannels = state.session.usableChannels.slice(); renderChannelControls(); renderChartTitle(); drawChart(); });
  $("rangeStart").addEventListener("input", () => { normalizeSelection(); renderRange(); renderStats(); drawChart(); });
  $("rangeEnd").addEventListener("input", () => { normalizeSelection(); renderRange(); renderStats(); drawChart(); });
  $("selectAllBtn").addEventListener("click", () => { $("rangeStart").value = 0; $("rangeEnd").value = state.session.rows.length - 1; normalizeSelection(); renderAll(false); });
  $("zoomSelectionBtn").addEventListener("click", () => setViewRange(state.selection[0], state.selection[1], "custom"));
  $("applyYAxisBtn").addEventListener("click", applyYAxis); $("autoYAxisBtn").addEventListener("click", resetYAxis);
  $("fitAllBtn").addEventListener("click", () => setViewRange(0, state.session.rows.length - 1, "all"));
  $("timeWindowSelect").addEventListener("change", e => applyTimeWindow(e.target.value));
  $("zoomInBtn").addEventListener("click", () => zoomView(0.72)); $("zoomOutBtn").addEventListener("click", () => zoomView(1.38));
  $("panPrevBtn").addEventListener("click", () => panView(-Math.max(1, Math.round((state.view[1] - state.view[0]) * .7))));
  $("panNextBtn").addEventListener("click", () => panView(Math.max(1, Math.round((state.view[1] - state.view[0]) * .7))));
  $("operationMode").addEventListener("change", renderOperationFields); $("operationScope").addEventListener("change", renderOperationScopeHint); $("applyOperationBtn").addEventListener("click", applyBatchOperation); $("restoreSelectionBtn").addEventListener("click", restoreSelection);
  $("undoBtn").addEventListener("click", undo); $("redoBtn").addEventListener("click", redo);
  $("prevPage").addEventListener("click", () => { state.page--; renderTable(); }); $("nextPage").addEventListener("click", () => { state.page++; renderTable(); });
  $("coordinatedDrawBtn").addEventListener("click", toggleCoordinatedDraw);
  $("gapDrawBtn").addEventListener("click", toggleGapDraw);
  $("drawModeBtn").addEventListener("click", () => setDrawEnabled(!state.drawEnabled));
  $("curveCanvas").addEventListener("pointerdown", beginDraw); $("curveCanvas").addEventListener("pointermove", continueDraw); $("curveCanvas").addEventListener("pointerup", endDraw); $("curveCanvas").addEventListener("pointercancel", endDraw); $("curveCanvas").addEventListener("pointerleave", hideTooltip);
  $("curveCanvas").addEventListener("wheel", handleChartWheel, { passive: false });
  $("curveCanvas").addEventListener("dblclick", () => setViewRange(0, state.session.rows.length - 1, "all"));
  $("curveCanvas").addEventListener("contextmenu", e => e.preventDefault());
  $("addHeatingRequirementBtn").addEventListener("click", () => { const before = captureEditState(); addRequirement("heating"); pushUndo(before, "添加升温客户要求"); });
  $("addHoldingRequirementBtn").addEventListener("click", () => { const before = captureEditState(); addRequirement("holding"); pushUndo(before, "添加保温客户要求"); });
  $("addCoolingRequirementBtn").addEventListener("click", () => { const before = captureEditState(); addRequirement("cooling"); pushUndo(before, "添加降温客户要求"); });
  $("validateRequirementsBtn").addEventListener("click", () => runRequirementValidation(true));
  $("requirementGate").addEventListener("change", setValidationWaiting);
  $("remapBtn").addEventListener("click", remapSession); $("exportPlrBtn").addEventListener("click", () => validateOutput(true)); $("exportCsvBtn").addEventListener("click", exportCsv); $("exportPngBtn").addEventListener("click", exportPng); $("exportProjectBtn").addEventListener("click", exportProject);
  $("projectFile").addEventListener("change", e => { if (e.target.files[0]) importProject(e.target.files[0]); e.target.value = ""; });
  $("verificationFile").addEventListener("change", e => { if (e.target.files[0]) verifyWithDmrExcel(e.target.files[0]); e.target.value = ""; });
  let resizePending = false;
  window.addEventListener("resize", () => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => { resizePending = false; resizeAndDraw(); });
  });
  document.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); } });
  renderOperationFields();
})();
