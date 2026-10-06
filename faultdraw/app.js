// FaultDraw — draw fault traces on public basemaps.
// User data stays in memory, localStorage (traces), and IndexedDB (inputs).
// This file never fetches or posts user files.

import { wgs84ToUtm11N } from './utm.js';
import { idbPut, idbGetAll, idbClear } from './idb.js';
import {
  sidecarCandidates,
  parseBounds,
  base64ToBlob,
  classifyJson,
  columnarQuakes,
  parseCsv,
  splitFeatureCollection,
  lineCollection,
} from './parse.js';

const L = window.L;

const STUDY_CENTER = [38.9, -117.5]; // fixed camera, not a data extent
const STUDY_ZOOM = 7;
const TRACES_KEY = 'faultdraw.v1.traces';
const LAST_EXPORT_KEY = 'faultdraw.v1.lastExport';
const EXPORT_DIGEST_KEY = 'faultdraw.v1.exportDigest';
const BANNER_KEY = 'faultdraw.bannerDismissedDigest';
const HISTORY_LIMIT = 50;

const DEPTH_STOPS = [
  [0, [253, 231, 37]],
  [0.25, [94, 201, 98]],
  [0.5, [33, 145, 140]],
  [0.75, [59, 82, 139]],
  [1, [68, 1, 84]],
];

const $ = (id) => document.getElementById(id);

const banner = $('banner');
const dirtyDot = $('dirty-dot');
const panel = $('panel');
const statusLine = $('status-line');
const bundleNoteEl = $('bundle-note');
const errorList = $('status-errors');
const layerList = $('layer-list');
const opacityFav = $('opacity-fav');
const opacityFavLabel = $('opacity-fav-label');
const favLegend = $('fav-legend');
const favMetaEl = $('fav-meta');
const opacityDots = $('opacity-dots');
const opacityDotsLabel = $('opacity-dots-label');
const dotsMetaEl = $('dots-meta');
const minmagInput = $('minmag');
const minmagNum = $('minmag-num');
const quakeCountEl = $('quake-count');
const quakeLegend = $('quake-legend');
const magLegend = $('mag-legend');
const busyEl = $('busy');
const undoBtn = $('btn-undo');
const redoBtn = $('btn-redo');
const traceStatsEl = $('trace-stats');
const dirtyFlag = $('dirty-flag');
const exportLabel = $('export-label');
const dropOverlay = $('drop-overlay');
const loadingEl = $('loading');
const loadingText = $('loading-text');

let statusText = '';
let errors = [];
let restoredAt = null;
let bundleNote = '';
let quakeShown = 0;
let quakeTotal = 0;
let lastLatLng = null;
let commitTimer = null;
let suspend = false;
let history = [];
let historyIndex = -1;
let quakeToken = 0;
let dragDepth = 0;
let loadChain = Promise.resolve();
let boot = Promise.resolve();

const urls = { favorability: null, dots: null };
const dataState = {
  favorability: null,
  dots: null,
  faults: null,
  hypocenters: null,
};

const layers = {
  favorability: null,
  dots: null,
  faults: null,
  hypocenters: null,
  traces: null,
};

if (!L || !L.map || !L.PM) {
  statusLine.textContent = 'Leaflet or Geoman failed to load. Check the network and reload.';
  throw new Error('Leaflet or Geoman failed to load');
}

// --- map ---

// Fixed study-area camera. Not derived from a dataset.
const map = L.map('map', {
  minZoom: 4,
  maxZoom: 19,
  zoomControl: true,
  worldCopyJump: false,
});
map.setView(STUDY_CENTER, STUDY_ZOOM);

function makePane(name, zIndex) {
  const pane = map.createPane(name);
  pane.style.zIndex = String(zIndex);
  return pane;
}

makePane('fav', 350);
makePane('dots', 360);
makePane('faults', 420);
makePane('quakes', 430);
makePane('drawings', 450);

const drawRenderer = L.svg({ pane: 'drawings' });
const faultRenderer = L.svg({ pane: 'faults' });
const quakeRenderer = L.canvas({ pane: 'quakes', tolerance: 3 });

const tracesGroup = L.featureGroup([], { pmIgnore: true, snapIgnore: true });
layers.traces = tracesGroup;
tracesGroup.addTo(map);

const defaultPathOptions = {
  renderer: drawRenderer,
  pane: 'drawings',
  className: 'trace-line',
  color: '#00e5ff',
  weight: 3,
  opacity: 1,
  smoothFactor: 0,
  lineCap: 'round',
  lineJoin: 'round',
};

map.pm.addControls({
  position: 'topleft',
  drawMarker: false,
  drawCircleMarker: false,
  drawPolyline: true,
  drawRectangle: false,
  drawPolygon: false,
  drawCircle: false,
  drawText: false,
  editMode: true,
  dragMode: true,
  cutPolygon: false,
  removalMode: true,
  rotateMode: false,
  optionsControls: false,
  pinningOption: false,
  snappingOption: false,
});

map.pm.setGlobalOptions({
  snappable: false,
  snapDistance: 20,
  allowSelfIntersection: true,
  allowSelfIntersectionEdit: true,
  layerGroup: tracesGroup,
  panes: {
    layerPane: 'drawings',
    vertexPane: 'markerPane',
    markerPane: 'markerPane',
  },
  pathOptions: defaultPathOptions,
  templineStyle: { color: '#00e5ff', weight: 3 },
  hintlineStyle: { color: '#00e5ff', dashArray: '4 6', weight: 2, opacity: 0.85 },
});

// USGS 3DEP ImageServer: each XYZ tile is an exportImage of that Web Mercator cell.
const DepHillshade = L.TileLayer.extend({
  initialize(options) {
    L.TileLayer.prototype.initialize.call(this, '', L.extend({
      tileSize: 256,
      maxZoom: 19,
      maxNativeZoom: 18,
      attribution: 'USGS 3DEP',
      rasterFunction: 'Hillshade Gray',
      updateWhenIdle: true,
      keepBuffer: 1,
    }, options));
  },
  getTileUrl(coords) {
    const half = Math.PI * 6378137;
    const span = (2 * half) / (2 ** coords.z);
    const xmin = -half + coords.x * span;
    const xmax = xmin + span;
    const ymax = half - coords.y * span;
    const ymin = ymax - span;
    const bbox = [xmin, ymin, xmax, ymax].map((v) => v.toFixed(2)).join(',');
    const rule = encodeURIComponent(JSON.stringify({ rasterFunction: this.options.rasterFunction }));
    return 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
      + `?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng`
      + `&renderingRule=${rule}&f=image`;
  },
});

const hillGray = new DepHillshade({ rasterFunction: 'Hillshade Gray' });
const hillMulti = new DepHillshade({ rasterFunction: 'Hillshade Multidirectional' });
const esriHill = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, maxNativeZoom: 16, attribution: '&copy; Esri, USGS, NOAA' },
);
const esriImg = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: '&copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community' },
);
const usgsTopo = L.tileLayer(
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, maxNativeZoom: 16, attribution: '&copy; USGS The National Map' },
);

