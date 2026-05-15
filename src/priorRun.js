// Prior-run loader and segment alignment.
//   loadPriorRunFile(file) → dispatches by extension to fit.js / gpx.js,
//                            returns a normalised priorRun object.
//   alignPriorToSegments(priorRun, segments, planSegPaces)
//                          → for each plan segment, derives the prior run's
//                            pace by linearly interpolating its time at the
//                            segment's start/end km. Segments past the prior's
//                            end of trace get null entries (the chart renders
//                            gaps cleanly).

import { parseGPX } from './gpx.js?v=v15';
import { parseFitBuffer } from './fit.js?v=v16';
import { readArrayBufferFile, readTextFile } from './storage.js?v=v19';

export async function loadPriorRunFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'fit') {
    const buf = await readArrayBufferFile(file);
    return await parseFitBuffer(buf, file.name);
  }
  if (ext === 'gpx') {
    const text = await readTextFile(file);
    const gpx = parseGPX(text);
    const tp = gpx.trackpoints;
    if (!tp.length) throw new Error('GPX has no trackpoints');
    if (tp[0].timeSec == null) {
      throw new Error('This GPX has no <time> tags so per-segment pace cannot be derived. Try a .fit file or a Strava-exported GPX with timestamps.');
    }
    const last = tp[tp.length - 1];
    // Compute speed per trackpoint from time + distance deltas (GPX has no
    // native speed field). speedMs powers stop-time detection downstream.
    const tpWithSpeed = tp.map((t, i) => {
      let speedMs = null;
      if (i > 0 && Number.isFinite(t.timeSec) && Number.isFinite(tp[i-1].timeSec)) {
        const dt = t.timeSec - tp[i-1].timeSec;
        if (dt > 0) {
          const dKm = (t.cumDistKm || 0) - (tp[i-1].cumDistKm || 0);
          speedMs = (dKm * 1000) / dt;
        }
      }
      return {
        lat: t.lat, lon: t.lon, eleM: t.eleM,
        timeSec: t.timeSec, cumDistKm: t.cumDistKm,
        hrBpm: t.hrBpm ?? null,
        speedMs,
      };
    });
    // Same moving-time derivation as fit.js so prior-run stats are consistent
    // across sources.
    const STOP_SPEED = 0.5;
    let stoppedSec = 0;
    for (let i = 0; i < tpWithSpeed.length - 1; i++) {
      const dt = tpWithSpeed[i+1].timeSec - tpWithSpeed[i].timeSec;
      if (dt > 0 && Number.isFinite(tpWithSpeed[i].speedMs) && tpWithSpeed[i].speedMs < STOP_SPEED) {
        stoppedSec += dt;
      }
    }
    const elapsed = last.timeSec - tpWithSpeed[0].timeSec;
    const moving = elapsed - stoppedSec;
    return {
      name: gpx.name || file.name.replace(/\.gpx$/i, ''),
      source: 'gpx',
      trackpoints: tpWithSpeed,
      totalDistanceKm: gpx.totalDistanceKm,
      totalSec: moving > 0 && stoppedSec > 0 ? moving : elapsed,
      totalMovingTime: moving > 0 ? moving : elapsed,
      totalElapsedTime: elapsed,
      totalStoppedTime: Math.max(0, stoppedSec),
    };
  }
  throw new Error('Unsupported file type: .' + ext + ' — use .fit or .gpx');
}

// Linear-interpolated lat/lon/ele on the plan trace at a given km. Used by
// the spatial alignment path so we can find geographically-equivalent prior
// trackpoints rather than assuming km axes line up.
function planPointAtKm(planTrackpoints, km) {
  if (!planTrackpoints?.length) return null;
  if (km <= planTrackpoints[0].cumDistKm) return planTrackpoints[0];
  const last = planTrackpoints[planTrackpoints.length - 1];
  if (km >= last.cumDistKm) return last;
  let lo = 0, hi = planTrackpoints.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (planTrackpoints[mid].cumDistKm <= km) lo = mid;
    else hi = mid;
  }
  const a = planTrackpoints[lo], b = planTrackpoints[hi];
  const dx = b.cumDistKm - a.cumDistKm;
  const t = dx > 0 ? (km - a.cumDistKm) / dx : 0;
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    eleM: a.eleM + (b.eleM - a.eleM) * t,
    cumDistKm: km,
  };
}

