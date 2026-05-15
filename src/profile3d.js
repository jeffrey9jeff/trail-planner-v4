// 3D route profile with checkpoints, LEFT-click pan, raycasting hover, HTML CP labels.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

let renderer = null;
let labelRenderer = null;
let scene = null;
let camera = null;
let controls = null;
let routeMesh = null;
let routeLine = null;
let baseMesh = null;
let hoverMarker = null;
let hoverPole = null;
let cpGroup = null;
let trackpointsCache = null;
let containerEl = null;
let overlayEl = null;
let raf = null;
let resizeObserver = null;
let projection = null;
let baseY = 0;
let labelResolver = null;
let cpLabelResolver = null;
let hoverCallback = null;
let raycaster = null;
let mouseNDC = null;
// Window over which the wall colour samples elevation change (in metres).
// Smaller = more sensitive — short rollers show their own colour rather than
// being smeared by the surrounding km-segment average.
let gradeWindowM = 150;
// Per-trackpoint grade computed during the last setRoute3D, so app.js can read
// the grade at a hovered km without recomputing it.
let lastTrackGrades = [];

const GRADE_COLORS = [
  { max: -7,  hex: 0x3d8bb5 },
  { max: -3,  hex: 0x5fa8d3 },
  { max:  3,  hex: 0x6bcf7f },
  { max:  7,  hex: 0xffd166 },
  { max: 12,  hex: 0xf0a868 },
  { max: 100, hex: 0xe95569 },
];
function colorForGrade(pct) {
  for (const c of GRADE_COLORS) if (pct <= c.max) return c.hex;
  return GRADE_COLORS[GRADE_COLORS.length - 1].hex;
}

function disposeObject(obj) {
  if (!obj) return;
  if (obj.traverse) {
    obj.traverse(o => {
      if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
      o.geometry?.dispose();
      o.material?.dispose();
    });
  } else {
    if (obj.isCSS2DObject && obj.element?.parentNode) obj.element.parentNode.removeChild(obj.element);
    obj.geometry?.dispose();
    obj.material?.dispose();
  }
}

export function init3DProfile(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  containerEl = el;

  if (renderer) { renderer.dispose?.(); el.innerHTML = ''; }

  scene = new THREE.Scene();
  scene.background = null;

  const w = el.clientWidth || 600;
  const h = el.clientHeight || 360;
  camera = new THREE.PerspectiveCamera(45, w / h, 1, 2_000_000);
  camera.position.set(60_000, 40_000, 60_000);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h);
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  el.appendChild(renderer.domElement);

  labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(w, h);
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.top = '0';
  labelRenderer.domElement.style.left = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  el.appendChild(labelRenderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.minDistance = 2_000;
  controls.maxDistance = 700_000;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dir = new THREE.DirectionalLight(0xffffff, 0.45);
  dir.position.set(1, 2, 1);
  scene.add(dir);

  raycaster = new THREE.Raycaster();
  mouseNDC = new THREE.Vector2();

  if (overlayEl) overlayEl.remove();
  overlayEl = document.createElement('div');
  overlayEl.className = 'profile3d-overlay';
  overlayEl.innerHTML = '<div class="hint">drag to pan · right-drag to rotate · scroll to zoom toward cursor</div><div class="hover" hidden></div>';
  el.appendChild(overlayEl);

  renderer.domElement.addEventListener('mousemove', (event) => {
    if (!routeMesh || !trackpointsCache?.length) return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouseNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouseNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouseNDC, camera);
    const hits = raycaster.intersectObject(routeMesh, false);
    if (hits.length) {
      const km = nearestKmToPoint(hits[0].point);
      if (km != null && hoverCallback) hoverCallback(km);
    }
  });
  renderer.domElement.addEventListener('mouseleave', () => { if (hoverCallback) hoverCallback(null); });

  if (window.ResizeObserver) {
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(() => {
      if (!renderer || !camera || !containerEl) return;
      const ww = containerEl.clientWidth, hh = containerEl.clientHeight;
      if (ww > 0 && hh > 0) {
        renderer.setSize(ww, hh);
        labelRenderer?.setSize(ww, hh);
        camera.aspect = ww / hh;
        camera.updateProjectionMatrix();
      }
    });
    resizeObserver.observe(el);
  }
  animate();
}

