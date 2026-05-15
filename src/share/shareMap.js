// Read-only Leaflet map for the spectator share view.
//
// Forked from src/map.js because that module uses module-level singletons
// (map, routeLayer, cpLayer, …) and exposes the planner's hover-snap UX
// that the share view doesn't need. The fork is mobile-tuned:
//
//   - Single tile layer (Street/OSM) — no switcher (crew want familiar
//     basemap; Phase 2 will add satellite if useful at aid stations).
//   - No permanent CP tooltips (mobile screens are too small) — tap a
//     marker to fire `onCpClick(cp)`, which the caller wires to an
//     action sheet (CP info + directions buttons).
//   - No hover snap-to-route — irrelevant when there are no other charts
//     to sync hover state across.
//   - Phase 3 will add a pulsing "you are here" marker via setLivePosition().

let map = null;
let routeLayer = null;
let cpLayer = null;
let spectatorLayer = null;
let livePulse = null;
let hoverMarker = null;
let hoverOverlay = null;
let hoverCallback = null;
let hoverLabelResolver = null;     // (km) => 'km 23.8 · 9:16 AM'
let mapClickCallback = null;       // (km, lat, lon) — non-marker map clicks
let trackpoints = [];
let resizeObserver = null;
let layerControl = null;

// Tile providers — same set as the planner's map.js so crew can pick a
// basemap they recognise. Default is Street; Satellite is the most-asked-
// for when crew are at a remote aid station and want a visual reference.
const TILE_LAYERS = {
  'Street (OSM)': () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }),
  'Topographic': () => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap, SRTM | OpenTopoMap', maxZoom: 17,
  }),
  'Satellite': () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles © Esri', maxZoom: 19,
  }),
  'Hybrid (sat + labels)': () => L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri', maxZoom: 19,
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, opacity: 0.9,
    }),
  ]),
};

export function initShareMap(containerId) {
  if (map) return;
  map = L.map(containerId, { preferCanvas: true, zoomControl: true });
  const layers = {};
  for (const [name, factory] of Object.entries(TILE_LAYERS)) layers[name] = factory();
  layers['Street (OSM)'].addTo(map);
  // Tile switcher (top-right collapsible — saves screen real estate on
  // phones).
  layerControl = L.control.layers(layers, {}, { collapsed: true, position: 'topright' }).addTo(map);
  cpLayer = L.layerGroup().addTo(map);
  spectatorLayer = L.layerGroup().addTo(map);

  // Hover snap-to-route — same UX as the planner's map.js. Anywhere the
  // user hovers (or taps on mobile), we snap to the nearest km along the
  // route and surface that km + ETA via a small overlay + bus callback.
  map.on('mousemove', (e) => {
    if (!trackpoints.length) return;
    const km = nearestKmToLatLng(e.latlng.lat, e.latlng.lng);
    if (km !== null) setShareHover(km);
  });
  map.on('mouseout', () => setShareHover(null));
  // Tap/click anywhere on the map (not on a marker — see propagation
  // stop in setShareCheckpoints below): update hover + fire the
  // mapClickCallback so the share view can open a generic "point on
  // route" action sheet with directions to the snapped lat/lon.
  map.on('click', (e) => {
    if (!trackpoints.length) return;
    const km = nearestKmToLatLng(e.latlng.lat, e.latlng.lng);
    if (km !== null) setShareHover(km);
    if (mapClickCallback) {
      // Pass the snapped trackpoint (so directions hit the route, not
      // the exact click which might be a few hundred metres off-trail).
      const snapped = km != null ? nearestTrackpointAtKm(km) : null;
      mapClickCallback({
        km,
        lat: snapped?.lat ?? e.latlng.lat,
        lon: snapped?.lon ?? e.latlng.lng,
        rawLat: e.latlng.lat,
        rawLon: e.latlng.lng,
      });
    }
  });

  const el = document.getElementById(containerId);
  if (el && window.ResizeObserver) {
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(() => map?.invalidateSize());
    resizeObserver.observe(el);
  }
}

