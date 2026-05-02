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
  alignRefT:    null,    // first-tap reference time during 2-tap align
  lastCursorX:  null,    // last cursor X value (data coords)
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
  // Show per-session cal state in status so we can immediately see why
  // a TPS plot is in % vs degrees.
  if (loaded) {
    const tail = state.sessions.slice(-loaded).map(s => {
      if (!s.tpsCal) return `${s.name}=DEG`;
      return `${s.name}=${s.tpsCal.closed}/${s.tpsCal.wot}`;
    }).join(' ');
    setStatus(`READY · ${tail}`);
  } else {
    setStatus('NO DATA', 'warn');
  }
}

elBtnImport.addEventListener('click', async () => {
  if ('showOpenFilePicker' in window) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        multiple: true,
        excludeAcceptAllOption: false,    // keep the "All files" entry
        // No `types` filter — different Android builds report .csv as
        // text/csv, text/plain, application/vnd.ms-excel, or octet-stream,
        // and a strict filter grays out the file. Show all files instead.
      });
    } catch(e) {
      if (e.name === 'AbortError') return; // user cancelled
      // Any other error (TypeError "Need at least one accepted type",
      // SecurityError, NotAllowedError, etc.) → quietly fall back to the
      // legacy <input type="file"> chooser so the user still gets a picker.
      console.warn('showOpenFilePicker failed, falling back:', e);
      elFileInput.click();
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

              // Default: NO calibration — TPS plot shows raw degrees.
              // (Matches the standalone Python viewer: user must explicitly
              // calibrate to switch the TPS axis to 0-100%.)
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
                tpsCal: tpsCalFromFile || null,    // null = uncalibrated
                offset: 0,
              };

              // Restore saved calibration & offset from localStorage, but
              // VALIDATE the cal still produces sensible % on this data —
              // a bad cal from an older build (e.g. peak 115% or -50%) is
              // discarded so the user falls back to raw degrees instead of
              // a permanently-broken plot.
              const saved = loadSessionState(file.name);
              if (saved) {
                if (saved.tpsCal && Number.isFinite(saved.tpsCal.closed) && Number.isFinite(saved.tpsCal.wot)) {
                  const probe = Number.isFinite(tpsMax) ? tpsMax : 90;
                  const pct = calibrateTps(probe, saved.tpsCal.closed, saved.tpsCal.wot, !!saved.tpsCal.ccw);
                  if (Number.isFinite(pct) && pct >= -5 && pct <= 110) {
                    sess.tpsCal = saved.tpsCal;
                  } else {
                    // Bad saved cal — wipe it so user starts clean in degrees mode.
                    console.warn('Discarding stale tpsCal for', file.name, '— produces', pct.toFixed(1)+'%');
                  }
                }
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
      drag: { x: true, y: false, uni: 8, setScale: false }, // selection only — no auto-zoom
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

  // TPS axis: percentages if ANY visible session is calibrated, else raw degrees.
  const anyCal = state.sessions.some(s => s.visible && s.tpsCal);
  const tpsRange = anyCal ? [-5, 110] : null;        // null = let uPlot auto-fit
  const tpsFmt   = anyCal ? (v => v.toFixed(0)+'%') : (v => v.toFixed(0)+'\u00b0');
  plotTps = makePlot(tpsEl, tpsRange, tpsFmt);

  // Update the TPS plot label (target the real TPS card, not the 3rd
  // child of .plots — that one is RPM because cursorLine is child 1).
  const tpsCard = $('plotTps') ? $('plotTps').parentElement : null;
  const tpsLabel = tpsCard ? tpsCard.querySelector('.plot-label') : null;
  if (tpsLabel) tpsLabel.textContent = anyCal ? 'TPS %' : 'TPS\u00b0';

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

    let pinchStart = null;
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
        const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
        const midClientX = (t0.clientX + t1.clientX) / 2;
        const u = getPlotForEl(el);
        if (!u) return;
        const xs = u.scales.x;
        if (!xs || !Number.isFinite(xs.min) || !Number.isFinite(xs.max)) return;
        const canvas = u.root && u.root.querySelector('canvas');
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        pinchStart = {
          dist, midClientX,
          x0: xs.min, x1: xs.max,
          rectLeft: rect.left,
          axisLeftCss:  u.bbox.left  / dpr,
          plotWidthCss: u.bbox.width / dpr,
        };
        e.preventDefault();
      } else if (e.touches.length === 1) {
        // double-tap to reset zoom — skip during align/range-select so the
        // two consecutive taps that those flows need don't trigger a reset.
        if (state.alignSession !== null) { lastTapT = 0; return; }
        if (state.rangeSelect && state.rangeSelect.active) { lastTapT = 0; return; }
        const now = Date.now();
        if (now - lastTapT < 350) { resetXZoom(); lastTapT = 0; }
        else { lastTapT = now; }
      }
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      if (!pinchStart || e.touches.length !== 2) return;
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      if (dist < 1) return;
      const midClientX = (t0.clientX + t1.clientX) / 2;
      const scale = pinchStart.dist / dist;
      const { x0, x1, rectLeft, axisLeftCss, plotWidthCss } = pinchStart;
      const fracOrig = Math.max(0, Math.min(1, (pinchStart.midClientX - rectLeft - axisLeftCss) / plotWidthCss));
      const fracNew  = Math.max(0, Math.min(1, (midClientX - rectLeft - axisLeftCss) / plotWidthCss));
      const xAnchor  = x0 + fracOrig * (x1 - x0);
      const newSpan = (x1 - x0) * scale;
      let newMin = xAnchor - fracNew * newSpan;
      let newMax = newMin + newSpan;
      const ext = getXDataExtent();
      if (ext) {
        const dataSpan = ext[1] - ext[0];
        if (newSpan > dataSpan) { newMin = ext[0]; newMax = ext[1]; }
        else {
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
      if (Number.isFinite(tpRaw)) {
        tpsSer[i] = cal ? calibrateTps(tpRaw, cal.closed, cal.wot, cal.ccw) : tpRaw;
      } else { tpsSer[i] = null; }
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
        <button data-act="align" data-id="${s.id}" class="${isAligning ? 'align-active' : ''}" title="Tap a point on any plot to pin it to t=0">ALIGN</button>
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
      state.alignRefT    = null;
      setStatus('READY');
      rebuildSidebar();
    } else {
      state.alignSession = s.id;
      state.alignRefT    = null;
      setStatus('ALIGN — tap REFERENCE point on the session to align TO (not this one)', 'warn');
      rebuildSidebar();
    }
  }
});

