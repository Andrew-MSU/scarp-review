/* Static scarp review. Labels and traces stay in localStorage until export. */
(function () {
  const COLUMNS = ["candidate_id","tile","label","reviewer","note","timestamp_utc","centroid_e","centroid_n","strike","length_m","trace_utm32611"];
  const LABELS = ["scarp","road/rail/man-made","drainage","other","unsure"];
  const HELP = {
    "scarp": "Straight sharp step, often parallel to a mapped fault and offset about 100–200 m. Not a channel or a graded road.",
    "road/rail/man-made": "Cut, berm, or embankment that follows a road, railroad, canal, or other built alignment.",
    "drainage": "Sinuous channel, gully, or valley edge that winds with the slope.",
    "other": "A real linear feature that is none of the above: joint, terrace, fan boundary, or artefact.",
    "unsure": "Too faint or short to call, or honestly more than one of the classes above."
  };
  const STORE = "scarp_review_site_v1";
  const SEP = "\u0000";
  const TAP_PX = 8;

  const chip = document.getElementById("chip");
  const overlay = document.getElementById("overlay");
  const stage = document.getElementById("stage");
  const minimap = document.getElementById("minimap");
  const reviewerEl = document.getElementById("reviewer");
  const noteEl = document.getElementById("note");
  const wrongEl = document.getElementById("wrong-location");
  const stayEl = document.getElementById("stay-to-trace");
  const savedEl = document.getElementById("saved");
  const state = {
    queue: [],
    byId: {},
    index: 0,
    filter: "all",
    mode: "multi",
    trace: true,
    traceMode: false,
    cursorChip: null,
    chipPx: 400,
    chipM: 400,
    store: loadStore(),
    drawToken: 0
  };
  let activePtr = null;

  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) || "null");
      if (raw && raw.entries && typeof raw.entries === "object") return normalizeStore(raw);
    } catch (err) { /* empty store */ }
    return { version: 1, reviewer: "", stayToTrace: true, entries: {} };
  }

  function normalizeStore(data) {
    const entries = data.entries && typeof data.entries === "object" ? data.entries : {};
    Object.keys(entries).forEach(function (key) {
      const entry = entries[key];
      if (!entry || typeof entry !== "object") return;
      if (!Array.isArray(entry.trace)) {
        entry.trace = Array.isArray(entry.redraw) ? entry.redraw.slice() : [];
      }
      delete entry.redraw;
      entry.wrong_location = !!entry.wrong_location;
    });
    return {
      version: 1,
      reviewer: String(data.reviewer || ""),
      stayToTrace: typeof data.stayToTrace === "boolean" ? data.stayToTrace : true,
      entries: entries
    };
  }

  function reviewerName() {
    return reviewerEl.value.trim();
  }

  function persist() {
    state.store.reviewer = reviewerName();
    state.store.stayToTrace = !!stayEl.checked;
    state.store.version = 1;
    try { localStorage.setItem(STORE, JSON.stringify(state.store)); }
    catch (err) { /* private mode */ }
  }

  function entryKey(reviewer, id) {
    return reviewer + SEP + id;
  }

  function getEntry(reviewer, id) {
    if (!reviewer) return null;
    return state.store.entries[entryKey(reviewer, id)] || null;
  }

  function ensureEntry(reviewer, id) {
    const key = entryKey(reviewer, id);
    if (!state.store.entries[key]) {
      state.store.entries[key] = {
        label: null,
        note: "",
        timestamp_utc: null,
        wrong_location: false,
        trace: []
      };
    }
    const entry = state.store.entries[key];
    if (!Array.isArray(entry.trace)) {
      entry.trace = Array.isArray(entry.redraw) ? entry.redraw.slice() : [];
      delete entry.redraw;
    }
    return entry;
  }

  function isLabelled(cand) {
    const entry = getEntry(reviewerName(), cand.id);
    return !!(entry && entry.label && LABELS.indexOf(entry.label) >= 0);
  }

  function filtered() {
    const mode = state.filter;
    return state.queue.filter(function (cand) {
      if (mode === "seeds") return cand.kind === "seed" || cand.seed === true;
      if (mode === "near") {
        const dist = Number(cand.qffdb_dist_m);
        return Number.isFinite(dist) && dist <= 500;
      }
      if (mode === "unlabelled") return !isLabelled(cand);
      if (mode === "batch2") return Number(cand.batch) === 2;
      return true;
    });
  }

  function current() {
    const list = filtered();
    if (!list.length) return null;
    if (state.index >= list.length) state.index = list.length - 1;
    if (state.index < 0) state.index = 0;
    return list[state.index];
  }

  function requireReviewer() {
    if (reviewerName()) return true;
    reviewerEl.focus();
    savedEl.textContent = "Set your name first.";
    return false;
  }

  function typing() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return type === "text" || type === "search" || type === "number" || type === "email" || type === "";
    }
    return false;
  }

  function chipToUtm(x, y, cand) {
    const scale = state.chipM / state.chipPx;
    const e = Number(cand.centroid_e) + (x - state.chipPx / 2) * scale;
    const n = Number(cand.centroid_n) - (y - state.chipPx / 2) * scale;
    return [e, n];
  }

  function utmToChip(e, n, cand) {
    const scale = state.chipM / state.chipPx;
    const x = (e - Number(cand.centroid_e)) / scale + state.chipPx / 2;
    const y = (Number(cand.centroid_n) - n) / scale + state.chipPx / 2;
    return [x, y];
  }

  function eventToChip(ev) {
    const rect = chip.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return [
      (ev.clientX - rect.left) * (state.chipPx / rect.width),
      (ev.clientY - rect.top) * (state.chipPx / rect.height)
    ];
  }

  function escapeText(t) {
    return String(t).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch];
    });
  }

  function drawUserTrace(ctx, cand, verts) {
    ctx.strokeStyle = "#ff3fd8";
    ctx.fillStyle = "#ff3fd8";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const xys = verts.map(function (utm) { return utmToChip(utm[0], utm[1], cand); });
    if (xys.length) {
      ctx.beginPath();
      xys.forEach(function (xy, i) {
        if (i === 0) ctx.moveTo(xy[0], xy[1]);
        else ctx.lineTo(xy[0], xy[1]);
      });
      if (xys.length >= 2) ctx.stroke();
      if (state.traceMode && state.cursorChip) {
        const last = xys[xys.length - 1];
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(last[0], last[1]);
        ctx.lineTo(state.cursorChip[0], state.cursorChip[1]);
        ctx.stroke();
        ctx.restore();
      }
      xys.forEach(function (xy) {
        ctx.beginPath();
        ctx.arc(xy[0], xy[1], 4, 0, Math.PI * 2);
        ctx.fill();
      });
    } else if (state.traceMode && state.cursorChip) {
      ctx.beginPath();
      ctx.arc(state.cursorChip[0], state.cursorChip[1], 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawOverlay() {
    const ctx = overlay.getContext("2d");
    const px = state.chipPx;
    const scale = px / state.chipM;
    overlay.width = px;
    overlay.height = px;
    ctx.clearRect(0, 0, px, px);
    const cand = current();
    if (!cand) return;
    if (state.trace && cand.trace_poly_est) {
      ctx.save();
      ctx.strokeStyle = "rgba(230, 230, 230, 0.9)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      cand.trace_poly_est.forEach(function (p, i) {
        if (i === 0) ctx.moveTo(p[0] * scale, p[1] * scale);
        else ctx.lineTo(p[0] * scale, p[1] * scale);
      });
      ctx.stroke();
      ctx.restore();
    }
    if (state.trace) {
      ctx.strokeStyle = "#ffe14a";
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.beginPath();
      (cand.trace_poly || []).forEach(function (p, i) {
        const x = p[0] * scale;
        const y = p[1] * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      (cand.trace_segments || []).forEach(function (seg) {
        ctx.moveTo(seg[0] * scale, seg[1] * scale);
        ctx.lineTo(seg[2] * scale, seg[3] * scale);
      });
      ctx.stroke();
    }
    const entry = getEntry(reviewerName(), cand.id);
    drawUserTrace(ctx, cand, (entry && entry.trace) || []);
  }

  function progressText() {
    const counts = {};
    LABELS.forEach(function (label) { counts[label] = 0; });
    let k = 0;
    const rev = reviewerName();
    state.queue.forEach(function (cand) {
      const entry = getEntry(rev, cand.id);
      if (!entry || !entry.label || counts[entry.label] == null) return;
      counts[entry.label] += 1;
      k += 1;
    });
    const n = state.queue.length;
    const bits = LABELS.map(function (label) { return label + " " + counts[label]; });
    return { k: k, n: n, text: "labelled " + k + " / " + n + " · " + bits.join(" · ") };
  }

  function show() {
    const list = filtered();
    const cand = current();
    const prog = progressText();
    document.getElementById("progress").textContent = state.queue.length ? prog.text : "no candidates";
    document.getElementById("progress-bar").style.width = prog.n ? (100 * prog.k / prog.n) + "%" : "0%";
    const filterLabel = { all: "all", seeds: "seeds", near: "near QFFDB", unlabelled: "unlabelled", batch2: "batch 2" }[state.filter] || "all";
    document.getElementById("position").textContent = list.length
      ? ((state.index + 1) + " / " + list.length + " " + filterLabel)
      : ("0 " + filterLabel);
    document.getElementById("mode-multi").classList.toggle("on", state.mode === "multi");
    document.getElementById("mode-dir").classList.toggle("on", state.mode === "dir");
    document.getElementById("toggle-trace").classList.toggle("on", state.trace);
    document.getElementById("trace-mode").classList.toggle("on", state.traceMode);
    stage.classList.toggle("tracing", state.traceMode);
    document.getElementById("trace-banner").hidden = !state.traceMode;
    if (!cand) {
      chip.removeAttribute("src");
      minimap.removeAttribute("src");
      document.getElementById("meta").textContent = "";
      document.getElementById("flags").textContent = "";
      document.getElementById("seed-badge").hidden = true;
      noteEl.value = "";
      wrongEl.checked = false;
      document.getElementById("vertex-count").textContent = "0 vertices";
      document.getElementById("trace-warn").hidden = true;
      drawOverlay();
      return;
    }
    const token = ++state.drawToken;
    const file = state.mode === "dir" ? cand.chip_dir : cand.chip_multi;
    const nextSrc = "chips/" + file;
    chip.dataset.id = cand.id;
    chip.dataset.mode = state.mode;
    chip.dataset.token = String(token);
    if (chip.getAttribute("src") !== nextSrc) chip.src = nextSrc;
    if (cand.minimap) {
      const mapSrc = "chips/" + cand.minimap;
      if (minimap.getAttribute("src") !== mapSrc) minimap.src = mapSrc;
    } else {
      minimap.removeAttribute("src");
    }
    const entry = getEntry(reviewerName(), cand.id);
    const qName = cand.qffdb_name ? String(cand.qffdb_name) : "—";
    const qDist = cand.qffdb_dist_m == null || !Number.isFinite(Number(cand.qffdb_dist_m))
      ? "—"
      : Number(cand.qffdb_dist_m).toFixed(1);
    const score = cand.mean_score == null ? "—" : Number(cand.mean_score).toFixed(2);
    const strike = cand.strike == null ? "—" : Math.round(Number(cand.strike)) + "°";
    const length = cand.length_m == null ? "—" : Math.round(Number(cand.length_m)) + " m";
    const labelled = entry && entry.label ? entry.label : "—";
    document.getElementById("meta").innerHTML = [
      ["id", cand.id],
      ["tile", cand.short || cand.tile],
      ["label", labelled],
      ["strike", strike],
      ["length", length],
      ["score", score],
      ["QFFDB fault:", qName + ", " + qDist + " m"]
    ].concat(cand.seed_status ? [["seed position:", escapeText(cand.seed_status)]] : []).map(function (pair) {
      return "<div><b>" + pair[0] + "</b> " + pair[1] + "</div>";
    }).join("");
    document.getElementById("seed-badge").hidden = !(cand.kind === "seed" || cand.seed === true);
    const flags = cand.mask_flags || {};
    document.getElementById("flags").innerHTML = Object.keys(flags).map(function (key) {
      const value = flags[key];
      const cls = value ? "flag on" : "flag";
      const text = value == null ? "n/a" : (value ? "yes" : "no");
      return "<span class=\"" + cls + "\">" + key + ": " + text + "</span>";
    }).join("");
    noteEl.value = entry && entry.note ? entry.note : "";
    wrongEl.checked = !!(entry && entry.wrong_location);
    const nVert = entry && entry.trace ? entry.trace.length : 0;
    document.getElementById("vertex-count").textContent = nVert + (nVert === 1 ? " vertex" : " vertices");
    const labelledOk = !!(entry && entry.label && LABELS.indexOf(entry.label) >= 0);
    document.getElementById("trace-warn").hidden = !(nVert && !labelledOk);
    drawOverlay();
  }

  function round1(value) {
    return Number(Number(value).toFixed(1));
  }

  function encodeNote(text, wrong) {
    let free = String(text || "");
    free = free.replace(/\s*\[wrong_location\]/g, "");
    free = free.replace(/\s*\[redraw_utm32611[^\]]*\]/g, "");
    free = free.trim();
    const parts = [];
    if (free) parts.push(free);
    if (wrong) parts.push("[wrong_location]");
    return parts.join(" ");
  }

  function traceWkt(verts) {
    if (!verts || !verts.length) return "";
    const body = verts.map(function (p) {
      return round1(p[0]).toFixed(1) + " " + round1(p[1]).toFixed(1);
    }).join(", ");
    if (verts.length === 1) return "POINT (" + body + ")";
    return "LINESTRING (" + body + ")";
  }

  function exportLabel(entry) {
    if (entry.label && LABELS.indexOf(entry.label) >= 0) return entry.label;
    return "unsure";
  }

  function numOrZero(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function exportEntries() {
    const rows = [];
    Object.keys(state.store.entries).forEach(function (key) {
      const splitAt = key.indexOf(SEP);
      if (splitAt < 0) return;
      const reviewer = key.slice(0, splitAt);
      const id = key.slice(splitAt + 1);
      const entry = state.store.entries[key];
      if (!entry) return;
      const labelled = entry.label && LABELS.indexOf(entry.label) >= 0;
      const traced = entry.trace && entry.trace.length;
      if (!labelled && !traced) return;
      const cand = state.byId[id];
      if (!cand) return;
      rows.push({ cand: cand, reviewer: reviewer, entry: entry });
    });
    rows.sort(function (a, b) {
      const ta = a.entry.timestamp_utc || "";
      const tb = b.entry.timestamp_utc || "";
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      if (a.cand.id < b.cand.id) return -1;
      if (a.cand.id > b.cand.id) return 1;
      return 0;
    });
    return rows;
  }

  function rowFrom(item) {
    const cand = item.cand;
    const entry = item.entry;
    return {
      candidate_id: cand.id,
      tile: cand.tile || "",
      label: exportLabel(entry),
      reviewer: item.reviewer,
      note: encodeNote(entry.note, entry.wrong_location),
      timestamp_utc: entry.timestamp_utc || nowIso(),
      centroid_e: numOrZero(cand.centroid_e),
      centroid_n: numOrZero(cand.centroid_n),
      strike: numOrZero(cand.strike),
      length_m: numOrZero(cand.length_m),
      trace_utm32611: traceWkt(entry.trace || [])
    };
  }

  function csvEscape(value) {
    const s = value == null ? "" : String(value);
    if (/[",\r\n]/.test(s)) return "\"" + s.replace(/"/g, "\"\"") + "\"";
    return s;
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function exportCsv() {
    const items = exportEntries();
    const lines = [COLUMNS.join(",")];
    items.forEach(function (item) {
      const row = rowFrom(item);
      lines.push(COLUMNS.map(function (col) { return csvEscape(row[col]); }).join(","));
    });
    download("scarp_labels.csv", lines.join("\n") + "\n", "text/csv");
    savedEl.textContent = "Exported " + items.length + " CSV rows.";
  }

  function exportGeoJSON() {
    const features = [];
    exportEntries().forEach(function (item) {
      const row = rowFrom(item);
      const props = {};
      COLUMNS.forEach(function (col) { props[col] = row[col]; });
      props.wrong_location = !!item.entry.wrong_location;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [row.centroid_e, row.centroid_n] },
        properties: props
      });
      const verts = (item.entry.trace || []).map(function (p) {
        return [round1(p[0]), round1(p[1])];
      });
      if (!verts.length) return;
      const geometry = verts.length >= 2
        ? { type: "LineString", coordinates: verts }
        : { type: "Point", coordinates: verts[0] };
      features.push({
        type: "Feature",
        geometry: geometry,
        properties: {
          candidate_id: row.candidate_id,
          reviewer: row.reviewer,
          label: row.label,
          timestamp_utc: row.timestamp_utc,
          kind: "trace"
        }
      });
    });
    const payload = {
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "EPSG:32611" } },
      features: features
    };
    download("scarp_labels.geojson", JSON.stringify(payload, null, 1) + "\n", "application/geo+json");
    savedEl.textContent = "Exported GeoJSON (" + features.length + " features).";
  }

  function exportBackup() {
    persist();
    download("scarp_review_backup.json", JSON.stringify(state.store, null, 1) + "\n", "application/json");
    savedEl.textContent = "Exported JSON backup.";
  }

  function advance() {
    state.traceMode = false;
    const cand = current();
    if (!cand) {
      show();
      return;
    }
    const stillThere = filtered().some(function (item) { return item.id === cand.id; });
    if (stillThere) {
      const idx = filtered().findIndex(function (item) { return item.id === cand.id; });
      const list = filtered();
      state.index = Math.min(list.length - 1, idx + 1);
    }
    show();
  }

  function commit(label) {
    const cand = current();
    if (!cand) return;
    if (!requireReviewer()) return;
    const reviewer = reviewerName();
    const entry = ensureEntry(reviewer, cand.id);
    entry.label = label;
    entry.note = noteEl.value;
    entry.timestamp_utc = nowIso();
    entry.wrong_location = wrongEl.checked;
    persist();
    if (label === "scarp" && stayEl.checked) {
      state.traceMode = true;
      const idx = filtered().findIndex(function (item) { return item.id === cand.id; });
      if (idx >= 0) state.index = idx;
      savedEl.textContent = "Saved scarp on " + cand.id + ". Trace the line, then Done.";
      show();
      return;
    }
    savedEl.textContent = "Saved " + label + " on " + cand.id;
    advance();
  }

  function move(delta) {
    state.traceMode = false;
    const list = filtered();
    if (!list.length) {
      show();
      return;
    }
    state.index = Math.max(0, Math.min(list.length - 1, state.index + delta));
    show();
  }

  function enterTrace() {
    if (!requireReviewer()) return;
    state.traceMode = true;
    savedEl.textContent = "Trace mode. Tap along the scarp.";
    show();
  }

  function finishTrace() {
    const cand = current();
    if (cand && reviewerName()) {
      const entry = ensureEntry(reviewerName(), cand.id);
      entry.note = noteEl.value;
      entry.wrong_location = wrongEl.checked;
      if ((entry.trace && entry.trace.length) || entry.label) {
        if (!entry.timestamp_utc) entry.timestamp_utc = nowIso();
      }
      persist();
      savedEl.textContent = "Trace saved on " + cand.id;
    }
    move(1);
  }

  function addVertex(ev) {
    const cand = current();
    if (!cand || !state.traceMode || !requireReviewer()) return;
    const xy = eventToChip(ev);
    if (!xy) return;
    if (xy[0] < 0 || xy[1] < 0 || xy[0] > state.chipPx || xy[1] > state.chipPx) return;
    const utm = chipToUtm(xy[0], xy[1], cand);
    const entry = ensureEntry(reviewerName(), cand.id);
    entry.trace.push(utm);
    if (!entry.timestamp_utc) entry.timestamp_utc = nowIso();
    persist();
    show();
  }

  function undoPoint() {
    const cand = current();
    if (!cand || !requireReviewer()) return;
    const entry = ensureEntry(reviewerName(), cand.id);
    if (entry.trace.length) entry.trace.pop();
    persist();
    show();
  }

  function clearTrace() {
    const cand = current();
    if (!cand || !requireReviewer()) return;
    const entry = ensureEntry(reviewerName(), cand.id);
    entry.trace = [];
    persist();
    show();
  }

  function toggleWrong() {
    const cand = current();
    if (!cand || !requireReviewer()) return;
    const entry = ensureEntry(reviewerName(), cand.id);
    entry.wrong_location = !entry.wrong_location;
    wrongEl.checked = entry.wrong_location;
    persist();
  }

  function buildKeys() {
    const box = document.getElementById("keys");
    LABELS.forEach(function (label, i) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = "<kbd>" + (i + 1) + "</kbd> " + label;
      btn.title = HELP[label] || "";
      btn.addEventListener("click", function () { commit(label); });
      box.appendChild(btn);
    });
    document.getElementById("guidance").textContent = LABELS.map(function (label, i) {
      return (i + 1) + " " + label + " — " + (HELP[label] || "");
    }).join(" ");
  }

  async function loadQueue() {
    // file:// cannot fetch in Chrome (CORS). candidates.js sets window.QUEUE.
    if (location.protocol !== "file:") {
      try {
        const res = await fetch("candidates.json", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.candidates)) return data;
        }
      } catch (err) { /* use the candidates.js fallback */ }
    }
    if (window.QUEUE && Array.isArray(window.QUEUE.candidates)) return window.QUEUE;
    throw new Error("candidates.json failed and window.QUEUE is missing");
  }

  document.getElementById("mode-multi").addEventListener("click", function () {
    state.mode = "multi";
    show();
  });
  document.getElementById("mode-dir").addEventListener("click", function () {
    state.mode = "dir";
    show();
  });
  document.getElementById("toggle-trace").addEventListener("click", function () {
    state.trace = !state.trace;
    show();
  });
  document.getElementById("trace-mode").addEventListener("click", enterTrace);
  document.getElementById("undo-point").addEventListener("click", undoPoint);
  document.getElementById("clear-trace").addEventListener("click", clearTrace);
  document.getElementById("trace-done").addEventListener("click", finishTrace);
  document.getElementById("prev").addEventListener("click", function () { move(-1); });
  document.getElementById("next").addEventListener("click", function () {
    if (state.traceMode) finishTrace();
    else move(1);
  });
  document.getElementById("jump-unlabelled").addEventListener("click", function () {
    const idx = filtered().findIndex(function (cand) { return !isLabelled(cand); });
    if (idx >= 0) state.index = idx;
    state.traceMode = false;
    show();
  });
  document.getElementById("filter").addEventListener("change", function (ev) {
    state.filter = ev.target.value;
    state.index = 0;
    state.traceMode = false;
    show();
  });
  stayEl.addEventListener("change", function () { persist(); });
  wrongEl.addEventListener("change", function () {
    const cand = current();
    if (!cand || !requireReviewer()) {
      wrongEl.checked = false;
      return;
    }
    const entry = ensureEntry(reviewerName(), cand.id);
    entry.wrong_location = wrongEl.checked;
    persist();
  });
  noteEl.addEventListener("input", function () {
    const cand = current();
    if (!cand || !reviewerName()) return;
    const entry = ensureEntry(reviewerName(), cand.id);
    entry.note = noteEl.value;
    persist();
  });
  reviewerEl.addEventListener("input", function () {
    persist();
    show();
  });

  stage.addEventListener("pointerdown", function (ev) {
    if (!state.traceMode) return;
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (activePtr !== null) return;
    activePtr = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    try { stage.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
  });
  stage.addEventListener("pointerup", function (ev) {
    if (!activePtr || ev.pointerId !== activePtr.id) return;
    const start = activePtr;
    activePtr = null;
    if (!state.traceMode) return;
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (Math.hypot(dx, dy) >= TAP_PX) return;
    addVertex(ev);
  });
  stage.addEventListener("pointercancel", function (ev) {
    if (activePtr && ev.pointerId === activePtr.id) activePtr = null;
  });
  stage.addEventListener("pointermove", function (ev) {
    const cand = current();
    if (!cand) return;
    const xy = eventToChip(ev);
    if (!xy) return;
    const utm = chipToUtm(xy[0], xy[1], cand);
    document.getElementById("cursor-utm").textContent = "E " + utm[0].toFixed(1) + "   N " + utm[1].toFixed(1);
    if (state.traceMode) {
      state.cursorChip = xy;
      drawOverlay();
    }
  });
  stage.addEventListener("pointerleave", function () {
    state.cursorChip = null;
    document.getElementById("cursor-utm").textContent = "E —   N —";
    if (state.traceMode) drawOverlay();
  });
  chip.addEventListener("load", function () {
    if (chip.dataset.token === String(state.drawToken)) drawOverlay();
  });
  document.getElementById("export-csv").addEventListener("click", exportCsv);
  document.getElementById("export-geojson").addEventListener("click", exportGeoJSON);
  document.getElementById("export-json").addEventListener("click", exportBackup);
  document.getElementById("import-json").addEventListener("change", function (ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || typeof data.entries !== "object" || !data.entries) throw new Error("not a backup");
        state.store = normalizeStore(data);
        reviewerEl.value = state.store.reviewer;
        stayEl.checked = state.store.stayToTrace !== false;
        persist();
        const firstOpen = state.queue.findIndex(function (cand) { return !isLabelled(cand); });
        state.index = firstOpen >= 0 ? firstOpen : 0;
        state.traceMode = false;
        show();
        savedEl.textContent = "Imported backup.";
      } catch (err) {
        savedEl.textContent = "Import failed.";
      }
    };
    reader.readAsText(file);
  });

  document.addEventListener("keydown", function (ev) {
    if (typing() || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const key = ev.key;
    if (key >= "1" && key <= "5") {
      ev.preventDefault();
      commit(LABELS[Number(key) - 1]);
    } else if (key === "Enter") {
      if (!state.traceMode) return;
      ev.preventDefault();
      finishTrace();
    } else if (key === "n" || key === "N") {
      ev.preventDefault();
      if (state.traceMode) finishTrace();
      else move(1);
    } else if (key === "b" || key === "B") {
      move(-1);
    } else if (key === "t" || key === "T") {
      state.trace = !state.trace;
      show();
    } else if (key === "h" || key === "H") {
      state.mode = state.mode === "multi" ? "dir" : "multi";
      show();
    } else if (key === "w" || key === "W") {
      ev.preventDefault();
      toggleWrong();
    } else if (key === "r" || key === "R") {
      ev.preventDefault();
      enterTrace();
    } else if (key === "u" || key === "U") {
      ev.preventDefault();
      undoPoint();
    } else if (key === "c" || key === "C") {
      ev.preventDefault();
      clearTrace();
    }
  });

  buildKeys();
  stayEl.checked = state.store.stayToTrace !== false;
  const requested = new URLSearchParams(window.location.search).get("reviewer");
  const knownReviewer = { Andrew: 1, Donggun: 1, Walker: 1 };
  if (requested && knownReviewer[requested.trim()]) {
    reviewerEl.value = requested.trim();
    persist();
  } else if (state.store.reviewer) {
    reviewerEl.value = state.store.reviewer;
  }

  loadQueue().then(function (payload) {
    state.queue = payload.candidates || [];
    state.chipPx = Number(payload.chip_px) || 400;
    state.chipM = Number(payload.chip_m) || state.chipPx;
    state.byId = {};
    state.queue.forEach(function (cand) { state.byId[cand.id] = cand; });
    state.filter = "batch2";
    document.getElementById("filter").value = "batch2";
    const firstOpen = filtered().findIndex(function (cand) { return !isLabelled(cand); });
    state.index = firstOpen >= 0 ? firstOpen : 0;
    show();
  }).catch(function (err) {
    document.getElementById("progress").textContent = String(err);
  });
})();
