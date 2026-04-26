/* ============================================================
   On The Road Analyzer — DeX edition
   Vanilla JS + uPlot. State, plots, sessions, transfer windows.
   ============================================================ */

// ----- Constants -----
const STOICH = 14.7;
const SESSION_COLORS = [
  '#ff7a00', '#4dc4ff', '#4ade80', '#ff5577',
  '#ffd24a', '#a78bfa', '#67e8f9', '#fb923c',
];

// ----- App state -----
const state = {
  sessions: [],          // [{id, name, color, visible, t, afr, rpm, tpsRaw, tpsCal, offset, fileName}]
  mode: 'afr',           // 'afr' | 'lambda'
  rangeSelect: { active: false, t1: null, t2: null },
  range: null,           // {t1, t2} after selection
  nextId: 1,
  alignSession: null,    // session id being aligned, or null
  lastCursorX: null,     // last cursor X value (data coords)
  settings: {
    tpsTol:     0.5,     // ±% TPS bin tolerance
    rpmTol:     50,      // ±rpm bin tolerance
    minSamples: 3,       // minimum samples per bin
    afrLean:    15.5,    // lean redline (AFR)
    afrRich:    12.5,    // rich redline (AFR)
  },
};

// ============================================================
// LOCAL STORAGE — persist calibrations + settings
// ============================================================
function saveSessionState(s) {
  try {
    const db = JSON.parse(localStorage.getItem('otr-sessions') || '{}');
    db[s.fileName] = { tpsCal: s.tpsCal, offset: s.offset, color: s.color };
    localStorage.setItem('otr-sessions', JSON.stringify(db));
  } catch(e) {}
}
function loadSessionState(fileName) {
  try {
    return JSON.parse(localStorage.getItem('otr-sessions') || '{}')[fileName] || null;
  } catch(e) { return null; }
}
function saveSettings() {
  try { localStorage.setItem('otr-settings', JSON.stringify(state.settings)); } catch(e) {}
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('otr-settings') || 'null');
    if (s) Object.assign(state.settings, s);
  } catch(e) {}
}

// ----- DOM refs -----
const $ = (id) => document.getElementById(id);
const elBtnImport     = $('btnImport');
const elFileInput     = $('fileInput');
const elBtnAfr        = $('modeAfr');
const elBtnLambda     = $('modeLambda');
const elBtnRange      = $('btnRangeSelect');
const elBtnClearR     = $('btnClearRange');
const elBtnPng        = $('btnExportPng');
const elBtnClearAll   = $('btnClearAll');
const elBtnSettings   = $('btnSettings');
const elSettingsPanel = $('settingsPanel');
const elSetTpsTol     = $('setTpsTol');
const elSetRpmTol     = $('setRpmTol');
const elSetMinSamples = $('setMinSamples');
const elSetAfrLean    = $('setAfrLean');
const elSetAfrRich    = $('setAfrRich');
const elSessionList   = $('sessionList');
const elSessionCount  = $('sessionCount');
const elStatus        = $('status');
const elAfrLabel      = $('afrLabel');
const elRangeBanner   = $('rangeBanner');
const elRangeText     = $('rangeBannerText');
const elBtnRangeCancel = $('btnRangeCancel');

// ----- Status -----
function setStatus(text, level='ok') {
  elStatus.textContent = text;
  elStatus.className = 'status' + (level === 'warn' ? ' warn' : level === 'error' ? ' error' : '');
}

// ============================================================
// SETTINGS PANEL
// ============================================================
function syncSettingsInputs() {
  elSetTpsTol.value     = state.settings.tpsTol;
  elSetRpmTol.value     = state.settings.rpmTol;
  elSetMinSamples.value = state.settings.minSamples;
  elSetAfrLean.value    = state.settings.afrLean;
  elSetAfrRich.value    = state.settings.afrRich;
}
function onSettingChange() {
  state.settings.tpsTol     = parseFloat(elSetTpsTol.value)    || 0.5;
  state.settings.rpmTol     = parseFloat(elSetRpmTol.value)    || 50;
  state.settings.minSamples = parseInt(elSetMinSamples.value)  || 3;
  state.settings.afrLean    = parseFloat(elSetAfrLean.value)   || 15.5;
  state.settings.afrRich    = parseFloat(elSetAfrRich.value)   || 12.5;
  saveSettings();
  drawRangeMarkers();           // redraws AFR redlines
  if (state.range) openTransferWindows(); // refresh bins
}
elBtnSettings.addEventListener('click', () => {
  elSettingsPanel.classList.toggle('hidden');
  elBtnSettings.classList.toggle('btn-settings-active',
    !elSettingsPanel.classList.contains('hidden'));
});
[elSetTpsTol, elSetRpmTol, elSetMinSamples, elSetAfrLean, elSetAfrRich].forEach(el => {
  el.addEventListener('change', onSettingChange);
});