// Find the prior trackpoint nearest to (lat, lon). Walks outward from
// `hintIdx` in both directions, stopping when haversine distance starts
// growing past the running best — this is much faster than O(n) per call,
// since the route is roughly monotonic.
function _haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function nearestPriorIdx(priorTrackpoints, targetLat, targetLon, hintIdx = 0) {
  const n = priorTrackpoints.length;
  if (!n) return { idx: -1, distKm: Infinity };
  let best = Math.max(0, Math.min(n - 1, hintIdx));
  let bestD = _haversineKm(priorTrackpoints[best].lat, priorTrackpoints[best].lon, targetLat, targetLon);
  // Forward search
  for (let i = best + 1; i < n; i++) {
    const d = _haversineKm(priorTrackpoints[i].lat, priorTrackpoints[i].lon, targetLat, targetLon);
    if (d < bestD) { bestD = d; best = i; }
    else if (d > bestD + 0.5) break;
  }
  // Backward search
  for (let i = best - 1; i >= 0; i--) {
    const d = _haversineKm(priorTrackpoints[i].lat, priorTrackpoints[i].lon, targetLat, targetLon);
    if (d < bestD) { bestD = d; best = i; }
    else if (d > bestD + 0.5) break;
  }
  return { idx: best, distKm: bestD };
}

// Linear-interpolated time at a target km along the prior trace. Returns null
// if km is past the trace's end or before its start.
function timeAtKm(trackpoints, km) {
  const n = trackpoints.length;
  if (n < 2) return null;
  const last = trackpoints[n - 1];
  if (km <= trackpoints[0].cumDistKm) return trackpoints[0].timeSec;
  if (km >= last.cumDistKm) return null; // past end → caller treats as no-data
  // Binary search by cumDistKm — trackpoints are guaranteed monotonic per parser.
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (trackpoints[mid].cumDistKm <= km) lo = mid;
    else hi = mid;
  }
  const a = trackpoints[lo], b = trackpoints[hi];
  const dx = b.cumDistKm - a.cumDistKm;
  if (dx <= 0) return a.timeSec;
  const t = (km - a.cumDistKm) / dx;
  return a.timeSec + (b.timeSec - a.timeSec) * t;
}

