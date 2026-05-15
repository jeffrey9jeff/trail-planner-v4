// Leaflet map with hover snap-to-route, tile switcher, and permanent CP labels.

let map = null;
let routeLayer = null;
let cpLayer = null;
let hoverMarker = null;
let hoverTooltip = null;
let trackpoints = [];
let hoverCallback = null;
let labelResolver = null;
let cpLabelResolver = null; // (cp) => "km X · ETA HH:MM"
let resizeObserver = null;
let layerControl = null;

const TILE_LAYERS = {
  'Street (OSM)': () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }),
  'Topographic': () => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap, SRTM | OpenTopoMap', maxZoom: 17,
  }),
  'Satellite': () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics', maxZoom: 19,
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

export function initMap(containerId) {
  if (map) return;
  map = L.map(containerId, { preferCanvas: true });
  const layers = {};
  for (const [name, factory] of Object.entries(TILE_LAYERS)) layers[name] = factory();
  layers['Street (OSM)'].addTo(map);
  layerControl = L.control.layers(layers, {}, { collapsed: true, position: 'topright' }).addTo(map);
  cpLayer = L.layerGroup().addTo(map);

  map.on('mousemove', (e) => {
    if (!trackpoints.length) return;
    const km = nearestKmToLatLng(e.latlng.lat, e.latlng.lng);
    if (km !== null && hoverCallback) hoverCallback(km);
  });
  map.on('mouseout', () => { if (hoverCallback) hoverCallback(null); });

  const el = document.getElementById(containerId);
  if (el && window.ResizeObserver) {
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(() => map?.invalidateSize());
    resizeObserver.observe(el);
  }
}

export function setRoute(tps) {
  trackpoints = tps;
  if (routeLayer) routeLayer.remove();
  if (!tps || tps.length < 2) return;
  const latlngs = tps.map(p => [p.lat, p.lon]);
  routeLayer = L.polyline(latlngs, { color: '#ff8c42', weight: 4, opacity: 0.9, lineJoin: 'round' }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [20, 20] });
}

export function setCheckpoints(cps) {
  if (!cpLayer) return;
  cpLayer.clearLayers();
  if (!trackpoints.length) return;
  // Rotate label direction per CP so adjacent labels (e.g. Six Foot Track / Start / Return)
  // don't pile on top of each other. Order chosen so common pairs split apart visually.
  const DIRECTIONS = [
    { dir: 'right',  off: [8, 0] },
    { dir: 'left',   off: [-8, 0] },
    { dir: 'top',    off: [0, -8] },
    { dir: 'bottom', off: [0, 10] },
  ];
  let dirIdx = 0;
  for (const cp of cps) {
    if (cp.km == null || !isFinite(cp.km)) continue;
    const tp = nearestTrackpointAtKm(cp.km);
    if (!tp) continue;
    const fillColor = cp.color || (cp.id === 'FIN' ? '#6bcf7f' : (cp.id?.startsWith?.('WP') ? '#5fa8d3' : '#58a6ff'));
    const marker = L.circleMarker([tp.lat, tp.lon], {
      radius: 7, color: '#fff', weight: 2,
      fillColor, fillOpacity: 1,
    });
    const labelHtml = cpLabelResolver
      ? cpLabelResolver(cp)
      : `<strong>${escapeHtml(cp.id)}</strong> · km ${cp.km.toFixed(1)}`;
    if (labelHtml && labelHtml.length > 0) {
      const d = DIRECTIONS[dirIdx % DIRECTIONS.length];
      dirIdx++;
      marker.bindTooltip(labelHtml, {
        permanent: true,
        direction: d.dir,
        offset: L.point(d.off[0], d.off[1]),
        className: 'cp-permanent',
      });
    }
    cpLayer.addLayer(marker);
  }
}

// Bottom-left overlay element used to print the hover label without obscuring the
// route. Created lazily inside the map container the first time we have a hover.
let hoverOverlay = null;
function ensureHoverOverlay() {
  if (hoverOverlay || !map) return hoverOverlay;
  hoverOverlay = document.createElement('div');
  hoverOverlay.className = 'map-hover-overlay';
  map.getContainer().appendChild(hoverOverlay);
  return hoverOverlay;
}

export function setHover(km) {
  if (km === null || !trackpoints.length) {
    if (hoverMarker) { hoverMarker.remove(); hoverMarker = null; }
    if (hoverOverlay) hoverOverlay.style.display = 'none';
    return;
  }
  const tp = nearestTrackpointAtKm(km);
  if (!tp) return;
  if (!hoverMarker) {
    hoverMarker = L.circleMarker([tp.lat, tp.lon], {
      radius: 8, color: '#ffd166', weight: 3,
      fillColor: '#ff8c42', fillOpacity: 0.9, interactive: false,
    }).addTo(map);
  } else {
    hoverMarker.setLatLng([tp.lat, tp.lon]);
  }
  const label = labelResolver ? labelResolver(km) : `km ${km.toFixed(1)}`;
  const ov = ensureHoverOverlay();
  if (ov) {
    ov.innerHTML = label;
    ov.style.display = 'block';
  }
}

export function onHover(cb) { hoverCallback = cb; }
// V4 v4.5: external trigger for invalidateSize after the container is
// resized by the user (drag-to-resize handle).
export function invalidateMap() { map?.invalidateSize(); }
export function setLabelResolver(fn) { labelResolver = fn; }
export function setCpLabelResolver(fn) { cpLabelResolver = fn; }

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
