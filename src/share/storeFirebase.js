// storeFirebase — Phase-5 swap-in. NOT yet implemented.
//
// When ready, this module will implement the same surface as storeLocal
// against Firebase Firestore (`runs/{runId}` doc, `onSnapshot` listener,
// Firebase Auth anonymous IDs for ownerToken validation). Until then it
// just throws — the share/index.js factory still exports storeLocal as
// the active impl, so calling this is a coding mistake.
//
// The shape of every export below must match storeLocal exactly so the
// swap is a one-line change in src/share/index.js.

function notImplemented(fn) {
  return () => {
    throw new Error(`storeFirebase.${fn} not implemented — Phase 5`);
  };
}

export const RUN_KEY = 'firebase-runs';
export const SELF_KEY = 'firebase-share-self';

export const genRunId = notImplemented('genRunId');
export const genToken = notImplemented('genToken');
export const loadShareSelf = notImplemented('loadShareSelf');
export const saveShareSelf = notImplemented('saveShareSelf');
export const clearShareSelf = notImplemented('clearShareSelf');

export const createRun = notImplemented('createRun');
export const updateRun = notImplemented('updateRun');
export const pushLive = notImplemented('pushLive');
export const getRun = notImplemented('getRun');
export const subscribe = notImplemented('subscribe');
