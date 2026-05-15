// Tiny utility for generating directions deep-links to Google Maps and
// Apple Maps. Used by the CP action-sheet on the share view so crew can
// tap a checkpoint and hand off to their preferred mapping app for
// turn-by-turn driving directions.
//
// Both URL formats route to the destination from the device's current
// location (the mapping app handles "where am I" via the OS — our app
// never touches the crew member's GPS).

function fixed6(n) {
  // Trim to 6 decimal places (~11 cm precision) — plenty for driving.
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(6) : '0';
}

// Google Maps URL (universal: web on desktop, native app on Android/iOS
// when installed). `travelmode=driving` is explicit since Google sometimes
// defaults to walking on mobile web.
export function googleMapsDir(lat, lon /*, label */) {
  return `https://www.google.com/maps/dir/?api=1&destination=${fixed6(lat)},${fixed6(lon)}&travelmode=driving`;
}

// Apple Maps URL (deep-links to native Maps.app on iOS / macOS;
// falls back to maps.apple.com web on other platforms — they get told
// "Apple Maps requires iOS/macOS" but the link still resolves).
// `dirflg=d` = driving directions.
export function appleMapsDir(lat, lon /*, label */) {
  return `https://maps.apple.com/?daddr=${fixed6(lat)},${fixed6(lon)}&dirflg=d`;
}

// Heuristic for which button to highlight as "primary" on the action
// sheet. Both are always shown — this just chooses the visual default.
// Phase 1 doesn't use this (both buttons rendered equally); Phase 6 may.
export function platformPrefersApple() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod|Macintosh/.test(ua);
}
