// V4-namespaced keys so V4 work never overwrites the locked V3 plan saved at port 8094
// (or V2 at 8093, V1 at 8092). All four versions can run side-by-side, each owning its
// own slice of localStorage.
const KEY_PLAN = 'trail-planner-v4-plan';
const KEY_TASKS = 'trail-planner-v4-tasks';
const KEY_HISTORY = 'trail-planner-v4-history';
const KEY_COLLAPSED = 'trail-planner-v4-collapsed';
const KEY_THEME = 'trail-planner-v4-theme';
const KEY_PANEL_ORDER = 'trail-planner-v4-panel-order';

const HISTORY_LIMIT_PER_FILE = 30;

// Exported so the share feature can hand a current snapshot to the share
// store adapter without round-tripping through localStorage.
export function snapshot(s) {
  const nu = s.nutrition || {};
  const inv = nu.startInventory || {};
  const gelTypes = (Array.isArray(nu.gelTypes) ? nu.gelTypes : []).map(t => ({
    id: String(t.id || ''),
    name: t.name || '',
    sizeG: Number(t.sizeG) || 25,
  }));
  const sanitiseGels = (raw) => {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const out = {};
    for (const t of gelTypes) out[t.id] = Number(src[t.id]) || 0;
    return out;
  };
  // V3 v8: priorRun (slim trackpoints + derived per-segment arrays) and
  // showPriorOverlay toggles. We stride-downsample to ~5000 trackpoints before
  // persisting (Garmin traces at 1 Hz are 30-50k points and would push past
  // Chrome's 5 MB localStorage quota). 5000 points across 100 km gives ~20 m
  // spacing — linear interpolation between them at running pace introduces
  // sub-5-second error per segment boundary, which is well below the noise
  // floor of GPS timestamps anyway.
  const PRIOR_PERSIST_LIMIT = 5000;
  const pr = s.priorRun;
  let priorRunSlim = null;
  if (pr && Array.isArray(pr.trackpoints) && pr.trackpoints.length) {
    const tp = pr.trackpoints;
    const stride = Math.max(1, Math.ceil(tp.length / PRIOR_PERSIST_LIMIT));
    const downsampled = [];
    for (let i = 0; i < tp.length; i += stride) downsampled.push(tp[i]);
    // Always include the very last trackpoint so totalDistanceKm/totalSec stay accurate.
    if (downsampled[downsampled.length - 1] !== tp[tp.length - 1]) downsampled.push(tp[tp.length - 1]);
    priorRunSlim = {
      name: pr.name || 'prior',
      source: pr.source || 'fit',
      totalDistanceKm: Number(pr.totalDistanceKm) || 0,
      totalSec: Number(pr.totalSec) || 0,
      totalMovingTime: Number(pr.totalMovingTime) || Number(pr.totalSec) || 0,
      totalElapsedTime: Number(pr.totalElapsedTime) || Number(pr.totalSec) || 0,
      totalStoppedTime: Number(pr.totalStoppedTime) || 0,
      trackpoints: downsampled.map(t => ({
        lat: t.lat, lon: t.lon, eleM: t.eleM,
        timeSec: t.timeSec, cumDistKm: t.cumDistKm,
        hrBpm: t.hrBpm ?? null,
        speedMs: t.speedMs ?? null,
      })),
      priorSegPaces: Array.isArray(pr.priorSegPaces) ? pr.priorSegPaces.slice() : [],
      priorSegPaceDeltas: Array.isArray(pr.priorSegPaceDeltas) ? pr.priorSegPaceDeltas.slice() : [],
      priorCumAvgPaces: Array.isArray(pr.priorCumAvgPaces) ? pr.priorCumAvgPaces.slice() : [],
      priorSegHR: Array.isArray(pr.priorSegHR) ? pr.priorSegHR.slice() : [],
      priorSegGrade: Array.isArray(pr.priorSegGrade) ? pr.priorSegGrade.slice() : [],
    };
  }
  const showPriorOverlay = s.showPriorOverlay
    ? {
        segpace: !!s.showPriorOverlay.segpace,
        cumpace: !!s.showPriorOverlay.cumpace,
        elev: !!s.showPriorOverlay.elev,
        grid: !!s.showPriorOverlay.grid,
        gridHR: !!s.showPriorOverlay.gridHR,
        segpaceHR: !!s.showPriorOverlay.segpaceHR,
        cumpaceHR: !!s.showPriorOverlay.cumpaceHR,
      }
    : { segpace: false, cumpace: false, elev: false, grid: false, gridHR: false, segpaceHR: false, cumpaceHR: false };
  return {
    version: 8,
    cpLabelFields: { ...(s.cpLabelFields || {}) },
    gpxName: s.gpx?.name,
    gpxText: s.gpxText,
    splitKm: s.splitKm,
    raceStart: s.raceStart,
    raceDate: s.raceDate || '',
    goal: { ...s.goal },
    overrides: s.overrides.map(o => ({ idx: o.idx, gapSecPerKm: o.gapSecPerKm, mode: o.mode || 'anchor' })),
    gradientPaceOverrides: { ...(s.gradientPaceOverrides || {}) },
    technicalGradientPaceOverrides: { ...(s.technicalGradientPaceOverrides || {}) },
    technicalIndices: [...(s.technicalIndices || [])],
    technicalSlowdown: s.technicalSlowdown || 1.2,
    checkpoints: s.checkpoints.map(c => {
      const db = c.dropbag || {};
      return {
        id: c.id, name: c.name, km: c.km,
        stoppageSec: c.stoppageSec || 0,
        color: c.color, notes: c.notes, _uid: c._uid,
        dropbag: {
          gels: sanitiseGels(db.gels),
          fluidL: Number(db.fluidL) || 0,
          waterL: Number(db.waterL) || 0,
          notes: db.notes || '',
          autoRestock: !!db.autoRestock,
          autoAdjust: !!db.autoAdjust,
          manualEdit: !!db.manualEdit,
        },
      };
    }),
    splitBias: s.splitBias || 0,
    uphillEffort: s.uphillEffort || 1.0,
    nutrition: {
      gelGPerHr: Number(nu.gelGPerHr) || 40,
      fluidGPerHr: Number(nu.fluidGPerHr) || 50,
      fluidLPerHr: Number(nu.fluidLPerHr) || 0.5,
      gelTypes,
      startInventory: {
        gels: sanitiseGels(inv.gels),
        fluidL: Number(inv.fluidL) || 0,
        waterL: Number(inv.waterL) || 0,
        notes: inv.notes || '',
        autoRestock: !!inv.autoRestock,
        autoAdjust: !!inv.autoAdjust,
        manualEdit: !!inv.manualEdit,
      },
    },
    priorRun: priorRunSlim,
    showPriorOverlay,
    // V3 scenarios + per-segment match-prior state. Stored under v8 (no
    // version bump — additive fields, older snapshots default cleanly).
    // Build per-scenario state. The ACTIVE scenario's edit slots get the live
    // working values (s.overrides etc) since those are the canonical
    // authoritative copy until the next setActiveScenario swaps them out.
    scenarios: (() => {
      const activeKey = ['A', 'B', 'C', 'prior'].includes(s.activeScenario) ? s.activeScenario : 'A';
      const out = {};
      for (const k of ['A', 'B', 'C', 'prior']) {
        const raw = s.scenarios?.[k] || {};
        const useLive = k === activeKey;
        out[k] = {
          name: raw.name || (k === 'prior' ? 'Prior race' : 'Plan ' + k),
          mode: ['time', 'pace', 'gap'].includes(raw.mode) ? raw.mode : 'time',
          timeSec: Number(raw.timeSec) || 0,
          paceSecPerKm: Number(raw.paceSecPerKm) || 0,
          gapSecPerKm: Number(raw.gapSecPerKm) || 0,
          overrides: (useLive ? (s.overrides || []) : (raw.overrides || []))
            .map(o => ({
              idx: Number(o.idx), gapSecPerKm: Number(o.gapSecPerKm),
              mode: o.mode === 'anchor' ? 'anchor' : 'point',
            })).filter(o => Number.isFinite(o.idx) && Number.isFinite(o.gapSecPerKm)),
          gradientPaceOverrides: { ...(useLive ? s.gradientPaceOverrides : raw.gradientPaceOverrides) || {} },
          technicalGradientPaceOverrides: { ...(useLive ? s.technicalGradientPaceOverrides : raw.technicalGradientPaceOverrides) || {} },
          technicalIndices: [...((useLive ? s.technicalIndices : raw.technicalIndices) || [])].filter(i => Number.isFinite(i)),
          priorMatchedIndices: [...((useLive ? s.priorMatchedIndices : raw.priorMatchedIndices) || [])].filter(i => Number.isFinite(i)),
          // Per-CP stopping times — for the active scenario, take from live
          // checkpoints (s.checkpoints[*].stoppageSec) so we always persist
          // the user's latest values. For other scenarios, keep the saved map.
          cpStops: useLive
            ? Object.fromEntries((s.checkpoints || []).filter(c => c._uid).map(c => [c._uid, Math.max(0, Math.round(c.stoppageSec || 0))]))
            : { ...(raw.cpStops || {}) },
          // V4 v4.2: per-scenario pace shift. For the active scenario,
          // pull from s.paceShift; for inactive, keep the saved value.
          paceShift: (() => {
            const src = useLive ? s.paceShift : raw.paceShift;
            const mode = src && ['gap','percent','seconds'].includes(src.mode) ? src.mode : 'gap';
            const value = src && Number.isFinite(Number(src.value)) ? Number(src.value) : 0;
            return { mode, value };
          })(),
        };
      }
      return out;
    })(),
    activeScenario: ['A', 'B', 'C', 'prior'].includes(s.activeScenario) ? s.activeScenario : 'A',
    priorMatchedIndices: Array.isArray(s.priorMatchedIndices)
      ? s.priorMatchedIndices.filter(i => Number.isFinite(i) && i >= 0)
      : [],
    // V4 Phase 2: spectator points (additive field on snapshot v8 —
    // older snapshots default to []).
    spectatorPoints: Array.isArray(s.spectatorPoints) ? s.spectatorPoints.map(sp => ({
      id: String(sp.id || ''),
      name: String(sp.name || 'Spectator point'),
      lat: Number(sp.lat),
      lon: Number(sp.lon),
      km: Number(sp.km) || null,
      color: String(sp.color || '#a371f7'),
      notes: String(sp.notes || ''),
      address: String(sp.address || ''),
      accessNotes: String(sp.accessNotes || ''),
    })).filter(sp => Number.isFinite(sp.lat) && Number.isFinite(sp.lon)) : [],
  };
}