// ============================================================
// CSV IMPORT
// Uses showOpenFilePicker (File System Access API) where available —
// opens the real file manager, not the media picker.
// Falls back to <input type="file"> for browsers that lack it.
// ============================================================
async function importFiles(files) {
  if (!files.length) { setStatus('NO FILES', 'warn'); return; }
  setStatus(`LOADING ${files.length}…`);
  let loaded = 0;
  for (const file of files) {
    try {
      await loadCsvFile(file);
      loaded++;
    } catch (err) {
      console.error(err);
      setStatus(`ERR: ${err.message || file.name}`, 'error');
      return; // stop and keep the error visible
    }
  }
  rebuildAll();
  setStatus(loaded ? `READY` : 'NO DATA', loaded ? 'ok' : 'warn');
}

elBtnImport.addEventListener('click', async () => {
  if ('showOpenFilePicker' in window) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        multiple: true,
        excludeAcceptAllOption: false,
        types: [{ description: 'CSV log files', accept: { 'text/csv': ['.csv'], 'text/plain': ['.csv'] } }],
      });
    } catch(e) {
      if (e.name === 'AbortError') return; // user cancelled
      setStatus(`PICKER ERR: ${e.message}`, 'error');
      return;
    }
    let files;
    try {
      files = await Promise.all(handles.map(h => h.getFile()));
    } catch(e) {
      setStatus(`FILE READ ERR: ${e.message}`, 'error');
      return;
    }
    await importFiles(files);
    return;
  }
  elFileInput.click();
});

// Legacy fallback change handler
elFileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  elFileInput.value = '';
  await importFiles(files);
});

function loadCsvFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('File read failed'));
    reader.onload = (ev) => {
      try {
        const text  = ev.target.result;
        const lines = text.split(/\r?\n/);

        // Extract embedded TPS calibration from comment lines (#tps_cal:zero=...,full=...,dir=...)
        let tpsCalFromFile = null;
        for (const line of lines) {
          if (!line.startsWith('#')) continue;
          const m = line.match(/zero=([\d.]+),full=([\d.]+),dir=(\w+)/);
          if (m) {
            tpsCalFromFile = {
              closed: parseFloat(m[1]),
              wot:    parseFloat(m[2]),
              ccw:    m[3] === 'ccw',
            };
          }
        }

        // Strip comment lines then parse
        const csvText = lines.filter(l => !l.startsWith('#')).join('\n');

        Papa.parse(csvText, {
          header: true,
          dynamicTyping: true,
          skipEmptyLines: true,
          complete: (res) => {
            try {
              const rows = res.data.filter(r =>
                r.t_ms !== undefined && r.t_ms !== null && !Number.isNaN(+r.t_ms)
              );
              if (!rows.length) return reject(new Error('No valid rows'));

              const t      = new Float64Array(rows.length);
              const afr    = new Float64Array(rows.length);
              const rpm    = new Float64Array(rows.length);
              const tpsRaw = new Float64Array(rows.length);

              for (let i=0; i<rows.length; i++) {
                const r = rows[i];
                t[i]      = (+r.t_ms) / 1000.0;
                const a = +r.afr;
                afr[i]    = (Number.isFinite(a) && a >= 8.5 && a <= 20.0) ? a : NaN;
                rpm[i]    = Number.isFinite(+r.rpm)     ? +r.rpm     : NaN;
                tpsRaw[i] = Number.isFinite(+r.tps_deg) ? +r.tps_deg : NaN;
              }

              const id = state.nextId++;
              const colorIdx = state.sessions.length % SESSION_COLORS.length;
              const sess = {
                id,
                fileName: file.name,
                name: file.name.replace(/\.csv$/i, ''),
                color: SESSION_COLORS[colorIdx],
                visible: true,
                t, afr, rpm, tpsRaw,
                tpsCal: tpsCalFromFile || { closed: 0, wot: 90, ccw: false },
                offset: 0,
              };

              // Saved user calibration overrides the embedded one
              const saved = loadSessionState(file.name);
              if (saved) {
                if (saved.tpsCal) sess.tpsCal = saved.tpsCal;
                if (saved.offset !== undefined) sess.offset = saved.offset;
                if (saved.color)  sess.color  = saved.color;
              }

              state.sessions.push(sess);
              resolve();
            } catch(e) { reject(e); }
          },
          error: reject,
        });
      } catch(e) { reject(e); }
    };
    reader.readAsText(file);
  });
}

