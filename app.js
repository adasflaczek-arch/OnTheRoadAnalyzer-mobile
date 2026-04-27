/* ============================================================
   On The Road Analyzer — DeX edition
   Vanilla JS + uPlot. State, plots, sessions, transfer windows.
   Mobile: pinch-zoom, tap-to-align, drag-to-select-range.
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
  try {
    rebuildAll();
  } catch(e) {
    console.error('rebuildAll:', e);
    setStatus(`ERR: ${e.message}`, 'error');
    return;
  }
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

              let tpsMin =  Infinity;
              let tpsMax = -Infinity;
              for (let i=0; i<rows.length; i++) {
                const r = rows[i];
                t[i]      = (+r.t_ms) / 1000.0;
                const a = +r.afr;
                afr[i]    = (Number.isFinite(a) && a >= 8.5 && a <= 20.0) ? a : NaN;
                rpm[i]    = Number.isFinite(+r.rpm)     ? +r.rpm     : NaN;
                const tp = +r.tps_deg;
                tpsRaw[i] = Number.isFinite(tp) ? tp : NaN;
                if (Number.isFinite(tp)) {
                  if (tp < tpsMin) tpsMin = tp;
                  if (tp > tpsMax) tpsMax = tp;
                }
              }

              // Auto-derive sensible TPS calibration defaults from the actual
              // raw range in this CSV (matches the standalone Python viewer).
              // The user can override per-session via the CAL modal afterwards.
              let defaultCal = { closed: 0, wot: 90, ccw: false };
              if (Number.isFinite(tpsMin) && Number.isFinite(tpsMax) && tpsMax > tpsMin) {
                defaultCal = {
                  closed: Math.round(tpsMin * 10) / 10,
                  wot:    Math.round(tpsMax * 10) / 10,
                  ccw:    false,
                };
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
                tpsRawMin: Number.isFinite(tpsMin) ? tpsMin : 0,
                tpsRawMax: Number.isFinite(tpsMax) ? tpsMax : 90,
                tpsCal: tpsCalFromFile || defaultCal,
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
      // Drag selects an X range and emits setSelect, but does NOT auto-zoom
      // (setScale: false). Pinch-to-zoom is handled by our own touch handler.
      drag: { x: true, y: false, uni: 8, setScale: false },
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

  attachPinchZoom();
}

// ============================================================
// PINCH-TO-ZOOM (mobile) + double-tap to reset.
// Two-finger gesture zooms/pans the X axis on all 3 plots in sync.
// We never zoom the page — the viewport meta locks page zoom and
// `touch-action: none` on .plot lets us own the gesture.
// ============================================================
function getAllPlots() {
  return [plotAfr, plotRpm, plotTps].filter(Boolean);
}

function setSyncedXRange(min, max) {
  for (const u of getAllPlots()) {
    u.setScale('x', { min, max });
  }
}

function getXDataExtent() {
  for (const u of getAllPlots()) {
    const xs = u.data && u.data[0];
    if (xs && xs.length) return [xs[0], xs[xs.length - 1]];
  }
  return null;
}

function resetXZoom() {
  const ext = getXDataExtent();
  if (!ext) return;
  setSyncedXRange(ext[0], ext[1]);
}

function attachPinchZoom() {
  ['plotAfr', 'plotRpm', 'plotTps'].forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.__pinchAttached) return;
    el.__pinchAttached = true;

    let pinchStart = null;     // {dist, midClientX, x0, x1, axisLeftCss, plotWidthCss, plot}
    let lastTapT   = 0;

    function getPlotForEl(elx) {
      if (elx === document.getElementById('plotAfr')) return plotAfr;
      if (elx === document.getElementById('plotRpm')) return plotRpm;
      if (elx === document.getElementById('plotTps')) return plotTps;
      return null;
    }

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const t0 = e.touches[0], t1 = e.touches[1];
        const dx = t0.clientX - t1.clientX;
        const dy = t0.clientY - t1.clientY;
        const dist = Math.hypot(dx, dy);
        const midClientX = (t0.clientX + t1.clientX) / 2;

        const u = getPlotForEl(el);
        if (!u) return;
        const xs = u.scales.x;
        if (!xs || !Number.isFinite(xs.min) || !Number.isFinite(xs.max)) return;

        const canvas = u.root && u.root.querySelector('canvas');
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const axisLeftCss = u.bbox.left / dpr;
        const plotWidthCss = u.bbox.width / dpr;

        pinchStart = {
          dist,
          midClientX,
          x0: xs.min,
          x1: xs.max,
          rectLeft: rect.left,
          axisLeftCss,
          plotWidthCss,
        };
        e.preventDefault();
      } else if (e.touches.length === 1) {
        // double-tap detection (within 350ms, two fingers not used) → reset zoom
        const now = Date.now();
        if (now - lastTapT < 350) {
          resetXZoom();
          lastTapT = 0;
        } else {
          lastTapT = now;
        }
      }
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      if (!pinchStart || e.touches.length !== 2) return;
      const t0 = e.touches[0], t1 = e.touches[1];
      const dx = t0.clientX - t1.clientX;
      const dy = t0.clientY - t1.clientY;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) return;
      const midClientX = (t0.clientX + t1.clientX) / 2;

      const scale = pinchStart.dist / dist; // shrink = zoom in
      const { x0, x1, rectLeft, axisLeftCss, plotWidthCss } = pinchStart;

      // Anchor: the data X under the original midpoint stays under the new midpoint.
      const fracOrig = Math.max(0, Math.min(1,
        (pinchStart.midClientX - rectLeft - axisLeftCss) / plotWidthCss));
      const fracNew  = Math.max(0, Math.min(1,
        (midClientX - rectLeft - axisLeftCss) / plotWidthCss));
      const xAnchor  = x0 + fracOrig * (x1 - x0);

      const newSpan = (x1 - x0) * scale;
      let newMin = xAnchor - fracNew * newSpan;
      let newMax = newMin + newSpan;

      // Clamp to data extent so we can't pan into infinity
      const ext = getXDataExtent();
      if (ext) {
        const dataSpan = ext[1] - ext[0];
        if (newSpan > dataSpan) {
          newMin = ext[0]; newMax = ext[1];
        } else {
          if (newMin < ext[0]) { newMin = ext[0]; newMax = newMin + newSpan; }
          if (newMax > ext[1]) { newMax = ext[1]; newMin = newMax - newSpan; }
        }
      }
      setSyncedXRange(newMin, newMax);
      e.preventDefault();
    }, { passive: false });

    const endPinch = (e) => {
      if (e.touches && e.touches.length < 2) pinchStart = null;
    };
    el.addEventListener('touchend', endPinch);
    el.addEventListener('touchcancel', endPinch);
  });
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
    width: 1