// === Current plan persistence ===

export function saveLocal(s) {
  try {
    if (!s.gpxText) return;
    localStorage.setItem(KEY_PLAN, JSON.stringify(snapshot(s)));
  } catch (e) { console.warn('saveLocal failed', e); }
}

export function loadLocal() {
  try {
    const raw = localStorage.getItem(KEY_PLAN);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { console.warn('loadLocal failed', e); return null; }
}

export function clearLocal() { localStorage.removeItem(KEY_PLAN); }

// === Version history (per GPX file) ===

export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEY_HISTORY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch { return []; }
}

export function saveHistory(history) {
  try { localStorage.setItem(KEY_HISTORY, JSON.stringify(history)); } catch {}
}

export function pushHistory(s, label) {
  if (!s.gpxText) return null;
  const history = loadHistory();
  const entry = {
    id: Date.now(),
    savedAt: new Date().toISOString(),
    label: label || `Auto-saved ${new Date().toLocaleString()}`,
    gpxName: s.gpx?.name || 'unknown',
    finishETA: s.finishETA,
    snap: snapshot(s),
  };
  // Insert at front; trim per-file to limit.
  history.unshift(entry);
  const perFile = {};
  const kept = [];
  for (const e of history) {
    perFile[e.gpxName] = (perFile[e.gpxName] || 0) + 1;
    if (perFile[e.gpxName] <= HISTORY_LIMIT_PER_FILE) kept.push(e);
  }
  saveHistory(kept);
  return entry;
}