function animate() {
  if (!renderer) return;
  controls?.update();
  renderer.render(scene, camera);
  labelRenderer?.render(scene, camera);
  raf = requestAnimationFrame(animate);
}

function nearestKmToPoint(point) {
  if (!trackpointsCache?.length || !projection) return null;
  let bestKm = 0, bestD = Infinity;
  const stride = Math.max(1, Math.floor(trackpointsCache.length / 800));
  for (let i = 0; i < trackpointsCache.length; i += stride) {
    const tp = trackpointsCache[i];
    const proj = projection(tp.lat, tp.lon, tp.eleM);
    const dx = proj.x - point.x;
    const dz = proj.z - point.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD) { bestD = d2; bestKm = tp.cumDistKm; }
  }
  return bestKm;
}

export function setRoute3D(trackpoints, segments) {
  if (!scene || !trackpoints?.length) return;
  // Preserve the camera + controls when this is a recolour-only rebuild (e.g. user
  // dragged the sensitivity slider). Without this the camera resets to default and
  // the user loses any pan / zoom / rotate they'd applied.
  const isRebuild = !!routeMesh;
  const savedCam = isRebuild ? {
    position: camera.position.clone(),
    target: controls.target.clone(),
    zoom: camera.zoom,
  } : null;
  trackpointsCache = trackpoints;

  for (const obj of [routeMesh, routeLine, baseMesh, hoverMarker, hoverPole, cpGroup]) {
    if (!obj) continue;
    scene.remove(obj);
    disposeObject(obj);
  }
  routeMesh = routeLine = baseMesh = hoverMarker = hoverPole = cpGroup = null;

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let minEle = Infinity, maxEle = -Infinity;
  for (const tp of trackpoints) {
    if (tp.lat < minLat) minLat = tp.lat;
    if (tp.lat > maxLat) maxLat = tp.lat;
    if (tp.lon < minLon) minLon = tp.lon;
    if (tp.lon > maxLon) maxLon = tp.lon;
    if (tp.eleM < minEle) minEle = tp.eleM;
    if (tp.eleM > maxEle) maxEle = tp.eleM;
  }
  const centerLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos(centerLat * Math.PI / 180);
  const lat2m = 111_000;
  const lon2m = 111_000 * cosLat;
  const eleScale = 5;
  baseY = -((maxEle - minEle) * eleScale * 0.05);

  projection = (lat, lon, eleM) => new THREE.Vector3(
    (lon - (minLon + maxLon) / 2) * lon2m,
    (eleM - minEle) * eleScale,
    -(lat - centerLat) * lat2m,
  );

  // Per-trackpoint local grade — linear least-squares slope of elevation vs distance
  // across a ± half-window centred on the point. The regression is much more robust
  // to GPS jitter than just diffing the endpoints, so an uphill stretch with a small
  // dip in the middle still shows yellow/red instead of accidentally green.
  function localGrade(i) {
    const tp = trackpoints[i];
    const halfKm = gradeWindowM / 2000;
    let lo = i, hi = i;
    while (lo > 0 && (tp.cumDistKm - trackpoints[lo - 1].cumDistKm) < halfKm) lo--;
    while (hi < trackpoints.length - 1 && (trackpoints[hi + 1].cumDistKm - tp.cumDistKm) < halfKm) hi++;
    const n = hi - lo + 1;
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let j = lo; j <= hi; j++) {
      const x = trackpoints[j].cumDistKm * 1000;  // metres
      const y = trackpoints[j].eleM;
      sx += x; sy += y; sxy += x * y; sxx += x * x;
    }
    const denom = n * sxx - sx * sx;
    if (denom <= 0) return 0;
    const slope = (n * sxy - sx * sy) / denom;  // m / m
    return slope * 100;                          // % grade
  }

  lastTrackGrades = new Array(trackpoints.length);
  const positions = [], colors = [], indices = [], linePos = [], lineColors = [];
  for (let i = 0; i < trackpoints.length; i++) {
    const tp = trackpoints[i];
    const top = projection(tp.lat, tp.lon, tp.eleM);
    const grade = localGrade(i);
    lastTrackGrades[i] = grade;
    const col = new THREE.Color(colorForGrade(grade));
    const colDim = col.clone().multiplyScalar(0.55);

    positions.push(top.x, top.y, top.z);
    positions.push(top.x, baseY, top.z);
    colors.push(col.r, col.g, col.b);
    colors.push(colDim.r, colDim.g, colDim.b);
    linePos.push(top.x, top.y, top.z);
    lineColors.push(col.r, col.g, col.b);

    if (i > 0) {
      const a = (i - 1) * 2, b = (i - 1) * 2 + 1, c = i * 2, d = i * 2 + 1;
      indices.push(a, b, d, a, d, c);
    }
  }

  const wallGeom = new THREE.BufferGeometry();
  wallGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  wallGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  wallGeom.setIndex(indices);
  wallGeom.computeVertexNormals();
  routeMesh = new THREE.Mesh(wallGeom, new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: 0, roughness: 0.85, side: THREE.DoubleSide,
  }));
  scene.add(routeMesh);

  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
  lineGeom.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
  routeLine = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ vertexColors: true }));
  scene.add(routeLine);

  const dx = (maxLon - minLon) * lon2m;
  const dz = (maxLat - minLat) * lat2m;
  const baseGeom = new THREE.PlaneGeometry(dx * 1.6 + 6000, dz * 1.6 + 6000);
  baseGeom.rotateX(-Math.PI / 2);
  baseMesh = new THREE.Mesh(baseGeom, new THREE.MeshStandardMaterial({ color: 0x1c2330, transparent: true, opacity: 0.55 }));
  baseMesh.position.y = baseY - 50;
  scene.add(baseMesh);

  const dy = (maxEle - minEle) * eleScale;
  const span = Math.max(dx, dz, dy);
  const dist = span * 1.5;
  if (savedCam) {
    camera.position.copy(savedCam.position);
    controls.target.copy(savedCam.target);
    camera.zoom = savedCam.zoom;
    camera.updateProjectionMatrix();
  } else {
    camera.position.set(dist * 0.7, dist * 0.45, dist * 0.7);
    camera.lookAt(0, dy / 2, 0);
    controls.target.set(0, dy / 2, 0);
  }
  controls.update();
}

