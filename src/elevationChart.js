let chart = null;
let segmentsRef = [];
let hoverCallback = null;

const GRADE_COLORS = {
  flat:        '#6bcf7f',
  mod:         '#ffd166',
  steep:       '#f0a868',
  severe:      '#e95569',
  down:        '#5fa8d3',
  downSteep:   '#3d8bb5',
};

function colorForGrade(pct) {
  if (pct >= 12) return GRADE_COLORS.severe;
  if (pct >= 7) return GRADE_COLORS.steep;
  if (pct >= 3) return GRADE_COLORS.mod;
  if (pct >= -3) return GRADE_COLORS.flat;
  if (pct >= -7) return GRADE_COLORS.down;
  return GRADE_COLORS.downSteep;
}

function colorWithAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function findSegmentForKm(km) {
  if (!segmentsRef.length) return null;
  if (km <= segmentsRef[0].startKm) return segmentsRef[0];
  for (let i = 0; i < segmentsRef.length; i++) {
    if (km < segmentsRef[i].endKm) return segmentsRef[i];
  }
  return segmentsRef[segmentsRef.length - 1];
}

const cpMarkersPlugin = {
  id: 'elev-cp-markers',
  afterDatasetsDraw(chart) {
    const cps = chart.$checkpoints;
    if (!cps?.length) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '600 10px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'top';
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
      ctx.fillText(cp.id, px, top + 2);
    }
    ctx.restore();
  },
};

const crosshairPlugin = {
  id: 'crosshair-elev',
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

export function initElevationChart(canvasId, trackpoints, segments, totalDistanceKm, opts = {}) {
  segmentsRef = segments;
  const canvas = document.getElementById(canvasId);
  if (chart) { chart.destroy(); chart = null; }
  const fg = getComputedStyle(document.body).getPropertyValue('--fg-dim').trim() || '#a0aab5';

  const targetPoints = 600;
  const stride = Math.max(1, Math.floor(trackpoints.length / targetPoints));
  const points = [];
  for (let i = 0; i < trackpoints.length; i += stride) {
    points.push({ x: trackpoints[i].cumDistKm, y: trackpoints[i].eleM });
  }
  const last = trackpoints[trackpoints.length - 1];
  if (points[points.length - 1]?.x !== last.cumDistKm) {
    points.push({ x: last.cumDistKm, y: last.eleM });
  }

  // Prior-run elevation overlay (faint dotted teal). Sample to ~400 points
  // matching the segpace/cumpace conventions; trackpoints are on the same
  // course so they share the y-scale.
  const priorPoints = [];
  if (Array.isArray(opts.priorTrackpoints) && opts.priorTrackpoints.length) {
    const ptp = opts.priorTrackpoints;
    const stride = Math.max(1, Math.floor(ptp.length / 400));
    for (let i = 0; i < ptp.length; i += stride) {
      priorPoints.push({ x: ptp[i].cumDistKm, y: ptp[i].eleM });
    }
    const last = ptp[ptp.length - 1];
    if (priorPoints[priorPoints.length - 1]?.x !== last.cumDistKm) {
      priorPoints.push({ x: last.cumDistKm, y: last.eleM });
    }
  }

  const datasets = [{
    label: 'Elevation',
    data: points,
    parsing: false,
    pointRadius: 0,
    borderWidth: 1.5,
    fill: { target: 'origin' },
    segment: {
      // Color each visual line-segment by its LOCAL gradient (slope between
      // p0 and p1) rather than the wider plan segment's avg grade. Plan
      // segments are ~1 km wide, so a steep climb embedded inside a flat-on-
      // average segment was being painted as flat (green). Local grade =
      // (Δele in m) / (Δkm × 1000) × 100.
      borderColor: ctx => {
        const a = ctx.p0?.parsed, b = ctx.p1?.parsed;
        if (!a || !b) return '#fff';
        const dx = b.x - a.x;
        if (!(dx > 0)) return '#fff';
        const grade = ((b.y - a.y) / 1000) / dx * 100;
        return colorForGrade(grade);
      },
      backgroundColor: ctx => {
        const a = ctx.p0?.parsed, b = ctx.p1?.parsed;
        if (!a || !b) return 'rgba(255,255,255,0.05)';
        const dx = b.x - a.x;
        if (!(dx > 0)) return 'rgba(255,255,255,0.05)';
        const grade = ((b.y - a.y) / 1000) / dx * 100;
        return colorWithAlpha(colorForGrade(grade), 0.18);
      },
    },
    tension: 0.2,
  }];
  if (priorPoints.length) {
    datasets.push({
      label: 'Prior elevation',
      data: priorPoints,
      parsing: false,
      pointRadius: 0,
      borderWidth: 1,
      borderColor: 'rgba(63,184,175,0.7)',
      borderDash: [3, 3],
      fill: false,
      tension: 0.2,
      hidden: !opts.showPrior,
    });
  }

  chart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 18 } },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: totalDistanceKm,
          title: { display: true, text: 'Distance (km)', color: fg },
          ticks: { color: fg, stepSize: 5, autoSkip: false },
          grid: { color: 'rgba(127,127,127,0.12)' },
        },
        y: {
          title: { display: true, text: 'Elevation (m)', color: fg },
          ticks: { color: fg },
          grid: { color: 'rgba(127,127,127,0.12)' },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `km ${items[0].parsed.x.toFixed(2)}`,
            label: (item) => {
              const seg = findSegmentForKm(item.parsed.x);
              return [
                `Elevation ${item.parsed.y.toFixed(1)} m`,
                seg ? `Grade ${seg.avgGradePct.toFixed(1)}%` : '',
              ].filter(Boolean);
            },
          },
        },
      },
      onHover: (event, _items, chartInstance) => {
        const x = chartInstance.scales.x.getValueForPixel(event.x);
        if (hoverCallback) hoverCallback(x);
      },
    },
    plugins: [crosshairPlugin, cpMarkersPlugin],
  });

  chart.$checkpoints = opts.checkpoints || [];
  chart.update();

  canvas.addEventListener('mouseleave', () => { if (hoverCallback) hoverCallback(null); });
}

export function setElevationHover(km) {
  if (!chart) return;
  chart.$hoverKm = km;
  chart.draw();
}

export function setElevationCheckpoints(cps) {
  if (!chart) return;
  chart.$checkpoints = cps || [];
  chart.draw();
}

export function onElevationHover(cb) { hoverCallback = cb; }
export function setElevationLabelResolver(fn) { if (chart) { chart.$labelResolver = fn; chart.draw(); } }
export function setElevationShowPrior(show) {
  if (!chart) return;
  const ds = chart.data.datasets.find(d => d.label === 'Prior elevation');
  if (ds) { ds.hidden = !show; chart.update('none'); }
}
export function destroyElevationChart() { if (chart) { chart.destroy(); chart = null; } }
