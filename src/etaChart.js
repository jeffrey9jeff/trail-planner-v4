let chart = null;
let hoverCallback = null;

// Background bands: night before civil dawn (dark), dawn → sunrise (lighter),
// daytime (no shade), sunset → civil dusk (lighter), night after dusk (dark).
// Drawn UNDER the data lines so they're a subtle backdrop.
const dayNightPlugin = {
  id: 'eta-daynight',
  beforeDatasetsDraw(chart) {
    const sun = chart.$sunInfo;
    if (!sun) return;
    const { ctx, chartArea, scales } = chart;
    const xL = chartArea.left, xR = chartArea.right;
    // y-axis is reversed (smaller hours up). For each band we map yStart/yEnd
    // through scales.y.getPixelForValue and clip to chartArea bounds. Hours
    // outside the chart's visible range simply don't render — getPixelForValue
    // can return values past chartArea.top/bottom but we clamp.
    const yMin = scales.y.min;
    const yMax = scales.y.max;
    const drawBand = (yStart, yEnd, color) => {
      const a = Math.max(yMin, Math.min(yMax, yStart));
      const b = Math.max(yMin, Math.min(yMax, yEnd));
      if (a === b) return;
      const py1 = scales.y.getPixelForValue(a);
      const py2 = scales.y.getPixelForValue(b);
      const top = Math.min(py1, py2);
      const bottom = Math.max(py1, py2);
      ctx.save();
      ctx.fillStyle = color;
      ctx.fillRect(xL, top, xR - xL, bottom - top);
      ctx.restore();
    };
    // Yesterday-night up to civil dawn
    drawBand(0, sun.civilDawn, 'rgba(20, 24, 40, 0.30)');
    // Civil dawn → sunrise (twilight)
    drawBand(sun.civilDawn, sun.sunrise, 'rgba(60, 80, 120, 0.20)');
    // Sunset → civil dusk (twilight)
    drawBand(sun.sunset, sun.civilDusk, 'rgba(60, 80, 120, 0.20)');
    // Night after civil dusk
    drawBand(sun.civilDusk, 24, 'rgba(20, 24, 40, 0.30)');
    // Day 2 (if chart spans past midnight): repeat the bands offset by 24h.
    if (yMax > 24) {
      drawBand(24, 24 + sun.civilDawn, 'rgba(20, 24, 40, 0.30)');
      drawBand(24 + sun.civilDawn, 24 + sun.sunrise, 'rgba(60, 80, 120, 0.20)');
      drawBand(24 + sun.sunset, 24 + sun.civilDusk, 'rgba(60, 80, 120, 0.20)');
      drawBand(24 + sun.civilDusk, 48, 'rgba(20, 24, 40, 0.30)');
    }
  },
};

// Sun and moon symbols rendered to the LEFT of the y-axis at the sunrise and
// sunset hour marks. Drawn after datasets so they sit on top of any line
// crossings near the y-axis edge.
const sunMoonPlugin = {
  id: 'eta-sunmoon',
  afterDatasetsDraw(chart) {
    const sun = chart.$sunInfo;
    if (!sun) return;
    const { ctx, chartArea, scales } = chart;
    const yMin = scales.y.min;
    const yMax = scales.y.max;
    const drawSymbol = (hour, glyph, color) => {
      if (hour < yMin || hour > yMax) return;
      const py = scales.y.getPixelForValue(hour);
      // Position to the LEFT of the y-axis time labels. scales.y.left is the
      // left edge of the y-axis area; nudging 6px before that puts the glyph
      // outside the labels in the canvas's left-padding gutter.
      const px = Math.max(8, (scales.y.left || chartArea.left) - 8);
      ctx.save();
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(glyph, px, py);
      ctx.restore();
    };
    drawSymbol(sun.sunrise, '☀', '#ffd166');
    drawSymbol(sun.sunset, '☾', '#9aa6b2');
    // Day 2 sunrise/sunset for races spanning past midnight
    if (yMax > 24) {
      drawSymbol(24 + sun.sunrise, '☀', '#ffd166');
      drawSymbol(24 + sun.sunset, '☾', '#9aa6b2');
    }
  },
};