export function setCheckpoints3D(cps) {
  if (!scene || !trackpointsCache?.length || !projection) return;
  if (cpGroup) {
    scene.remove(cpGroup);
    disposeObject(cpGroup);
    cpGroup = null;
  }
  cpGroup = new THREE.Group();
  for (const cp of cps) {
    if (cp.km == null || !isFinite(cp.km)) continue;
    const tp = nearestTrackpointAtKm(cp.km);
    if (!tp) continue;
    const p = projection(tp.lat, tp.lon, tp.eleM);
    const fillHex = parseInt((cp.color || '#58a6ff').replace('#', ''), 16);

    const poleHeight = (p.y - baseY) + 800;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(40, 40, poleHeight, 8),
      new THREE.MeshStandardMaterial({ color: fillHex, transparent: true, opacity: 0.85 })
    );
    pole.position.set(p.x, baseY + poleHeight / 2, p.z);
    cpGroup.add(pole);

    const knobY = baseY + poleHeight + 220;
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(220, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: fillHex, emissiveIntensity: 0.5 })
    );
    knob.position.set(p.x, knobY, p.z);
    cpGroup.add(knob);

    const div = document.createElement('div');
    div.className = 'cp3d-label';
    div.style.borderColor = cp.color || '#58a6ff';
    const html = cpLabelResolver ? cpLabelResolver(cp) : `<strong>${cp.id}</strong> · km ${cp.km.toFixed(1)}`;
    if (!html || html.trim().length === 0) continue; // all toggles off
    div.innerHTML = html;
    const label = new CSS2DObject(div);
    label.position.set(p.x, knobY + 380, p.z);
    cpGroup.add(label);
  }
  scene.add(cpGroup);
  // Force immediate render so CSS2DObjects attach to the DOM right away (avoids relying on rAF).
  try { renderer?.render(scene, camera); labelRenderer?.render(scene, camera); } catch {}
}

