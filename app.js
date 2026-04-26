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
const TPS_TOLERANCE_DEFAULT = 0.5;   // ±0.5 % bin
const RPM_TOLERANCE_DEFAULT = 50;    // ±50 rpm bin
const MIN_SAMPLES_PER_BIN = 3;

// ----- App state -----
const state = {
  sessions: [],          // [{id, name, color, visible, t, afr, rpm, tpsRaw, tpsCal:{closed,wot}, offset, fileName}]
  mode: 'afr',           // 'afr' | 'lambda'
  rangeSelect: { active: false, t1: null, t2: null },
  range: null,           // {t1, t2} after selection
  nextId: 1,
};

// ----- DOM refs -----
const $ = (id) => document.getElementById(id);
const elFileInput   = $('fileInput');
const elBtnImport   = $('btnImport');
const elBtnAfr      = $('modeAfr');
const elBtnLambda   = $('modeLambda');
const elBtnRange    = $('btnRangeSelect');
const elBtnClearR   = $('btnClearRange');
const elBtnPng      = $('btnExportPng');
const elBtnClearAll = $('btnClearAll');
const elSessionList = $('sessionList');
const elSessionCount= $('sessionCount');
const elStatus      = $('status');
const elAfrLabel    = $('afrLabel');
const elRangeBanner = $('rangeBanner');
const elRangeText   = $('rangeBannerText');
const elBtnRangeCancel = $('btnRangeCancel');

// ----- Status -----
function setStatus(text, level='ok') {
  elStatus.textContent = text;
  elStatus.className = 'status' + (level === 'warn' ? ' warn' : level === 'error' ? ' error' : '');
}

// ============================================================
// CSV IMPORT
// ============================================================
elBtnImport.addEventListener('click', () => elFileInput.click());

elFileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  setStatus(`LOADING ${files.length}…`);
  for (const file of files) {
    try { await loadCsvFile(file); }
    catch (err) {
      console.error(err);
      setStatus(`ERR: ${file.name}`, 'error');
    }
  }
  elFileInput.value = '';
  rebuildAll();
  setStatus('READY');
});

function loadCsvFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (res) => {
        try {
          const rows = res.data.filter(r =>
            r.t_ms !== undefined && r.t_ms !== null && !Number.isNaN(+r.t_ms)
          );
          if (!rows.length) return reject(new Error('No valid rows'));

          const t       = new Float64Array(rows.length);
          const afr     = new Float64Array(rows.length);
          const rpm     = new Float64Array(rows.length);
          const tpsRaw  = new Float64Array(rows.length);

          for (let i=0; i<rows.length; i++) {
            const r = rows[i];
            t[i]      = (+r.t_ms) / 1000.0;     // seconds since boot
            // AFR: filter "99.9" sentinel and out-of-range
            const a = +r.afr;
            afr[i]    = (Number.isFinite(a) && a >= 8.5 && a <= 20.0) ? a : NaN;
            rpm[i]    = Number.isFinite(+r.rpm)     ? +r.rpm     : NaN;
            tpsRaw[i] = Number.isFinite(+r.tps_deg) ? +r.tps_deg : NaN;
          }

          const id = state.nextId++;
          const colorIdx = (state.sessions.length) % SESSION_COLORS.length;

          state.sessions.push({
            id,
            fileName: file.name,
            name: file.name.replace(/\.csv$/i, ''),
            color: SESSION_COLORS[colorIdx],
            visible: true,
            t, afr, rpm, tpsRaw,
            tpsCal: { closed: 0, wot: 90 },     // sensible defaults
            offset: 0,
          });
          resolve();
        } catch(e) { reject(e); }
      },
      error: reject,
    });
  });
}

// ============================================================
// uPlot — three vertically stacked, X-linked plots
// ============================================================
let plotAfr = null, plotRpm = null, plotTps = null;
let cursorSyncKey = 'otr-sync';
const sync = uPlot.sync(cursorSyncKey);

