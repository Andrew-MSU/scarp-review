// Candidate trace QA/QC: code-generated candidate lines (bundle layers.candidates) that can be clicked to
// reject / restore. Candidates are not editable traces and never mix with drawn traces.
// Reject state lives in localStorage and rides along in trace exports as `faultdraw_candidates`.

export const CAND_KEY = 'faultdraw.v1.candidates';

/** Validate a candidates FeatureCollection (LineStrings with unique properties.trace_id). */
export function normalizeCandidates(fc) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('candidates must be a GeoJSON FeatureCollection');
  }
  const seen = new Set();
  const features = [];
  for (const f of fc.features) {
    const g = f && f.geometry;
    if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) continue;
    const p = f.properties || {};
    if (p.trace_id == null) throw new Error('candidate without trace_id');
    const id = String(p.trace_id).slice(0, 64);
    if (seen.has(id)) throw new Error(`duplicate trace_id ${id}`);
    seen.add(id);
    features.push({ type: 'Feature', properties: { ...p, trace_id: id }, geometry: g });
  }
  if (!features.length) throw new Error('candidates has no lines');
  return { type: 'FeatureCollection', name: fc.name || 'Candidate traces', source: fc.source || '', features };
}

export function parseCandState(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  const src = obj.rejected;
  if (Array.isArray(src)) for (const id of src) out[String(id)] = '';
  else if (src && typeof src === 'object') for (const [id, w] of Object.entries(src)) out[String(id)] = typeof w === 'string' ? w : '';
  return out;
}

export function createCandidateReview({ map, L, layerControl, storageGet, storageSet, isBlocked, onChange }) {
  const pane = map.createPane('candidates');
  pane.style.zIndex = '430';
  const renderer = L.canvas({ pane: 'candidates', tolerance: 6 });
  let fc = null;
  let group = null;
  let rejected = {};
  const byId = new Map();
  try { rejected = parseCandState(JSON.parse(storageGet(CAND_KEY) || 'null')); } catch { rejected = {}; }

  const styleFor = (id) => (rejected[id] != null
    ? { color: '#9a9a9a', weight: 2, opacity: 0.8, dashArray: '4 4' }
    : { color: '#ff00ff', weight: 3, opacity: 0.95, dashArray: null });

  function save() { storageSet(CAND_KEY, JSON.stringify({ rejected, source: fc && fc.source, updated: new Date().toISOString() })); }

  function toggle(id, value) {
    const lyr = byId.get(id);
    if (!lyr) return;
    const next = value == null ? rejected[id] == null : !!value;
    if (next) rejected[id] = new Date().toISOString(); else delete rejected[id];
    save();
    lyr.setStyle(styleFor(id));
    onChange && onChange();
  }

  function tip(p) {
    const parts = [`<b>${String(p.trace_id).replace(/[&<>"']/g, '')}</b>`];
    if (Number.isFinite(p.length_km)) parts.push(`${p.length_km.toFixed(2)} km`);
    if (Number.isFinite(p.mean_q)) parts.push(`q ${p.mean_q.toFixed(2)}`);
    if (p.ds249_scarp) parts.push('DS-249 scarp');
    if (p.dem_slope_break) parts.push('DEM slope break');
    return parts.join(' · ');
  }

  function setLayer(newFc, show = true) {
    const clean = normalizeCandidates(newFc);
    unmount();
    fc = clean;
    group = L.featureGroup([], { pmIgnore: true, snapIgnore: true });
    for (const f of clean.features) {
      const id = f.properties.trace_id;
      const lyr = L.geoJSON(f, { renderer, pane: 'candidates', pmIgnore: true, snapIgnore: true, interactive: true, style: () => styleFor(id) });
      lyr.on('click', (e) => {
        if (isBlocked && isBlocked()) return;
        if (e.originalEvent && e.originalEvent.shiftKey) return; // shift-click is for zones; let it bubble to the map
        L.DomEvent.stop(e);
        toggle(id);
      });
      lyr.bindTooltip(tip(f.properties), { sticky: true });
      group.addLayer(lyr);
      byId.set(id, lyr);
    }
    // drop stale ids from another candidate set
    for (const id of Object.keys(rejected)) if (!byId.has(id)) delete rejected[id];
    save();
    layerControl.addOverlay(group, 'Candidate traces (QA/QC)');
    if (show) group.addTo(map);
    syncPointer();
    onChange && onChange();
    return clean;
  }

  function unmount() {
    if (group) {
      layerControl.removeLayer(group);
      if (map.hasLayer(group)) map.removeLayer(group);
    }
    group = null; fc = null; byId.clear();
  }

  function syncPointer() {
    const off = isBlocked && isBlocked();
    pane.style.pointerEvents = off ? 'none' : '';
    const c = renderer._container;
    if (c) c.style.pointerEvents = off ? 'none' : '';
  }

  function progress() {
    let n = 0;
    for (const id of byId.keys()) if (rejected[id] != null) n += 1;
    return { rejected: n, total: byId.size };
  }

  function exportState() {
    return { source: fc ? fc.source : '', rejected: Object.keys(rejected).filter((id) => byId.has(id)).sort(),
      total: byId.size, updated: new Date().toISOString() };
  }

  function importState(obj, mode) {
    const inc = parseCandState(obj);
    rejected = mode === 'replace' ? inc : { ...rejected, ...inc };
    save();
    for (const [id, lyr] of byId) lyr.setStyle(styleFor(id));
    onChange && onChange();
    return Object.keys(rejected).length;
  }

  function reset() {
    rejected = {};
    save();
    for (const [id, lyr] of byId) lyr.setStyle(styleFor(id));
    onChange && onChange();
  }

  return { setLayer, unmount, toggle, progress, exportState, importState, reset, syncPointer,
    get geojson() { return fc; }, get layer() { return group; }, isRejected: (id) => rejected[id] != null };
}
