// Share store factory. Re-exports the active store implementation so the
// rest of the share feature stays impl-agnostic.
//
// Phase 1-4: storeLocal (BroadcastChannel + localStorage).
// Phase 5:   flip the line below to storeFirebase. No other call sites change.

import * as localStore from './storeLocal.js?v=v34';
// import * as firebaseStore from './storeFirebase.js?v=v28';   // Phase 5

export const store = localStore;
export const {
  RUN_KEY,
  SELF_KEY,
  genRunId,
  genToken,
  loadShareSelf,
  saveShareSelf,
  clearShareSelf,
  createRun,
  updateRun,
  pushLive,
  getRun,
  subscribe,
} = localStore;
