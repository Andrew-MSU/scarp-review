# Scarp review

Static page for labelling candidate lineaments on hillshade chips. There is no
server and no account. Open the published site or `index.html` in this folder:

https://andrew-msu.github.io/scarp-review/

Links are relative, so the page also works from disk. `.nojekyll` is included
so GitHub Pages serves the files as they are.

## Use

1. Open the page.
2. Type your name in Reviewer. The browser remembers it. Labels are refused
   until the name is set.
3. One candidate at a time. The multidirectional hillshade is shown first.
   The small map is a 2 km context with this chip outlined.

Filter the queue with All, Seeds, Near QFFDB fault (≤ 500 m), or Unlabelled,
or jump to the first candidate you have not labelled. The bar reads
`labelled k / n` plus a count for each class.

Seeds (`seed-elko-1` … `seed-elko-4`) wear a seed badge. They are four
example lines in the Elko area. They start unlabelled in this browser.

Orange lines on the chip are the USGS Quaternary Fault and Fold Database.
Yellow is the detector trace or seed. A dashed grey line, when present, is
the original seed estimate. Magenta is your trace of the true scarp. The
white bar is 100 m and the arrow is north.

If the yellow line is off the real scarp, trace it. If it is on the scarp,
just label.

Chrome blocks `fetch` of `candidates.json` on `file://`. `candidates.js`
sets `window.QUEUE` and the page uses that when fetch fails. Over http either
file works; fetch is preferred.

## Keys

| Key | Action |
|---|---|
| 1 | scarp — straight sharp step, often parallel to a mapped fault and offset about 100–200 m; not a channel or a graded road. With **After 1, stay to trace** checked (the default), stays on this chip and opens trace mode |
| 2 | road/rail/man-made — cut, berm, or embankment following a road, railroad, canal, or other built alignment |
| 3 | drainage — sinuous channel, gully, or valley edge that winds with the slope |
| 4 | other — a real linear feature that is none of the above (joint, terrace, fan boundary, artefact) |
| 5 | unsure — too faint or short, or honestly more than one class |
| r | enter trace mode |
| u | undo the last trace vertex |
| c | clear the trace on this candidate |
| Enter | in trace mode, save the trace and advance |
| n | next candidate; in trace mode, save the trace and advance |
| b | back |
| t | toggle the yellow candidate trace |
| h | switch multidirectional hillshade / sun perpendicular to strike |
| w | toggle "wrong location" (a flag, separate from the trace) |

Keys 2–5 save a label and move to the next candidate. Key 1 does that only
when **After 1, stay to trace** is unchecked. The checkbox is remembered in
this browser. Labelling the same candidate again replaces your previous row
(one row per reviewer and candidate). Keys are ignored while the cursor is
in the name or note field.

## Trace

**Trace** (r) enters trace mode. Each tap on the chip adds a vertex along the
true scarp. The line under the chip is the cursor's easting and northing.
**Undo point** (u) removes the last vertex. **Clear trace** (c) removes them
all. **Done**, Enter, or n saves and moves to the next candidate. On a phone,
a tap is a pointer-up that moved less than 8 px, and the chip ignores page
scroll only while trace mode is on.

The trace is drawn in magenta (`#ff3fd8`), 2.5 px, with a dot on each vertex.
Vertices are stored as UTM zone 11N (EPSG:32611), not as pixels. A trace can
be saved before you pick a label. The page warns you when that happens.

**Wrong location** (w) is independent. It does not start a trace and it does
not move the yellow line. Use it when the candidate is simply in the wrong
place and you are not drawing a replacement.

## Export

**Export CSV** writes `scarp_labels.csv`. Columns, in order:

`candidate_id,tile,label,reviewer,note,timestamp_utc,centroid_e,centroid_n,strike,length_m,trace_utm32611`

`timestamp_utc` is UTC ISO-8601 with seconds and a `Z` suffix
(`2026-09-29T18:00:00Z`). The label strings are exactly `scarp`,
`road/rail/man-made`, `drainage`, `other`, `unsure`.

`trace_utm32611` is WKT in EPSG:32611. Two or more vertices are
`LINESTRING (E N, E N, ...)` with each coordinate to 1 decimal. One vertex is
`POINT (E N)`. The cell is empty when you did not trace. A row is exported
when it has a label or a trace. The label is the one you set. It is `scarp`
only when you labelled it scarp. A trace with no label is exported as
`unsure`.

`[wrong_location]` is still appended to the free text of `note` when that
flag is set. New exports do not put the trace in the note. Older files may
still contain `[redraw_utm32611 E1 N1; E2 N2; ...]`. The merge script reads
that token as a trace when `trace_utm32611` is empty.

Example note: `offset looks high [wrong_location]`

**Export GeoJSON** writes `scarp_labels.geojson`: a point at each exported
centroid (EPSG:32611) with those columns as properties, plus `wrong_location`,
and one LineString (2+ vertices) or Point (1 vertex) per trace. Trace features
have `candidate_id`, `reviewer`, `label`, `timestamp_utc`, and `kind` set to
`trace`. They are not extra rows.

**Export JSON backup** / **Import JSON backup** copies the browser state
(reviewer, notes, labels, traces, the stay-to-trace choice) so you can move
machines without labelling twice.

## Data

Chips are hillshades of USGS 3DEP 1 m lidar (public domain). Fault lines are from the U.S. Geological Survey Quaternary fault and fold database for the United States (public domain), accessed 2026-09-29, https://www.usgs.gov/natural-hazards/earthquake-hazards/faults. 3DEP: https://www.usgs.gov/3d-elevation-program. Candidate lineaments are from our own detector.

## License

Hillshade chips and the QFFDB lines are works of the United States Government
and are in the public domain. The HTML, CSS, and JavaScript in this repository
are MIT licensed. Copyright 2026 Andrew Laskowski. See `LICENSE`.

## Privacy

Labels stay in your browser (localStorage) until you export them. Send exported CSV/GeoJSON files to the team privately; they are merged into our private project repository with scripts/review_import_labels.py. Never commit label exports to this public repository or open issues/PRs containing them.

## Georeference

Each chip is 400 × 400 px at 1 m/px (400 m on a side), north-up, centred on
the candidate centroid. `chip_px` and `chip_m` in `candidates.json` are both
400.

Pixel `(x, y)` has its origin at the top-left of the chip (x east, y south).
The page reads the chip's on-screen rectangle (`getBoundingClientRect`) so a
scaled chip, including a phone layout, still maps the tap onto these pixels.
In EPSG:32611:

```
E = centroid_e + (x - 200) * (chip_m / chip_px)
N = centroid_n - (y - 200) * (chip_m / chip_px)
```

200 is half of 400, the chip centre. With `chip_m == chip_px` the scale is
1 m per pixel.

The hillshade itself was sampled in the lidar tile CRS, NAD83 / UTM zone 11N
(EPSG:26911 on these tiles). Centroids and trace vertices are stored in
WGS84 / UTM zone 11N (EPSG:32611). Those two frames differ by about 1–2 m in
this part of Nevada, so a stored vertex can sit a metre or two off the pixel
you tapped when it is plotted back on the NAD83 hillshade. The yellow trace
is in chip metres from the top-left of that hillshade (`trace_poly` for
seeds, `trace_segments` as `[x1, y1, x2, y2]` for detector candidates) and
lines up with the image. The magenta trace uses the EPSG:32611 formula above.
