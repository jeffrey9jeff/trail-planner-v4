// Parse a GPX 1.1 string into a flat trackpoint array with cumulative distance and smoothed elevation.

const R = 6371.0088; // mean Earth radius, km

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Light moving-average smoothing for GPS elevation noise.
export function smoothElevation(eles, window = 3) {
  const n = eles.length;
  if (n === 0) return [];
  const half = Math.floor(window / 2);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      sum += eles[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

// Hysteresis-based gain/loss. Tracks the most recent "anchor" elevation; only commits
// gain (or loss) when the current reading is more than `threshold` metres above (or below)
// the running min/max since the last commit. This matches Strava/Garmin behaviour better
// than a per-step threshold, because it captures slow steady climbs while ignoring noise.
export function computeGainLoss(eles, threshold = 1) {
  if (!eles || eles.length === 0) return { gain: 0, loss: 0 };
  let gain = 0, loss = 0;
  let anchor = eles[0];
  let extreme = anchor;        // running max while ascending, running min while descending
  let dir = 0;                 // +1 = ascending, -1 = descending, 0 = undecided
  for (let i = 1; i < eles.length; i++) {
    const e = eles[i];
    if (dir >= 0 && e > extreme) extreme = e;        // climbing higher
    if (dir <= 0 && e < extreme) extreme = e;        // descending lower
    const fromAnchor = e - anchor;
    if (dir !== -1 && fromAnchor >= threshold) {
      // Confirmed climb commits as we crest a hysteresis bump.
      // Continue tracking — only commit + reset on direction reversal.
      dir = 1;
    } else if (dir !== 1 && fromAnchor <= -threshold) {
      dir = -1;
    }
    // Reversal detection: if we've been climbing and now drop more than threshold from extreme,
    // the previous climb is locked in and we start a fresh descent.
    if (dir === 1 && extreme - e >= threshold) {
      gain += extreme - anchor;
      anchor = extreme;
      extreme = e;
      dir = -1;
    } else if (dir === -1 && e - extreme >= threshold) {
      loss += anchor - extreme;
      anchor = extreme;
      extreme = e;
      dir = 1;
    }
  }
  // Flush the open leg at the end of the trace.
  if (dir === 1) gain += extreme - anchor;
  else if (dir === -1) loss += anchor - extreme;
  return { gain, loss };
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) throw new Error('Invalid GPX: ' + parserError.textContent);

  const nameEl = doc.querySelector('trk > name') || doc.querySelector('metadata > name');
  const name = nameEl ? nameEl.textContent.trim() : 'Unnamed route';

  const trkpts = Array.from(doc.querySelectorAll('trkpt'));
  if (trkpts.length === 0) throw new Error('GPX contains no trackpoints');

  const rawEles = trkpts.map(p => parseFloat(p.querySelector('ele')?.textContent || '0'));
  // Light smoothing on the trackpoints exposed to charts/segments — but compute total gain/loss
  // from the *raw* signal so the hysteresis sees true climbs without smoothing-induced flattening.
  const smoothed = smoothElevation(rawEles, 3);

  // <time> is optional in GPX 1.1 but emitted by Garmin/Strava when the file
  // came from an actual activity. We capture it so prior-run pace overlays can
  // derive segment-by-segment pace; route-only GPX (no <time>) gets timeSec=null
  // and only the elevation overlay is meaningful.
  const timeStrs = trkpts.map(p => p.querySelector('time')?.textContent?.trim() || null);
  const firstTimeStr = timeStrs.find(t => !!t);
  const t0 = firstTimeStr ? Date.parse(firstTimeStr) : NaN;
  // Heart rate via the Garmin TrackPointExtension namespace. We resolve via
  // localName so we don't have to bind to the gpxtpx prefix the file declares.
  const hrs = trkpts.map(p => {
    const exts = p.getElementsByTagName('extensions')[0];
    if (!exts) return null;
    const hrEl = exts.getElementsByTagNameNS('*', 'hr')[0];
    if (!hrEl) return null;
    const v = parseFloat(hrEl.textContent || '');
    return Number.isFinite(v) && v > 0 ? v : null;
  });

  let cumKm = 0;
  const trackpoints = trkpts.map((p, i) => {
    const lat = parseFloat(p.getAttribute('lat'));
    const lon = parseFloat(p.getAttribute('lon'));
    if (i > 0) {
      const prev = trkpts[i - 1];
      cumKm += haversineKm(
        parseFloat(prev.getAttribute('lat')),
        parseFloat(prev.getAttribute('lon')),
        lat,
        lon
      );
    }
    let timeSec = null;
    if (Number.isFinite(t0) && timeStrs[i]) {
      const t = Date.parse(timeStrs[i]);
      if (Number.isFinite(t)) timeSec = (t - t0) / 1000;
    }
    return { lat, lon, eleM: smoothed[i], cumDistKm: cumKm, timeSec, hrBpm: hrs[i] };
  });

  // Use raw signal for gain/loss totals (hysteresis already filters GPS noise).
  const { gain, loss } = computeGainLoss(rawEles);

  return {
    name,
    trackpoints,
    totalDistanceKm: cumKm,
    totalGainM: gain,
    totalLossM: loss,
  };
}
