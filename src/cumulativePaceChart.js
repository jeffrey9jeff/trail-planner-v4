// Cumulative pace chart: cumulative average + optional GAP overlay.

let chart = null;
let hoverCallback = null;

const crosshairPlugin = {
  id: 'cum-crosshair',
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

const cumLabelsPlugin = {
  id: 'cum-labels',
  afterDatasetsDraw(chart) {
    if (!chart.$showCumLabels) return;
    const ds = chart.data.datasets.find(d => d.label === 'Cumulative avg');
    if (!ds) return;
    const ctx = chart.ctx;
    const cs = getComputedStyle(chart.canvas);
    const panel = cs.getPropertyValue('--panel').trim() || '#161b22';
    drawLabels(chart, ctx, ds, panel, '#58a6ff', 5, 16);
  },
};

const cpMarkersPlugin = {
  id: 'cum-cp-markers',
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
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let lastX = -Infinity;
  for (const point of ds.data) {
    if (point.x % everyKm > 0.4 && (everyKm - point.x % everyKm) > 0.4) continue;
    const px = chart.scales.x.getPixelForValue(point.x);
    const py = chart.scales.y.getPixelForValue(point.y);
    if (Math.abs(px - lastX) < 28) continue;
    lastX = px;
    const text = fmtPace(point.y);
    const w = ctx.measureText(text).width + 10;
    const h = 14;
    ctx.fillStyle = bg;
    rect(ctx, px - w / 2, py + offY - h / 2, w, h, 2); ctx.fill();
    ctx.strokeStyle = accent; ctx.lineWidth = 1;
    rect(ctx, px - w / 2 + 0.5, py + offY - h / 2 + 0.5, w - 1, h - 1, 2); ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillText(text, px, py + offY);
  }
  ctx.restore();
}

function rect(ctx, x, y, w, h, r) {
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

export function initCumPaceChart(canvasId, segments, segPaces, segGaps, cumSec, totalDistanceKm, trackpoints, opts = {}) {
  const canvas = document.getElementById(canvasId);
  if (chart) { chart.destroy(); chart = null; }
  // Chart.js does not understand `var(--…)` strings — resolve to a real color
  // at init so dark/light theme switches pick up the right axis text colour.
  const fg = getComputedStyle(document.body).getPropertyValue('--fg-dim').trim() || '#a0aab5';

  const cumAvg = segments.map((s, i) => ({ x: s.endKm, y: cumSec[i] / s.endKm }));

  // Cumulative GAP-only-equivalent average: total time would be Σ dist × GAP / 1 (since GAP is flat-equivalent pace).
  // For overlay, plot the cumulative average if every segment ran at its stored GAP (ignoring grade/effort/tech).
  // That's effectively Σ(distKm[i] × segGaps[i]) / cumDist.
  const cumGap = [];
  if (segGaps?.length) {
    let runSec = 0;
    for (let i = 0; i < segments.length; i++) {
      runSec += segments[i].distKm * segGaps[i];
      cumGap.push({ x: segments[i].endKm, y: runSec / segments[i].endKm });
    }
  }

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

  // Prior-run cumulative-avg overlay. Null entries become NaN so the chart
  // renders a gap rather than connecting to zero.
  const priorCum = Array.isArray(opts.priorCumPaces)
    ? segments.map((s, i) => ({ x: s.endKm, y: opts.priorCumPaces[i] != null ? opts.priorCumPaces[i] : NaN }))
    : null;

  const allPaces = [...cumAvg.map(p => p.y), ...cumGap.map(p => p.y)].filter(v => isFinite(v));
  if (priorCum) for (const p of priorCum) if (isFinite(p.y)) allPaces.push(p.y);
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
      label: 'Cumulative avg', data: cumAvg, parsing: false,
      borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.1)',
      pointRadius: 0, borderWidth: 2.5, fill: false, tension: 0.2, order: 1,
    },
  ];
  if (opts.showGAP) {
    datasets.push({
      label: 'Cumulative GAP', data: cumGap, parsing: false,
      borderColor: 'rgba(163, 113, 247, 0.9)',
      borderDash: [5, 5],
      pointRadius: 0, borderWidth: 1.6, fill: false, tension: 0.2, order: 2,
    });
  }
  if (priorCum) {
    datasets.push({
      label: 'Prior cum-avg', data: priorCum, parsing: false,
      borderColor: 'rgba(63,184,175,0.95)', backgroundColor: 'rgba(63,184,175,0.05)',
      borderDash: [6, 4],
      pointRadius: 0, borderWidth: 2, fill: false, tension: 0.2, order: 0,
      hidden: !opts.showPrior,
      spanGaps: false,
    });
  }
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
        legend: {
          labels: {
            color: fg, font: { size: 11 },
            filter: (item) => item.text !== 'Elevation',
          },
          position: 'top', align: 'end',
        },
        tooltip: { callbacks: {
          title: (items) => `km ${items[0].parsed.x.toFixed(1)}`,
          label: (item) => item.dataset.label === 'Elevation' ? null : `${item.dataset.label}: ${fmtPace(item.parsed.y)}/km`,
        }, filter: (item) => item.dataset.label !== 'Elevation' },
      },
      onHover: (event, _items, c) => {
        const x = c.scales.x.getValueForPixel(event.x);
        if (hoverCallback) hoverCallback(x);
      },
    },
    plugins: [crosshairPlugin, cumLabelsPlugin, cpMarkersPlugin],
  });

  chart.$showCumLabels = !!opts.showCumLabels;
  chart.$checkpoints = opts.checkpoints || [];
  chart.update();
  canvas.addEventListener('mouseleave', () => { if (hoverCallback) hoverCallback(null); });
}

export function setCumPaceLabels(showCumLabels) {
  if (!chart) return;
  chart.$showCumLabels = showCumLabels;
  chart.draw();
}

export function setCumPaceHover(km) { if (chart) { chart.$hoverKm = km; chart.draw(); } }
export function onCumPaceHover(cb) { hoverCallback = cb; }
export function setCumPaceLabelResolver(fn) { if (chart) { chart.$labelResolver = fn; chart.draw(); } }
export function setCumPaceShowPrior(show) {
  if (!chart) return;
  const ds = chart.data.datasets.find(d => d.label === 'Prior cum-avg');
  if (ds) { ds.hidden = !show; chart.update('none'); }
}
export function setCumPaceShowPriorHR(show) {
  if (!chart) return;
  const ds = chart.data.datasets.find(d => d.label === 'Prior HR');
  if (ds) { ds.hidden = !show; chart.update('none'); }
}
export function destroyCumPaceChart() { if (chart) { chart.destroy(); chart = null; } }
