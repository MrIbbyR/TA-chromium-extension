// keyword-triage-core.js — SmartRecruiters keyword search on resume + optional Move forward
// Exposes: __srKeywordTriageRun, __srKeywordTriageRunMulti, __srKeywordTriageStartQueue,
//          __srCollectApplicantClickTargets (shared with salary-triage)

(function () {
  "use strict";

  /* ── Keyword expansion table (ported from req.py KEYWORD_EXPANSIONS) ── */
  var _RD = ["research and development", "research & development", "r and d", "r&d"];
  var KEYWORD_EXPANSIONS = {
    "r&d": _RD, "r and d": _RD, "r & d": _RD,
    "ml": ["machine learning", "machine-learning"],
    "nlp": ["natural language processing", "natural-language processing"],
    "ai": ["artificial intelligence", "artificial-intelligence"],
    "dl": ["deep learning", "deep-learning"],
    "cv": ["computer vision"],
    "phd": ["ph.d", "ph.d.", "doctorate", "doctoral"],
    "ms": ["m.s", "m.s.", "master's", "masters", "msc", "m.sc"],
    "bsc": ["b.s", "b.s.", "bachelor's", "bachelors", "b.sc"],
    "iso 45001": ["iso45001", "iso-45001", "ohsms", "occupational health and safety"],
    "iso 9001": ["iso9001", "iso-9001", "quality management"],
    "nebsh": ["nebsh igc", "international general certificate"],
    "ctf": ["capture the flag", "capture-the-flag"],
    "aws": ["amazon web services"],
    "gcp": ["google cloud platform", "google cloud"],
    "api": ["application programming interface", "apis"],
  };

  var MOVE_FORWARD_ID = "st-moveForward";

  /* ── Helpers ── */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function isVisible(el, win) {
    if (!el) return false;
    var style = win.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0)
      return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isDisabledish(el) {
    if (!el) return true;
    try { if (el.disabled === true) return true; } catch (_) {}
    try {
      if (el.getAttribute && el.getAttribute("disabled") != null) return true;
      if (String(el.getAttribute && el.getAttribute("aria-disabled")).toLowerCase() === "true") return true;
    } catch (_) {}
    return false;
  }

  function walkShadow(node, visitor, visited) {
    if (!node || visited.has(node)) return;
    visited.add(node);
    visitor(node);
    if (node.childNodes && node.childNodes.length) {
      for (var i = 0; i < node.childNodes.length; i++) walkShadow(node.childNodes[i], visitor, visited);
    }
    var sr = node.shadowRoot;
    if (sr) walkShadow(sr, visitor, visited);
  }

  function queryDeepSelectorAll(root, win, selector) {
    var out = [];
    var visited = new Set();
    walkShadow(root, function (n) {
      if (n.nodeType === 1) {
        try {
          if (n.matches && n.matches(selector)) out.push(n);
          out.push.apply(out, Array.from(n.querySelectorAll(selector)));
        } catch (_) {}
      }
    }, visited);
    return out.filter(function (el, i, a) { return a.indexOf(el) === i; });
  }

  function collectClickablesDeep(root, win) {
    var sel =
      'button, [role="button"], a[href], spl-button, [class*="button"], input[type="button"], input[type="submit"]';
    var raw = queryDeepSelectorAll(root, win, sel);
    return raw.filter(function (el) { return isVisible(el, win); });
  }

  function findElementByIdDeep(root, id, visited) {
    if (!visited) visited = new Set();
    if (!root || visited.has(root)) return null;
    visited.add(root);
    if (root.nodeType === 1) {
      try {
        if (root.id === id) return root;
        if (root.getAttribute && root.getAttribute("id") === id) return root;
      } catch (_) {}
    }
    if (root.childNodes) {
      for (var i = 0; i < root.childNodes.length; i++) {
        var f = findElementByIdDeep(root.childNodes[i], id, visited);
        if (f) return f;
      }
    }
    if (root.shadowRoot) {
      var f2 = findElementByIdDeep(root.shadowRoot, id, visited);
      if (f2) return f2;
    }
    return null;
  }

  function isCandidateProfilePage(doc) {
    try {
      var p = (doc.location && doc.location.pathname) || "";
      return /\/app\/people\/(?:applications|profile)\/[^/?#]+/i.test(p);
    } catch (_) { return false; }
  }

  /* ── Keyword parsing & expansion (ported from req.py) ── */

  function parseKeywordsFromString(s) {
    if (!s || !s.trim()) return [];
    var lines = s.split(/\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.charAt(0) === "#") continue;
      var parts = line.split(/[,;]+/);
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j].trim();
        if (p) out.push(p);
      }
    }
    return out;
  }

  function canonicalizeKeywords(keywords) {
    var seenLower = {};
    var cleaned = [];
    for (var i = 0; i < keywords.length; i++) {
      var kw = (keywords[i] || "").trim();
      if (!kw) continue;
      var key = kw.toLowerCase();
      if (seenLower[key]) continue;
      seenLower[key] = true;
      cleaned.push(kw);
    }
    return cleaned;
  }

  function expandKeywords(keywords) {
    var expanded = keywords.slice();
    var expandedLower = {};
    for (var i = 0; i < expanded.length; i++) expandedLower[expanded[i].toLowerCase()] = true;
    for (var k = 0; k < keywords.length; k++) {
      var key = (keywords[k] || "").trim().toLowerCase();
      if (!key) continue;
      var forms = KEYWORD_EXPANSIONS[key];
      if (!forms) continue;
      for (var f = 0; f < forms.length; f++) {
        if (!expandedLower[forms[f].toLowerCase()]) {
          expanded.push(forms[f]);
          expandedLower[forms[f].toLowerCase()] = true;
        }
      }
    }
    return expanded;
  }

  function resolveKeywords(rawInput) {
    var parsed = parseKeywordsFromString(rawInput);
    var canon = canonicalizeKeywords(parsed);
    var expanded = expandKeywords(canon);
    return canonicalizeKeywords(expanded);
  }

  /* ── Text normalization (ported from req.py _normalize_for_kw) ── */

  function normalizeForKw(s) {
    if (!s) return "";
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
    s = s.replace(/\u00A0/g, " ").replace(/\u202F/g, " ").replace(/\u2007/g, " ");
    s = s.replace(/\s+/g, " ");
    return s.trim();
  }

  /* ── Resume text extraction from DOM (ported from req.py get_dom_resume_text) ── */

  function getResumeText(doc) {
    var root = doc.querySelector("#st-candidateView") || doc.body;
    var selectors = [
      "sr-resume-viewer",
      "sr-candidate-resume",
      "sr-resume",
      '[data-testid*="resume"]',
      '[class*="resume"]',
      '[id*="resume"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = root.querySelector(selectors[i]);
        if (!el) continue;
        var t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t.length > 200) return t;
      } catch (_) {}
    }
    return (root.innerText || root.textContent || "").trim();
  }

  function getScreeningText(doc, win) {
    var body = doc.body || doc.documentElement;
    var found = null;
    var visited = new Set();
    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 1) {
        var t = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (/screening questions/i.test(t) && t.length < 2500) {
          var el2 = node;
          for (var up = 0; up < 18 && el2; up++) {
            var tag = (el2.tagName || "").toLowerCase();
            if (tag === "section" || tag.indexOf("card") >= 0 || tag === "spl-card") {
              found = el2;
              return;
            }
            el2 = el2.parentElement;
          }
          found = node;
        }
      }
      if (node.childNodes) {
        for (var c = 0; c < node.childNodes.length; c++) walk(node.childNodes[c]);
      }
      if (node.shadowRoot) walk(node.shadowRoot);
    }
    walk(body);
    if (found) return (found.innerText || found.textContent || "").trim();
    return "";
  }

  /* ── Keyword matching (ported from req.py find_keyword_hits) ── */

  function sepFlexiblePattern(kwNorm) {
    var tokens = kwNorm.match(/[A-Za-z]+|\d+/g);
    if (!tokens || !tokens.length) return null;
    var mid = "[\\W_]*";
    var body = tokens.map(function (t) {
      return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join(mid);
    if (!body) return null;
    return new RegExp("(?<![A-Za-z0-9])" + body + "(?![A-Za-z0-9])", "gi");
  }

  function findKeywordHits(allText, keywords) {
    var hay = normalizeForKw(allText || "");
    if (!hay) return { hits: [], hitCount: 0 };
    var hayLower = hay.toLowerCase();
    var found = [];
    var seenLower = {};

    for (var i = 0; i < keywords.length; i++) {
      var kwDisp = (keywords[i] || "").trim();
      if (!kwDisp) continue;
      var kwKey = kwDisp;
      if (kwKey.charAt(0) === "(" && kwKey.charAt(kwKey.length - 1) === ")") {
        var inner = kwKey.slice(1, -1).trim();
        if (inner) kwKey = inner;
      }
      var kwNorm = normalizeForKw(kwKey);
      if (!kwNorm) continue;
      var count = 0;
      var rx = sepFlexiblePattern(kwNorm);
      if (rx) {
        var matches = hay.match(rx);
        count = matches ? matches.length : 0;
      }
      if (count === 0) {
        if (hayLower.indexOf(kwNorm.toLowerCase()) >= 0) count = 1;
      }
      if (count > 0) {
        var key = kwDisp.toLowerCase();
        if (!seenLower[key]) {
          seenLower[key] = true;
          found.push({ keyword: kwDisp, count: count });
        }
      }
    }
    return { hits: found, hitCount: found.length };
  }

  /* ── Move Forward pipeline (same as salary-triage-core.js) ── */

  function resolveMoveForwardClickTarget(doc, win, host) {
    if (!host) return null;
    var candidates = [];
    try { candidates = queryDeepSelectorAll(host, win, 'button, [role="button"], a[href]'); } catch (_) {}
    try { if (host.matches && host.matches('button, [role="button"], a[href]')) candidates.unshift(host); } catch (_) {}

    var bestForward = null;
    var bestLen = 1e9;
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (isDisabledish(el)) continue;
      if (!isVisible(el, win)) continue;
      var txt = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!/\bmove\s+forward\b/.test(txt)) continue;
      if (txt.length < bestLen) { bestLen = txt.length; bestForward = el; }
    }
    if (bestForward) return bestForward;
    for (var j = 0; j < candidates.length; j++) {
      var el2 = candidates[j];
      if (isDisabledish(el2)) continue;
      if (!isVisible(el2, win)) continue;
      var txt2 = (el2.textContent || "").replace(/\s+/g, " ").trim();
      if (txt2.length > 0 && txt2.length < 100) return el2;
    }
    try {
      if (!isDisabledish(host) && isVisible(host, win) && host.matches && host.matches('button, [role="button"], a[href]'))
        return host;
    } catch (_) {}
    return host;
  }

  function dispatchClickAtElementCenter(el, win, xBias) {
    if (!el) return;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    var bias = typeof xBias === "number" ? xBias : 0.35;
    var x = r.left + Math.max(4, Math.min(r.width * bias, r.width - 4));
    var y = r.top + r.height / 2;
    var base = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: win, button: 0 };
    try {
      if (typeof win.PointerEvent === "function") {
        el.dispatchEvent(new win.PointerEvent("pointerdown", {
          bubbles: true, cancelable: true, clientX: x, clientY: y, view: win,
          pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1,
        }));
      }
    } catch (_) {}
    try { el.dispatchEvent(new win.MouseEvent("mousedown", base)); } catch (_) {}
    try { el.dispatchEvent(new win.MouseEvent("mouseup", base)); } catch (_) {}
    try {
      if (typeof win.PointerEvent === "function") {
        el.dispatchEvent(new win.PointerEvent("pointerup", {
          bubbles: true, cancelable: true, clientX: x, clientY: y, view: win,
          pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 0,
        }));
      }
    } catch (_) {}
    try { el.dispatchEvent(new win.MouseEvent("click", base)); } catch (_) {}
  }

  function fireMoveForwardPipelineClick(win, innerBtn, host) {
    if (!innerBtn) return;
    dispatchClickAtElementCenter(innerBtn, win, 0.32);
    try { if (typeof innerBtn.click === "function") innerBtn.click(); } catch (_) {}
    if (!host || host === innerBtn) return;
    var tag = (host.tagName || "").toLowerCase();
    if (tag.indexOf("spl-") !== 0 && !host.shadowRoot) return;
    dispatchClickAtElementCenter(host, win, 0.32);
    try { if (typeof host.click === "function") host.click(); } catch (_) {}
  }

  function findMoveControl(doc, win) {
    var host = null;
    try { host = doc.getElementById(MOVE_FORWARD_ID); } catch (_) {}
    if (!host) {
      try { host = findElementByIdDeep(doc.documentElement || doc.body, MOVE_FORWARD_ID); } catch (_) {}
    }
    if (host) {
      var target = resolveMoveForwardClickTarget(doc, win, host);
      return { btn: target || host, host: host };
    }
    var clickables = collectClickablesDeep(doc.body || doc.documentElement, win);
    var bestForward = null;
    var bestForwardLen = 1e9;
    for (var i = 0; i < clickables.length; i++) {
      var el = clickables[i];
      var txt = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!txt || txt.length > 120) continue;
      if (/\bmove\s+forward\b/.test(txt)) {
        if (txt.length < bestForwardLen) { bestForwardLen = txt.length; bestForward = el; }
      }
    }
    return bestForward ? { btn: bestForward, host: null } : null;
  }

  function hasSrProfileChrome(doc) {
    var mv = null;
    try { mv = doc.getElementById(MOVE_FORWARD_ID); } catch (_) {}
    if (!mv) {
      try { mv = findElementByIdDeep(doc.documentElement || doc.body, MOVE_FORWARD_ID); } catch (_) {}
    }
    var sc = null;
    try { sc = doc.getElementById("st-screening"); } catch (_) {}
    if (!sc) {
      try { sc = findElementByIdDeep(doc.documentElement || doc.body, "st-screening"); } catch (_) {}
    }
    return !!(mv || sc);
  }

  /* ── URL / click target harvesting (shared with salary-triage) ── */

  function normalizeProfilePath(href) {
    try {
      var u = new URL(href, location.origin);
      var m = u.pathname.match(/^(\/app\/people\/(?:applications|profile)\/[^/]+)\/?/i);
      return m ? u.origin + m[1] + "/" : "";
    } catch (_) { return ""; }
  }

  function hrefFromNode(el) {
    if (!el) return "";
    try {
      var a = el.getAttribute && el.getAttribute("href");
      if (a) return a;
      if (el.href) return String(el.href);
    } catch (_) {}
    return "";
  }

  function harvestProfileUrls(doc, win) {
    var seen = new Set();
    var urls = [];
    function addRaw(raw) {
      var path = normalizeProfilePath(raw);
      if (!path || seen.has(path)) return;
      seen.add(path);
      urls.push(path);
    }
    var broadSel =
      'a[href*="/app/people/applications/"], a[href*="/app/people/profile/"], sr-link[href*="/app/people/applications/"], sr-link[href*="/app/people/profile/"]';
    function harvestSelectorList(root, useDeep) {
      var list = [];
      if (useDeep) {
        list = queryDeepSelectorAll(root, win, broadSel);
      } else {
        try { list = Array.from(root.querySelectorAll(broadSel)); } catch (_) {}
      }
      for (var i = 0; i < list.length; i++) addRaw(hrefFromNode(list[i]));
    }
    var root = doc.body || doc.documentElement;
    harvestSelectorList(root, false);
    harvestSelectorList(root, true);
    try {
      doc.querySelectorAll(
        "#st-jobDetailsPage spl-table a[href*='/app/people/'], " +
        "#st-jobDetailsPage spl-table sr-link[href*='/app/people/'], " +
        "#st-jobDetailsPage app-applicant-list-container a[href*='/app/people/'], " +
        "#st-jobDetailsPage app-applicant-list-container sr-link[href*='/app/people/'], " +
        "#st-jobDetailsPage app-people-tab-applicant-list-container a[href*='/app/people/'], " +
        "#st-jobDetailsPage people-tab-container a[href*='/app/people/']"
      ).forEach(function (n) { addRaw(hrefFromNode(n)); });
    } catch (_) {}
    var nameHosts = new Set();
    try {
      doc.querySelectorAll('[data-test="applicant-name"], spl-truncate.applicant-name--name-truncate').forEach(function (n) { nameHosts.add(n); });
    } catch (_) {}
    try {
      queryDeepSelectorAll(root, win, '[data-test="applicant-name"]').forEach(function (n) { nameHosts.add(n); });
    } catch (_) {}
    nameHosts.forEach(function (host) {
      var el = host;
      for (var up = 0; up < 24 && el; up++) {
        var tag = (el.tagName || "").toUpperCase();
        if (tag === "A" || tag === "SR-LINK") { addRaw(hrefFromNode(el)); break; }
        try {
          var inner = el.querySelector && el.querySelector(broadSel);
          if (inner) { addRaw(hrefFromNode(inner)); break; }
        } catch (_) {}
        el = el.parentElement;
      }
      var row = null;
      try { row = host.closest && host.closest("tr"); } catch (_) {}
      if (!row) { try { row = host.closest && host.closest('[role="row"]'); } catch (_) {} }
      if (row) { try { row.querySelectorAll(broadSel).forEach(function (n) { addRaw(hrefFromNode(n)); }); } catch (_) {} }
    });
    return urls;
  }

  function resolveApplicantClickTarget(host) {
    if (!host) return null;
    try {
      var inJobList = host.closest && host.closest("#st-jobDetailsPage");
      if (inJobList) {
        var directA = host.closest && host.closest("a[href*='/app/people/']");
        if (directA) return directA;
      }
    } catch (_) {}
    try {
      var cell = host.closest && (host.closest("td") || host.closest('[role="gridcell"]'));
      if (cell) {
        var a = cell.querySelector('a[href*="/app/people/"], sr-link[href*="/app/people/"], a[href^="/app/people/"]');
        if (a) return a;
      }
    } catch (_) {}
    var el = host;
    for (var up = 0; up < 32 && el; up++) {
      var tag = (el.tagName || "").toUpperCase();
      if (tag === "A" || tag === "SR-LINK") return el;
      var role = String((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
      if (role === "link" || role === "button") return el;
      el = el.parentElement;
    }
    return host;
  }

  function collectApplicantClickTargets(doc, win) {
    var out = [];
    var seenClickEl = new Set();
    var seenRow = new WeakSet();
    var seenHost = new Set();
    function rowKeyForSplTable(host) {
      var el = host;
      for (var i = 0; i < 28 && el; i++) {
        var p = el.parentElement;
        if (!p) break;
        if ((p.tagName || "").toLowerCase() === "spl-table") return el;
        el = p;
      }
      return null;
    }
    function markRowAndPush(el, rowHint) {
      if (!el || seenClickEl.has(el)) return;
      if (rowHint) { if (seenRow.has(rowHint)) return; seenRow.add(rowHint); }
      seenClickEl.add(el);
      out.push(el);
    }
    try {
      doc.querySelectorAll(
        "#st-jobDetailsPage spl-table a[href*='/app/people/applications/'], " +
        "#st-jobDetailsPage spl-table a[href*='/app/people/profile/'], " +
        "#st-jobDetailsPage spl-table sr-link[href*='/app/people/'], " +
        "#st-jobDetailsPage app-applicant-list-container a[href*='/app/people/'], " +
        "#st-jobDetailsPage app-applicant-list-container sr-link[href*='/app/people/'], " +
        "#st-jobDetailsPage app-people-tab-applicant-list-container a[href*='/app/people/'], " +
        "#st-jobDetailsPage app-people-tab-applicant-list-container sr-link[href*='/app/people/'], " +
        "#st-jobDetailsPage people-tab-container a[href*='/app/people/'], " +
        "#st-jobDetailsPage people-tab-container sr-link[href*='/app/people/']"
      ).forEach(function (linkEl) {
        var underTable = linkEl.closest && linkEl.closest("spl-table");
        var rowHint = underTable && linkEl.parentElement
          ? linkEl.parentElement
          : linkEl.closest("tr") || linkEl.closest('[role="row"]');
        markRowAndPush(linkEl, rowHint || linkEl);
      });
    } catch (_) {}
    function considerHost(host) {
      if (!host || seenHost.has(host)) return;
      seenHost.add(host);
      var row = null;
      try { row = host.closest && (host.closest("tr") || host.closest('[role="row"]')); } catch (_) {}
      if (!row) { try { row = rowKeyForSplTable(host); } catch (_) {} }
      if (row) { if (seenRow.has(row)) return; seenRow.add(row); }
      var target = resolveApplicantClickTarget(host);
      if (!target || seenClickEl.has(target)) return;
      seenClickEl.add(target);
      out.push(target);
    }
    var root = doc.body || doc.documentElement;
    try { doc.querySelectorAll('[data-test="applicant-name"], spl-truncate.applicant-name--name-truncate').forEach(considerHost); } catch (_) {}
    try { queryDeepSelectorAll(root, win, '[data-test="applicant-name"]').forEach(considerHost); } catch (_) {}
    try {
      doc.querySelectorAll(
        "#st-jobDetailsPage app-applicant-list-container spl-typography-title spl-truncate, " +
        "#st-jobDetailsPage app-people-tab-applicant-list-container spl-typography-title spl-truncate, " +
        "#st-jobDetailsPage people-tab-container spl-typography-title spl-truncate, " +
        "#st-jobDetailsPage spl-table spl-typography-title spl-truncate"
      ).forEach(considerHost);
    } catch (_) {}
    return out;
  }

  function fireClick(win, el) {
    if (!el) return;
    try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
    try { el.click(); } catch (_) {
      try {
        var r = el.getBoundingClientRect();
        el.dispatchEvent(
          new win.MouseEvent("click", { bubbles: true, cancelable: true, clientX: r.left + Math.min(r.width / 2, 80), clientY: r.top + Math.min(r.height / 2, 20), view: win })
        );
      } catch (_) {}
    }
  }

  /* ── Core: run keyword triage on a single profile page ── */

  async function runKeywordTriageWithDoc(doc, win, config, options) {
    options = options || {};
    var log = [];
    var subframeTriage = !!options.subframeTriage;

    if (!isCandidateProfilePage(doc) && !subframeTriage) {
      log.push({ ok: false, msg: "Wrong page — open a candidate profile from Applicants." });
      return { log: log, moved: false, skipped: true, matchedKeywords: [], hitCount: 0 };
    }

    var keywords = resolveKeywords(config.keywords || "");
    var minHits = Math.max(1, parseInt(config.minHits, 10) || 2);
    var dryRun = !!config.dryRun;

    if (!keywords.length) {
      log.push({ ok: false, msg: "No keywords provided." });
      return { log: log, moved: false, skipped: true, matchedKeywords: [], hitCount: 0 };
    }

    log.push({ ok: true, msg: "Keywords (" + keywords.length + "): " + keywords.slice(0, 8).join(", ") + (keywords.length > 8 ? "..." : "") });
    log.push({ ok: true, msg: "Min hits to move forward: " + minHits });

    var resumeWaitMs = Math.max(1500, parseInt(config.resumeWaitMs, 10) || 3000);
    await sleep(resumeWaitMs);

    var resumeText = "";
    try { resumeText = getResumeText(doc); } catch (e) {
      log.push({ ok: false, msg: "Failed to extract resume text: " + (e && e.message) });
    }
    var screeningText = "";
    try { screeningText = getScreeningText(doc, win); } catch (_) {}

    var allText = (resumeText + " " + screeningText).trim();
    var textLen = allText.length;
    log.push({ ok: true, msg: "Text extracted: " + textLen + " chars (resume: " + resumeText.length + ", screening: " + screeningText.length + ")" });

    if (textLen < 50) {
      log.push({ ok: false, msg: "Very little text found on page — resume may not have loaded." });
      return { log: log, moved: false, skipped: true, matchedKeywords: [], hitCount: 0 };
    }

    var result = findKeywordHits(allText, keywords);
    var hitLabels = result.hits.map(function (h) {
      return h.count > 1 ? h.keyword + " (x" + h.count + ")" : h.keyword;
    });

    log.push({ ok: true, msg: "Matched " + result.hitCount + "/" + keywords.length + " keywords: " + (hitLabels.length ? hitLabels.join(", ") : "(none)") });

    if (result.hitCount < minHits) {
      log.push({ ok: false, msg: "Below threshold (" + result.hitCount + " < " + minHits + ") — skip" });
      return { log: log, moved: false, skipped: false, matchedKeywords: hitLabels, hitCount: result.hitCount };
    }

    log.push({ ok: true, msg: "Meets threshold — proceeding to Move forward" });

    if (dryRun) {
      log.push({ ok: true, msg: "Dry run: would click Move forward (skipped)" });
      return { log: log, moved: false, skipped: false, matchedKeywords: hitLabels, hitCount: result.hitCount };
    }

    var moveReadyMs = Math.max(800, parseInt(config.moveButtonReadyMs, 10) || 4500);
    var moveSettleMs = Math.max(400, parseInt(config.moveSettleMs, 10) || 1800);
    var step = 200;

    var moveCtrl = null;
    for (var elapsed = 0; elapsed < moveReadyMs; elapsed += step) {
      moveCtrl = findMoveControl(doc, win);
      if (moveCtrl && moveCtrl.btn && isVisible(moveCtrl.btn, win) && !isDisabledish(moveCtrl.btn)) break;
      moveCtrl = null;
      await sleep(step);
    }

    if (!moveCtrl || !moveCtrl.btn) {
      log.push({ ok: false, msg: "Move forward button not found." });
      return { log: log, moved: false, skipped: false, matchedKeywords: hitLabels, hitCount: result.hitCount };
    }
    if (isDisabledish(moveCtrl.btn)) {
      log.push({ ok: false, msg: "Move forward appears disabled — skipped." });
      return { log: log, moved: false, skipped: false, matchedKeywords: hitLabels, hitCount: result.hitCount };
    }

    try { moveCtrl.btn.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
    await sleep(200);
    try { moveCtrl.btn.focus && moveCtrl.btn.focus(); } catch (_) {}
    await sleep(60);
    fireMoveForwardPipelineClick(win, moveCtrl.btn, moveCtrl.host);
    log.push({ ok: true, msg: "Clicked Move forward" });
    await sleep(moveSettleMs);

    return { log: log, moved: true, skipped: false, matchedKeywords: hitLabels, hitCount: result.hitCount };
  }

  async function runKeywordTriageMultiFrame(config) {
    var cfg = config || {};
    var frames = [window];
    try {
      var iframes = document.querySelectorAll("iframe");
      for (var i = 0; i < iframes.length; i++) {
        try { var w = iframes[i].contentWindow; if (w && w !== window) frames.push(w); } catch (_) {}
      }
    } catch (_) {}

    for (var j = 0; j < frames.length; j++) {
      var w2 = frames[j];
      var doc = null;
      try { doc = w2.document; } catch (_) { continue; }
      if (!doc || !doc.documentElement) continue;
      var isTop = w2 === w2.top;
      if (isTop && !isCandidateProfilePage(doc)) continue;
      if (!hasSrProfileChrome(doc)) continue;
      return await runKeywordTriageWithDoc(doc, w2, cfg, { subframeTriage: !isTop });
    }

    return {
      log: [{ ok: false, msg: "No frame had SR controls. Reload and try again." }],
      moved: false, skipped: true, matchedKeywords: [], hitCount: 0,
    };
  }

  async function runKeywordTriage(config) {
    return runKeywordTriageWithDoc(document, window, config || {}, {});
  }

  /* ── Queue bootstrap ── */

  function startQueueFromPage(config) {
    var doc = document;
    var win = window;
    var log = [];
    var KEY = "sr_ext_keyword_triage_v1";
    var resumeWaitMs = Math.max(1500, parseInt(config.resumeWaitMs, 10) || 3000);
    var moveSettleMs = Math.max(400, parseInt(config.moveSettleMs, 10) || 1800);
    var afterMoveNavigateMs = Math.max(500, parseInt(config.afterMoveNavigateMs, 10) || 1600);
    var moveButtonReadyMs = Math.max(800, parseInt(config.moveButtonReadyMs, 10) || 4500);
    var queueReadyMaxMs = Math.max(2000, parseInt(config.queueReadyMaxMs, 10) || 16000);
    var baseState = {
      returnUrl: win.location.href,
      initialDelayMs: Math.max(400, resumeWaitMs),
      config: {
        keywords: config.keywords,
        minHits: config.minHits,
        dryRun: config.dryRun,
        resumeWaitMs: resumeWaitMs,
        moveSettleMs: moveSettleMs,
        afterMoveNavigateMs: afterMoveNavigateMs,
        moveButtonReadyMs: moveButtonReadyMs,
        queueReadyMaxMs: queueReadyMaxMs,
      },
      log: [],
      results: [],
      startedAt: Date.now(),
    };

    var urls = harvestProfileUrls(doc, win);
    if (urls.length) {
      var state = Object.assign({}, baseState, { kind: "urls", queue: urls.slice() });
      try {
        sessionStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        log.push({ ok: false, msg: "sessionStorage failed: " + (e && e.message) });
        return { ok: false, log: log, queued: 0 };
      }
      log.push({ ok: true, msg: "Queued " + urls.length + " profiles (URL list)" });
      win.location.replace(state.queue[0]);
      return { ok: true, log: log, queued: urls.length, mode: "urls" };
    }

    var targets = collectApplicantClickTargets(doc, win);
    if (!targets.length) {
      log.push({ ok: false, msg: "No applicant rows found — open Applicants, scroll to load names, then try again." });
      return { ok: false, log: log, queued: 0 };
    }

    var state2 = Object.assign({}, baseState, { kind: "click", clickIndex: 0, total: targets.length });
    try {
      sessionStorage.setItem(KEY, JSON.stringify(state2));
    } catch (e) {
      log.push({ ok: false, msg: "sessionStorage failed: " + (e && e.message) });
      return { ok: false, log: log, queued: 0 };
    }
    log.push({ ok: true, msg: "Queued " + targets.length + " applicants (click names)" });
    fireClick(win, targets[0]);
    return { ok: true, log: log, queued: targets.length, mode: "click" };
  }

  /* ── Exports ── */

  globalThis.__srKeywordTriageRun = function (config) {
    return runKeywordTriage(config || {});
  };
  globalThis.__srKeywordTriageRunMulti = function (config) {
    return runKeywordTriageMultiFrame(config || {});
  };
  globalThis.__srKeywordTriageStartQueue = function (config) {
    return startQueueFromPage(config || {});
  };
  if (typeof globalThis.__srCollectApplicantClickTargets !== "function") {
    globalThis.__srCollectApplicantClickTargets = function () {
      return collectApplicantClickTargets(document, window);
    };
  }
})();
