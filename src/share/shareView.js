// shareView — Alpine component for share.html.
//
// Subscribes to the run via store.subscribe, re-derives segments + paces +
// ETAs from `plan.gpxText` (so the share view doesn't depend on planner
// state at all), and exposes getters for:
//
//   - the map (route polyline + clickable CP markers)
//   - the simplified nutrition table (per-CP fluid + gel handover counts)
//   - the read-only ETA list (with optional "vs last year" delta column
//     when run.plan.priorRun is present)
//   - the CP action sheet (Google + Apple Maps directions)
//
// The derivation pipeline mirrors src/app.js's recompute() so share ETAs
// match planner ETAs to the second. The pipeline runs every time the run
// doc updates (via the subscribe callback) — cheap because there are no
// charts to re-render in Phase 1.

import { parseGPX } from '../gpx.js?v=v15';
import { buildSegments, segmentIndexForKm } from '../segments.js';
import {
  computeSegmentGaps, computeSegmentPaces, computeSegmentSeconds,
  gapForTargetTime,
  buildStoppageAccumulator, totalStoppageSec,
  secondsAtKm, formatHHMMSS, formatPace, formatTimeOfDay,
  parseHHMMSS,
} from '../pacePlan.js';
import { normaliseCheckpoints } from '../checkpoints.js?v=v12';
import { subscribe } from './index.js?v=v27';
import {
  initShareMap, setShareRoute, setShareCheckpoints,
  setShareSpectatorPoints, setShareHoverLabelResolver, setShareHover,
  onShareHover, onShareMapClick, invalidateShareMap,
} from './shareMap.js?v=v32';
import { googleMapsDir, appleMapsDir } from './dirLinks.js?v=v27';
import * as elevApi from '../elevationChart.js?v=v14';
import * as cumApi from '../cumulativePaceChart.js?v=v14';
import * as segPaceApi from '../segmentPaceChart.js?v=v14';
import * as p3dApi from '../profile3d.js?v=v12';
import { setHoverKm, onHoverChange } from '../sync.js';

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function relativeTimeAgo(ms) {
  if (!ms) return '';
  const dt = Date.now() - ms;
  if (dt < 60_000) return `${Math.max(0, Math.round(dt / 1000))}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)} min ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)} h ago`;
  return `${Math.round(dt / 86_400_000)} d ago`;
}

// 12-hour formatter without seconds — feels more natural for crew glancing
// at a phone ("8:07 AM" vs "08:07:33"). 24-hour view keeps seconds for the
// race-day precision Jeff plans against.
function formatTimeOfDay12h(totalSec) {
  if (!Number.isFinite(totalSec)) return '—';
  const day = 86400;
  const t = ((Math.round(totalSec) % day) + day) % day;
  const hh24 = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ampm = hh24 < 12 ? 'AM' : 'PM';
  let hh = hh24 % 12; if (hh === 0) hh = 12;
  return `${hh}:${String(mm).padStart(2, '0')} ${ampm}`;
}

// localStorage-backed per-viewer preferences. Each crew member's phone
// remembers their own toggles. Survives share-doc updates from the runner.
const PREFS_KEY = 'trail-planner-v4-share-view-prefs';
const DEFAULT_PREFS = {
  clock: '24h',                                    // '24h' | '12h'
  labels: { code: true, name: false, km: true, eta: true },
  showSpectatorPoints: true,
  theme: 'dark',                                   // 'dark' | 'light'
};
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS, labels: { ...DEFAULT_PREFS.labels } };
    const obj = JSON.parse(raw) || {};
    return {
      clock: obj.clock === '12h' ? '12h' : '24h',
      labels: { ...DEFAULT_PREFS.labels, ...(obj.labels || {}) },
      showSpectatorPoints: obj.showSpectatorPoints !== false,
      theme: obj.theme === 'light' ? 'light' : 'dark',
    };
  } catch {
    return { ...DEFAULT_PREFS, labels: { ...DEFAULT_PREFS.labels } };
  }
}
function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