export function setShareRoute(tps) {
  trackpoints = tps || [];
  if (!map) return;
  if (routeLayer) { routeLayer.remove(); routeLayer = null; }
  if (trackpoints.length < 2) return;
  const latlngs = trackpoints.map(p => [p.lat, p.lon]);
  routeLayer = L.polyline(latlngs, {
    color: '#ff8c42', weight: 4, opacity: 0.9, lineJoin: 'round',
  }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [20, 20] });
}

// Render CP markers and wire each one's click to `onCpClick(cp)`.
// CP positions are snapped to the nearest trackpoint at cp.km, matching
// the planner's behaviour (so map dot lat/lon match what the runner sees).
//
// `labelHtml(cp)` (optional): returns the permanent-tooltip HTML for that
// CP, or '' to skip. Lets the viewer toggle code/name/km/ETA labels.
export function setShareCheckpoints(cps, onCpClick, labelHtml) {
  if (!cpLayer) return;
  cpLayer.clearLayers();
  if (!trackpoints.length) return;
  const DIRECTIONS = [
    { dir: 'right',  off: [10, 0] },
    { dir: 'left',   off: [-10, 0] },
    { dir: 'top',    off: [0, -10] },
    { dir: 'bottom', off: [0, 12] },
  ];
  let dirIdx = 0;
  for (const cp of cps) {
    if (cp.km == null || !isFinite(cp.km)) continue;
    const tp = nearestTrackpointAtKm(cp.km);
    if (!tp) continue;
    const fill = cp.color || (cp.id === 'FIN' ? '#6bcf7f' : '#58a6ff');
    const marker = L.circleMarker([tp.lat, tp.lon], {
      radius: 9,            // bigger than planner — easier to tap on phone
      color: '#fff', weight: 2,
      fillColor: fill, fillOpacity: 1,
    });
    // Attach the resolved lat/lon on the cp object so the action sheet
    // can pass them straight to googleMapsDir / appleMapsDir without
    // re-running the snap.
    cp._resolvedLat = tp.lat;
    cp._resolvedLon = tp.lon;
    if (typeof onCpClick === 'function') {
      marker.on('click', (e) => {
        // Stop bubbling so the map's click handler doesn't also fire and
        // open the generic "point on route" sheet over the top of the
        // CP-specific one.
        L.DomEvent.stopPropagation(e);
        onCpClick(cp);
      });
    }
    if (typeof labelHtml === 'function') {
      const html = labelHtml(cp);
      if (html) {
        const d = DIRECTIONS[dirIdx % DIRECTIONS.length];
        dirIdx++;
        marker.bindTooltip(html, {
          permanent: true,
          direction: d.dir,
          offset: L.point(d.off[0], d.off[1]),
          className: 'cp-permanent share-cp-permanent',
        });
      }
    }
    cpLayer.addLayer(marker);
  }
}

// Spectator points (Phase 2). Different marker shape so crew can tell at
// a glance which dots are "where to find the runner" (CP circles) and
// which are "where to stand for the best view" (spectator triangles —
// actually L.circleMarker with a different stroke/colour, since polygons
// aren't worth the complexity here).
export function setShareSpectatorPoints(points, onClick) {
  if (!spectatorLayer) return;
  spectatorLayer.clearLayers();
  if (!points?.length) return;
  for (const s of points) {
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const fill = s.color || '#a371f7';
    // Use an L.marker with a custom divIcon to make spectator points
    // visually distinct (diamond-shaped) without pulling in extra deps.
    const icon = L.divIcon({
      className: 'share-spectator-icon',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      html: `<div class="share-spectator-diamond" style="background:${escapeAttr(fill)}"></div>`,
    });
    const marker = L.marker([lat, lon], { icon });
    if (typeof onClick === 'function') {
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        onClick(s);
      });
    }
    spectatorLayer.addLayer(marker);
  }
}

