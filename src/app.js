import { parseGPX } from './gpx.js?v=v15';
import { buildSegments } from './segments.js';
import { _selfTest as minettiSelfTest, paceFromGap, gapFromPace, costOfRunning } from './minetti.js';
import {
  computeSegmentGaps, computeSegmentPaces, computeSegmentSeconds,
  gapForTargetTime, computeSegmentETAs,
  buildStoppageAccumulator, totalStoppageSec,
  parseHHMMSS, formatHHMMSS, parsePace, formatPace, formatTimeOfDay,
  parseStoppage, formatStoppage,
} from './pacePlan.js';
import { defaultCheckpoints, makeManualCheckpoint, normaliseCheckpoint, normaliseCheckpoints, syncDropbagsToGelTypes } from './checkpoints.js?v=v12';
import * as mapApi from './map.js';
import * as elevApi from './elevationChart.js?v=v14';
import * as etaApi from './etaChart.js?v=v14';
import * as cumApi from './cumulativePaceChart.js?v=v14';
import * as segPaceApi from './segmentPaceChart.js?v=v14';
import * as p3dApi from './profile3d.js?v=v12';
import { setHoverKm, onHoverChange } from './sync.js';
import {
  saveLocal, loadLocal, exportToFile, readJSONFile, readTextFile,
  loadTasks, saveTasks as persistTasksToStorage,
  loadHistory, pushHistory, deleteHistoryEntry,
  loadCollapsed, saveCollapsed,
  loadTheme, saveTheme,
  loadPanelOrder, savePanelOrder,
  snapshot as makeSnapshot,
} from './storage.js?v=v35';
import { loadPriorRunFile, alignPriorToSegments } from './priorRun.js?v=v17';
// === Spectator / Crew Share (V4 Phase 1) ============================
// Local-first store adapter behind a one-line swap. createRun behaves as
// "update existing" when share-self is already populated (one run per V4
// install per Jeff's preference).
import {
  createRun as shareCreateRun,
  updateRun as shareUpdateRun,
  loadShareSelf, saveShareSelf, clearShareSelf,
} from './share/index.js?v=v35';
import { filterSnapshotForShare } from './share/snapshotFilter.js?v=v35';

minettiSelfTest();

const UNDO_LIMIT = 30;
let saveTimer = null;
function debouncedSave(state) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveLocal(state), 400);
}

const roundKm = km => Math.round(km * 10) / 10;

function makeUndoSnap(s) {
  return {
    splitKm: s.splitKm,
    raceStart: s.raceStart,
    goal: { ...s.goal },
    overrides: s.overrides.map(o => ({ ...o })),
    checkpoints: s.checkpoints.map(c => ({ ...c })),
    splitBias: s.splitBias,
    uphillEffort: s.uphillEffort,
    technicalSlowdown: s.technicalSlowdown,
    technicalIndices: [...s.technicalIndices],
    gradientPaceOverrides: { ...s.gradientPaceOverrides },
    technicalGradientPaceOverrides: { ...s.technicalGradientPaceOverrides },
  };
}

function applyUndoSnap(s, snap) {
  s.splitKm = snap.splitKm;
  s.raceStart = snap.raceStart;
  s.goal = { ...snap.goal };
  s.overrides = snap.overrides.map(o => ({ ...o }));
  s.checkpoints = snap.checkpoints.map(c => ({ ...c }));
  s.splitBias = snap.splitBias;
  s.uphillEffort = snap.uphillEffort;
  s.technicalSlowdown = snap.technicalSlowdown ?? 1.2;
  s.technicalIndices = [...(snap.technicalIndices || [])];
  s.gradientPaceOverrides = { ...snap.gradientPaceOverrides };
  s.technicalGradientPaceOverrides = { ...(snap.technicalGradientPaceOverrides || {}) };
  s.goalTimeText = formatHHMMSS(s.goal.timeSec || 0);
  s.goalPaceText = formatPace(s.goal.paceSecPerKm || 0);
  s.goalGapText = formatPace(s.goal.gapSecPerKm || 0);
}