function nearestTrackpointAtKm(km) {
  if (!trackpointsCache?.length) return null;
  let lo = 0, hi = trackpointsCache.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trackpointsCache[mid].cumDistKm < km) lo = mid + 1;
    else hi = mid;
  }
  return trackpointsCache[lo];
}

export function setHover3D(km) {
  if (!scene || !trackpointsCache) return;
  if (km == null) {
    for (const obj of [hoverMarker, hoverPole]) {
      if (!obj) continue;
      scene.remove(obj);
      disposeObject(obj);
    }
    hoverMarker = hoverPole = null;
    if (overlayEl) {
      const hover = overlayEl.querySelector('.hover');
      if (hover) { hover.hidden = true; hover.textContent = ''; }
    }
    return;
  }
  const tp = nearestTrackpointAtKm(km);
  if (!tp || !projection) return;
  const p = projection(tp.lat, tp.lon, tp.eleM);

  if (!hoverMarker) {
    hoverMarker = new THREE.Mesh(
      new THREE.SphereGeometry(280, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0xff8c42, emissiveIntensity: 0.6 })
    );
    scene.add(hoverMarker);
  }
  hoverMarker.position.copy(p);

  if (!hoverPole) {
    const poleGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, baseY, 0), new THREE.Vector3(0, 0, 0),
    ]);
    hoverPole = new THREE.Line(poleGeom, new THREE.LineBasicMaterial({ color: 0xffd166 }));
    scene.add(hoverPole);
  }
  const arr = hoverPole.geometry.attributes.position.array;
  arr[0] = p.x; arr[1] = baseY; arr[2] = p.z;
  arr[3] = p.x; arr[4] = p.y;   arr[5] = p.z;
  hoverPole.geometry.attributes.position.needsUpdate = true;
  hoverPole.geometry.computeBoundingSphere();

  if (overlayEl && labelResolver) {
    const label = labelResolver(km);
    const hover = overlayEl.querySelector('.hover');
    if (hover) { hover.textContent = label; hover.hidden = false; }
  }
}

export function setLabelResolver3D(fn) { labelResolver = fn; }
export function setCpLabelResolver3D(fn) { cpLabelResolver = fn; }
export function onHover3D(cb) { hoverCallback = cb; }
// Sensitivity in metres — the half-window over which the wall colour samples
// elevation change. Smaller = more responsive to short pitches; larger = smoother.
// Caller should re-invoke setRoute3D after changing this.
export function setColorSensitivity3D(windowM) { gradeWindowM = Math.max(10, Math.round(Number(windowM) || 150)); }
export function getColorSensitivity3D() { return gradeWindowM; }
// Looks up the windowed grade at a given km from the last setRoute3D pass. Used
// by app.js to surface the grade in the 3D hover label.
export function gradeAtKm3D(km) {
  if (!trackpointsCache?.length || !lastTrackGrades?.length) return null;
  if (km <= trackpointsCache[0].cumDistKm) return lastTrackGrades[0];
  if (km >= trackpointsCache[trackpointsCache.length - 1].cumDistKm) return lastTrackGrades[lastTrackGrades.length - 1];
  let lo = 0, hi = trackpointsCache.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trackpointsCache[mid].cumDistKm < km) lo = mid; else hi = mid;
  }
  return lastTrackGrades[lo];
}

export function destroy3DProfile() {
  if (raf) cancelAnimationFrame(raf);
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = null;
  if (cpGroup) { scene.remove(cpGroup); disposeObject(cpGroup); cpGroup = null; }
  if (renderer) { renderer.dispose(); renderer.domElement.remove(); renderer = null; }
  if (labelRenderer) { labelRenderer.domElement.remove(); labelRenderer = null; }
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  scene = camera = controls = routeMesh = routeLine = baseMesh = hoverMarker = hoverPole = null;
  trackpointsCache = containerEl = projection = null;
  raycaster = mouseNDC = null;
}