function makePlot(targetEl, label, yRange, yFormatFn) {
  const opts = {
    width:  targetEl.clientWidth,
    height: targetEl.clientHeight,
    cursor: {
      sync: { key: cursorSyncKey, setSeries: false },
      drag: { x: true, y: false, uni: 30 },
      points: { show: true },
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
    hooks: {
      ready: [ u => sync.sub(u) ],
      setCursor: [ u => onCursor(u) ],
      setSelect: [ u => onSelect(u) ],
    },
  };
  const u = new uPlot(opts, [[]], targetEl);
  return u;
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

  plotAfr = makePlot(afrEl, 'AFR', afrRange, afrFmt);
  plotRpm = makePlot(rpmEl, 'RPM', [0, 7000], v => v.toFixed(0));
  plotTps = makePlot(tpsEl, 'TPS', [-5, 105],  v => v.toFixed(0)+'%');

  // Window resize
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
  // Build a unified X axis from all visible sessions, plus per-session Y series.
  // Strategy: each visible session contributes its own (t+offset) array as series.
  // uPlot requires a shared X. We pick the union of all timestamps, then for each
  // series we map values back via index-of-t, leaving NaN where absent.
  const visible = state.sessions.filter(s => s.visible);

  const yIsLambda = state.mode === 'lambda';
  elAfrLabel.textContent = yIsLambda ? 'λ' : 'AFR';
  elBtnAfr.classList.toggle('active', !yIsLambda);
  elBtnLambda.classList.toggle('active', yIsLambda);

  // Refresh ranges by rebuilding plots — simpler than mutating scales.
  buildPlots();

  if (!visible.length) {
    plotAfr.setData([[]]);
    plotRpm.setData([[]]);
    plotTps.setData([[]]);
    return;
  }

  // Build merged timeline (sorted unique union)
  const timeSet = new Set();
  for (const s of visible) {
    const off = s.offset;
    for (let i=0; i<s.t.length; i++) timeSet.add(s.t[i] + off);
  }
  const xs = Float64Array.from(timeSet).sort();

  const afrData = [xs];
  const rpmData = [xs];
  const tpsData = [xs];

  // For fast lookup, build per-session t→idx map keyed on shifted time.
  for (const s of visible) {
    const off = s.offset;
    // Build map shifted_t -> idx
    const idxByT = new Map();
    for (let i=0; i<s.t.length; i++) idxByT.set(s.t[i] + off, i);

    const afrSer = new Array(xs.length);
    const rpmSer = new Array(xs.length);
    const tpsSer = new Array(xs.length);

    const cal = s.tpsCal;
    for (let i=0; i<xs.length; i++) {
      const j = idxByT.get(xs[i]);
      if (j === undefined) {
        afrSer[i] = null; rpmSer[i] = null; tpsSer[i] = null;
        continue;
      }
      const a = s.afr[j];
      const r = s.rpm[j];
      const tpRaw = s.tpsRaw[j];

      afrSer[i] = Number.isFinite(a) ? (yIsLambda ? a / STOICH : a) : null;
      rpmSer[i] = Number.isFinite(r) ? r : null;
      tpsSer[i] = Number.isFinite(tpRaw) ? calibrateTps(tpRaw, cal.closed, cal.wot) : null;
    }
    afrData.push(afrSer);
    rpmData.push(rpmSer);
    tpsData.push(tpsSer);

    addSeriesToPlot(plotAfr, s);
    addSeriesToPlot(plotRpm, s);
    addSeriesToPlot(plotTps, s);
  }

  plotAfr.setData(afrData);
  plotRpm.setData(rpmData);
  plotTps.setData(tpsData);

  // Re-draw range markers if any
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
//   maps raw angle (deg) to 0..100% based on closed & wot reference angles
// ============================================================
function calibrateTps(raw, closed, wot) {
  // Normalize all to [0,360)
  const nraw = ((raw % 360) + 360) % 360;
  const nc   = ((closed % 360) + 360) % 360;
  const nw   = ((wot % 360) + 360) % 360;

  // Distance from closed in the direction of wot, modulo 360.
  // First find arc length from closed to wot (the "WOT direction").
  let arc = (nw - nc + 360) % 360;
  if (arc === 0) arc = 1; // avoid divide-by-zero

  let pos = (nraw - nc + 360) % 360;

  // Allow overshoot/undershoot (don't clamp), but if pos > 180+arc, treat as undershoot
  // Map: pos==0 -> 0%, pos==arc -> 100%
  // For values "behind" closed (i.e. arc > 180 from forward), express as negative.
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
    const div = document.createElement('div');
    div.className = 'session' + (s.visible ? '' : ' hidden-row');
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
        <button data-act="cal"    data-id="${s.id}">CAL</button>
        <button data-act="color"  data-id="${s.id}">COLOR</button>
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
    rebuildAll();
  } else if (act === 'color') {
    const idx = SESSION_COLORS.indexOf(s.color);
    s.color = SESSION_COLORS[(idx + 1) % SESSION_COLORS.length];
    rebuildAll();
  } else if (act === 'cal') {
    openCalModal(s);
  }
});

