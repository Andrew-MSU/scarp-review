// Pure parsers for local FaultDraw inputs. No network, no DOM.

/** Lower-case sidecar filenames for a PNG: "name.png.json" and "name.json". */
export function sidecarCandidates(pngName) {
  const lower = String(pngName).toLowerCase();
  const stem = lower.replace(/\.png$/, '');
  return [`${lower}.json`, `${stem}.json`];
}

/**
 * @param {unknown} bounds
 * @returns {[[number, number], [number, number]]} [[south, west], [north, east]]
 */
export function parseBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 2) {
    throw new Error('bounds must be [[south, west], [north, east]] in EPSG:4326');
  }
  const sw = bounds[0];
  const ne = bounds[1];
  if (!Array.isArray(sw) || !Array.isArray(ne) || sw.length < 2 || ne.length < 2) {
    throw new Error('bounds must be [[south, west], [north, east]] in EPSG:4326');
  }
  const south = Number(sw[0]);
  const west = Number(sw[1]);
  const north = Number(ne[0]);
  const east = Number(ne[1]);
  if (![south, west, north, east].every(Number.isFinite)) {
    throw new Error('bounds must be finite numbers');
  }
  if (Math.abs(south) > 90 || Math.abs(north) > 90 || Math.abs(west) > 180 || Math.abs(east) > 180) {
    throw new Error('bounds are not EPSG:4326 latitudes/longitudes');
  }
  if (south > north) throw new Error('bounds south is greater than north');
  if (south === north || west === east) throw new Error('bounds have zero width or height');
  return [[south, west], [north, east]];
}

