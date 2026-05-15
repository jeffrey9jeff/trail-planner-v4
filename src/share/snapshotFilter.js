// snapshotFilter — turns the v8 storage.js snapshot into a slim, read-only
// plan blob suitable for shipping to crew / family via the share doc.
//
// Phase 1 of the Spectator / Crew Share View. The full snapshot includes
// planner-internal bookkeeping (tasks, history, scenarios, raw FIT trace,
// UI prefs) that crew don't need to see. This filter is the privacy boundary
// between the runner-side planner and the read-only share view.
//
// KEEP: everything the share view needs to re-derive segments, paces and
// ETAs that exactly match the planner — including the gradient-pace and
// technical-pace knobs (their *panel* is hidden in the share view, but the
// underlying values must travel so derived numbers don't drift).
//
// STRIP completely: scenarios, activeScenario, priorMatchedIndices,
// showPriorOverlay, cpLabelFields — all planner-side UI/state.
//
// KEEP-SLIM: priorRun gets stripped of its 5000-point trackpoints array
// (the bulk of the doc) and HR/grade arrays, leaving only what's needed to
// surface "Jeff is N min ahead of last year" — name, totalSec, and the
// derived per-segment pace arrays.

const PRIVATE_DROPBAG_FLAGS = ['autoRestock', 'autoAdjust', 'manualEdit'];

function filterDropbag(db) {
  db = db || {};
  const gels = (db.gels && typeof db.gels === 'object') ? { ...db.gels } : {};
  return {
    gels,
    fluidL: Number(db.fluidL) || 0,
    waterL: Number(db.waterL) || 0,
    notes: db.notes || '',
    // PRIVATE_DROPBAG_FLAGS are intentionally dropped — planner-internal
    // auto-fill bookkeeping.
  };
}

function filterCheckpoint(cp) {
  return {
    id: cp.id,
    name: cp.name,
    km: cp.km,
    stoppageSec: cp.stoppageSec || 0,
    color: cp.color,
    notes: cp.notes || '',
    _uid: cp._uid,
    dropbag: filterDropbag(cp.dropbag),
  };
}

function filterNutrition(nu) {
  nu = nu || {};
  const inv = nu.startInventory || {};
  return {
    gelGPerHr: Number(nu.gelGPerHr) || 40,
    fluidGPerHr: Number(nu.fluidGPerHr) || 50,
    fluidLPerHr: Number(nu.fluidLPerHr) || 0.5,
    gelTypes: (Array.isArray(nu.gelTypes) ? nu.gelTypes : []).map(t => ({
      id: String(t.id || ''),
      name: t.name || '',
      sizeG: Number(t.sizeG) || 25,
    })),
    startInventory: {
      gels: (inv.gels && typeof inv.gels === 'object') ? { ...inv.gels } : {},
      fluidL: Number(inv.fluidL) || 0,
      waterL: Number(inv.waterL) || 0,
      notes: inv.notes || '',
      // autoRestock / autoAdjust / manualEdit dropped.
    },
  };
}

// Prior run is kept only as the slim "vs last year" surface: name, totals
// and the pre-derived per-segment pace arrays. The 5000-trackpoint trace
// and HR/grade arrays are stripped — bulk of the doc, useless to crew.
function filterPriorRun(pr) {
  if (!pr || typeof pr !== 'object') return null;
  return {
    name: pr.name || 'Prior race',
    source: pr.source || 'fit',
    totalSec: Number(pr.totalSec) || 0,
    totalDistanceKm: Number(pr.totalDistanceKm) || 0,
    priorSegPaces: Array.isArray(pr.priorSegPaces) ? pr.priorSegPaces.slice() : [],
    priorSegPaceDeltas: Array.isArray(pr.priorSegPaceDeltas) ? pr.priorSegPaceDeltas.slice() : [],
    priorCumAvgPaces: Array.isArray(pr.priorCumAvgPaces) ? pr.priorCumAvgPaces.slice() : [],
    // STRIP: trackpoints (the 5000-point bulk), priorSegHR, priorSegGrade,
    // totalMovingTime, totalElapsedTime, totalStoppedTime.
  };
}