export function deleteHistoryEntry(id) {
  const history = loadHistory().filter(e => e.id !== id);
  saveHistory(history);
}

// === Tasks (feature requests) ===

const SEED_TASKS = [
  // v1.0
  { id: 1, text: 'Drag-and-drop GPX onto empty state', done: true },
  { id: 2, text: 'Light/dark theme toggle', done: true },
  { id: 3, text: 'Negative/positive split slider', done: true },
  { id: 4, text: 'Uphill effort slider', done: true },
  { id: 5, text: 'Hover anywhere on map → snap to nearest route', done: true },
  { id: 6, text: 'Time/pace inputs accept formats without colons', done: true },
  { id: 7, text: 'Editable Pace column in segment grid', done: true },
  { id: 8, text: 'Stoppage time per checkpoint with ETA propagation', done: true },
  { id: 9, text: 'Bound chart x-axes to total race distance', done: true },
  { id: 10, text: 'ETA chart: full checkpoint name labels', done: true },
  { id: 11, text: 'Improved elevation gain accuracy (Strava-comparable)', done: true },
  { id: 12, text: '3D route profile (VeloViewer-style fill)', done: true },
  { id: 13, text: 'CP heading rows in segment grid', done: true },
  { id: 14, text: 'Hover sync from cumpace + ETA charts', done: true },
  { id: 15, text: 'Collapsible panels', done: true },
  { id: 16, text: 'All charts full-width (stacked layout)', done: true },
  { id: 17, text: 'Faint grey outline on editable cells', done: true },
  { id: 18, text: 'Cumpace: 30s y-ticks · 5km x-ticks · faint elevation background', done: true },
  { id: 19, text: 'Software updates dropdown', done: true },
  { id: 20, text: 'Per-file version history dropdown', done: true },
  // v1.3
  { id: 21, text: 'Pace-by-gradient table (1% increments, editable)', done: true },
  { id: 22, text: 'Map type switcher (Street / Topo / Satellite / Hybrid)', done: true },
  { id: 23, text: 'Cumpace data-label toggles (per-km + 5km cumulative) + CP markers', done: true },
  { id: 24, text: 'Editable Cum + ETA cells in per-segment grid', done: true },
  { id: 25, text: 'Override modes — Anchor (interpolate) vs Point (single segment)', done: true },
  { id: 26, text: 'Up/down spinner buttons on goal time/pace/GAP/split size', done: true },
  { id: 27, text: 'Undo / Redo (buttons + Ctrl+Z / Ctrl+Y)', done: true },
  { id: 28, text: 'Edit-conflict alert in Goal panel when overrides exist', done: true },
  { id: 29, text: 'Implicit boundary anchors (single anchor → smooth tent, not full pin)', done: true },
  { id: 30, text: '3D: pan + checkpoints rendered + hover info overlay', done: true },
  { id: 31, text: 'Round Finish CP km to 0.1', done: true },
  { id: 32, text: 'Right-aligned grid headings · more obvious dropdown chevrons', done: true },
  // v1.4
  { id: 33, text: 'Per-segment grid: heading + input columns aligned to right edge', done: true },
  { id: 34, text: 'Cumpace data labels: light-mode contrast + visual separation per line', done: true },
  { id: 35, text: '3D: LEFT-click pan + raycasting hover on the route mesh', done: true },
  { id: 36, text: 'Pace-by-gradient: incline first · default collapsed', done: true },
  { id: 37, text: 'Auto-append shipped features to this list (seed + merge)', done: true },
  // v1.5
  { id: 38, text: 'Smart time parsing (05 = 5 min, 0533 = 5:33, 130210 = 13:02:10)', done: true },
  { id: 39, text: 'FIN km auto-rounded to 0.1 on restore + manual edit', done: true },
  { id: 40, text: 'Editable checkpoint codes (CP1, WP1, etc.)', done: true },
  { id: 41, text: 'Editable arrive/depart times in checkpoint table', done: true },
  { id: 42, text: 'Stop input right-aligned + stop time shown in CP heading rows', done: true },
  { id: 43, text: 'Per-segment Cum column now includes cumulative stoppage', done: true },
  { id: 44, text: 'Per-segment grid: removed CP column (covered by heading rows)', done: true },
  { id: 45, text: 'Default new edit mode = Point (no propagation)', done: true },
  { id: 46, text: 'Pace by gradient: ±0.5% bucket + implied GAP shown per row', done: true },
  { id: 47, text: 'Technical-difficulty slider + per-segment checkbox', done: true },
  { id: 48, text: '3D: zoom-to-cursor + floating HTML CP labels (CSS2DRenderer)', done: true },
  { id: 49, text: '3D Google-Maps-style satellite map (would require MapLibre GL switch)', done: false },
  // v1.6
  { id: 50, text: 'Per-segment grid: Enter / Shift+Enter to navigate vertically', done: true },
  { id: 51, text: 'Editable CP code without losing focus on each keystroke', done: true },
  { id: 52, text: '3D + map labels include distance + ETA', done: true },
  { id: 53, text: 'Map: permanent CP labels with name, distance, ETA', done: true },
  { id: 54, text: 'Cumulative pace split into a separate panel from per-segment pace', done: true },
  { id: 55, text: 'Cumulative pace chart: optional GAP overlay (toggle)', done: true },
  { id: 56, text: 'Reverse y-axis on ETA-over-time chart', done: true },
  { id: 57, text: '3D label cleanup fix (no duplicates after re-render)', done: true },
  { id: 58, text: 'Editable stopping time in CP heading rows of segment grid', done: true },
  { id: 59, text: '"Tech" column renamed to "Technical"', done: true },
  { id: 60, text: 'Technical override pace column in pace-by-gradient', done: true },
  { id: 61, text: 'Removed "Minetti" terminology — column reads "GAP-derived pace"', done: true },
  { id: 62, text: 'Color picker on each CP code; colors flow to map dots, 3D, charts, grid', done: true },
  // v1.7
  { id: 63, text: 'Insert checkpoint button between rows (+ at midpoint km)', done: true },
  { id: 64, text: 'Collapse-all / Expand-all panel buttons in header', done: true },
  { id: 65, text: 'Per-segment column heading: "#" → "Segment"', done: true },
  { id: 66, text: 'Elevation profile: 5km x-axis ticks + checkpoint markers', done: true },
  { id: 67, text: 'Pace-by-gradient: implied GAP next to each pace cell (regular + technical)', done: true },
  { id: 68, text: 'Per-trackpoint Minetti integration (replace single-segment-avg-grade model)', done: false },
  { id: 69, text: 'MapLibre GL switch for 3D-tilted satellite basemap', done: false },
  // v1.8
  { id: 70, text: 'Insert-CP button reduced to a subtle "+" on the row divider (no text)', done: true },
  { id: 71, text: 'Per-CP label field toggles (code · name · km · ETA) for both map and 3D', done: true },
  { id: 72, text: 'Map permanent labels use the toggle system; default = code+km+ETA (less crowded)', done: true },
  { id: 73, text: 'Per-segment CP heading + segment row tint match the chosen CP color (low-alpha)', done: true },
  { id: 74, text: 'Left-stripe accent on CP-tagged segments matches CP color', done: true },
  { id: 75, text: 'Expand/Collapse-all buttons replaced with bold + / − symbols', done: true },
  // v1.9
  { id: 76, text: 'Insert + and Add Checkpoint create blank rows (no km until user fills in)', done: true },
  { id: 77, text: 'Blank CPs sort to the end so existing rows do not shuffle on insert', done: true },
  { id: 78, text: 'CP color applies to both heading row and segment row uniformly (no blue default)', done: true },
  // v1.10
  { id: 79, text: 'Unique UIDs (timestamp+random) so reloading never collides keys → checkpoints table never silently empties', done: true },
  { id: 80, text: 'normaliseCheckpoints heals duplicate UIDs on JSON import / autosave restore', done: true },
  { id: 81, text: '2026 UTA100 preset: Tarros · Foggy Knob · Ironpot Turn Around · Six Foot Track · WP entries · Katoomba Aquatic Centre · Fairmont Resort · Queen Victoria Hospital · Emergency Aid · Base of Furber Steps · Finish', done: true },
  // v1.11
  { id: 82, text: 'Auto-save current plan to History before destructive actions (preset / reset / restore / migration)', done: true },
  { id: 83, text: '2026 preset auto-migration on first load when old Medlow-Gap state is detected', done: true },
  // v1.12
  { id: 84, text: 'ETA chart: stack overlapping CP labels into vertical lanes with leader lines', done: true },
  { id: 85, text: 'Map: rotate CP label directions (right/left/top/bottom) so adjacent labels do not stack', done: true },
  // V2 v2.0 — nutrition tracking
  { id: 86, text: 'Nutrition: fluid g/hr + gel g/hr + gel size inputs; derived gel interval and total gels needed', done: true },
  { id: 87, text: 'Nutrition: per-segment cumulative carbs, toggleable column in segment grid', done: true },
  { id: 88, text: 'Nutrition: drop-bag plan per CP (gels, caff gels, fluid g, notes) with start inventory and shortfall warning', done: true },
  { id: 89, text: 'Storage v5 → v6: adds nutrition block + cp.dropbag; defaults populate on load', done: true },
  // V2 v2.1 — nutrition redesign
  { id: 90, text: 'Charts: resolve --fg-dim CSS variable so axis text is visible in dark theme', done: true },
  { id: 91, text: 'Nutrition: full-width column alignment via colgroup + table-layout fixed', done: true },
  { id: 92, text: 'Nutrition: Enter / arrow-key cell navigation in inputs grid and drop-bag table', done: true },
  { id: 93, text: 'Nutrition: per-CP Carbs Restocked target (next-leg duration × target g/hr)', done: true },
  { id: 94, text: 'Nutrition: configurable gel types (primary + caffeine + custom), each with own size', done: true },
  { id: 95, text: 'Nutrition: per-CP auto-restock checkbox auto-fills primary gel + primary fluid for next leg', done: true },
  { id: 96, text: 'Nutrition: drop-bag fluid in litres + water-only column + auto-generated editable notes', done: true },
  { id: 97, text: 'Per-segment grid: toggleable # gels and fluid L cumulative columns; CP heading row aligns restock numbers', done: true },
  { id: 98, text: 'Pace by gradient: GAP / Technical GAP grouping headers above the table with current values', done: true },
  { id: 99, text: 'Checkpoints: colour swatch palette of already-used colours next to the system colour picker', done: true },
  { id: 100, text: 'Storage v6 → v7: gelTypes array, fluidL, waterL, autoRestock, primaryFluidGPerL', done: true },
  // V3 v3.0 — prior-run comparison overlay
  { id: 101, text: 'V3: .fit / .gpx prior-run upload + segpace + cumpace + elevation overlay (toggleable)', done: true },
  { id: 102, text: 'V3: Per-segment grid prior-pace column with green/red tint (faster vs slower than plan)', done: true },
  { id: 103, text: 'V3: Storage v7 → v8 — priorRun block (slim trackpoints + derived per-segment arrays) + showPriorOverlay toggles', done: true },
  // V3 v3.1 — UI polish + match-prior + scenarios
  { id: 104, text: 'V3: Panel headings left-aligned (drag handle + title hug the left edge)', done: true },
  { id: 105, text: 'V3: Per-segment grid — prior pace column moved adjacent to the pace column', done: true },
  { id: 106, text: 'V3: Per-row ≈ Match-prior button + Match-all / Clear-matches in panel header (sets pace override = prior)', done: true },
  { id: 107, text: 'V3: Goal & biases — Scenarios picker (Plan A / Plan B / Prior race) with active-row radio driving the model', done: true },
  // V4 v4.0 — Spectator / Crew Share View
  { id: 108, text: 'V4: Spectator/Crew share view (Phase 1) — read-only share link with map (Google/Apple Maps directions per CP), simplified nutrition handover table, ETAs with "vs last year" deltas. Local-first store adapter (BroadcastChannel + localStorage) so Phases 2-5 swap in without changing call sites.', done: true },
  // V4 v4.1 — Share view view-options + spectator points + standalone export
  { id: 109, text: 'V4: Share view 24h ↔ AM/PM clock toggle + per-viewer label toggles (code/name/km/ETA) on map markers + Hide spectator points toggle. Prefs persisted per-viewer.', done: true },
  { id: 110, text: 'V4: Spectator points (Phase 2) — planner panel for lat/lon-driven viewpoints, snap-to-km, ETA in planner row, diamond markers on share map, interleaved into share ETA list.', done: true },
  { id: 111, text: 'V4: Standalone HTML export — single self-contained .html file with plan baked in. Modules bundled via data-URI importmap. Crew open the file on PC or phone without the planner server.', done: true },
  // V4 v4.2 — Share-map hover, dark mode, plan match-A, per-km pace shift
  { id: 112, text: 'V4: Share-view map hover overlay (km + ETA + pace) on mousemove + tap. Tile switcher restored (Street / Topo / Satellite / Hybrid) so crew can pick a basemap.', done: true },
  { id: 113, text: 'V4: Share view dark/light theme toggle in header. Per-viewer preference persisted; CSS-vars driven so the standalone export honours the choice too.', done: true },
  { id: 114, text: 'V4: Plan B / Plan C "≈A" button — copies Plan A\'s per-segment edits + gradient overrides + technical flags + pace shift in one click. Forks A as a starting point.', done: true },
  { id: 115, text: 'V4: Per-scenario pace shift (GAP / per-km %% / per-km sec). Percent + seconds modes apply to every segment uniformly (overrides included) so the whole plan moves without resetting edits.', done: true },
  // V4 v4.3 — share-view extras
  { id: 116, text: 'V4: Share view scenario picker (Plan A / B / C / Prior Race). Crew can flip plans without the runner re-publishing. Share doc now ships all scenarios slim.', done: true },
  { id: 117, text: 'V4: Share view read-only chart panels — elevation, ETA over time, per-segment pace, cumulative pace, 3D route profile. Collapsed by default; re-render on scenario switch.', done: true },
  { id: 118, text: 'V4: Per-segment plan grid — "pace incl. stop" toggle column (single-column variant of elapsed pace).', done: true },
  { id: 119, text: 'V4: Share-view map tooltips theme-aware (dark-on-light in light mode; pace-shift input widened so negative + multi-digit values fit).', done: true },
  // V4 v4.4 — share-view polish
  { id: 120, text: 'V4: Removed ETA-over-time chart from spectator view (redundant with ETA list + per-segment pace).', done: true },
  { id: 121, text: 'V4: Cross-chart hover sync across share-view map + elevation + per-seg + cumulative + 3D (orange-dot tracker like the planner).', done: true },
  { id: 122, text: 'V4: 3D route profile in share view uses code-only label resolver — no km/ETA on the pole so labels stop stacking on top of each other.', done: true },
  // V4 v4.5 — mobile compat + ergonomics
  { id: 123, text: 'V4: Standalone HTML mobile compat — added es-module-shims polyfill so importmap + data-URI modules load on older mobile Safari (pre-iOS 16.4) and Android browsers. Modern browsers skip the shim.', done: true },
  { id: 124, text: 'V4: Map drag-to-resize handle below the planner map. Drag up/down to set height; persisted to localStorage. Leaflet invalidateSize fires on drag end.', done: true },
  { id: 125, text: 'V4: Spectator points — km column is now editable. Type a km along the route and the planner snaps lat/lon to the nearest trackpoint (or enter lat/lon and km derives). Either entry path works.', done: true },
  { id: 126, text: 'V4: Share map — tap anywhere (not just a CP marker) opens a "Point on route" action sheet with Google + Apple Maps directions to that lat/lon. Marker clicks stop propagation so they only fire the CP sheet.', done: true },
  // V4 v4.6 — mobile-bulletproof standalone export
  { id: 127, text: 'V4: Standalone HTML export rewritten as a non-module IIFE registry bundle. No data-URI ES modules, no importmap, no es-module-shims. Works on any phone with a modern-ish browser (incl. in-app browsers). Alpine loaded via UMD/global build. 3D route profile excluded from standalone (Three.js is ESM-only).', done: true },
  // V4 v4.7 — hover bug fix + 3D label box + Pages deploy
  { id: 128, text: 'V4: Cross-chart hover wiring was AFTER the staticPlan early-return in shareView.init — so standalone HTML never wired the bus. Moved to top of init() so live + standalone both wire it.', done: true },
  { id: 129, text: 'V4: 3D CP labels in share view get the planner\'s "little box" styling (background + accent border + bold code). CSS inlined in share.html so it works even when styles.css is excluded (standalone export). Resolver wraps code in <strong> for the accent.', done: true },
  { id: 130, text: 'V4: Added .github/workflows/pages.yml + DEPLOY-SHARE.md — three paths for getting the crew share view onto a phone: AirDrop standalone HTML, Netlify Drop, GitHub Pages auto-deploy.', done: true },
  // V4 v4.8
  { id: 131, text: 'V4: Nutrition drop-bag notes are user-controlled only — auto-restock still fills gel/fluid numbers but no longer overwrites the notes field on every recompute.', done: true },
];

