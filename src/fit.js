// `.fit` parser wrapper. Uses Garmin's official @garmin/fitsdk (ESM via
// jsDelivr) lazily on first .fit upload so the planner doesn't fetch ~300 KB
// of SDK code when the user only ever loads .gpx prior runs.
//
// Adapts the SDK's record messages into our prior-run trackpoint shape:
//   { lat, lon, eleM, timeSec, cumDistKm }
// `lat`/`lon` are in degrees (the SDK exposes positionLat/Long in semicircles
// — int32 fixed-point, 2^31 semicircles = 180°). `timeSec` is from the start
// of the activity, NOT race-day TOD.

import { haversineKm } from './gpx.js?v=v15';
// (Note: fit.js itself bumped to v16 by callers in priorRun.js.)

const FITSDK_URL_PRIMARY = 'https://cdn.jsdelivr.net/npm/@garmin/fitsdk@21.158.0/+esm';
const FITSDK_URL_FALLBACK = 'https://esm.sh/@garmin/fitsdk@21.158.0';
const SEMICIRCLE_TO_DEGREE = 180 / 2 ** 31;

let _sdkPromise = null;
function getSDK() {
  if (!_sdkPromise) {
    _sdkPromise = import(FITSDK_URL_PRIMARY)
      .catch(() => import(FITSDK_URL_FALLBACK));
  }
  return _sdkPromise;
}

export async function parseFitBuffer(buffer, fileName = 'prior.fit') {
  const sdk = await getSDK();
  const Decoder = sdk.Decoder || sdk.default?.Decoder;
  const Stream = sdk.Stream || sdk.default?.Stream;
  if (!Decoder || !Stream) throw new Error('fitsdk: Decoder/Stream not found in module');

  const ab = buffer instanceof ArrayBuffer ? buffer : (buffer.buffer || new Uint8Array(buffer).buffer);
  const stream = Stream.fromArrayBuffer(ab);
  if (!Decoder.isFIT(stream)) throw new Error('Not a valid FIT file');
  const decoder = new Decoder(stream);
  const checked = decoder.checkIntegrity();
  if (!checked) console.warn('FIT integrity check failed; attempting to read anyway');
  const { messages, errors } = decoder.read({
    applyScaleAndOffset: true,
    expandSubFields: true,
    expandComponents: true,
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    mergeHeartRates: false,
  });
  if (errors && errors.length) console.warn('FIT decode errors:', errors.slice(0, 5));

  const recs = Array.isArray(messages?.recordMesgs) ? messages.recordMesgs : [];
  const filtered = recs.filter(r =>
    r && r.positionLat != null && r.positionLong != null && r.timestamp != null
  );
  if (!filtered.length) throw new Error('FIT file has no GPS records');

  const t0 = +new Date(filtered[0].timestamp);
  const trackpoints = filtered.map(r => {
    const ele = r.enhancedAltitude ?? r.altitude;
    const hr = r.heartRate ?? r.heart_rate;
    const spd = r.enhancedSpeed ?? r.speed;
    return {
      lat: Number(r.positionLat) * SEMICIRCLE_TO_DEGREE,
      lon: Number(r.positionLong) * SEMICIRCLE_TO_DEGREE,
      eleM: Number(ele) || 0,
      timeSec: (+new Date(r.timestamp) - t0) / 1000,
      cumDistKm: Number.isFinite(Number(r.distance)) ? Number(r.distance) / 1000 : null,
      hrBpm: Number.isFinite(Number(hr)) && hr > 0 ? Number(hr) : null,
      speedMs: Number.isFinite(Number(spd)) ? Number(spd) : null,
    };
  });

  // Some devices/activities don't write per-record distance — fall back to
  // haversine. We only do this if every distance is missing/zero; partial
  // distance traces would corrupt the alignment.
  const tail = trackpoints[trackpoints.length - 1];
  if (tail.cumDistKm == null || tail.cumDistKm <= 0) {
    let cum = 0;
    trackpoints[0].cumDistKm = 0;
    for (let i = 1; i < trackpoints.length; i++) {
      cum += haversineKm(
        trackpoints[i-1].lat, trackpoints[i-1].lon,
        trackpoints[i].lat, trackpoints[i].lon,
      );
      trackpoints[i].cumDistKm = cum;
    }
  }

  const last = trackpoints[trackpoints.length - 1];
  const baseName = fileName.replace(/\.fit$/i, '');

  // True moving time. The session message's totalTimerTime is only useful if
  // auto-pause was on — when it's off (Jeff's UTA case), totalTimerTime ==
  // totalElapsedTime and aid-station stops are still counted. So we always
  // compute moving time directly from the per-record speedMs stream: sum dt
  // where the runner was actually moving (speed >= 0.5 m/s, ~ slow walk).
  // This matches what Strava/Garmin Connect's "Moving Time" stat reports.
  const STOP_SPEED = 0.5; // m/s
  let stoppedSec = 0;
  for (let i = 0; i < trackpoints.length - 1; i++) {
    const dt = trackpoints[i + 1].timeSec - trackpoints[i].timeSec;
    if (dt > 0 && Number.isFinite(trackpoints[i].speedMs) && trackpoints[i].speedMs < STOP_SPEED) {
      stoppedSec += dt;
    }
  }
  const elapsedFromRecords = last.timeSec - trackpoints[0].timeSec;
  const movingFromSpeed = elapsedFromRecords - stoppedSec;

  const session = Array.isArray(messages?.sessionMesgs) ? messages.sessionMesgs[0] : null;
  const sessionTimerSec = Number(session?.totalTimerTime);
  const sessionElapsedSec = Number(session?.totalElapsedTime);

  // Prefer the speed-derived moving time (it captures stops the watch missed).
  // Fall back to the session's totalTimerTime if speed data is sparse.
  const totalMovingTime = movingFromSpeed > 0 && stoppedSec > 0
    ? movingFromSpeed
    : (Number.isFinite(sessionTimerSec) ? sessionTimerSec : elapsedFromRecords);
  const totalElapsedTime = Number.isFinite(sessionElapsedSec) && sessionElapsedSec > 0
    ? sessionElapsedSec
    : elapsedFromRecords;

  return {
    name: baseName,
    source: 'fit',
    trackpoints,
    totalDistanceKm: last.cumDistKm,
    // totalSec is the headline number — moving time, since that's what runners
    // report as their finish time on Strava/Garmin Connect.
    totalSec: totalMovingTime,
    totalMovingTime,
    totalElapsedTime,
    totalStoppedTime: Math.max(0, totalElapsedTime - totalMovingTime),
  };
}