/** Decode a raw base64 string or a data URL into a Blob. Does not use fetch. */
export function base64ToBlob(input, mime = 'image/png') {
  if (typeof input !== 'string' || !input.trim()) throw new Error('missing png_base64');
  let b64 = input.trim();
  let type = mime;
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(b64);
  if (m) {
    type = m[1] || mime;
    b64 = m[2];
  }
  b64 = b64.replace(/\s+/g, '');
  if (!b64) throw new Error('empty png_base64');
  let binary;
  try {
    binary = atob(b64);
  } catch {
    throw new Error('png_base64 is not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  const chunk = 0x8000;
  for (let i = 0; i < binary.length; i += chunk) {
    const end = Math.min(i + chunk, binary.length);
    for (let j = i; j < end; j++) bytes[j] = binary.charCodeAt(j);
  }
  return new Blob([bytes], { type: type || mime });
}

/**
 * @param {unknown} data
 * @returns {{kind:'bundle'|'sidecar'|'features'|'unknown', wrap?:boolean, error?:string}}
 */
export function classifyJson(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { kind: 'unknown', error: 'JSON is not an object' };
  }
  if (data.format === 'faultdraw-bundle') {
    if (data.version != null && Number(data.version) !== 1) {
      return { kind: 'unknown', error: `Unsupported bundle version ${data.version} (expected 1)` };
    }
    return { kind: 'bundle' };
  }
  if ((data.kind === 'favorability' || data.kind === 'dots') && data.bounds) {
    return { kind: 'sidecar' };
  }
  if (data.type === 'FeatureCollection' && Array.isArray(data.features)) return { kind: 'features' };
  if (data.type === 'Feature' && data.geometry) return { kind: 'features', wrap: true };
  return {
    kind: 'unknown',
    error: 'Unrecognized JSON (expected a faultdraw bundle, an image sidecar, or GeoJSON)',
  };
}

function finiteNumber(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Columnar hypocenters. time may be omitted (filled with empty strings).
 * @returns {{lon:Float64Array, lat:Float64Array, depth_km:Float64Array, mag:Float64Array, time:string[], name:string, source:string, timeMissing:boolean}}
 */
export function columnarQuakes(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('hypocenters must be an object of columns');
  const lon = obj.lon;
  const lat = obj.lat;
  const depth = obj.depth_km;
  const mag = obj.mag;
  if (!lon || !lat || !depth || !mag) {
    throw new Error('hypocenters need arrays lon, lat, depth_km, and mag');
  }
  const n = lon.length;
  if (lat.length !== n || depth.length !== n || mag.length !== n) {
    throw new Error(`hypocenter columns differ in length (lon has ${n})`);
  }
  const timeMissing = obj.time == null;
  const timeSrc = timeMissing ? new Array(n).fill('') : obj.time;
  if (timeSrc.length !== n) throw new Error('hypocenter time length does not match lon');
  return {
    lon: Float64Array.from(lon, finiteNumber),
    lat: Float64Array.from(lat, finiteNumber),
    depth_km: Float64Array.from(depth, finiteNumber),
    mag: Float64Array.from(mag, finiteNumber),
    time: Array.from(timeSrc, (v) => (v == null ? '' : String(v))),
    name: obj.name != null ? String(obj.name) : '',
    source: obj.source != null ? String(obj.source) : '',
    timeMissing,
  };
}

function headerIndex(header, names) {
  for (const name of names) {
    const i = header.indexOf(name);
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * Simple split CSV. No quoted commas. Requires lon, lat, mag, depth_km|depth, time.
 * @returns {{rows:object, skipped:number}}
 */
export function parseCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) throw new Error('CSV is empty');
  const header = lines[0].split(',').map((s) => s.trim().toLowerCase());
  const iLon = headerIndex(header, ['lon', 'longitude', 'long']);
  const iLat = headerIndex(header, ['lat', 'latitude']);
  const iMag = headerIndex(header, ['mag', 'magnitude']);
  const iDep = headerIndex(header, ['depth_km', 'depth']);
  const iTime = headerIndex(header, ['time', 'time_utc', 'datetime', 'date']);
  const missing = [];
  if (iLon < 0) missing.push('lon');
  if (iLat < 0) missing.push('lat');
  if (iMag < 0) missing.push('mag');
  if (iDep < 0) missing.push('depth_km (or depth)');
  if (iTime < 0) missing.push('time');
  if (missing.length) throw new Error(`CSV is missing column(s): ${missing.join(', ')}`);
  const lon = [];
  const lat = [];
  const depth_km = [];
  const mag = [];
  const time = [];
  let skipped = 0;
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(',');
    const lo = finiteNumber(cells[iLon] == null ? '' : cells[iLon].trim());
    const la = finiteNumber(cells[iLat] == null ? '' : cells[iLat].trim());
    const m = finiteNumber(cells[iMag] == null ? '' : cells[iMag].trim());
    const d = finiteNumber(cells[iDep] == null ? '' : cells[iDep].trim());
    if (!Number.isFinite(lo) || !Number.isFinite(la) || !Number.isFinite(m) || !Number.isFinite(d)) {
      skipped += 1;
      continue;
    }
    lon.push(lo);
    lat.push(la);
    depth_km.push(d);
    mag.push(m);
    time.push(cells[iTime] == null ? '' : cells[iTime].trim());
  }
  if (!lon.length) throw new Error('CSV had no usable rows');
  const rows = columnarQuakes({ lon, lat, depth_km, mag, time });
  return { rows, skipped };
}

/** Split a Feature or FeatureCollection into fault lines and magnitude-bearing points. */
export function splitFeatureCollection(fc) {
  const features = fc && fc.type === 'Feature' ? [fc] : (fc && fc.features) || [];
  const lines = [];
  const lon = [];
  const lat = [];
  const depth_km = [];
  const mag = [];
  const time = [];
  let pointLike = 0;
  let pointsWithoutMag = 0;
  let other = 0;
  for (const feature of features) {
    if (!feature || !feature.geometry) {
      other += 1;
      continue;
    }
    const g = feature.geometry;
    const props = feature.properties || {};
    if (g.type === 'LineString' || g.type === 'MultiLineString') {
      lines.push(feature);
      continue;
    }
    if (g.type === 'Point' || g.type === 'MultiPoint') {
      const coords = g.type === 'Point' ? [g.coordinates] : g.coordinates;
      pointLike += 1;
      const m = finiteNumber(props.mag != null ? props.mag : props.magnitude);
      if (!Number.isFinite(m)) {
        pointsWithoutMag += 1;
        continue;
      }
      const t = props.time ?? props.time_utc ?? props.datetime ?? props.date ?? '';
      const dProp = props.depth_km != null ? props.depth_km : props.depth;
      const list = Array.isArray(coords) ? coords : [];
      for (const c of list) {
        if (!c || c.length < 2) continue;
        const d = finiteNumber(dProp != null ? dProp : c[2]);
        lon.push(finiteNumber(c[0]));
        lat.push(finiteNumber(c[1]));
        depth_km.push(Number.isFinite(d) ? d : NaN);
        mag.push(m);
        time.push(t == null ? '' : String(t));
      }
      continue;
    }
    other += 1;
  }
  return {
    faults: lines.length ? { type: 'FeatureCollection', features: lines } : null,
    quakes: lon.length ? columnarQuakes({ lon, lat, depth_km, mag, time }) : null,
    pointLike,
    pointsWithoutMag,
    other,
  };
}

/** Keep only LineString / MultiLineString features. */
export function lineCollection(fc) {
  const split = splitFeatureCollection(fc);
  return {
    faults: split.faults,
    ignoredPoints: split.pointLike,
    ignoredOther: split.other,
  };
}

// --- hypothesis overlays (bundle layers.overlays) ---

const OVERLAY_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const CSS_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const DASH = /^[0-9]+(?:[ ,][0-9]+)*$/;

function str(v, max = 2000) {
  return v == null ? '' : String(v).slice(0, max);
}

function cssColor(v, fallback) {
  return typeof v === 'string' && CSS_HEX.test(v.trim()) ? v.trim() : fallback;
}

function unitNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** Path style with only known keys and safe values. */
export function cleanPathStyle(src, base = {}) {
  const out = { ...base };
  if (!src || typeof src !== 'object') return out;
  if (src.color != null) out.color = cssColor(src.color, out.color || '#ffffff');
  if (src.weight != null && Number.isFinite(Number(src.weight))) {
    out.weight = Math.min(8, Math.max(0.3, Number(src.weight)));
  }
  if (src.opacity != null) out.opacity = unitNumber(src.opacity, out.opacity == null ? 0.9 : out.opacity);
  if (src.dashArray != null) {
    const d = String(src.dashArray).trim();
    if (DASH.test(d)) out.dashArray = d;
  }
  return out;
}

/** Legend: ramp {colors, labels} | categories {items:[{color,label}]} | lines {items:[{color,label,dash}]}. */
export function cleanLegend(src) {
  if (!src || typeof src !== 'object') return null;
  if (src.kind === 'ramp') {
    const colors = (Array.isArray(src.colors) ? src.colors : []).map((c) => cssColor(c, null)).filter(Boolean).slice(0, 32);
    if (colors.length < 2) return null;
    const labels = (Array.isArray(src.labels) ? src.labels : []).map((s) => str(s, 40)).slice(0, 5);
    return { kind: 'ramp', colors, labels };
  }
  if (src.kind === 'categories' || src.kind === 'lines') {
    const items = (Array.isArray(src.items) ? src.items : []).slice(0, 24).map((it) => ({
      color: cssColor(it && it.color, '#cccccc'),
      label: str(it && it.label, 80),
      dash: !!(it && it.dash),
    }));
    return items.length ? { kind: src.kind, items } : null;
  }
  return null;
}

/**
 * Validate one overlay entry. Raster: png_base64 + bounds. Lines: geojson FeatureCollection.
 * @returns {{spec:object, png?:string, geojson?:object}}
 */
export function normalizeOverlay(src, index) {
  if (!src || typeof src !== 'object') throw new Error(`overlay ${index + 1} is not an object`);
  const type = src.type;
  if (type !== 'raster' && type !== 'lines') throw new Error(`overlay ${index + 1}: type must be "raster" or "lines"`);
  const id = typeof src.id === 'string' && OVERLAY_ID.test(src.id) ? src.id : `overlay_${index + 1}`;
  const spec = {
    id,
    type,
    order: index,
    group: str(src.group, 60),
    name: str(src.name, 120) || id,
    opacity: unitNumber(src.opacity, type === 'raster' ? 0.7 : 0.95),
    visible: src.visible === true,
    legend: cleanLegend(src.legend),
    note: str(src.note),
    source: str(src.source, 500),
    hypothesis: str(src.hypothesis, 500),
  };
  if (type === 'raster') {
    spec.bounds = parseBounds(src.bounds);
    if (typeof src.png_base64 !== 'string' || !src.png_base64.trim()) throw new Error(`${id}: missing png_base64`);
    return { spec, png: src.png_base64 };
  }
  const fc = src.geojson;
  if (!fc || typeof fc !== 'object') throw new Error(`${id}: lines overlay needs geojson`);
  const lines = lineCollection(fc).faults;
  if (!lines) throw new Error(`${id}: geojson has no lines`);
  const style = src.style && typeof src.style === 'object' ? src.style : {};
  const def = cleanPathStyle(style.default, { color: '#ffffff', weight: 1.2, opacity: 0.95 });
  const values = {};
  if (style.values && typeof style.values === 'object') {
    for (const [k, v] of Object.entries(style.values).slice(0, 64)) values[String(k)] = cleanPathStyle(v, {});
  }
  spec.style = { property: str(style.property, 64), default: def, values };
  return { spec, geojson: lines };
}

/** Leaflet path options for one feature of a lines overlay. */
export function featureStyle(styleSpec, feature) {
  const props = (feature && feature.properties) || {};
  const key = styleSpec.property ? props[styleSpec.property] : undefined;
  const extra = key != null && Object.prototype.hasOwnProperty.call(styleSpec.values, String(key))
    ? styleSpec.values[String(key)]
    : {};
  return { ...styleSpec.default, ...extra };
}