let hillWarned = false;
function watchHillshade(layer, label) {
  layer.on('tileerror', () => {
    if (hillWarned) return;
    hillWarned = true;
    pushError(`${label} tile failed to load. Switch basemap if this continues.`);
    renderStatus();
  });
}
watchHillshade(hillGray, 'USGS 3DEP hillshade');
watchHillshade(hillMulti, 'USGS 3DEP multidirectional hillshade');

hillGray.addTo(map);
const layerControl = L.control.layers({
  'USGS 3DEP lidar hillshade (1 m where available)': hillGray,
  'USGS 3DEP multidirectional hillshade': hillMulti,
  'Esri World Hillshade': esriHill,
  'Esri World Imagery': esriImg,
  'USGS Topo': usgsTopo,
}, null, { position: 'topleft', collapsed: true }).addTo(map);

const Readout = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-control readout');
    div.id = 'readout';
    div.textContent = '—';
    return div;
  },
  setText(text) {
    this.getContainer().textContent = text;
  },
});
const readout = new Readout();
readout.addTo(map);
L.control.scale({ position: 'bottomleft', metric: true, imperial: true }).addTo(map);

// --- small helpers ---

function frame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function clampConfidence(value) {
  const n = Number(value);
  return n === 1 || n === 2 || n === 3 ? n : 2;
}

function validIso(value) {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function fileBase(name) {
  return String(name).replace(/\.[^.]+$/, '');
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    pushError(`Could not write browser storage: ${err.message}`);
    renderStatus();
    return false;
  }
}

function sessionGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function sessionSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* private mode */ }
}