export function trailPlannerComponent() {
  return {
    // --- persisted ---
    gpx: null,
    gpxText: null,
    splitKm: 1,
    raceStart: '06:25:00',
    // Race date — used to compute sunrise/sunset/civil-twilight for the ETA
    // chart's day/night shading. Defaults to UTA 2026 (May 16). The date input
    // sits next to Race start in the shared-goal-inputs row.
    raceDate: '2026-05-16',
    goal: { mode: 'time', timeSec: 46930, paceSecPerKm: 469.3, gapSecPerKm: 469.3 },
    overrides: [],
    gradientPaceOverrides: {},
    checkpoints: [],
    splitBias: 0,
    uphillEffort: 1.0,
    technicalSlowdown: 1.2,
    technicalIndices: [],
    technicalGradientPaceOverrides: {},
    theme: 'dark',
    defaultEditMode: 'point',

    nutrition: {
      // Three direct master inputs. Concentration is derived (= fluidGPerHr / fluidLPerHr).
      gelGPerHr: 40,
      fluidGPerHr: 50,
      fluidLPerHr: 0.5,
      gelTypes: [
        { id: 'g1', name: 'Primary', sizeG: 30 },
        { id: 'g2', name: 'Caffeine', sizeG: 25 },
      ],
      startInventory: {
        gels: { g1: 5, g2: 1 },
        fluidL: 1.4,
        waterL: 0,
        notes: '2x 70g flasks + 1x 500ml electrolyte',
        autoRestock: false,
        autoAdjust: false,
        manualEdit: false,
      },
    },

    // --- mirrors ---
    goalTimeText: '13:02:10',
    goalPaceText: '7:49',
    goalGapText: '7:49',

    // --- prior-run overlay (V3 task #1) ---
    // priorRun is the parsed prior race/training run loaded via the "Load prior
    // run" header button. Slim trackpoints + derived per-segment arrays are
    // persisted in storage v8; charts re-derive on splitKm change.
    priorRun: null,
    priorRunLoading: false,
    showPriorOverlay: { segpace: false, cumpace: false, elev: false, grid: false, gridHR: false, segpaceHR: false, cumpaceHR: false },
    // Per-segment "match prior" overrides. Stores the seg.idx of every segment
    // whose pace override was set via the ≈ match-prior button (per-row or
    // bulk). Lets Clear-matches remove only prior-sourced overrides without
    // touching the user's hand-edited ones.
    priorMatchedIndices: [],

    // --- scenarios (V3 task #2) ---
    // Three rows in Goal & biases. activeScenario radios select which row
    // drives the model. A/B each store mode + time + pace + GAP so the user
    // can edit any of the three inline (mirrors the main goal inputs at top).
    // Prior is sourced from priorRun.totalSec when active. The mode field
    // tracks which value was last edited — that's the canonical driver when
    // the scenario is activated. Derived values (other two of time/pace/gap)
    // get re-synced from the recompute output for live feedback.
    // Each scenario carries its OWN per-segment edits, gradient overrides,
    // technical flags, and prior-matched indices. setActiveScenario saves the
    // outgoing scenario's edits and loads the incoming one so changes don't
    // leak across plans. The Prior scenario starts empty and auto-matches the
    // prior race per-segment paces on first activation.
    scenarios: {
      A: {
        name: 'Plan A', mode: 'time', timeSec: 46930, paceSecPerKm: 469.3, gapSecPerKm: 469.3,
        overrides: [], gradientPaceOverrides: {}, technicalGradientPaceOverrides: {},
        technicalIndices: [], priorMatchedIndices: [],
        // Per-scenario pace shift. mode 'gap' adds value sec/km to base
        // GAP (keeps overrides untouched, defaults shift). Mode 'percent'
        // multiplies every segment pace (overrides included) by
        // (1 + value/100). Mode 'seconds' adds value sec/km to every
        // segment pace (overrides included). value=0 = no shift.
        paceShift: { mode: 'gap', value: 0 },
      },
      B: {
        name: 'Plan B', mode: 'time', timeSec: 0, paceSecPerKm: 0, gapSecPerKm: 0,
        overrides: [], gradientPaceOverrides: {}, technicalGradientPaceOverrides: {},
        technicalIndices: [], priorMatchedIndices: [],
        paceShift: { mode: 'gap', value: 0 },
      },
      C: {
        name: 'Plan C', mode: 'time', timeSec: 0, paceSecPerKm: 0, gapSecPerKm: 0,
        overrides: [], gradientPaceOverrides: {}, technicalGradientPaceOverrides: {},
        technicalIndices: [], priorMatchedIndices: [],
        paceShift: { mode: 'gap', value: 0 },
      },
      prior: {
        name: 'Prior race', mode: 'time', timeSec: 0, paceSecPerKm: 0, gapSecPerKm: 0,
        overrides: [], gradientPaceOverrides: {}, technicalGradientPaceOverrides: {},
        technicalIndices: [], priorMatchedIndices: [],
        paceShift: { mode: 'gap', value: 0 },
      },
    },
    activeScenario: 'A',

    // Active scenario's paceShift, mirrored here so recompute can read it
    // synchronously. setActiveScenario syncs in/out of scenarios[key].
    paceShift: { mode: 'gap', value: 0 },

    // --- transient ---
    dragOver: false,
    showTasks: false,
    showHistory: false,
    showSegLabels: false,
    showCumLabels: false,
    showCumGAP: false,
    showCarbs: false,
    showGelsCol: false,
    showFluidLCol: false,
    showMovingPace: true,
    showElapsedPace: false,
    // V4 v4.3: standalone "pace incl. stop" column. Single column variant
    // of segElapsedPace[i] — handy when you want pace + stoppage without
    // the GAP (E) companion column.
    showPaceStop: false,
    p3dSensitivityM: 250,
    // V4 v4.5: user-resizable map. Persisted in localStorage so reload
    // keeps the chosen height. Clamped to [200, 1200] px.
    mapHeightPx: (() => {
      try {
        const v = Number(localStorage.getItem('trail-planner-v4-map-h'));
        if (Number.isFinite(v) && v >= 200 && v <= 1200) return v;
      } catch {}
      return 420;
    })(),
    _mapResizing: false,
    _mapResizeStartY: 0,
    _mapResizeStartH: 0,
    showHowTo: false,
    howToExpanded: null,
    // Drag-to-reorder canonical order. Persisted in localStorage; the page renders
    // each panel via CSS `order` so we don't have to template the actual <section>s.
    panelOrder: ['goal', 'nutrition', 'map', 'cumpace', 'segpace', 'eta', 'elev', 'p3d', 'gradient', 'cp', 'spectator', 'share', 'grid'],
    _dragPanelKey: null,
    _dragOverPanelKey: null,
    // CP label field toggles, applied to permanent map labels and 3D pole labels.
    cpLabelFields: { code: true, name: false, distance: true, eta: true },
    tasks: [],
    history: [],
    collapsed: {},

    _undoStack: [],
    _redoStack: [],

    // --- Spectator points (V4 Phase 2) ---
    // Manually-entered points (lat/lon) Jeff types in for crew. Each gets
    // snapped to the nearest route trackpoint to derive an ETA km. Surfaced
    // on the share view's map (diamond marker) and ETA list interleaved
    // with checkpoints. Distinct from checkpoints — no stoppage, no drop
    // bag, just "where to stand". Persisted via snapshot v8 (additive).
    spectatorPoints: [],

    // --- Spectator / Crew Share (V4 Phase 1) ---
    // `share` holds the runner-side tokens once a share link has been
    // generated. Persisted to localStorage as `trail-planner-v4-share-self`
    // via storeLocal so reload reuses the same URL (per Jeff:
    // "regenerate updates the existing run, same URL").
    share: {
      runId: null,
      ownerToken: null,
      shareToken: null,
      expiresAt: null,
      createdAt: null,
      updatedAt: null,
      generating: false,
      error: null,
      copied: false,        // flips to true for ~2s after Copy
    },

    // --- derived ---
    segments: [],
    segGaps: [],
    segPaces: [],
    segSec: [],
    segCumSec: [],
    segCumWithStop: [],
    segETAs: [],
    segElapsedPace: [],
    segElapsedGap: [],
    finishETA: '—',
    checkpointArrivals: [],
    checkpointDepartures: [],
    totalSec: 0,
    totalStoppage: 0,
    hoverKm: null,

    // --- nutrition derived ---
    segFluidG: [],
    segGelG: [],
    segCumCarbsG: [],
    segCumGels: [],
    segCumFluidL: [],
    cpRestockNeed: {},      // { [cpUid]: { carbsG, totalLegCarbsG, gelsNeeded, fluidL, legHrs } }
    cpCarbsCollected: {},   // { [cpUid]: carbsG actually loaded at this CP (gels + fluid) }
    cpTimeToNext: {},       // { [cpUid]: legHrs to the next restock point in the chain }
    cpSurplus: {},          // { [cpUid]: collected − legTarget; positive=surplus, negative=deficit }
    cpInChain: new Set(),   // uids that are part of the active restock chain
    nutritionTotals: {
      gelIntervalSec: 0, fluidGPerHr: 0, gelGPerHr: 0, combinedGPerHr: 0,
      totalFluidG: 0, totalGelsNeeded: 0, totalGelG: 0, totalCarbsG: 0,
      actualCombinedGPerHr: 0,
      plannedGels: {},        // { [gelTypeId]: count }
      plannedGelsTotal: 0,
      plannedFluidL: 0,
      plannedFluidG: 0,
      plannedWaterL: 0,
      gelShortfall: 0, fluidShortfallG: 0,
    },

    get sortedCheckpoints() {
      // CPs with no km set yet sort to the end so newly-added blank rows don't shuffle
      // existing entries around.
      return [...this.checkpoints].sort((a, b) => {
        const ka = a.km == null || !isFinite(a.km) ? Infinity : a.km;
        const kb = b.km == null || !isFinite(b.km) ? Infinity : b.km;
        return ka - kb;
      });
    },
    get validCheckpoints() {
      return this.checkpoints.filter(c => c.km != null && isFinite(c.km));
    },
    get sortedValidCheckpoints() {
      return this.validCheckpoints.slice().sort((a, b) => a.km - b.km);
    },
    get splitLabel() {
      const v = this.splitBias;
      if (Math.abs(v) < 0.05) return 'even';
      const pct = Math.round(Math.abs(v) * 20);
      return v > 0 ? `+${pct}% positive` : `−${pct}% negative`;
    },
    get effortLabel() {
      const e = this.uphillEffort;
      if (Math.abs(e - 1) < 0.02) return '1.0× standard';
      const pct = Math.round((e - 1) * 100);
      return `${e.toFixed(2)}× (${pct >= 0 ? '+' : ''}${pct}%)`;
    },
    get technicalLabel() {
      const t = this.technicalSlowdown;
      if (Math.abs(t - 1) < 0.02) return 'no penalty';
      const pct = Math.round((t - 1) * 100);
      return `${t.toFixed(2)}× (+${pct}%)`;
    },
    get gradientRange() {
      if (!this.segments.length) return [];
      let lo = Infinity, hi = -Infinity;
      for (const s of this.segments) {
        if (s.avgGradePct < lo) lo = s.avgGradePct;
        if (s.avgGradePct > hi) hi = s.avgGradePct;
      }
      const arr = [];
      for (let g = Math.ceil(hi); g >= Math.floor(lo); g--) arr.push(g);
      return arr;
    },
    get canUndo() { return this._undoStack.length > 0; },
    get canRedo() { return this._redoStack.length > 0; },
    // Distinct list of colours already used by any checkpoint, ordered by first use.
    // Powers the swatch palette next to the colour picker so the user can match a new
    // CP to an existing colour without fishing for the hex.
    // Source of truth for the How-To dropdown. Edit this list when shipping a feature
    // change so the menu stays in sync. Each entry: { key (matches the panel id),
    // title, short (one-line tagline), long (1-2 paragraphs of detail) }.
    // Order follows the user's panelOrder so dragging the page reshuffles the menu too.
    get howToSections() {
      const all = [
        {
          key: 'goal',
          title: 'Goal & biases',
          short: 'Set race start time + goal time/pace/GAP. Slide pace bias, uphill effort, technical penalty.',
          long: 'Pick split size (km granularity), then choose how to anchor the plan: by total time, average pace, or GAP. Bias slider shifts pace earlier/later in the race; uphill effort scales how hard you push climbs; technical penalty is a multiplier applied only to segments you flag as technical in the per-segment grid.',
        },
        {
          key: 'nutrition',
          title: 'Nutrition strategy',
          short: 'Target g/hr from fluid + gels, configurable gel types, drop-bag plan with auto-restock.',
          long: 'Top inputs set your target carbs/hr and primary fluid concentration. Add gel types with the +. The drop-bag table shows the carbs you need to carry to the next stocked CP and what you have collected at this CP. Tick "restock" on a row to auto-fill primary gels and primary fluid for that leg. Notes auto-generate but stay editable.',
        },
        {
          key: 'map',
          title: 'Map',
          short: 'Leaflet map of the route with CP labels. Hover to sync km, ETA, pace, GAP across all charts.',
          long: 'Toggle which CP fields appear on the permanent labels (code/name/km/ETA). Hovering anywhere on the route snaps to the nearest km and broadcasts the position to every other chart and the 3D profile so you can read the same point everywhere.',
        },
        {
          key: 'cumpace',
          title: 'Cumulative pace',
          short: 'Running cumulative average pace (and optional GAP overlay).',
          long: 'Each point shows the average pace from the start to that km. Toggle "GAP overlay" to compare cumulative GAP. The faint grey area is elevation for context. Hover anywhere to see the cum-avg pace and segment GAP at that km.',
        },
        {
          key: 'segpace',
          title: 'Per-segment pace',
          short: 'Stepped pace line per segment with optional per-segment labels.',
          long: 'Each step is one segment\'s pace. Tick the per-km labels toggle in the panel header to label every segment. Hover shows the segment pace and GAP for that km.',
        },
        {
          key: 'eta',
          title: 'ETA over time',
          short: 'Time-of-day on the y-axis, with CPs stacked into vertical lanes.',
          long: 'Reading direction is "where will I be at what time". CP labels stack into lanes when they cluster. Hover to see the time of day at any km.',
        },
        {
          key: 'elev',
          title: 'Elevation profile',
          short: 'Course elevation coloured by gradient bucket. Hover for elevation, pace, GAP.',
          long: 'Per-segment colours match the gradient buckets (flat/mod/steep/severe + downs). Hovering reads off the elevation at that exact km plus the pace and GAP you\'ll run there.',
        },
        {
          key: 'p3d',
          title: '3D route profile',
          short: '3D-extruded wall view of the route. Sensitivity slider tunes how locally the colour reads gradient.',
          long: 'Left-drag to orbit. Colour sensitivity is a sliding window over the trackpoints — small windows light up short rollers, large windows give smoother colour bands across longer climbs/descents.',
        },
        {
          key: 'gradient',
          title: 'Pace by gradient',
          short: 'Override pace at each integer gradient bucket; separate column for technical segments.',
          long: 'Each row is one gradient bucket (e.g. +3% covers 2.5%–3.5%). Edit the override pace to lock in what you actually run at that gradient; the implied GAP back-solves it. The Technical column is what you run on segments flagged "technical". Goal GAP and Technical GAP headers above the table show the current values so you can sanity-check overrides.',
        },
        {
          key: 'cp',
          title: 'Checkpoints',
          short: 'CP table — colour, code, name, km, stop time, arrival/departure ETAs, free-text notes.',
          long: 'Pick a CP colour from the circle dropdown — match an existing CP via the swatch row, or open the system colour picker for a custom hex. Edit km / stop / arrive / depart in any column; the planner back-solves the segment GAP to make it true.',
        },
        {
          key: 'spectator',
          title: 'Spectator points',
          short: 'GPS pins for crew vantage points along the course. Show on the share map + ETA list.',
          long: 'Add a row, name it, paste in lat/lon (from Google Maps long-press → coordinates). The planner snaps the point to the nearest km on the route and computes the ETA. Visible on the crew share view as diamond markers (alongside the round CP markers), and interleaved in the ETA list so crew know when to head to which viewpoint.',
        },
        {
          key: 'share',
          title: 'Share & go live (crew view)',
          short: 'Generate a read-only link for crew + family — map, drop-bag handover, ETAs.',
          long: 'Click Generate share link to mint a URL crew can open on their phones. Same URL keeps working as you re-publish — just click Update share link after editing your plan. Crew see a mobile-friendly map (tap a CP for Google/Apple Maps directions), the per-CP fluid + gel handover plan, and arrival/departure ETAs with optional "vs last year" deltas. Phase 1 is plan-only; Phase 3 will add live GPS.',
        },
        {
          key: 'grid',
          title: 'Per-segment plan',
          short: 'Edit GAP, pace, moving time, elapsed time, ETA per segment. Toggle moving/elapsed pace + carb columns.',
          long: 'Each row is one segment. Editing GAP / pace / time / ETA on any row creates a per-segment override (Anchor or Point — Anchor interpolates between, Point only affects this row). Moving Time excludes stoppage; Elapsed Time includes it (so the last row equals goal time). Toggles add elapsed-pace columns and cumulative carbs / gel-count / fluid-litres tallies.',
        },
      ];
      const lookup = Object.fromEntries(all.map(s => [s.key, s]));
      return this.panelOrder.map(k => lookup[k]).filter(Boolean);
    },
    goToSection(key) {
      // Expand the panel if collapsed (toggleCollapse handles chart re-init), then scroll.
      if (this.isCollapsed(key)) this.toggleCollapse(key);
      this.$nextTick(() => {
        const el = document.getElementById('panel-' + key);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    // === Drag-to-reorder ====================================================
    panelOrderIdx(key) {
      const idx = this.panelOrder.indexOf(key);
      return idx >= 0 ? idx : 999;
    },
    onPanelDragStart(key, ev) {
      this._dragPanelKey = key;
      try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', key); } catch {}
    },
    onPanelDragOver(key, ev) {
      ev.preventDefault();
      this._dragOverPanelKey = key;
      try { ev.dataTransfer.dropEffect = 'move'; } catch {}
    },
    onPanelDragLeave(key) {
      if (this._dragOverPanelKey === key) this._dragOverPanelKey = null;
    },
    onPanelDrop(key, ev) {
      ev.preventDefault();
      this._dragOverPanelKey = null;
      const from = this._dragPanelKey;
      this._dragPanelKey = null;
      if (!from || from === key) return;
      const fromIdx = this.panelOrder.indexOf(from);
      const toIdx = this.panelOrder.indexOf(key);
      if (fromIdx < 0 || toIdx < 0) return;
      const next = [...this.panelOrder];
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, from);
      this.panelOrder = next;
      savePanelOrder(next);
    },
    onPanelDragEnd() { this._dragPanelKey = null; this._dragOverPanelKey = null; },
    movePanel(key, dir) {
      const idx = this.panelOrder.indexOf(key);
      if (idx < 0) return;
      const swap = idx + (dir === 'up' ? -1 : 1);
      if (swap < 0 || swap >= this.panelOrder.length) return;
      const next = [...this.panelOrder];
      [next[idx], next[swap]] = [next[swap], next[idx]];
      this.panelOrder = next;
      savePanelOrder(next);
    },

    get usedCpColors() {
      const seen = new Set();
      const out = [];
      for (const cp of this.checkpoints) {
        const c = (cp?.color || '').toLowerCase();
        if (!c || seen.has(c)) continue;
        seen.add(c);
        out.push(cp.color);
      }
      return out;
    },
    setCpColor(cp, color) {
      cp.color = color;
      this.snapshotThen(() => {
        this.recompute();
        mapApi.setCheckpoints(this.sortedValidCheckpoints);
        p3dApi.setCheckpoints3D(this.sortedValidCheckpoints);
      });
    },
    // === V4 v4.5: Map resize ============================
    // Drag the handle below the map to adjust height. The map gets
    // `invalidateSize()` after the drag completes so Leaflet recomputes
    // its viewport. Height clamped to [200, 1200] px; persisted to
    // localStorage so reload keeps the chosen size.

    get mapHeightStyle() {
      return `height: ${this.mapHeightPx}px`;
    },

    onMapResizeStart(ev) {
      this._mapResizing = true;
      this._mapResizeStartY = ev.touches ? ev.touches[0].clientY : ev.clientY;
      this._mapResizeStartH = this.mapHeightPx;
      ev.preventDefault();
      const move = (e) => this._onMapResizeMove(e);
      const end = () => this._onMapResizeEnd(move, end);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', end);
      window.addEventListener('touchmove', move, { passive: false });
      window.addEventListener('touchend', end);
      // Add a body class so we can prevent text selection during drag.
      document.body.classList.add('resizing-map');
    },

    _onMapResizeMove(ev) {
      if (!this._mapResizing) return;
      ev.preventDefault?.();
      const y = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const delta = y - this._mapResizeStartY;
      const next = Math.max(200, Math.min(1200, this._mapResizeStartH + delta));
      this.mapHeightPx = next;
      // Tell Leaflet the container changed so tiles recalc.
      mapApi.invalidateMap?.();
    },

    _onMapResizeEnd(move, end) {
      this._mapResizing = false;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      document.body.classList.remove('resizing-map');
      try { localStorage.setItem('trail-planner-v4-map-h', String(this.mapHeightPx)); } catch {}
      // Final invalidate so Leaflet rerenders cleanly.
      mapApi.invalidateMap?.();
    },

    onP3dSensitivity() {
      // Tell the 3D module about the new window, then rebuild the wall mesh so
      // colours pick up the new sensitivity. CPs are re-applied because the mesh
      // disposal removes them as side-effect.
      if (!this.gpx) return;
      p3dApi.setColorSensitivity3D(this.p3dSensitivityM);
      p3dApi.setRoute3D(this.gpx.trackpoints, this.segments);
      p3dApi.setCheckpoints3D(this.sortedValidCheckpoints);
    },

    init() {
      this.theme = loadTheme();
      this.tasks = loadTasks();
      this.history = loadHistory();
      this.collapsed = loadCollapsed();
      const savedOrder = loadPanelOrder();
      if (savedOrder?.length) {
        // Merge: keep saved order, append any new keys that weren't in storage yet.
        const known = new Set(savedOrder);
        const merged = [...savedOrder];
        for (const k of this.panelOrder) if (!known.has(k)) merged.push(k);
        this.panelOrder = merged;
      }
      if (this.checkpoints?.length) normaliseCheckpoints(this.checkpoints);
      if (this.collapsed.gradient === undefined) {
        this.collapsed = { ...this.collapsed, gradient: true };
        saveCollapsed(this.collapsed);
      }
      // Default share panel to collapsed on first visit — it's secondary
      // until the runner is ready to share with crew.
      if (this.collapsed.share === undefined) {
        this.collapsed = { ...this.collapsed, share: true };
        saveCollapsed(this.collapsed);
      }

      // Rehydrate share tokens. If a previous "Generate share link" was
      // clicked, the same {runId, ownerToken, shareToken, expiresAt} are
      // here — used to update the existing run on the next click rather
      // than mint a fresh URL.
      const selfShare = loadShareSelf();
      if (selfShare) {
        this.share = { ...this.share, ...selfShare };
      }

      onHoverChange(km => {
        this.hoverKm = km;
        mapApi.setHover(km);
        elevApi.setElevationHover(km);
        etaApi.setETAHover(km);
        cumApi.setCumPaceHover(km);
        segPaceApi.setSegmentPaceHover(km);
        p3dApi.setHover3D(km);
      });

      const saved = loadLocal();
      if (saved?.gpxText) {
        this.$nextTick(() => {
          this.restoreSnapshot(saved, false);
          this.$nextTick(() => this.maybeMigrate2026Preset());
        });
      }
    },

    // One-time migration: if the user's saved state still has the pre-2026 preset
    // (Medlow Gap @ 16.6 km), auto-save the current plan to History and replace the
    // checkpoints with the new 2026 race-alignment list.
    maybeMigrate2026Preset() {
      if (!this.gpx || !this.checkpoints?.length) return;
      const hasOld = this.checkpoints.some(c => c?.name === 'Medlow Gap' && Math.abs((c.km ?? -1) - 16.6) < 0.05);
      if (!hasOld) return;
      pushHistory(this, `Auto-saved before 2026 preset migration · ${new Date().toLocaleString()}`);
      this.history = loadHistory();
      this.snapshotThen(() => {
        this.checkpoints = defaultCheckpoints(this.gpx.totalDistanceKm);
        this.recompute();
        mapApi.setCheckpoints(this.sortedValidCheckpoints);
        p3dApi.setCheckpoints3D(this.sortedValidCheckpoints);
      });
    },

    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      saveTheme(this.theme);
      this.$nextTick(() => this.refreshDerivedCharts(true));
    },

    isCollapsed(key) { return !!this.collapsed[key]; },
    toggleCollapse(key) {
      this.collapsed = { ...this.collapsed, [key]: !this.collapsed[key] };
      saveCollapsed(this.collapsed);
      const expanded = !this.collapsed[key];
      // Charts are sized from the *visible* panel body — when a panel was hidden,
      // its canvas had width:0, so on first expand we have to (re-)init the chart so
      // it lays out at the correct size. Same applies to Leaflet (invalidateSize).
      this.$nextTick(() => {
        if (!expanded || !this.gpx) return;
        if (key === 'cumpace' || key === 'eta' || key === 'elev' || key === 'segpace') {
          this.refreshDerivedCharts(true);
        }
        if (key === 'elev' && document.getElementById('elevation-chart')) {
          elevApi.initElevationChart('elevation-chart', this.gpx.trackpoints, this.segments, this.gpx.totalDistanceKm, { checkpoints: this.sortedCheckpoints });
          elevApi.onElevationHover(km => setHoverKm(km));
        }
        if (key === 'map') {
          if (typeof mapApi.invalidateSize === 'function') {
            mapApi.invalidateSize();
          } else if (document.getElementById('map')) {
            mapApi.initMap('map');
            mapApi.setRoute(this.gpx.trackpoints);
            mapApi.setCpLabelResolver(cp => this.cpLabelHTML(cp));
            mapApi.setCheckpoints(this.sortedCheckpoints);
            mapApi.onHover(km => setHoverKm(km));
            mapApi.setLabelResolver(km => this.hoverLabel(km));
          }
        }
        if (key === 'p3d') {
          p3dApi.init3DProfile('profile3d');
          p3dApi.setLabelResolver3D(km => this.hoverLabel(km));
          p3dApi.onHover3D(km => setHoverKm(km));
          p3dApi.setRoute3D(this.gpx.trackpoints, this.segments);
          p3dApi.setCheckpoints3D(this.sortedCheckpoints);
        }
      });
    },

    persistMode() {},

    persistTasks() { persistTasksToStorage(this.tasks); },
    addTask(event) {
      const text = (event.target.value || '').trim();
      if (!text) return;
      this.tasks.push({ id: Date.now(), text, done: false });
      event.target.value = '';
      this.persistTasks();
    },
    removeTask(id) { this.tasks = this.tasks.filter(t => t.id !== id); this.persistTasks(); },
    editTask(task) {
      const next = prompt('Edit task', task.text);
      if (next != null && next.trim()) { task.text = next.trim(); this.persistTasks(); }
    },

    saveCurrentVersion() {
      if (!this.gpxText) return;
      const label = prompt('Label for this version (optional):', `Saved ${new Date().toLocaleString()}`);
      if (label === null) return;
      const entry = pushHistory(this, label || undefined);
      if (entry) this.history = loadHistory();
    },
    deleteVersion(id) {
      if (!confirm('Delete this version?')) return;
      deleteHistoryEntry(id);
      this.history = loadHistory();
    },
    restoreVersion(entry) {
      if (!confirm(`Restore "${entry.label}" from ${new Date(entry.savedAt).toLocaleString()}?`)) return;
      this.restoreSnapshot(entry.snap, false);
      this.showHistory = false;
    },

    pushUndo() {
      this._undoStack.push(makeUndoSnap(this));
      if (this._undoStack.length > UNDO_LIMIT) this._undoStack.shift();
      this._redoStack = [];
    },
    snapshotThen(fn) { this.pushUndo(); fn(); },
    undo() {
      if (!this._undoStack.length) return;
      const cur = makeUndoSnap(this);
      const prev = this._undoStack.pop();
      this._redoStack.push(cur);
      applyUndoSnap(this, prev);
      this.fullRebuild();
    },
    redo() {
      if (!this._redoStack.length) return;
      const cur = makeUndoSnap(this);
      const next = this._redoStack.pop();
      this._undoStack.push(cur);
      applyUndoSnap(this, next);
      this.fullRebuild();
    },

    async onLoadGPX(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      try { this.loadGPXText(await readTextFile(file)); }
      catch (e) { console.error(e); alert('Failed to read file: ' + e.message); }
      event.target.value = '';
    },

    async onDropGPX(event) {
      this.dragOver = false;
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      try {
        if (file.name.toLowerCase().endsWith('.json')) {
          this.restoreSnapshot(JSON.parse(await readTextFile(file)));
        } else {
          this.loadGPXText(await readTextFile(file));
        }
      } catch (e) { console.error(e); alert('Drop failed: ' + e.message); }
    },

    loadGPXText(text) {
      try {
        const gpx = parseGPX(text);
        this.gpxText = text;
        this.gpx = gpx;
        this.checkpoints = defaultCheckpoints(gpx.totalDistanceKm);
        this.overrides = [];
        this.gradientPaceOverrides = {};
        this.technicalIndices = [];
        // Loading a new course invalidates the prior run (alignment is per-course).
        this.priorRun = null;
        this.showPriorOverlay = { segpace: false, cumpace: false, elev: false, grid: false, gridHR: false, segpaceHR: false, cumpaceHR: false };
        this.priorMatchedIndices = [];
        if (this.activeScenario === 'prior') this.activeScenario = 'A';
        this._undoStack = [];
        this._redoStack = [];
        this.fullRebuild();
        this.$nextTick(() => {
          pushHistory(this, `Loaded ${gpx.name}`);
          this.history = loadHistory();
        });
      } catch (e) { console.error(e); alert('Failed to parse GPX: ' + e.message); }
    },

    async onLoadPriorRun(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      this.priorRunLoading = true;
      try {
        const prior = await loadPriorRunFile(file);
        this.priorRun = prior;
        // Re-derive aligned arrays then full chart rebuild so all three overlay
        // datasets attach cleanly. Chart.js can't gracefully add new datasets to
        // a live chart, so re-init is the path of least surprise.
        this.recompute(true);
        this.$nextTick(() => this.rebuildPriorOverlayCharts());
      } catch (e) {
        console.error(e);
        alert('Failed to load prior run: ' + e.message);
      } finally {
        this.priorRunLoading = false;
        event.target.value = '';
      }
    },

    clearPriorRun() {
      if (!this.priorRun) return;
      if (!confirm('Clear the loaded prior run?')) return;
      this.priorRun = null;
      this.showPriorOverlay = { segpace: false, cumpace: false, elev: false, grid: false, gridHR: false, segpaceHR: false, cumpaceHR: false };
      // Clearing the prior also clears any prior-matched per-segment overrides
      // (they're meaningless without the prior trace). Manual edits stay.
      if (this.priorMatchedIndices.length) {
        const matched = new Set(this.priorMatchedIndices);
        this.overrides = this.overrides.filter(o => !matched.has(o.idx));
        this.priorMatchedIndices = [];
      }
      if (this.activeScenario === 'prior') this.activeScenario = 'A';
      this.recompute(true);
      this.$nextTick(() => this.rebuildPriorOverlayCharts());
      debouncedSave(this);
    },

    // Re-init the three overlay-aware charts so prior datasets attach/detach.
    // Lighter than fullRebuild (skips map + 3D + ETA + segment rebuild).
    rebuildPriorOverlayCharts() {
      if (!this.gpx) return;
      const sortedCps = this.sortedCheckpoints;
      if (!this.isCollapsed('cumpace') && document.getElementById('cumpace-chart')) {
        cumApi.initCumPaceChart('cumpace-chart', this.segments, this.segPaces, this.segGaps, this.segCumSec, this.gpx.totalDistanceKm, this.gpx.trackpoints, {
          showCumLabels: this.showCumLabels,
          showGAP: this.showCumGAP,
          checkpoints: sortedCps,
          priorCumPaces: this.priorRun?.priorCumAvgPaces || null,
          priorHR: this.priorRun?.priorSegHR || null,
          showPrior: !!this.showPriorOverlay.cumpace,
          showPriorHR: !!this.showPriorOverlay.cumpaceHR,
        });
        cumApi.onCumPaceHover(km => setHoverKm(km));
        cumApi.setCumPaceLabelResolver(km => this.cumPaceHoverPill(km));
      }
      if (!this.isCollapsed('segpace') && document.getElementById('segpace-chart')) {
        segPaceApi.initSegmentPaceChart('segpace-chart', this.segments, this.segPaces, this.gpx.totalDistanceKm, this.gpx.trackpoints, {
          showLabels: this.showSegLabels,
          checkpoints: sortedCps,
          priorPaces: this.priorRun?.priorSegPaces || null,
          priorHR: this.priorRun?.priorSegHR || null,
          showPrior: !!this.showPriorOverlay.segpace,
          showPriorHR: !!this.showPriorOverlay.segpaceHR,
        });
        segPaceApi.onSegmentPaceHover(km => setHoverKm(km));
        segPaceApi.setSegmentPaceLabelResolver(km => this.segPaceHoverPill(km));
        segPaceApi.onSegmentPaceDrag((idx, paceSec) => this.onSegPaceDrag(idx, paceSec));
      }
      if (!this.isCollapsed('elev') && document.getElementById('elevation-chart')) {
        elevApi.initElevationChart('elevation-chart', this.gpx.trackpoints, this.segments, this.gpx.totalDistanceKm, {
          checkpoints: sortedCps,
          priorTrackpoints: this.priorRun?.trackpoints || null,
          showPrior: !!this.showPriorOverlay.elev,
        });
        elevApi.onElevationHover(km => setHoverKm(km));
        elevApi.setElevationLabelResolver(km => this.elevationHoverPill(km));
      }
    },

    // Toggles re-init the chart so the prior dataset can be added/removed cleanly
    // (Chart.js doesn't gracefully add new datasets at runtime).
    onPriorOverlayToggle(panel) {
      // Show/hide the existing dataset without rebuilding the chart, when the
      // prior dataset is already attached. fullRebuild only happens when prior
      // first loads or splitKm changes.
      if (panel === 'segpace') segPaceApi.setSegmentPaceShowPrior(this.showPriorOverlay.segpace);
      if (panel === 'cumpace') cumApi.setCumPaceShowPrior(this.showPriorOverlay.cumpace);
      if (panel === 'elev') elevApi.setElevationShowPrior(this.showPriorOverlay.elev);
      if (panel === 'segpaceHR') segPaceApi.setSegmentPaceShowPriorHR(this.showPriorOverlay.segpaceHR);
      if (panel === 'cumpaceHR') cumApi.setCumPaceShowPriorHR(this.showPriorOverlay.cumpaceHR);
      debouncedSave(this);
    },

    priorPaceForSeg(i) {
      const arr = this.priorRun?.priorSegPaces;
      return Array.isArray(arr) && Number.isFinite(arr[i]) ? arr[i] : null;
    },
    priorPaceDeltaClass(i) {
      const arr = this.priorRun?.priorSegPaceDeltas;
      if (!Array.isArray(arr)) return '';
      const d = arr[i];
      if (!Number.isFinite(d)) return '';
      // Pace seconds are inverted: lower pace = faster. Positive delta means
      // prior was slower (red); negative = prior faster (green).
      if (d < -0.5) return 'prior-faster';
      if (d > 0.5) return 'prior-slower';
      return '';
    },
    formatPriorDelta(i) {
      const arr = this.priorRun?.priorSegPaceDeltas;
      if (!Array.isArray(arr)) return '';
      const d = arr[i];
      if (!Number.isFinite(d)) return '';
      const sign = d >= 0 ? '+' : '−';
      return `${sign}${Math.abs(Math.round(d))}s`;
    },

    fullRebuild() {
      if (!this.gpx) return;
      this.segments = buildSegments(this.gpx.trackpoints, this.splitKm);
      this.recompute(true);
      const runInit = () => {
        if (!this.isCollapsed('map') && document.getElementById('map')) {
          mapApi.initMap('map');
          mapApi.setRoute(this.gpx.trackpoints);
          mapApi.setCpLabelResolver(cp => this.cpLabelHTML(cp));
          mapApi.setCheckpoints(this.sortedCheckpoints);
          mapApi.onHover(km => setHoverKm(km));
          mapApi.setLabelResolver(km => this.hoverLabel(km));
        }
        if (!this.isCollapsed('elev') && document.getElementById('elevation-chart')) {
          elevApi.initElevationChart('elevation-chart', this.gpx.trackpoints, this.segments, this.gpx.totalDistanceKm, {
            checkpoints: this.sortedCheckpoints,
            priorTrackpoints: this.priorRun?.trackpoints || null,
            showPrior: !!this.showPriorOverlay.elev,
          });
          elevApi.onElevationHover(km => setHoverKm(km));
          elevApi.setElevationLabelResolver(km => this.elevationHoverPill(km));
        }
        if (!this.isCollapsed('eta') && document.getElementById('eta-chart')) {
          etaApi.initETAChart('eta-chart', this.segments, this.segCumSec, this.raceStartSec(), this.sortedCheckpoints, this.gpx.totalDistanceKm);
          etaApi.onETAHover(km => setHoverKm(km));
          etaApi.setETALabelResolver(km => this.etaHoverPill(km));
        }
        if (!this.isCollapsed('cumpace') && document.getElementById('cumpace-chart')) {
          cumApi.initCumPaceChart('cumpace-chart', this.segments, this.segPaces, this.segGaps, this.segCumSec, this.gpx.totalDistanceKm, this.gpx.trackpoints, {
            showCumLabels: this.showCumLabels,
            showGAP: this.showCumGAP,
            checkpoints: this.sortedCheckpoints,
            priorCumPaces: this.priorRun?.priorCumAvgPaces || null,
            priorHR: this.priorRun?.priorSegHR || null,
            showPrior: !!this.showPriorOverlay.cumpace,
            showPriorHR: !!this.showPriorOverlay.cumpaceHR,
          });
          cumApi.onCumPaceHover(km => setHoverKm(km));
          cumApi.setCumPaceLabelResolver(km => this.cumPaceHoverPill(km));
        }
        if (!this.isCollapsed('segpace') && document.getElementById('segpace-chart')) {
          segPaceApi.initSegmentPaceChart('segpace-chart', this.segments, this.segPaces, this.gpx.totalDistanceKm, this.gpx.trackpoints, {
            showLabels: this.showSegLabels,
            checkpoints: this.sortedCheckpoints,
            priorPaces: this.priorRun?.priorSegPaces || null,
            priorHR: this.priorRun?.priorSegHR || null,
            showPrior: !!this.showPriorOverlay.segpace,
            showPriorHR: !!this.showPriorOverlay.segpaceHR,
          });
          segPaceApi.onSegmentPaceHover(km => setHoverKm(km));
          segPaceApi.setSegmentPaceLabelResolver(km => this.segPaceHoverPill(km));
          segPaceApi.onSegmentPaceDrag((idx, paceSec) => this.onSegPaceDrag(idx, paceSec));
        }
        if (!this.isCollapsed('p3d') && document.getElementById('profile3d')) {
          p3dApi.init3DProfile('profile3d');
          p3dApi.setLabelResolver3D(km => this.hoverLabel(km));
          p3dApi.setCpLabelResolver3D(cp => this.cpLabelHTML(cp));
          p3dApi.onHover3D(km => setHoverKm(km));
          p3dApi.setRoute3D(this.gpx.trackpoints, this.segments);
          p3dApi.setCheckpoints3D(this.sortedCheckpoints);
        }
      };
      const tryInit = (attempt = 0) => {
        if (document.getElementById('elevation-chart') || attempt >= 12) runInit();
        else setTimeout(() => tryInit(attempt + 1), 30);
      };
      this.$nextTick(() => tryInit());
    },

    rebuildSegments() {
      if (!this.gpx) return;
      this.snapshotThen(() => {
        const target = Math.max(0.5, Number(this.splitKm) || 1);
        this.splitKm = target;
        this.segments = buildSegments(this.gpx.trackpoints, target);
        this.overrides = this.overrides.filter(o => o.idx < this.segments.length);
        this.technicalIndices = this.technicalIndices.filter(i => i < this.segments.length);
        this.recompute(true);
        this.$nextTick(() => {
          if (!this.isCollapsed('elev')) {
            elevApi.initElevationChart('elevation-chart', this.gpx.trackpoints, this.segments, this.gpx.totalDistanceKm);
            elevApi.onElevationHover(km => setHoverKm(km));
          }
          this.refreshDerivedCharts(true);
          if (!this.isCollapsed('p3d')) p3dApi.setRoute3D(this.gpx.trackpoints, this.segments);
        });
      });
    },

    recompute(skipChartRefresh = false) {
      if (!this.segments.length || !this.gpx) return;
      const totalKm = this.gpx.totalDistanceKm;
      const techSet = new Set(this.technicalIndices);

      let baseGap;
      if (this.goal.mode === 'time') {
        baseGap = gapForTargetTime(this.segments, this.goal.timeSec, totalKm, this.splitBias, this.uphillEffort, techSet, this.technicalSlowdown);
      } else if (this.goal.mode === 'pace') {
        const targetTotal = this.goal.paceSecPerKm * totalKm;
        baseGap = gapForTargetTime(this.segments, targetTotal, totalKm, this.splitBias, this.uphillEffort, techSet, this.technicalSlowdown);
      } else {
        baseGap = this.goal.gapSecPerKm;
      }
      // Per-scenario pace shift (V4 v4.2). 'gap' mode adds value sec/km to
      // the base GAP — equivalent to nudging the goal pace, leaves
      // overrides untouched (defaults shift). 'percent' and 'seconds'
      // modes apply AFTER segPaces so they hit every segment uniformly
      // (overrides included) — that's what Jeff wants for "shift the
      // whole thing 5 minutes faster without resetting my edits".
      const shift = this.paceShift || { mode: 'gap', value: 0 };
      if (shift.mode === 'gap' && Number.isFinite(shift.value) && shift.value !== 0) {
        baseGap += shift.value;
      }
      this.goal.gapSecPerKm = baseGap;

      this.segGaps = computeSegmentGaps(this.segments, baseGap, this.overrides, totalKm, this.splitBias);
      const overrideIdxSet = new Set(this.overrides.map(o => o.idx));
      this.segPaces = computeSegmentPaces(
        this.segments, this.segGaps, this.uphillEffort,
        this.gradientPaceOverrides, overrideIdxSet,
        techSet, this.technicalSlowdown,
        this.technicalGradientPaceOverrides,
      );
      // Apply % / sec shift AFTER pace resolution so every segment
      // (override or default) moves uniformly.
      if (shift.mode === 'percent' && Number.isFinite(shift.value) && shift.value !== 0) {
        const mul = 1 + (shift.value / 100);
        this.segPaces = this.segPaces.map(p => p * mul);
      } else if (shift.mode === 'seconds' && Number.isFinite(shift.value) && shift.value !== 0) {
        this.segPaces = this.segPaces.map(p => p + shift.value);
      }
      const sec = computeSegmentSeconds(this.segments, this.segPaces);
      this.segSec = sec.segSec;
      this.segCumSec = sec.cumSec;
      this.totalSec = sec.totalSec;
      this.totalStoppage = totalStoppageSec(this.validCheckpoints);

      const startSec = this.raceStartSec();
      const sortedCps = this.sortedValidCheckpoints;
      const stoppageAt = buildStoppageAccumulator(sortedCps);
      // Cum (race-clock incl. stoppage at segment endpoints).
      this.segCumWithStop = this.segments.map((seg, i) => sec.cumSec[i] + stoppageAt(seg.endKm));

      if (this.goal.mode !== 'time') {
        this.goal.timeSec = this.totalSec;
        this.goalTimeText = formatHHMMSS(this.totalSec);
      }
      if (this.goal.mode !== 'pace') {
        this.goal.paceSecPerKm = this.totalSec / totalKm;
        this.goalPaceText = formatPace(this.goal.paceSecPerKm);
      }
      if (this.goal.mode !== 'gap') this.goalGapText = formatPace(baseGap);

      // Per-segment elapsed pace: same time-per-km as moving pace, plus any stoppage that
      // sits inside or at the trailing boundary of the segment. Elapsed GAP back-solves
      // the GAP that would yield that elapsed pace at the segment's grade and effort.
      this.segElapsedPace = this.segments.map((seg, i) => {
        const prev = i === 0 ? 0 : this.segCumWithStop[i - 1];
        return seg.distKm > 0 ? (this.segCumWithStop[i] - prev) / seg.distKm : 0;
      });
      this.segElapsedGap = this.segments.map((seg, i) => {
        const techMul = this.technicalIndices.includes(i) ? this.technicalSlowdown : 1;
        const movingEquivalent = this.segElapsedPace[i] / Math.max(0.001, techMul);
        return gapFromPace(movingEquivalent, seg.avgGradePct, this.uphillEffort);
      });

      this.segETAs = this.segments.map((seg, i) => formatTimeOfDay(startSec + this.segCumWithStop[i]));
      this.checkpointArrivals = sortedCps.map(cp => formatTimeOfDay(startSec + this.secondsAtKmHelper(cp.km) + stoppageAt(cp.km)));
      this.checkpointDepartures = sortedCps.map(cp => formatTimeOfDay(startSec + this.secondsAtKmHelper(cp.km) + stoppageAt(cp.km) + (cp.stoppageSec || 0)));
      this.finishETA = formatTimeOfDay(startSec + this.totalSec + this.totalStoppage);

      this.computeNutrition();

      // Prior-run alignment uses the just-computed plan paces so deltas are
      // accurate. Pass plan trackpoints so alignment can match by lat/lon
      // (handles year-over-year course differences where the km axes drift).
      if (this.priorRun?.trackpoints?.length) {
        const aligned = alignPriorToSegments(this.priorRun, this.segments, this.segPaces, this.gpx?.trackpoints);
        this.priorRun.priorSegPaces = aligned.priorSegPaces;
        this.priorRun.priorSegPaceDeltas = aligned.priorSegPaceDeltas;
        this.priorRun.priorCumAvgPaces = aligned.priorCumAvgPaces;
        this.priorRun.priorSegHR = aligned.priorSegHR;
        this.priorRun.priorSegGrade = aligned.priorSegGrade;
      }

      // Keep inactive scenarios' derived (pace, GAP, time) values in sync with
      // the latest splitBias/effort/etc so each row shows live numbers without
      // having to be activated. The active scenario is already up-to-date via
      // the goal sync above.
      this._refreshInactiveScenarios();

      if (!skipChartRefresh) this.refreshDerivedCharts();
      debouncedSave(this);
    },

    // Per-segment + race-level nutrition. The split-counter timer for gel drops uses the
    // PRIMARY gel size (gelTypes[0]). Fluid is time-based: fluidGPerHr × segHrs converted
    // to litres of primary mix at primaryFluidGPerL.
    computeNutrition() {
      const nu = this.nutrition || {};
      const gelGPerHr = Math.max(0, Number(nu.gelGPerHr) || 0);
      const fluidGPerHr = Math.max(0, Number(nu.fluidGPerHr) || 0);
      const fluidLPerHr = Math.max(0, Number(nu.fluidLPerHr) || 0);
      // Concentration is derived from the two fluid inputs. Falls back to 100 g/L
      // when the user has zeroed fluid intake (avoids divide-by-zero).
      const fluidGPerL = fluidLPerHr > 0 ? fluidGPerHr / fluidLPerHr : 100;
      const targetGPerHr = gelGPerHr + fluidGPerHr;
      const gelTypes = Array.isArray(nu.gelTypes) ? nu.gelTypes : [];
      const primary = gelTypes[0];
      const primarySize = Math.max(1, Number(primary?.sizeG) || 25);
      const totalActiveSec = this.totalSec || 0;
      const totalRaceHrs = totalActiveSec / 3600;

      // Make sure every CP has an entry for every active gel type.
      syncDropbagsToGelTypes(this.checkpoints, gelTypes);
      // Same for start inventory.
      const inv = nu.startInventory || (nu.startInventory = {});
      if (!inv.gels || typeof inv.gels !== 'object') inv.gels = {};
      for (const t of gelTypes) if (inv.gels[t.id] == null) inv.gels[t.id] = 0;
      for (const k of Object.keys(inv.gels)) if (!gelTypes.find(t => t.id === k)) delete inv.gels[k];

      const gelIntervalSec = gelGPerHr > 0 ? (primarySize / gelGPerHr) * 3600 : Infinity;

      const segFluidG = [];
      const segGelG = [];
      const segCumCarbsG = [];
      const segCumGels = [];
      const segCumFluidL = [];
      let prevTick = 0;
      let cum = 0;
      let cumGels = 0;
      for (let i = 0; i < this.segments.length; i++) {
        const segSec = this.segSec[i] || 0;
        const segHrs = segSec / 3600;
        const fluidG = fluidGPerHr * segHrs;
        const cumActiveSec = this.segCumSec[i] || 0;
        const tick = isFinite(gelIntervalSec) ? Math.floor(cumActiveSec / gelIntervalSec) : 0;
        const gelDrops = Math.max(0, tick - prevTick);
        prevTick = tick;
        cumGels += gelDrops;
        const gelG = gelDrops * primarySize;
        cum += fluidG + gelG;
        segFluidG.push(fluidG);
        segGelG.push(gelG);
        segCumCarbsG.push(cum);
        segCumGels.push(cumGels);
        segCumFluidL.push((fluidGPerHr * (cumActiveSec / 3600)) / fluidGPerL);
      }
      this.segFluidG = segFluidG;
      this.segGelG = segGelG;
      this.segCumCarbsG = segCumCarbsG;
      this.segCumGels = segCumGels;
      this.segCumFluidL = segCumFluidL;

      // === Restock chain ============================================================
      // A "restock point" is any row (Start or CP) that the runner is using to refill —
      // either by ticking the Restock checkbox, or by manually loading some gels/fluid.
      // If NOTHING is ticked or stocked anywhere, Start is treated as the implicit
      // restock for the whole race (so the table at least shows the runner what they'd
      // need to carry from km 0).
      //
      // For each restock point we compute a leg target = carbs needed to reach the next
      // restock point (or the finish if it's the last). When the row is auto-restocked
      // and the user hasn't manually edited it, we set primary gel + primary fluid to
      // hit that target. We walk the chain in REVERSE so any deficit at a downstream
      // manual row gets absorbed into the previous auto row's fill — the runner ends up
      // carrying enough from the earliest restock.
      const sortedCps = this.sortedValidCheckpoints;
      const secAtKm = (km) => this.secondsAtKmHelper(km);
      const finishKm = sortedCps.length ? sortedCps[sortedCps.length - 1].km : (this.gpx?.totalDistanceKm || 0);
      const finishSec = secAtKm(finishKm);
      const isStocked = (src) => {
        if (!src) return false;
        if (Number(src.fluidL) > 0 || Number(src.waterL) > 0) return true;
        if (src.gels) {
          for (const t of gelTypes) if ((Number(src.gels[t.id]) || 0) > 0) return true;
        }
        return false;
      };
      const carbsCollectedFor = (src) => {
        if (!src) return 0;
        let total = 0;
        if (src.gels) {
          for (const t of gelTypes) total += (Number(src.gels[t.id]) || 0) * (Number(t.sizeG) || 0);
        }
        total += (Number(src.fluidL) || 0) * fluidGPerL;
        return total;
      };

      // Build chain in km order. Each entry: { uid, src (inv or cp.dropbag), km, isActive }.
      const chain = [];
      const startActive = isStocked(inv) || !!inv.autoRestock;
      const anyCpActive = sortedCps.some(cp => isStocked(cp.dropbag) || !!cp.dropbag?.autoRestock);
      // Implicit Start when nothing is set anywhere — pin Start to chain so the table
      // shows total race carbs at Start.
      if (startActive || (!anyCpActive && !startActive)) {
        chain.push({ uid: '__START__', src: inv, km: 0, isActive: startActive || (!anyCpActive) });
      }
      for (const cp of sortedCps) {
        const active = isStocked(cp.dropbag) || !!cp.dropbag?.autoRestock;
        if (active) chain.push({ uid: cp._uid, src: cp.dropbag, km: cp.km, isActive: true, cp });
      }

      // Compute leg targets (forward).
      for (let i = 0; i < chain.length; i++) {
        const here = chain[i];
        const next = chain[i + 1];
        const endSec = next ? secAtKm(next.km) : finishSec;
        const legSec = Math.max(0, endSec - secAtKm(here.km));
        here.legHrs = legSec / 3600;
        here.legTargetCarbs = here.legHrs * (fluidGPerHr + gelGPerHr);
      }

      // Pre-pass forward walk: estimate the upstream balance entering each
      // chain node BEFORE auto-fill runs. Any auto row uses this to subtract
      // upstream surplus from its fill target — otherwise auto chains over-
      // prescribe by `legTarget` per node, accumulating surplus across the
      // race.
      let _preBalance = 0;
      for (let i = 0; i < chain.length; i++) {
        const here = chain[i];
        // For auto rows we don't yet know the post-fill collected; assume 0
        // and let auto-fill solve to legTarget - upstream + downstream. For
        // manual rows we use the actual current collected.
        if (here.src.autoRestock && !here.src.manualEdit) {
          here.upstreamBalanceBeforeFill = _preBalance;
          // The auto row will fill enough to bring balance back to 0 going
          // into the next leg, so the running balance after this leg is 0.
          _preBalance = 0;
        } else {
          const collected = carbsCollectedFor(here.src);
          _preBalance += collected - here.legTargetCarbs;
          here.upstreamBalanceBeforeFill = 0; // not used
        }
      }

      // Walk reverse to absorb downstream deficits + run auto-fill on rows that have
      // restock ticked AND no manual override.
      for (let i = chain.length - 1; i >= 0; i--) {
        const here = chain[i];
        const downstreamDeficit = (chain[i + 1]?.deficit) || 0;
        // Auto rows subtract upstream surplus from their fill target so the
        // chain's total carbs ≈ total race carbs (no rounding-driven overage).
        const upstreamSurplus = (here.src.autoRestock && !here.src.manualEdit)
          ? Math.max(0, here.upstreamBalanceBeforeFill || 0)
          : 0;
        const targetWithDeficit = Math.max(0, here.legTargetCarbs + downstreamDeficit - upstreamSurplus);
        const collected = carbsCollectedFor(here.src);
        if (here.src.autoRestock && !here.src.manualEdit) {
          // Allocate the target proportionally between gels and fluid using the same
          // ratio as the master inputs. Round (not ceil) so we don't accumulate a
          // gel-rounding surplus across many CPs — net rounding error stays close
          // to zero across the full chain.
          const total = (gelGPerHr + fluidGPerHr) || 1;
          const gelShareCarbs = targetWithDeficit * (gelGPerHr / total);
          const fluidShareCarbs = targetWithDeficit * (fluidGPerHr / total);
          const primaryGels = primarySize > 0 ? Math.round(gelShareCarbs / primarySize) : 0;
          const newFluidL = fluidGPerL > 0 ? fluidShareCarbs / fluidGPerL : 0;
          // Reset only the primary gel slot — leave caffeine + extras alone so the user
          // can override after auto-restock.
          if (primary) {
            const existingExtra = {};
            for (const t of gelTypes) if (t.id !== primary.id) existingExtra[t.id] = Number(here.src.gels?.[t.id]) || 0;
            here.src.gels = here.src.gels || {};
            for (const t of gelTypes) {
              here.src.gels[t.id] = t.id === primary.id ? primaryGels : (existingExtra[t.id] || 0);
            }
          }
          here.src.fluidL = Number((newFluidL).toFixed(3));
          // V4 v4.8: notes are user-controlled only — no longer auto-filled
          // on auto-restock. Auto-fill still sets the gel/fluid numbers,
          // but anything typed in the notes column stays as-is.
          here.deficit = 0;
          here.surplus = 0;
        } else {
          here.deficit = Math.max(0, targetWithDeficit - collected);
          here.surplus = collected - targetWithDeficit;  // negative means deficit
        }
      }

      // Build per-row maps for HTML bindings.
      const cpRestockNeed = {};
      const cpCarbsCollected = {};
      const cpTimeToNext = {};
      const cpSurplus = {};
      const inChainSet = new Set(chain.map(c => c.uid));
      const chainByUid = Object.fromEntries(chain.map(c => [c.uid, c]));

      const writeRow = (uid, src, km) => {
        const inChain = inChainSet.has(uid);
        const c = chainByUid[uid];
        const collected = carbsCollectedFor(src);
        cpCarbsCollected[uid] = collected;
        if (inChain && c) {
          cpRestockNeed[uid] = {
            legHrs: c.legHrs,
            carbsG: c.legTargetCarbs,
            totalLegCarbsG: c.legTargetCarbs,
            gelsNeeded: gelGPerHr > 0 ? Math.ceil((gelGPerHr * c.legHrs) / primarySize) : 0,
            // Total fluid needed for the leg in litres (primary + water at the
            // master fluidLPerHr rate). Matches what the runner actually drinks.
            fluidL: fluidLPerHr * c.legHrs,
          };
          cpTimeToNext[uid] = c.legHrs;
          // Show running surplus (forward-walk balance) so upstream overstock
          // covers downstream legs instead of falsely flagging a deficit.
          cpSurplus[uid] = Number.isFinite(c.runningSurplus) ? c.runningSurplus : (collected - c.legTargetCarbs);
        } else {
          cpRestockNeed[uid] = { legHrs: 0, carbsG: 0, totalLegCarbsG: 0, gelsNeeded: 0, fluidL: 0 };
          cpTimeToNext[uid] = 0;
          cpSurplus[uid] = 0;
        }
      };
      writeRow('__START__', inv, 0);
      for (const cp of sortedCps) writeRow(cp._uid, cp.dropbag, cp.km);

      // Final forward walk AFTER auto-fill so the displayed surplus reflects
      // actual post-fill values (auto-fill may have changed src.fluidL / gels).
      // Carbs use carbsCollectedFor; fluid uses primary + water litres against
      // total fluid required (fluidLPerHr × legHrs).
      let _fwdBalance = 0;
      let _fwdFluidL = 0;
      for (let i = 0; i < chain.length; i++) {
        const here = chain[i];
        const collected = carbsCollectedFor(here.src);
        _fwdBalance += collected;
        here.runningSurplus = _fwdBalance - here.legTargetCarbs;
        _fwdBalance = here.runningSurplus;
        const fluidCollected = (Number(here.src.fluidL) || 0) + (Number(here.src.waterL) || 0);
        const fluidNeedL = fluidLPerHr * here.legHrs;
        _fwdFluidL += fluidCollected;
        here.runningFluidSurplus = _fwdFluidL - fluidNeedL;
        _fwdFluidL = here.runningFluidSurplus;
      }
      // Re-write the now-correct surplus values into the cpSurplus map (the
      // earlier writeRow pass used the auto-fill loop's `here.surplus` which
      // doesn't carry forward).
      for (const c of chain) {
        cpSurplus[c.uid] = Number.isFinite(c.runningSurplus) ? c.runningSurplus : (cpSurplus[c.uid] || 0);
      }

      this.cpRestockNeed = cpRestockNeed;
      this.cpCarbsCollected = cpCarbsCollected;
      this.cpTimeToNext = cpTimeToNext;
      this.cpSurplus = cpSurplus;
      this.cpInChain = inChainSet;
      // Per-CP fluid running surplus (forward-walking balance). Used by the
      // dropbag table's Fluid surplus column so upstream overstock carries.
      const cpFluidRunningSurplus = {};
      for (const c of chain) {
        cpFluidRunningSurplus[c.uid] = Number.isFinite(c.runningFluidSurplus) ? c.runningFluidSurplus : 0;
      }
      this._cpFluidRunningSurplus = cpFluidRunningSurplus;

      // Race totals (planned vs needed).
      const plannedGels = {};
      for (const t of gelTypes) plannedGels[t.id] = 0;
      let plannedFluidL = 0;
      let plannedWaterL = 0;
      const accum = (src) => {
        if (!src) return;
        for (const t of gelTypes) plannedGels[t.id] += Number(src.gels?.[t.id]) || 0;
        plannedFluidL += Number(src.fluidL) || 0;
        plannedWaterL += Number(src.waterL) || 0;
      };
      accum(inv);
      for (const cp of this.checkpoints) accum(cp.dropbag);

      let plannedGelsTotal = 0;
      let plannedGelCarbsG = 0;
      for (const t of gelTypes) {
        const n = plannedGels[t.id] || 0;
        plannedGelsTotal += n;
        plannedGelCarbsG += n * (Number(t.sizeG) || 0);
      }
      const plannedFluidG = plannedFluidL * fluidGPerL;

      const totalFluidG = fluidGPerHr * totalRaceHrs;
      const totalGelsNeeded = totalRaceHrs > 0
        ? Math.ceil((gelGPerHr * totalRaceHrs) / primarySize)
        : 0;
      const totalGelG = totalGelsNeeded * primarySize;
      const totalCarbsG = totalFluidG + totalGelG;
      const actualCombinedGPerHr = totalRaceHrs > 0 ? totalCarbsG / totalRaceHrs : 0;

      // Race-level surplus/deficit = total carbs collected across all rows minus the
      // race target. Positive means the runner is carrying more than they'll consume,
      // negative means they're going to run short before the finish.
      const totalSurplus = (plannedGelCarbsG + plannedFluidG) - totalCarbsG;

      this.nutritionTotals = {
        gelIntervalSec,
        fluidGPerHr,
        gelGPerHr,
        combinedGPerHr: fluidGPerHr + gelGPerHr,
        primaryFluidGPerL: fluidGPerL,
        primaryGelSize: primarySize,
        totalFluidG,
        totalGelsNeeded,
        totalGelG,
        totalCarbsG,
        actualCombinedGPerHr,
        plannedGels,
        plannedGelsTotal,
        plannedGelCarbsG,
        plannedFluidL,
        plannedFluidG,
        plannedWaterL,
        totalSurplus,
        gelShortfall: Math.max(0, totalGelsNeeded - plannedGelsTotal),
        fluidShortfallG: Math.max(0, totalFluidG - plannedFluidG),
      };
    },

    _composeAutoNotes(src, gelTypes, fluidGPerL, isStart) {
      const parts = [];
      if (Number(src.fluidL) > 0) {
        const grams = Math.round(Number(src.fluidL) * fluidGPerL);
        parts.push(`${Number(src.fluidL).toFixed(1)}L pre-mix (${grams}g)`);
      }
      for (const t of gelTypes) {
        const n = Number(src.gels?.[t.id]) || 0;
        if (n > 0) parts.push(`${n}× ${t.name} (${t.sizeG}g)`);
      }
      if (Number(src.waterL) > 0) parts.push(`${Number(src.waterL).toFixed(1)}L water`);
      return parts.join(', ');
    },

    // Wire-up for the Nutrition panel inputs — snapshots, recomputes, no chart refresh
    // since nutrition doesn't currently feed any of the existing charts.
    onNutritionEdit() {
      this.snapshotThen(() => this.recompute());
    },
    onDropbagEdit() {
      this.snapshotThen(() => this.recompute());
    },
    // The user manually changed a numeric input (gels / fluidL / waterL) in this row.
    // Setting manualEdit suppresses subsequent auto-restock fills in computeNutrition
    // until the user clicks the "↺ revert to auto" button on that row.
    markRowManual(src) {
      if (!src) return;
      src.manualEdit = true;
      this.snapshotThen(() => this.recompute());
    },
    toggleAutoAdjust(src) {
      if (!src) return;
      src.autoAdjust = !src.autoAdjust;
      this.snapshotThen(() => this.recompute());
    },
    // Called from the @change handlers on every numeric cell in a drop-bag row.
    // `editedField` is one of `'gel.<typeId>'`, `'fluidL'`, or `'waterL'`.
    // When the row has autoAdjust on we rebalance the OTHER carb-bearing field so
    // the row's collected carbs land back on the leg target. The slack-taker is:
    //  - secondary gel if the user just edited the primary gel
    //  - primary gel for any other change (secondary/tertiary/fluid)
    // Water has no carbs, so editing water never triggers a rebalance.
    onRowEdit(src, editedField) {
      if (!src) return;
      src.manualEdit = true;
      if (src.autoAdjust && editedField !== 'waterL') {
        this._rebalanceRow(src, editedField);
      }
      this.snapshotThen(() => this.recompute());
    },
    _rebalanceRow(src, editedField) {
      const nu = this.nutrition || {};
      const gelTypes = nu.gelTypes || [];
      if (!gelTypes.length) return;
      const fluidGPerL = nu.fluidLPerHr > 0 ? nu.fluidGPerHr / nu.fluidLPerHr : 100;
      const primaryId = gelTypes[0].id;
      const secondaryId = gelTypes[1]?.id;
      // Locate this row in the chain to read its leg target.
      const uid = src === this.nutrition.startInventory ? '__START__'
        : (this.checkpoints.find(c => c.dropbag === src)?._uid);
      const target = this.cpRestockNeed?.[uid]?.totalLegCarbsG;
      if (!target || target <= 0) return;

      const gelCarbs = (id) => (Number(src.gels?.[id]) || 0) * (gelTypes.find(t => t.id === id)?.sizeG || 0);
      const totalGels = gelTypes.reduce((s, t) => s + gelCarbs(t.id), 0);
      const fluidCarbs = (Number(src.fluidL) || 0) * fluidGPerL;
      const current = totalGels + fluidCarbs;
      const diff = target - current;
      if (Math.abs(diff) < 0.5) return;

      const slackId = (editedField === 'gel.' + primaryId && secondaryId) ? secondaryId : primaryId;
      const slackType = gelTypes.find(t => t.id === slackId);
      // If the user edited fluid, push the slack into the primary gel (whole-gel units).
      // If the user edited a gel, push the slack into the slackId gel (whole-gel units).
      // Bias to round UP so the runner errs on the side of "enough carbs".
      if (slackType && slackType.sizeG > 0) {
        const currentN = Number(src.gels?.[slackId]) || 0;
        const newN = Math.max(0, Math.round((currentN * slackType.sizeG + diff) / slackType.sizeG));
        src.gels = src.gels || {};
        src.gels[slackId] = newN;
      }
    },
    revertRowToAuto(src) {
      if (!src) return;
      src.manualEdit = false;
      this.snapshotThen(() => this.recompute());
    },
    // Zero out gels + fluid + water in a row. Doesn't touch autoRestock — the user can
    // still tick it to refill. Marks the row as manualEdit so a subsequent recompute
    // doesn't immediately re-fill the auto-restock target on top.
    clearRowSupplies(src) {
      if (!src) return;
      this.snapshotThen(() => {
        if (src.gels) for (const k of Object.keys(src.gels)) src.gels[k] = 0;
        src.fluidL = 0;
        src.waterL = 0;
        src.notes = '';
        src.manualEdit = !!src.autoRestock;  // only mark manual if restock was on
        this.recompute();
      });
    },
    onAutoRestockToggle(src) {
      // Ticking restock implies "use auto-fill again" — clear any prior manual flag so
      // computeNutrition writes the leg target into this row.
      if (src) src.manualEdit = false;
      this.snapshotThen(() => this.recompute());
    },

    // Append a new gel type. Counts default to 0 across all checkpoints + start inventory.
    addGelType() {
      this.snapshotThen(() => {
        const ids = new Set((this.nutrition.gelTypes || []).map(t => t.id));
        let n = this.nutrition.gelTypes.length + 1;
        let id = `g${n}`;
        while (ids.has(id)) id = `g${++n}`;
        this.nutrition.gelTypes.push({ id, name: `Gel ${this.nutrition.gelTypes.length + 1}`, sizeG: 25 });
        syncDropbagsToGelTypes(this.checkpoints, this.nutrition.gelTypes);
        if (!this.nutrition.startInventory.gels) this.nutrition.startInventory.gels = {};
        this.nutrition.startInventory.gels[id] = 0;
        this.recompute();
      });
    },
    removeGelType(id) {
      // Don't allow removing the last remaining type — at least one (primary) is needed.
      if ((this.nutrition.gelTypes || []).length <= 1) return;
      this.snapshotThen(() => {
        this.nutrition.gelTypes = this.nutrition.gelTypes.filter(t => t.id !== id);
        syncDropbagsToGelTypes(this.checkpoints, this.nutrition.gelTypes);
        if (this.nutrition.startInventory.gels) delete this.nutrition.startInventory.gels[id];
        this.recompute();
      });
    },

    // Move focus across the drop-bag table with Enter / arrow keys. Enter (and Shift+Enter)
    // step rows in the same column; ArrowUp/Down do the same; ArrowLeft/Right step columns
    // along the row, but only when the cursor is at the field boundary so they don't fight
    // text editing in the Notes column.
    onDropbagKeydown(event) {
      const k = event.key;
      if (!['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) return;
      const input = event.target;
      if (!input || input.tagName !== 'INPUT') return;
      const td = input.closest('td');
      const tr = input.closest('tr');
      const tbody = input.closest('tbody');
      if (!td || !tr) return;

      const tdIdx = Array.from(tr.children).indexOf(td);
      const move = (targetTr, targetTdIdx) => {
        if (!targetTr) return false;
        const targetTd = targetTr.children[targetTdIdx];
        const next = targetTd?.querySelector('input');
        if (!next) return false;
        event.preventDefault();
        input.dispatchEvent(new Event('change'));
        next.focus();
        if (typeof next.select === 'function') next.select();
        return true;
      };

      if (k === 'Enter' || k === 'ArrowDown' || k === 'ArrowUp') {
        const direction = (k === 'ArrowUp' || (k === 'Enter' && event.shiftKey)) ? -1 : 1;
        // Walk siblings within the current tbody, then jump to the next tbody if needed.
        let node = tr;
        while (true) {
          node = direction === 1 ? node.nextElementSibling : node.previousElementSibling;
          if (!node) break;
          if (node.tagName !== 'TR') continue;
          if (move(node, tdIdx)) return;
        }
        // Spill out of the current tbody into the adjacent one.
        let body = tbody;
        while (body) {
          body = direction === 1 ? body.nextElementSibling : body.previousElementSibling;
          if (!body || body.tagName !== 'TBODY' && body.tagName !== 'TFOOT') {
            if (!body) return;
            continue;
          }
          const rows = Array.from(body.querySelectorAll('tr'));
          const candidates = direction === 1 ? rows : rows.reverse();
          for (const r of candidates) {
            if (move(r, tdIdx)) return;
          }
        }
        return;
      }

      if (k === 'ArrowRight' || k === 'ArrowLeft') {
        // For number inputs always navigate; for text inputs only when cursor is at the boundary.
        const isText = input.type === 'text';
        if (isText) {
          const start = input.selectionStart, end = input.selectionEnd;
          if (k === 'ArrowRight' && (start !== input.value.length || start !== end)) return;
          if (k === 'ArrowLeft' && (start !== 0 || start !== end)) return;
        }
        const direction = k === 'ArrowRight' ? 1 : -1;
        let nextIdx = tdIdx + direction;
        while (nextIdx >= 0 && nextIdx < tr.children.length) {
          if (move(tr, nextIdx)) return;
          nextIdx += direction;
        }
      }
    },

    // Same idea for the 3 inline inputs at the top of the Nutrition panel.
    onNutritionInputKeydown(event) {
      const k = event.key;
      if (!['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) return;
      const input = event.target;
      if (!input || input.tagName !== 'INPUT') return;
      const grid = input.closest('.nutrition-grid');
      if (!grid) return;
      const inputs = Array.from(grid.querySelectorAll('input'));
      const idx = inputs.indexOf(input);
      if (idx < 0) return;
      const direction = (k === 'Enter' && event.shiftKey) || k === 'ArrowUp' || k === 'ArrowLeft' ? -1 : 1;
      const next = inputs[idx + direction];
      if (!next) return;
      event.preventDefault();
      input.dispatchEvent(new Event('change'));
      next.focus();
      if (typeof next.select === 'function') next.select();
    },

    // Compact "Hh MMm" formatter for the next-refill window in the drop-bag rows.
    formatLegHrs(hrs) {
      if (!isFinite(hrs) || hrs <= 0) return '—';
      const totalMin = Math.round(hrs * 60);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      if (h === 0) return `${m}m`;
      return `${h}h ${String(m).padStart(2, '0')}m`;
    },
    formatGelInterval(sec) {
      if (!isFinite(sec) || sec <= 0) return '—';
      const m = Math.floor(sec / 60);
      const s = Math.round(sec - m * 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    },
    cpDropbagGelTotal(cp) {
      const gels = cp?.dropbag?.gels;
      if (!gels) return 0;
      let total = 0;
      for (const k of Object.keys(gels)) total += Number(gels[k]) || 0;
      return total;
    },

    // Per-chart hover-pill text resolvers. Each one returns a small multi-line
    // string for the floating label that follows the crosshair.
    segPaceHoverPill(km) {
      if (!isFinite(km)) return '';
      const pace = this.paceAtKm(km);
      const gap = this.gapAtKm(km);
      let s = `km ${km.toFixed(2)} · Pace ${pace ? formatPace(pace) : '—'}/km · GAP ${gap ? formatPace(gap) : '—'}/km`;
      const prior = this.priorPaceAtKm(km);
      if (prior != null) {
        const delta = pace ? prior - pace : null;
        const deltaTxt = delta != null ? ` (Δ ${delta >= 0 ? '+' : '−'}${Math.abs(Math.round(delta))}s)` : '';
        s += ` · Prior ${formatPace(prior)}${deltaTxt}`;
      }
      return s;
    },
    cumPaceHoverPill(km) {
      if (!isFinite(km)) return '';
      const cumSecAtKm = this.secondsAtKmHelper(km);
      const cumAvg = km > 0 ? cumSecAtKm / km : 0;
      const pace = this.paceAtKm(km);
      const gap = this.gapAtKm(km);
      let s = `km ${km.toFixed(2)} · cum-avg ${cumAvg ? formatPace(cumAvg) : '—'}/km · Pace ${pace ? formatPace(pace) : '—'} · GAP ${gap ? formatPace(gap) : '—'}`;
      const priorCum = this.priorCumAvgAtKm(km);
      if (priorCum != null) {
        const delta = cumAvg ? priorCum - cumAvg : null;
        const deltaTxt = delta != null ? ` (Δ ${delta >= 0 ? '+' : '−'}${Math.abs(Math.round(delta))}s)` : '';
        s += ` · Prior cum ${formatPace(priorCum)}${deltaTxt}`;
      }
      return s;
    },

    // Linear-interpolated lookup of prior pace at any km along the plan, using
    // the per-segment aligned arrays (which already encode null for past-end).
    priorPaceAtKm(km) {
      const arr = this.priorRun?.priorSegPaces;
      if (!Array.isArray(arr)) return null;
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        if (km >= seg.startKm && km < seg.endKm) {
          return Number.isFinite(arr[i]) ? arr[i] : null;
        }
      }
      return null;
    },
    priorCumAvgAtKm(km) {
      const arr = this.priorRun?.priorCumAvgPaces;
      if (!Array.isArray(arr)) return null;
      // Use the segment whose end >= km for a step-wise read.
      for (let i = 0; i < this.segments.length; i++) {
        if (km <= this.segments[i].endKm) {
          return Number.isFinite(arr[i]) ? arr[i] : null;
        }
      }
      return null;
    },
    priorHRAtKm(km) {
      const arr = this.priorRun?.priorSegHR;
      if (!Array.isArray(arr)) return null;
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        if (km >= seg.startKm && km < seg.endKm) {
          return Number.isFinite(arr[i]) ? arr[i] : null;
        }
      }
      return null;
    },
    priorGradeAtKm(km) {
      const arr = this.priorRun?.priorSegGrade;
      if (!Array.isArray(arr)) return null;
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        if (km >= seg.startKm && km < seg.endKm) {
          return Number.isFinite(arr[i]) ? arr[i] : null;
        }
      }
      return null;
    },
    priorHRForSeg(i) {
      const arr = this.priorRun?.priorSegHR;
      return Array.isArray(arr) && Number.isFinite(arr[i]) ? arr[i] : null;
    },
    // Back-solve a prior-race GAP at the segment containing this km using the
    // plan's grade for that segment (the prior trace's own grade is available
    // via priorGradeAtKm but we standardise on plan grades for comparability).
    priorGapAtKm(km) {
      const arr = this.priorRun?.priorSegPaces;
      if (!Array.isArray(arr)) return null;
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        if (km >= seg.startKm && km < seg.endKm) {
          const pace = arr[i];
          if (!Number.isFinite(pace) || pace <= 0) return null;
          return gapFromPace(pace, seg.avgGradePct, this.uphillEffort);
        }
      }
      return null;
    },
    formatGrade(g) {
      if (!Number.isFinite(g)) return '—';
      return `${g >= 0 ? '+' : ''}${g.toFixed(1)}%`;
    },
    // True when prior is loaded with at least one finite HR sample. Used to
    // surface a "re-load for HR" hint when older persisted data (pre-round-6)
    // is restored without heart-rate values.
    get priorHasHR() {
      const arr = this.priorRun?.priorSegHR;
      return Array.isArray(arr) && arr.some(v => Number.isFinite(v));
    },
    // Build stop clusters from the prior trace. A cluster is a contiguous run
    // of trackpoints whose speed stayed below 1 m/s long enough to total ≥ 20
    // seconds — that filters out brief GPS-noise dips while still catching
    // every aid-station rest. Each cluster has a centerKm (avg of the runner's
    // position during the stop) and a duration.
    get _priorStopClusters() {
      if (!this.priorRun?.trackpoints?.length) return [];
      // Cache by trace identity so we don't rescan 50k records on every render.
      const key = `${this.priorRun.totalSec}:${this.priorRun.trackpoints.length}`;
      if (this._stopClustersCache?.key === key) return this._stopClustersCache.clusters;
      const tp = this.priorRun.trackpoints;
      const STOP_SPEED = 1.0;     // m/s — slow-walk threshold
      const MIN_DURATION = 20;    // s — ignore <20s dips (GPS jitter, brief slowdowns)
      const clusters = [];
      let i = 0;
      while (i < tp.length - 1) {
        const moving = !(Number.isFinite(tp[i].speedMs) && tp[i].speedMs < STOP_SPEED);
        if (moving) { i++; continue; }
        let j = i, total = 0, kmSum = 0, kmCount = 0;
        while (j < tp.length - 1 && Number.isFinite(tp[j].speedMs) && tp[j].speedMs < STOP_SPEED) {
          const dt = tp[j+1].timeSec - tp[j].timeSec;
          if (dt > 0) { total += dt; kmSum += tp[j].cumDistKm; kmCount++; }
          j++;
        }
        if (total >= MIN_DURATION && kmCount > 0) {
          clusters.push({
            centerKm: kmSum / kmCount,
            startKm: tp[i].cumDistKm,
            endKm: tp[Math.max(i, j-1)].cumDistKm,
            durationSec: total,
          });
        }
        i = j;
      }
      this._stopClustersCache = { key, clusters };
      return clusters;
    },

    // Map of cpKm → total prior stopped time. Each detected stop cluster is
    // assigned to its nearest checkpoint within 1 km; longer drives between
    // CPs that contain stops still get attributed (cluster picks closest CP).
    get _priorStopByCpKm() {
      const out = {};
      const cps = this.sortedValidCheckpoints;
      if (!cps?.length) return out;
      for (const cp of cps) out[cp.km] = 0;
      for (const c of this._priorStopClusters) {
        let bestCp = null, bestDist = Infinity;
        for (const cp of cps) {
          const d = Math.abs(c.centerKm - cp.km);
          if (d < bestDist) { bestDist = d; bestCp = cp; }
        }
        if (bestCp && bestDist <= 1.0) {
          out[bestCp.km] = (out[bestCp.km] || 0) + c.durationSec;
        }
      }
      return out;
    },

    // Time the prior racer spent stopped near a target km (typically a
    // checkpoint). Uses the cluster map so each stop is attributed to one CP.
    priorStopAtKm(km) {
      if (!Number.isFinite(km)) return 0;
      const map = this._priorStopByCpKm;
      return map[km] || 0;
    },

    // Toggle the autoAdjust flag on every drop-bag row in lockstep. Hits the
    // start inventory + every CP. If any row is currently OFF, turn them all
    // ON; otherwise turn them all OFF.
    toggleAdjustAll() {
      const rows = [this.nutrition?.startInventory, ...this.checkpoints.map(c => c?.dropbag)].filter(Boolean);
      if (!rows.length) return;
      const target = rows.some(r => !r.autoAdjust);
      this.snapshotThen(() => {
        for (const r of rows) r.autoAdjust = target;
        this.recompute();
      });
    },
    get adjustAllActive() {
      const rows = [this.nutrition?.startInventory, ...this.checkpoints.map(c => c?.dropbag)].filter(Boolean);
      return rows.length > 0 && rows.every(r => r.autoAdjust);
    },

    // Bulk-clear every drop-bag row (start inventory + every CP). Master
    // counterpart to the per-row "clear" button: zeroes gels, fluidL, waterL,
    // and the auto-fill notes so the user can rebuild the plan from scratch.
    clearAllRowSupplies() {
      const rows = [this.nutrition?.startInventory, ...this.checkpoints.map(c => c?.dropbag)].filter(Boolean);
      if (!rows.length) return;
      this.snapshotThen(() => {
        for (const r of rows) this.clearRowSupplies(r);
      });
    },

    // === Fluid required / collected / surplus helpers (drop-bag table) ====
    // Required fluid for the leg starting at this row already lives in
    // cpRestockNeed[uid].fluidL (litres). Collected = primary fluidL + waterL
    // because total fluid carried is what matters for surviving to the next
    // refill, regardless of which has carbs.
    fluidCollectedFor(rowSrc) {
      if (!rowSrc) return 0;
      return (Number(rowSrc.fluidL) || 0) + (Number(rowSrc.waterL) || 0);
    },
    fluidSurplusForKey(key) {
      // Forward-walking running balance — see _fwdFluidL in computeNutrition.
      // Cached on the chain entry so we don't re-walk per cell render.
      const cached = this._cpFluidRunningSurplus?.[key];
      if (cached != null) return cached;
      // Fallback: simple collected - needed (used before computeNutrition runs).
      let collected = 0;
      if (key === '__START__') collected = this.fluidCollectedFor(this.nutrition?.startInventory);
      else {
        const cp = this.checkpoints.find(c => c._uid === key);
        if (cp) collected = this.fluidCollectedFor(cp.dropbag);
      }
      const needed = this.cpRestockNeed?.[key]?.fluidL || 0;
      return collected - needed;
    },
    // Total stoppage time for a scenario (sum of all CPs' stops). For the
    // active scenario we compute fresh from current cp.stoppageSec rather
    // than reading this.totalStoppage — totalStoppage is set by recompute,
    // which hasn't run yet during a setActiveScenario switch (we need the
    // fresh value BEFORE we can derive moving = elapsed - stoppage). For
    // inactive scenarios we sum the saved cpStops map.
    scenarioStoppageSec(key) {
      if (this.activeScenario === key) {
        let s = 0;
        for (const cp of this.checkpoints) {
          if (cp && cp.km != null) s += Math.max(0, Number(cp.stoppageSec) || 0);
        }
        return s;
      }
      const sc = this.scenarios?.[key];
      if (!sc?.cpStops) return 0;
      let sum = 0;
      for (const v of Object.values(sc.cpStops)) sum += Number(v) || 0;
      return sum;
    },

    get totalFluidNeeded() {
      const need = this.cpRestockNeed || {};
      let sum = 0;
      // Sum the leg-required fluid for the start + every CP that's part of
      // the active restock chain. Mirrors how totalCarbsG is reported.
      const inv = this.nutrition?.startInventory;
      if (inv?.autoRestock) sum += need.__START__?.fluidL || 0;
      for (const cp of this.sortedValidCheckpoints) {
        if (cp.dropbag?.autoRestock) sum += need[cp._uid]?.fluidL || 0;
      }
      return sum;
    },
    get totalFluidSurplus() {
      const planned = (this.nutritionTotals?.plannedFluidL || 0) + (this.nutritionTotals?.plannedWaterL || 0);
      return planned - this.totalFluidNeeded;
    },

    // Prior-race hover bubble shown on the right side of the chart hint area
    // when a prior is loaded. Includes pace, GAP (back-solved at the prior
    // gradient), the prior trace's actual gradient at that km, and HR.
    priorRaceHoverPill(km) {
      if (!isFinite(km) || !this.priorRun) return '';
      const pace = this.priorPaceAtKm(km);
      const grade = this.priorGradeAtKm(km);
      const hr = this.priorHRAtKm(km);
      const planGrade = this.gradeAtKmHelper(km);
      const parts = [`prior @ km ${km.toFixed(2)}`];
      parts.push(`pace ${pace ? formatPace(pace) : '—'}/km`);
      if (Number.isFinite(grade) && Number.isFinite(pace) && pace > 0) {
        const gap = gapFromPace(pace, grade, this.uphillEffort);
        parts.push(`GAP ${Number.isFinite(gap) ? formatPace(gap) : '—'}/km`);
      } else {
        parts.push('GAP —');
      }
      const gradeStr = Number.isFinite(grade) ? `${grade >= 0 ? '+' : ''}${grade.toFixed(1)}%` : '—';
      const planGradeStr = Number.isFinite(planGrade) ? `${planGrade >= 0 ? '+' : ''}${planGrade.toFixed(1)}%` : '—';
      parts.push(`grade ${gradeStr} (plan ${planGradeStr})`);
      parts.push(`HR ${Number.isFinite(hr) ? Math.round(hr) + ' bpm' : '—'}`);
      return parts.join(' · ');
    },

    gradeAtKmHelper(km) {
      if (!this.segments?.length) return null;
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        if (km >= seg.startKm && km < seg.endKm) return seg.avgGradePct;
      }
      const last = this.segments[this.segments.length - 1];
      return km >= last?.endKm ? last.avgGradePct : null;
    },

    // === Pace-by-gradient prior-race statistics ============================
    // For each integer gradient bucket, gather the prior race's per-segment
    // paces from segments whose plan grade falls in [g-0.5, g+0.5) and compute
    // distribution stats. Cached lazily per recompute via _priorGradStatCache.
    priorGradStat(g, statKey, kind) {
      if (!this.priorRun?.priorSegPaces?.length || !this.segments?.length) return null;
      // Build cache once, keyed by gradient. Invalidate by length-change check.
      const cacheKey = `${this.segments.length}:${this.priorRun.totalSec}`;
      if (!this._priorGradStatCache || this._priorGradStatCache.key !== cacheKey) {
        const buckets = {};
        for (let i = 0; i < this.segments.length; i++) {
          const seg = this.segments[i];
          const p = this.priorRun.priorSegPaces[i];
          if (!Number.isFinite(p)) continue;
          const bucket = Math.round(seg.avgGradePct);
          (buckets[bucket] = buckets[bucket] || []).push(p);
        }
        for (const k of Object.keys(buckets)) buckets[k].sort((a, b) => a - b);
        this._priorGradStatCache = { key: cacheKey, buckets };
      }
      const arr = this._priorGradStatCache.buckets[g];
      if (!arr?.length) return null;
      const q = (frac) => {
        if (arr.length === 1) return arr[0];
        const pos = (arr.length - 1) * frac;
        const lo = Math.floor(pos), hi = Math.ceil(pos), w = pos - lo;
        return arr[lo] * (1 - w) + arr[hi] * w;
      };
      let val;
      if (statKey === 'q1') val = q(0.25);
      else if (statKey === 'med') val = q(0.5);
      else if (statKey === 'q3') val = q(0.75);
      else if (statKey === 'avg') val = arr.reduce((a, b) => a + b, 0) / arr.length;
      else return null;
      if (kind === 'pace') return val;
      if (kind === 'gap') return gapFromPace(val, g, this.uphillEffort);
      return null;
    },
    etaHoverPill(km) {
      if (!isFinite(km)) return '';
      const startSec = this.raceStartSec();
      const stoppageAt = buildStoppageAccumulator(this.sortedCheckpoints);
      const tSec = this.secondsAtKmHelper(km) + stoppageAt(km);
      return `km ${km.toFixed(2)} · ToD ${formatTimeOfDay(startSec + tSec)}`;
    },
    elevationHoverPill(km) {
      if (!isFinite(km)) return '';
      const ele = this.elevationAtKm(km);
      const pace = this.paceAtKm(km);
      const gap = this.gapAtKm(km);
      const elevTxt = ele != null ? `${Math.round(ele)} m` : '—';
      return `km ${km.toFixed(2)} · ele ${elevTxt} · Pace ${pace ? formatPace(pace) : '—'} · GAP ${gap ? formatPace(gap) : '—'}`;
    },

    secondsAtKmHelper(km) {
      if (!this.segments.length) return 0;
      if (km <= this.segments[0].startKm) return 0;
      const last = this.segments[this.segments.length - 1];
      if (km >= last.endKm) return this.segCumSec[this.segCumSec.length - 1];
      for (let i = 0; i < this.segments.length; i++) {
        const s = this.segments[i];
        if (km < s.endKm) {
          const prevCum = i === 0 ? 0 : this.segCumSec[i - 1];
          const segElapsed = this.segCumSec[i] - prevCum;
          const t = s.distKm > 0 ? (km - s.startKm) / s.distKm : 0;
          return prevCum + segElapsed * t;
        }
      }
      return this.segCumSec[this.segCumSec.length - 1];
    },

    refreshDerivedCharts() {
      if (!this.gpx) return;
      const sortedCps = this.sortedCheckpoints;
      if (document.getElementById('eta-chart') && !this.isCollapsed('eta')) {
        etaApi.initETAChart('eta-chart', this.segments, this.segCumSec, this.raceStartSec(), sortedCps, this.gpx.totalDistanceKm, { sunInfo: this.sunInfo });
        etaApi.onETAHover(km => setHoverKm(km));
        etaApi.setETALabelResolver(km => this.etaHoverPill(km));
      }
      if (document.getElementById('cumpace-chart') && !this.isCollapsed('cumpace')) {
        cumApi.initCumPaceChart('cumpace-chart', this.segments, this.segPaces, this.segGaps, this.segCumSec, this.gpx.totalDistanceKm, this.gpx.trackpoints, {
          showCumLabels: this.showCumLabels,
          showGAP: this.showCumGAP,
          checkpoints: sortedCps,
          priorCumPaces: this.priorRun?.priorCumAvgPaces || null,
          priorHR: this.priorRun?.priorSegHR || null,
          showPrior: !!this.showPriorOverlay.cumpace,
          showPriorHR: !!this.showPriorOverlay.cumpaceHR,
        });
        cumApi.onCumPaceHover(km => setHoverKm(km));
        cumApi.setCumPaceLabelResolver(km => this.cumPaceHoverPill(km));
      }
      if (document.getElementById('segpace-chart') && !this.isCollapsed('segpace')) {
        segPaceApi.initSegmentPaceChart('segpace-chart', this.segments, this.segPaces, this.gpx.totalDistanceKm, this.gpx.trackpoints, {
          showLabels: this.showSegLabels,
          checkpoints: sortedCps,
          priorPaces: this.priorRun?.priorSegPaces || null,
          priorHR: this.priorRun?.priorSegHR || null,
          showPrior: !!this.showPriorOverlay.segpace,
          showPriorHR: !!this.showPriorOverlay.segpaceHR,
        });
        segPaceApi.onSegmentPaceHover(km => setHoverKm(km));
        segPaceApi.setSegmentPaceLabelResolver(km => this.segPaceHoverPill(km));
      }
      if (document.getElementById('elevation-chart') && !this.isCollapsed('elev')) {
        elevApi.setElevationLabelResolver(km => this.elevationHoverPill(km));
      }
      if (this.gpx && !this.isCollapsed('map')) {
        mapApi.setCpLabelResolver(cp => this.cpLabelHTML(cp));
        mapApi.setCheckpoints(sortedCps);
      }
      if (this.gpx && !this.isCollapsed('p3d')) {
        p3dApi.setCpLabelResolver3D(cp => this.cpLabelHTML(cp));
        p3dApi.setCheckpoints3D(sortedCps);
      }
      if (document.getElementById('elevation-chart') && !this.isCollapsed('elev')) {
        elevApi.setElevationCheckpoints(sortedCps);
      }
    },

    updateCumLabels() { cumApi.setCumPaceLabels(this.showCumLabels); },
    updateSegLabels() { segPaceApi.setSegmentPaceLabels(this.showSegLabels); },
    updateCumGAP() { this.refreshDerivedCharts(); },

    raceStartSec() { return parseHHMMSS(this.raceStart); },

    // Sunrise/sunset/civil-twilight times for race day at the route's start
    // location. Approximation (no atmospheric refraction, no longitude time-
    // zone correction — assumes the race-day local solar noon is 12:00).
    // Good enough for the ETA chart's shading bands at trail-running latitudes.
    get sunInfo() {
      if (!this.raceDate || !this.gpx?.trackpoints?.length) return null;
      const tp0 = this.gpx.trackpoints[0];
      const lat = tp0.lat;
      // Day of year from the YYYY-MM-DD string
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(this.raceDate);
      if (!m) return null;
      const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      const yearStart = Date.UTC(+m[1], 0, 0);
      const N = Math.floor((date - yearStart) / 86400000);
      // Solar declination (°). 23.45° axial tilt, peaks near summer solstice
      // (day ~172 northern hemisphere).
      const declination = -23.45 * Math.cos(2 * Math.PI * (N + 10) / 365);
      const declRad = declination * Math.PI / 180;
      const latRad = lat * Math.PI / 180;
      const cosH = -Math.tan(latRad) * Math.tan(declRad);
      if (cosH > 1 || cosH < -1) return null; // polar night/day
      const H = Math.acos(cosH);
      const halfDayHours = (H * 180 / Math.PI) / 15;
      const noonLocal = 12;
      return {
        sunrise: noonLocal - halfDayHours,
        sunset: noonLocal + halfDayHours,
        civilDawn: Math.max(0, noonLocal - halfDayHours - 0.5),
        civilDusk: Math.min(24, noonLocal + halfDayHours + 0.5),
      };
    },

    onGoalTimeEdit() {
      const sec = parseHHMMSS(this.goalTimeText);
      if (sec > 0) {
        this.snapshotThen(() => {
          this.goal.mode = 'time';
          this.goal.timeSec = sec;
          this.goalTimeText = formatHHMMSS(sec);
          if (this.activeScenario === 'prior') this.activeScenario = 'A';
          this.recompute();
          if (this.activeScenario === 'A' || this.activeScenario === 'B' || this.activeScenario === 'C') {
            this.scenarios[this.activeScenario].mode = 'time';
            this._syncDerivedToScenario(this.activeScenario);
          }
        });
      }
    },
    onGoalPaceEdit() {
      const sec = parsePace(this.goalPaceText);
      if (sec > 0) {
        this.snapshotThen(() => {
          this.goal.mode = 'pace';
          this.goal.paceSecPerKm = sec;
          this.goalPaceText = formatPace(sec);
          if (this.activeScenario === 'prior') this.activeScenario = 'A';
          this.recompute();
          if (this.activeScenario === 'A' || this.activeScenario === 'B' || this.activeScenario === 'C') {
            this.scenarios[this.activeScenario].mode = 'pace';
            this._syncDerivedToScenario(this.activeScenario);
          }
        });
      }
    },
    onGoalGapEdit() {
      const sec = parsePace(this.goalGapText);
      if (sec > 0) {
        this.snapshotThen(() => {
          this.goal.mode = 'gap';
          this.goal.gapSecPerKm = sec;
          this.goalGapText = formatPace(sec);
          if (this.activeScenario === 'prior') this.activeScenario = 'A';
          this.recompute();
          if (this.activeScenario === 'A' || this.activeScenario === 'B' || this.activeScenario === 'C') {
            this.scenarios[this.activeScenario].mode = 'gap';
            this._syncDerivedToScenario(this.activeScenario);
          }
        });
      }
    },

    // === Scenarios + match-prior ===========================================
    scenarioImpliedGap(key) {
      // Best-effort GAP for a scenario row: only meaningful when the scenario
      // is currently active (the live goal.gapSecPerKm reflects it). For non-
      // active rows we return null so the cell shows '—' instead of stale GAP.
      if (this.activeScenario !== key) return null;
      return this.goal.gapSecPerKm;
    },

    // Snapshot the current per-segment edits into the named scenario. Called
    // when leaving a scenario so the user's edits stay tied to that plan and
    // don't bleed over into the next active scenario.
    _saveCurrentEditsToScenario(key) {
      const sc = this.scenarios[key];
      if (!sc) return;
      sc.overrides = this.overrides.map(o => ({ ...o }));
      sc.gradientPaceOverrides = { ...(this.gradientPaceOverrides || {}) };
      sc.technicalGradientPaceOverrides = { ...(this.technicalGradientPaceOverrides || {}) };
      sc.technicalIndices = [...(this.technicalIndices || [])];
      sc.priorMatchedIndices = [...(this.priorMatchedIndices || [])];
      sc.paceShift = { mode: this.paceShift?.mode || 'gap', value: Number(this.paceShift?.value) || 0 };
      // Per-CP stoppage map (uid → seconds) so each scenario keeps its own
      // aid-station stopping plan. This is what makes elapsed time correct
      // when the user picks the Prior race scenario — it loads the prior's
      // detected stops, recompute sums them into totalStoppage, and
      // elapsed = moving + stops matches the prior's actual elapsed time.
      sc.cpStops = {};
      for (const cp of this.checkpoints) {
        if (cp._uid) sc.cpStops[cp._uid] = Math.max(0, Math.round(cp.stoppageSec || 0));
      }
    },
    _loadScenarioEdits(key) {
      const sc = this.scenarios[key];
      if (!sc) return;
      this.overrides = (sc.overrides || []).map(o => ({ ...o }));
      this.gradientPaceOverrides = { ...(sc.gradientPaceOverrides || {}) };
      this.technicalGradientPaceOverrides = { ...(sc.technicalGradientPaceOverrides || {}) };
      this.technicalIndices = [...(sc.technicalIndices || [])];
      this.priorMatchedIndices = [...(sc.priorMatchedIndices || [])];
      this.paceShift = sc.paceShift
        ? { mode: ['gap','percent','seconds'].includes(sc.paceShift.mode) ? sc.paceShift.mode : 'gap',
            value: Number(sc.paceShift.value) || 0 }
        : { mode: 'gap', value: 0 };
      if (sc.cpStops && typeof sc.cpStops === 'object') {
        for (const cp of this.checkpoints) {
          if (cp._uid && cp._uid in sc.cpStops) cp.stoppageSec = sc.cpStops[cp._uid];
        }
      }
    },
    // For the prior scenario specifically: write each CP's detected prior-race
    // stop time into cp.stoppageSec so totalStoppage reflects actual prior
    // stops. Only runs on FIRST activation (when scenarios.prior.cpStops is
    // empty); subsequent activations restore the user's saved tweaks.
    _seedPriorScenarioCpStops() {
      if (!this.priorRun) return;
      for (const cp of this.checkpoints) {
        if (cp.km != null && Number.isFinite(cp.km)) {
          cp.stoppageSec = Math.round(this.priorStopAtKm(cp.km));
        }
      }
    },

    // === Pace shift (V4 v4.2) ============================
    // Per-scenario knob to shift the WHOLE plan up/down without losing
    // per-segment edits. Three modes:
    //   gap   — adjust base GAP by value sec/km (overrides untouched)
    //   percent — multiply every segment pace by (1 + value/100)
    //   seconds — add value sec/km to every segment pace
    // Mirrored on the active scenario via _save/_load.

    setPaceShiftMode(mode) {
      if (!['gap', 'percent', 'seconds'].includes(mode)) return;
      this.snapshotThen(() => {
        // Reset value when switching modes so the user doesn't double-up
        // (e.g. -5% turning into -5 sec on mode flip).
        this.paceShift = { mode, value: 0 };
        if (this.scenarios[this.activeScenario]) {
          this.scenarios[this.activeScenario].paceShift = { ...this.paceShift };
        }
        this.recompute();
      });
    },

    setPaceShiftValue(v) {
      const num = Number(v);
      this.paceShift = { ...this.paceShift, value: Number.isFinite(num) ? num : 0 };
      if (this.scenarios[this.activeScenario]) {
        this.scenarios[this.activeScenario].paceShift = { ...this.paceShift };
      }
      this.recompute();
    },

    bumpPaceShiftValue(delta) {
      this.snapshotThen(() => this.setPaceShiftValue((this.paceShift?.value || 0) + delta));
    },

    resetPaceShift() {
      this.snapshotThen(() => {
        this.paceShift = { ...this.paceShift, value: 0 };
        if (this.scenarios[this.activeScenario]) {
          this.scenarios[this.activeScenario].paceShift = { ...this.paceShift };
        }
        this.recompute();
      });
    },

    get paceShiftUnitLabel() {
      if (this.paceShift?.mode === 'percent') return '%';
      if (this.paceShift?.mode === 'seconds') return 's/km';
      return 's/km (GAP)';
    },

    // Returns the estimated total-time delta the current shift will yield,
    // in seconds. Used by the panel to surface "−4:23 over the race" so
    // Jeff can dial in a target finish-time delta intuitively. Approximate
    // — computed from the LAST recompute's totalKm.
    get paceShiftFinishDelta() {
      const shift = this.paceShift || { value: 0 };
      const km = this.gpx?.totalDistanceKm || 0;
      if (!km || !shift.value) return 0;
      if (shift.mode === 'percent') return this.totalSec * (shift.value / 100);
      if (shift.mode === 'seconds') return shift.value * km;
      // gap mode: rough estimate — base-GAP shift propagates through
      // computeSegmentPaces non-linearly, so just show value × km.
      return shift.value * km;
    },

    // Copy Plan A's per-segment edits, gradient overrides, technical
    // flags, AND pace shift into the target scenario (B or C). Used by
    // the "Match A" button so Jeff can fork A as a starting point for B
    // (and then tweak from there without re-editing every segment).
    // Skips the scenario's `mode`/`timeSec`/`paceSecPerKm`/`gapSecPerKm`
    // — those are the goal-row inputs the user types per scenario.
    matchScenarioToA(targetKey) {
      if (targetKey === 'A' || !this.scenarios[targetKey] || !this.scenarios.A) return;
      this.snapshotThen(() => {
        const A = this.scenarios.A;
        const target = this.scenarios[targetKey];
        target.overrides = (A.overrides || []).map(o => ({ ...o }));
        target.gradientPaceOverrides = { ...(A.gradientPaceOverrides || {}) };
        target.technicalGradientPaceOverrides = { ...(A.technicalGradientPaceOverrides || {}) };
        target.technicalIndices = [...(A.technicalIndices || [])];
        target.priorMatchedIndices = [...(A.priorMatchedIndices || [])];
        target.paceShift = A.paceShift ? { ...A.paceShift } : { mode: 'gap', value: 0 };
        // If the target is the active scenario, reload edits live so the
        // user sees the match immediately.
        if (this.activeScenario === targetKey) {
          this._loadScenarioEdits(targetKey);
          this.recompute();
        }
      });
      debouncedSave(this);
    },

    setActiveScenario(key) {
      if (this.activeScenario === key) return;

      // Save the outgoing scenario's edits (overrides, gradient overrides,
      // technical flags, prior-match indices) so switching back later restores
      // exactly that plan's working state.
      this._saveCurrentEditsToScenario(this.activeScenario);

      if (key === 'prior') {
        if (!this.priorRun) return;
        this.snapshotThen(() => {
          this.activeScenario = 'prior';
          this._loadScenarioEdits('prior');
          // First activation: seed per-segment overrides + per-CP stops from
          // the prior race. Subsequent activations restore saved edits.
          if (!this.scenarios.prior.overrides?.length) {
            this._applyMatchAllPrior();
          }
          if (!this.scenarios.prior.cpStops || !Object.keys(this.scenarios.prior.cpStops).length) {
            this._seedPriorScenarioCpStops();
          }
          this.goal.mode = 'time';
          // The model's moving-time target = prior's actual moving time. The
          // scenario's displayed goal time = elapsed (matches Strava/Garmin
          // finish-time convention). After recompute, scenario.timeSec gets
          // sync'd to elapsed via _syncDerivedToScenario.
          this.goal.timeSec = this.priorRun.totalMovingTime || this.priorRun.totalSec;
          this.goalTimeText = formatHHMMSS(this.goal.timeSec);
          this.recompute();
          // Scenario goal time = elapsed (use FIT's totalElapsedTime as the
          // canonical prior race finish time, even if computed-stoppage drifts
          // slightly from FIT's stopped-time figure).
          this.scenarios.prior.timeSec = Math.round(this.priorRun.totalElapsedTime || (this.totalSec + this.totalStoppage));
          this.scenarios.prior.paceSecPerKm = Math.round(this.goal.paceSecPerKm || 0);
          this.scenarios.prior.gapSecPerKm = Math.round(this.goal.gapSecPerKm || 0);
        });
        return;
      }
      // A, B, or C
      const sc = this.scenarios[key];
      if (!sc) return;
      const mode = sc.mode || 'time';
      const hasValue =
        (mode === 'time' && sc.timeSec > 0) ||
        (mode === 'pace' && sc.paceSecPerKm > 0) ||
        (mode === 'gap' && sc.gapSecPerKm > 0);
      this.snapshotThen(() => {
        this.activeScenario = key;
        // Load this scenario's per-segment edits + flags. cpStops are
        // restored too, so scenarioStoppageSec is correct on the next read.
        this._loadScenarioEdits(key);
        if (hasValue) {
          this.goal.mode = mode;
          if (mode === 'time') {
            // scenario.timeSec is elapsed (goal time). Model uses moving.
            const stoppage = this.scenarioStoppageSec(key);
            const moving = Math.max(0, sc.timeSec - stoppage);
            this.goal.timeSec = moving;
            this.goalTimeText = formatHHMMSS(moving);
          } else if (mode === 'pace') {
            this.goal.paceSecPerKm = sc.paceSecPerKm;
            this.goalPaceText = formatPace(sc.paceSecPerKm);
          } else {
            this.goal.gapSecPerKm = sc.gapSecPerKm;
            this.goalGapText = formatPace(sc.gapSecPerKm);
          }
        }
        this.recompute();
        if (hasValue) this._syncDerivedToScenario(key);
      });
    },

    // After a recompute driven by scenario `key`, copy the live derived
    // goal.timeSec/paceSecPerKm/gapSecPerKm back into the scenario. The
    // scenario's `timeSec` is now the user-facing GOAL TIME which INCLUDES
    // stoppage (= moving + stoppage). The model's `goal.timeSec` is the
    // moving-time recompute target. So we add stoppage when syncing.
    _syncDerivedToScenario(key) {
      const sc = this.scenarios[key];
      if (!sc) return;
      const stoppage = this.scenarioStoppageSec(key);
      sc.timeSec = Math.round((this.goal.timeSec || 0) + stoppage);
      sc.paceSecPerKm = Math.round(this.goal.paceSecPerKm || 0);
      sc.gapSecPerKm = Math.round(this.goal.gapSecPerKm || 0);
    },

    // Derive the missing (pace, GAP, time) fields for an INACTIVE scenario so
    // its row shows live numbers without having to flip the radio. The active
    // scenario is kept in sync via _syncDerivedToScenario after each recompute;
    // this function does the equivalent computation for a non-active scenario
    // using its stored mode + value.
    _deriveScenarioFromMode(key) {
      if (this.activeScenario === key) return;
      const sc = this.scenarios[key];
      if (!sc || !this.gpx || !this.segments.length) return;
      const techSet = new Set(this.technicalIndices);
      const totalKm = this.gpx.totalDistanceKm;
      const stoppage = this.scenarioStoppageSec(key);
      // scenario.timeSec is the user-facing GOAL TIME (elapsed). Internally
      // we always solve for MOVING time = elapsed - stoppage; pace is moving
      // pace; GAP comes from gapForTargetTime against moving.
      if (sc.mode === 'time' && sc.timeSec > 0) {
        const moving = Math.max(0, sc.timeSec - stoppage);
        sc.paceSecPerKm = totalKm > 0 ? moving / totalKm : 0;
        sc.gapSecPerKm = gapForTargetTime(
          this.segments, moving, totalKm,
          this.splitBias, this.uphillEffort, techSet, this.technicalSlowdown,
        );
      } else if (sc.mode === 'pace' && sc.paceSecPerKm > 0) {
        const moving = sc.paceSecPerKm * totalKm;
        sc.timeSec = Math.round(moving + stoppage);
        sc.gapSecPerKm = gapForTargetTime(
          this.segments, moving, totalKm,
          this.splitBias, this.uphillEffort, techSet, this.technicalSlowdown,
        );
      } else if (sc.mode === 'gap' && sc.gapSecPerKm > 0) {
        let moving = 0;
        for (let i = 0; i < this.segments.length; i++) {
          const seg = this.segments[i];
          const techMul = techSet.has(i) ? this.technicalSlowdown : 1;
          const pace = paceFromGap(sc.gapSecPerKm, seg.avgGradePct, this.uphillEffort) * techMul;
          moving += pace * seg.distKm;
        }
        sc.timeSec = Math.round(moving + stoppage);
        sc.paceSecPerKm = totalKm > 0 ? moving / totalKm : 0;
      }
    },

    _refreshInactiveScenarios() {
      for (const key of ['A', 'B', 'C']) {
        if (this.activeScenario !== key) this._deriveScenarioFromMode(key);
      }
    },

    // Distance-weighted average prior race GAP across plan segments. We
    // back-solve GAP per segment from the prior pace at that segment using the
    // current uphillEffort + tech multipliers; then weight by segment distance.
    // Returns null when no prior is loaded or alignment hasn't been run yet.
    get priorRaceGap() {
      const arr = this.priorRun?.priorSegPaces;
      if (!Array.isArray(arr) || !this.segments.length) return null;
      let weighted = 0;
      let dist = 0;
      for (let i = 0; i < this.segments.length; i++) {
        const p = arr[i];
        if (!Number.isFinite(p) || p <= 0) continue;
        const seg = this.segments[i];
        const techMul = this.technicalIndices.includes(i) ? this.technicalSlowdown : 1;
        const baselinePace = p / Math.max(0.001, techMul);
        const segGap = gapFromPace(baselinePace, seg.avgGradePct, this.uphillEffort);
        if (Number.isFinite(segGap)) {
          weighted += segGap * seg.distKm;
          dist += seg.distKm;
        }
      }
      return dist > 0 ? weighted / dist : null;
    },

    onScenarioTimeEdit(key, event) {
      // The user enters GOAL TIME (= elapsed = moving + stoppage). The model
      // recomputes against MOVING time = elapsed - stoppage.
      const elapsed = parseHHMMSS(event.target.value);
      if (!Number.isFinite(elapsed) || elapsed < 0) return;
      const sc = this.scenarios[key];
      this.snapshotThen(() => {
        sc.timeSec = elapsed;
        sc.mode = 'time';
        if (this.activeScenario === key && elapsed > 0) {
          const stoppage = this.scenarioStoppageSec(key);
          const moving = Math.max(0, elapsed - stoppage);
          this.goal.mode = 'time';
          this.goal.timeSec = moving;
          this.goalTimeText = formatHHMMSS(moving);
          this.recompute();
          this._syncDerivedToScenario(key);
        } else {
          this._deriveScenarioFromMode(key);
        }
      });
    },
    onScenarioPaceEdit(key, event) {
      const sec = parsePace(event.target.value);
      if (!Number.isFinite(sec) || sec <= 0) return;
      const sc = this.scenarios[key];
      this.snapshotThen(() => {
        sc.paceSecPerKm = sec;
        sc.mode = 'pace';
        if (this.activeScenario === key) {
          this.goal.mode = 'pace';
          this.goal.paceSecPerKm = sec;
          this.goalPaceText = formatPace(sec);
          this.recompute();
          this._syncDerivedToScenario(key);
        } else {
          this._deriveScenarioFromMode(key);
        }
      });
    },
    onScenarioGapEdit(key, event) {
      const sec = parsePace(event.target.value);
      if (!Number.isFinite(sec) || sec <= 0) return;
      const sc = this.scenarios[key];
      this.snapshotThen(() => {
        sc.gapSecPerKm = sec;
        sc.mode = 'gap';
        if (this.activeScenario === key) {
          this.goal.mode = 'gap';
          this.goal.gapSecPerKm = sec;
          this.goalGapText = formatPace(sec);
          this.recompute();
          this._syncDerivedToScenario(key);
        } else {
          this._deriveScenarioFromMode(key);
        }
      });
    },

    bumpScenarioTime(key, d) {
      const sc = this.scenarios[key];
      if (!sc) return;
      const cur = sc.timeSec || this.goal.timeSec || 0;
      const next = Math.max(0, cur + d);
      this.onScenarioTimeEdit(key, { target: { value: formatHHMMSS(next) } });
    },
    bumpScenarioPace(key, d) {
      const sc = this.scenarios[key];
      if (!sc) return;
      const cur = sc.paceSecPerKm || this.goal.paceSecPerKm || 0;
      const next = Math.max(60, cur + d);
      this.onScenarioPaceEdit(key, { target: { value: formatPace(next) } });
    },
    bumpScenarioGap(key, d) {
      const sc = this.scenarios[key];
      if (!sc) return;
      const cur = sc.gapSecPerKm || this.goal.gapSecPerKm || 0;
      const next = Math.max(60, cur + d);
      this.onScenarioGapEdit(key, { target: { value: formatPace(next) } });
    },

    saveCurrentToScenario(key) {
      if (!this.gpx || !(key === 'A' || key === 'B' || key === 'C')) return;
      this.snapshotThen(() => {
        this.scenarios[key].timeSec = Math.max(0, Math.round(this.totalSec || this.goal.timeSec || 0));
        this.scenarios[key].paceSecPerKm = Math.max(0, Math.round(this.goal.paceSecPerKm || 0));
        this.scenarios[key].gapSecPerKm = Math.max(0, Math.round(this.goal.gapSecPerKm || 0));
        this.scenarios[key].mode = this.goal.mode;
      });
    },

    isPriorMatched(idx) {
      return this.priorMatchedIndices.includes(idx);
    },

    matchPriorPaceForSeg(idx) {
      const priorPace = this.priorRun?.priorSegPaces?.[idx];
      if (!Number.isFinite(priorPace) || priorPace <= 0) return;
      const seg = this.segments[idx];
      if (!seg) return;
      const techMul = this.technicalIndices.includes(idx) ? this.technicalSlowdown : 1;
      // Convert displayed pace → baseline (pre-tech) → GAP via Minetti.
      const baselinePace = priorPace / Math.max(0.001, techMul);
      const newGap = gapFromPace(baselinePace, seg.avgGradePct, this.uphillEffort);
      this.snapshotThen(() => {
        this.setOverride(idx, newGap, 'point');
        if (!this.priorMatchedIndices.includes(idx)) this.priorMatchedIndices.push(idx);
        this.recompute();
      });
    },

    unmatchPriorPaceForSeg(idx) {
      this.snapshotThen(() => {
        this.overrides = this.overrides.filter(o => o.idx !== idx);
        this.priorMatchedIndices = this.priorMatchedIndices.filter(i => i !== idx);
        this.recompute();
      });
    },

    togglePriorMatch(idx) {
      if (this.isPriorMatched(idx)) this.unmatchPriorPaceForSeg(idx);
      else this.matchPriorPaceForSeg(idx);
    },

    // Apply per-segment prior-pace overrides without taking a fresh snapshot
    // or recomputing — the caller is expected to do those. Manual overrides
    // (overrides on segments NOT in priorMatchedIndices) are preserved so
    // switching to the prior scenario or hitting Match-all doesn't blow away
    // the user's hand-edits.
    _applyMatchAllPrior() {
      if (!this.priorRun?.priorSegPaces?.length) return;
      const existingMatched = new Set(this.priorMatchedIndices);
      const matched = [];
      for (let i = 0; i < this.segments.length; i++) {
        const priorPace = this.priorRun.priorSegPaces[i];
        if (!Number.isFinite(priorPace) || priorPace <= 0) continue;
        const seg = this.segments[i];
        if (!seg) continue;
        const existing = this.overrides.find(o => o.idx === i);
        if (existing && !existingMatched.has(i)) continue; // preserve manual
        const techMul = this.technicalIndices.includes(i) ? this.technicalSlowdown : 1;
        const baselinePace = priorPace / Math.max(0.001, techMul);
        const newGap = gapFromPace(baselinePace, seg.avgGradePct, this.uphillEffort);
        this.setOverride(i, newGap, 'point');
        matched.push(i);
      }
      this.priorMatchedIndices = matched;
    },

    matchAllPrior() {
      if (!this.priorRun?.priorSegPaces?.length) return;
      this.snapshotThen(() => {
        this._applyMatchAllPrior();
        this.recompute();
      });
    },

    clearAllPriorMatches() {
      if (!this.priorMatchedIndices.length) return;
      this.snapshotThen(() => {
        const matchedSet = new Set(this.priorMatchedIndices);
        this.overrides = this.overrides.filter(o => !matchedSet.has(o.idx));
        this.priorMatchedIndices = [];
        this.recompute();
      });
    },

    // === Per-cell ▲▼ steppers (per-segment grid) ============================
    // For GAP / Pace: snap to the nearest 5-second boundary in the bump
    // direction. Logic: if the current value isn't already on a multiple of 5,
    // jump straight to the next-lower (or next-higher) boundary; if it IS on
    // one, step by 5. Either way the result is always a multiple of 5.
    _bump5snap(cur, dir) {
      const c = Math.round(Number(cur) || 0);
      if (c % 5 === 0) return c + 5 * dir;
      return dir > 0 ? Math.ceil(c / 5) * 5 : Math.floor(c / 5) * 5;
    },

    bumpSegGap(idx, dir) {
      const cur = this.segGaps[idx];
      if (!Number.isFinite(cur)) return;
      const next = this._bump5snap(cur, dir);
      if (next <= 0) return;
      this.snapshotThen(() => { this.setOverride(idx, next); this.recompute(); });
    },

    bumpSegPace(idx, dir) {
      const cur = this.segPaces[idx];
      if (!Number.isFinite(cur)) return;
      const next = this._bump5snap(cur, dir);
      if (next <= 0) return;
      const seg = this.segments[idx];
      if (!seg) return;
      const techMul = this.technicalIndices.includes(idx) ? this.technicalSlowdown : 1;
      const baselinePace = next / Math.max(0.001, techMul);
      const newGap = gapFromPace(baselinePace, seg.avgGradePct, this.uphillEffort);
      this.snapshotThen(() => { this.setOverride(idx, newGap); this.recompute(); });
    },

    // Elapsed (cumWithStop), ETA, and stoppage steppers move by ±5 without
    // snapping — they already represent absolute clock time and the user is
    // typically nudging by a few seconds.
    bumpSegCum(idx, dir) {
      const seg = this.segments[idx];
      if (!seg) return;
      const curCumWithStop = Math.round(this.segCumWithStop[idx] || 0);
      const newCumWithStop = curCumWithStop + 5 * dir;
      const sortedCps = this.sortedCheckpoints;
      const stoppageAt = buildStoppageAccumulator(sortedCps);
      const newCum = newCumWithStop - stoppageAt(seg.endKm);
      const prevCum = idx === 0 ? 0 : this.segCumSec[idx - 1];
      const segTime = newCum - prevCum;
      if (segTime <= 0) return;
      const newPace = segTime / seg.distKm;
      const techMul = this.technicalIndices.includes(idx) ? this.technicalSlowdown : 1;
      const newGap = gapFromPace(newPace / Math.max(0.001, techMul), seg.avgGradePct, this.uphillEffort);
      this.snapshotThen(() => { this.setOverride(idx, newGap); this.recompute(); });
    },

    bumpSegETA(idx, dir) {
      const seg = this.segments[idx];
      if (!seg) return;
      const curEta = parseHHMMSS(this.segETAs[idx] || '');
      if (!Number.isFinite(curEta)) return;
      const newEta = curEta + 5 * dir;
      const raceStart = this.raceStartSec();
      const newCumWithStop = newEta - raceStart;
      if (newCumWithStop <= 0) return;
      const sortedCps = this.sortedCheckpoints;
      const stoppageAt = buildStoppageAccumulator(sortedCps);
      const newCum = newCumWithStop - stoppageAt(seg.endKm);
      const prevCum = idx === 0 ? 0 : this.segCumSec[idx - 1];
      const segTime = newCum - prevCum;
      if (segTime <= 0) return;
      const newPace = segTime / seg.distKm;
      const techMul = this.technicalIndices.includes(idx) ? this.technicalSlowdown : 1;
      const newGap = gapFromPace(newPace / Math.max(0.001, techMul), seg.avgGradePct, this.uphillEffort);
      this.snapshotThen(() => { this.setOverride(idx, newGap); this.recompute(); });
    },

    onMovingTimeEdit(idx, event) {
      // Moving time = segCumSec[idx] (no stoppage). Editing it adjusts the
      // segment's pace via the same back-solve as onCumEdit, just without
      // the stoppage-accumulator subtraction (since cumWithStop !== cum here).
      const newCum = parseHHMMSS(event.target.value);
      if (!isFinite(newCum) || newCum <= 0) { this.recompute(); return; }
      const seg = this.segments[idx];
      if (!seg) return;
      const prevCum = idx === 0 ? 0 : this.segCumSec[idx - 1];
      const segTime = newCum - prevCum;
      if (segTime <= 0) { alert('Moving time must be greater than the previous segment.'); this.recompute(); return; }
      const newPace = segTime / seg.distKm;
      const techMul = this.technicalIndices.includes(idx) ? this.technicalSlowdown : 1;
      const newGap = gapFromPace(newPace / Math.max(0.001, techMul), seg.avgGradePct, this.uphillEffort);
      this.snapshotThen(() => { this.setOverride(idx, newGap); this.recompute(); });
    },

    bumpSegMovingTime(idx, dir) {
      const seg = this.segments[idx];
      if (!seg) return;
      const cur = Math.round(this.segCumSec[idx] || 0);
      const next = cur + 5 * dir;
      if (next <= 0) return;
      const prevCum = idx === 0 ? 0 : this.segCumSec[idx - 1];
      const segTime = next - prevCum;
      if (segTime <= 0) return;
      const newPace = segTime / seg.distKm;
      const techMul = this.technicalIndices.includes(idx) ? this.technicalSlowdown : 1;
      const newGap = gapFromPace(newPace / Math.max(0.001, techMul), seg.avgGradePct, this.uphillEffort);
      this.snapshotThen(() => { this.setOverride(idx, newGap); this.recompute(); });
    },

    bumpStoppage(cp, dir) {
      if (!cp) return;
      const cur = Math.max(0, Math.round(cp.stoppageSec || 0));
      const next = Math.max(0, cur + 5 * dir);
      if (next === cur) return;
      this.snapshotThen(() => {
        cp.stoppageSec = next;
        this.recompute();
      });
    },

    bumpGoalTime(d) { const cur = parseHHMMSS(this.goalTimeText) || this.goal.timeSec; this.goalTimeText = formatHHMMSS(Math.max(0, cur + d)); this.onGoalTimeEdit(); },
    bumpGoalPace(d) { const cur = parsePace(this.goalPaceText) || this.goal.paceSecPerKm; this.goalPaceText = formatPace(Math.max(60, cur + d)); this.onGoalPaceEdit(); },
    bumpGoalGap(d)  { const cur = parsePace(this.goalGapText) || this.goal.gapSecPerKm;   this.goalGapText  = formatPace(Math.max(60, cur + d)); this.onGoalGapEdit(); },
    bumpSplitKm(d)  { this.splitKm = Math.max(0.5, Math.round((Number(this.splitKm) + d) * 2) / 2); this.rebuildSegments(); },

    setOverride(idx, gapSecPerKm, mode) {
      const existing = this.overrides.find(o => o.idx === idx);
      if (existing) {
        existing.gapSecPerKm = gapSecPerKm;
        if (mode) existing.mode = mode;
      } else {
        this.overrides.push({ idx, gapSecPerKm, mode: mode || this.defaultEditMode });
      }
    },
    onGapEdit(idx, event) {
      const newGap = parsePace(event.target.value);
      if (!isFinite(newGap) || newGap <= 0) { this.recompute(); return; }
      this.snapshotThen(() => { this.setOverride(idx, newGap); this.recompute(); });
    },
    onPaceEdit(idx, event) {
      const newPace = parsePace(event.target.value);
      if (!isFinite(newPace) || newPace <= 0) { this.recompute(); return; }
      const seg = this.segments[idx];
      const techMul = this.technicalIndices.includes(idx) ? this.technicalSlowdown : 1;
      // The user enters the displayed pace; back out the GAP so the displayed pace == newPace.
      const baselinePace = newPace / techMul;
      const newGap = gapFromPace(baselinePace, seg.avgGradePct, this.uphillEffort);
      this.snapshotThen(() => { this.setOverride(idx, newGap); this.recompute(); });
    },
    // Drag-to-edit on the segment pace chart: the user drags a segment up (faster) or
    // down (slower) and on mouseup we lock it as a per-segment override. Goes through
    // the same setOverride path as the typed-in pace cell so undo works the same way.
    onSegPaceDrag(idx, paceSec) {
      if (!isFinite(paceSec) || paceSec <= 0) { this.recompute(); return; }
      const seg = this.segments[idx];
      if (!seg) return;
      const techMul = this.technicalIndices.includes(idx) ? this.technicalSlowdown : 1;
      const baselinePace = paceSec / techMul;
      const newGap = gapFromPace(baselinePace, seg.avgGradePct, this.uphillEffort);
      this.snapshotThen(() => { this.setOverride(idx, newGap); this.recompute(); });
    },
    onCumEdit(idx, event) {
      // The display value already includes cumulative stoppage at this segment's endpoint.
      const newCumWithStop = parseHHMMSS(event.target.value);
      if (!isFinite(newCumWithStop) || newCumWithStop <= 0) { this.recompute(); return; }
      const sortedCps = this.sortedCheckpoints;
      const stoppageAt = buildStoppageAccumulator(sortedCps);
      const seg = this.segments[idx];
      const newCum = newCumWithStop - stoppageAt(seg.endKm);
      const prevCum = idx === 0 ? 0 : this.segCumSec[idx - 1];
      const segTime = newCum - prevCum;
      if (segTime <= 0) { alert('Cum time must be greater than the previous segment.'); this.recompute(); return; }
      const newPace = segTime / seg.distKm;
      const techMul = this.technicalIndices.includes(idx) ? this.technicalSlowdown : 1;
      const newGap = gapFromPace(newPace / techMul, seg.avgGradePct, this.uphillEffort);
      this.snapshotThen(() => { this.setOverride(idx, newGap); this.recompute(); });
    },
    onETAEdit(idx, event) {
      const seg = this.segments[idx];
      const sortedCps = this.sortedCheckpoints;
      const stoppageAt = buildStoppageAccumulator(sortedCps);
      const newETASec = parseHHMMSS(event.target.value);
      if (!isFinite(newETASec) || newETASec <= 0) { this.recompute(); return; }
      const targetCum = newETASec - this.raceStartSec() - stoppageAt(seg.endKm);
      const prevCum = idx === 0 ? 0 : this.segCumSec[idx - 1];
      const segTime = targetCum - prevCum;
      if (segTime <= 0) { alert('ETA must be after the previous segment.'); this.recompute(); return; }
      const newPace = segTime / seg.distKm;
      const techMul = this.technicalIndices.includes(idx) ? this.technicalSlowdown : 1;
      const newGap = gapFromPace(newPace / techMul, seg.avgGradePct, this.uphillEffort);
      this.snapshotThen(() => { this.setOverride(idx, newGap); this.recompute(); });
    },
    clearOverride(idx) { this.snapshotThen(() => { this.overrides = this.overrides.filter(o => o.idx !== idx); this.recompute(); }); },
    clearAllOverrides() {
      if (!this.overrides.length) return;
      if (!confirm(`Clear all ${this.overrides.length} segment edits?`)) return;
      this.snapshotThen(() => { this.overrides = []; this.recompute(); });
    },
    isOverride(idx) { return this.overrides.some(o => o.idx === idx); },
    overrideMode(idx) { return this.overrides.find(o => o.idx === idx)?.mode || 'point'; },
    toggleOverrideMode(idx) {
      const ov = this.overrides.find(o => o.idx === idx);
      if (!ov) return;
      this.snapshotThen(() => {
        ov.mode = (ov.mode || 'point') === 'point' ? 'anchor' : 'point';
        this.recompute();
      });
    },

    // Technical
    isTechnical(idx) { return this.technicalIndices.includes(idx); },
    toggleTechnical(idx) {
      this.snapshotThen(() => {
        if (this.technicalIndices.includes(idx)) this.technicalIndices = this.technicalIndices.filter(i => i !== idx);
        else this.technicalIndices = [...this.technicalIndices, idx].sort((a, b) => a - b);
        this.recompute();
      });
    },

    // Gradient overrides — "default pace" = goal-GAP applied at this grade.
    defaultPaceFor(grade) { return paceFromGap(this.goal.gapSecPerKm, grade, this.uphillEffort); },
    minettiPaceFor(grade) { return this.defaultPaceFor(grade); },
    gradientOverrideGAP(grade) {
      const pace = this.gradientPaceOverrides[grade];
      if (pace == null) return null;
      return gapFromPace(pace, grade, this.uphillEffort);
    },
    technicalGradientOverrideGAP(grade) {
      const pace = this.technicalGradientPaceOverrides[grade];
      if (pace == null) return null;
      return gapFromPace(pace, grade, this.uphillEffort);
    },
    onGradientPaceEdit(grade, event) {
      const pace = parsePace(event.target.value);
      if (!isFinite(pace) || pace <= 0) { this.recompute(); return; }
      const baseline = this.defaultPaceFor(grade);
      this.snapshotThen(() => {
        if (Math.abs(pace - baseline) < 0.5) delete this.gradientPaceOverrides[grade];
        else this.gradientPaceOverrides = { ...this.gradientPaceOverrides, [grade]: pace };
        this.recompute();
      });
    },
    onTechnicalGradientPaceEdit(grade, event) {
      const pace = parsePace(event.target.value);
      if (!isFinite(pace) || pace <= 0) { this.recompute(); return; }
      const techBaseline = this.defaultPaceFor(grade) * this.technicalSlowdown;
      this.snapshotThen(() => {
        if (Math.abs(pace - techBaseline) < 0.5) delete this.technicalGradientPaceOverrides[grade];
        else this.technicalGradientPaceOverrides = { ...this.technicalGradientPaceOverrides, [grade]: pace };
        this.recompute();
      });
    },
    clearGradientOverride(grade) {
      this.snapshotThen(() => {
        const next = { ...this.gradientPaceOverrides };
        delete next[grade];
        this.gradientPaceOverrides = next;
        this.recompute();
      });
    },
    clearTechnicalGradientOverride(grade) {
      this.snapshotThen(() => {
        const next = { ...this.technicalGradientPaceOverrides };
        delete next[grade];
        this.technicalGradientPaceOverrides = next;
        this.recompute();
      });
    },
    clearAllGradientOverrides() {
      const total = Object.keys(this.gradientPaceOverrides).length + Object.keys(this.technicalGradientPaceOverrides).length;
      if (!total) return;
      if (!confirm(`Clear all ${total} gradient + technical overrides?`)) return;
      this.snapshotThen(() => {
        this.gradientPaceOverrides = {};
        this.technicalGradientPaceOverrides = {};
        this.recompute();
      });
    },

    setHoverFromGrid(km) { setHoverKm(km); },
    hoverLabel(km) {
      if (!isFinite(km)) return '';
      const startSec = this.raceStartSec();
      const stoppageAt = buildStoppageAccumulator(this.sortedCheckpoints);
      const tSec = this.secondsAtKmHelper(km) + stoppageAt(km);
      const segIdx = this.segments.findIndex(s => km >= s.startKm && km <= s.endKm);
      const pace = segIdx >= 0 && this.segPaces[segIdx] ? formatPace(this.segPaces[segIdx]) : '—';
      const gap = segIdx >= 0 && this.segGaps[segIdx] ? formatPace(this.segGaps[segIdx]) : '—';
      // Local windowed grade from the 3D wall colours. Falls back to the segment-average grade.
      const localG = p3dApi.gradeAtKm3D ? p3dApi.gradeAtKm3D(km) : null;
      const segGrade = segIdx >= 0 ? this.segments[segIdx].avgGradePct : null;
      const grade = localG != null ? localG : segGrade;
      const gradeStr = grade != null ? `${grade >= 0 ? '+' : ''}${grade.toFixed(1)}%` : '—';
      return `km ${km.toFixed(2)} · ${gradeStr} · ETA ${formatTimeOfDay(startSec + tSec)} · Pace ${pace}/km · GAP ${gap}/km`;
    },
    // Returns the elevation (m) at a given km by interpolating between trackpoints.
    elevationAtKm(km) {
      const tps = this.gpx?.trackpoints;
      if (!tps?.length || !isFinite(km)) return null;
      if (km <= tps[0].cumDistKm) return tps[0].eleM;
      if (km >= tps[tps.length - 1].cumDistKm) return tps[tps.length - 1].eleM;
      // Binary search.
      let lo = 0, hi = tps.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (tps[mid].cumDistKm < km) lo = mid; else hi = mid;
      }
      const a = tps[lo], b = tps[hi];
      const dx = b.cumDistKm - a.cumDistKm;
      if (dx <= 0) return a.eleM;
      const t = (km - a.cumDistKm) / dx;
      return a.eleM + (b.eleM - a.eleM) * t;
    },
    // Returns segPace (sec/km) at a given km (segment-bucket lookup).
    paceAtKm(km) {
      const i = this.segments.findIndex(s => km >= s.startKm && km <= s.endKm);
      return i >= 0 ? this.segPaces[i] : null;
    },
    gapAtKm(km) {
      const i = this.segments.findIndex(s => km >= s.startKm && km <= s.endKm);
      return i >= 0 ? this.segGaps[i] : null;
    },
    cpLabel(cp) {
      // Plain-text fallback, used by older callers.
      const startSec = this.raceStartSec();
      const stoppageAt = buildStoppageAccumulator(this.sortedCheckpoints);
      const tSec = this.secondsAtKmHelper(cp.km) + stoppageAt(cp.km);
      return `km ${cp.km.toFixed(1)} · ETA ${formatTimeOfDay(startSec + tSec)}`;
    },
    cpLabelHTML(cp) {
      const t = this.cpLabelFields;
      const parts = [];
      const escape = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      if (t.code) parts.push(`<strong style="color:${cp.color || '#58a6ff'}">${escape(cp.id)}</strong>`);
      if (t.name) parts.push(escape(cp.name));
      if (t.distance) parts.push(`km ${cp.km.toFixed(1)}`);
      if (t.eta) {
        const startSec = this.raceStartSec();
        const stoppageAt = buildStoppageAccumulator(this.sortedCheckpoints);
        const tSec = this.secondsAtKmHelper(cp.km) + stoppageAt(cp.km);
        parts.push(`ETA ${formatTimeOfDay(startSec + tSec)}`);
      }
      return parts.length ? parts.join(' · ') : `<span class="cp-meta">·</span>`;
    },
    updateCpLabels() {
      if (!this.gpx) return;
      const cps = this.sortedValidCheckpoints;
      mapApi.setCpLabelResolver(cp => this.cpLabelHTML(cp));
      mapApi.setCheckpoints(cps);
      p3dApi.setCpLabelResolver3D(cp => this.cpLabelHTML(cp));
      p3dApi.setCheckpoints3D(cps);
    },
    cpRowBg(hex) {
      if (!hex) return '';
      const h = hex.replace('#', '');
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, 0.18)`;
    },

    // ===== Per-segment grid keyboard navigation =====
    onCellKeydown(event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const input = event.target;
      if (!input || input.tagName !== 'INPUT') return;
      const td = input.closest('td');
      const tr = input.closest('tr');
      if (!td || !tr) return;
      const tdIndex = Array.from(tr.children).indexOf(td);
      const direction = event.shiftKey ? -1 : 1;
      let currentTbody = input.closest('tbody');
      while (currentTbody) {
        const sibling = direction === 1 ? currentTbody.nextElementSibling : currentTbody.previousElementSibling;
        if (!sibling || sibling.tagName.toLowerCase() !== 'tbody') break;
        const targetRow = Array.from(sibling.querySelectorAll('tr')).find(r => !r.classList.contains('cp-heading-row'));
        if (targetRow) {
          const nextTd = targetRow.children[tdIndex];
          const nextInput = nextTd?.querySelector('input');
          if (nextInput) {
            input.dispatchEvent(new Event('change'));
            nextInput.focus();
            if (typeof nextInput.select === 'function') nextInput.select();
            return;
          }
        }
        currentTbody = sibling;
      }
    },

    // Checkpoints
    // Adds a blank checkpoint with no km yet — user fills it in. Until they do, the row
    // sits at the end of the sorted list so existing entries don't shuffle.
    addCheckpoint() {
      this.snapshotThen(() => {
        const cp = makeManualCheckpoint(0, this.gpx.totalDistanceKm);
        cp.km = null; cp.name = ''; cp.notes = ''; cp.stoppageSec = 0;
        this.checkpoints.push(cp);
        this.recompute();
        mapApi.setCheckpoints(this.sortedValidCheckpoints);
        p3dApi.setCheckpoints3D(this.sortedValidCheckpoints);
      });
    },
    // Insert + still adds a blank — user enters km/name. Sorted by km will land it where
    // they intend once they type the kilometre.
    insertCheckpointBetween(i) {
      this.snapshotThen(() => {
        const cp = makeManualCheckpoint(0, this.gpx.totalDistanceKm);
        cp.km = null; cp.name = ''; cp.notes = ''; cp.stoppageSec = 0;
        this.checkpoints.push(cp);
        this.recompute();
        mapApi.setCheckpoints(this.sortedValidCheckpoints);
        p3dApi.setCheckpoints3D(this.sortedValidCheckpoints);
      });
    },
    collapseAll() {
      const keys = ['goal', 'nutrition', 'map', 'cumpace', 'segpace', 'eta', 'elev', 'p3d', 'gradient', 'cp', 'grid'];
      this.collapsed = keys.reduce((m, k) => { m[k] = true; return m; }, {});
      saveCollapsed(this.collapsed);
    },
    expandAll() {
      this.collapsed = {};
      saveCollapsed(this.collapsed);
      this.$nextTick(() => this.fullRebuild());
    },
    removeCheckpoint(cp) {
      this.snapshotThen(() => {
        const i = this.checkpoints.findIndex(c => c.id === cp.id);
        if (i >= 0) {
          this.checkpoints.splice(i, 1);
          this.recompute();
          mapApi.setCheckpoints(this.sortedCheckpoints);
          p3dApi.setCheckpoints3D(this.sortedCheckpoints);
        }
      });
    },
    loadPreset() {
      if (this.gpxText) {
        pushHistory(this, `Auto-saved before UTA100 preset · ${new Date().toLocaleString()}`);
        this.history = loadHistory();
      }
      this.snapshotThen(() => {
        this.checkpoints = defaultCheckpoints(this.gpx.totalDistanceKm);
        this.recompute();
        mapApi.setCheckpoints(this.sortedValidCheckpoints);
        p3dApi.setCheckpoints3D(this.sortedValidCheckpoints);
      });
    },
    onStoppageEdit(cp, event) {
      this.snapshotThen(() => { cp.stoppageSec = parseStoppage(event.target.value); this.recompute(); });
    },
    onCheckpointStoppageOnly(cp, event) {
      cp.stoppageSec = parseStoppage(event.target.value);
      this.recompute();
    },
    onCheckpointKmEdit(cp) {
      if (cp.km != null && isFinite(cp.km)) cp.km = roundKm(cp.km);
      this.snapshotThen(() => {
        this.recompute();
        mapApi.setCheckpoints(this.sortedValidCheckpoints);
        p3dApi.setCheckpoints3D(this.sortedValidCheckpoints);
      });
    },
    onCheckpointIdEdit(cp) {
      this.snapshotThen(() => {
        this.recompute();
        mapApi.setCheckpoints(this.sortedValidCheckpoints);
        p3dApi.setCheckpoints3D(this.sortedValidCheckpoints);
      });
    },
    onCheckpointColorEdit(cp, event) {
      cp.color = event.target.value;
      this.snapshotThen(() => {
        this.recompute();
        mapApi.setCheckpoints(this.sortedValidCheckpoints);
        p3dApi.setCheckpoints3D(this.sortedValidCheckpoints);
      });
    },
    onCpArriveEdit(cp, event) {
      const arriveSec = parseHHMMSS(event.target.value);
      if (!isFinite(arriveSec) || arriveSec <= 0) { this.recompute(); return; }
      const sortedCps = this.sortedCheckpoints;
      const stoppageAt = buildStoppageAccumulator(sortedCps);
      const targetCum = arriveSec - this.raceStartSec() - stoppageAt(cp.km);
      const segIdx = this.segments.findIndex(s => cp.km > s.startKm && cp.km <= s.endKm);
      if (segIdx < 0) { this.recompute(); return; }
      const seg = this.segments[segIdx];
      const f = seg.distKm > 0 ? (cp.km - seg.startKm) / seg.distKm : 0;
      const prevCum = segIdx === 0 ? 0 : this.segCumSec[segIdx - 1];
      if (f <= 0) { alert('Checkpoint sits at the segment boundary; edit the previous segment instead.'); this.recompute(); return; }
      const segTime = (targetCum - prevCum) / f;
      if (segTime <= 0) { alert('Arrive time must be after the previous segment.'); this.recompute(); return; }
      const newPace = segTime / seg.distKm;
      const techMul = this.technicalIndices.includes(segIdx) ? this.technicalSlowdown : 1;
      const newGap = gapFromPace(newPace / techMul, seg.avgGradePct, this.uphillEffort);
      this.snapshotThen(() => { this.setOverride(segIdx, newGap); this.recompute(); });
    },
    onCpDepartEdit(cp, event) {
      const departSec = parseHHMMSS(event.target.value);
      if (!isFinite(departSec) || departSec <= 0) return;
      // Depart - stoppage = arrive. Edit arrive accordingly.
      const arriveSec = departSec - (cp.stoppageSec || 0);
      this.onCpArriveEdit(cp, { target: { value: formatTimeOfDay(arriveSec) } });
    },

    formatStop(sec) { return formatStoppage(sec); },
    segCheckpoint(seg) { return this.validCheckpoints.find(cp => cp.km >= seg.startKm && cp.km < seg.endKm); },

    resetPlan() {
      if (!confirm('Clear all segment edits, gradient overrides, technical flags, and reload UTA100 preset?')) return;
      if (this.gpxText) {
        pushHistory(this, `Auto-saved before Reset · ${new Date().toLocaleString()}`);
        this.history = loadHistory();
      }
      this.snapshotThen(() => {
        this.overrides = [];
        this.gradientPaceOverrides = {};
        this.technicalGradientPaceOverrides = {};
        this.technicalIndices = [];
        this.splitBias = 0;
        this.uphillEffort = 1.0;
        this.technicalSlowdown = 1.2;
        this.checkpoints = defaultCheckpoints(this.gpx.totalDistanceKm);
        this.recompute();
        mapApi.setCheckpoints(this.sortedValidCheckpoints);
        p3dApi.setCheckpoints3D(this.sortedValidCheckpoints);
      });
    },

    exportJSON() { exportToFile(this); },

    async importJSON(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      try { this.restoreSnapshot(await readJSONFile(file)); }
      catch (e) { console.error(e); alert('Failed to import JSON: ' + e.message); }
      event.target.value = '';
    },

    restoreSnapshot(s, addToHistory = true) {
      try {
        if (!s.gpxText) { alert('JSON does not contain GPX data.'); return; }
        // If this is replacing an existing plan, save the current state so the user can revert.
        if (this.gpxText && addToHistory) {
          pushHistory(this, `Auto-saved before restore · ${new Date().toLocaleString()}`);
          this.history = loadHistory();
        }
        this.gpxText = s.gpxText;
        this.gpx = parseGPX(s.gpxText);
        this.splitKm = Number(s.splitKm) || (s.splitMode === '0.5km' ? 0.5 : s.splitMode === '5km' ? 5 : 1);
        this.raceStart = s.raceStart || '06:25:00';
        if (typeof s.raceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.raceDate)) {
          this.raceDate = s.raceDate;
        }
        this.goal = Object.assign({ mode: 'time' }, s.goal);
        this.overrides = (s.overrides || []).map(o => ({ mode: 'anchor', ...o }));
        this.gradientPaceOverrides = { ...(s.gradientPaceOverrides || {}) };
        this.technicalGradientPaceOverrides = { ...(s.technicalGradientPaceOverrides || {}) };
        this.technicalIndices = Array.isArray(s.technicalIndices) ? [...s.technicalIndices] : [];
        this.technicalSlowdown = s.technicalSlowdown ?? 1.2;
        if (s.cpLabelFields) this.cpLabelFields = { code: true, name: false, distance: true, eta: true, ...s.cpLabelFields };
        // Snap any incoming checkpoint kms to 0.1, ensure color/uid.
        this.checkpoints = (s.checkpoints && s.checkpoints.length)
          ? normaliseCheckpoints(s.checkpoints.map(c => ({ stoppageSec: 0, ...c, km: c.km == null ? null : roundKm(c.km) })))
          : defaultCheckpoints(this.gpx.totalDistanceKm);
        this.splitBias = s.splitBias ?? 0;
        this.uphillEffort = s.uphillEffort ?? 1.0;

        // v7 nutrition. Migrates from v5 (no nutrition), v6 (gels:number, caffGels:number,
        // fluidG, gelSizeG) to v7 (gelTypes array, gels:{[id]:n}, fluidL, waterL,
        // autoRestock, primaryFluidGPerL).
        const sn = s.nutrition || {};
        const sinv = sn.startInventory || {};
        let gelTypes = Array.isArray(sn.gelTypes) ? sn.gelTypes.map(t => ({
          id: String(t.id),
          name: t.name || '',
          sizeG: Number(t.sizeG) || 25,
        })) : null;
        if (!gelTypes || !gelTypes.length) {
          gelTypes = [
            { id: 'g1', name: 'Primary', sizeG: Number(sn.gelSizeG) || 30 },
            { id: 'g2', name: 'Caffeine', sizeG: 25 },
          ];
        }
        const fluidGPerL = Number(sn.primaryFluidGPerL) || 100;
        let invGels;
        if (sinv.gels && typeof sinv.gels === 'object') {
          invGels = { ...sinv.gels };
        } else {
          invGels = {};
          if (sinv.gels != null) invGels[gelTypes[0].id] = Number(sinv.gels) || 0;
          if (gelTypes[1] && sinv.caffGels != null) invGels[gelTypes[1].id] = Number(sinv.caffGels) || 0;
        }
        for (const t of gelTypes) if (invGels[t.id] == null) invGels[t.id] = 0;
        let invFluidL = sinv.fluidL != null
          ? Number(sinv.fluidL) || 0
          : (sinv.fluidG != null ? (Number(sinv.fluidG) || 0) / fluidGPerL : 0);
        // Migrate to v9 — three direct inputs (gel g/hr, fluid g/hr, fluid L/hr).
        // v8 had targetGPerHr + fluidLPerHr; v7 had fluidGPerHr + gelGPerHr.
        const legacyFluidG = Number(sn.fluidGPerHr);
        const legacyGelG = Number(sn.gelGPerHr);
        const legacyTarget = Number(sn.targetGPerHr);
        const fluidLPerHr = Number(sn.fluidLPerHr) || (
          isFinite(legacyFluidG) ? (legacyFluidG || 0) / fluidGPerL : 0.5
        );
        const gelGPerHr = isFinite(legacyGelG) ? legacyGelG
          : (isFinite(legacyTarget) ? Math.max(0, legacyTarget - (legacyFluidG || fluidLPerHr * fluidGPerL))
          : 40);
        const fluidGPerHr = isFinite(legacyFluidG) ? legacyFluidG
          : (isFinite(legacyTarget) ? legacyTarget - gelGPerHr
          : 50);
        this.nutrition = {
          gelGPerHr: Math.max(0, gelGPerHr),
          fluidGPerHr: Math.max(0, fluidGPerHr),
          fluidLPerHr,
          gelTypes,
          startInventory: {
            gels: invGels,
            fluidL: invFluidL,
            waterL: Number(sinv.waterL) || 0,
            notes: sinv.notes || '',
            autoRestock: !!sinv.autoRestock,
            autoAdjust: !!sinv.autoAdjust,
            manualEdit: !!sinv.manualEdit,
          },
        };
        // After loading checkpoints (above), ensure each cp.dropbag.gels has every active
        // gel-type id (legacy snapshots were keyed differently or missing entirely).
        syncDropbagsToGelTypes(this.checkpoints, this.nutrition.gelTypes);

        this.goalTimeText = formatHHMMSS(this.goal.timeSec || 0);
        this.goalPaceText = formatPace(this.goal.paceSecPerKm || 0);
        this.goalGapText = formatPace(this.goal.gapSecPerKm || 0);

        // v8 priorRun. v7 (and earlier) snapshots have no priorRun key → stays null.
        if (s.priorRun && Array.isArray(s.priorRun.trackpoints) && s.priorRun.trackpoints.length) {
          this.priorRun = {
            name: s.priorRun.name || 'prior',
            source: s.priorRun.source || 'fit',
            trackpoints: s.priorRun.trackpoints.map(t => ({
              lat: Number(t.lat), lon: Number(t.lon),
              eleM: Number(t.eleM) || 0,
              timeSec: Number(t.timeSec) || 0,
              cumDistKm: Number(t.cumDistKm) || 0,
              hrBpm: Number.isFinite(Number(t.hrBpm)) ? Number(t.hrBpm) : null,
              speedMs: Number.isFinite(Number(t.speedMs)) ? Number(t.speedMs) : null,
            })),
            totalDistanceKm: Number(s.priorRun.totalDistanceKm) || 0,
            totalSec: Number(s.priorRun.totalSec) || 0,
            totalMovingTime: Number(s.priorRun.totalMovingTime) || Number(s.priorRun.totalSec) || 0,
            totalElapsedTime: Number(s.priorRun.totalElapsedTime) || Number(s.priorRun.totalSec) || 0,
            totalStoppedTime: Number(s.priorRun.totalStoppedTime) || 0,
            // Derived arrays will be repopulated by recompute(). Keep stored
            // values as a fast-path so the very first render isn't blank.
            priorSegPaces: Array.isArray(s.priorRun.priorSegPaces) ? s.priorRun.priorSegPaces : [],
            priorSegPaceDeltas: Array.isArray(s.priorRun.priorSegPaceDeltas) ? s.priorRun.priorSegPaceDeltas : [],
            priorCumAvgPaces: Array.isArray(s.priorRun.priorCumAvgPaces) ? s.priorRun.priorCumAvgPaces : [],
            priorSegHR: Array.isArray(s.priorRun.priorSegHR) ? s.priorRun.priorSegHR : [],
            priorSegGrade: Array.isArray(s.priorRun.priorSegGrade) ? s.priorRun.priorSegGrade : [],
          };
        } else {
          this.priorRun = null;
        }
        this.showPriorOverlay = {
          segpace: !!(s.showPriorOverlay?.segpace),
          cumpace: !!(s.showPriorOverlay?.cumpace),
          elev: !!(s.showPriorOverlay?.elev),
          grid: !!(s.showPriorOverlay?.grid),
          gridHR: !!(s.showPriorOverlay?.gridHR),
          segpaceHR: !!(s.showPriorOverlay?.segpaceHR),
          cumpaceHR: !!(s.showPriorOverlay?.cumpaceHR),
        };

        // Scenarios + active selection (v8). Each scenario carries its own
        // edits (overrides, gradient overrides, technical flags, prior-match
        // indices) so switching plans doesn't leak edits across them.
        const fillScenario = (raw, defaults) => ({
          name: raw.name || defaults.name,
          mode: ['time', 'pace', 'gap'].includes(raw.mode) ? raw.mode : 'time',
          timeSec: Number(raw.timeSec) || defaults.timeSec || 0,
          paceSecPerKm: Number(raw.paceSecPerKm) || defaults.paceSecPerKm || 0,
          gapSecPerKm: Number(raw.gapSecPerKm) || defaults.gapSecPerKm || 0,
          overrides: Array.isArray(raw.overrides)
            ? raw.overrides.map(o => ({
                idx: Number(o.idx),
                gapSecPerKm: Number(o.gapSecPerKm),
                mode: o.mode === 'anchor' ? 'anchor' : 'point',
              })).filter(o => Number.isFinite(o.idx) && Number.isFinite(o.gapSecPerKm))
            : [],
          gradientPaceOverrides: { ...(raw.gradientPaceOverrides || {}) },
          technicalGradientPaceOverrides: { ...(raw.technicalGradientPaceOverrides || {}) },
          technicalIndices: Array.isArray(raw.technicalIndices)
            ? raw.technicalIndices.filter(i => Number.isFinite(i))
            : [],
          priorMatchedIndices: Array.isArray(raw.priorMatchedIndices)
            ? raw.priorMatchedIndices.filter(i => Number.isFinite(i))
            : [],
          cpStops: raw.cpStops && typeof raw.cpStops === 'object' ? { ...raw.cpStops } : {},
          paceShift: raw.paceShift && typeof raw.paceShift === 'object'
            ? {
                mode: ['gap','percent','seconds'].includes(raw.paceShift.mode) ? raw.paceShift.mode : 'gap',
                value: Number(raw.paceShift.value) || 0,
              }
            : { mode: 'gap', value: 0 },
        });
        const liveDefaults = {
          timeSec: this.goal.timeSec || 46930,
          paceSecPerKm: this.goal.paceSecPerKm || 469.3,
          gapSecPerKm: this.goal.gapSecPerKm || 469.3,
        };
        // Migrate older snapshots: copy the legacy top-level overrides /
        // gradientPaceOverrides / technicalIndices into Plan A's edits if
        // Plan A's own arrays are empty (so old saves don't lose data).
        const sa = s.scenarios?.A || {};
        if (!sa.overrides && Array.isArray(s.overrides)) {
          sa.overrides = s.overrides;
          sa.gradientPaceOverrides = { ...(s.gradientPaceOverrides || {}) };
          sa.technicalGradientPaceOverrides = { ...(s.technicalGradientPaceOverrides || {}) };
          sa.technicalIndices = Array.isArray(s.technicalIndices) ? s.technicalIndices : [];
          sa.priorMatchedIndices = Array.isArray(s.priorMatchedIndices) ? s.priorMatchedIndices : [];
        }
        this.scenarios = {
          A: fillScenario(sa, { name: 'Plan A', ...liveDefaults }),
          B: fillScenario(s.scenarios?.B || {}, { name: 'Plan B', timeSec: 0, paceSecPerKm: 0, gapSecPerKm: 0 }),
          C: fillScenario(s.scenarios?.C || {}, { name: 'Plan C', timeSec: 0, paceSecPerKm: 0, gapSecPerKm: 0 }),
          prior: fillScenario(s.scenarios?.prior || {}, { name: 'Prior race', timeSec: 0, paceSecPerKm: 0, gapSecPerKm: 0 }),
        };
        const allowed = ['A', 'B', 'C', 'prior'];
        this.activeScenario = allowed.includes(s.activeScenario) ? s.activeScenario : 'A';
        if (this.activeScenario === 'prior' && !this.priorRun) this.activeScenario = 'A';

        // Live working set comes from the active scenario's saved edits.
        const active = this.scenarios[this.activeScenario];
        this.overrides = (active.overrides || []).map(o => ({ ...o }));
        this.gradientPaceOverrides = { ...(active.gradientPaceOverrides || {}) };
        this.technicalGradientPaceOverrides = { ...(active.technicalGradientPaceOverrides || {}) };
        this.technicalIndices = [...(active.technicalIndices || [])];
        this.priorMatchedIndices = [...(active.priorMatchedIndices || [])];
        // V4 v4.2: rehydrate pace shift from the active scenario.
        this.paceShift = active.paceShift
          ? {
              mode: ['gap','percent','seconds'].includes(active.paceShift.mode) ? active.paceShift.mode : 'gap',
              value: Number(active.paceShift.value) || 0,
            }
          : { mode: 'gap', value: 0 };
        // V4 Phase 2: rehydrate spectator points. Defensive — older
        // snapshots won't have the field.
        this.spectatorPoints = Array.isArray(s.spectatorPoints)
          ? s.spectatorPoints.map(sp => ({ ...sp })).filter(sp => Number.isFinite(Number(sp.lat)) && Number.isFinite(Number(sp.lon)))
          : [];

        this._undoStack = [];
        this._redoStack = [];
        this.fullRebuild();
        if (addToHistory) {
          this.$nextTick(() => {
            pushHistory(this, `Imported ${this.gpx.name}`);
            this.history = loadHistory();
          });
        }
      } catch (e) {
        console.error('restoreSnapshot failed', e);
        alert('Could not restore plan: ' + e.message);
      }
    },

    // === Spectator / Crew Share (V4 Phase 1) ============================

    // Race date + 7 days, or now + 14 days if no race date set.
    // Surfaced as the default on the share panel's expiry date input.
    shareDefaultExpiresAt() {
      if (this.raceDate && /^\d{4}-\d{2}-\d{2}$/.test(this.raceDate)) {
        const t = Date.parse(this.raceDate + 'T00:00:00');
        if (Number.isFinite(t)) return t + 7 * 86400_000;
      }
      return Date.now() + 14 * 86400_000;
    },

    // Returns the full share URL for the current tab's location, or '' if
    // no share has been generated yet. Used by both the readonly URL field
    // and the "Open share view" button.
    get shareUrl() {
      if (!this.share.runId || !this.share.shareToken) return '';
      const base = location.origin + location.pathname.replace(/[^/]*$/, '');
      return `${base}share.html?runId=${encodeURIComponent(this.share.runId)}&token=${encodeURIComponent(this.share.shareToken)}`;
    },

    get shareExpiryDateInput() {
      // <input type="date"> wants YYYY-MM-DD in local time.
      const ms = this.share.expiresAt || this.shareDefaultExpiresAt();
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },

    get shareRunIdShort() {
      if (!this.share.runId) return '';
      const s = this.share.runId;
      if (s.length <= 10) return s;
      return s.slice(0, 4) + '…' + s.slice(-4);
    },

    get shareUpdatedAgo() {
      const ms = this.share.updatedAt || this.share.createdAt;
      if (!ms) return '';
      const dt = Date.now() - ms;
      if (dt < 60_000) return `${Math.max(0, Math.round(dt / 1000))}s ago`;
      if (dt < 3_600_000) return `${Math.round(dt / 60_000)} min ago`;
      if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)} h ago`;
      return `${Math.round(dt / 86_400_000)} d ago`;
    },

    // Primary action: build a filtered snapshot, hand it to the store
    // adapter. The adapter knows whether to create-new or update-existing
    // based on whether share-self is already populated.
    async generateShareLink() {
      if (!this.gpxText) {
        this.share.error = 'Load a course first';
        return;
      }
      this.share.generating = true;
      this.share.error = null;
      try {
        const filtered = filterSnapshotForShare(makeSnapshot(this));
        const expiresAt = this.share.expiresAt || this.shareDefaultExpiresAt();
        const result = await shareCreateRun(filtered, { expiresAt });
        this.share = {
          ...this.share,
          runId: result.runId,
          ownerToken: result.ownerToken,
          shareToken: result.shareToken,
          expiresAt: result.expiresAt,
          createdAt: result.createdAt || Date.now(),
          updatedAt: Date.now(),
          generating: false,
          error: null,
        };
      } catch (e) {
        console.error('[share] generateShareLink failed', e);
        this.share.generating = false;
        this.share.error = e && e.message || String(e);
      }
    },

    async copyShareUrl() {
      const url = this.shareUrl;
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        this.share.copied = true;
        setTimeout(() => { this.share.copied = false; }, 1800);
      } catch (e) {
        // Fallback: select the input.
        const el = document.getElementById('share-url-input');
        if (el) { el.select(); el.setSelectionRange(0, 99999); }
      }
    },

    openSharePreview() {
      const url = this.shareUrl;
      if (!url) return;
      window.open(url, '_blank', 'noopener');
    },

    async setShareExpiry(yyyyMmDd) {
      if (!this.share.runId) return;
      const t = Date.parse(yyyyMmDd + 'T23:59:59');
      if (!Number.isFinite(t)) return;
      try {
        await shareUpdateRun(this.share.runId, { expiresAt: t }, this.share.ownerToken);
        this.share = { ...this.share, expiresAt: t, updatedAt: Date.now() };
        saveShareSelf({
          runId: this.share.runId,
          ownerToken: this.share.ownerToken,
          shareToken: this.share.shareToken,
          expiresAt: t,
        });
      } catch (e) {
        console.error('[share] setShareExpiry failed', e);
        this.share.error = e && e.message || String(e);
      }
    },

    // === Spectator points (V4 Phase 2) ============================
    // Jeff types in lat/lon for each spectator-friendly viewing spot. We
    // snap to the nearest route trackpoint to derive the cum km (so ETAs
    // can be interpolated along the plan's segCumSec on the share side).
    // Stored on `this.spectatorPoints` and serialised via snapshot().

    _genSpId() {
      return 'sp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    },

    // Snap a lat/lon to the nearest route trackpoint and return its
    // cumulative km, or null if the point is too far off-route to be
    // useful (>2 km — heuristic; just a sanity check).
    snapLatLonToKm(lat, lon) {
      const tps = this.gpx?.trackpoints;
      if (!tps || tps.length < 2) return null;
      const latN = Number(lat), lonN = Number(lon);
      if (!Number.isFinite(latN) || !Number.isFinite(lonN)) return null;
      let bestKm = null, bestD2 = Infinity;
      const cosLat = Math.cos(latN * Math.PI / 180);
      const stride = Math.max(1, Math.floor(tps.length / 800));
      for (let i = 0; i < tps.length; i += stride) {
        const tp = tps[i];
        const dy = tp.lat - latN;
        const dx = (tp.lon - lonN) * cosLat;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; bestKm = tp.cumDistKm; }
      }
      // ~0.018° at the equator ≈ 2 km. Bail out if the user typed lat/lon
      // that don't match the loaded route.
      if (bestD2 > 0.0003) return null;
      return roundKm(bestKm);
    },

    addSpectatorPoint() {
      const sp = {
        id: this._genSpId(),
        name: 'Spectator point ' + (this.spectatorPoints.length + 1),
        lat: null,
        lon: null,
        km: null,
        color: '#a371f7',
        notes: '',
        address: '',
        accessNotes: '',
      };
      this.snapshotThen(() => {
        this.spectatorPoints = [...this.spectatorPoints, sp];
      });
      debouncedSave(this);
    },

    removeSpectatorPoint(id) {
      this.snapshotThen(() => {
        this.spectatorPoints = this.spectatorPoints.filter(s => s.id !== id);
      });
      debouncedSave(this);
    },

    // Called from x-on:change on the lat/lon inputs. After the user types
    // both coordinates we resnap and update km so the share view's ETA can
    // be derived. If only one is set, leave km null and the share view
    // re-snaps on read.
    onSpectatorLatLonChange(sp) {
      const km = this.snapLatLonToKm(sp.lat, sp.lon);
      sp.km = km;
      debouncedSave(this);
    },

    // V4 v4.5: alternative entry mode — type a km, snap to the nearest
    // route trackpoint and back-fill lat/lon. Lets Jeff add a spectator
    // point without copy-pasting GPS coords from Google Maps.
    onSpectatorKmChange(sp) {
      const km = Number(sp.km);
      if (!Number.isFinite(km) || km < 0) {
        sp.km = null;
        return;
      }
      const tps = this.gpx?.trackpoints;
      if (!tps?.length) return;
      // Clamp to the route's distance range.
      const total = tps[tps.length - 1].cumDistKm;
      const clamped = Math.max(0, Math.min(total, km));
      // Binary search for the first trackpoint past clamped km.
      let lo = 0, hi = tps.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tps[mid].cumDistKm < clamped) lo = mid + 1;
        else hi = mid;
      }
      const tp = tps[lo];
      if (tp) {
        sp.lat = Number(tp.lat.toFixed(6));
        sp.lon = Number(tp.lon.toFixed(6));
        sp.km = roundKm(clamped);
      }
      debouncedSave(this);
    },

    // Persist edits to spectator-row text fields (name, notes). The
    // template wires this on @change so x-model mutations land in
    // localStorage via the standard debouncedSave path.
    onSpectatorEdit() { debouncedSave(this); },

    // === Spectator / Crew Share share helpers continued ============================

    // Standalone HTML export. Builds a self-contained .html file with the
    // current plan baked in. Crew open the file on PC or phone — no
    // planner server required, no localStorage, no internet beyond the
    // CDN-hosted Leaflet + Alpine tiles.
    //
    // Bundling strategy: data-URI importmap. Each module is base64-encoded
    // and registered under a short ID in the importmap. Cross-module
    // imports get rewritten to use those IDs. Browser handles the rest as
    // standard ESM resolution — module scope is preserved, no naming
    // collisions between internal helpers across files.
    // V4 v4.6 — Standalone HTML export, mobile-bulletproof rewrite.
    //
    // The earlier export used data-URI ES modules + an importmap. That
    // requires Safari iOS 16.4+ / Chrome 89+ to work natively (and we'd
    // added es-module-shims as a polyfill for older browsers). In
    // practice some mobile browsers still failed silently — likely due
    // to file:// CSP restrictions, in-app browsers, or shim races.
    //
    // This version bundles every module as a plain non-module
    // `<script>`. Each module body is wrapped in an IIFE that registers
    // its exports onto a `__shareMods` registry. Imports are rewritten
    // to `const { x } = __shareMods.y;` destructures. No data URIs, no
    // importmap, no ES module support required at all — should work on
    // any phone with a modern-ish browser (incl. in-app browsers).
    //
    // Trade-off: 3D route profile (profile3d.js) is dropped from the
    // standalone export because Three.js is ES-module-only since r150.
    // The 2D map, ETA list, drop-bag table, and 4 of 5 chart panels
    // still ship. Crew rarely need the 3D anyway.
    async exportShareHTML() {
      if (!this.gpxText) {
        alert('Load a course first.');
        return;
      }
      this.share.generating = true;
      this.share.error = null;
      try {
        const filtered = filterSnapshotForShare(makeSnapshot(this));

        // Manifest in topological order — each module's deps appear
        // earlier in the list so the IIFE registry is populated when
        // they're needed. profile3d is intentionally omitted (ESM-only
        // Three.js). The bundled shareView checks for missing profile3d
        // and hides the 3D panel.
        const manifest = [
          ['minetti', './src/minetti.js'],
          ['gpx', './src/gpx.js'],
          ['segments', './src/segments.js'],
          ['pacePlan', './src/pacePlan.js'],
          ['uta100', './src/presets/uta100.js'],
          ['checkpoints', './src/checkpoints.js'],
          ['storeLocal', './src/share/storeLocal.js'],
          ['storeIndex', './src/share/index.js'],
          ['dirLinks', './src/share/dirLinks.js'],
          ['shareMap', './src/share/shareMap.js'],
          ['snapshotFilter', './src/share/snapshotFilter.js'],
          ['sync', './src/sync.js'],
          ['elevationChart', './src/elevationChart.js'],
          ['cumulativePaceChart', './src/cumulativePaceChart.js'],
          ['segmentPaceChart', './src/segmentPaceChart.js'],
          ['shareView', './src/share/shareView.js'],
        ];
        const pathToId = {
          './minetti.js': 'minetti', '../minetti.js': 'minetti',
          './gpx.js': 'gpx', '../gpx.js': 'gpx',
          './segments.js': 'segments', '../segments.js': 'segments',
          './pacePlan.js': 'pacePlan', '../pacePlan.js': 'pacePlan',
          './presets/uta100.js': 'uta100', '../presets/uta100.js': 'uta100',
          './checkpoints.js': 'checkpoints', '../checkpoints.js': 'checkpoints',
          './storeLocal.js': 'storeLocal',
          './index.js': 'storeIndex',
          './dirLinks.js': 'dirLinks',
          './shareMap.js': 'shareMap',
          './snapshotFilter.js': 'snapshotFilter',
          './elevationChart.js': 'elevationChart', '../elevationChart.js': 'elevationChart',
          './etaChart.js': 'etaChart', '../etaChart.js': 'etaChart',
          './cumulativePaceChart.js': 'cumulativePaceChart', '../cumulativePaceChart.js': 'cumulativePaceChart',
          './segmentPaceChart.js': 'segmentPaceChart', '../segmentPaceChart.js': 'segmentPaceChart',
          './profile3d.js': 'profile3d', '../profile3d.js': 'profile3d',
          './sync.js': 'sync', '../sync.js': 'sync',
          './shareView.js': 'shareView',
        };

        // Fetch every module's source once.
        const sources = {};
        for (const [id, path] of manifest) {
          sources[id] = await fetch(path).then(r => {
            if (!r.ok) throw new Error('Failed to fetch ' + path);
            return r.text();
          });
        }

        // Transform each module into a self-contained IIFE.
        // - Strip `?v=v\d+` from import paths.
        // - Extract `import { a, b } from './x.js'` (or `import * as x`)
        //   and rewrite as `const { a, b } = __shareMods.x;` at top of
        //   the IIFE body.
        // - Drop imports of 'three' / 'three/addons/...' entirely (3D
        //   isn't in the standalone bundle — see header comment).
        //   Replace any other unresolved import with an empty stub so
        //   the bundle still parses.
        // - Strip `export ` prefix on declarations and record export
        //   names. Strip `export { a, b };` statements likewise.
        // - Wrap in IIFE that returns an object of exported names.
        const buildModuleIIFE = (id, src) => {
          // 1. Strip cache-bust suffix
          src = src.replace(/(['"])(\.[^'"]+?\.js)\?v=v\d+\1/g, '$1$2$1');

          // 2. Extract imports (handles multi-line { ... } via [\s\S]).
          const imports = [];
          src = src.replace(
            /^\s*import\s+([\s\S]+?)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
            (m, names, q, p) => {
              names = names.trim();
              if (p === 'three' || p.startsWith('three/')) {
                // 3D dependency — not in the bundle. Replace with empty
                // stub so reference compiles (but the module that uses
                // it should be omitted from the manifest anyway).
                if (names.startsWith('*')) {
                  const alias = (names.match(/as\s+(\w+)/) || [])[1] || 'M';
                  imports.push(`const ${alias} = {};`);
                } else if (names.startsWith('{')) {
                  imports.push(`const ${names} = {};`);
                }
                return '';
              }
              const target = pathToId[p];
              if (!target) {
                // Unknown import — emit empty stub.
                if (names.startsWith('{')) imports.push(`const ${names} = {};`);
                return '';
              }
              if (names.startsWith('*')) {
                // import * as X from '...'  — fall back to {} if the
                // target wasn't bundled (e.g. profile3d).
                const alias = (names.match(/as\s+(\w+)/) || [])[1];
                if (alias) imports.push(`const ${alias} = (__shareMods.${target} || {});`);
              } else if (names.startsWith('{')) {
                // import { a, b } from '...' — destructure straight from
                // registry, with `|| {}` so missing modules don't throw.
                imports.push(`const ${names} = (__shareMods.${target} || {});`);
              } else {
                // Default import (rare in this codebase): use .default fallback.
                imports.push(`const ${names} = (__shareMods.${target} && (__shareMods.${target}.default || __shareMods.${target})) || {};`);
              }
              return '';
            }
          );

          // 3. Strip `export ` prefix on declarations + collect names.
          const exports = [];
          // (a) `export const { A, B } = X;` — destructuring re-export
          //     (used in share/index.js to re-export storeLocal names).
          src = src.replace(
            /^(\s*)export\s+(const|let|var)\s+\{([^}]+)\}/gm,
            (m, ind, kw, list) => {
              for (const piece of list.split(',')) {
                const t = piece.trim();
                if (!t) continue;
                // Could be `name`, `name as alias`, `name: alias`, or `name = default`.
                const localName = t.split(/[:=]/)[0].split(/\s+as\s+/).pop().trim();
                if (localName) exports.push(localName);
              }
              return `${ind}${kw} {${list}}`;
            }
          );
          // (b) `export function NAME(...)` | `export const NAME = ...` | let / var / class / async function
          src = src.replace(
            /^(\s*)export\s+(function|const|let|var|class|async\s+function)(\s+)(\w+)/gm,
            (m, ind, kw, sp, name) => {
              exports.push(name);
              return `${ind}${kw}${sp}${name}`;
            }
          );
          // (c) `export { a, b as c };` — re-export statement.
          src = src.replace(/^\s*export\s*\{([^}]+)\}\s*;?\s*$/gm, (m, list) => {
            for (const piece of list.split(',')) {
              const t = piece.trim();
              if (!t) continue;
              const localName = t.split(/\s+as\s+/)[0].trim();
              if (localName) exports.push(localName);
            }
            return '';
          });

          // 4. Wrap in IIFE.
          return (
            `__shareMods.${id} = (function(){\n` +
            imports.join('\n') + '\n' +
            src + '\n' +
            `return { ${[...new Set(exports)].join(', ')} };\n` +
            `})();`
          );
        };

        const moduleChunks = manifest.map(([id]) => buildModuleIIFE(id, sources[id]));
        const bundleScript =
          '(function(){\n' +
          'var __shareMods = window.__shareMods = {};\n' +
          moduleChunks.join('\n\n// === module boundary ===\n\n') + '\n\n' +
          '// Expose the shareView factory for the bootstrap below.\n' +
          'window.__SHARE_VIEW_FACTORY__ = __shareMods.shareView.shareView;\n' +
          '})();';

        // Fetch the share.html template + rewrite for non-module bundle.
        let html = await fetch('share.html').then(r => r.text());

        // Drop the styles.css link — inline <style> in share.html is enough.
        html = html.replace(/<link rel="stylesheet" href="\.\/styles\.css[^"]*"[^>]*>/, '');

        // Drop the Three.js importmap (we don't bundle 3D in standalone).
        html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, '');

        // Drop the es-module-shims polyfill + its explanatory comment —
        // no modules in the export, so the polyfill is dead weight and
        // mentioning "importmap" in the comment confuses sniff-tests.
        html = html.replace(/<!--[^]*?es-module-shims[^]*?-->\s*/, '');
        html = html.replace(/<script[^>]*es-module-shims[^>]*>\s*<\/script>/, '');

        // Drop the 3D panel (no profile3d in the bundle).
        html = html.replace(
          /<section class="share-panel chart-panel">\s*<div class="share-panel-header chart-panel-header" @click="toggleChartPanel\('p3d'\)">[\s\S]*?<\/section>/,
          ''
        );

        // Swap the Alpine module import for the UMD/global build, and
        // replace the bootstrap module with a plain script that uses
        // window.__SHARE_VIEW_FACTORY__ exposed by the bundle.
        const bootstrapPlain =
          `<script src="https://cdn.jsdelivr.net/npm/alpinejs@3.13.5/dist/cdn.min.js" defer></script>\n` +
          `<script>\n` +
          bundleScript + '\n' +
          // Defer Alpine.data registration until Alpine fires alpine:init,
          // which is the right hook for the UMD/global build.
          `document.addEventListener('alpine:init', function() {\n` +
          `  window.Alpine.data('shareView', window.__SHARE_VIEW_FACTORY__);\n` +
          `});\n` +
          `</script>`;
        html = html.replace(/<script type="module">[\s\S]*?<\/script>/, bootstrapPlain);

        // Inject the plan data as a global at the top of <body>.
        const dataScript = `\n<script>\n` +
          `window.__TRAIL_SHARE_STATIC__ = ${JSON.stringify(filtered)};\n` +
          `window.__TRAIL_SHARE_STATIC_AT__ = ${Date.now()};\n` +
          `</script>\n`;
        html = html.replace(/<body class="share-body"[^>]*>/, m => m + dataScript);

        // Trigger download.
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const safeName = (this.gpx?.name || 'race-share').replace(/[^\w\-]+/g, '_');
        a.href = url;
        a.download = safeName + '-share.html';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);

        this.share.generating = false;
      } catch (e) {
        console.error('[share] exportShareHTML failed', e);
        this.share.generating = false;
        this.share.error = 'Standalone export failed: ' + (e && e.message || e);
      }
    },

    // Phase-6 "stop sharing": clears tokens locally, leaves the doc
    // server-side to expire naturally. Wired but not exposed in Phase 1 UI.
    clearShareSelf() {
      clearShareSelf();
      this.share = {
        runId: null, ownerToken: null, shareToken: null,
        expiresAt: null, createdAt: null, updatedAt: null,
        generating: false, error: null, copied: false,
      };
    },

    formatPace(sec) { return formatPace(sec); },
    formatTime(sec) { return formatHHMMSS(sec); },
    formatDistance(km) { return km.toFixed(1) + ' km'; },
    gradeClass(pct) {
      if (pct >= 12) return 'g-severe';
      if (pct >= 7) return 'g-steep';
      if (pct >= 3) return 'g-mod';
      if (pct >= -3) return 'g-flat';
      if (pct >= -7) return 'g-down';
      return 'g-down-steep';
    },
  };
}
