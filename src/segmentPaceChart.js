// Per-segment pace chart with optional per-km labels and CP markers.

let chart = null;
let hoverCallback = null;
// drag-to-edit state — populated on mousedown, cleared on mouseup.
let dragState = null;
let dragCallback = null;

const crosshairPlugin = {
  id: 'segpace-crosshair',
  afterDatasetsDraw(chart) {
    const km = chart.$hoverKm;
    if (km == null) return;
    const x = chart.scales.x.getPixelForValue(km);
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, chart.chartArea.top);
    ctx.lineTo(x, chart.chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  },
};

const segLabelsPlugin = {
  id: 'segpace-labels',
  afterDatasetsDraw(chart) {
    if (!chart.$showLabels) return;
    const ds = chart.data.datasets.find(d => d.label === 'Per-segment pace');
    if (!ds) return;
    const ctx = chart.ctx;
    const cs = getComputedStyle(chart.canvas);
    const panel = cs.getPropertyValue('--panel').trim() || '#161b22';
    drawLabels(chart, ctx, ds, panel, '#ff8c42', 1, -12);
  },
};

const cpMarkersPlugin = {
  id: 'segpace-cp-markers',
  afterDatasetsDraw(chart) {
    const cps = chart.$checkpoints;
    if (!cps?.length) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '600 10px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'center';
    for (const cp of cps) {
      const px = chart.scales.x.getPixelForValue(cp.km);
      const top = chart.chartArea.top, bot = chart.chartArea.bottom;
      ctx.strokeStyle = (cp.color || 'rgba(127,127,127,0.55)');
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(px, top);
      ctx.lineTo(px, bot);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cp.color || '#9aa6b2';
      ctx.fillText(cp.id, px, top + 12);
    }
    ctx.restore();
  },
};

