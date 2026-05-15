// Minetti et al. 2002 — energy cost of running on incline.
// C(i) = 155.4 i^5 - 30.4 i^4 - 43.3 i^3 + 46.3 i^2 + 19.5 i + 3.6  (J/kg/m)
// where i is gradient as a decimal (0.10 = 10% uphill).
// Reference: J Appl Physiol 93:1039-1046, 2002. Polynomial fit valid roughly -0.45 to +0.45.

const C0 = 3.6;

export function costOfRunning(gradePct) {
  const i = Math.max(-0.45, Math.min(0.45, gradePct / 100));
  return (
    155.4 * i ** 5
    - 30.4 * i ** 4
    - 43.3 * i ** 3
    + 46.3 * i ** 2
    + 19.5 * i
    + 3.6
  );
}

// "Effort" is a multiplier on uphill running fitness vs. pure Minetti.
// 1.0 = standard Minetti, 1.2 = 20% less time penalty on climbs, 0.8 = 20% more.
// Only positive gradients are affected (you can't really push the descents).
export function paceFromGap(gapSecPerKm, gradePct, uphillEffort = 1) {
  const cost = costOfRunning(gradePct);
  const adjusted = gradePct > 0 ? cost / uphillEffort : cost;
  return gapSecPerKm * (adjusted / C0);
}

export function gapFromPace(paceSecPerKm, gradePct, uphillEffort = 1) {
  const cost = costOfRunning(gradePct);
  const adjusted = gradePct > 0 ? cost / uphillEffort : cost;
  return paceSecPerKm * (C0 / adjusted);
}

export function _selfTest() {
  const eq = (a, b, tol = 0.5) => Math.abs(a - b) < tol;
  const cases = [
    [paceFromGap(420, 0), 420, 'flat round-trip'],
    [gapFromPace(420, 0), 420, 'gap == pace at 0%'],
    [paceFromGap(420, 10) > 420, true, '10% climb is slower'],
    [paceFromGap(420, -10) < 420, true, '10% descent is faster'],
    [paceFromGap(420, 10, 1.2) < paceFromGap(420, 10, 1), true, 'higher effort = less climb penalty'],
    [paceFromGap(420, -10, 1.2) === paceFromGap(420, -10, 1), true, 'effort has no descent effect'],
  ];
  const failures = cases.filter(([a, b]) => (typeof b === 'boolean' ? a !== b : !eq(a, b)));
  if (failures.length) console.warn('[minetti] self-test failures', failures);
  else console.log('[minetti] self-test passed');
}