// ============================================================
// uPlot PLUGINS
// ============================================================

// Range band — draws a shaded region + dashed border for the selected time range.
function makeRangeBandPlugin() {
  return {
    hooks: {
      draw: [u => {
        if (!state.range) return;
        if (!u.data[0] || !u.data[0].length) return;
        const { t1, t2 } = state.range;
        const px1 = u.valToPos(t1, 'x', true);
        const px2 = u.valToPos(t2, 'x', true);
        const { left, top, width, height } = u.bbox;
        const c1 = Math.max(left, Math.min(left + width, px1));
        const c2 = Math.max(left, Math.min(left + width, px2));
        if (c2 <= c1) return;
        const ctx = u.ctx;
        ctx.save();
        ctx.fillStyle = 'rgba(255,122,0,0.07)';
        ctx.fillRect(c1, top, c2 - c1, height);
        ctx.strokeStyle = 'rgba(255,122,0,0.4)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(px1, top); ctx.lineTo(px1, top + height);
        ctx.moveTo(px2, top); ctx.lineTo(px2, top + height);
        ctx.stroke();
        ctx.restore();
      }]
    }
  };
}

// AFR / λ redlines — stoich (solid green), lean (dashed blue), rich (dashed red).
function makeAfrRedlinePlugin() {
  return {
    hooks: {
      draw: [u => {
        const { afrLean, afrRich } = state.settings;
        const yIsLambda = state.mode === 'lambda';
        const lean   = yIsLambda ? afrLean / STOICH : afrLean;
        const rich   = yIsLambda ? afrRich / STOICH : afrRich;
        const stoich = yIsLambda ? 1.0 : STOICH;
        const { left, top, width, height } = u.bbox;
        const ctx = u.ctx;

        const pyLean   = u.valToPos(lean,   'y', true);
        const pyRich   = u.valToPos(rich,   'y', true);
        const pyStoich = u.valToPos(stoich, 'y', true);

        ctx.save();

        // Subtle background tints
        if (pyLean > top) {
          ctx.fillStyle = 'rgba(77,196,255,0.04)';
          ctx.fillRect(left, top, width, pyLean - top);
        }
        if (pyRich < top + height) {
          ctx.fillStyle = 'rgba(255,85,55,0.04)';
          ctx.fillRect(left, pyRich, width, (top + height) - pyRich);
        }

        // Lean line
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(77,196,255,0.55)';
        ctx.beginPath();
        ctx.moveTo(left, pyLean); ctx.lineTo(left + width, pyLean);
        ctx.stroke();

        // Rich line
        ctx.strokeStyle = 'rgba(255,85,55,0.55)';
        ctx.beginPath();
        ctx.moveTo(left, pyRich); ctx.lineTo(left + width, pyRich);
        ctx.stroke();

        // Stoich line
        ctx.setLineDash([]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(74,222,128,0.72)';
        ctx.beginPath();
        ctx.moveTo(left, pyStoich); ctx.lineTo(left + width, pyStoich);
        ctx.stroke();

        ctx.restore();
      }]
    }
  };
}

// ============================================================
// uPlot — three vertically stacked, X-linked plots
// ============================================================
let plotAfr = null, plotRpm = null, plotTps = null;

// uPlot cursor sync — shared key so all three plots show a vertical line together.
const plotSync = uPlot.sync('otr-sync');

// CSS cursor line — a single div spanning all three plots, repositioned on mousemove.
const elCursorLine = $('cursorLine');
const elPlots      = $('plots');

function showCursorLine(u) {
  if (!elCursorLine || !elPlots) return;
  const canvas = u.root && u.root.querySelector('canvas');
  if (!canvas) return;
  const canvasRect = canvas.getBoundingClientRect();
  const plotsRect  = elPlots.getBoundingClientRect();
  const dpr        = window.devicePixelRatio || 1;
  const axisWidth  = u.bbox.left / dpr;           // y-axis width in CSS px
  const clientX    = canvasRect.left + axisWidth + u.cursor.left;
  const relX       = clientX - plotsRect.left;
  elCursorLine.style.left    = relX + 'px';
  elCursorLine.style.display = 'block';
}
function hideCursorLine() {
  if (elCursorLine) elCursorLine.style.display = 'none';
}

function makePlot(targetEl, yRange, yFormatFn, extraPlugins = []) {
  const opts = {
    width:  targetEl.clientWidth,
    height: targetEl.clientHeight,
    cursor: {
      drag: { x: true, y: false, uni: 30 },
      points: { show: true },
      sync: { key: plotSync.key, setSeries: false },
    },
    scales: {
      x: { time: false },
      y: yRange ? { range: () => yRange } : {},
    },
    axes: [
      {
        stroke: '#888',
        grid:   { stroke: '#2a2a2a', width: 1 },
        ticks:  { stroke: '#3a3a3a', width: 1 },
        size:   30,
        font:   '11px JetBrains Mono',
        values: (u, splits) => splits.map(v => v.toFixed(1) + 's'),
      },
      {
        stroke: '#888',
        grid:   { stroke: '#2a2a2a', width: 1 },
        ticks:  { stroke: '#3a3a3a', width: 1 },
        size:   55,
        font:   '11px JetBrains Mono',
        values: (u, splits) => splits.map(v => yFormatFn ? yFormatFn(v) : v.toFixed(0)),
      },
    ],
    series: [{ label: 't' }],
    plugins: [makeRangeBandPlugin(), ...extraPlugins],
    hooks: {
      setCursor: [ u => onCursor(u) ],
      setSelect: [ u => onSelect(u) ],
    },
  };
  return new uPlot(opts, [[]], targetEl);
}

function buildPlots() {
  const afrEl = $('plotAfr');
  const rpmEl = $('plotRpm');
  const tpsEl = $('plotTps');

  const yIsLambda = state.mode === 'lambda';
  const afrRange = yIsLambda ? [0.6, 1.3] : [10.0, 18.0];
  const afrFmt = (v) => yIsLambda ? v.toFixed(2) : v.toFixed(1);

  if (plotAfr) plotAfr.destroy();
  if (plotRpm) plotRpm.destroy();
  if (plotTps) plotTps.destroy();

  plotAfr = makePlot(afrEl, afrRange, afrFmt, [makeAfrRedlinePlugin()]);
  plotRpm = makePlot(rpmEl, [0, 7000],  v => v.toFixed(0));
  plotTps = makePlot(tpsEl, [-5, 105],  v => v.toFixed(0)+'%');

  window.removeEventListener('resize', resizePlots);
  window.addEventListener('resize', resizePlots);
}

function resizePlots() {
  for (const [u, sel] of [[plotAfr,'#plotAfr'],[plotRpm,'#plotRpm'],[plotTps,'#plotTps']]) {
    if (!u) continue;
    const el = document.querySelector(sel);
    u.setSize({ width: el.clientWidth, height: el.clientHeight });
  }
}

// ============================================================
// REBUILD plot data from current sessions + mode
// ============================================================
function rebuildAll() {
  rebuildSidebar();
  if (!plotAfr) buildPlots();
  rebuildPlotData();
}

function rebuildPlotData() {
  const visible = state.sessions.filter(s => s.visible);

  const yIsLambda = state.mode === 'lambda';
  elAfrLabel.textContent = yIsLambda ? 'λ' : 'AFR';
  elBtnAfr.classList.toggle('active', !yIsLambda);
  elBtnLambda.classList.toggle('active', yIsLambda);

  buildPlots();

  if (!visible.length) {
    plotAfr.setData([[]]); plotRpm.setData([[]]); plotTps.setData([[]]);
    return;
  }

  // Build merged timeline
  const timeSet = new Set();
  for (const s of visible) {
    const off = s.offset;
    for (let i=0; i<s.t.length; i++) timeSet.add(s.t[i] + off);
  }
  const xs = Float64Array.from(timeSet).sort();

  const afrData = [xs], rpmData = [xs], tpsData = [xs];

  for (const s of visible) {
    const off = s.offset;
    const idxByT = new Map();
    for (let i=0; i<s.t.length; i++) idxByT.set(s.t[i] + off, i);

    const afrSer = new Array(xs.length);
    const rpmSer = new Array(xs.length);
    const tpsSer = new Array(xs.length);
    const cal = s.tpsCal;

    for (let i=0; i<xs.length; i++) {
      const j = idxByT.get(xs[i]);
      if (j === undefined) { afrSer[i]=null; rpmSer[i]=null; tpsSer[i]=null; continue; }
      const a = s.afr[j], r = s.rpm[j], tpRaw = s.tpsRaw[j];
      afrSer[i] = Number.isFinite(a) ? (yIsLambda ? a / STOICH : a) : null;
      rpmSer[i] = Number.isFinite(r) ? r : null;
      tpsSer[i] = Number.isFinite(tpRaw) ? calibrateTps(tpRaw, cal.closed, cal.wot, cal.ccw) : null;
    }
    afrData.push(afrSer); rpmData.push(rpmSer); tpsData.push(tpsSer);
    addSeriesToPlot(plotAfr, s);
    addSeriesToPlot(plotRpm, s);
    addSeriesToPlot(plotTps, s);
  }

  plotAfr.setData(afrData);
  plotRpm.setData(rpmData);
  plotTps.setData(tpsData);

  drawRangeMarkers();
}

function addSeriesToPlot(u, s) {
  u.addSeries({
    label: s.name,
    stroke: s.color,
    width: 1.5,
    points: { show: false },
    spanGaps: false,
  });
}

// ============================================================
// TPS calibration with modular wraparound
// ============================================================
function calibrateTps(raw, closed, wot, ccw = false) {
  // For CCW sensors the rotation direction is reversed — flip closed/wot and invert result.
  if (ccw) return 100 - calibrateTps(raw, wot, closed, false);
  const nraw = ((raw % 360) + 360) % 360;
  const nc   = ((closed % 360) + 360) % 360;
  const nw   = ((wot    % 360) + 360) % 360;
  let arc = (nw - nc + 360) % 360;
  if (arc === 0) arc = 1;
  let pos = (nraw - nc + 360) % 360;
  if (pos > arc + (360 - arc) / 2) pos -= 360;
  return (pos / arc) * 100;
}

// ============================================================
// SIDEBAR
// ============================================================
function rebuildSidebar() {
  elSessionCount.textContent = state.sessions.length;
  if (!state.sessions.length) {
    elSessionList.innerHTML = `
      <div class="empty-state">
        <div class="empty-glyph">⌀</div>
        <div class="empty-text">No sessions loaded</div>
        <div class="empty-hint">Import a CSV from your Tuner</div>
      </div>`;
    return;
  }

  elSessionList.innerHTML = '';
  for (const s of state.sessions) {
    const dur = s.t[s.t.length-1] - s.t[0];
    const isAligning = state.alignSession === s.id;
    const div = document.createElement('div');
    div.className = 'session'
      + (s.visible  ? '' : ' hidden-row')
      + (isAligning ? ' aligning' : '');
    div.style.borderLeftColor = s.color;
    div.innerHTML = `
      <div class="session-row1">
        <button class="session-vis ${s.visible ? 'on' : ''}" data-act="vis" data-id="${s.id}" title="Toggle visibility">
          ${s.visible ? '●' : '○'}
        </button>
        <div class="session-name" title="${s.fileName}">${s.name}</div>
      </div>
      <div class="session-meta">
        <span>${s.t.length} pts</span>
        <span>${dur.toFixed(1)}s</span>
        <span>off ${s.offset.toFixed(1)}s</span>
      </div>
      <div class="session-actions">
        <button data-act="cal"   data-id="${s.id}">CAL</button>
        <button data-act="color" data-id="${s.id}">COLOR</button>
        <button data-act="align" data-id="${s.id}" class="${isAligning ? 'align-active' : ''}" title="Hover over a reference point, then click to pin it to t=0">ALIGN</button>
        <button class="btn-remove" data-act="remove" data-id="${s.id}">DEL</button>
      </div>
    `;
    elSessionList.appendChild(div);
  }
}

elSessionList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = +btn.dataset.id;
  const act = btn.dataset.act;
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;

  if (act === 'vis') {
    s.visible = !s.visible;
    rebuildAll();
  } else if (act === 'remove') {
    state.sessions = state.sessions.filter(x => x.id !== id);
    if (state.alignSession === id) { state.alignSession = null; setStatus('READY'); }
    rebuildAll();
  } else if (act === 'color') {
    const idx = SESSION_COLORS.indexOf(s.color);
    s.color = SESSION_COLORS[(idx + 1) % SESSION_COLORS.length];
    saveSessionState(s);
    rebuildAll();
  } else if (act === 'cal') {
    openCalModal(s);
  } else if (act === 'align') {
    if (state.alignSession === s.id) {
      // Cancel
      state.alignSession = null;
      setStatus('READY');
      rebuildSidebar();
    } else {
      state.alignSession = s.id;
      setStatus('ALIGN — hover to reference point, then click plot', 'warn');
      rebuildSidebar();
    }
  }
});

