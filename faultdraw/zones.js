// Interpretation zone tracker: shift-click a zone to mark it complete.
// Zone polygons come from bundle layers.zones (and are kept in IndexedDB like other inputs).
// Completion state lives in localStorage and rides along in trace exports.

export const ZONES_KEY = 'faultdraw.v1.zones';

/** Validate a zones FeatureCollection; returns a cleaned copy. */
export function normalizeZones(fc) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('zones must be a GeoJSON FeatureCollection');
  }
  const seen = new Set();
  const features = [];
  for (const f of fc.features) {
    const g = f && f.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    const p = f.properties || {};
    const id = String(p.id != null ? p.id : p.label != null ? p.label : features.length + 1).slice(0, 32);
    if (seen.has(id)) throw new Error(`duplicate zone id ${id}`);
    seen.add(id);
    const ll = Array.isArray(p.label_lonlat) && p.label_lonlat.length === 2
      && p.label_lonlat.every(Number.isFinite) ? p.label_lonlat : null;
    features.push({
      type: 'Feature',
      properties: { id, label: String(p.label != null ? p.label : id).slice(0, 32), area_km2: Number(p.area_km2) || null, label_lonlat: ll },
      geometry: g,
    });
  }
  if (!features.length) throw new Error('zones has no polygons');
  return { type: 'FeatureCollection', name: fc.name || 'Interpretation zones', features };
}

/** Parse a stored / imported completion state into { id: isoString }. */
export function parseZoneState(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  const src = obj.complete;
  if (Array.isArray(src)) {
    for (const id of src) if (typeof id === 'string' || typeof id === 'number') out[String(id)] = '';
  } else if (src && typeof src === 'object') {
    for (const [id, when] of Object.entries(src)) out[String(id)] = typeof when === 'string' ? when : '';
  }
  return out;
}

export function createZoneTracker({ map, L, layerControl, storageGet, storageSet, isBlocked, onChange }) {
  const pane = map.createPane('zones');
  pane.style.zIndex = '400';
  const renderer = L.svg({ pane: 'zones' });
  let fc = null;
  let group = null;
  let complete = {};
  const byId = new Map();

  try { complete = parseZoneState(JSON.parse(storageGet(ZONES_KEY) || 'null')); } catch { complete = {}; }

  const styleFor = (id) => (complete[id] != null
    ? { color: '#ffd400', weight: 1.5, opacity: 0.9, fillColor: '#1a1a1a', fillOpacity: 0.45, dashArray: null }
    : { color: '#ffd400', weight: 1.5, opacity: 0.9, fillColor: '#ffd400', fillOpacity: 0.0, dashArray: '6 4' });

  function save() {
    storageSet(ZONES_KEY, JSON.stringify({ complete, updated: new Date().toISOString() }));
  }

  function refresh(id) {
    const entry = byId.get(id);
    if (!entry) return;
    entry.poly.setStyle(styleFor(id));
    const done = complete[id] != null;
    entry.label.setContent(`${escape(entry.labelText)}${done ? ' ✓' : ''}`);
    const el = entry.label.getElement && entry.label.getElement();
    if (el) el.classList.toggle('done', done);
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function toggle(id, value) {
    if (!byId.has(id)) return;
    const next = value == null ? complete[id] == null : !!value;
    if (next) complete[id] = new Date().toISOString();
    else delete complete[id];
    save();
    refresh(id);
    onChange && onChange();
  }

  function setLayer(newFc, show = true) {
    const clean = normalizeZones(newFc);
    unmount();
    fc = clean;
    group = L.featureGroup([], { pmIgnore: true, snapIgnore: true });
    for (const f of clean.features) {
      const id = f.properties.id;
      const poly = L.geoJSON(f, {
        renderer, pane: 'zones', pmIgnore: true, snapIgnore: true, interactive: true,
        style: () => styleFor(id),
      });
      poly.on('click', (e) => {
        if (isBlocked && isBlocked()) return;
        if (!(e.originalEvent && e.originalEvent.shiftKey)) return; // plain clicks pass through (candidates, map)
        L.DomEvent.stop(e);
        toggle(id);
      });
      let at;
      if (f.properties.label_lonlat) at = L.latLng(f.properties.label_lonlat[1], f.properties.label_lonlat[0]);
      else at = poly.getBounds().getCenter();
      const label = L.tooltip({ permanent: true, direction: 'center', className: 'zone-label', interactive: false, pane: 'zones' })
        .setLatLng(at).setContent(escape(f.properties.label));
      group.addLayer(poly);
      group.addLayer(label);
      byId.set(id, { poly, label, labelText: f.properties.label });
    }
    layerControl.addOverlay(group, 'Interpretation zones');
    if (show) group.addTo(map);
    for (const id of byId.keys()) refresh(id);
    map.on('zoomend', relabel);
    relabel();
    syncPointer();
    onChange && onChange();
    return clean;
  }

  function relabel() {
    pane.classList.toggle('zones-small', map.getZoom() < 7);
    for (const id of byId.keys()) refresh(id);
  }

  function unmount() {
    if (group) {
      layerControl.removeLayer(group);
      if (map.hasLayer(group)) map.removeLayer(group);
    }
    map.off('zoomend', relabel);
    group = null;
    fc = null;
    byId.clear();
  }

  function syncPointer() {
    pane.style.pointerEvents = isBlocked && isBlocked() ? 'none' : '';
    const svg = renderer._container;
    if (svg) svg.style.pointerEvents = isBlocked && isBlocked() ? 'none' : '';
  }

  function progress() {
    const total = byId.size;
    let done = 0;
    for (const id of byId.keys()) if (complete[id] != null) done += 1;
    return { done, total };
  }

  /** State for export: completed ids with timestamps. */
  function exportState() {
    return { complete: { ...complete }, total: byId.size, updated: new Date().toISOString() };
  }

  /** mode 'replace' or 'merge'. Returns count of completed zones after import. */
  function importState(obj, mode) {
    const incoming = parseZoneState(obj);
    complete = mode === 'replace' ? incoming : { ...complete, ...incoming };
    save();
    for (const id of byId.keys()) refresh(id);
    onChange && onChange();
    return Object.keys(complete).length;
  }

  function reset() {
    complete = {};
    save();
    for (const id of byId.keys()) refresh(id);
    onChange && onChange();
  }

  // Shift-click anywhere (e.g. on a candidate line drawn above the zones): toggle the zone under the point.
  function inRing(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function zoneAt(latlng) {
    if (!fc || !group || !map.hasLayer(group)) return null;
    for (const f of fc.features) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const p of polys) {
        if (p.length && inRing(p[0], latlng.lng, latlng.lat) && !p.slice(1).some((h) => inRing(h, latlng.lng, latlng.lat))) return f.properties.id;
      }
    }
    return null;
  }
  map.on('click', (e) => {
    if (!(e.originalEvent && e.originalEvent.shiftKey)) return;
    if (isBlocked && isBlocked()) return;
    const id = zoneAt(e.latlng);
    if (id != null && byId.has(id)) toggle(id);
  });

  return {
    zoneAt,
    setLayer, unmount, toggle, progress, exportState, importState, reset, syncPointer,
    get geojson() { return fc; },
    get layer() { return group; },
    isComplete: (id) => complete[id] != null,
    ids: () => Array.from(byId.keys()),
  };
}
