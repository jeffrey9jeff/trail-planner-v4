// Build per-segment summaries from trackpoints.

export function buildSegments(trackpoints, splitKm = 1) {
  if (!trackpoints || trackpoints.length < 2) return [];
  if (!splitKm || splitKm < 0.1) splitKm = 1;
  const segments = [];

  let segStartIdx = 0;
  let segIdx = 0;
  let nextBoundary = splitKm;

  for (let i = 1; i < trackpoints.length; i++) {
    const tp = trackpoints[i];
    const reachedEnd = i === trackpoints.length - 1;
    if (tp.cumDistKm >= nextBoundary || reachedEnd) {
      const segEndIdx = i;
      const startKm = trackpoints[segStartIdx].cumDistKm;
      const endKm = tp.cumDistKm;
      const distKm = endKm - startKm;

      // Hysteresis gain/loss within the segment slice (matches gpx.js).
      const slice = trackpoints.slice(segStartIdx, segEndIdx + 1);
      let gain = 0, loss = 0;
      const sliceEles = slice.map(p => p.eleM);
      const threshold = 1;
      if (sliceEles.length >= 2) {
        let anchor = sliceEles[0], extreme = anchor, dir = 0;
        for (let k = 1; k < sliceEles.length; k++) {
          const e = sliceEles[k];
          if (dir >= 0 && e > extreme) extreme = e;
          if (dir <= 0 && e < extreme) extreme = e;
          const fromAnchor = e - anchor;
          if (dir !== -1 && fromAnchor >= threshold) dir = 1;
          else if (dir !== 1 && fromAnchor <= -threshold) dir = -1;
          if (dir === 1 && extreme - e >= threshold) {
            gain += extreme - anchor; anchor = extreme; extreme = e; dir = -1;
          } else if (dir === -1 && e - extreme >= threshold) {
            loss += anchor - extreme; anchor = extreme; extreme = e; dir = 1;
          }
        }
        if (dir === 1) gain += extreme - anchor;
        else if (dir === -1) loss += anchor - extreme;
      }
      const netM = slice[slice.length - 1].eleM - slice[0].eleM;
      const avgGradePct = distKm > 0 ? (netM / (distKm * 1000)) * 100 : 0;
      const mid = slice[Math.floor(slice.length / 2)];

      segments.push({
        idx: segIdx,
        startKm,
        endKm,
        distKm,
        gainM: gain,
        lossM: loss,
        netM,
        avgGradePct,
        midLat: mid.lat,
        midLon: mid.lon,
        startLat: slice[0].lat,
        startLon: slice[0].lon,
        endLat: slice[slice.length - 1].lat,
        endLon: slice[slice.length - 1].lon,
        startEle: slice[0].eleM,
        endEle: slice[slice.length - 1].eleM,
      });

      segIdx++;
      segStartIdx = segEndIdx;
      nextBoundary += splitKm;
      if (reachedEnd) break;
    }
  }
  return segments;
}

export function segmentIndexForKm(segments, km) {
  if (!segments.length) return -1;
  if (km <= segments[0].startKm) return 0;
  if (km >= segments[segments.length - 1].endKm) return segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    if (km < segments[i].endKm) return i;
  }
  return segments.length - 1;
}
