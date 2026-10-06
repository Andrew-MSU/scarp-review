# FaultDraw

Hand-draw fault traces on a hillshade basemap and export them as GeoJSON. Map data (favorability, dots, known faults, earthquakes) is loaded from your computer at runtime and kept in this browser only. The page does not upload files.

Open `faultdraw/` on the GitHub Pages site, or open `index.html` through a local static server. A direct `file://` open may block IndexedDB.

The map opens at a fixed camera (about latitude 38.9, longitude -117.5, zoom 7). That view is not computed from a dataset.

## Basemaps

Use the layers control (under the zoom buttons):

- USGS 3DEP lidar hillshade (1 m where available) — default
- USGS 3DEP multidirectional hillshade (slower on the USGS server)
- Esri World Hillshade
- Esri World Imagery
- USGS Topo

Hillshade and imagery tiles are requested from those public services. Your traces and data files are not sent with them.

## Load data

**Load data...** accepts several files at once. You can also drop files on the map.

Loading a layer replaces the previous layer of that kind. The last load is stored in IndexedDB (`faultdraw` / `inputs`) and restored on the next visit. **Forget loaded data** clears that store and the overlays. It does not delete drawn traces.

| Layer | When loaded | Draw order (bottom to top) |
| --- | --- | --- |
| Favorability PNG | On, opacity 55% | above the basemap |
| U6 dots PNG | Off, opacity 100% | above favorability |
| Known faults | On | above the images |
| Earthquakes | Off (can be heavy) | above known faults, below your traces |

Your traces are always above those layers. Data layers are not snapping targets. **Snap to my traces** snaps only to traces you drew.

### Bundle (preferred)

One JSON file:

```json
{
  "format": "faultdraw-bundle",
  "version": 1,
  "created": "ISO-8601 timestamp",
  "meta": { "any": "free text or object" },
  "layers": {
    "favorability": {
      "png_base64": "<raw base64 or data URL>",
      "bounds": [[south, west], [north, east]],
      "name": "optional",
      "stretch": { "min": 0, "max": 1 },
      "note": "optional"
    },
    "dots": {
      "png_base64": "<base64>",
      "bounds": [[south, west], [north, east]],
      "name": "optional"
    },
    "known_faults": { "type": "FeatureCollection", "features": [] },
    "hypocenters": {
      "columns": ["lon", "lat", "depth_km", "mag", "time"],
      "lon": [],
      "lat": [],
      "depth_km": [],
      "mag": [],
      "time": [],
      "name": "optional",
      "source": "optional"
    }
  }
}
```

Any subset of `layers` may be present. Bounds are EPSG:4326, south-west then north-east, in Leaflet order `[lat, lon]`. PNGs must already be in Web Mercator. `png_base64` is turned into a blob URL (the data URL is not kept). Hypocenters are columnar to keep the file smaller. `time` values are ISO strings.

### Separate files

- **PNG + sidecar.** `favorability.png` plus `favorability.png.json` or `favorability.json`:

  ```json
  { "kind": "favorability", "bounds": [[south, west], [north, east]], "name": "", "stretch": {}, "note": "" }
  ```

  `kind` is `favorability` or `dots`. If the sidecar is missing, the load reports an error and skips that image.

- **GeoJSON** (`.geojson`, or `.json` with `type: "FeatureCollection"`). LineString and MultiLineString features become known faults. Point features with a `mag` (or `magnitude`) property become hypocenters. Depth is `depth_km`, else `depth`, else the third coordinate. Time is `time`, `time_utc`, `datetime`, or `date`.

- **CSV** with a header containing `lon`, `lat`, `mag`, `depth_km` (or `depth`), and `time`. Commas inside quotes are not supported. `.csv.gz` is not read.

## Drawing

Toolbar: polyline, edit vertices, drag, delete. Marker, polygon, rectangle, circle, text, cut, and rotate are off.

While drawing: click to add vertices, click the last vertex again or press Enter or **Finish** to complete, **Backspace** removes the last vertex, **Esc** cancels. **Ctrl+Z** / **Ctrl+Y** undo and redo finished changes (not a vertex while you are still drawing). The undo stack keeps 50 states.

Click a finished trace (when no Geoman tool is active) to set confidence and a note.

| Confidence | Style |
| --- | --- |
| 1 low | dashed cyan |
| 2 medium | solid cyan (default) |
| 3 high | thicker solid cyan |

Each trace stores `id`, `confidence`, `note`, `created`, `modified`, and a geodesic `length_km`. The status line **Segments** counts traces. Length uses `map.distance` between vertices.

Traces autosave to `localStorage` key `faultdraw.v1.traces`. They are not written to IndexedDB. The warning banner can be dismissed for this session; it comes back when the traces change. Closing the tab warns if there are changes since the last export.

**Export GeoJSON** downloads `faultdraw_traces_YYYYMMDD_HHMM.geojson`:

```json
{
  "type": "FeatureCollection",
  "name": "faultdraw traces",
  "exported": "ISO-8601 UTC",
  "features": [{
    "type": "Feature",
    "properties": {
      "id": "uuid",
      "confidence": 2,
      "note": "",
      "created": "ISO-8601",
      "modified": "ISO-8601",
      "length_km": 1.234
    },
    "geometry": { "type": "LineString", "coordinates": [[lon, lat]] }
  }]
}
```

Coordinates are EPSG:4326, longitude then latitude, 6 decimal places.

**Import traces** reads that kind of GeoJSON (LineString, or one trace per MultiLineString part). It asks whether to replace or merge. Merge skips features whose `id` is already present. Missing properties get defaults. Do not use Import traces for known faults or catalogs; use **Load data...**.

**Clear all traces** asks first and can be undone.

## Earthquakes

Circle markers on a canvas (no DOM marker per quake). Radius is `clamp(1 + 1.6 * (mag + 0.5), 1, 14)` pixels. Color is depth from 0 km (yellow) to 30 km (dark purple); deeper and shallower values are clamped. The minimum-magnitude control defaults to 1.5. The count is how many points pass that filter. Clicks are ignored while a draw or edit tool is active. A popup shows magnitude, depth to 0.1 km, the UTC time string, and the local date.

## Coordinate readout

The bottom-left readout is latitude and longitude to 5 decimals, UTM zone 11N easting and northing in metres (WGS84 transverse Mercator, central meridian −117°, false easting 500000, false northing 0), and zoom. It stays zone 11N even if you pan outside the zone.

## For tests

After the module loads, `window.faultdraw` is `{ map, getTracesGeoJSON, loadFiles, layers, status }`. `loadFiles` accepts a `FileList` or an array of `File`s and resolves to `status()`. `getTracesGeoJSON()` is the current traces without the export timestamp.
