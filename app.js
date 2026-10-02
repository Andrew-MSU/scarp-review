/* Static scarp review. One task: label the line on each batch-4 chip.
   Labels stay in localStorage until CSV export. */
(function () {
  const LABELS = ["scarp","road/rail/man-made","drainage","other","unsure"];
  const DISPLAY = ["scarp","road/rail","drainage/channel","other","unsure"];
  const COLUMNS = ["candidate_id","label","reviewer","note","timestamp_utc"];
  const STORE = "scarp_review_site_v1";
  const SEP = "\u0000";

  const chip = document.getElementById("chip");
  const overlay = document.getElementById("overlay");
  const reviewerEl = document.getElementById("reviewer");
  const noteEl = document.getElementById("note");
  const savedEl = document.getElementById("saved");
  const state = {
    queue: [],
    byId: {},
    index: 0,
    chipPx: 400,
    chipM: 400,
    store: loadStore(),
    drawToken: 0
  };

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
      // A drawn line with no class was the Enter-without-1 case. That line is a scarp.
      if (Array.isArray(entry.trace) && entry.trace.length >= 2 && !entry.label) {
        entry.label = "scarp";
      }
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
    state.store.version = 1;
    // Write the whole store, including entries whose ids are not in this queue.
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
    if (!entry || !entry.label) return false;
    return LABELS.indexOf(entry.label) >= 0;
  }

  function current() {
    if (!state.queue.length) return null;
    if (state.index >= state.queue.length) state.index = state.queue.length - 1;
    if (state.index < 0) state.index = 0;
    return state.queue[state.index];
  }

  function labelledCount() {
    let k = 0;
    state.queue.forEach(function (cand) {
      if (isLabelled(cand)) k += 1;
    });
    return k;
  }

  function requireReviewer() {
    if (reviewerName()) return true;
    reviewerEl.focus();
    savedEl.textContent = "Enter your name first.";
    return false;
  }

  function typing() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return type === "text" || type === "search" || type === "number" || type === "email" || type === "";
    }
    return false;
  }

  function displayOf(label) {
    const i = LABELS.indexOf(label);
    return i >= 0 ? DISPLAY[i] : label;
  }

  function markLabel(label) {
    const buttons = document.getElementById("keys").querySelectorAll("button");
    Array.prototype.forEach.call(buttons, function (btn) {
      const on = btn.getAttribute("data-label") === label;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function drawOverlay() {
    const ctx = overlay.getContext("2d");
    const px = state.chipPx;
    const scale = px / state.chipM;
    overlay.width = px;
    overlay.height = px;
    ctx.clearRect(0, 0, px, px);
    const cand = current();
    const poly = cand && cand.trace_poly;
    if (!poly || !poly.length) return;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    poly.forEach(function (p, i) {
      const x = p[0] * scale;
      const y = p[1] * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "rgba(0,0,0,0.88)";
    ctx.lineWidth = 3.4;
    ctx.stroke();
    ctx.strokeStyle = "#f4f1ea";
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  function show() {
    const cand = current();
    const n = state.queue.length;
    const k = labelledCount();
    document.getElementById("progress").textContent = "Labelled " + k + " / " + n;
    document.getElementById("progress-bar").style.width = n ? (100 * k / n) + "%" : "0%";
    document.getElementById("position").textContent = n ? ((state.index + 1) + " of " + n) : "0 of 0";
    const entry = cand ? getEntry(reviewerName(), cand.id) : null;
    markLabel(entry && entry.label);
    if (!cand) {
      chip.removeAttribute("src");
      noteEl.value = "";
      drawOverlay();
      return;
    }
    const token = ++state.drawToken;
    const nextSrc = "chips/" + cand.chip_multi;
    chip.dataset.token = String(token);
    if (chip.getAttribute("src") !== nextSrc) chip.src = nextSrc;
    noteEl.value = entry && entry.note ? entry.note : "";
    drawOverlay();
  }

  function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
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
    const rows = [];
    Object.keys(state.store.entries).forEach(function (key) {
      const splitAt = key.indexOf(SEP);
      if (splitAt < 0) return;
      const reviewer = key.slice(0, splitAt);
      const id = key.slice(splitAt + 1);
      if (!state.byId[id]) return;
      const entry = state.store.entries[key];
      if (!entry || LABELS.indexOf(entry.label) < 0) return;
      rows.push({
        candidate_id: id,
        label: entry.label,
        reviewer: reviewer,
        note: entry.note == null ? "" : String(entry.note),
        timestamp_utc: entry.timestamp_utc == null ? "" : String(entry.timestamp_utc)
      });
    });
    rows.sort(function (a, b) {
      if (a.candidate_id < b.candidate_id) return -1;
      if (a.candidate_id > b.candidate_id) return 1;
      if (a.reviewer < b.reviewer) return -1;
      if (a.reviewer > b.reviewer) return 1;
      return 0;
    });
    const lines = [COLUMNS.join(",")];
    rows.forEach(function (row) {
      lines.push(COLUMNS.map(function (col) { return csvEscape(row[col]); }).join(","));
    });
    download("scarp_review_labels.csv", lines.join("\n") + "\n", "text/csv");
    savedEl.textContent = "Exported " + rows.length + " rows";
  }

  function advance() {
    if (!state.queue.length) {
      show();
      return;
    }
    state.index = Math.min(state.queue.length - 1, state.index + 1);
    show();
  }

  function commit(label) {
    const cand = current();
    if (!cand) return;
    if (!requireReviewer()) return;
    if (LABELS.indexOf(label) < 0) return;
    const entry = ensureEntry(reviewerName(), cand.id);
    entry.label = label;
    entry.note = noteEl.value;
    entry.timestamp_utc = nowIso();
    persist();
    savedEl.textContent = "Saved " + displayOf(label) + ".";
    advance();
  }

  function move(delta) {
    if (!state.queue.length) {
      show();
      return;
    }
    state.index = Math.max(0, Math.min(state.queue.length - 1, state.index + delta));
    show();
  }

  function buildKeys() {
    const box = document.getElementById("keys");
    LABELS.forEach(function (label, i) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-label", label);
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", (i + 1) + " " + DISPLAY[i]);
      btn.innerHTML = "<kbd>" + (i + 1) + "</kbd><span>" + DISPLAY[i] + "</span>";
      btn.addEventListener("click", function () { commit(label); });
      box.appendChild(btn);
    });
  }

  function loadQueue() {
    if (location.protocol !== "file:") {
      return fetch("candidates.json", { cache: "no-store" }).then(function (res) {
        if (!res.ok) throw new Error("not ok");
        return res.json();
      }).then(function (data) {
        if (data && Array.isArray(data.candidates)) return data;
        throw new Error("bad candidates");
      }).catch(function () {
        if (window.QUEUE && Array.isArray(window.QUEUE.candidates)) return window.QUEUE;
        throw new Error("candidates.json failed and window.QUEUE is missing");
      });
    }
    if (window.QUEUE && Array.isArray(window.QUEUE.candidates)) return Promise.resolve(window.QUEUE);
    return Promise.reject(new Error("candidates.json failed and window.QUEUE is missing"));
  }

  function firstUnlabelledIndex() {
    for (let i = 0; i < state.queue.length; i++) {
      if (!isLabelled(state.queue[i])) return i;
    }
    return 0;
  }

  document.getElementById("prev").addEventListener("click", function () { move(-1); });
  document.getElementById("next").addEventListener("click", function () { move(1); });
  document.getElementById("export-csv").addEventListener("click", exportCsv);
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
  chip.addEventListener("load", function () {
    if (chip.dataset.token === String(state.drawToken)) drawOverlay();
  });
  document.addEventListener("keydown", function (ev) {
    if (typing() || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const key = ev.key;
    if (key >= "1" && key <= "5") {
      ev.preventDefault();
      commit(LABELS[Number(key) - 1]);
    } else if (key === "n" || key === "N") {
      ev.preventDefault();
      move(1);
    } else if (key === "b" || key === "B") {
      ev.preventDefault();
      move(-1);
    }
  });

  buildKeys();
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
    state.index = firstUnlabelledIndex();
    show();
  }).catch(function (err) {
    document.getElementById("progress").textContent = String(err);
  });
})();