// ============================================================
// ALIGN TO CURSOR — click on a plot to pin that time to t=0
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  // Clear cursor line when mouse leaves the plots area
  document.getElementById('plots').addEventListener('mouseleave', () => {
    state.lastCursorX = null;
    hideCursorLine();
  });

  ['plotAfr', 'plotRpm', 'plotTps'].forEach(id => {
    document.getElementById(id).addEventListener('click', () => {
      if (state.alignSession === null || state.lastCursorX === null) return;
      const s = state.sessions.find(x => x.id === state.alignSession);
      if (!s) { state.alignSession = null; return; }
      s.offset = s.offset - state.lastCursorX;
      state.alignSession = null;
      setStatus('READY');
      saveSessionState(s);
      rebuildAll();
    });
  });
});

// ============================================================
// MODE TOGGLE
// ============================================================
elBtnAfr.addEventListener('click',    () => { state.mode = 'afr';    rebuildPlotData(); });
elBtnLambda.addEventListener('click', () => { state.mode = 'lambda'; rebuildPlotData(); });

// ============================================================
// CALIBRATION MODAL
// ============================================================
const elCalModal  = $('calModal');
const elCalClose  = $('calClose');
const elCalName   = $('calSessionName');
const elCalClosed = $('calClosed');
const elCalWot    = $('calWot');
const elCalOffset = $('calOffset');
const elCalApply  = $('calApply');
const elCalReset  = $('calReset');
let calSessionId = null;