function hashStr(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function pushError(message) {
  errors.push(message);
  console.error('[faultdraw]', message);
}

function setLoading(text) {
  if (!text) {
    loadingEl.hidden = true;
    return;
  }
  loadingText.textContent = text;
  loadingEl.hidden = false;
}

function setBusy(text) {
  busyEl.hidden = !text;
  busyEl.textContent = text || '';
}

function formatBundleMeta(meta) {
  if (meta == null) return '';
  if (typeof meta === 'string') return meta.slice(0, 500);
  try {
    const text = Object.entries(meta).map(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${k}: ${val}`;
    }).join(' · ');
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

function metaText(meta) {
  if (!meta) return '';
  const bits = [];
  if (meta.name) bits.push(String(meta.name));
  if (meta.note) bits.push(String(meta.note));
  if (meta.source) bits.push(String(meta.source));
  if (meta.stretch != null && meta.stretch !== '') {
    if (typeof meta.stretch === 'object') {
      bits.push(Object.entries(meta.stretch).map(([k, v]) => {
        const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return `${k}: ${val}`;
      }).join(', '));
    } else {
      bits.push(String(meta.stretch));
    }
  }
  return bits.join(' · ');
}

function overlayTitle(base, name) {
  if (!name) return base;
  const short = String(name).replace(/\s+/g, ' ').slice(0, 48);
  return short ? `${base} — ${short}` : base;
}

function depthColor(depthKm) {
  const d = Number.isFinite(depthKm) ? depthKm : 0;
  const t = Math.min(1, Math.max(0, d / 30));
  let i = 0;
  while (i < DEPTH_STOPS.length - 2 && t > DEPTH_STOPS[i + 1][0]) i += 1;
  const [t0, c0] = DEPTH_STOPS[i];
  const [t1, c1] = DEPTH_STOPS[i + 1];
  const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const rgb = c0.map((v, k) => Math.round(v + (c1[k] - v) * u));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function magRadius(mag) {
  const m = Number.isFinite(mag) ? mag : 0;
  return Math.max(1, Math.min(14, 1 + 1.6 * (m + 0.5)));
}

function roundTenth(value) {
  return Math.round(Number(value) * 10) / 10;
}

function getMinMag() {
  const n = roundTenth(minmagInput.value);
  if (!Number.isFinite(n)) return 1.5;
  return Math.min(7, Math.max(-1, n));
}

function geomanActive() {
  const pm = map.pm;
  return !!(
    pm.globalDrawModeEnabled()
    || pm.globalEditModeEnabled()
    || pm.globalRemovalModeEnabled()
    || pm.globalDragModeEnabled()
  );
}

function cancelGeomanModes() {
  if (map.pm.globalDrawModeEnabled()) map.pm.disableDraw();
  if (map.pm.globalEditModeEnabled()) map.pm.disableGlobalEditMode();
  if (map.pm.globalRemovalModeEnabled()) map.pm.disableGlobalRemovalMode();
  if (map.pm.globalDragModeEnabled()) map.pm.disableGlobalDragMode();
  syncQuakePointer();
}

function typingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// --- readout ---

function renderReadout(latlng) {
  const z = map.getZoom();
  if (!latlng) {
    readout.setText(`— | UTM 11N — | z ${z}`);
    return;
  }
  lastLatLng = latlng;
  const utm = wgs84ToUtm11N(latlng.lat, latlng.lng);
  if (!utm) {
    readout.setText(`${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)} | UTM 11N — | z ${z}`);
    return;
  }
  const east = Math.round(utm.easting);
  const north = Math.round(utm.northing);
  readout.setText(`${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)} | UTM 11N ${east} E ${north} N | z ${z}`);
}

map.on('mousemove', (e) => renderReadout(e.latlng));
map.on('zoomend', () => renderReadout(lastLatLng || L.latLng(STUDY_CENTER[0], STUDY_CENTER[1])));
renderReadout(L.latLng(STUDY_CENTER[0], STUDY_CENTER[1]));

// --- status ---

function setStatusText(text) {
  statusText = text;
  renderStatus();
}

function renderStatus() {
  statusLine.textContent = statusText;
  bundleNoteEl.hidden = !bundleNote;
  bundleNoteEl.textContent = bundleNote;
  errorList.replaceChildren();
  errorList.hidden = errors.length === 0;
  for (const message of errors) {
    const li = document.createElement('li');
    li.textContent = message;
    errorList.append(li);
  }
  const rows = [
    ['Favorability', dataState.favorability, layers.favorability],
    ['U6 dots', dataState.dots, layers.dots],
    ['Known faults', dataState.faults, layers.faults],
    ['Earthquakes', dataState.hypocenters, layers.hypocenters],
  ];
  layerList.replaceChildren();
  for (const [label, data, layer] of rows) {
    const li = document.createElement('li');
    if (!data) {
      li.textContent = `${label}: not loaded`;
    } else if (label === 'Known faults') {
      const n = data.geojson.features.length;
      const on = layer && map.hasLayer(layer) ? 'on' : 'off';
      li.textContent = `${label}: ${n} feature${n === 1 ? '' : 's'} (${on})`;
    } else if (label === 'Earthquakes') {
      const n = data.lon.length;
      const name = data.meta && data.meta.name ? ` — ${data.meta.name}` : '';
      const on = layer && map.hasLayer(layer) ? 'on' : 'off';
      li.textContent = `${label}: ${n.toLocaleString()} points${name} (${on})`;
    } else {
      const name = data.meta && data.meta.name ? ` — ${data.meta.name}` : '';
      const on = layer && map.hasLayer(layer) ? 'on' : 'off';
      li.textContent = `${label}${name} (${on})`;
    }
    layerList.append(li);
  }
  opacityFav.disabled = !dataState.favorability;
  opacityDots.disabled = !dataState.dots;
  updateQuakeCount();
}

function status() {
  const stats = traceStats();
  return {
    text: statusText,
    errors: errors.slice(),
    restoredAt,
    bundleNote,
    layers: {
      favorability: !!dataState.favorability,
      dots: !!dataState.dots,
      faults: !!dataState.faults,
      hypocenters: !!dataState.hypocenters,
    },
    visibility: {
      favorability: !!(layers.favorability && map.hasLayer(layers.favorability)),
      dots: !!(layers.dots && map.hasLayer(layers.dots)),
      faults: !!(layers.faults && map.hasLayer(layers.faults)),
      hypocenters: !!(layers.hypocenters && map.hasLayer(layers.hypocenters)),
    },
    faultsCount: dataState.faults ? dataState.faults.geojson.features.length : 0,
    hypocentersTotal: quakeTotal,
    hypocentersShown: quakeShown,
    segments: stats.segments,
    totalLengthKm: stats.km,
    dirty: isDirty(),
    lastExport: storageGet(LAST_EXPORT_KEY),
  };
}

function layoutChrome() {
  const top = banner.hidden ? 8 : banner.getBoundingClientRect().height + 8;
  panel.style.top = `${top}px`;
  panel.style.maxHeight = `calc(100vh - ${top + 8}px)`;
  map.invalidateSize();
}

// --- traces ---

function tracePathOptions(confidence) {
  const c = clampConfidence(confidence);
  const opt = {
    renderer: drawRenderer,
    pane: 'drawings',
    className: 'trace-line',
    color: '#00e5ff',
    opacity: 1,
    weight: c === 3 ? 5 : c === 1 ? 2.5 : 3,
    smoothFactor: 0,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: true,
    pmIgnore: false,
    snapIgnore: false,
  };
  if (c === 1) opt.dashArray = '7 6';
  return opt;
}

function applyTraceStyle(layer) {
  const c = layer.feature && layer.feature.properties
    ? layer.feature.properties.confidence
    : 2;
  const opt = tracePathOptions(c);
  layer.setStyle(opt);
  if (c !== 1) layer.setStyle({ dashArray: null });
}

function restyleAll() {
  tracesGroup.eachLayer((layer) => {
    if (layer._faultdrawTrace) applyTraceStyle(layer);
  });
}

function latLngSequence(latlngs) {
  const out = [];
  const walk = (arr) => {
    if (!arr) return;
    if (typeof arr.lat === 'number' && typeof arr.lng === 'number') {
      out.push(arr);
      return;
    }
    if (Array.isArray(arr)) {
      for (const item of arr) walk(item);
    }
  };
  walk(latlngs);
  return out;
}

function lengthMeters(seq) {
  let meters = 0;
  for (let i = 1; i < seq.length; i++) meters += map.distance(seq[i - 1], seq[i]);
  return meters;
}

function adoptTrace(layer, props) {
  layer._faultdrawTrace = true;
  layer.feature = {
    type: 'Feature',
    properties: {
      id: props.id,
      confidence: clampConfidence(props.confidence),
      note: props.note == null ? '' : String(props.note),
      created: props.created,
      modified: props.modified,
    },
    geometry: null,
  };
  if (!layer._faultdrawClick) {
    layer.on('click', onTraceClick);
    layer._faultdrawClick = true;
  }
  applyTraceStyle(layer);
}

function addTrace(latlngs, props) {
  const layer = L.polyline(latlngs, tracePathOptions(props.confidence));
  adoptTrace(layer, props);
  tracesGroup.addLayer(layer);
  return layer;
}

function getTracesGeoJSON() {
  const features = [];
  tracesGroup.eachLayer((layer) => {
    if (!layer._faultdrawTrace || !layer.feature) return;
    const seq = latLngSequence(layer.getLatLngs());
    if (seq.length < 2) return;
    const props = layer.feature.properties;
    features.push({
      type: 'Feature',
      properties: {
        id: props.id,
        confidence: props.confidence,
        note: props.note,
        created: props.created,
        modified: props.modified,
        length_km: Number((lengthMeters(seq) / 1000).toFixed(3)),
      },
      geometry: {
        type: 'LineString',
        coordinates: seq.map((ll) => [Number(ll.lng.toFixed(6)), Number(ll.lat.toFixed(6))]),
      },
    });
  });
  return { type: 'FeatureCollection', name: 'faultdraw traces', features };
}

function traceStats() {
  let segments = 0;
  let meters = 0;
  tracesGroup.eachLayer((layer) => {
    if (!layer._faultdrawTrace) return;
    const seq = latLngSequence(layer.getLatLngs());
    if (seq.length < 2) return;
    segments += 1;
    meters += lengthMeters(seq);
  });
  return { segments, km: meters / 1000 };
}

function updateStats() {
  const stats = traceStats();
  traceStatsEl.textContent = `Segments: ${stats.segments} | Total length: ${stats.km.toFixed(2)} km`;
}

function traceDigest() {
  return hashStr(JSON.stringify(getTracesGeoJSON()));
}

function isDirty() {
  const gj = getTracesGeoJSON();
  const digest = storageGet(EXPORT_DIGEST_KEY);
  if (!gj.features.length && !digest) return false;
  if (!digest) return gj.features.length > 0;
  return traceDigest() !== digest;
}

function updateDirtyUi() {
  const dirty = isDirty();
  dirtyFlag.hidden = !dirty;
  dirtyDot.hidden = !dirty;
  const dismissed = sessionGet(BANNER_KEY);
  banner.hidden = dismissed === traceDigest();
  layoutChrome();
}

function updateExportLabel() {
  const iso = storageGet(LAST_EXPORT_KEY);
  exportLabel.textContent = iso
    ? `Last export: ${new Date(iso).toLocaleString()}`
    : 'Last export: never';
}

function updateUndoButtons() {
  undoBtn.disabled = historyIndex <= 0;
  redoBtn.disabled = historyIndex < 0 || historyIndex >= history.length - 1;
}

function commitNow() {
  if (suspend) return;
  const snap = JSON.stringify(getTracesGeoJSON());
  if (!(historyIndex >= 0 && history[historyIndex] === snap)) {
    history.splice(historyIndex + 1);
    history.push(snap);
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    historyIndex = history.length - 1;
  }
  storageSet(TRACES_KEY, snap);
  updateStats();
  updateDirtyUi();
  updateUndoButtons();
}

function scheduleCommit() {
  if (suspend) return;
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commitTimer = null;
    commitNow();
  }, 40);
}

function flushCommit() {
  if (!commitTimer) return;
  clearTimeout(commitTimer);
  commitTimer = null;
  commitNow();
}

function applySnapshot(snap) {
  suspend = true;
  try {
    cancelGeomanModes();
    map.closePopup();
    tracesGroup.clearLayers();
    const gj = JSON.parse(snap);
    for (const feature of gj.features || []) addTraceFromFeature(feature);
  } finally {
    suspend = false;
  }
  storageSet(TRACES_KEY, snap);
  updateStats();
  updateDirtyUi();
  updateUndoButtons();
}

function undo() {
  flushCommit();
  if (map.pm.globalDrawModeEnabled()) return;
  if (historyIndex <= 0) return;
  historyIndex -= 1;
  applySnapshot(history[historyIndex]);
}

function redo() {
  flushCommit();
  if (map.pm.globalDrawModeEnabled()) return;
  if (historyIndex >= history.length - 1) return;
  historyIndex += 1;
  applySnapshot(history[historyIndex]);
}

function planTraceParts(feature) {
  const geometry = feature && feature.geometry;
  if (!geometry) return [];
  const parts = geometry.type === 'LineString'
    ? [geometry.coordinates]
    : geometry.type === 'MultiLineString'
      ? geometry.coordinates
      : [];
  const base = feature.properties || {};
  const planned = [];
  parts.forEach((coords, index) => {
    const latlngs = [];
    for (const coord of coords || []) {
      if (!coord || coord.length < 2) continue;
      const lon = Number(coord[0]);
      const lat = Number(coord[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      latlngs.push([lat, lon]);
    }
    if (latlngs.length < 2) return;
    let id = base.id != null && String(base.id).trim() ? String(base.id) : uuid();
    if (parts.length > 1 && index > 0) id = `${id}#${index + 1}`;
    const created = validIso(base.created) || nowIso();
    planned.push({
      latlngs,
      props: {
        id,
        confidence: clampConfidence(base.confidence),
        note: base.note == null ? '' : String(base.note),
        created,
        modified: validIso(base.modified) || created,
      },
    });
  });
  return planned;
}