// ============================================================
// MODE TOGGLE
// ============================================================
elBtnAfr.addEventListener('click', () => { state.mode = 'afr'; rebuildPlotData(); });
elBtnLambda.addEventListener('click', () => { state.mode = 'lambda'; rebuildPlotData(); });

// ============================================================
// CALIBRATION MODAL
// ============================================================
const elCalModal   = $('calModal');
const elCalClose   = $('calClose');
const elCalName    = $('calSessionName');
const elCalClosed  = $('calClosed');
const elCalWot     = $('calWot');
const elCalOffset  = $('calOffset');
const elCalApply   = $('calApply');
const elCalReset   = $('calReset');
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
  elRangeText.textContent = 'Click first point on any plot…';
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
  // No-op for now; could show coordinated readout
}

function onSelect(u) {
  // uPlot's drag-to-select gives us a range natively. Use it as range select.
  if (!u.select || u.select.width <= 2) return;
  const i0 = u.posToIdx(u.select.left);
  const i1 = u.posToIdx(u.select.left + u.select.width);
  const xs = u.data[0];
  if (!xs.length) return;
  const t1 = xs[Math.max(0, Math.min(xs.length-1, i0))];
  const t2 = xs[Math.max(0, Math.min(xs.length-1, i1))];
  state.range = { t1: Math.min(t1,t2), t2: Math.max(t1,t2) };
  cancelRangeSelect();
  drawRangeMarkers();
  openTransferWindows();
}

function drawRangeMarkers() {
  // uPlot doesn't easily draw persistent shaded regions without plugin code;
  // for now we leave the native selection visible until user drags again.
  // (A fuller implementation would add a hook plugin to render a band.)
}

// ============================================================
// TRANSFER WINDOWS — RPM→λ and TPS→λ binning
// ============================================================
const elTransferWindows = $('transferWindows');