function openCalModal(s) {
  calSessionId = s.id;
  elCalName.textContent = s.name;
  elCalClosed.value = s.tpsCal.closed;
  elCalWot.value    = s.tpsCal.wot;
  elCalOffset.value = s.offset;
  elCalModal.classList.remove('hidden');
}
function closeCalModal() {
  elCalModal.classList.add('hidden');
  calSessionId = null;
}
elCalClose.addEventListener('click', closeCalModal);
elCalModal.addEventListener('click', (e) => { if (e.target === elCalModal) closeCalModal(); });

elCalApply.addEventListener('click', () => {
  const s = state.sessions.find(x => x.id === calSessionId);
  if (!s) return;
  s.tpsCal.closed = parseFloat(elCalClosed.value) || 0;
  s.tpsCal.wot    = parseFloat(elCalWot.value)    || 90;
  s.offset        = parseFloat(elCalOffset.value) || 0;
  saveSessionState(s);
  closeCalModal();
  rebuildAll();
});
elCalReset.addEventListener('click', () => {
  elCalClosed.value = 0; elCalWot.value = 90; elCalOffset.value = 0;
});

// ============================================================
// RANGE SELECT
// ============================================================
elBtnRange.addEventListener('click', () => {
  state.rangeSelect = { active: true, t1: null, t2: null };
  elRangeBanner.classList.remove('hidden');
  elRangeText.textContent = 'Drag on any plot to select a range…';
});
elBtnRangeCancel.addEventListener('click', cancelRangeSelect);
function cancelRangeSelect() {
  state.rangeSelect = { active: false, t1: null, t2: null };
  elRangeBanner.classList.add('hidden');
}
elBtnClearR.addEventListener('click', () => {
  state.range = null;
  cancelRangeSelect();
  rebuildPlotData();
});