function addTraceFromFeature(feature) {
  let n = 0;
  for (const part of planTraceParts(feature)) {
    addTrace(part.latlngs, part.props);
    n += 1;
  }
  return n;
}

function onTraceClick(e) {
  if (geomanActive()) return;
  if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
  openTracePopup(e.target);
}

function openTracePopup(layer) {
  const props = layer.feature.properties;
  const root = document.createElement('div');
  root.className = 'trace-form';
  const len = document.createElement('div');
  const seq = latLngSequence(layer.getLatLngs());
  len.textContent = `Length: ${(lengthMeters(seq) / 1000).toFixed(2)} km`;
  const confLabel = document.createElement('label');
  confLabel.append(document.createTextNode('Confidence'));
  const select = document.createElement('select');
  for (const [value, text] of [['1', '1 — low'], ['2', '2 — medium'], ['3', '3 — high']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    select.append(opt);
  }
  select.value = String(clampConfidence(props.confidence));
  confLabel.append(select);
  const noteLabel = document.createElement('label');
  noteLabel.append(document.createTextNode('Note'));
  const note = document.createElement('textarea');
  note.rows = 3;
  note.value = props.note || '';
  noteLabel.append(note);
  const idEl = document.createElement('div');
  idEl.className = 'id';
  idEl.textContent = props.id;
  const row = document.createElement('div');
  row.className = 'row';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger';
  del.textContent = 'Delete';
  save.addEventListener('click', () => {
    props.confidence = clampConfidence(select.value);
    props.note = note.value;
    props.modified = nowIso();
    applyTraceStyle(layer);
    commitNow();
    map.closePopup();
  });
  del.addEventListener('click', () => {
    tracesGroup.removeLayer(layer);
    map.closePopup();
    commitNow();
  });
  row.append(save, del);
  root.append(len, confLabel, noteLabel, idEl, row);
  L.popup({ maxWidth: 300, minWidth: 220, autoPan: true })
    .setLatLng(layer.getBounds().getCenter())
    .setContent(root)
    .openOn(map);
}

function touchTrace(layer) {
  if (!layer || !layer._faultdrawTrace || !layer.feature) return;
  layer.feature.properties.modified = nowIso();
  applyTraceStyle(layer);
}

function exportStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportTraces() {
  flushCommit();
  const gj = getTracesGeoJSON();
  const exported = nowIso();
  const payload = {
    type: 'FeatureCollection',
    name: 'faultdraw traces',
    exported,
    features: gj.features,
  };
  downloadText(`faultdraw_traces_${exportStamp(new Date())}.geojson`, JSON.stringify(payload, null, 2));
  storageSet(LAST_EXPORT_KEY, exported);
  storageSet(EXPORT_DIGEST_KEY, hashStr(JSON.stringify(gj)));
  updateExportLabel();
  updateDirtyUi();
  setStatusText(`Exported ${gj.features.length} traces.`);
}

function importTraces(data, mode) {
  const cls = classifyJson(data);
  if (cls.kind === 'bundle' || cls.kind === 'sidecar') {
    throw new Error('This file is map data, not drawn traces. Use Load data.');
  }
  if (cls.kind !== 'features') {
    throw new Error(cls.error || 'Import needs a GeoJSON FeatureCollection of lines.');
  }
  const fc = cls.wrap ? data : data;
  const split = splitFeatureCollection(fc.type === 'Feature' ? { type: 'FeatureCollection', features: [fc] } : fc);
  if (!split.faults && split.quakes) {
    throw new Error('This file looks like hypocenters. Use Load data.');
  }
  if (!split.faults) throw new Error('No LineString traces in this file.');
  let added = 0;
  let skipped = 0;
  suspend = true;
  try {
    cancelGeomanModes();
    map.closePopup();
    if (mode === 'replace') tracesGroup.clearLayers();
    const existing = new Set();
    tracesGroup.eachLayer((layer) => {
      if (layer.feature && layer.feature.properties) existing.add(layer.feature.properties.id);
    });
    for (const feature of split.faults.features) {
      for (const part of planTraceParts(feature)) {
        if (mode === 'merge' && existing.has(part.props.id)) {
          skipped += 1;
          continue;
        }
        addTrace(part.latlngs, part.props);
        existing.add(part.props.id);
        added += 1;
      }
    }
  } finally {
    suspend = false;
  }
  commitNow();
  const extra = skipped ? ` Skipped ${skipped} with an id you already have.` : '';
  setStatusText(`Imported ${added} traces.${extra}`);
}

function askImportMode() {
  const dialog = $('import-dialog');
  if (typeof dialog.showModal !== 'function') {
    const replace = window.confirm('OK replaces all traces. Cancel merges and skips ids you already have.');
    return Promise.resolve(replace ? 'replace' : 'merge');
  }
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      const value = dialog.returnValue;
      resolve(value === 'replace' || value === 'merge' ? value : null);
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    try {
      dialog.showModal();
    } catch (err) {
      dialog.removeEventListener('close', onClose);
      resolve(null);
    }
  });
}