export function loadTasks() {
  let stored = null;
  try {
    const raw = localStorage.getItem(KEY_TASKS);
    if (raw) stored = JSON.parse(raw);
  } catch {}
  if (!Array.isArray(stored) || stored.length === 0) {
    return SEED_TASKS.map(t => ({ ...t }));
  }
  // Merge: append any new SEED_TASKS not already present (by id) — keeps the user's
  // own custom entries and check states intact.
  const existingIds = new Set(stored.map(t => t.id));
  const merged = [...stored];
  for (const seed of SEED_TASKS) {
    if (!existingIds.has(seed.id)) merged.push({ ...seed });
  }
  return merged;
}

export function saveTasks(tasks) {
  try { localStorage.setItem(KEY_TASKS, JSON.stringify(tasks)); } catch {}
}

// === Collapsed panel state ===

export function loadCollapsed() {
  try {
    const raw = localStorage.getItem(KEY_COLLAPSED);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

export function saveCollapsed(map) {
  try { localStorage.setItem(KEY_COLLAPSED, JSON.stringify(map)); } catch {}
}

// === Theme ===

export function loadTheme() { return localStorage.getItem(KEY_THEME) || 'dark'; }
export function saveTheme(t) { localStorage.setItem(KEY_THEME, t); }

// === Panel ordering ===
// Persists the user's drag-to-reorder choice. The How-To dropdown reads from the
// same array so its section list mirrors the visible page order.
export function loadPanelOrder() {
  try {
    const raw = localStorage.getItem(KEY_PANEL_ORDER);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}
export function savePanelOrder(arr) {
  try { localStorage.setItem(KEY_PANEL_ORDER, JSON.stringify(arr)); } catch {}
}

// === Export / Import ===

export function exportToFile(s, filename) {
  const data = snapshot(s);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || (s.gpx?.name?.replace(/[^\w-]+/g, '_') || 'trail-plan') + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

export function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { try { resolve(JSON.parse(r.result)); } catch (e) { reject(e); } };
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function readArrayBufferFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}
