# Trail Pace Planner

Interactive HTML pace planner for trail/ultra races. Drop in a GPX file, set a goal time, fine-tune per-segment pace via grade-adjusted inputs, and see ETAs at every checkpoint synced across map, elevation profile, and grid views.

## Run locally

The app is plain HTML + ES modules. Modules require a real HTTP server — opening `index.html` directly via `file://` will fail.

```bash
# from this folder
python -m http.server 8000
# then visit http://localhost:8000
```

(Any static server works: `npx serve`, `php -S localhost:8000`, etc.)

## Features (v1)

- GPX upload — parses lat/lon/elevation, computes distance via Haversine, smooths elevation, derives gain/loss/gradient per segment
- Master goal toggle — set goal **time** OR **pace** OR **GAP**, the other two derive automatically using the Minetti grade-adjusted-cost model
- Per-segment grid — edit any segment's GAP to anchor it; cells between anchors interpolate linearly. Click ↺ to clear an anchor
- Map (Leaflet/OSM) + elevation profile (Chart.js, gradient-colored) + ETA chart + cumulative pace chart, all hover-synced
- Checkpoints — pre-populated with the 8 UTA100 by UTMB checkpoints (Medlow Gap, Foggy Knob, Six Foot Track, etc.), fully editable
- LocalStorage autosave + JSON export/import for backup and sharing
- Mobile-aware layout

## Deferred (later versions)

- Nutrition planning (gels, fluid carbs, calorie tracking)
- Multi-scenario comparison (Case2 / Case3)
- .fit/.gpx comparison overlay (drop a previous run on top of the plan)
- Gradient distribution histogram
- Sun/civil twilight markers on the ETA chart
- 3D route view
- Firebase cloud sync + shareable read-only spectator/crew links
- Print-friendly race-day card

## Project layout

```
Trail-Planner/
├── index.html
├── styles.css
├── README.md
├── GPX/                          # input GPX files
└── src/
    ├── app.js                    # Alpine root, top-level wiring
    ├── gpx.js                    # GPX parse + Haversine + elevation smoothing
    ├── segments.js               # split trackpoints into segments by mode
    ├── minetti.js                # cost-of-running + GAP↔pace conversion
    ├── pacePlan.js               # master toggle, override interpolation, ETA computation
    ├── checkpoints.js            # default + manual checkpoint operations
    ├── presets/uta100.js         # UTA100 checkpoint preset
    ├── map.js                    # Leaflet wrapper
    ├── elevationChart.js         # Chart.js elevation profile
    ├── etaChart.js               # distance × time-of-day chart
    ├── cumulativePaceChart.js    # cumulative + per-segment pace
    ├── sync.js                   # cross-view hover state
    └── storage.js                # localStorage + JSON import/export
```

## Deploy to Firebase Hosting

```bash
npm install -g firebase-tools
firebase login
firebase init hosting
# - Use existing project (or create one)
# - Public directory: . (this folder)
# - Single-page app: No
# - Don't overwrite index.html
firebase deploy
```

GitHub Pages also works — just push the folder to a repo and enable Pages from the root.

## Validation against UTA100

End-to-end smoke test using `GPX/2026 UTA by UTMB - 100km - RACE ALIGNMENT.gpx`:

1. Load the GPX → total distance ≈ 100 km, total gain ≈ 4500 m
2. Race start `06:25:00`, goal time `13:02:10` → finish ETA `19:27:10`, average pace ≈ 7:49/km (matches the 2025 spreadsheet)
3. UTA100 checkpoints prepopulate at the correct kilometres
4. Hover the elevation profile → marker drops on the map at the matching lat/lon and the corresponding row scrolls into view in the grid
5. Edit km 50's GAP +30 s/km → cell colors yellow, surrounding cells interpolate, total time updates
6. Export JSON, refresh browser → autosave restores the plan; importing the exported JSON also restores cleanly

## Math reference

**Minetti cost of running** (J/kg/m), gradient `i` as decimal:
```
C(i) = 155.4 i⁵ − 30.4 i⁴ − 43.3 i³ + 46.3 i² + 19.5 i + 3.6
```

Pace at gradient `i` for a target flat-equivalent (GAP) pace `p`:
```
pace(i) = p × C(i) / C(0)            with C(0) = 3.6
```

**Inverting goal time → required GAP**: since `paceFromGap(gap, grade)` is linear in `gap`,
```
totalSec = GAP × Σ distKm[i] × (C(grade[i]) / C(0))
GAP      = totalSec / Σ distKm[i] × (C(grade[i]) / C(0))
```
which is what `gapForTargetTime` does in `pacePlan.js`.

## License

MIT (or your preference — adjust before publishing).