function onCursor(u) {
  const left = u.cursor.left;
  if (left == null || left < 0) { hideCursorLine(); return; }
  const val = u.posToVal(left, 'x');
  if (!Number.isFinite(val)) return;
  state.lastCursorX = val;
  showCursorLine(u);
}

function onSelect(u) {
  if (!u.select || u.select.width <= 2) return;
  const i0 = u.posToIdx(u.select.left);
  const i1 = u.posToIdx(u.select.left + u.select.width);
  const xs = u.data[0];
  if (!xs || !xs.length) return;
  const t1 = xs[Math.max(0, Math.min(xs.length-1, i0))];
  const t2 = xs[Math.max(0, Math.min(xs.length-1, i1))];
  state.range = { t1: Math.min(t1,t2), t2: Math.max(t1,t2) };
  cancelRangeSelect();
  drawRangeMarkers();
  openTransferWindows();
}

// Trigger a redraw on all plots so range band + redlines repaint
function drawRangeMarkers() {
  if (plotAfr) plotAfr.redraw(false);
  if (plotRpm) plotRpm.redraw(false);
  if (plotTps) plotTps.redraw(false);
}

// ============================================================
// TRANSFER WINDOWS — RPM→λ and TPS→λ binning
// ============================================================
const elTransferWindows = $('transferWindows');

