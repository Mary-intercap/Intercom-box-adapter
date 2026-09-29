/**
 * The dashboard page.
 *
 * One self-contained HTML document: no build step, no framework, no CDN, no
 * runtime dependencies. It polls `/api/requests` and renders the result.
 *
 * Security note: every value that originated with a customer is written with
 * `textContent`, never `innerHTML`. A support message containing markup is
 * displayed as text and cannot execute.
 */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>box support triage</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --border: #e3e6ea;
    --text: #12161c;
    --muted: #666f7d;
    --accent: #3d5afe;
    --crit: #c0263c;  --crit-bg: #fdecef;
    --high: #b25000;  --high-bg: #fdf0e4;
    --med:  #8a6400;  --med-bg:  #fbf5e0;
    --low:  #2f7a4a;  --low-bg:  #eaf6ee;
    --warn: #8a5a00;  --warn-bg: #fcf3e2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1216; --panel: #171b21; --border: #2a303a;
      --text: #e8ebef; --muted: #98a2b1; --accent: #8fa2ff;
      --crit: #ff8d9f; --crit-bg: #2e1419;
      --high: #ffb36b; --high-bg: #2c1d10;
      --med:  #ecd07a; --med-bg:  #29230f;
      --low:  #7fd6a0; --low-bg:  #10251a;
      --warn: #ecc07a; --warn-bg: #2a2110;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 0 16px calc(48px + env(safe-area-inset-bottom, 0px));
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  header { padding: 28px 0 16px; }
  h1 { margin: 0 0 4px; font-size: 19px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; }
  .live { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--low); }
  .dot.paused { background: var(--muted); }

  .stats { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
  .stat {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 14px; min-width: 92px;
  }
  .stat b { display: block; font-size: 20px; font-weight: 650; letter-spacing: -0.02em; }
  .stat span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }

  .bar {
    position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5;
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    background: var(--bg); padding: 10px 0; border-bottom: 1px solid var(--border);
  }
  select, input[type=search], button {
    font: inherit; color: var(--text); background: var(--panel);
    border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px;
  }
  input[type=search] { flex: 1 1 180px; min-width: 0; }
  button { cursor: pointer; }
  button:hover { border-color: var(--accent); }
  label.chk { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }

  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px; margin: 12px 0;
  }
  .card.degraded { border-color: var(--warn); }
  .card-top { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
  .badge {
    font-size: 11px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 5px;
  }
  .p-critical { color: var(--crit); background: var(--crit-bg); }
  .p-high     { color: var(--high); background: var(--high-bg); }
  .p-medium   { color: var(--med);  background: var(--med-bg); }
  .p-low      { color: var(--low);  background: var(--low-bg); }
  .p-none     { color: var(--warn); background: var(--warn-bg); }
  .cat { font-weight: 600; }
  .spacer { flex: 1; }
  .when, .conf { color: var(--muted); font-size: 12px; }

  .who { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
  .who b { color: var(--text); font-weight: 600; }
  blockquote {
    margin: 0 0 12px; padding: 10px 12px; border-left: 3px solid var(--border);
    background: color-mix(in srgb, var(--bg) 60%, transparent);
    border-radius: 0 6px 6px 0; white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .field { margin-bottom: 10px; }
  .field > .k {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--muted); margin-bottom: 3px;
  }
  .field > .v { overflow-wrap: anywhere; }
  .ai::before { content: "AI "; color: var(--muted); }
  .foot { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 12px; }
  a.open { color: var(--accent); text-decoration: none; font-weight: 600; }
  a.open:hover { text-decoration: underline; }
  .ids { color: var(--muted); font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .note {
    color: var(--muted); font-size: 12px; margin: 20px 0;
    border-top: 1px solid var(--border); padding-top: 14px;
  }
  .empty { text-align: center; color: var(--muted); padding: 56px 16px; }
  .hidden-note { color: var(--muted); font-size: 12px; padding: 8px 2px; }
  .corrected {
    font-size: 11px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--accent); border: 1px solid var(--accent); border-radius: 5px; padding: 2px 7px;
  }
  .was { color: var(--muted); font-size: 12px; font-style: italic; }
  .edit {
    margin-top: 12px; padding: 12px; border: 1px dashed var(--border); border-radius: 8px;
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  }
  .edit label { color: var(--muted); font-size: 12px; }
  .link-btn {
    background: none; border: none; padding: 0; color: var(--accent);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  .link-btn:hover { text-decoration: underline; }
  .save { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
  .dates { color: var(--muted); font-size: 11px; margin-top: 6px; }
  .dates span { margin-right: 14px; white-space: nowrap; }
  .err { color: var(--crit); background: var(--crit-bg); padding: 10px 14px; border-radius: 8px; margin: 12px 0; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>box support triage</h1>
    <div class="sub">
      AI-classified Intercom conversations ·
      <span class="live"><span class="dot" id="dot"></span><span id="liveText">live</span></span>
    </div>
  </header>

  <div class="stats" id="stats"></div>
  <div id="error"></div>

  <div class="bar">
    <select id="fPriority">
      <option value="">All priorities</option>
      <option value="critical">Critical</option>
      <option value="high">High</option>
      <option value="medium">Medium</option>
      <option value="low">Low</option>
      <option value="__degraded">Unclassified</option>
    </select>
    <select id="fCategory"><option value="">All categories</option></select>
    <input type="search" id="fSearch" placeholder="Search messages and summaries…">
    <label class="chk"><input type="checkbox" id="fAction"> Action required</label>
    <select id="fSort" title="Sort by">
      <option value="priority">Sorted: priority</option>
      <option value="processedAt">Sorted: triaged</option>
      <option value="createdAt">Sorted: message received</option>
      <option value="conversationCreatedAt">Sorted: conversation opened</option>
      <option value="lastResponseAt">Sorted: last response</option>
    </select>
    <button id="fDir" title="Toggle sort direction" data-dir="desc">Newest first ↓</button>
    <button id="pause">Pause</button>
  </div>

  <div id="list"></div>

  <p class="note">
    Category, priority, confidence, summary and suggested response are generated by AI from the
    customer's message alone. They are <strong>not verified facts</strong> — no system has been
    checked. Nothing here has been sent to any customer.
  </p>
</div>

<script>
(function () {
  "use strict";

  // If the dashboard is token-protected, the token arrives once in the URL and
  // is kept for this tab only. It is removed from the address bar so it does
  // not end up in screenshots or browser history.
  var token = new URL(location.href).searchParams.get("token");
  if (token) {
    try { sessionStorage.setItem("dashboardToken", token); } catch (e) { /* private mode */ }
    history.replaceState(null, "", location.pathname);
  } else {
    try { token = sessionStorage.getItem("dashboardToken"); } catch (e) { token = null; }
  }

  var CATEGORY_LABELS = {
    dns: "DNS", domain_registration: "Domain registration", billing: "Billing",
    account: "Account", technical_issue: "Technical issue", feature_request: "Feature request",
    security: "Security", abuse: "Abuse", general: "General",
    not_support: "Not support", misdirected: "Misdirected", other: "Other"
  };

  var state = { records: [], stats: null, paused: false };
  var el = function (id) { return document.getElementById(id); };

  function node(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    // textContent, never innerHTML: customer text is untrusted and must never
    // be parsed as markup.
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  // A human correction wins over the model everywhere - list, filters, cards.
  // The model's original answer stays on the record so the two can be compared.
  function effCategory(r) {
    return (r.override && r.override.category) || (r.result && r.result.category) || null;
  }
  function effPriority(r) {
    return (r.override && r.override.priority) || (r.result && r.result.priority) || null;
  }
  function wasCorrected(r) {
    if (!r.override) return false;
    var cat = r.override.category && r.result && r.override.category !== r.result.category;
    var pri = r.override.priority && r.result && r.override.priority !== r.result.priority;
    return !!(cat || pri || (r.override.category && !r.result));
  }

  function relativeTime(iso) {
    var then = Date.parse(iso);
    if (isNaN(then)) return "";
    var secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) return secs + "s ago";
    if (secs < 3600) return Math.round(secs / 60) + "m ago";
    if (secs < 86400) return Math.round(secs / 3600) + "h ago";
    return Math.round(secs / 86400) + "d ago";
  }

  function renderStats() {
    var wrap = el("stats");
    wrap.textContent = "";
    var s = state.stats;
    if (!s) return;
    var tiles = [
      ["Total", s.total],
      ["Action needed", s.actionRequired],
      ["Critical", s.byPriority.critical],
      ["High", s.byPriority.high],
      ["Unclassified", s.degraded],
      ["Corrected", s.corrected]
    ];
    tiles.forEach(function (t) {
      var d = node("div", "stat");
      d.appendChild(node("b", null, t[1]));
      d.appendChild(node("span", null, t[0]));
      wrap.appendChild(d);
    });
  }

  function syncCategoryOptions() {
    var sel = el("fCategory");
    var seen = {};
    state.records.forEach(function (r) { var c = effCategory(r); if (c) seen[c] = true; });
    var wanted = Object.keys(seen).sort();
    if (sel.dataset.keys === wanted.join(",")) return;
    sel.dataset.keys = wanted.join(",");
    var current = sel.value;
    sel.textContent = "";
    sel.appendChild(node("option", null, "All categories"));
    sel.firstChild.value = "";
    wanted.forEach(function (key) {
      var o = node("option", null, CATEGORY_LABELS[key] || key);
      o.value = key;
      sel.appendChild(o);
    });
    sel.value = current;
  }

  function matches(r) {
    var priority = el("fPriority").value;
    if (priority === "__degraded") { if (effPriority(r)) return false; }
    else if (priority && effPriority(r) !== priority) return false;

    var category = el("fCategory").value;
    if (category && effCategory(r) !== category) return false;

    if (el("fAction").checked && !(r.result && r.result.actionRequired)) return false;

    var q = el("fSearch").value.trim().toLowerCase();
    if (q) {
      var hay = [
        r.request.message,
        effCategory(r) || "",
        r.result ? r.result.summary : "",
        r.result ? r.result.suggestedResponse : "",
        r.request.customer ? (r.request.customer.email || "") : "",
        r.request.customer ? (r.request.customer.name || "") : ""
      ].join(" ").toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  var SORT_LABELS = {
    priority: "priority",
    processedAt: "triaged",
    createdAt: "message received",
    conversationCreatedAt: "conversation opened",
    lastResponseAt: "last response"
  };

  var PRIORITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

  function sortValue(r, key) {
    if (key === "priority") {
      // Ordinal, not a date - and it follows a human correction like
      // everything else does.
      var p = effPriority(r);
      return p ? PRIORITY_RANK[p] || null : null;
    }
    var raw = key === "processedAt" ? r.processedAt : r.request[key];
    var t = raw ? Date.parse(raw) : NaN;
    return isNaN(t) ? null : t;
  }

  function sortRecords(list) {
    var key = el("fSort").value;
    var descending = el("fDir").dataset.dir === "desc";
    return list.slice().sort(function (a, b) {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      // Records with no such value sort last in both directions - "never
      // answered" and "never classified" are real states, not zero.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av !== bv) return descending ? bv - av : av - bv;
      // Only four priority values, so ties are the norm rather than the
      // exception. Break them by most recently triaged so the order inside a
      // band is meaningful instead of arbitrary.
      return Date.parse(b.processedAt) - Date.parse(a.processedAt);
    });
  }

  // "Newest first" is wrong for an ordinal like priority.
  var DIR_LABELS = {
    priority: { desc: "Highest first ↓", asc: "Lowest first ↑" },
    date: { desc: "Newest first ↓", asc: "Oldest first ↑" }
  };

  function dirLabel() {
    var set = el("fSort").value === "priority" ? DIR_LABELS.priority : DIR_LABELS.date;
    return set[el("fDir").dataset.dir === "desc" ? "desc" : "asc"];
  }

  function updateDirLabel() {
    el("fDir").textContent = dirLabel();
  }

  function field(label, value, isAi) {
    var f = node("div", "field");
    f.appendChild(node("div", isAi ? "k ai" : "k", label));
    f.appendChild(node("div", "v", value));
    return f;
  }

  function card(r) {
    var cat = effCategory(r);
    var pri = effPriority(r);
    var corrected = wasCorrected(r);
    var degraded = !cat;
    var c = node("div", "card" + (degraded ? " degraded" : ""));

    var top = node("div", "card-top");
    top.appendChild(node("span", "badge p-" + (degraded ? "none" : pri),
      degraded ? "Unclassified" : pri));
    if (!degraded) {
      top.appendChild(node("span", "cat", CATEGORY_LABELS[cat] || cat));
    }
    if (corrected) top.appendChild(node("span", "corrected", "corrected"));
    top.appendChild(node("span", "spacer"));
    // Confidence describes the model's answer, so it is meaningless once a
    // human has overruled it.
    if (!degraded && !corrected && r.result) {
      top.appendChild(node("span", "conf", Math.round(r.result.confidence * 100) + "% confidence"));
    }
    var when = node("span", "when", relativeTime(r.processedAt));
    when.title = r.processedAt;
    top.appendChild(when);
    c.appendChild(top);

    var cust = r.request.customer || {};
    var who = node("div", "who");
    who.appendChild(document.createTextNode("From "));
    who.appendChild(node("b", null, cust.email || cust.name || cust.id || "unidentified customer"));
    if (cust.email && cust.name) who.appendChild(document.createTextNode(" (" + cust.name + ")"));
    c.appendChild(who);

    c.appendChild(node("blockquote", null, r.request.message));

    if (corrected && r.result) {
      var was = node("div", "was");
      was.textContent = "AI originally said: " +
        (CATEGORY_LABELS[r.result.category] || r.result.category) + " / " + r.result.priority +
        " (" + Math.round(r.result.confidence * 100) + "% confidence)";
      c.appendChild(was);
    }

    if (!r.result) {
      c.appendChild(field("triage unavailable — review manually",
        "Reason: " + (r.degradedReason || "unknown"), false));
    } else {
      c.appendChild(field("summary", r.result.summary, true));
      c.appendChild(field("assessment",
        r.result.actionRequired ? "Human attention required" : "No action appears required", true));
      if (r.result.reasoningSummary) c.appendChild(field("reasoning", r.result.reasoningSummary, true));
      c.appendChild(field("suggested response (draft — not sent)", r.result.suggestedResponse, true));
    }

    c.appendChild(editor(r, cat, pri));

    var dates = node("div", "dates");
    [
      ["opened", r.request.conversationCreatedAt],
      ["message", r.request.createdAt],
      ["last reply", r.request.lastResponseAt || null],
      ["triaged", r.processedAt]
    ].forEach(function (pair) {
      if (pair[0] === "last reply" && !pair[1]) {
        dates.appendChild(node("span", null, "last reply: never"));
        return;
      }
      if (!pair[1]) return;
      var sp = node("span", null, pair[0] + ": " + relativeTime(pair[1]));
      sp.title = pair[1];
      dates.appendChild(sp);
    });
    c.appendChild(dates);

    var foot = node("div", "foot");
    if (r.request.intercomUrl) {
      var a = node("a", "open", "Open in Intercom ↗");
      a.href = r.request.intercomUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      foot.appendChild(a);
    }
    foot.appendChild(node("span", "ids", "conv " + r.request.conversationId + " · evt " + r.request.eventId));
    c.appendChild(foot);

    return c;
  }

  var PRIORITIES = ["low", "medium", "high", "critical"];

  function selectOf(options, current, labels) {
    var sel = document.createElement("select");
    options.forEach(function (value) {
      var o = node("option", null, labels ? labels[value] || value : value);
      o.value = value;
      sel.appendChild(o);
    });
    if (current) sel.value = current;
    return sel;
  }

  /** Inline reclassification. Collapsed until asked for, so cards stay scannable. */
  function editor(r, currentCategory, currentPriority) {
    var wrap = node("div");
    var open = node("button", "link-btn", "Reclassify");
    var form = node("div", "edit");
    form.hidden = true;

    var catSel = selectOf(Object.keys(CATEGORY_LABELS), currentCategory, CATEGORY_LABELS);
    var priSel = selectOf(PRIORITIES, currentPriority);
    var save = node("button", "save", "Save");
    var cancel = node("button", null, "Cancel");
    var status = node("span", "was");

    form.appendChild(node("label", null, "Category"));
    form.appendChild(catSel);
    form.appendChild(node("label", null, "Priority"));
    form.appendChild(priSel);
    form.appendChild(save);
    form.appendChild(cancel);
    form.appendChild(status);

    open.addEventListener("click", function () {
      form.hidden = !form.hidden;
      open.textContent = form.hidden ? "Reclassify" : "Close";
    });
    cancel.addEventListener("click", function () {
      form.hidden = true;
      open.textContent = "Reclassify";
    });

    save.addEventListener("click", function () {
      save.disabled = true;
      status.textContent = "Saving…";
      var headers = { "content-type": "application/json" };
      // Writes require the bearer header; a query token is deliberately not
      // accepted by the server.
      if (token) headers.Authorization = "Bearer " + token;

      fetch("api/requests/" + encodeURIComponent(r.request.eventId), {
        method: "PATCH",
        headers: headers,
        body: JSON.stringify({ category: catSel.value, priority: priSel.value })
      })
        .then(function (res) {
          if (res.status === 404) throw new Error("This record is no longer stored.");
          if (res.status === 401) throw new Error("Unauthorized.");
          if (!res.ok) throw new Error("Save failed (HTTP " + res.status + ").");
          return refresh();
        })
        .catch(function (e) {
          save.disabled = false;
          status.textContent = e.message;
        });
    });

    wrap.appendChild(open);
    wrap.appendChild(form);
    return wrap;
  }

  function render() {
    updateDirLabel();
    renderStats();
    syncCategoryOptions();
    var list = el("list");
    list.textContent = "";

    if (state.records.length === 0) {
      list.appendChild(node("div", "empty",
        "No conversations triaged yet. Run: npm run seed"));
      return;
    }

    var shown = sortRecords(state.records.filter(matches));

    if (shown.length === 0) {
      list.appendChild(node("div", "empty", "No requests match these filters."));
      return;
    }

    var hidden = state.records.length - shown.length;
    var suffix = " · sorted by " + SORT_LABELS[el("fSort").value] +
      ", " + dirLabel().replace(/ [↓↑]$/, "").toLowerCase();
    list.appendChild(node("div", "hidden-note",
      (hidden > 0 ? hidden + " of " + state.records.length + " hidden by the filters above"
                  : shown.length + " shown") + suffix));

    shown.forEach(function (r) { list.appendChild(card(r)); });
  }

  function showError(message) {
    var box = el("error");
    box.textContent = "";
    if (message) box.appendChild(node("div", "err", message));
  }

  function refresh() {
    if (state.paused) return Promise.resolve();
    var headers = token ? { Authorization: "Bearer " + token } : {};
    return fetch("api/requests", { headers: headers })
      .then(function (res) {
        if (res.status === 401) throw new Error("Unauthorized — open this page with ?token=… appended.");
        if (!res.ok) throw new Error("Request failed with HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        state.records = data.records || [];
        state.stats = data.stats || null;
        showError(null);
        render();
      })
      .catch(function (e) { showError(e.message); });
  }

  ["fPriority", "fCategory", "fSearch", "fAction", "fSort"].forEach(function (id) {
    el(id).addEventListener("input", render);
  });

  el("fDir").addEventListener("click", function () {
    this.dataset.dir = this.dataset.dir === "desc" ? "asc" : "desc";
    render();
  });

  el("pause").addEventListener("click", function () {
    state.paused = !state.paused;
    this.textContent = state.paused ? "Resume" : "Pause";
    el("dot").className = state.paused ? "dot paused" : "dot";
    el("liveText").textContent = state.paused ? "paused" : "live";
    if (!state.paused) refresh();
  });

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
