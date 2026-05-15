// build-standalone.mjs — one-off helper to generate a self-contained
// share HTML from the command line. Mirrors the exportShareHTML logic
// in src/app.js (IIFE registry bundle, Alpine UMD, 3D excluded).
//
// Usage:
//   node build-standalone.mjs <V4_DIR> <PLAN_JSON> <OUT_HTML>
// e.g.:
//   node build-standalone.mjs . ./plan.json ./crew.html

import fs from 'fs';
import path from 'path';

const [, , V4_DIR = '.', PLAN_JSON, OUT_HTML = 'crew.html'] = process.argv;
if (!PLAN_JSON) {
  console.error('Usage: node build-standalone.mjs <V4_DIR> <PLAN_JSON> <OUT_HTML>');
  process.exit(2);
}

// --- 1. Module manifest + path rewrite map (mirrors app.js exportShareHTML)
const manifest = [
  ['minetti', 'src/minetti.js'],
  ['gpx', 'src/gpx.js'],
  ['segments', 'src/segments.js'],
  ['pacePlan', 'src/pacePlan.js'],
  ['uta100', 'src/presets/uta100.js'],
  ['checkpoints', 'src/checkpoints.js'],
  ['storeLocal', 'src/share/storeLocal.js'],
  ['storeIndex', 'src/share/index.js'],
  ['dirLinks', 'src/share/dirLinks.js'],
  ['shareMap', 'src/share/shareMap.js'],
  ['snapshotFilter', 'src/share/snapshotFilter.js'],
  ['sync', 'src/sync.js'],
  ['elevationChart', 'src/elevationChart.js'],
  ['cumulativePaceChart', 'src/cumulativePaceChart.js'],
  ['segmentPaceChart', 'src/segmentPaceChart.js'],
  ['shareView', 'src/share/shareView.js'],
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

// --- 2. buildModuleIIFE (same regex transforms as app.js)
function buildModuleIIFE(id, src) {
  src = src.replace(/(['"])(\.[^'"]+?\.js)\?v=v\d+\1/g, '$1$2$1');
  const imports = [];
  src = src.replace(
    /^\s*import\s+([\s\S]+?)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
    (m, names, q, p) => {
      names = names.trim();
      if (p === 'three' || p.startsWith('three/')) {
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
        if (names.startsWith('{')) imports.push(`const ${names} = {};`);
        return '';
      }
      if (names.startsWith('*')) {
        const alias = (names.match(/as\s+(\w+)/) || [])[1];
        if (alias) imports.push(`const ${alias} = (__shareMods.${target} || {});`);
      } else if (names.startsWith('{')) {
        imports.push(`const ${names} = (__shareMods.${target} || {});`);
      } else {
        imports.push(`const ${names} = (__shareMods.${target} && (__shareMods.${target}.default || __shareMods.${target})) || {};`);
      }
      return '';
    }
  );
  const exports = [];
  src = src.replace(
    /^(\s*)export\s+(const|let|var)\s+\{([^}]+)\}/gm,
    (m, ind, kw, list) => {
      for (const piece of list.split(',')) {
        const t = piece.trim();
        if (!t) continue;
        const localName = t.split(/[:=]/)[0].split(/\s+as\s+/).pop().trim();
        if (localName) exports.push(localName);
      }
      return `${ind}${kw} {${list}}`;
    }
  );
  src = src.replace(
    /^(\s*)export\s+(function|const|let|var|class|async\s+function)(\s+)(\w+)/gm,
    (m, ind, kw, sp, name) => { exports.push(name); return `${ind}${kw}${sp}${name}`; }
  );
  src = src.replace(/^\s*export\s*\{([^}]+)\}\s*;?\s*$/gm, (m, list) => {
    for (const piece of list.split(',')) {
      const t = piece.trim();
      if (!t) continue;
      const localName = t.split(/\s+as\s+/)[0].trim();
      if (localName) exports.push(localName);
    }
    return '';
  });
  return (
    `__shareMods.${id} = (function(){\n` +
    imports.join('\n') + '\n' +
    src + '\n' +
    `return { ${[...new Set(exports)].join(', ')} };\n` +
    `})();`
  );
}

// --- 3. snapshot filter (pure JS port of share/snapshotFilter.js)
function filterDropbag(db) {
  db = db || {};
  const gels = (db.gels && typeof db.gels === 'object') ? { ...db.gels } : {};
  return { gels, fluidL: +db.fluidL || 0, waterL: +db.waterL || 0, notes: db.notes || '' };
}
function filterCheckpoint(cp) {
  return {
    id: cp.id, name: cp.name, km: cp.km,
    stoppageSec: cp.stoppageSec || 0,
    color: cp.color, notes: cp.notes || '', _uid: cp._uid,
    dropbag: filterDropbag(cp.dropbag),
  };
}
function filterNutrition(nu) {
  nu = nu || {};
  const inv = nu.startInventory || {};
  return {
    gelGPerHr: +nu.gelGPerHr || 40,
    fluidGPerHr: +nu.fluidGPerHr || 50,
    fluidLPerHr: +nu.fluidLPerHr || 0.5,
    gelTypes: (Array.isArray(nu.gelTypes) ? nu.gelTypes : []).map(t => ({
      id: String(t.id || ''), name: t.name || '', sizeG: +t.sizeG || 25,
    })),
    startInventory: {
      gels: (inv.gels && typeof inv.gels === 'object') ? { ...inv.gels } : {},
      fluidL: +inv.fluidL || 0, waterL: +inv.waterL || 0, notes: inv.notes || '',
    },
  };
}
function filterPriorRun(pr) {
  if (!pr || typeof pr !== 'object') return null;
  return {
    name: pr.name || 'Prior race', source: pr.source || 'fit',
    totalSec: +pr.totalSec || 0, totalDistanceKm: +pr.totalDistanceKm || 0,
    priorSegPaces: Array.isArray(pr.priorSegPaces) ? pr.priorSegPaces.slice() : [],
    priorSegPaceDeltas: Array.isArray(pr.priorSegPaceDeltas) ? pr.priorSegPaceDeltas.slice() : [],
    priorCumAvgPaces: Array.isArray(pr.priorCumAvgPaces) ? pr.priorCumAvgPaces.slice() : [],
  };
}
function filterScenarios(scn) {
  const out = {};
  for (const k of ['A', 'B', 'C', 'prior']) {
    const sc = (scn && scn[k]) || {};
    out[k] = {
      name: sc.name || (k === 'prior' ? 'Prior race' : 'Plan ' + k),
      mode: ['time', 'pace', 'gap'].includes(sc.mode) ? sc.mode : 'time',
      timeSec: +sc.timeSec || 0, paceSecPerKm: +sc.paceSecPerKm || 0, gapSecPerKm: +sc.gapSecPerKm || 0,
      overrides: Array.isArray(sc.overrides)
        ? sc.overrides.map(o => ({ idx: +o.idx, gapSecPerKm: +o.gapSecPerKm, mode: o.mode === 'anchor' ? 'anchor' : 'point' }))
          .filter(o => Number.isFinite(o.idx) && Number.isFinite(o.gapSecPerKm))
        : [],
      gradientPaceOverrides: { ...(sc.gradientPaceOverrides || {}) },
      technicalGradientPaceOverrides: { ...(sc.technicalGradientPaceOverrides || {}) },
      technicalIndices: Array.isArray(sc.technicalIndices) ? sc.technicalIndices.filter(Number.isFinite) : [],
      cpStops: sc.cpStops && typeof sc.cpStops === 'object' ? { ...sc.cpStops } : {},
      paceShift: sc.paceShift && typeof sc.paceShift === 'object'
        ? { mode: ['gap','percent','seconds'].includes(sc.paceShift.mode) ? sc.paceShift.mode : 'gap', value: +sc.paceShift.value || 0 }
        : { mode: 'gap', value: 0 },
    };
  }
  return out;
}
function filterSnapshotForShare(snap) {
  if (!snap || typeof snap !== 'object') return null;
  const filtered = {
    version: snap.version || 8,
    gpxName: snap.gpxName || '', gpxText: snap.gpxText || '',
    splitKm: +snap.splitKm || 1, raceStart: snap.raceStart || '06:00:00', raceDate: snap.raceDate || '',
    goal: { ...(snap.goal || {}) },
    overrides: Array.isArray(snap.overrides)
      ? snap.overrides.map(o => ({ idx: +o.idx, gapSecPerKm: +o.gapSecPerKm, mode: o.mode || 'anchor' })) : [],
    gradientPaceOverrides: { ...(snap.gradientPaceOverrides || {}) },
    technicalGradientPaceOverrides: { ...(snap.technicalGradientPaceOverrides || {}) },
    technicalIndices: Array.isArray(snap.technicalIndices) ? [...snap.technicalIndices] : [],
    technicalSlowdown: +snap.technicalSlowdown || 1.2,
    splitBias: +snap.splitBias || 0, uphillEffort: +snap.uphillEffort || 1.0,
    checkpoints: Array.isArray(snap.checkpoints) ? snap.checkpoints.map(filterCheckpoint) : [],
    nutrition: filterNutrition(snap.nutrition),
    priorRun: filterPriorRun(snap.priorRun),
    spectatorPoints: Array.isArray(snap.spectatorPoints)
      ? snap.spectatorPoints.map(sp => ({
          id: sp.id || '', name: sp.name || 'Spectator point',
          lat: +sp.lat, lon: +sp.lon,
          km: Number.isFinite(sp.km) ? sp.km : null,
          color: sp.color || '#a371f7', notes: sp.notes || '',
          address: sp.address || '', accessNotes: sp.accessNotes || '',
        })).filter(sp => Number.isFinite(sp.lat) && Number.isFinite(sp.lon))
      : [],
    scenarios: filterScenarios(snap.scenarios),
    activeScenario: ['A','B','C','prior'].includes(snap.activeScenario) ? snap.activeScenario : 'A',
  };
  return JSON.parse(JSON.stringify(filtered));
}

// --- 4. Build the bundle script
const sources = {};
for (const [id, p] of manifest) {
  sources[id] = fs.readFileSync(path.join(V4_DIR, p), 'utf8');
}
const chunks = manifest.map(([id]) => buildModuleIIFE(id, sources[id]));
const bundleScript =
  '(function(){\n' +
  'var __shareMods = window.__shareMods = {};\n' +
  chunks.join('\n\n// === module boundary ===\n\n') + '\n\n' +
  'window.__SHARE_VIEW_FACTORY__ = __shareMods.shareView.shareView;\n' +
  '})();';

// --- 5. Read share.html, apply same replacements
let html = fs.readFileSync(path.join(V4_DIR, 'share.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="\.\/styles\.css[^"]*"[^>]*>/, '');
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, '');
// v4.10 fix: anchor on `es-module-shims` IMMEDIATELY after `<!--` so we
// don't accidentally devour every `<!-- … -->` comment from the first one
// onwards (the previous lazy pattern matched from any `<!--` it could
// reach forward to `es-module-shims`, eating all body templates).
html = html.replace(/<!--\s*es-module-shims[\s\S]*?-->\s*/, '');
html = html.replace(/<script[^>]*es-module-shims[^>]*>\s*<\/script>/, '');
html = html.replace(
  /<section class="share-panel chart-panel">\s*<div class="share-panel-header chart-panel-header" @click="toggleChartPanel\('p3d'\)">[\s\S]*?<\/section>/,
  ''
);
const bootstrapPlain =
  `<script src="https://cdn.jsdelivr.net/npm/alpinejs@3.13.5/dist/cdn.min.js" defer></script>\n` +
  `<script>\n` + bundleScript + '\n' +
  `document.addEventListener('alpine:init', function() {\n` +
  `  window.Alpine.data('shareView', window.__SHARE_VIEW_FACTORY__);\n` +
  `});\n` +
  `</script>`;
html = html.replace(/<script type="module">[\s\S]*?<\/script>/, bootstrapPlain);

// --- 6. Load + filter plan
const snap = JSON.parse(fs.readFileSync(PLAN_JSON, 'utf8'));
const filtered = filterSnapshotForShare(snap);
const dataScript = `\n<script>\n` +
  `window.__TRAIL_SHARE_STATIC__ = ${JSON.stringify(filtered)};\n` +
  `window.__TRAIL_SHARE_STATIC_AT__ = ${Date.now()};\n` +
  `</script>\n`;
html = html.replace(/<body class="share-body"[^>]*>/, m => m + dataScript);

// --- 7. Write
fs.writeFileSync(OUT_HTML, html);
console.log(`Wrote ${OUT_HTML} — ${(html.length / 1024).toFixed(1)} KB`);
