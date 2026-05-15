// storeLocal — local-first store adapter for the spectator share feature.
//
// Two browser tabs on the same origin can exchange a share doc through
// localStorage + BroadcastChannel + the storage event. No server, no
// Firebase. Phase 5 will swap in storeFirebase under the same exported
// surface and the rest of the share code stays unchanged.
//
// localStorage layout:
//   trail-planner-v4-share-runs → { [runId]: RunDoc }   (the "DB")
//   trail-planner-v4-share-self → { runId, ownerToken, shareToken, expiresAt }
//                                  (this runner's own run reference,
//                                   so reload reuses the same URL)
//
// BroadcastChannel name pattern: `trail-share-<runId>` — one channel per
// run; the share viewer subscribes to only the run it was opened with.
//
// All methods are async (Promise) so the Phase-5 Firebase swap-in is
// drop-in. The local impl resolves synchronously inside a microtask.

export const RUN_KEY = 'trail-planner-v4-share-runs';
export const SELF_KEY = 'trail-planner-v4-share-self';

// === Token generation =====================================================

// crypto.randomUUID is supported on all evergreen browsers since
// Safari 15.4 / Chrome 92. Fallback to a Math.random-based ID for ancient
// in-app browsers; entropy is lower but acceptable for a Phase-1 local
// share link (no server-side replay window to defend).
function uuid() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {}
  // eslint-disable-next-line no-console
  console.warn('[share] crypto.randomUUID unavailable; falling back to Math.random');
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${rand()}${rand()}-${rand()}-${rand()}`;
}

export function genRunId() {
  // Shorter ID for the URL — first segment of a UUID is plenty (36+ bits).
  return uuid().split('-')[0] + uuid().split('-')[0];
}
export function genToken() { return uuid().replace(/-/g, ''); }

// === DB primitives ========================================================

function readDb() {
  try {
    const raw = localStorage.getItem(RUN_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) {
    console.warn('[share] readDb failed', e);
    return {};
  }
}

function writeDb(db) {
  try {
    localStorage.setItem(RUN_KEY, JSON.stringify(db));
    return true;
  } catch (e) {
    console.warn('[share] writeDb failed', e);
    return false;
  }
}

// Expire-on-read sweep so RUN_KEY can't grow unbounded with stale runs.
function sweepExpired(db) {
  const now = Date.now();
  let dirty = false;
  for (const id of Object.keys(db)) {
    const r = db[id];
    if (r && r.expiresAt && r.expiresAt < now) {
      delete db[id];
      dirty = true;
    }
  }
  if (dirty) writeDb(db);
  return db;
}

// === Self-token persistence (runner side) =================================

export function loadShareSelf() {
  try {
    const raw = localStorage.getItem(SELF_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    // Drop self if it points at an expired run.
    if (obj.expiresAt && obj.expiresAt < Date.now()) {
      localStorage.removeItem(SELF_KEY);
      return null;
    }
    return obj;
  } catch (e) {
    console.warn('[share] loadShareSelf failed', e);
    return null;
  }
}

export function saveShareSelf(obj) {
  try {
    localStorage.setItem(SELF_KEY, JSON.stringify(obj));
  } catch (e) {
    console.warn('[share] saveShareSelf failed', e);
  }
}

export function clearShareSelf() {
  try { localStorage.removeItem(SELF_KEY); } catch {}
}

// === Broadcast helper =====================================================

function broadcast(runId, kind = 'update') {
  try {
    const ch = new BroadcastChannel('trail-share-' + runId);
    ch.postMessage({ kind, t: Date.now() });
    ch.close();
  } catch (e) {
    // BroadcastChannel unsupported (older Safari) → the storage event +
    // 1s poll fallback will still pick up the change. Don't throw.
  }
}

// === Public surface =======================================================

// Create a fresh run, OR — per Jeff's "regenerate updates same URL" rule —
// update the existing one when SELF_KEY already has a non-expired run.
//
// Returns: { runId, ownerToken, shareToken, expiresAt, createdAt, isNew }
export async function createRun(filteredPlan, opts = {}) {
  const expiresAt = Number(opts.expiresAt) || (Date.now() + 14 * 86400_000);
  const db = sweepExpired(readDb());
  const self = loadShareSelf();

  if (self && self.runId && db[self.runId]) {
    // Same URL — overwrite the existing run's plan + bump expiry.
    const existing = db[self.runId];
    if (existing.ownerToken !== self.ownerToken) {
      throw new Error('Owner token mismatch on existing run');
    }
    existing.plan = filteredPlan;
    existing.expiresAt = expiresAt;
    existing.updatedAt = Date.now();
    db[self.runId] = existing;
    if (!writeDb(db)) throw new Error('Failed to write share doc to localStorage');
    saveShareSelf({
      runId: existing.runId,
      ownerToken: existing.ownerToken,
      shareToken: existing.shareToken,
      expiresAt,
    });
    broadcast(existing.runId, 'update');
    return {
      runId: existing.runId,
      ownerToken: existing.ownerToken,
      shareToken: existing.shareToken,
      expiresAt,
      createdAt: existing.createdAt,
      isNew: false,
    };
  }

  // Fresh run.
  const runId = genRunId();
  const ownerToken = genToken();
  const shareToken = genToken();
  const createdAt = Date.now();
  const doc = {
    runId,
    ownerToken,
    shareToken,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    plan: filteredPlan,
    live: null,           // Phase 3+
    spectatorPoints: [],  // Phase 2+
  };
  db[runId] = doc;
  if (!writeDb(db)) throw new Error('Failed to write share doc to localStorage');
  saveShareSelf({ runId, ownerToken, shareToken, expiresAt });
  broadcast(runId, 'create');
  return { runId, ownerToken, shareToken, expiresAt, createdAt, isNew: true };
}

// Shallow merge a patch onto the run. Validates ownerToken — crew with
// only the shareToken can't write. Used in Phase 1 for expiry-date edits,
// Phase 2 for spectator points, etc.
export async function updateRun(runId, patch, ownerToken) {
  const db = sweepExpired(readDb());
  const doc = db[runId];
  if (!doc) throw new Error('Run not found: ' + runId);
  if (doc.ownerToken !== ownerToken) throw new Error('Owner token mismatch');
  Object.assign(doc, patch, { updatedAt: Date.now() });
  db[runId] = doc;
  if (!writeDb(db)) throw new Error('Failed to update share doc');
  broadcast(runId, 'update');
}

// Phase-3 stub — wires now so the call site is one-line later.
export async function pushLive(runId, live, ownerToken) {
  return updateRun(runId, { live }, ownerToken);
}

// One-shot read. Validates shareToken — wrong token returns null.
export async function getRun(runId, shareToken) {
  const db = sweepExpired(readDb());
  const doc = db[runId];
  if (!doc) return null;
  if (doc.shareToken !== shareToken) return null;
  if (doc.expiresAt && doc.expiresAt < Date.now()) return null;
  return doc;
}

// Subscribe to live updates. Three redundant channels:
//   1. BroadcastChannel — same-origin tabs, near-instant.
//   2. window 'storage' event — cross-tab fallback (BC unavailable).
//   3. setInterval(1s) — final belt-and-braces (covers reloads etc.).
// All three re-read from localStorage; payload is never trusted directly.
//
// Returns an unsubscribe function. Always fires `cb(run | null)` once
// immediately so the consumer doesn't have to special-case the first read.
export function subscribe(runId, shareToken, cb) {
  let alive = true;
  let bc = null;
  let pollTimer = null;
  let lastUpdatedAt = -1;

  const refresh = () => {
    if (!alive) return;
    getRun(runId, shareToken).then(run => {
      if (!alive) return;
      const u = run ? run.updatedAt || 0 : -1;
      if (u !== lastUpdatedAt) {
        lastUpdatedAt = u;
        try { cb(run); } catch (e) { console.warn('[share] subscribe cb threw', e); }
      }
    });
  };

  // 1. BroadcastChannel
  try {
    bc = new BroadcastChannel('trail-share-' + runId);
    bc.onmessage = () => refresh();
  } catch {}

  // 2. storage event
  const onStorage = (e) => { if (e.key === RUN_KEY) refresh(); };
  window.addEventListener('storage', onStorage);

  // 3. Polling fallback (1 s).
  pollTimer = setInterval(refresh, 1000);

  // Fire once.
  refresh();

  return function unsubscribe() {
    alive = false;
    if (bc) { try { bc.close(); } catch {} bc = null; }
    window.removeEventListener('storage', onStorage);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };
}