// ============================================================
// ALIGN — two-tap matching the Python tool.
//   1. User presses ALIGN button on the session they want to shift.
//      (state.alignSession = id, state.alignRefT = null)
//   2. User taps reference point in any plot of any session.
//      → state.alignRefT = tapped time
//   3. User taps the matching point on the same data trace in the
//      session being shifted.
//      → offset += (alignRefT - tappedTime), so the matching point
//        slides to where the reference was.
// ============================================================
function pickXFromEvent(plotInstance, ev) {
  if (!plotInstance) return null;
  const canvas = plotInstance.root && plotInstance.root.querySelector('canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  let clientX;
  if (ev.touches && ev.touches.length)              clientX = ev.touches[0].clientX;
  else if (ev.changedTouches && ev.changedTouches.length) clientX = ev.changedTouches[0].clientX;
  else if (typeof ev.clientX === 'number')          clientX = ev.clientX;
  else return null;
  const dpr       = window.devicePixelRatio || 1;
  const axisWidth = plotInstance.bbox.left / dpr;
  const xCss      = clientX - rect.left - axisWidth;
  if (xCss < 0) return null;
  const val = plotInstance.posToVal(xCss, 'x');
  return Number.isFinite(val) ? val : null;
}

function applyAlignTap(xv) {
  // Stage 1: store reference time
  if (state.alignRefT === null) {
    state.alignRefT = xv;
    setStatus(`ALIGN — ref t=${xv.toFixed(2)}s, now tap matching point in session being shifted`, 'warn');
    return;
  }
  // Stage 2: compute shift and apply to the session whose ALIGN was pressed
  const s = state.sessions.find(x => x.id === state.alignSession);
  if (!s) { state.alignSession = null; state.alignRefT = null; setStatus('READY'); return; }
  const shift = state.alignRefT - xv;
  s.offset = (s.offset || 0) + shift;
  saveSessionState(s);
  state.alignSession = null;
  state.alignRefT = null;
  setStatus(`ALIGNED ${s.name} by ${shift >= 0 ? '+' : ''}${shift.toFixed(3)}s`);
  rebuildAll();
}

window.addEventListener('DOMContentLoaded', () => {
  const plotsEl = document.getElementById('plots');
  if (plotsEl) {
    plotsEl.addEventListener('mouseleave', () => {
      state.lastCursorX = null;
      hideCursorLine();
    });
  }

  const plotMap = { plotAfr: () => plotAfr, plotRpm: () => plotRpm, plotTps: () => plotTps };

  let touchStartX = 0, touchStartY = 0, touchMoved = false, touchStartT = 0;

  Object.keys(plotMap).forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    let dragSelStartX = null;        // CSS px relative to canvas, when range-select drag is active
    let dragSelStartCanvasRect = null;
    let dragSelPlot = null;          // the uPlot whose drag is active

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchMoved  = false;
        touchStartT = Date.now();

        // If range-select mode is active, capture this finger as a drag.
        if (state.rangeSelect && state.rangeSelect.active) {
          const u = plotMap[id]();
          if (u) {
            const canvas = u.root && u.root.querySelector('canvas');
            if (canvas) {
              const rect = canvas.getBoundingClientRect();
              const dpr  = window.devicePixelRatio || 1;
              const axisLeftCss  = u.bbox.left  / dpr;
              const plotTopCss   = u.bbox.top   / dpr;
              const plotHeightCss= u.bbox.height/ dpr;
              dragSelPlot = u;
              dragSelStartCanvasRect = { rect, axisLeftCss, plotTopCss, plotHeightCss };
              dragSelStartX = e.touches[0].clientX - rect.left - axisLeftCss;
              if (dragSelStartX < 0) dragSelStartX = 0;
              try { u.setSelect({ left: dragSelStartX, top: plotTopCss, width: 0, height: plotHeightCss }, false); } catch (_e) {}
              e.preventDefault();
            }
          }
        }
      } else { touchMoved = true; dragSelStartX = null; }
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      if (e.touches.length >= 2) { touchMoved = true; dragSelStartX = null; return; }
      if (e.touches.length === 1) {
        const dx = Math.abs(e.touches[0].clientX - touchStartX);
        const dy = Math.abs(e.touches[0].clientY - touchStartY);
        if (dx > 8 || dy > 8) touchMoved = true;

        // Range-select drag in progress — update highlight rect
        if (dragSelStartX !== null && dragSelPlot && dragSelStartCanvasRect) {
          const { rect, axisLeftCss, plotTopCss, plotHeightCss } = dragSelStartCanvasRect;
          let curX = e.touches[0].clientX - rect.left - axisLeftCss;
          if (curX < 0) curX = 0;
          const left  = Math.min(dragSelStartX, curX);
          const width = Math.abs(curX - dragSelStartX);
          try { dragSelPlot.setSelect({ left, top: plotTopCss, width, height: plotHeightCss }, false); } catch (_e) {}
          e.preventDefault();
        }
      }
    }, { passive: false });

    el.addEventListener('touchend', (e) => {
      // ---- Range-select touch drag commit ----
      if (dragSelStartX !== null && dragSelPlot && dragSelStartCanvasRect) {
        try {
          const sel = dragSelPlot.select;
          if (sel && sel.width > 4) {
            const t1 = dragSelPlot.posToVal(sel.left, 'x');
            const t2 = dragSelPlot.posToVal(sel.left + sel.width, 'x');
            if (Number.isFinite(t1) && Number.isFinite(t2) && t1 !== t2) {
              state.range = { t1: Math.min(t1, t2), t2: Math.max(t1, t2) };
              cancelRangeSelect();
              try { dragSelPlot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false); } catch (_e) {}
              drawRangeMarkers();
              openTransferWindows();
            } else {
              try { dragSelPlot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false); } catch (_e) {}
            }
          } else {
            try { dragSelPlot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false); } catch (_e) {}
          }
        } catch (_e) {}
        dragSelStartX = null;
        dragSelPlot = null;
        dragSelStartCanvasRect = null;
        return;
      }

      // ---- Alignment tap ----
      if (touchMoved) return;
      if (Date.now() - touchStartT > 600) return;
      if (state.alignSession === null) return;
      const u = plotMap[id]();
      const xv = pickXFromEvent(u, e);
      if (xv === null) return;
      applyAlignTap(xv);
      e.preventDefault();
    });

    el.addEventListener('click', (e) => {
      if (state.alignSession === null) return;
      const u = plotMap[id]();
      const xv = pickXFromEvent(u, e);
      const useX = xv !== null ? xv : state.lastCursorX;
      if (useX === null) return;
      applyAlignTap(useX);
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
  // If session is calibrated, show its values; otherwise pre-populate with
  // the data's actual raw min/max as a sensible starting point the user can tweak.
  const closedSeed = s.tpsCal ? s.tpsCal.closed : (Math.round((s.tpsRawMin || 0) * 10) / 10);
  const wotSeed    = s.tpsCal ? s.tpsCal.wot    : (Math.round((s.tpsRawMax || 90) * 10) / 10);
  elCalClosed.value = closedSeed;
  elCalWot.value    = wotSeed;
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
  if (!s) { closeCalModal(); return; }

  // ---- read inputs ----
  const newClosed = parseFloat(elCalClosed.value);
  const newWot    = parseFloat(elCalWot.value);
  const newOff    = parseFloat(elCalOffset.value);

  // ---- compute peak TPS % BEFORE applying, for diagnostic flash ----
  let peakRaw = -Infinity;
  for (let i=0; i<s.tpsRaw.length; i++) {
    const v = s.tpsRaw[i];
    if (Number.isFinite(v) && v > peakRaw) peakRaw = v;
  }
  const oldCal = { ...s.tpsCal };
  const oldPct = Number.isFinite(peakRaw)
    ? calibrateTps(peakRaw, oldCal.closed, oldCal.wot, oldCal.ccw)
    : NaN;

  // ---- replace tpsCal with a fresh object ----
  s.tpsCal = {
    closed: Number.isFinite(newClosed) ? newClosed : 0,
    wot:    Number.isFinite(newWot)    ? newWot    : 90,
    ccw:    !!s.tpsCal.ccw,
  };
  s.offset = Number.isFinite(newOff) ? newOff : 0;
  saveSessionState(s);
  closeCalModal();

  // ---- force a totally fresh canvas — destroy & null out before rebuild ----
  try { if (plotAfr) plotAfr.destroy(); } catch (_e) {}
  try { if (plotRpm) plotRpm.destroy(); } catch (_e) {}
  try { if (plotTps) plotTps.destroy(); } catch (_e) {}
  plotAfr = plotRpm = plotTps = null;

  try {
    rebuildAll();
    const newPct = Number.isFinite(peakRaw)
      ? calibrateTps(peakRaw, s.tpsCal.closed, s.tpsCal.wot, s.tpsCal.ccw)
      : NaN;
    const fmt = v => Number.isFinite(v) ? v.toFixed(1)+'%' : '—';
    setStatus(`CAL ${oldCal.closed}/${oldCal.wot} → ${s.tpsCal.closed}/${s.tpsCal.wot}  peak ${fmt(oldPct)}→${fmt(newPct)}`);
  } catch (e) {
    console.error('rebuildAll after CAL apply:', e);
    setStatus(`ERR: ${e.message}`, 'error');
  }
});
elCalReset.addEventListener('click', () => {
  // Wipe calibration entirely — TPS goes back to raw degrees on the plot.
  const s = state.sessions.find(x => x.id === calSessionId);
  if (s) {
    s.tpsCal = null;
    s.offset = 0;
    saveSessionState(s);
  }
  // Re-seed the visible inputs with the data's actual extent so user can
  // tweak from there if they want to recalibrate immediately.
  if (s) {
    elCalClosed.value = Math.round((s.tpsRawMin || 0) * 10) / 10;
    elCalWot.value    = Math.round((s.tpsRawMax || 90) * 10) / 10;
  } else {
    elCalClosed.value = 0; elCalWot.value = 90;
  }
  elCalOffset.value = 0;
  closeCalModal();
  try { if (plotAfr) plotAfr.destroy(); } catch (_e) {}
  try { if (plotRpm) plotRpm.destroy(); } catch (_e) {}
  try { if (plotTps) plotTps.destroy(); } catch (_e) {}
  plotAfr = plotRpm = plotTps = null;
  rebuildAll();
  setStatus(`CAL CLEARED — ${s ? s.name : ''} now shows raw degrees`);
});