function clearTraces() {
  flushCommit();
  if (!traceStats().segments) {
    setStatusText('No traces to clear.');
    return;
  }
  if (!window.confirm('Clear all traces? You can undo this.')) return;
  suspend = true;
  try {
    cancelGeomanModes();
    map.closePopup();
    tracesGroup.clearLayers();
  } finally {
    suspend = false;
  }
  commitNow();
  setStatusText('Traces cleared.');
}

function restoreTraces() {
  const raw = storageGet(TRACES_KEY);
  if (raw) {
    try {
      const gj = JSON.parse(raw);
      if (!gj || gj.type !== 'FeatureCollection' || !Array.isArray(gj.features)) {
        throw new Error('not a FeatureCollection');
      }
      suspend = true;
      try {
        for (const feature of gj.features) addTraceFromFeature(feature);
      } finally {
        suspend = false;
      }
    } catch (err) {
      pushError(`Saved traces could not be read (${err.message}). They were left in localStorage.`);
    }
  }
  history = [JSON.stringify(getTracesGeoJSON())];
  historyIndex = 0;
  updateStats();
  updateUndoButtons();
  updateExportLabel();
  updateDirtyUi();
}

map.on('pm:create', (e) => {
  if (e.shape !== 'Line') {
    if (e.layer) e.layer.remove();
    return;
  }
  const layer = e.layer;
  const seq = latLngSequence(layer.getLatLngs());
  if (seq.length < 2) {
    if (tracesGroup.hasLayer(layer)) tracesGroup.removeLayer(layer);
    else layer.remove();
    return;
  }
  const ts = nowIso();
  adoptTrace(layer, { id: uuid(), confidence: 2, note: '', created: ts, modified: ts });
  if (!tracesGroup.hasLayer(layer)) tracesGroup.addLayer(layer);
  commitNow();
});

tracesGroup.on('pm:edit pm:dragend', (e) => {
  touchTrace(e.layer);
  scheduleCommit();
});

map.on('pm:remove', (e) => {
  const layer = e.layer;
  if (!layer || !layer._faultdrawTrace) return;
  if (tracesGroup.hasLayer(layer)) tracesGroup.removeLayer(layer);
  scheduleCommit();
});

function onModeChange(e) {
  if (e && e.type === 'pm:globaleditmodetoggled' && e.enabled === false) restyleAll();
  if (geomanActive()) map.closePopup();
  syncQuakePointer();
  updateUndoButtons();
}

map.on('pm:globaldrawmodetoggled pm:globaleditmodetoggled pm:globalremovalmodetoggled pm:globaldragmodetoggled', onModeChange);
map.on('pm:drawstart pm:drawend', onModeChange);