function openTransferWindows() {
  if (!state.range) return;
  elTransferWindows.innerHTML = '';
  const { t1, t2 } = state.range;
  const visible = state.sessions.filter(s => s.visible);
  if (!visible.length) return;
  makeTransferWindow('TPS → λ', 'tps', t1, t2, visible,  60, 100);
  makeTransferWindow('RPM → λ', 'rpm', t1, t2, visible, 600, 140);
}

function makeTransferWindow(title, axis, t1, t2, sessions, leftPx, topPx) {
  const win = document.createElement('div');
  win.className = 'transfer-window';
  win.style.left = leftPx + 'px';
  win.style.top  = topPx  + 'px';
  win.innerHTML = `
    <div class="transfer-head">
      <span class="transfer-title">${title}</span>
      <div class="transfer-actions">
        <button class="btn-csv">CSV</button>
        <button class="btn-png">PNG</button>
      </div>
      <button class="transfer-close">×</button>
    </div>
    <div class="transfer-body"></div>
  `;
  elTransferWindows.appendChild(win);

  const head = win.querySelector('.transfer-head');
  let drag = null;
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    drag = { x: e.clientX - win.offsetLeft, y: e.clientY - win.offsetTop };
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    win.style.left = (e.clientX - drag.x) + 'px';
    win.style.top  = (e.clientY - drag.y) + 'px';
  });
  window.addEventListener('mouseup', () => drag = null);
  win.querySelector('.transfer-close').addEventListener('click', () => win.remove());

  const yIsLambda = state.mode === 'lambda';
  const xMin = axis === 'tps' ? -5 : 0;
  const xMax = axis === 'tps' ? 105 : 7000;
  const xLabel = axis === 'tps' ? 'TPS %' : 'RPM';
  const yLabel = yIsLambda ? 'λ' : 'AFR';

  const body = win.querySelector('.transfer-body');
  setTimeout(() => {
    const data = [[]];
    const series = [{ label: 'x' }];
    const xUnion = new Set();

    const sessionBins = sessions.map(s => {
      const bins = computeTransferBins(s, axis, t1, t2);
      bins.forEach(b => xUnion.add(b.x));
      return { s, bins };
    });

    const xArr = Array.from(xUnion).sort((a,b) => a-b);
    data[0] = xArr;
    sessionBins.forEach(({ s, bins }) => {
      const map = new Map(bins.map(b => [b.x, yIsLambda ? b.y / STOICH : b.y]));
      data.push(xArr.map(x => map.has(x) ? map.get(x) : null));
      series.push({ label: s.name, stroke: s.color, width: 1.5, points: { show: true, size: 4 }, spanGaps: false });
    });

    const yRange = yIsLambda ? [0.6, 1.3] : [10.0, 18.0];
    const yFmt   = (v) => yIsLambda ? v.toFixed(3) : v.toFixed(1);

    const u = new uPlot({
      width: body.clientWidth,
      height: body.clientHeight,
      cursor: { drag: { x: false, y: false } },
      scales: {
        x: { range: () => [xMin, xMax] },
        y: { range: () => yRange },
      },
      axes: [
        { stroke:'#888', grid:{stroke:'#2a2a2a'}, font:'11px JetBrains Mono', label: xLabel },
        { stroke:'#888', grid:{stroke:'#2a2a2a'}, font:'11px JetBrains Mono', size: 55,
          values: (u, splits) => splits.map(yFmt), label: yLabel },
      ],
      series,
    }, data, body);

    new ResizeObserver(() => u.setSize({ width: body.clientWidth, height: body.clientHeight }))
      .observe(body);

    win.querySelector('.btn-csv').addEventListener('click', () => {
      const headers = [xLabel, ...sessions.map(s => s.name)];
      const rows = [headers.join(',')];
      for (let i=0; i<xArr.length; i++) {
        const row = [xArr[i]];
        for (let k=1; k<data.length; k++) row.push(data[k][i] == null ? '' : data[k][i]);
        rows.push(row.join(','));
      }
      downloadBlob(new Blob([rows.join('\n')], { type: 'text/csv' }),
        `${title.replace(/[^a-z0-9]/gi,'_')}.csv`);
    });
    win.querySelector('.btn-png').addEventListener('click', () => {
      const canvas = body.querySelector('canvas');
      if (!canvas) return;
      canvas.toBlob(blob => downloadBlob(blob, `${title.replace(/[^a-z0-9]/gi,'_')}.png`));
    });
  }, 50);
}