function drawLabels(chart, ctx, ds, bg, accent, everyKm, offY) {
  ctx.save();
  ctx.font = '600 10px -apple-system, "Segoe UI", Roboto, sans-serif';
  // Per-segment labels are rotated 90° so they fit one above each segment midpoint
  // even on a 100-km course. Native chart labels are too wide to lay out flat.
  const skipModulus = everyKm <= 1;
  const minSpacing = skipModulus ? 9 : 28;
  let lastX = -Infinity;
  for (const point of ds.data) {
    if (!skipModulus && point.x % everyKm > 0.4 && (everyKm - point.x % everyKm) > 0.4) continue;
    const px = chart.scales.x.getPixelForValue(point.x);
    const py = chart.scales.y.getPixelForValue(point.y);
    if (Math.abs(px - lastX) < minSpacing) continue;
    lastX = px;
    const text = fmtPace(point.y);
    const w = ctx.measureText(text).width + 8;
    const h = 14;
    ctx.save();
    ctx.translate(px, py + offY - 14);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = bg;
    roundedRect(ctx, -w + 4, -h / 2, w, h, 6);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    roundedRect(ctx, -w + 4.5, -h / 2 + 0.5, w - 1, h - 1, 6);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillText(text, -w + 8, 0);
    ctx.restore();
  }
  ctx.restore();
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function fmtPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0) return '—';
  const m = Math.floor(secPerKm / 60);
  const r = Math.round(secPerKm % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function initSegmentPaceChart(canvasId, segments, segPaces, totalDistanceKm, trackpoints, opts = {}) {
  const canvas = document.getElementById(canvasId);
  if (chart) { chart.destroy(); chart = null; }
  const fg = getComputedStyle(document.body).getPropertyValue('--fg-dim').trim() || '#a0aab5';

  const segPoints = segments.map((s, i) => ({ x: (s.startKm + s.endKm) / 2, y: segPaces[i] }));

  // Prior-run dashed teal overlay (toggleable). Null entries (segments past the
  // prior trace's end) become NaN points so Chart.js renders a gap, not a line
  // back to zero.
  const priorPoints = Array.isArray(opts.priorPaces)
    ? segments.map((s, i) => ({ x: (s.startKm + s.endKm) / 2, y: opts.priorPaces[i] != null ? opts.priorPaces[i] : NaN }))
    : null;

  const elevPoints = [];
  if (trackpoints?.length) {
    const stride = Math.max(1, Math.floor(trackpoints.length / 400));
    for (let i = 0; i < trackpoints.length; i += stride) {
      elevPoints.push({ x: trackpoints[i].cumDistKm, y: trackpoints[i].eleM });
    }
    const last = trackpoints[trackpoints.length - 1];
    if (elevPoints[elevPoints.length - 1]?.x !== last.cumDistKm) {
      elevPoints.push({ x: last.cumDistKm, y: last.eleM });
    }
  }

  const allPaces = segPaces.filter(v => isFinite(v));
  if (priorPoints) for (const p of priorPoints) if (isFinite(p.y)) allPaces.push(p.y);
  const pMin = Math.max(60, Math.floor(Math.min(...allPaces) / 30) * 30 - 30);
  const pMax = Math.ceil(Math.max(...allPaces) / 30) * 30 + 30;

  const datasets = [
    {
      label: 'Elevation', data: elevPoints, parsing: false,
      yAxisID: 'yEle', xAxisID: 'x',
      borderColor: 'rgba(127,127,127,0.32)', backgroundColor: 'rgba(127,127,127,0.10)',
      pointRadius: 0, borderWidth: 1, fill: 'origin', tension: 0.3, order: 99,
    },
    {
      label: 'Per-segment pace', data: segPoints, parsing: false,
      borderColor: 'rgba(255,140,66,0.85)', backgroundColor: 'rgba(255,140,66,0.06)',
      pointRadius: 0, borderWidth: 1.6, stepped: 'middle', fill: false, order: 1,
    },
  ];
  if (priorPoints) {
    datasets.push({
      label: 'Prior pace', data: priorPoints, parsing: false,
      borderColor: 'rgba(63,184,175,0.95)', backgroundColor: 'rgba(63,184,175,0.05)',
      borderDash: [6, 4],
      pointRadius: 0, borderWidth: 1.6, stepped: 'middle', fill: false, order: 0,
      hidden: !opts.showPrior,
      spanGaps: false,
    });
  }
  // Prior-run HR overlay (rose dotted line on a hidden secondary axis since
  // BPM is on a different scale than pace).
  if (Array.isArray(opts.priorHR)) {
    const hrPoints = segments.map((s, i) => ({
      x: (s.startKm + s.endKm) / 2,
      y: opts.priorHR[i] != null ? opts.priorHR[i] : NaN,
    }));
    datasets.push({
      label: 'Prior HR', data: hrPoints, parsing: false,
      yAxisID: 'yHR',
      borderColor: 'rgba(244,114,182,0.85)',
      borderDash: [2, 3],
      pointRadius: 0, borderWidth: 1.4, fill: false, order: 0,
      hidden: !opts.showPriorHR,
      spanGaps: false,
    });
  }

  chart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      layout: { padding: { top: 24 } },
      scales: {
        x: { type: 'linear', min: 0, max: totalDistanceKm,
             title: { display: true, text: 'Distance (km)', color: fg },
             ticks: { color: fg, stepSize: 5, autoSkip: false },
             grid: { color: 'rgba(127,127,127,0.12)' } },
        y: { min: pMin, max: pMax,
             title: { display: true, text: 'Pace (min/km)', color: fg },
             ticks: { color: fg, stepSize: 30, callback: v => fmtPace(v) },
             grid: { color: 'rgba(127,127,127,0.12)' }, reverse: true },
        yEle: { type: 'linear', position: 'right', display: false, grid: { display: false } },
        yHR: { type: 'linear', position: 'right', display: false, min: 60, max: 220, grid: { display: false } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: (items) => `km ${items[0].parsed.x.toFixed(1)}`,
          label: (item) => item.dataset.label === 'Elevation' ? null : `${item.dataset.label} ${fmtPace(item.parsed.y)}/km`,
        }, filter: (item) => item.dataset.label !== 'Elevation' },
      },
      onHover: (event, _items, c) => {
        const x = c.scales.x.getValueForPixel(event.x);
        if (hoverCallback) hoverCallback(x);
      },
    },
    plugins: [crosshairPlugin, segLabelsPlugin, cpMarkersPlugin],
  });

  chart.$showLabels = !!opts.showLabels;
  chart.$checkpoints = opts.checkpoints || [];
  chart.update();
  canvas.addEventListener('mouseleave', () => { if (hoverCallback) hoverCallback(null); });

  // Drag-to-edit: pick the segment under the cursor on mousedown, then on mousemove
  // map the cursor's y-pixel to a pace and update the segment's bar live. On mouseup
  // emit the final pace via dragCallback so app.js can lock it as a per-segment
  // override. The chart's data array is mutated during drag for instant feedback;
  // the upstream recompute will re-derive everything when the drag commits.
  canvas.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !chart || !segments?.length) return;
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const km = chart.scales.x.getValueForPixel(px);
    const idx = segments.findIndex(s => km >= s.startKm && km < s.endKm);
    if (idx < 0) return;
    event.preventDefault();
    dragState = { idx, segment: segments[idx], startY: event.clientY };
    canvas.style.cursor = 'ns-resize';
    canvas.setPointerCapture?.(event.pointerId || 0);
  });
  const onDragMove = (event) => {
    if (!dragState || !chart) return;
    const rect = canvas.getBoundingClientRect();
    const py = event.clientY - rect.top;
    const newPaceSec = chart.scales.y.getValueForPixel(py);
    if (!isFinite(newPaceSec) || newPaceSec <= 30) return;
    const ds = chart.data.datasets.find(d => d.label === 'Per-segment pace');
    if (ds) ds.data[dragState.idx].y = newPaceSec;
    dragState.lastPace = newPaceSec;
    chart.update('none');
  };
  const onDragEnd = (event) => {
    if (!dragState) return;
    canvas.style.cursor = '';
    const final = dragState.lastPace;
    const idx = dragState.idx;
    dragState = null;
    if (final && dragCallback) dragCallback(idx, final);
  };
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
}

export function setSegmentPaceLabels(show) { if (chart) { chart.$showLabels = !!show; chart.draw(); } }
export function setSegmentPaceHover(km) { if (chart) { chart.$hoverKm = km; chart.draw(); } }
export function onSegmentPaceHover(cb) { hoverCallback = cb; }
export function setSegmentPaceLabelResolver(fn) { if (chart) { chart.$labelResolver = fn; chart.draw(); } }
export function onSegmentPaceDrag(cb) { dragCallback = cb; }
export function setSegmentPaceShowPrior(show) {
  if (!chart) return;
  const ds = chart.data.datasets.find(d => d.label === 'Prior pace');
  if (ds) { ds.hidden = !show; chart.update('none'); }
}
export function setSegmentPaceShowPriorHR(show) {
  if (!chart) return;
  const ds = chart.data.datasets.find(d => d.label === 'Prior HR');
  if (ds) { ds.hidden = !show; chart.update('none'); }
}
export function destroySegmentPaceChart() { if (chart) { chart.destroy(); chart = null; } }
