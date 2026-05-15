import { paceFromGap, gapFromPace, costOfRunning } from './minetti.js';

const C0 = 3.6;

function splitFactor(midKm, totalKm, splitBias, magnitude = 0.2) {
  if (!splitBias || totalKm <= 0) return 1;
  return 1 + splitBias * magnitude * (midKm / totalKm - 0.5);
}

// === Per-segment GAP resolution ===
// Each override may be 'anchor' (interpolate) or 'point' (single segment, no propagation).
// Implicit boundary anchors at the first and last segments hold the *default* GAP, so a single
// user anchor in the middle creates a smooth "tent" without pinning all other segments to the
// override value.
export function computeSegmentGaps(segments, baseGap, overrides, totalKm = 0, splitBias = 0) {
  const n = segments.length;
  if (n === 0) return [];
  const result = new Array(n);
  const overrideMap = new Map(overrides.map(o => [o.idx, o]));

  // Default per-segment GAP applying split bias.
  const defaults = segments.map(s => baseGap * splitFactor((s.startKm + s.endKm) / 2, totalKm, splitBias));

  // Build the anchor list: user-anchor overrides + implicit endpoints if not already overridden.
  const userAnchors = overrides
    .filter(o => (o.mode || 'anchor') === 'anchor')
    .map(o => ({ idx: o.idx, gap: o.gapSecPerKm }));
  const anchors = [];
  if (!overrideMap.has(0))               anchors.push({ idx: 0,     gap: defaults[0],     implicit: true });
  for (const a of userAnchors)           anchors.push(a);
  if (!overrideMap.has(n - 1))           anchors.push({ idx: n - 1, gap: defaults[n - 1], implicit: true });
  anchors.sort((a, b) => a.idx - b.idx);

  for (let i = 0; i < n; i++) {
    const ov = overrideMap.get(i);
    if (ov) { result[i] = ov.gapSecPerKm; continue; }

    // Locate enclosing anchors (left ≤ i ≤ right).
    let left = null, right = null;
    for (const a of anchors) {
      if (a.idx <= i) left = a;
      if (a.idx >= i) { right = a; break; }
    }
    if (left && right) {
      result[i] = (left.idx === right.idx)
        ? left.gap
        : left.gap + (right.gap - left.gap) * ((i - left.idx) / (right.idx - left.idx));
    } else if (left) {
      result[i] = left.gap;
    } else if (right) {
      result[i] = right.gap;
    } else {
      result[i] = defaults[i];
    }
  }
  return result;
}

// Apply gradient overrides AFTER GAP→pace conversion. Each override is a pace (sec/km) at
// an integer-percent gradient bucket; a segment with grade in [bucket-0.5, bucket+0.5) gets that pace.
// Per-segment overrides (the "anchor/point" kind) take priority over gradient overrides.
// Technical segments multiply the resulting pace by technicalSlowdown.
// Priority: per-segment override → (technical AND tech-grade override) → grade override → default.
// If technical AND no tech-grade override is set, multiply final pace by technicalSlowdown.
export function computeSegmentPaces(
  segments, segGaps, uphillEffort = 1,
  gradientPaceOverrides = {}, perSegmentOverrideIdxSet = new Set(),
  technicalSet = new Set(), technicalSlowdown = 1,
  technicalGradientPaceOverrides = {}
) {
  return segments.map((s, i) => {
    const tech = technicalSet.has(i);
    if (perSegmentOverrideIdxSet.has(i)) {
      const p = paceFromGap(segGaps[i], s.avgGradePct, uphillEffort);
      return tech ? p * technicalSlowdown : p;
    }
    const bucket = Math.round(s.avgGradePct);
    if (tech && technicalGradientPaceOverrides[bucket] != null && isFinite(technicalGradientPaceOverrides[bucket])) {
      return technicalGradientPaceOverrides[bucket];  // explicit tech pace; no further multiplier
    }
    const override = gradientPaceOverrides[bucket];
    let p = (override != null && isFinite(override) && override > 0)
      ? override
      : paceFromGap(segGaps[i], s.avgGradePct, uphillEffort);
    return tech ? p * technicalSlowdown : p;
  });
}

export function computeSegmentSeconds(segments, segPaces) {
  const segSec = segments.map((s, i) => s.distKm * segPaces[i]);
  const cumSec = [];
  let running = 0;
  for (const s of segSec) { running += s; cumSec.push(running); }
  return { segSec, cumSec, totalSec: running };
}

export function gapForTargetTime(
  segments, targetTotalSec, totalKm,
  splitBias = 0, uphillEffort = 1,
  technicalSet = new Set(), technicalSlowdown = 1
) {
  if (!segments.length) return 0;
  let weight = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const sf = splitFactor((s.startKm + s.endKm) / 2, totalKm, splitBias);
    const cost = costOfRunning(s.avgGradePct);
    const adjusted = s.avgGradePct > 0 ? cost / uphillEffort : cost;
    const techMul = technicalSet.has(i) ? technicalSlowdown : 1;
    weight += s.distKm * sf * (adjusted / C0) * techMul;
  }
  return weight > 0 ? targetTotalSec / weight : 0;
}

