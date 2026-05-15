// Tiny pub/sub for the cross-view hover state. Single source of truth: hoverKm.
const listeners = new Set();
let hoverKm = null;

export function getHoverKm() { return hoverKm; }

export function setHoverKm(km) {
  if (km === hoverKm) return;
  hoverKm = km;
  for (const cb of listeners) {
    try { cb(km); } catch (e) { console.error('hover listener', e); }
  }
}

export function onHoverChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