// ============================================================
// RANGE SELECT
// ============================================================
elBtnRange.addEventListener('click', () => {
  state.rangeSelect = { active: true, t1: null, t2: null };
  elRangeBanner.classList.remove('hidden');
  elRangeText.textContent = 'Drag horizontally on any plot to select a range…';
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
  if (!u.select || u.select.width <= 4) return; // ignore micro-drags / taps
  const left  = u.select.left;
  const right = u.select.left + u.select.width;
  const t1 = u.posToVal(left,  'x');
  const t2 = u.posToVal(right, 'x');
  if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 === t2) return;
  state.range = { t1: Math.min(t1, t2), t2: Math.max(t1, t2) };
  cancelRangeSelect();
  // Clear the visual selection rect so it doesn't linger between drags
  try { u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false); } catch (e) {}
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

  // Touch drag for mobile/tablet
  head.addEventListener('touchstart', (e) => {
    if (e.target.closest('button')) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    drag = { x: t.clientX - win.offsetLeft, y: t.clientY - win.offsetTop, touch: true };
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!drag || !drag.touch || e.touches.length !== 1) return;
    const t = e.touches[0];
    win.style.left = (t.clientX - drag.x) + 'px';
    win.style.top  = (t.clientY - drag.y) + 'px';
  }, { passive: true });
  window.addEventListener('touchend', () => { if (drag && drag.touch) drag = null; });

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
      xv = cal ? calibrateTps(tp, cal.closed, cal.wot, cal.ccw) : tp;
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
const APP_BUILD = 'v14-wipe-cals-button';
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  syncSettingsInputs();
  buildPlots();
  setStatus('READY');
  // Stamp the build marker into the brand sub-text so we can confirm at
  // a glance which version of app.js is actually loaded.
  const sub = document.querySelector('.brand-sub');
  if (sub) sub.textContent = 'ANALYZER \u00b7 ' + APP_BUILD.toUpperCase();
  console.log('OTR Analyzer build:', APP_BUILD);

  // Inject a "WIPE SAVED CALS" button into the settings panel — one-tap
  // way to clear all stored per-file calibrations from localStorage so the
  // app falls back to raw degrees on next import.
  const sp = $('settingsPanel');
  if (sp) {
    const wipeBtn = document.createElement('button');
    wipeBtn.className = 'btn btn-danger';
    wipeBtn.textContent = 'WIPE SAVED CALS';
    wipeBtn.title = 'Clear all per-file TPS calibrations + offsets from localStorage';
    wipeBtn.style.marginLeft = 'auto';
    wipeBtn.addEventListener('click', () => {
      if (!confirm('Wipe all saved TPS calibrations and offsets from this device?')) return;
      try { localStorage.removeItem('otr-sessions'); } catch (_e) {}
      // Also clear any in-memory cals on currently-loaded sessions so the
      // user sees the plot revert immediately.
      for (const s of state.sessions) { s.tpsCal = null; s.offset = 0; }
      try { if (plotAfr) plotAfr.destroy(); } catch (_e) {}
      try { if (plotRpm) plotRpm.destroy(); } catch (_e) {}
      try { if (plotTps) plotTps.destroy(); } catch (_e) {}
      plotAfr = plotRpm = plotTps = null;
      rebuildAll();
      setStatus('CALS WIPED — TPS now in raw degrees');
    });
    sp.appendChild(wipeBtn);
  }
});
