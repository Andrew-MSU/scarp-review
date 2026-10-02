# Scarp review

Static page for one task: judge whether the line drawn on a hillshade chip follows a real fault scarp. There is no server and no account. Open the published site or `index.html` in this folder:

https://andrew-msu.github.io/scarp-review/

Links are relative, so the page also works from disk. `_config.yml` excludes `archive/` from the GitHub Pages build, so the archived batches are kept in the repo but not served.

The page loads the 152 batch-4 chips only (`b4-001` through `b4-152`). Each chip is the multidirectional hillshade with the line already drawn. Batches 1–3 are in `archive/` and are not loaded or served.

Chrome blocks `fetch` of `candidates.json` on `file://`. `candidates.js` sets `window.QUEUE`, and the page uses that when fetch fails. Over http, either file works; fetch is preferred.

## Use

1. Open the page and enter your name in Reviewer first. The browser remembers it. A label is refused until the name is set. A link can prefill a known name, for example <https://andrew-msu.github.io/scarp-review/?reviewer=Walker>. Each name keeps its own labels.
2. The page opens on the first chip you have not labelled. The header shows where you are (`1 of 152`) and how many you have labelled (`Labelled k / 152`).
3. Judge the drawn line. Keys 1–5 save that label for the current chip and move to the next one. `n` is next and `b` is back. Buttons do the same thing.

| Key | What you see | Value stored |
|---|---|---|
| 1 | scarp | `scarp` |
| 2 | road/rail | `road/rail/man-made` |
| 3 | drainage/channel | `drainage` |
| 4 | other | `other` |
| 5 | unsure | `unsure` |

Key 1 saves `scarp` directly. The optional note is saved with the label. Keys are ignored while the cursor is in the name or note field. Labelling the same chip again replaces your previous label for that chip. The button for the current label is highlighted.

Labels save in this browser automatically. When finished, click **Export CSV** and send the file to Andrew.

## Export

**Export CSV** downloads `scarp_review_labels.csv`. Columns, in order:

`candidate_id,label,reviewer,note,timestamp_utc`

Rows are labels whose id is one of the 152 loaded chips, for any reviewer, sorted by `candidate_id`. The note text is included. The page reports `Exported N rows`.

`timestamp_utc` is UTC ISO-8601 with seconds and a `Z` suffix (`2026-09-29T18:00:00Z`). The label strings are exactly `scarp`, `road/rail/man-made`, `drainage`, `other`, and `unsure`.

## Storage

Labels stay in `localStorage` under the key `scarp_review_site_v1`. That key is unchanged, so labels already in this browser stay there, including labels from batches 1–3. This page does not delete entries for ids it does not load. It only shows and exports the batch-4 chips.

Do not commit label exports to this public repository.

## Data

Chips are hillshades of USGS 3DEP 1 m lidar (public domain).

## License

Hillshade chips are works of the United States Government and are in the public domain. The HTML, CSS, and JavaScript in this repository are MIT licensed. Copyright 2026 Andrew Laskowski. See `LICENSE`.