function computeTransferBins(s, axis, t1, t2) {
  const xs = [], ys = [];
  const off = s.offset, cal = s.tpsCal;
  for (let i=0; i<s.t.length; i++) {
    const ti = s.t[i] + off;
    if (ti < t1 || ti > t2) continue;
    const a = s.afr[i];
    if (!Number.isFinite(a)) continue;
    let xv;
    if (axis === 'tps') {
      const tp = s.tpsRaw[i];
      if (!Number.isFinite(tp)) continue;
      xv = calibrateTps(tp, cal.closed, cal.wot, cal.ccw);
    } else {
      const rp = s.rpm[i];
      if (!Number.isFinite(rp)) continue;
      xv = rp;
    }
    xs.push(xv); ys.push(a);
  }

  // Use current settings for tolerances
  const tol = axis === 'tps' ? state.settings.tpsTol : state.settings.rpmTol;
  const binSize = tol * 2;
  const bins = new Map();
  for (let i=0; i<xs.length; i++) {
    const key = Math.round(xs[i] / binSize) * binSize;
    if (!bins.has(key)) bins.set(key, { sumY: 0, n: 0, x: key });
    const b = bins.get(key); b.sumY += ys[i]; b.n++;
  }
  const out = [];
  for (const b of bins.values()) {
    if (b.n < state.settings.minSamples) continue;
    out.push({ x: b.x, y: b.sumY / b.n, n: b.n });
  }
  out.sort((a,b) => a.x - b.x);
  return out;
}

// ============================================================
// EXPORT PNG (main plots)
// ============================================================
elBtnPng.addEventListener('click', () => {
  const cs = ['plotAfr','plotRpm','plotTps']
    .map(id => document.querySelector(`#${id} canvas`))
    .filter(Boolean);
  if (!cs.length) return;
  const w = Math.max(...cs.map(c=>c.width));
  const h = cs.reduce((a,c) => a + c.height, 0);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);
  let y = 0;
  for (const c of cs) { ctx.drawImage(c, 0, y); y += c.height; }
  out.toBlob(b => downloadBlob(b, 'analyzer-plots.png'));
});

// ============================================================
// CLEAR ALL
// ============================================================
elBtnClearAll.addEventListener('click', () => {
  if (!state.sessions.length) return;
  if (!confirm('Remove all sessions?')) return;
  state.sessions = [];
  state.range = null;
  state.alignSession = null;
  cancelRangeSelect();
  setStatus('READY');
  rebuildAll();
});

// ============================================================
// HELPERS
// ============================================================
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  syncSettingsInputs();
  buildPlots();
  setStatus('READY');
});