// Align prior-run data to the plan's per-segment grid.
//
// When `planTrackpoints` is provided we use SPATIAL alignment (haversine to
// find the geographically-nearest prior trackpoint for each plan segment
// boundary). This handles year-over-year course differences where a prior
// race's km axis may not match the current plan's km axis even though the
// two routes mostly overlap. When `planTrackpoints` is omitted we fall back
// to a km-axis interpolation, which is faster but less accurate when the
// two traces drift apart.
export function alignPriorToSegments(priorRun, segments, planSegPaces, planTrackpoints) {
  const empty = { priorSegPaces: [], priorSegPaceDeltas: [], priorCumAvgPaces: [], priorSegHR: [], priorSegGrade: [] };
  if (!priorRun?.trackpoints?.length || !segments?.length) return empty;

  const tp = priorRun.trackpoints;
  const priorSegPaces = new Array(segments.length).fill(null);
  const priorSegPaceDeltas = new Array(segments.length).fill(null);
  const priorCumAvgPaces = new Array(segments.length).fill(null);
  const priorSegHR = new Array(segments.length).fill(null);
  const priorSegGrade = new Array(segments.length).fill(null);

  const useSpatial = Array.isArray(planTrackpoints) && planTrackpoints.length >= 2;

  if (useSpatial) {
    // For each plan segment, find prior trackpoints nearest to the plan's
    // geographic location at startKm and endKm. Reuse the previous segment's
    // end-match as a hint so the search stays roughly O(n + m). For each
    // segment we ALSO sum stopped time within that segment so the per-segment
    // pace reflects MOVING pace (not wall-clock pace, which would include
    // aid-station stops). The cumulative avg pace tracks moving time too.
    const STOP_SPEED = 0.5; // m/s — same threshold used in fit.js totalMovingTime
    let hintIdx = 0;
    let cumMovingSec = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const planStart = planPointAtKm(planTrackpoints, seg.startKm);
      const planEnd = planPointAtKm(planTrackpoints, seg.endKm);
      if (!planStart || !planEnd) continue;
      const startMatch = nearestPriorIdx(tp, planStart.lat, planStart.lon, hintIdx);
      const endMatch = nearestPriorIdx(tp, planEnd.lat, planEnd.lon, startMatch.idx);
      hintIdx = endMatch.idx;
      if (startMatch.idx < 0 || endMatch.idx < 0 || endMatch.idx <= startMatch.idx) continue;
      const tStart = tp[startMatch.idx].timeSec;
      const tEnd = tp[endMatch.idx].timeSec;
      const wallDt = tEnd - tStart;
      if (!(wallDt > 0) || seg.distKm <= 0) continue;
      // Sum stopped time within the matched range so we can subtract it from
      // the wall-clock delta to get true moving time for this segment.
      let stoppedInSeg = 0;
      for (let k = startMatch.idx; k < endMatch.idx; k++) {
        const dt = tp[k+1].timeSec - tp[k].timeSec;
        if (dt > 0 && Number.isFinite(tp[k].speedMs) && tp[k].speedMs < STOP_SPEED) {
          stoppedInSeg += dt;
        }
      }
      const movingDt = Math.max(0, wallDt - stoppedInSeg);
      if (!(movingDt > 0)) continue;
      const pace = movingDt / seg.distKm;
      if (!Number.isFinite(pace) || pace <= 0) continue;
      priorSegPaces[i] = pace;
      cumMovingSec += movingDt;
      if (Array.isArray(planSegPaces) && Number.isFinite(planSegPaces[i])) {
        priorSegPaceDeltas[i] = pace - planSegPaces[i];
      }
      if (seg.endKm > 0) priorCumAvgPaces[i] = cumMovingSec / seg.endKm;
      // HR average across the matched prior-trackpoint range
      let hrSum = 0, hrCount = 0;
      for (let k = startMatch.idx; k <= endMatch.idx; k++) {
        const t = tp[k];
        if (Number.isFinite(t.hrBpm) && t.hrBpm > 0) { hrSum += t.hrBpm; hrCount++; }
      }
      if (hrCount > 0) priorSegHR[i] = hrSum / hrCount;
      // Grade from prior elevation between the matched endpoints
      const eStart = tp[startMatch.idx].eleM;
      const eEnd = tp[endMatch.idx].eleM;
      if (Number.isFinite(eStart) && Number.isFinite(eEnd)) {
        priorSegGrade[i] = ((eEnd - eStart) / (seg.distKm * 1000)) * 100;
      }
    }
    return { priorSegPaces, priorSegPaceDeltas, priorCumAvgPaces, priorSegHR, priorSegGrade };
  }

  // === km-axis fallback ===
  // Single forward sweep: for each plan segment, accumulate HR samples and
  // elevation deltas at prior trackpoints whose cumDistKm falls inside the
  // segment's [startKm, endKm) range.
  let tpIdx = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let hrSum = 0, hrCount = 0;
    let eleStart = null, eleEnd = null;
    while (tpIdx < tp.length && tp[tpIdx].cumDistKm < seg.startKm) tpIdx++;
    if (tpIdx < tp.length) eleStart = tp[tpIdx].eleM;
    while (tpIdx < tp.length && tp[tpIdx].cumDistKm < seg.endKm) {
      const t = tp[tpIdx];
      if (Number.isFinite(t.hrBpm) && t.hrBpm > 0) { hrSum += t.hrBpm; hrCount++; }
      eleEnd = t.eleM;
      tpIdx++;
    }
    if (hrCount > 0) priorSegHR[i] = hrSum / hrCount;
    if (eleStart != null && eleEnd != null && seg.distKm > 0) {
      priorSegGrade[i] = ((eleEnd - eleStart) / (seg.distKm * 1000)) * 100;
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const tStart = timeAtKm(tp, seg.startKm);
    const tEnd = timeAtKm(tp, seg.endKm);
    if (tStart == null || tEnd == null || seg.distKm <= 0) continue;
    const pace = (tEnd - tStart) / seg.distKm;
    if (!Number.isFinite(pace) || pace <= 0) continue;
    priorSegPaces[i] = pace;
    if (Array.isArray(planSegPaces) && Number.isFinite(planSegPaces[i])) {
      priorSegPaceDeltas[i] = pace - planSegPaces[i];
    }
    if (seg.endKm > 0) priorCumAvgPaces[i] = tEnd / seg.endKm;
  }
  return { priorSegPaces, priorSegPaceDeltas, priorCumAvgPaces, priorSegHR, priorSegGrade };
}

// Slim a priorRun for localStorage: drop derived arrays (recomputed) and keep
// only the fields the chart re-init paths actually need from trackpoints.
export function slimPriorRunForStorage(priorRun) {
  if (!priorRun) return null;
  return {
    name: priorRun.name,
    source: priorRun.source,
    totalDistanceKm: priorRun.totalDistanceKm,
    totalSec: priorRun.totalSec,
    trackpoints: (priorRun.trackpoints || []).map(t => ({
      lat: t.lat, lon: t.lon, eleM: t.eleM,
      timeSec: t.timeSec, cumDistKm: t.cumDistKm,
      hrBpm: t.hrBpm ?? null,
      speedMs: t.speedMs ?? null,
    })),
  };
}