const crosshairPlugin = {
  id: 'eta-crosshair',
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

// Anti-collision: when CPs cluster (e.g. Six Foot Track + Start + Return are 3 km apart),
// stack each label into a free vertical lane below the dot instead of all at offset 8 px.
const checkpointLabels = {
  id: 'cp-labels',
  afterDatasetsDraw(chart) {
    const cpDataset = chart.data.datasets[1];
    if (!cpDataset) return;
    const ctx = chart.ctx;
    const fg = getComputedStyle(chart.canvas).getPropertyValue('--fg').trim() || '#e6edf3';
    const dim = getComputedStyle(chart.canvas).getPropertyValue('--fg-dim').trim() || '#9aa6b2';
    const placed = []; // {x1, x2, y1, y2}
    const labelHeight = 36;
    const padX = 8;
    const laneStep = 32;
    const gap = 8; // gap between dot and label

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const area = chart.chartArea;
    const midY = (area.top + area.bottom) / 2;

    cpDataset.data.forEach(p => {
      const px = chart.scales.x.getPixelForValue(p.x);
      const py = chart.scales.y.getPixelForValue(p.y);
      ctx.font = '600 11px -apple-system, "Segoe UI", Roboto, sans-serif';
      const text1 = `${p.label} · ${p.name}`;
      const text2 = fmtHr(p.y);
      const w1 = ctx.measureText(text1).width;
      ctx.font = '10px -apple-system, "Segoe UI", Roboto, sans-serif';
      const w2 = ctx.measureText(text2).width;
      const w = Math.max(w1, w2);

      // Dot in the lower half of the plot? Stack labels UPWARD so they don't fall into the x-axis area.
      const goUp = py > midY;

      const labelTopFor = lane => goUp
        ? py - gap - labelHeight - lane * laneStep
        : py + gap + lane * laneStep;

      let lane = 0;
      const fits = () => {
        const top = labelTopFor(lane);
        const bottom = top + labelHeight;
        // Also clamp inside chart vertical bounds.
        if (top < area.top - 4 || bottom > area.bottom + 4) return false;
        const left = px - w / 2 - padX;
        const right = px + w / 2 + padX;
        return !placed.some(b => left < b.x2 && right > b.x1 && top < b.y2 && bottom > b.y1);
      };
      while (lane < 8 && !fits()) lane++;

      const yTop = labelTopFor(lane);
      // Connector line for any pushed lane (and even lane 0 for "up" so the relationship reads).
      if (lane > 0 || goUp) {
        ctx.strokeStyle = (p.color || dim) + '88';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (goUp) {
          ctx.moveTo(px, py - 6);
          ctx.lineTo(px, yTop + labelHeight + 1);
        } else {
          ctx.moveTo(px, py + 6);
          ctx.lineTo(px, yTop - 1);
        }
        ctx.stroke();
      }
      ctx.font = '600 11px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = p.color || fg;
      ctx.fillText(text1, px, yTop);
      ctx.font = '10px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = dim;
      ctx.fillText(text2, px, yTop + 14);

      placed.push({
        x1: px - w / 2 - padX,
        x2: px + w / 2 + padX,
        y1: yTop,
        y2: yTop + labelHeight,
      });
    });
    ctx.restore();
  },
};

function fmtHr(hourDecimal) {
  const total = Math.round(hourDecimal * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function initETAChart(canvasId, segments, cumSec, raceStartSec, checkpoints, totalDistanceKm, opts = {}) {
  const canvas = document.getElementById(canvasId);
  if (chart) { chart.destroy(); chart = null; }
  const fg = getComputedStyle(document.body).getPropertyValue('--fg-dim').trim() || '#a0aab5';

  const stoppageBefore = (km) =>
    checkpoints.filter(cp => cp.km < km).reduce((s, cp) => s + (cp.stoppageSec || 0), 0);

  const points = segments.map((s, i) => ({
    x: s.endKm,
    y: (raceStartSec + cumSec[i] + stoppageBefore(s.endKm)) / 3600,
  }));
  points.unshift({ x: 0, y: raceStartSec / 3600 });

  const cpPoints = checkpoints.map(cp => {
    const i = segments.findIndex(s => cp.km <= s.endKm);
    if (i < 0) return null;
    const seg = segments[i];
    const prevCum = i === 0 ? 0 : cumSec[i - 1];
    const segElapsed = cumSec[i] - prevCum;
    const t = seg.distKm > 0 ? (cp.km - seg.startKm) / seg.distKm : 0;
    const tSec = prevCum + segElapsed * t + stoppageBefore(cp.km);
    let displayName = cp.name || '';
    if (displayName.length > 22) displayName = displayName.slice(0, 21) + '…';
    return { x: cp.km, y: (raceStartSec + tSec) / 3600, label: cp.id, name: displayName, color: cp.color };
  }).filter(Boolean);

  const allY = points.map(p => p.y);
  const yMin = Math.floor(Math.min(...allY) * 2) / 2;
  const yMax = Math.ceil(Math.max(...allY) * 2) / 2;

  chart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Plan',
          data: points,
          parsing: false,
          borderColor: '#ff8c42',
          backgroundColor: 'rgba(255,140,66,0.12)',
          pointRadius: 0,
          borderWidth: 2,
          fill: false,
          tension: 0.1,
        },
        {
          label: 'Checkpoints',
          data: cpPoints,
          parsing: false,
          showLine: false,
          pointRadius: 6,
          pointHoverRadius: 8,
          backgroundColor: cpPoints.map(p => p.color || '#58a6ff'),
          borderColor: '#fff',
          borderWidth: 1.5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 16, bottom: 50, left: 30 } },
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
          min: yMin, max: yMax,
          reverse: true,
          title: { display: true, text: 'Time of day', color: fg },
          ticks: { color: fg, stepSize: 0.5, callback: v => fmtHr(v) },
          grid: { color: 'rgba(127,127,127,0.12)' },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `km ${items[0].parsed.x.toFixed(1)}`,
            label: (item) => {
              if (item.dataset.label === 'Checkpoints') return `${item.raw.name} (${item.raw.label}) — ${fmtHr(item.parsed.y)}`;
              return fmtHr(item.parsed.y);
            },
          },
        },
      },
      onHover: (event, _items, chartInstance) => {
        const x = chartInstance.scales.x.getValueForPixel(event.x);
        if (hoverCallback) hoverCallback(x);
      },
    },
    plugins: [dayNightPlugin, sunMoonPlugin, crosshairPlugin, checkpointLabels],
  });

  chart.$sunInfo = opts.sunInfo || null;
  chart.update();
  canvas.addEventListener('mouseleave', () => { if (hoverCallback) hoverCallback(null); });
}

export function setETAHover(km) {
  if (!chart) return;
  chart.$hoverKm = km;
  chart.draw();
}

export function onETAHover(cb) { hoverCallback = cb; }
export function setETALabelResolver(fn) { if (chart) { chart.$labelResolver = fn; chart.draw(); } }
export function destroyETAChart() { if (chart) { chart.destroy(); chart = null; } }
