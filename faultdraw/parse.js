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