function escapeAttr(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Phase-3 hook. Sets / updates a pulsing marker at the runner's live
// position. Pass null to clear. Wired now so Phase 3 only needs to call
// this from the subscribe callback.
export function setLivePosition(lat, lon) {
  if (!map) return;
  if (lat == null || lon == null) {
    if (livePulse) { livePulse.remove(); livePulse = null; }
    return;
  }
  if (!livePulse) {
    livePulse = L.circleMarker([lat, lon], {
      radius: 10,
      color: '#ffd166', weight: 3,
      fillColor: '#ff8c42', fillOpacity: 0.95,
      className: 'share-live-pulse',
    }).addTo(map);
  } else {
    livePulse.setLatLng([lat, lon]);
  }
}

// === Hover snap-to-route ====================================================

// Caller registers a resolver that turns `km` into the overlay text.
// Lives on shareView so it can format the time per the viewer's 24h/AM-PM
// preference and stitch in the ETA from the derived segCumSec.
export function setShareHoverLabelResolver(fn) { hoverLabelResolver = fn; }

// Register a callback for non-marker map clicks (i.e. tap anywhere on
// the map surface). Used by shareView to open a generic "directions to
// this point on the route" action sheet so crew can get nav to any spot,
// not just the named CPs.
export function onShareMapClick(cb) { mapClickCallback = cb; }

// Optional: notify shareView when the hover-km changes (e.g. if Phase 3
// wants the live status pill to react). Phase 1 doesn't use this.
export function onShareHover(cb) { hoverCallback = cb; }

function ensureHoverOverlay() {
  if (hoverOverlay || !map) return hoverOverlay;
  hoverOverlay = document.createElement('div');
  hoverOverlay.className = 'share-map-hover-overlay';
  map.getContainer().appendChild(hoverOverlay);
  return hoverOverlay;
}

export function setShareHover(km) {
  if (!map) return;
  if (km === null || !trackpoints.length) {
    if (hoverMarker) { hoverMarker.remove(); hoverMarker = null; }
    if (hoverOverlay) hoverOverlay.style.display = 'none';
    if (hoverCallback) hoverCallback(null);
    return;
  }
  const tp = nearestTrackpointAtKm(km);
  if (!tp) return;
  if (!hoverMarker) {
    hoverMarker = L.circleMarker([tp.lat, tp.lon], {
      radius: 7, color: '#ffd166', weight: 3,
      fillColor: '#ff8c42', fillOpacity: 0.9,
      interactive: false,
    }).addTo(map);
  } else {
    hoverMarker.setLatLng([tp.lat, tp.lon]);
  }
  const ov = ensureHoverOverlay();
  if (ov) {
    const label = hoverLabelResolver
      ? hoverLabelResolver(km)
      : `km ${km.toFixed(1)}`;
    ov.innerHTML = label;
    ov.style.display = 'block';
  }
  if (hoverCallback) hoverCallback(km);
}

function nearestKmToLatLng(lat, lng) {
  if (!trackpoints.length) return null;
  let bestKm = 0, bestD = Infinity;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const stride = Math.max(1, Math.floor(trackpoints.length / 800));
  for (let i = 0; i < trackpoints.length; i += stride) {
    const tp = trackpoints[i];
    const dy = tp.lat - lat;
    const dx = (tp.lon - lng) * cosLat;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) { bestD = d2; bestKm = tp.cumDistKm; }
  }
  return bestKm;
}

export function invalidateShareMap() { if (map) map.invalidateSize(); }

// === helpers ==============================================================

function nearestTrackpointAtKm(km) {
  if (!trackpoints.length) return null;
  let lo = 0, hi = trackpoints.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trackpoints[mid].cumDistKm < km) lo = mid + 1;
    else hi = mid;
  }
  return trackpoints[lo];
}