map.on('pm:keyevent', (ev) => {
  if (ev.eventType !== 'keydown') return;
  const event = ev.event;
  if (!event || typingTarget(event.target)) return;
  if (!map.pm.globalDrawModeEnabled()) return;
  const shapeName = map.pm.Draw.getActiveShape();
  const tool = shapeName && map.pm.Draw[shapeName];
  if (!tool) return;
  if ((event.key === 'Backspace' || event.key === 'Delete') && typeof tool._removeLastVertex === 'function') {
    event.preventDefault();
    tool._removeLastVertex();
  } else if (event.key === 'Enter' && typeof tool._finishShape === 'function') {
    event.preventDefault();
    tool._finishShape();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    map.pm.disableDraw();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (typingTarget(event.target)) return;
    cancelGeomanModes();
    dragDepth = 0;
    dropOverlay.hidden = true;
    return;
  }
  const meta = event.ctrlKey || event.metaKey;
  if (!meta) return;
  const key = event.key.toLowerCase();
  if (key === 'z' && !event.shiftKey) {
    if (typingTarget(event.target) || map.pm.globalDrawModeEnabled()) return;
    event.preventDefault();
    undo();
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    if (typingTarget(event.target) || map.pm.globalDrawModeEnabled()) return;
    event.preventDefault();
    redo();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

// --- data layers ---

function unmount(key) {
  const prev = layers[key];
  if (!prev) return;
  layerControl.removeLayer(prev);
  if (map.hasLayer(prev)) map.removeLayer(prev);
  if (key === 'hypocenters') {
    quakeToken += 1;
    prev.clearLayers();
  }
  layers[key] = null;
}

function mountNew(key, layer, name, show) {
  layers[key] = layer;
  layerControl.addOverlay(layer, name);
  if (show) layer.addTo(map);
}

async function showImage(kind, record, persist) {
  const bounds = record.bounds;
  const meta = record.meta || {};
  const blob = record.blob;
  if (!(blob instanceof Blob)) throw new Error('image is missing');
  unmount(kind);
  if (urls[kind]) {
    URL.revokeObjectURL(urls[kind]);
    urls[kind] = null;
  }
  const url = URL.createObjectURL(blob);
  urls[kind] = url;
  const opacity = kind === 'favorability' ? 0.55 : 1;
  const layer = L.imageOverlay(url, bounds, {
    pane: kind === 'favorability' ? 'fav' : 'dots',
    opacity,
    interactive: false,
    pmIgnore: true,
    snapIgnore: true,
    className: 'pixelated-overlay',
    alt: meta.name || (kind === 'favorability' ? 'Favorability' : 'U6 dots'),
  });
  const title = overlayTitle(kind === 'favorability' ? 'Favorability' : 'U6 submitted dots', meta.name);
  layer.on('error', () => {
    pushError(`${title} image failed to display.`);
    renderStatus();
  });
  mountNew(kind, layer, title, kind === 'favorability');
  const savedAt = record.savedAt || nowIso();
  dataState[kind] = { blob, bounds, meta, savedAt };
  if (kind === 'favorability') {
    opacityFav.value = '55';
    opacityFavLabel.textContent = '55%';
    favMetaEl.textContent = metaText(meta);
    favLegend.hidden = false;
  } else {
    opacityDots.value = '100';
    opacityDotsLabel.textContent = '100%';
    dotsMetaEl.textContent = metaText(meta);
  }
  if (persist) {
    try {
      await idbPut({ kind, savedAt, blob, bounds, meta });
    } catch (err) {
      pushError(`${kind} is loaded but could not be saved in this browser: ${err.message}`);
    }
  }
}

function showFaults(fc, meta, persist) {
  const layer = L.geoJSON(fc, {
    pane: 'faults',
    renderer: faultRenderer,
    interactive: false,
    pmIgnore: true,
    snapIgnore: true,
    bubblingMouseEvents: false,
    smoothFactor: 1,
    style: { color: '#5a3a1a', weight: 1.5, opacity: 0.9 },
    filter: (feature) => {
      const t = feature && feature.geometry && feature.geometry.type;
      return t === 'LineString' || t === 'MultiLineString';
    },
    onEachFeature(_feature, child) {
      child.options.interactive = false;
      child.options.pmIgnore = true;
      child.options.snapIgnore = true;
    },
  });
  unmount('faults');
  mountNew('faults', layer, 'Known faults', true);
  const savedAt = nowIso();
  dataState.faults = { geojson: fc, meta: meta || {}, savedAt };
  if (persist) {
    idbPut({ kind: 'faults', savedAt, geojson: fc, meta: meta || {} }).catch((err) => {
      pushError(`known faults are loaded but could not be saved in this browser: ${err.message}`);
      renderStatus();
    });
  }
}

function makeQuakeGroup() {
  const group = L.featureGroup([], { pmIgnore: true, snapIgnore: true });
  group.on('click', (event) => {
    if (geomanActive()) return;
    const marker = event.propagatedFrom || event.sourceTarget;
    if (!marker || !marker._q) return;
    const q = marker._q;
    const mag = Number.isFinite(q.mag) ? q.mag.toFixed(2) : '?';
    const depth = Number.isFinite(q.depth_km) ? Number(q.depth_km).toFixed(1) : '?';
    let timeHtml = 'Time: unknown';
    if (q.time) {
      const parsed = new Date(q.time);
      if (Number.isNaN(parsed.getTime())) {
        timeHtml = `Time: ${escapeHtml(q.time)}`;
      } else {
        const local = parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        timeHtml = `Time: ${escapeHtml(q.time)}<br><span class="muted">${escapeHtml(local)} local</span>`;
      }
    }
    L.popup({ maxWidth: 320, className: 'quake-popup' })
      .setLatLng(marker.getLatLng())
      .setContent(`<div class="qpop"><div><strong>M ${escapeHtml(mag)}</strong></div><div>Depth: ${escapeHtml(depth)} km</div><div>${timeHtml}</div></div>`)
      .openOn(map);
  });
  return group;
}

async function showQuakes(cols, persist) {
  const group = makeQuakeGroup();
  const meta = { name: cols.name || '', source: cols.source || '' };
  unmount('hypocenters');
  // Off by default: do not add the group, so the canvas is not built until toggled on.
  mountNew('hypocenters', group, overlayTitle('Earthquakes', meta.name), false);
  const savedAt = nowIso();
  dataState.hypocenters = {
    lon: cols.lon,
    lat: cols.lat,
    depth_km: cols.depth_km,
    mag: cols.mag,
    time: cols.time,
    meta,
    savedAt,
  };
  quakeLegend.hidden = false;
  updateQuakeCount();
  if (persist) {
    try {
      await idbPut({
        kind: 'hypocenters',
        savedAt,
        lon: cols.lon,
        lat: cols.lat,
        depth_km: cols.depth_km,
        mag: cols.mag,
        time: cols.time,
        meta,
      });
    } catch (err) {
      pushError(`hypocenters are loaded but could not be saved in this browser: ${err.message}`);
    }
  }
}

function countQuakes() {
  const src = dataState.hypocenters;
  if (!src) return { shown: 0, total: 0 };
  const minMag = getMinMag();
  const n = src.lon.length;
  let shown = 0;
  for (let i = 0; i < n; i++) {
    const mag = src.mag[i];
    if (!Number.isFinite(mag) || mag < minMag) continue;
    if (!Number.isFinite(src.lat[i]) || !Number.isFinite(src.lon[i])) continue;
    shown += 1;
  }
  return { shown, total: n };
}

function updateQuakeCount() {
  const counts = countQuakes();
  quakeShown = counts.shown;
  quakeTotal = counts.total;
  const off = !(layers.hypocenters && map.hasLayer(layers.hypocenters));
  const suffix = off && counts.total ? ' (layer off)' : '';
  quakeCountEl.textContent = `${counts.shown.toLocaleString()} of ${counts.total.toLocaleString()} shown${suffix}`;
}

function syncQuakePointer() {
  const el = quakeRenderer._container;
  if (!el) return;
  const onMap = !!(layers.hypocenters && map.hasLayer(layers.hypocenters));
  el.style.pointerEvents = onMap && quakeShown > 0 && !geomanActive() ? 'auto' : 'none';
}

async function rebuildQuakes() {
  const token = ++quakeToken;
  const group = layers.hypocenters;
  const src = dataState.hypocenters;
  if (!group || !src || !map.hasLayer(group)) {
    syncQuakePointer();
    updateQuakeCount();
    return;
  }
  group.clearLayers();
  const minMag = getMinMag();
  const n = src.lon.length;
  let added = 0;
  for (let i = 0; i < n; i++) {
    if (token !== quakeToken) return;
    const mag = src.mag[i];
    if (!Number.isFinite(mag) || mag < minMag) continue;
    const lat = src.lat[i];
    const lon = src.lon[i];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const marker = L.circleMarker([lat, lon], {
      renderer: quakeRenderer,
      pane: 'quakes',
      pmIgnore: true,
      snapIgnore: true,
      interactive: true,
      radius: magRadius(mag),
      color: '#1a1a1a',
      weight: 0.7,
      opacity: 0.85,
      fillColor: depthColor(src.depth_km[i]),
      fillOpacity: 0.88,
      bubblingMouseEvents: true,
    });
    marker._q = { mag, depth_km: src.depth_km[i], time: src.time[i] || '' };
    group.addLayer(marker);
    added += 1;
    if (added % 4000 === 0) {
      setBusy(`Drawing earthquakes ${added.toLocaleString()}…`);
      await frame();
    }
  }
  if (token !== quakeToken) return;
  setBusy('');
  updateQuakeCount();
  syncQuakePointer();
}

let quakeRebuildTimer = null;
function scheduleQuakeRebuild() {
  updateQuakeCount();
  clearTimeout(quakeRebuildTimer);
  quakeRebuildTimer = setTimeout(() => {
    rebuildQuakes();
  }, 200);
}

map.on('overlayadd', (e) => {
  if (e.layer === layers.hypocenters) rebuildQuakes();
  renderStatus();
});
map.on('overlayremove', (e) => {
  if (e.layer === layers.hypocenters) {
    quakeToken += 1;
    e.layer.clearLayers();
    setBusy('');
    syncQuakePointer();
  }
  renderStatus();
});

function renderMagLegend() {
  magLegend.replaceChildren();
  for (const mag of [1, 2, 3, 4, 5]) {
    const item = document.createElement('div');
    item.className = 'mag-item';
    const dot = document.createElement('span');
    dot.className = 'mag-dot';
    const r = magRadius(mag);
    dot.style.width = `${r * 2}px`;
    dot.style.height = `${r * 2}px`;
    const label = document.createElement('span');
    label.textContent = `M${mag}`;
    item.append(dot, label);
    magLegend.append(item);
  }
}

async function forgetData() {
  if (!window.confirm('Forget loaded data stored in this browser? Drawn traces are kept.')) return;
  try {
    await idbClear();
  } catch (err) {
    pushError(`Could not clear saved data: ${err.message}`);
    renderStatus();
    return;
  }
  for (const key of ['favorability', 'dots', 'faults', 'hypocenters']) unmount(key);
  for (const key of ['favorability', 'dots']) {
    if (urls[key]) URL.revokeObjectURL(urls[key]);
    urls[key] = null;
    dataState[key] = null;
  }
  dataState.faults = null;
  dataState.hypocenters = null;
  bundleNote = '';
  favLegend.hidden = true;
  quakeLegend.hidden = true;
  favMetaEl.textContent = '';
  dotsMetaEl.textContent = '';
  setBusy('');
  errors = [];
  updateQuakeCount();
  syncQuakePointer();
  setStatusText('Loaded data cleared from this browser.');
}

async function restoreFromIdb() {
  let records = [];
  try {
    records = await idbGetAll();
  } catch (err) {
    pushError(`Could not read saved data: ${err.message}`);
    setStatusText('No saved data restored.');
    return;
  }
  if (!records.length) {
    setStatusText('No saved data in this browser.');
    return;
  }
  let latest = null;
  for (const rec of records) {
    if (rec.savedAt && (!latest || rec.savedAt > latest)) latest = rec.savedAt;
    try {
      if (rec.kind === 'favorability' || rec.kind === 'dots') {
        const bounds = parseBounds(rec.bounds);
        await showImage(rec.kind, {
          blob: rec.blob,
          bounds,
          meta: rec.meta || {},
          savedAt: rec.savedAt,
        }, false);
      } else if (rec.kind === 'faults' && rec.geojson) {
        const lines = lineCollection(rec.geojson).faults;
        if (lines) showFaults(lines, rec.meta || {}, false);
      } else if (rec.kind === 'hypocenters' && rec.lon) {
        const cols = columnarQuakes({
          lon: rec.lon,
          lat: rec.lat,
          depth_km: rec.depth_km,
          mag: rec.mag,
          time: rec.time,
          name: rec.meta && rec.meta.name,
          source: rec.meta && rec.meta.source,
        });
        await showQuakes(cols, false);
      }
    } catch (err) {
      pushError(`Could not restore ${rec.kind || 'a layer'}: ${err.message}`);
    }
  }
  restoredAt = latest;
  const when = latest ? new Date(latest).toLocaleString() : 'an unknown date';
  setStatusText(`Restored data from this browser (loaded ${when}).`);
}

// --- file loading ---

function asFiles(input) {
  if (!input) return [];
  if (typeof FileList !== 'undefined' && input instanceof FileList) return Array.from(input);
  if (Array.isArray(input)) return input;
  if (typeof input.length === 'number' && input[0] && typeof input[0].name === 'string') {
    return Array.from(input);
  }
  if (typeof input.name === 'string' && typeof input.text === 'function') return [input];
  return [];
}

async function readEntries(files) {
  const entries = [];
  for (const file of files) {
    const name = file.name || 'file';
    const lower = name.toLowerCase();
    try {
      if (lower.endsWith('.gz') || lower.endsWith('.zip') || lower.endsWith('.npy') || lower.endsWith('.tif')) {
        entries.push({
          name,
          role: 'error',
          error: `${name}: this loader reads a bundle JSON, PNG + sidecar, GeoJSON, or CSV.`,
        });
        continue;
      }
      if (lower.endsWith('.png') || file.type === 'image/png') {
        if (!lower.endsWith('.png')) {
          entries.push({ name, role: 'error', error: `${name}: PNG files need a .png name so the sidecar can be matched.` });
          continue;
        }
        entries.push({ name, role: 'png', file });
        continue;
      }
      if (lower.endsWith('.csv') || file.type === 'text/csv') {
        setLoading(`Reading ${name}…`);
        await frame();
        entries.push({ name, role: 'csv', text: await file.text() });
        continue;
      }
      if (
        lower.endsWith('.json')
        || lower.endsWith('.geojson')
        || file.type === 'application/json'
        || file.type === 'application/geo+json'
      ) {
        setLoading(`Reading ${name}…`);
        await frame();
        const text = await file.text();
        setLoading(`Parsing ${name}…`);
        await frame();
        let data;
        try {
          data = JSON.parse(text);
        } catch (err) {
          entries.push({ name, role: 'error', error: `${name}: invalid JSON (${err.message})` });
          continue;
        }
        const cls = classifyJson(data);
        if (cls.kind === 'unknown') {
          entries.push({ name, role: 'error', error: `${name}: ${cls.error}` });
          continue;
        }
        entries.push({ name, role: cls.kind, data });
        continue;
      }
      entries.push({ name, role: 'error', error: `${name}: unsupported file type` });
    } catch (err) {
      entries.push({ name, role: 'error', error: `${name}: ${err.message || err}` });
    }
  }
  return entries;
}

async function applyPng(entry, sidecars, consumed) {
  let sidecar = null;
  for (const key of sidecarCandidates(entry.name)) {
    if (sidecars.has(key)) {
      sidecar = sidecars.get(key);
      break;
    }
  }
  if (!sidecar) {
    const stem = entry.name.replace(/\.png$/i, '');
    throw new Error(`missing sidecar JSON (${entry.name}.json or ${stem}.json) with kind and bounds`);
  }
  consumed.add(sidecar);
  const kind = sidecar.data.kind;
  if (kind !== 'favorability' && kind !== 'dots') {
    throw new Error('sidecar kind must be "favorability" or "dots"');
  }
  const bounds = parseBounds(sidecar.data.bounds);
  await showImage(kind, {
    blob: entry.file,
    bounds,
    meta: {
      name: sidecar.data.name || '',
      note: sidecar.data.note || '',
      stretch: sidecar.data.stretch,
    },
    savedAt: nowIso(),
  }, true);
  return kind === 'favorability' ? 'favorability' : 'dots';
}

async function applyBundle(data) {
  const src = data.layers;
  if (!src || typeof src !== 'object') throw new Error('bundle has no layers object');
  bundleNote = data.meta == null ? '' : formatBundleMeta(data.meta);
  const loaded = [];
  const jobs = [];
  if (src.favorability) {
    jobs.push(['favorability', async () => {
      const layer = src.favorability;
      await showImage('favorability', {
        blob: base64ToBlob(layer.png_base64),
        bounds: parseBounds(layer.bounds),
        meta: { name: layer.name || '', note: layer.note || '', stretch: layer.stretch },
        savedAt: nowIso(),
      }, true);
    }]);
  }
  if (src.dots) {
    jobs.push(['dots', async () => {
      const layer = src.dots;
      await showImage('dots', {
        blob: base64ToBlob(layer.png_base64),
        bounds: parseBounds(layer.bounds),
        meta: { name: layer.name || '', note: layer.note || '' },
        savedAt: nowIso(),
      }, true);
    }]);
  }
  if (src.known_faults) {
    jobs.push(['known faults', async () => {
      if (!src.known_faults || typeof src.known_faults !== 'object') {
        throw new Error('known_faults is not GeoJSON');
      }
      const lines = lineCollection(src.known_faults);
      if (!lines.faults) throw new Error('known_faults has no lines');
      if (lines.ignoredPoints) {
        pushError(`known_faults: ignored ${lines.ignoredPoints} point feature(s)`);
      }
      showFaults(lines.faults, { name: src.known_faults.name || '' }, true);
    }]);
  }
  if (src.hypocenters) {
    jobs.push(['hypocenters', async () => {
      const cols = columnarQuakes(src.hypocenters);
      if (cols.timeMissing) pushError('hypocenters have no time column; times will be blank');
      await showQuakes(cols, true);
    }]);
  }
  if (!jobs.length) throw new Error('bundle contained no layers');
  for (const [label, fn] of jobs) {
    try {
      await fn();
      loaded.push(label);
    } catch (err) {
      pushError(`${label}: ${err.message || err}`);
    }
  }
  return loaded;
}

async function applyFeatures(name, data) {
  const fc = data.type === 'Feature' ? { type: 'FeatureCollection', features: [data] } : data;
  const split = splitFeatureCollection(fc);
  const loaded = [];
  if (!split.faults && !split.quakes) {
    if (split.pointLike) throw new Error(`${name}: points have no mag property, so they were not loaded as hypocenters`);
    throw new Error(`${name}: no line or hypocenter features`);
  }
  if (split.faults) {
    showFaults(split.faults, { name: data.name || fileBase(name) }, true);
    loaded.push('known faults');
  }
  if (split.quakes) {
    split.quakes.name = data.name || fileBase(name);
    split.quakes.source = name;
    await showQuakes(split.quakes, true);
    loaded.push('hypocenters');
  }
  if (split.pointsWithoutMag) {
    pushError(`${name}: skipped ${split.pointsWithoutMag} point feature(s) without mag`);
  }
  return loaded;
}

async function loadFilesInner(files) {
  await boot;
  if (!files.length) {
    setStatusText('No files selected.');
    return status();
  }
  errors = [];
  setLoading('Loading…');
  const loaded = [];
  try {
    await frame();
    const entries = await readEntries(files);
    const sidecars = new Map();
    for (const entry of entries) {
      if (entry.role === 'sidecar') sidecars.set(entry.name.toLowerCase(), entry);
    }
    const consumed = new Set();
    for (const entry of entries) {
      try {
        if (entry.role === 'error') {
          pushError(entry.error);
        } else if (entry.role === 'png') {
          setLoading(`Loading ${entry.name}…`);
          await frame();
          loaded.push(await applyPng(entry, sidecars, consumed));
        } else if (entry.role === 'bundle') {
          setLoading(`Loading ${entry.name}…`);
          await frame();
          loaded.push(...await applyBundle(entry.data));
        } else if (entry.role === 'features') {
          setLoading(`Loading ${entry.name}…`);
          await frame();
          loaded.push(...await applyFeatures(entry.name, entry.data));
        } else if (entry.role === 'csv') {
          setLoading(`Loading ${entry.name}…`);
          await frame();
          const parsed = parseCsv(entry.text);
          parsed.rows.name = fileBase(entry.name);
          parsed.rows.source = entry.name;
          await showQuakes(parsed.rows, true);
          loaded.push('hypocenters');
          if (parsed.skipped) pushError(`${entry.name}: skipped ${parsed.skipped} row(s) with invalid numbers`);
        }
      } catch (err) {
        pushError(entry.role === 'error' ? entry.error : `${entry.name}: ${err.message || err}`);
      }
    }
    for (const entry of entries) {
      if (entry.role === 'sidecar' && !consumed.has(entry)) {
        pushError(`${entry.name}: sidecar JSON without a matching PNG`);
      }
    }
    const summary = loaded.length ? `Loaded ${loaded.join(', ')}.` : 'No data layers loaded.';
    const extra = errors.length ? ' Some files had problems.' : '';
    setStatusText(summary + extra);
  } catch (err) {
    pushError(err.message || String(err));
    setStatusText('Load failed.');
  } finally {
    setLoading(null);
    renderStatus();
  }
  return status();
}

function loadFiles(fileList) {
  const files = asFiles(fileList);
  const job = loadChain.then(() => loadFilesInner(files), () => loadFilesInner(files));
  loadChain = job.then(() => {}, () => {});
  return job;
}

// --- chrome events ---

$('panel-toggle').addEventListener('click', () => {
  const collapsed = panel.classList.toggle('collapsed');
  const btn = $('panel-toggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.textContent = collapsed ? 'Show' : 'Hide';
  layoutChrome();
});

$('dismiss-banner').addEventListener('click', () => {
  sessionSet(BANNER_KEY, traceDigest());
  updateDirtyUi();
});

$('btn-load').addEventListener('click', () => $('file-load').click());
$('file-load').addEventListener('change', () => {
  const input = $('file-load');
  if (input.files && input.files.length) loadFiles(input.files);
  input.value = '';
});

$('btn-forget').addEventListener('click', () => { forgetData(); });
$('btn-undo').addEventListener('click', () => undo());
$('btn-redo').addEventListener('click', () => redo());
$('btn-export').addEventListener('click', () => exportTraces());
$('btn-clear').addEventListener('click', () => clearTraces());
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', async () => {
  const input = $('file-import');
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  try {
    setLoading(`Reading ${file.name}…`);
    await frame();
    const text = await file.text();
    setLoading(null);
    const data = JSON.parse(text);
    const mode = await askImportMode();
    if (!mode) {
      setStatusText('Import cancelled.');
      return;
    }
    importTraces(data, mode);
  } catch (err) {
    setLoading(null);
    pushError(`${file.name}: ${err.message || err}`);
    setStatusText('Import failed.');
  }
});

opacityFav.addEventListener('input', () => {
  const pct = Number(opacityFav.value);
  opacityFavLabel.textContent = `${pct}%`;
  if (layers.favorability) layers.favorability.setOpacity(pct / 100);
});
opacityDots.addEventListener('input', () => {
  const pct = Number(opacityDots.value);
  opacityDotsLabel.textContent = `${pct}%`;
  if (layers.dots) layers.dots.setOpacity(pct / 100);
});

function bindMinMag(source) {
  const value = roundTenth(source === 'num' ? minmagNum.value : minmagInput.value);
  if (!Number.isFinite(value)) return;
  const clamped = Math.min(7, Math.max(-1, value));
  minmagInput.value = String(clamped);
  minmagNum.value = String(clamped);
  scheduleQuakeRebuild();
}
minmagInput.addEventListener('input', () => bindMinMag('range'));
minmagNum.addEventListener('input', () => bindMinMag('num'));

$('snap-traces').addEventListener('change', (event) => {
  map.pm.setGlobalOptions({ snappable: event.target.checked });
});

function isFileDrag(event) {
  const types = event.dataTransfer && event.dataTransfer.types;
  if (!types) return false;
  return Array.from(types).includes('Files');
}

document.addEventListener('dragenter', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.hidden = false;
});
document.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (event) => {
  if (!isFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
document.addEventListener('drop', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const files = event.dataTransfer && event.dataTransfer.files;
  if (files && files.length) loadFiles(files);
});

renderMagLegend();
restoreTraces();
setStatusText('Restoring saved data…');
boot = restoreFromIdb().catch((err) => {
  pushError(`Restore failed: ${err.message || err}`);
  setStatusText('No saved data restored.');
});

window.addEventListener('resize', layoutChrome);
layoutChrome();

window.faultdraw = {
  map,
  getTracesGeoJSON,
  loadFiles,
  layers,
  status,
};