export function shareView() {
  return {
    // --- url ---
    runId: null,
    shareToken: null,

    // --- lifecycle ---
    status: 'loading',     // loading | ok | not-found | expired | invalid-token | error
    errorMsg: '',
    _unsub: null,
    _tickTimer: null,
    _now: Date.now(),      // re-render trigger for "8s ago" labels

    // --- per-viewer prefs (persisted in localStorage) ---
    // Each crew member's phone remembers their own toggles, independent of
    // what the runner pushes.
    prefs: loadPrefs(),
    showPrefs: false,      // collapsible View options bar

    // --- scenario picker (V4 v4.3) ---
    // Crew can flip between Plan A / B / C / Prior Race to see how the
    // ETAs change under each plan. Defaults to whichever scenario the
    // runner has active on their side; viewer can override locally.
    selectedScenario: 'A',

    // --- run doc (from store.subscribe) ---
    runDoc: null,

    // --- derived (from runDoc.plan) ---
    trackpoints: [],
    segments: [],
    segPaces: [],
    segSec: [],
    segCumSec: [],
    totalSec: 0,
    raceStartSec: 0,
    sortedCps: [],         // normalised + sorted by km
    cpRows: [],            // [{ id, name, km, lat, lon, color, planArrivalSec,
                            //   stoppageSec, fluidL, waterL,
                            //   gelsByType:[{id,name,count}], notes,
                            //   priorDeltaSec, isSpectator: false }]
    spectatorRows: [],     // same shape (sans nutrition), isSpectator: true
    gelTypes: [],

    // --- UI ---
    sheetCp: null,         // currently-open CP action sheet (null = closed)

    init() {
      // === Cross-chart hover sync (V4 v4.4 / v4.7 placement fix) =====
      // MUST run regardless of static vs live path — earlier this was
      // after the staticPlan early-return, so the standalone HTML never
      // wired the bus and the live path only wired it after subscribe.
      // Now it's the first thing init does so every page mode gets it.
      onHoverChange(km => {
        try { setShareHover(km); } catch {}
        try { if (this.chartsExpanded.elev) elevApi.setElevationHover(km); } catch {}
        try { if (this.chartsExpanded.cumpace) cumApi.setCumPaceHover(km); } catch {}
        try { if (this.chartsExpanded.segpace) segPaceApi.setSegmentPaceHover(km); } catch {}
        try { if (this.chartsExpanded.p3d) p3dApi.setHover3D(km); } catch {}
      });
      // Map mouse-move publishes onto the bus.
      onShareHover(km => setHoverKm(km));

      // Cleanup on tab close.
      window.addEventListener('beforeunload', () => this._destroy());

      // Standalone HTML export path: plan is baked in as
      // `window.__TRAIL_SHARE_STATIC__`. Skip the store/subscribe — the
      // file IS the snapshot (nothing to listen for).
      const staticPlan = typeof window !== 'undefined'
        ? window.__TRAIL_SHARE_STATIC__ : null;
      if (staticPlan) {
        const at = (typeof window !== 'undefined' && window.__TRAIL_SHARE_STATIC_AT__) || Date.now();
        this._onRun({
          runId: 'static',
          shareToken: 'static',
          createdAt: at,
          updatedAt: at,
          // Static exports don't expire — the file IS the expiry boundary.
          expiresAt: Date.now() + 365 * 86400_000,
          plan: staticPlan,
          live: null,
          spectatorPoints: staticPlan.spectatorPoints || [],
        });
        // Tick timer so "snapshot taken" relative time refreshes.
        this._tickTimer = setInterval(() => { this._now = Date.now(); }, 5000);
        return;
      }

      const params = new URLSearchParams(location.search);
      this.runId = params.get('runId') || '';
      this.shareToken = params.get('token') || params.get('shareToken') || '';
      if (!this.runId || !this.shareToken) {
        this.status = 'invalid-token';
        this.errorMsg = 'Missing runId or token in URL.';
        return;
      }

      // Subscribe. cb(run | null) fires immediately with whatever's in
      // localStorage right now, then every time the run updates.
      try {
        this._unsub = subscribe(this.runId, this.shareToken, (run) => this._onRun(run));
      } catch (e) {
        this.status = 'error';
        this.errorMsg = String(e && e.message || e);
        return;
      }

      // Re-render the "<n>s ago" labels every 5 s.
      this._tickTimer = setInterval(() => { this._now = Date.now(); }, 5000);
    },

    _destroy() {
      if (this._unsub) { try { this._unsub(); } catch {} this._unsub = null; }
      if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    },

    _onRun(run) {
      if (!run) {
        // Could be: not found, wrong token, expired. We can't tell which
        // without a separate query — but in the local impl the subscribe
        // already validates token before firing, so null = not-found-or-wrong-token.
        this.runDoc = null;
        if (this.status === 'loading') this.status = 'not-found';
        return;
      }
      this.runDoc = run;
      if (run.expiresAt && run.expiresAt < Date.now()) {
        this.status = 'expired';
        return;
      }
      this.status = 'ok';
      // Default the picker to the runner's active scenario the first time
      // the doc loads. Subsequent re-runs (e.g. broadcasts) don't clobber
      // the viewer's choice.
      if (!this._scenarioInitialised && run.plan?.activeScenario) {
        this.selectedScenario = run.plan.activeScenario;
        this._scenarioInitialised = true;
      }
      this._derive();
      // Map init is deferred until status === 'ok' (otherwise the
      // container has display:none from x-show and Leaflet can't size).
      this.$nextTick(() => {
        this._renderMap();
        this._refreshOpenCharts();
      });
    },

    // Viewer switched scenarios — re-derive using the selected scenario's
    // overrides / pace shift / etc. and re-render the map labels + any
    // open chart panels (ETAs change). Base GPX route stays the same.
    setShareScenario(key) {
      if (!this.hasScenarios) return;
      if (!['A', 'B', 'C', 'prior'].includes(key)) return;
      if (key === 'prior' && !this.priorAvailable) return;
      this.selectedScenario = key;
      this._derive();
      this.$nextTick(() => {
        this._renderMap();
        this._refreshOpenCharts();
      });
    },

    // Build the effective plan for derivation — starts with the active
    // (top-level) plan, overlays the SELECTED scenario's overrides /
    // pace shift / etc. if different from active.
    _effectivePlan() {
      const plan = this.runDoc?.plan;
      if (!plan) return null;
      const activeKey = plan.activeScenario || 'A';
      const sel = this.selectedScenario || activeKey;
      const scenarios = plan.scenarios || {};
      const sc = scenarios[sel];
      if (!sc || sel === activeKey) {
        // Use the top-level plan (= active scenario already resolved).
        // Top-level `goal.timeSec` from the planner is MOVING time (model
        // working value), which is what gapForTargetTime expects.
        return plan;
      }
      // Overlay the selected scenario onto a shallow copy. The planner
      // stores `scenarios[k].timeSec` as the USER-FACING goal (elapsed =
      // moving + stoppage), so when we overlay a non-active scenario we
      // need to subtract the scenario's stoppage from timeSec before
      // handing it to gapForTargetTime (which targets moving time).
      // paceSecPerKm and gapSecPerKm are moving-rates already — no
      // adjustment needed.
      const cpStops = sc.cpStops || {};
      const checkpoints = (plan.checkpoints || []).map(cp => {
        const copy = { ...cp };
        if (cp._uid && cp._uid in cpStops) {
          copy.stoppageSec = Math.max(0, Number(cpStops[cp._uid]) || 0);
        }
        return copy;
      });
      const totalStoppage = checkpoints.reduce(
        (sum, c) => sum + (Number(c.stoppageSec) || 0), 0,
      );
      const scTimeSec = Number(sc.timeSec) || 0;
      const movingTimeSec = scTimeSec > totalStoppage
        ? scTimeSec - totalStoppage
        : scTimeSec;
      const goal = {
        mode: sc.mode || plan.goal?.mode || 'time',
        timeSec: movingTimeSec,
        paceSecPerKm: Number(sc.paceSecPerKm) || plan.goal?.paceSecPerKm || 0,
        gapSecPerKm: Number(sc.gapSecPerKm) || plan.goal?.gapSecPerKm || 0,
      };
      return {
        ...plan,
        goal,
        overrides: sc.overrides || [],
        gradientPaceOverrides: sc.gradientPaceOverrides || {},
        technicalGradientPaceOverrides: sc.technicalGradientPaceOverrides || {},
        technicalIndices: sc.technicalIndices || [],
        paceShift: sc.paceShift || { mode: 'gap', value: 0 },
        checkpoints,
      };
    },

    // Mirrors src/app.js's recompute() pipeline so the numbers match.
    // Uses _effectivePlan() so scenario switches re-derive cleanly.
    _derive() {
      const plan = this._effectivePlan();
      if (!plan || !plan.gpxText) { this._clearDerived(); return; }
      try {
        const gpx = parseGPX(plan.gpxText);
        this.trackpoints = gpx.trackpoints;
        const totalKm = gpx.totalDistanceKm;
        const splitKm = plan.splitKm > 0 ? plan.splitKm : 1;
        const segments = buildSegments(gpx.trackpoints, splitKm);
        this.segments = segments;

        const goal = plan.goal || {};
        const overrides = Array.isArray(plan.overrides) ? plan.overrides : [];
        const splitBias = Number(plan.splitBias) || 0;
        const uphillEffort = Number(plan.uphillEffort) || 1.0;
        const technicalSlowdown = Number(plan.technicalSlowdown) || 1.2;
        const technicalIndices = Array.isArray(plan.technicalIndices) ? plan.technicalIndices : [];
        const gradOv = plan.gradientPaceOverrides || {};
        const techGradOv = plan.technicalGradientPaceOverrides || {};
        const paceShift = plan.paceShift || { mode: 'gap', value: 0 };
        const techSetForGap = new Set(technicalIndices);

        // Resolve baseGap from the goal driver — mirrors src/app.js's
        // recompute(). For inactive scenarios only timeSec is set (not
        // gapSecPerKm), so we need gapForTargetTime to back-solve.
        let baseGap;
        if (goal.mode === 'time' && Number(goal.timeSec) > 0) {
          baseGap = gapForTargetTime(segments, Number(goal.timeSec), totalKm, splitBias, uphillEffort, techSetForGap, technicalSlowdown);
        } else if (goal.mode === 'pace' && Number(goal.paceSecPerKm) > 0) {
          const targetTotal = Number(goal.paceSecPerKm) * totalKm;
          baseGap = gapForTargetTime(segments, targetTotal, totalKm, splitBias, uphillEffort, techSetForGap, technicalSlowdown);
        } else {
          baseGap = Number(goal.gapSecPerKm) || 0;
        }

        // Apply 'gap' shift mode to baseGap before computeSegmentGaps —
        // mirrors src/app.js recompute().
        if (paceShift.mode === 'gap' && Number.isFinite(paceShift.value) && paceShift.value !== 0) {
          baseGap += paceShift.value;
        }

        const segGaps = computeSegmentGaps(segments, baseGap, overrides, totalKm, splitBias);
        const perSegOvrSet = new Set(overrides.map(o => o.idx));
        const techSet = new Set(technicalIndices);
        let segPaces = computeSegmentPaces(
          segments, segGaps, uphillEffort,
          gradOv, perSegOvrSet, techSet, technicalSlowdown, techGradOv,
        );
        // % / sec shift applies AFTER pace resolution so overrides move
        // with the bulk shift.
        if (paceShift.mode === 'percent' && Number.isFinite(paceShift.value) && paceShift.value !== 0) {
          const mul = 1 + (paceShift.value / 100);
          segPaces = segPaces.map(p => p * mul);
        } else if (paceShift.mode === 'seconds' && Number.isFinite(paceShift.value) && paceShift.value !== 0) {
          segPaces = segPaces.map(p => p + paceShift.value);
        }
        const { segSec, cumSec, totalSec } = computeSegmentSeconds(segments, segPaces);
        this.segPaces = segPaces;
        this.segSec = segSec;
        this.segCumSec = cumSec;
        this.totalSec = totalSec;

        // CPs: defensive normalise + sort by km.
        const cps = Array.isArray(plan.checkpoints) ? plan.checkpoints.map(c => ({ ...c })) : [];
        normaliseCheckpoints(cps);
        this.sortedCps = cps
          .filter(c => c.km != null && isFinite(c.km))
          .sort((a, b) => a.km - b.km);

        // Race start in seconds-of-day.
        this.raceStartSec = parseHHMMSS(plan.raceStart || '06:00:00');

        // Nutrition gel types — used by the simplified nutrition table to
        // know which gel columns to render.
        this.gelTypes = (plan.nutrition?.gelTypes || []).map(t => ({ ...t }));

        // Build per-CP rows: planned arrival/departure + prior delta.
        const stoppage = buildStoppageAccumulator(this.sortedCps);
        const priorCum = plan.priorRun?.priorCumAvgPaces;
        const hasPrior = Array.isArray(priorCum) && priorCum.length === segments.length;

        const rows = [];
        for (const cp of this.sortedCps) {
          const tp = nearestTrackpointAtKm(this.trackpoints, cp.km);
          const movingSec = secondsAtKm(cp.km, segments, cumSec);
          const arrivalSec = movingSec + stoppage(cp.km);
          const departSec = arrivalSec + (cp.stoppageSec || 0);
          // Prior arrival approximation: priorCumAvgPaces is per-segment
          // (cum-avg pace at each seg.endKm). We pick the segment that
          // contains cp.km and use that bucket's cum-avg × cp.km. This
          // matches the planner's "where was I at this km in 2025" view
          // within a few seconds.
          let priorDeltaSec = null;
          if (hasPrior) {
            const sIdx = clamp(segmentIndexForKm(segments, cp.km), 0, segments.length - 1);
            const priorPace = priorCum[sIdx];
            if (Number.isFinite(priorPace) && priorPace > 0) {
              const priorMovingSec = priorPace * cp.km;
              priorDeltaSec = movingSec - priorMovingSec; // +ve = plan slower than 2025
            }
          }

          const gelsByType = this.gelTypes.map(t => ({
            id: t.id,
            name: t.name,
            count: Number(cp.dropbag?.gels?.[t.id] || 0),
          }));

          rows.push({
            id: cp.id,
            uid: cp._uid,
            name: cp.name,
            km: cp.km,
            color: cp.color,
            notes: cp.notes || '',
            lat: tp ? tp.lat : null,
            lon: tp ? tp.lon : null,
            planArrivalSec: arrivalSec,
            planArrivalText: formatTimeOfDay(this.raceStartSec + arrivalSec),
            planDepartureText: formatTimeOfDay(this.raceStartSec + departSec),
            stoppageSec: cp.stoppageSec || 0,
            stoppageText: cp.stoppageSec ? formatHHMMSS(cp.stoppageSec).replace(/^00:/, '') : '',
            fluidL: Number(cp.dropbag?.fluidL || 0),
            waterL: Number(cp.dropbag?.waterL || 0),
            dropNotes: cp.dropbag?.notes || '',
            gelsByType,
            priorDeltaSec,
            priorDeltaText: priorDeltaSec == null ? '' : formatSignedDelta(priorDeltaSec),
          });
        }
        this.cpRows = rows;

        // Spectator points (Phase 2). Each has explicit lat/lon entered by
        // the runner; km is either authoritatively set on the snapshot OR
        // we re-snap it from the route trackpoints. ETA is interpolated
        // along the plan's segCumSec at that km.
        const spIn = Array.isArray(plan.spectatorPoints) ? plan.spectatorPoints : [];
        const spRows = [];
        for (const s of spIn) {
          const lat = Number(s.lat);
          const lon = Number(s.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          let km = Number(s.km);
          if (!Number.isFinite(km)) {
            // Best-effort snap: find the nearest trackpoint to lat/lon and
            // read its cumDistKm.
            km = nearestKmToLatLon(this.trackpoints, lat, lon);
          }
          if (!Number.isFinite(km)) continue;
          const movingSec = secondsAtKm(km, segments, cumSec);
          const arrivalSec = movingSec + stoppage(km);
          let priorDeltaSec = null;
          if (hasPrior) {
            const sIdx = clamp(segmentIndexForKm(segments, km), 0, segments.length - 1);
            const priorPace = priorCum[sIdx];
            if (Number.isFinite(priorPace) && priorPace > 0) {
              priorDeltaSec = movingSec - priorPace * km;
            }
          }
          spRows.push({
            id: s.id || ('SP' + (spRows.length + 1)),
            uid: s.id || ('sp_' + km.toFixed(2)),
            name: s.name || 'Spectator point',
            km,
            color: s.color || '#a371f7',
            notes: s.notes || '',
            accessNotes: s.accessNotes || '',
            address: s.address || '',
            lat, lon,
            planArrivalSec: arrivalSec,
            stoppageSec: 0,
            stoppageText: '',
            fluidL: 0, waterL: 0,
            gelsByType: [],
            dropNotes: '',
            priorDeltaSec,
            priorDeltaText: priorDeltaSec == null ? '' : formatSignedDelta(priorDeltaSec),
            isSpectator: true,
          });
        }
        this.spectatorRows = spRows;
      } catch (e) {
        console.error('[shareView] derive failed', e);
        this.status = 'error';
        this.errorMsg = String(e && e.message || e);
        this._clearDerived();
      }
    },

    // Interleaved ETA list: CPs + spectator points sorted by km (only when
    // the viewer has spectator points enabled, else just CPs).
    get combinedRows() {
      const cp = this.cpRows.map(r => ({ ...r, isSpectator: false }));
      const sp = this.prefs.showSpectatorPoints ? this.spectatorRows : [];
      return [...cp, ...sp].sort((a, b) => a.km - b.km);
    },

    get hasSpectators() { return this.spectatorRows.length > 0; },

    // === scenario picker ============================================
    get hasScenarios() {
      const scn = this.runDoc?.plan?.scenarios;
      if (!scn) return false;
      // Only show the picker if at least Plan B or C has a goal set (else
      // there's nothing to switch to). Always allow A.
      const hasB = scn.B && (scn.B.timeSec > 0 || scn.B.paceSecPerKm > 0 || scn.B.gapSecPerKm > 0);
      const hasC = scn.C && (scn.C.timeSec > 0 || scn.C.paceSecPerKm > 0 || scn.C.gapSecPerKm > 0);
      return hasB || hasC || this.priorAvailable;
    },
    get priorAvailable() {
      // Prior race scenario is meaningful only if the share doc has the
      // pre-derived prior pace arrays.
      const pr = this.runDoc?.plan?.priorRun;
      return !!(pr && Array.isArray(pr.priorCumAvgPaces) && pr.priorCumAvgPaces.length);
    },
    get scenarioPickerOptions() {
      const scn = this.runDoc?.plan?.scenarios || {};
      const out = [];
      const names = {
        A: scn.A?.name || 'Plan A',
        B: scn.B?.name || 'Plan B',
        C: scn.C?.name || 'Plan C',
        prior: scn.prior?.name || 'Prior race',
      };
      // Always include A. B and C only when they have a goal set.
      out.push({ key: 'A', label: names.A, enabled: true });
      if (scn.B && (scn.B.timeSec > 0 || scn.B.paceSecPerKm > 0 || scn.B.gapSecPerKm > 0)) {
        out.push({ key: 'B', label: names.B, enabled: true });
      }
      if (scn.C && (scn.C.timeSec > 0 || scn.C.paceSecPerKm > 0 || scn.C.gapSecPerKm > 0)) {
        out.push({ key: 'C', label: names.C, enabled: true });
      }
      if (this.priorAvailable) {
        out.push({ key: 'prior', label: names.prior, enabled: true });
      }
      return out;
    },

    _clearDerived() {
      this.trackpoints = [];
      this.segments = [];
      this.segPaces = [];
      this.segSec = [];
      this.segCumSec = [];
      this.totalSec = 0;
      this.sortedCps = [];
      this.cpRows = [];
      this.spectatorRows = [];
      this.gelTypes = [];
    },

    // === Chart panels (V4 v4.3) =====================================
    // Read-only ports of the planner's chart modules. Same modules, just
    // initialized with the derived data and no edit callbacks. Each panel
    // is collapsed by default (mobile screens are short); crew can expand
    // to drill in.

    // Track which chart panels the viewer has expanded.
    chartsExpanded: { elev: false, cumpace: false, segpace: false, p3d: false },
    _chartsBuilt: false,

    toggleChartPanel(key) {
      this.chartsExpanded = { ...this.chartsExpanded, [key]: !this.chartsExpanded[key] };
      // First expansion of a chart panel triggers a build (lazy-load).
      // Subsequent expansions just show/hide the existing canvas.
      if (this.chartsExpanded[key]) {
        this.$nextTick(() => this._buildChartIfNeeded(key));
      }
    },

    _buildChartIfNeeded(key) {
      if (!this.segments.length) return;
      const totalKm = this.trackpoints[this.trackpoints.length - 1]?.cumDistKm || 0;
      const cps = this.sortedCps;
      try {
        if (key === 'elev') {
          elevApi.initElevationChart('share-elev-canvas', this.trackpoints, this.segments, totalKm);
          elevApi.setElevationCheckpoints(cps);
          elevApi.onElevationHover(km => setHoverKm(km));
        } else if (key === 'cumpace') {
          // segGaps isn't tracked on shareView (planner-internal); pass
          // the moving paces as a stand-in so the GAP overlay can still
          // be rendered. Read-only — viewer can't drag-edit.
          cumApi.initCumPaceChart('share-cumpace-canvas', this.segments, this.segPaces, this.segPaces, this.segCumSec, totalKm, this.trackpoints);
          cumApi.onCumPaceHover(km => setHoverKm(km));
        } else if (key === 'segpace') {
          segPaceApi.initSegmentPaceChart('share-segpace-canvas', this.segments, this.segPaces, totalKm, this.trackpoints);
          segPaceApi.onSegmentPaceHover(km => setHoverKm(km));
          // No onSegmentPaceDrag wiring → drag-to-edit is a no-op.
        } else if (key === 'p3d') {
          p3dApi.init3DProfile('share-p3d');
          p3dApi.setRoute3D(this.trackpoints, this.segments);
          // Slim CP label resolver: just the code (no km/ETA) so labels
          // don't pile on top of each other when zoomed out. Tap a CP on
          // the 2D map for the full action sheet.
          // Code-only label wrapped in <strong> so the .cp3d-label CSS
          // accent applies (matches the planner's "little box" style).
          p3dApi.setCpLabelResolver3D(cp => cp.id ? `<strong>${escapeHtml(cp.id)}</strong>` : '');
          p3dApi.setCheckpoints3D(cps);
          p3dApi.onHover3D(km => setHoverKm(km));
        }
      } catch (e) {
        console.warn('[share] chart build failed for', key, e);
      }
    },

    // Called from _derive after segments change (scenario switch, broadcast).
    _refreshOpenCharts() {
      const totalKm = this.trackpoints[this.trackpoints.length - 1]?.cumDistKm || 0;
      const cps = this.sortedCps;
      try {
        if (this.chartsExpanded.elev) {
          elevApi.initElevationChart('share-elev-canvas', this.trackpoints, this.segments, totalKm);
          elevApi.setElevationCheckpoints(cps);
          elevApi.onElevationHover(km => setHoverKm(km));
        }
        if (this.chartsExpanded.cumpace) {
          cumApi.initCumPaceChart('share-cumpace-canvas', this.segments, this.segPaces, this.segPaces, this.segCumSec, totalKm, this.trackpoints);
          cumApi.onCumPaceHover(km => setHoverKm(km));
        }
        if (this.chartsExpanded.segpace) {
          segPaceApi.initSegmentPaceChart('share-segpace-canvas', this.segments, this.segPaces, totalKm, this.trackpoints);
          segPaceApi.onSegmentPaceHover(km => setHoverKm(km));
        }
        if (this.chartsExpanded.p3d) {
          p3dApi.setRoute3D(this.trackpoints, this.segments);
          // Code-only label wrapped in <strong> so the .cp3d-label CSS
          // accent applies (matches the planner's "little box" style).
          p3dApi.setCpLabelResolver3D(cp => cp.id ? `<strong>${escapeHtml(cp.id)}</strong>` : '');
          p3dApi.setCheckpoints3D(cps);
        }
      } catch (e) {
        console.warn('[share] chart refresh failed', e);
      }
    },

    _renderMap() {
      const mapEl = document.getElementById('share-map');
      if (!mapEl) return;
      initShareMap('share-map');
      setShareRoute(this.trackpoints);
      // Pass a label resolver so the marker tooltips honour the viewer's
      // code/name/km/ETA toggles. Returning '' means "no permanent label
      // for this marker" (tap-only).
      setShareCheckpoints(
        this.sortedCps,
        (cp) => this.openSheet(cp),
        (cp) => this.cpLabelHtml(cp),
      );
      // Render spectator points (Phase 2) if the runner shipped any and
      // the viewer hasn't hidden them.
      const sp = (this.runDoc?.plan?.spectatorPoints || []);
      const visibleSp = this.prefs.showSpectatorPoints ? sp : [];
      setShareSpectatorPoints(visibleSp, (s) => this.openSpectatorSheet(s));
      // Hover overlay — clamps along the route on mouse-move / tap. The
      // label reads "km X · HH:MM" honouring the viewer's clock pref.
      setShareHoverLabelResolver((km) => this._hoverLabel(km));
      // Click anywhere on the map (not a CP marker) → open a generic
      // action sheet with directions to that point on the route.
      onShareMapClick((p) => this.openPointSheet(p));
      // The Leaflet container may have sized to 0 if it was hidden during
      // init — recompute on the next tick.
      setTimeout(() => invalidateShareMap(), 50);
    },

    // Build the hover-overlay text for a given km. Interpolates planned
    // arrival from segCumSec + stoppage at that km, then formats per the
    // viewer's clock pref. Returns plain text; the overlay is an HTML
    // element so we keep this short and unstyled (CSS handles look).
    _hoverLabel(km) {
      if (!Number.isFinite(km) || !this.segments.length) return `km ${km.toFixed(1)}`;
      const movingSec = secondsAtKm(km, this.segments, this.segCumSec);
      // Stoppage before this km (CPs we've already passed).
      let stop = 0;
      for (const c of this.sortedCps) {
        if (Number.isFinite(c.km) && c.km < km) stop += c.stoppageSec || 0;
      }
      const arrival = this.raceStartSec + movingSec + stop;
      const pace = this._paceAtKm(km);
      const distLabel = `km ${km.toFixed(1)}`;
      const etaLabel = this.fmtClock(arrival);
      const paceLabel = pace ? ` · ${formatPace(pace)}/km` : '';
      return `<strong>${distLabel}</strong> · ${etaLabel}${paceLabel}`;
    },

    _paceAtKm(km) {
      if (!this.segments.length) return null;
      for (let i = 0; i < this.segments.length; i++) {
        const s = this.segments[i];
        if (km < s.endKm || i === this.segments.length - 1) return this.segPaces[i];
      }
      return null;
    },

    // Generic "point on route" sheet — opens when the user taps an empty
    // part of the map. Same shape as a CP sheet (so the existing
    // template renders it) but with no drop-bag and an "anywhere on
    // route" label instead of a CP code. Lets crew get directions to
    // any spot, not just the named CPs.
    openPointSheet(p) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
      const km = Number.isFinite(p.km) ? p.km : 0;
      const movingSec = this.segments.length ? secondsAtKm(km, this.segments, this.segCumSec) : 0;
      let stop = 0;
      for (const c of this.sortedCps) {
        if (Number.isFinite(c.km) && c.km < km) stop += c.stoppageSec || 0;
      }
      const arrivalSec = movingSec + stop;
      this.sheetCp = {
        id: '◉',
        uid: 'point_' + km.toFixed(2),
        name: 'Point on route',
        km,
        color: '#ffd166',
        notes: '',
        lat: p.lat,
        lon: p.lon,
        planArrivalSec: arrivalSec,
        stoppageSec: 0,
        stoppageText: '',
        fluidL: 0,
        waterL: 0,
        dropNotes: '',
        gelsByType: [],
        priorDeltaSec: null,
        priorDeltaText: '',
        isSpectator: false,
        isFreePoint: true,
      };
    },

    openSpectatorSheet(s) {
      // Spectator points use a separate sheet shape since they don't have
      // drop-bag contents. Re-use the cp-sheet structure with empty gels.
      this.sheetCp = {
        id: s.id || 'SP',
        uid: s.id || ('sp_' + s.km),
        name: s.name || 'Spectator point',
        km: Number(s.km) || 0,
        color: s.color || '#a371f7',
        notes: s.notes || '',
        lat: Number(s.lat),
        lon: Number(s.lon),
        planArrivalSec: s.planArrivalSec || 0,
        stoppageSec: 0,
        stoppageText: '',
        fluidL: 0,
        waterL: 0,
        dropNotes: s.accessNotes || '',
        gelsByType: [],
        priorDeltaSec: null,
        priorDeltaText: '',
        isSpectator: true,
      };
    },

    // === getters ============================================================

    get raceName() { return this.runDoc?.plan?.gpxName || 'Race plan'; },
    get raceDate() { return this.runDoc?.plan?.raceDate || ''; },
    get raceStartText() { return this.runDoc?.plan?.raceStart || ''; },
    // Honours the viewer's clock pref. Used by the header so "06:25" /
    // "6:25 AM" switches with the toggle.
    get raceStartFormatted() {
      return this.fmtClock(this.raceStartSec);
    },
    get finishText() {
      if (!this.totalSec) return '—';
      const stoppage = totalStoppageSec(this.sortedCps);
      return this.fmtClock(this.raceStartSec + this.totalSec + stoppage);
    },
    get totalKmText() {
      const total = this.trackpoints.length ? this.trackpoints[this.trackpoints.length - 1].cumDistKm : 0;
      return total ? total.toFixed(1) + ' km' : '';
    },
    get planTotalText() {
      const stoppage = totalStoppageSec(this.sortedCps);
      return this.totalSec ? formatHHMMSS(this.totalSec + stoppage) : '—';
    },
    get hasPrior() {
      const pr = this.runDoc?.plan?.priorRun;
      return !!(pr && Array.isArray(pr.priorCumAvgPaces) && pr.priorCumAvgPaces.length);
    },
    get priorLabel() {
      const pr = this.runDoc?.plan?.priorRun;
      if (!pr) return '';
      return pr.name || 'Prior race';
    },
    get priorTotalText() {
      const pr = this.runDoc?.plan?.priorRun;
      if (!pr || !pr.totalSec) return '';
      return formatHHMMSS(pr.totalSec);
    },
    get statusText() {
      if (this.status === 'loading') return 'Loading…';
      if (this.status === 'expired') return 'Link expired';
      if (this.status === 'not-found') return 'Run not found';
      if (this.status === 'invalid-token') return 'Invalid link';
      if (this.status === 'error') return 'Error';
      // Phase 1 has no live state; once Phase 3 ships, swap to live/idle.
      return 'Plan locked · pre-race';
    },
    get snapshotAgo() {
      const ms = this.runDoc?.updatedAt || this.runDoc?.createdAt;
      if (!ms) return '';
      // _now is bumped on a 5 s timer to keep this label fresh.
      const _ = this._now;
      return relativeTimeAgo(ms);
    },
    get expiresOnText() {
      const ms = this.runDoc?.expiresAt;
      if (!ms) return '';
      try {
        return new Date(ms).toLocaleDateString();
      } catch {
        return '';
      }
    },

    // === prefs / formatters =================================================

    // Format a time-of-day seconds value per the viewer's clock preference.
    // 24h gets full HH:MM:SS for race-day precision; 12h drops seconds since
    // crew glance and don't need them.
    fmtClock(sec) {
      if (!Number.isFinite(sec)) return '—';
      if (this.prefs.clock === '12h') return formatTimeOfDay12h(sec);
      return formatTimeOfDay(sec);
    },

    setClock(mode) {
      this.prefs = { ...this.prefs, clock: mode === '12h' ? '12h' : '24h' };
      savePrefs(this.prefs);
    },

    toggleLabel(field) {
      this.prefs = {
        ...this.prefs,
        labels: { ...this.prefs.labels, [field]: !this.prefs.labels[field] },
      };
      savePrefs(this.prefs);
      // Re-render the map so marker tooltips reflect the new label set.
      this.$nextTick(() => this._renderMap());
    },

    toggleSpectatorPoints() {
      this.prefs = { ...this.prefs, showSpectatorPoints: !this.prefs.showSpectatorPoints };
      savePrefs(this.prefs);
      this.$nextTick(() => this._renderMap());
    },

    // Dark / light theme. Inverts the CSS-var set on body.share-body.
    // Pure CSS swap — no map re-init or re-derive needed.
    toggleTheme() {
      const next = this.prefs.theme === 'light' ? 'dark' : 'light';
      this.prefs = { ...this.prefs, theme: next };
      savePrefs(this.prefs);
    },

    // Build the permanent label HTML for a CP marker, respecting the
    // viewer's label toggles. Returns '' when no fields are enabled —
    // shareMap.js treats that as "no permanent tooltip" (tap-only).
    cpLabelHtml(cp) {
      const L = this.prefs.labels;
      const parts = [];
      if (L.code && cp.id) parts.push(`<strong>${escapeHtml(cp.id)}</strong>`);
      if (L.name && cp.name) parts.push(escapeHtml(cp.name));
      if (L.km && Number.isFinite(cp.km)) parts.push(`km ${cp.km.toFixed(1)}`);
      if (L.eta) {
        const row = this.cpRows.find(r => r.uid === cp._uid || r.id === cp.id);
        if (row) parts.push(this.fmtClock(this.raceStartSec + row.planArrivalSec));
      }
      return parts.join(' · ');
    },

    // === action sheet =======================================================

    openSheet(cp) {
      // cp here is the original CP object passed to setShareCheckpoints
      // (which mutated _resolvedLat/_resolvedLon onto it). Find the
      // matching cpRows entry to get the rich row data.
      const row = this.cpRows.find(r => r.uid === cp._uid || r.id === cp.id);
      this.sheetCp = row || null;
    },
    closeSheet() { this.sheetCp = null; },

    googleHref(row) {
      if (!row || row.lat == null || row.lon == null) return '#';
      return googleMapsDir(row.lat, row.lon);
    },
    appleHref(row) {
      if (!row || row.lat == null || row.lon == null) return '#';
      return appleMapsDir(row.lat, row.lon);
    },
  };
}

// === helpers ==============================================================

function nearestTrackpointAtKm(tps, km) {
  if (!tps?.length) return null;
  let lo = 0, hi = tps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tps[mid].cumDistKm < km) lo = mid + 1;
    else hi = mid;
  }
  return tps[lo];
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Snap a lat/lon (e.g. spectator point GPS) to the route's nearest
// trackpoint and return its cumulative km. Used when the runner enters
// a spectator-point address but didn't pre-compute its km.
function nearestKmToLatLon(tps, lat, lon) {
  if (!tps?.length) return NaN;
  let best = NaN, bestD = Infinity;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const stride = Math.max(1, Math.floor(tps.length / 800));
  for (let i = 0; i < tps.length; i += stride) {
    const tp = tps[i];
    const dy = tp.lat - lat;
    const dx = (tp.lon - lon) * cosLat;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) { bestD = d2; best = tp.cumDistKm; }
  }
  return best;
}

function formatSignedDelta(sec) {
  if (!Number.isFinite(sec)) return '';
  const sign = sec >= 0 ? '+' : '−';
  const abs = Math.abs(Math.round(sec));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  if (h > 0) return `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${sign}${m}:${String(s).padStart(2, '0')}`;
}