function openTransferWindows() {
  if (!state.range) return;
  // Remove any existing
  elTransferWindows.innerHTML = '';

  const { t1, t2 } = state.range;
  const visible = state.sessions.filter(s => s.visible);
  if (!visible.length) return;

  makeTransferWindow('TPS → λ', 'tps', t1, t2, visible, 60, 100);
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

  // Drag-move
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

  // Bin data
  const yIsLambda = state.mode === 'lambda';
  const xMin = axis === 'tps' ? -5 : 0;
  const xMax = axis === 'tps' ? 105 : 7000;
  const xLabel = axis === 'tps' ? 'TPS %' : 'RPM';
  const yLabel = yIsLambda ? 'λ' : 'AFR';

  // Build series per session
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

    const xArr = Array.from(xUnion).sort((a,b)=>a-b);
    data[0] = xArr;
    sessionBins.forEach(({ s, bins }) => {
      const map = new Map(bins.map(b => [b.x, yIsLambda ? b.y / STOICH : b.y]));
      data.push(xArr.map(x => map.has(x) ? map.get(x) : null));
      series.push({
        label: s.name,
        stroke: s.color,
        width: 1.5,
        points: { show: true, size: 4 },
        spanGaps: false,
      });
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

    // Resize observer for the window
    new ResizeObserver(() => u.setSize({ width: body.clientWidth, height: body.clientHeight }))
      .observe(body);

    // CSV export
    win.querySelector('.btn-csv').addEventListener('click', () => {
      const headers = [xLabel, ...sessions.map(s => s.name)];
      const rows = [headers.join(',')];
      for (let i=0; i<xArr.length; i++) {
        const row = [xArr[i]];
        for (let k=1; k<data.length; k++) {
          row.push(data[k][i] == null ? '' : data[k][i]);
        }
        rows.push(row.join(','));
      }
      const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      downloadBlob(blob, `${title.replace(/[^a-z0-9]/gi,'_')}.csv`);
    });
    // PNG export
    win.querySelector('.btn-png').addEventListener('click', () => {
      const canvas = body.querySelector('canvas');
      if (!canvas) return;
      canvas.toBlob(blob => downloadBlob(blob, `${title.replace(/[^a-z0-9]/gi,'_')}.png`));
    });
  }, 50);
}

function computeTransferBins(s, axis, t1, t2) {
  // x = TPS% (calibrated) or RPM
  // y = AFR (we always store AFR; transfer window converts to λ if needed)
  const xs = []; const ys = [];
  const off = s.offset;
  const cal = s.tpsCal;
  for (let i=0; i<s.t.length; i++) {
    const ti = s.t[i] + off;
    if (ti < t1 || ti > t2) continue;
    const a = s.afr[i];
    if (!Number.isFinite(a)) continue;
    let xv;
    if (axis === 'tps') {
      const tp = s.tpsRaw[i];
      if (!Number.isFinite(tp)) continue;
      xv = calibrateTps(tp, cal.closed, cal.wot);
    } else {
      const rp = s.rpm[i];
      if (!Number.isFinite(rp)) continue;
      xv = rp;
    }
    xs.push(xv); ys.push(a);
  }

  // Bin by tolerance
  const tol = axis === 'tps' ? TPS_TOLERANCE_DEFAULT : RPM_TOLERANCE_DEFAULT;
  const binSize = tol * 2;
  const bins = new Map();   // binKey -> {sumY, n, x}
  for (let i=0; i<xs.length; i++) {
    const key = Math.round(xs[i] / binSize) * binSize;
    if (!bins.has(key)) bins.set(key, { sumY: 0, n: 0, x: key });
    const b = bins.get(key); b.sumY += ys[i]; b.n++;
  }
  const out = [];
  for (const b of bins.values()) {
    if (b.n < MIN_SAMPLES_PER_BIN) continue;
    out.push({ x: b.x, y: b.sumY / b.n, n: b.n });
  }
  out.sort((a,b)=>a.x-b.x);
  return out;
}

// ============================================================
// EXPORT PNG (main plots)
// ============================================================
elBtnPng.addEventListener('click', () => {
  // Concatenate the three plot canvases vertically into one PNG
  const cs = ['plotAfr','plotRpm','plotTps']
    .map(id => document.querySelector(`#${id} canvas`))
    .filter(Boolean);
  if (!cs.length) return;
  const w = Math.max(...cs.map(c=>c.width));
  const h = cs.reduce((a,c)=>a+c.height, 0);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0,0,w,h);
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
  cancelRangeSelect();
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
  buildPlots();
  setStatus('READY');
});
