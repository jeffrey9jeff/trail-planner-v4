import { UTA100_CHECKPOINTS, UTA100_FINISH_KM } from './presets/uta100.js?v=v12';

let nextManualId = 1;

export function roundKm(km) { return Math.round(km * 10) / 10; }

function defaultColorFor(id) {
  if (id === 'FIN') return '#6bcf7f';
  if (id?.startsWith?.('WP')) return '#5fa8d3';
  if (id?.startsWith?.('MK')) return '#ffd166';
  return '#58a6ff';
}

// Globally unique UID — survives page reloads. Used by Alpine's :key so re-rendering
// or re-importing checkpoints never produces duplicate keys (which previously caused
// rows to silently disappear from the checkpoints table).
function genUid() {
  return 'cp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function ensureUid(cp, seen) {
  if (!cp._uid || (seen && seen.has(cp._uid))) {
    cp._uid = genUid();
  }
  if (seen) seen.add(cp._uid);
  return cp;
}

// Idempotent — leaves an already-shaped dropbag alone but back-fills missing fields.
// Migrates legacy v6 dropbag shape ({gels:n, caffGels:n, fluidG:n}) to the v7 shape
// (gels:{g1:n, g2:n}, fluidL, waterL, autoRestock). The legacy fluidG is treated as
// 100 g/L pre-mix when computing fluidL.
function ensureDropbag(cp) {
  const db = cp.dropbag || {};
  let gels;
  if (db.gels && typeof db.gels === 'object') {
    gels = { ...db.gels };
  } else {
    gels = {};
    if (db.gels != null) gels.g1 = Number(db.gels) || 0;
    if (db.caffGels != null) gels.g2 = Number(db.caffGels) || 0;
  }
  let fluidL = Number(db.fluidL);
  if (!isFinite(fluidL) || fluidL === 0) {
    if (db.fluidG != null) fluidL = (Number(db.fluidG) || 0) / 100;
    else fluidL = 0;
  }
  cp.dropbag = {
    gels,
    fluidL,
    waterL: Number(db.waterL) || 0,
    notes: db.notes || '',
    autoRestock: !!db.autoRestock,
  };
  return cp;
}

// After mutating gelTypes (add/remove), make sure every checkpoint's dropbag.gels
// has a key for every active type and no orphan keys. Defaults missing entries to 0.
export function syncDropbagsToGelTypes(checkpoints, gelTypes) {
  const ids = new Set((gelTypes || []).map(t => t.id));
  for (const cp of checkpoints) {
    if (!cp.dropbag) cp.dropbag = { gels: {}, fluidL: 0, waterL: 0, notes: '', autoRestock: false };
    if (!cp.dropbag.gels || typeof cp.dropbag.gels !== 'object') cp.dropbag.gels = {};
    for (const id of ids) {
      if (cp.dropbag.gels[id] == null) cp.dropbag.gels[id] = 0;
    }
    for (const k of Object.keys(cp.dropbag.gels)) {
      if (!ids.has(k)) delete cp.dropbag.gels[k];
    }
  }
  return checkpoints;
}

export function defaultCheckpoints(totalDistanceKm) {
  if (totalDistanceKm >= 95 && totalDistanceKm <= 105) {
    // Honour the published finish km (e.g. 2026 UTA's 101.3) even when it's a touch past the
    // GPX endpoint — keeps Finish below MK1 (Base of Furber Steps) in the sorted view.
    const seen = new Set();
    const cps = UTA100_CHECKPOINTS.map(c => ensureDropbag(ensureUid({ ...c }, seen)));
    cps.push(ensureDropbag(ensureUid({ id: 'FIN', name: 'Finish', km: UTA100_FINISH_KM, stoppageSec: 0, color: '#6bcf7f', notes: '' }, seen)));
    return cps;
  }
  return [ensureDropbag(ensureUid({ id: 'FIN', name: 'Finish', km: roundKm(totalDistanceKm), stoppageSec: 0, color: '#6bcf7f', notes: '' }))];
}

export function makeManualCheckpoint(km, totalDistanceKm) {
  const id = 'X' + (nextManualId++);
  return ensureDropbag(ensureUid({
    id,
    name: 'Checkpoint',
    km: roundKm(Math.max(0, Math.min(totalDistanceKm, km))),
    stoppageSec: 0,
    color: defaultColorFor(id),
    notes: '',
  }));
}

export function normaliseCheckpoint(cp) {
  if (!cp) return cp;
  ensureUid(cp);
  ensureDropbag(cp);
  if (!cp.color) cp.color = defaultColorFor(cp.id);
  if (cp.stoppageSec == null) cp.stoppageSec = 0;
  return cp;
}

// Apply across an array — guarantees every CP has a unique _uid and a color.
// Used on JSON import / autosave restore so duplicates from older saved states are healed.
export function normaliseCheckpoints(cps) {
  const seen = new Set();
  for (const cp of cps) {
    ensureUid(cp, seen);
    ensureDropbag(cp);
    if (!cp.color) cp.color = defaultColorFor(cp.id);
    if (cp.stoppageSec == null) cp.stoppageSec = 0;
  }
  return cps;
}

export function sortByKm(checkpoints) {
  return [...checkpoints].sort((a, b) => a.km - b.km);
}
// Sun May 10 09:30:32 AUSEST 2026