// Slim every scenario down to just the fields the share view needs to
// re-derive segPaces + ETAs. Drops nothing functional — the share doc
// includes the goal driver (mode + time/pace/gap), the per-segment
// override deltas, the gradient/technical knobs, the pace shift, and the
// per-CP stoppage map. Skipped: scenario `name` is kept for the picker
// label, but nothing else planner-internal.
function filterScenarios(scn) {
  const out = {};
  const keys = ['A', 'B', 'C', 'prior'];
  for (const k of keys) {
    const sc = (scn && scn[k]) || {};
    out[k] = {
      name: sc.name || (k === 'prior' ? 'Prior race' : 'Plan ' + k),
      mode: ['time', 'pace', 'gap'].includes(sc.mode) ? sc.mode : 'time',
      timeSec: Number(sc.timeSec) || 0,
      paceSecPerKm: Number(sc.paceSecPerKm) || 0,
      gapSecPerKm: Number(sc.gapSecPerKm) || 0,
      overrides: Array.isArray(sc.overrides)
        ? sc.overrides.map(o => ({
            idx: Number(o.idx),
            gapSecPerKm: Number(o.gapSecPerKm),
            mode: o.mode === 'anchor' ? 'anchor' : 'point',
          })).filter(o => Number.isFinite(o.idx) && Number.isFinite(o.gapSecPerKm))
        : [],
      gradientPaceOverrides: { ...(sc.gradientPaceOverrides || {}) },
      technicalGradientPaceOverrides: { ...(sc.technicalGradientPaceOverrides || {}) },
      technicalIndices: Array.isArray(sc.technicalIndices)
        ? sc.technicalIndices.filter(i => Number.isFinite(i)) : [],
      cpStops: sc.cpStops && typeof sc.cpStops === 'object' ? { ...sc.cpStops } : {},
      paceShift: sc.paceShift && typeof sc.paceShift === 'object'
        ? {
            mode: ['gap', 'percent', 'seconds'].includes(sc.paceShift.mode) ? sc.paceShift.mode : 'gap',
            value: Number(sc.paceShift.value) || 0,
          }
        : { mode: 'gap', value: 0 },
    };
  }
  return out;
}

export function filterSnapshotForShare(snap) {
  if (!snap || typeof snap !== 'object') return null;
  const filtered = {
    version: snap.version || 8,
    gpxName: snap.gpxName || '',
    gpxText: snap.gpxText || '',
    splitKm: Number(snap.splitKm) || 1,
    raceStart: snap.raceStart || '06:00:00',
    raceDate: snap.raceDate || '',
    goal: { ...(snap.goal || {}) },
    overrides: Array.isArray(snap.overrides)
      ? snap.overrides.map(o => ({
          idx: Number(o.idx),
          gapSecPerKm: Number(o.gapSecPerKm),
          mode: o.mode || 'anchor',
        }))
      : [],
    // Gradient-pace knobs are kept (drive computeSegmentPaces) but the
    // *panel* is excluded from the share view — these are invisible to
    // crew but make sure share ETAs match planner ETAs to the second.
    gradientPaceOverrides: { ...(snap.gradientPaceOverrides || {}) },
    technicalGradientPaceOverrides: { ...(snap.technicalGradientPaceOverrides || {}) },
    technicalIndices: Array.isArray(snap.technicalIndices) ? [...snap.technicalIndices] : [],
    technicalSlowdown: Number(snap.technicalSlowdown) || 1.2,
    splitBias: Number(snap.splitBias) || 0,
    uphillEffort: Number(snap.uphillEffort) || 1.0,
    checkpoints: Array.isArray(snap.checkpoints)
      ? snap.checkpoints.map(filterCheckpoint)
      : [],
    nutrition: filterNutrition(snap.nutrition),
    priorRun: filterPriorRun(snap.priorRun),
    // Phase 2: pass spectator points through unfiltered (no private fields
    // on them). km may be null if the runner entered lat/lon but the
    // planner hadn't snapped yet — the share view re-snaps on render.
    spectatorPoints: Array.isArray(snap.spectatorPoints)
      ? snap.spectatorPoints.map(sp => ({
          id: sp.id || '',
          name: sp.name || 'Spectator point',
          lat: Number(sp.lat),
          lon: Number(sp.lon),
          km: Number.isFinite(sp.km) ? sp.km : null,
          color: sp.color || '#a371f7',
          notes: sp.notes || '',
          address: sp.address || '',
          accessNotes: sp.accessNotes || '',
        })).filter(sp => Number.isFinite(sp.lat) && Number.isFinite(sp.lon))
      : [],
    // V4 v4.3: Ship all scenarios so crew can toggle between Plan A / B /
    // C / Prior Race. The TOP-LEVEL `overrides`, `gradientPaceOverrides`,
    // `technicalIndices`, `paceShift` still reflect the runner's active
    // scenario (so a viewer with no scenario picker — or one with the
    // active default — sees the active plan). When a viewer picks a
    // different scenario, the share view re-derives using that scenario's
    // saved edits.
    scenarios: filterScenarios(snap.scenarios),
    activeScenario: ['A','B','C','prior'].includes(snap.activeScenario)
      ? snap.activeScenario : 'A',
    // STRIP: priorMatchedIndices (per-scenario inside the block already),
    //         showPriorOverlay, cpLabelFields.
  };
  // Paranoia belt: deep-clone once via JSON so no mutable ref leaks from
  // planner state into the stored doc. Subsequent planner edits cannot
  // mutate the shared run through any path.
  return JSON.parse(JSON.stringify(filtered));
}