export function buildStoppageAccumulator(checkpoints) {
  const sorted = [...checkpoints].sort((a, b) => a.km - b.km);
  return function stoppageBeforeKm(km, includeAtKm = false) {
    let total = 0;
    for (const cp of sorted) {
      if (cp.km < km || (includeAtKm && cp.km === km)) total += cp.stoppageSec || 0;
    }
    return total;
  };
}

export function totalStoppageSec(checkpoints) {
  return checkpoints.reduce((sum, cp) => sum + (cp.stoppageSec || 0), 0);
}

export function secondsAtKm(km, segments, cumSec) {
  if (!segments.length) return 0;
  if (km <= segments[0].startKm) return 0;
  const last = segments[segments.length - 1];
  if (km >= last.endKm) return cumSec[cumSec.length - 1];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (km < s.endKm) {
      const prevCum = i === 0 ? 0 : cumSec[i - 1];
      const segElapsed = cumSec[i] - prevCum;
      const t = s.distKm > 0 ? (km - s.startKm) / s.distKm : 0;
      return prevCum + segElapsed * t;
    }
  }
  return cumSec[cumSec.length - 1];
}

export function computeCheckpointETAs(checkpoints, segments, cumSec, raceStartSec) {
  const stoppage = buildStoppageAccumulator(checkpoints);
  return checkpoints.map(cp => {
    const tSec = secondsAtKm(cp.km, segments, cumSec) + stoppage(cp.km);
    return formatTimeOfDay(raceStartSec + tSec);
  });
}

export function computeSegmentETAs(segments, cumSec, raceStartSec, checkpoints) {
  const stoppage = buildStoppageAccumulator(checkpoints);
  return segments.map((seg, i) => {
    const tSec = cumSec[i] + stoppage(seg.endKm);
    return formatTimeOfDay(raceStartSec + tSec);
  });
}

// === Time / pace text helpers ===

// Unified bare-digit parsing: 1-2 digits = MM, 3-4 = MM:SS, 5-6 = HH:MM:SS.
// "05" → 5 min (300 s) · "0533" → 5:33 (333 s) · "130210" → 13:02:10 (46930 s).
function parseBareDigits(digits) {
  if (!digits) return 0;
  if (digits.length <= 2) return parseInt(digits, 10) * 60;
  if (digits.length <= 4) {
    const mm = parseInt(digits.slice(0, -2), 10) || 0;
    const ss = parseInt(digits.slice(-2), 10) || 0;
    return mm * 60 + ss;
  }
  const ss = parseInt(digits.slice(-2), 10) || 0;
  const mm = parseInt(digits.slice(-4, -2), 10) || 0;
  const hh = parseInt(digits.slice(0, -4), 10) || 0;
  return hh * 3600 + mm * 60 + ss;
}

// Used for HH:MM:SS contexts (goal time, cum, ETA, race start as text).
// Colon form parses naturally; bare digits use the smart logic above.
export function parseHHMMSS(text) {
  if (text == null) return 0;
  const t = String(text).trim();
  if (!t) return 0;
  if (t.includes(':')) {
    const parts = t.split(':').map(p => parseFloat(p) || 0);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60; // H:MM
    return parts[0] * 3600;
  }
  return parseBareDigits(t.replace(/[^\d]/g, ''));
}

export function formatHHMMSS(totalSec) {
  if (!isFinite(totalSec)) return '—';
  const s = Math.max(0, Math.round(totalSec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function parsePace(text) {
  if (text == null) return 0;
  const t = String(text).trim();
  if (!t) return 0;
  if (t.includes(':')) {
    const [m, s] = t.split(':');
    return (parseInt(m, 10) || 0) * 60 + (parseFloat(s) || 0);
  }
  if (t.includes('.')) {
    const v = parseFloat(t);
    if (isFinite(v)) return v * 60;
  }
  return parseBareDigits(t.replace(/[^\d]/g, ''));
}

export function formatPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0) return '—';
  const s = Math.round(secPerKm);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function formatTimeOfDay(totalSec) {
  if (!isFinite(totalSec)) return '—';
  const day = 86400;
  const t = ((Math.round(totalSec) % day) + day) % day;
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function parseStoppage(text) {
  if (text == null) return 0;
  const t = String(text).trim();
  if (!t) return 0;
  if (t.includes(':')) {
    const [m, s] = t.split(':');
    return (parseInt(m, 10) || 0) * 60 + (parseInt(s, 10) || 0);
  }
  return parseBareDigits(t.replace(/[^\d]/g, ''));
}

export function formatStoppage(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
