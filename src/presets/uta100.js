// UTA100 by UTMB — 2026 race-alignment checkpoints + waypoints (name + km only).
// stoppageSec is an estimate; color is the dot/label tint used across the map, 3D and charts.
//   blue   #58a6ff  — crewed checkpoint
//   purple #a371f7  — drop-bag checkpoint
//   teal   #5fa8d3  — water / aid waypoint
//   amber  #ffd166  — marker / POI (no stop)
// dropbag = { gels: { [gelTypeId]: count }, fluidL (litres of carb fluid),
//             waterL (litres water), notes (auto-generated, editable), autoRestock (bool) }
// Default gel-type ids 'g1' = primary, 'g2' = caffeine. Drop-bag amounts seeded from
// the 2025 spreadsheet's Summary tab.
export const UTA100_CHECKPOINTS = [
  { id: 'CP1', name: 'Tarros',                              km: 13.8, stoppageSec:  60, color: '#58a6ff', notes: 'First crewed CP — refill fluids',
    dropbag: { gels: { g1: 0, g2: 0 }, fluidL: 0.7, waterL: 0, notes: '70g Trail Brew sachet refill', autoRestock: false } },
  { id: 'CP2', name: 'Foggy Knob',                          km: 23.8, stoppageSec:  90, color: '#58a6ff', notes: 'Refill fluids',
    dropbag: { gels: { g1: 0, g2: 0 }, fluidL: 1.2, waterL: 0, notes: '2x 60g Trail Brew sachets', autoRestock: false } },
  { id: 'WP1', name: 'Ironpot Turn Around',                 km: 26.3, stoppageSec:  30, color: '#5fa8d3', notes: 'Turnaround marker',
    dropbag: { gels: { g1: 0, g2: 0 }, fluidL: 0, waterL: 0, notes: '', autoRestock: false } },
  { id: 'CP3', name: 'Six Foot Track',                      km: 37.3, stoppageSec: 180, color: '#a371f7', notes: 'Drop bag — pre-mix, gels, treats',
    dropbag: { gels: { g1: 3, g2: 0 }, fluidL: 1.0, waterL: 0, notes: '1L pre-mix bottle, Staminade sachet, Cramp Fix', autoRestock: false } },
  { id: 'WP2', name: 'Six Foot Track Start',                km: 42.6, stoppageSec:  30, color: '#5fa8d3', notes: 'Water point at Six Foot Track entry',
    dropbag: { gels: { g1: 0, g2: 0 }, fluidL: 0, waterL: 0, notes: '', autoRestock: false } },
  { id: 'WP3', name: 'Six Foot Track (Return) Water Point', km: 45.7, stoppageSec:  30, color: '#5fa8d3', notes: 'Water if needed',
    dropbag: { gels: { g1: 0, g2: 0 }, fluidL: 0, waterL: 0, notes: '', autoRestock: false } },
  { id: 'CP4', name: 'Katoomba Aquatic Centre',             km: 56.2, stoppageSec: 240, color: '#a371f7', notes: 'Drop bag — pre-mix, gels, caffeine',
    dropbag: { gels: { g1: 4, g2: 1 }, fluidL: 1.0, waterL: 0, notes: '1L pre-mix bottle (200g), treats, Staminade, Cramp Fix', autoRestock: false } },
  { id: 'CP5', name: 'Fairmont Resort',                     km: 68.3, stoppageSec:  60, color: '#58a6ff', notes: 'Refill, snacks if needed',
    dropbag: { gels: { g1: 0, g2: 0 }, fluidL: 0, waterL: 0, notes: '', autoRestock: false } },
  { id: 'CP6', name: 'Queen Victoria Hospital',             km: 79.3, stoppageSec: 240, color: '#a371f7', notes: 'Drop bag — pre-mix, gels, caffeine',
    dropbag: { gels: { g1: 4, g2: 1 }, fluidL: 1.0, waterL: 0, notes: '1L pre-mix bottle (170g), treats, Staminade, Cramp Fix', autoRestock: false } },
  { id: 'WP4', name: 'Emergency Aid Station',               km: 92.5, stoppageSec:  30, color: '#5fa8d3', notes: 'Water if needed',
    dropbag: { gels: { g1: 0, g2: 0 }, fluidL: 0, waterL: 0, notes: '', autoRestock: false } },
  { id: 'MK1', name: 'Base of Furber Steps',                km: 100.2, stoppageSec: 0,  color: '#ffd166', notes: 'Marker — final climb to the finish',
    dropbag: { gels: { g1: 0, g2: 0 }, fluidL: 0, waterL: 0, notes: '', autoRestock: false } },
];

export const UTA100_FINISH_KM = 101.3;
export const UTA100_DEFAULTS = {
  raceStart: '06:25:00',
  goalTime: '13:02:10',
};
