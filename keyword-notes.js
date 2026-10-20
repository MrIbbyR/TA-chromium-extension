// keyword-notes.js — keyword search: builds the keyword note and posts it as a "Note to self".
// One of the keyword-*.js modules that keyword-triage-core.js runs. They share the
// globalThis.__srKw namespace (require() under Node) and load in dependency order:
// dom → matching → extract → pipeline → notes → diag → core.

(function () {
  "use strict";

  // SmartRecruiters selectors and element ids live in sr-selectors.js, which loads first.
  var SR = globalThis.__SR || (typeof require === "function" ? require("./sr-selectors.js").SR : null);
  if (!SR) throw new Error("sr-selectors.js must load before keyword-notes.js");

  // Node: require(). Browser: modules loaded earlier put their exports on
  // globalThis.__srKw; a missing name means a loader got the order wrong.
  function need(file, names) {
    var mod = typeof module !== "undefined" && module.exports ? require("./" + file) : globalThis.__srKw || {};
    names.forEach(function (n) {
      if (mod[n] === undefined) throw new Error(n + " missing: load " + file + " before keyword-notes.js");
    });
    return mod;
  }
  var domMod = need("keyword-dom.js", [
    "sleep", "isVisible", "isDisabledish", "queryDeepSelectorAll", "findElementByIdDeep",
    "dispatchClickAtElementCenter", "getDeepText"
  ]);
  var extractMod = need("keyword-extract.js", ["getCandidateName", "getCandidateLocation", "getCandidateHeadline", "salaryNoteLines"]);
  var sleep = domMod.sleep,
      isVisible = domMod.isVisible,
      isDisabledish = domMod.isDisabledish,
      queryDeepSelectorAll = domMod.queryDeepSelectorAll,
      findElementByIdDeep = domMod.findElementByIdDeep,
      dispatchClickAtElementCenter = domMod.dispatchClickAtElementCenter,
      getDeepText = domMod.getDeepText;
  var getCandidateName = extractMod.getCandidateName,
      getCandidateLocation = extractMod.getCandidateLocation,
      getCandidateHeadline = extractMod.getCandidateHeadline,
      salaryNoteLines = extractMod.salaryNoteLines;

  /* ── Post keyword hits to the Notes tab on the prospect profile ── */

  /* ── Notes helpers ── */

  function findNotesTab(doc, win) {
    var root = doc.body || doc.documentElement;
    var candidates = [];
    SR.sel.notesTabLabel.forEach(function (sel) {
      try { candidates = candidates.concat(Array.from(doc.querySelectorAll(sel))); } catch (_) {}
    });
    try { candidates = candidates.concat(queryDeepSelectorAll(root, win, SR.sel.tabLabel)); } catch (_) {}
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var txt = ((el.textContent || el.innerText || "") + "").replace(/\s+/g, " ").trim().toLowerCase();
      if (/^notes\b/.test(txt)) {
        var clickTarget = el;
        try {
          var parentA = el.closest && el.closest("a");
          if (parentA) clickTarget = parentA;
        } catch (_) {}
        return clickTarget;
      }
    }
    // Fallback: the Notes tab is an <a> whose href ends in /notes, so it can be found
    // even when its label text isn't readable (seen live: label missing from the DOM
    // on some worker-tab loads, so every note in a row failed).
    try {
      var links = queryDeepSelectorAll(root, win, "a[href]");
      for (var j = 0; j < links.length; j++) {
        var href = links[j].getAttribute("href") || "";
        if (/\/app\/people\/applications\/[^/?#]+\/notes(?:[?#]|$)/.test(href)) return links[j];
      }
    } catch (_) {}
    return null;
  }

  /**
   * What the profile's tab bar held when the Notes tab wasn't found, for the log:
   * tab labels (SR's own UI text, no candidate data), page visibility and width.
   */
  function describeTabBar(doc, win) {
    var labels = [];
    try {
      var els = queryDeepSelectorAll(doc.body || doc.documentElement, win, SR.sel.tabLabel);
      for (var i = 0; i < els.length && labels.length < 12; i++) {
        labels.push(((els[i].textContent || "") + "").replace(/\s+/g, " ").trim().slice(0, 20));
      }
    } catch (_) {}
    var vis = "", w = 0;
    try { vis = doc.visibilityState || ""; } catch (_) {}
    try { w = win.innerWidth || 0; } catch (_) {}
    return "tabs=[" + labels.join(", ") + "] visibility=" + vis + " width=" + w;
  }

  /**
   * Walk shadow DOMs to find every textarea visible in the page.
   * SmartRecruiters wraps Notes in spl-form-element → shadowRoot → div → textarea.
   */
  function findAllDeepTextareas(root, win) {
    var out = [];
    var visited = new Set();
    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 1) {
        var tag = (node.tagName || "").toLowerCase();
        if (tag === "textarea") { out.push(node); return; }
        if (node.matches) {
          try {
            if (node.matches(SR.sel.notesInput)) out.push(node);
          } catch (_) {}
        }
      }
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.childNodes) {
        for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
      }
    }
    walk(root);
    return out.filter(function (el) { return isVisible(el, win); });
  }

  function getNotesSection(doc) {
    var sec = null;
    // #st-notes may be a <spl-tab> (tab button) rather than the notes form panel.
    // When a match is a tab, the form lives elsewhere — skip it so callers fall back to body.
    var sels = SR.sel.notesSection;
    for (var ni = 0; !sec && ni < sels.length; ni++) {
      try { sec = doc.querySelector(sels[ni]); } catch (_) {}
      if (sec) {
        var stag = (sec.tagName || "").toLowerCase();
        if (stag === "spl-tab" || (sec.getAttribute && sec.getAttribute("role") === "tab")) sec = null;
      }
    }
    if (!sec) {
      try {
        var deep = findElementByIdDeep(doc.documentElement || doc.body, SR.id.notes);
        if (deep) {
          var dtag = (deep.tagName || "").toLowerCase();
          if (dtag !== "spl-tab" && !(deep.getAttribute && deep.getAttribute("role") === "tab")) sec = deep;
        }
      } catch (_) {}
    }
    return sec;
  }

  function findNotesInput(doc, win) {
    var notesSection = getNotesSection(doc);
    if (notesSection) {
      var inSection = findAllDeepTextareas(notesSection, win);
      if (inSection.length) return inSection[0];
    }
    var all = findAllDeepTextareas(doc.body || doc.documentElement, win);
    return all.length ? all[0] : null;
  }

  /**
   * Single-pass shadow walk that collects notes textarea, "Note to self" state,
   * and post button simultaneously — avoids 4 separate DOM traversals.
   * Returns { input, isNoteToSelf, postBtn }.
   */
  function findNotesContext(doc, win) {
    var notesSection = getNotesSection(doc);
    // SR's form elements (#spl-form-element_N) live outside #st-notes, so always
    // search the full body — same fallback the original findNotesInput used.
    var searchRoot = doc.body || doc.documentElement;
    var input = null;
    var postBtn = null;
    var isNoteToSelf = false;
    var visited = new Set();

    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 1) {
        var tag = (node.tagName || "").toLowerCase();
        // Collect textarea/contenteditable
        if (!input) {
          if (tag === "textarea" && isVisible(node, win)) {
            input = node;
          } else if (node.matches) {
            try {
              if (node.matches(SR.sel.notesInput) && isVisible(node, win))
                input = node;
            } catch (_) {}
          }
        }
        // Detect "Note to self" selected on a spl-button
        if (tag === "spl-button" && !isNoteToSelf) {
          var bt = getDeepText(node);
          if (/note\s*to\s*self/i.test(bt)) isNoteToSelf = true;
        }
        // Collect post button
        if (!postBtn && (tag === "spl-button" || tag === "button" || tag === "input")) {
          if (isVisible(node, win) && !isDisabledish(node)) {
            var skip = false;
            try { if (node.closest && node.closest(SR.sel.splDropdown)) skip = true; } catch (_) {}
            if (!skip) {
              var dtxt = getDeepText(node);
              if (/^post$/i.test(dtxt) || (/post|save|submit/i.test(dtxt) && dtxt.length < 20)) postBtn = node;
            }
          }
        }
      }
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.childNodes) {
        for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
      }
    }

    walk(searchRoot);
    return { input: input, isNoteToSelf: isNoteToSelf, postBtn: postBtn };
  }

  /**
   * Walk shadow DOMs to find every spl-button / button visible.
   */
  function findAllDeepButtons(root, win) {
    var out = [];
    var visited = new Set();
    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 1) {
        var tag = (node.tagName || "").toLowerCase();
        if (tag === "spl-button" || tag === "button") out.push(node);
        if (node.matches) {
          try { if (node.matches('[role="button"]')) out.push(node); } catch (_) {}
        }
      }
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.childNodes) {
        for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
      }
    }
    walk(root);
    return Array.from(new Set(out));
  }

  function findNotesPostButton(doc, win) {
    // Pass 1: search all spl-form-element containers (ID index varies per page load)
    var formEls = doc.querySelectorAll(SR.sel.notesFormElement);
    for (var fi = 0; fi < formEls.length; fi++) {
      try {
        var allBtns = formEls[fi].querySelectorAll(SR.sel.splButton);
        for (var b = 0; b < allBtns.length; b++) {
          if (!isVisible(allBtns[b], win)) continue;
          if (allBtns[b].closest && allBtns[b].closest(SR.sel.splDropdown)) continue;
          var txt = getDeepText(allBtns[b]);
          if (/post|save|submit/i.test(txt)) return allBtns[b];
        }
      } catch (_) {}
    }
    // Pass 2: deep shadow-DOM walk from notes section or full body
    var notesSection = getNotesSection(doc);
    var searchRoot = notesSection || doc.body || doc.documentElement;
    var deepBtns = findAllDeepButtons(searchRoot, win);
    for (var i = 0; i < deepBtns.length; i++) {
      if (isDisabledish(deepBtns[i])) continue;
      if (deepBtns[i].closest && deepBtns[i].closest(SR.sel.splDropdown)) continue;
      var dtxt = getDeepText(deepBtns[i]);
      if (/^post$/i.test(dtxt)) return deepBtns[i];
    }
    // Pass 3: if notes section was too narrow, search full body
    if (notesSection) {
      var bodyBtns = findAllDeepButtons(doc.body || doc.documentElement, win);
      for (var j = 0; j < bodyBtns.length; j++) {
        if (isDisabledish(bodyBtns[j])) continue;
        if (bodyBtns[j].closest && bodyBtns[j].closest(SR.sel.splDropdown)) continue;
        var btxt = getDeepText(bodyBtns[j]);
        if (/^post$/i.test(btxt)) return bodyBtns[j];
      }
    }
    return null;
  }

  // Warning appended to notes when the resume PDF never rendered and the scan saw
  // only SR profile/skills data — so the recruiter knows a low hit count may be
  // incomplete rather than a true negative.
  var PARTIAL_SCAN_WARNING = "⚠ Resume PDF not read — partial scan (profile data only)";

  // Usual spelling of common terms whose capitalisation isn't just a capital first
  // letter. Keys are lowercase; looked up per word and for the whole keyword.
  var KEYWORD_DISPLAY_CASE = {};
  ("AI ML DL NLP CV LLM LLMs RAG GPU AWS GCP SQL NoSQL API APIs REST JSON XML HTML CSS PHP " +
   "WAF IAM SSO CIAM SIEM SOC DNS VPN DDoS OSINT CTF OCR RPA ETL ELT BI KPI CRM ERP SAP GIS " +
   "QA UI UX SEO GDPR ISO HR TA B2B B2C FMCG CPG MBA MSc BSc PhD R&D CI/CD DevOps MLOps SecOps SaaS PaaS IaaS " +
   "iOS macOS PyTorch TensorFlow NumPy OpenCV JavaScript TypeScript GitHub GitLab LinkedIn " +
   "PostgreSQL MySQL MongoDB SailPoint .NET C# C++ Node.js K8s").split(" ").forEach(function (w) {
    KEYWORD_DISPLAY_CASE[w.toLowerCase()] = w;
  });
  var KEYWORD_SMALL_WORDS = { and: 1, or: 1, of: 1, in: 1, on: 1, for: 1, with: 1, to: 1, the: 1, a: 1, an: 1 };

  /**
   * "scrapy (x3)" → "Scrapy (x3)", "data acquisition" → "Data Acquisition",
   * "waf" → "WAF". A keyword the recruiter typed with capitals keeps their spelling.
   * Note display only — results and diagnostics keep the matched text as-is.
   */
  function displayKeywordLabel(label) {
    var m = /^(.*?)(\s*\(x\d+\))?$/.exec(String(label == null ? "" : label));
    var kw = m[1], count = m[2] || "";
    if (/[A-Z]/.test(kw)) return kw + count;
    var whole = KEYWORD_DISPLAY_CASE[kw.toLowerCase()];
    if (whole) return whole + count;
    var words = kw.split(/(\s+|-)/);
    var first = true;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w || /^(\s+|-)$/.test(w)) continue;
      var known = KEYWORD_DISPLAY_CASE[w.toLowerCase()];
      if (known) words[i] = known;
      else if (!first && KEYWORD_SMALL_WORDS[w]) words[i] = w;
      else words[i] = w.charAt(0).toUpperCase() + w.slice(1);
      first = false;
    }
    return words.join("") + count;
  }

  /**
   * Note body as lines, read top to bottom: current role ("Current: Data
   * Annotator at Samsung…", the headline under the name), location, current and
   * expected salary from the screening answers (salaryLines), a blank line, then
   * the match count ("Keywords match N/T" or "Boolean match N/T", by `mode`), then
   * one line per matched keyword, capitalised (a comma-joined row was hard to
   * scan), with a blank line between the count and the list. Zero hits stays a
   * single "No keyword tagged - Keywords match 0/N" line.
   */
  function noteBodyLines(hitLabels, hitCount, totalKeywords, notePrefix, partialScan, location, headline, salaryLines, mode) {
    var lines = [];
    if (headline) lines.push("Current: " + headline);
    if (location) lines.push("Location: " + location);
    if (salaryLines) lines.push.apply(lines, salaryLines);
    if (lines.length) lines.push(""); // blank line between the profile details and the match count
    var matched = matchLabel(mode) + " " + hitCount + "/" + totalKeywords;
    if (hitCount === 0 || !hitLabels || !hitLabels.length) {
      lines.push((notePrefix || "") + "No keyword tagged - " + matched);
    } else {
      lines.push((notePrefix || "") + matched + ":");
      lines.push(""); // blank line between the count and the keyword list
      for (var i = 0; i < hitLabels.length; i++) lines.push(displayKeywordLabel(hitLabels[i]));
    }
    if (partialScan) lines.push(PARTIAL_SCAN_WARNING);
    return lines;
  }

  /** "Boolean match" for a boolean-query scan, otherwise "Keywords match". */
  function matchLabel(mode) {
    return mode === "boolean" ? "Boolean match" : "Keywords match";
  }

  function formatNoteText(hitLabels, hitCount, totalKeywords, notePrefix, candidateName, profileUrl, partialScan, location, headline, salaryLines, mode) {
    var lines = noteBodyLines(hitLabels, hitCount, totalKeywords, notePrefix, partialScan, location, headline, salaryLines, mode);
    // SR notes are plain-text, so name + URL go in as a plain header line (no markup).
    var header = [candidateName, profileUrl].filter(function (p) { return p; }).join(" | ");
    if (header) lines.unshift(header);
    return lines.join("\n");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /**
   * Rich-text variant of formatNoteText: the profile URL becomes an "SR Profile"
   * hyperlink instead of a bare URL. Used ONLY when the notes field is a
   * contenteditable rich editor — a plain <textarea> cannot hold an anchor.
   */
  function formatNoteHtml(hitLabels, hitCount, totalKeywords, notePrefix, candidateName, profileUrl, partialScan, location, headline, salaryLines, mode) {
    var lines = noteBodyLines(hitLabels, hitCount, totalKeywords, notePrefix, partialScan, location, headline, salaryLines, mode).map(escapeHtml);
    var parts = [];
    if (candidateName) parts.push(escapeHtml(candidateName));
    if (profileUrl) parts.push('<a href="' + escapeHtml(profileUrl) + '">SR Profile</a>');
    var header = parts.join(" | ");
    if (header) lines.unshift(header);
    return lines.join("<br>");
  }

  /* ── Note-save confirmation: detect the note actually rendering in the feed ── */

  function _normNoteText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
  }

  function _countOccur(hay, needle) {
    if (!needle) return 0;
    var n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
    return n;
  }

  /**
   * Render-stable marker for a just-composed note: its "match N/T" count
   * (a substring of both "Keywords match N/T" and "Boolean match N/T").
   * The note is now one keyword per line, and the feed may render those lines
   * as separate elements whose textContent runs together ("• nlp• keras"), so
   * the keyword list itself is no longer a reliable substring. The count sits
   * on a single line in every note format. It only has to be new in this
   * profile's feed: feedDeltaCount compares copies before vs after Post, so
   * older notes with the same count are in the baseline. Unlike a URL
   * substring or the compose field clearing, this fires for SR's div editor.
   */
  function noteConfirmMarker(hitCount, totalKeywords) {
    return _normNoteText("match " + (hitCount || 0) + "/" + totalKeywords);
  }

  /**
   * Copies of `marker` rendered in the notes feed, EXCLUDING the compose box.
   *
   * Both arguments are .textContent (never textarea .value): for a
   * contenteditable editor the live note text lives in textContent of both the
   * section and the input, so they cancel; for a <textarea> the live value is in
   * neither textContent, so nothing is double-counted. Comparing this delta
   * before vs after Post tells us a NEW note element appeared — which is exactly
   * what a recruiter sees when a note saves.
   */
  function feedDeltaCount(sectionTextContent, inputTextContent, marker) {
    if (!marker) return 0;
    var sec = _countOccur(_normNoteText(sectionTextContent), marker);
    var inp = _countOccur(_normNoteText(inputTextContent), marker);
    var d = sec - inp;
    return d > 0 ? d : 0;
  }

  function feedCopiesOfNote(doc, win, marker, inputEl) {
    var sec = getNotesSection(doc) || doc.body || doc.documentElement;
    var secText = "";
    try { secText = (sec && sec.textContent) || ""; } catch (_) {}
    var inText = "";
    try { inText = (inputEl && inputEl.textContent) || ""; } catch (_) {}
    return feedDeltaCount(secText, inText, marker);
  }

  /**
   * Set the value on a textarea/input/contenteditable and fire all events
   * that Angular/React/Web Component bindings listen to.
   */
  function setNativeInputValue(el, value) {
    try { el.focus(); } catch (_) {}
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input") {
      try {
        var proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var nativeSetter = Object.getOwnPropertyDescriptor(proto, "value");
        if (nativeSetter && nativeSetter.set) {
          nativeSetter.set.call(el, value);
        } else {
          el.value = value;
        }
      } catch (_) {
        el.value = value;
      }
      try { el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: value, bubbles: true, cancelable: true, composed: true })); } catch (_) {}
      try { el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: value, bubbles: true, composed: true })); } catch (_) {}
      try { el.dispatchEvent(new Event("change", { bubbles: true, composed: true })); } catch (_) {}
      try { el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: "a" })); } catch (_) {}
    } else {
      // Contenteditable: use execCommand to trigger framework bindings (Angular/React)
      var ceInserted = false;
      try {
        el.focus();
        var ownerDoc = el.ownerDocument || document;
        var ownerWin = ownerDoc.defaultView || window;
        var sel = ownerWin.getSelection();
        if (sel) { sel.selectAllChildren(el); }
        ceInserted = ownerDoc.execCommand("insertText", false, value);
      } catch (_) {}
      if (!ceInserted) {
        try { el.textContent = value; } catch (_) {}
        try { el.innerHTML = value.replace(/\n/g, "<br>"); } catch (_) {}
      }
      try { el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: value, bubbles: true, composed: true })); } catch (_) {}
      try { el.dispatchEvent(new Event("change", { bubbles: true, composed: true })); } catch (_) {}
    }
  }

  /**
   * Simulate actual keyboard typing — works with frameworks that ignore .value sets.
   */
  async function typeIntoElement(el, text, win) {
    try { el.focus(); } catch (_) {}
    await sleep(100);
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var keyCode = ch.charCodeAt(0);
      try {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, code: "Key" + ch.toUpperCase(), keyCode: keyCode, which: keyCode, bubbles: true, composed: true }));
        el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, code: "Key" + ch.toUpperCase(), keyCode: keyCode, which: keyCode, bubbles: true, composed: true }));
        el.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true, composed: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, code: "Key" + ch.toUpperCase(), keyCode: keyCode, which: keyCode, bubbles: true, composed: true }));
      } catch (_) {}
    }
  }

  function clickSplButton(el, win) {
    if (!el) return;
    var target = el;
    try {
      if (el.shadowRoot) {
        var inner = el.shadowRoot.querySelector("button, [role='button']");
        if (inner) target = inner;
      }
    } catch (_) {}
    try { target.click(); } catch (_) {
      dispatchClickAtElementCenter(target, win, 0.5);
    }
  }

  /**
   * Try a single click on an element using one specific strategy.
   * Returns nothing — caller must check if the click had the desired effect.
   */
  function singleClick(el, win, strategy) {
    if (!el) return;
    try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
    if (strategy === "native") {
      try { el.click(); } catch (_) {}
    } else if (strategy === "shadow") {
      var sb = null;
      try { if (el.shadowRoot) sb = el.shadowRoot.querySelector("button, a, [role='button']"); } catch (_) {}
      if (sb) { try { sb.click(); } catch (_) {} }
      else { try { el.click(); } catch (_) {} }
    } else {
      dispatchClickAtElementCenter(el, win, 0.5);
    }
  }

  /** Check if any dropdown menu is currently visible in the DOM. */
  function isDropdownMenuOpen(doc) {
    try {
      var menus = doc.querySelectorAll(SR.sel.dropdownMenu);
      for (var i = 0; i < menus.length; i++) {
        var r = menus[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    } catch (_) {}
    return false;
  }

  /** Find the "Note to self" item from any visible dropdown menu. */
  function findNoteToSelfItem(doc) {
    var menus = doc.querySelectorAll(SR.sel.dropdownMenu);
    for (var m = 0; m < menus.length; m++) {
      var items = menus[m].querySelectorAll(SR.sel.dropdownItem);
      for (var i = 0; i < items.length; i++) {
        if (/note\s*to\s*self/i.test(getDeepText(items[i]))) return items[i];
      }
      if (items.length >= 3) return items[2];
    }
    var loose = doc.querySelectorAll(SR.sel.dropdownItem);
    for (var j = 0; j < loose.length; j++) {
      if (/note\s*to\s*self/i.test(getDeepText(loose[j]))) return loose[j];
    }
    return null;
  }

  /**
   * Open the "Open note" dropdown and select "Note to self".
   * Tries one click strategy at a time, checking if the dropdown opened after each.
   */
  async function selectNoteToSelf(doc, win) {
    var splBtn = null;
    // Find the note-type dropdown — the one whose text contains "note" (e.g. "Open note").
    // There may be other dropdowns (e.g. "Using Publisher") in the same form element;
    // querySelectorAll returns all of them so we can pick the right one.
    var formEls = doc.querySelectorAll(SR.sel.notesFormElement);
    for (var fi = 0; fi < formEls.length && !splBtn; fi++) {
      try {
        var dds = formEls[fi].querySelectorAll(SR.sel.splDropdown);
        for (var di = 0; di < dds.length; di++) {
          var dd = dds[di];
          if (!isVisible(dd, win)) continue;
          var ddText = getDeepText(dd);
          if (/\bnote\b/i.test(ddText)) {
            var btn = dd.querySelector(SR.sel.splButton);
            if (btn) { splBtn = btn; break; }
          }
        }
      } catch (_) {}
    }
    // Fallback: deep search entire body for note-type dropdown
    if (!splBtn) {
      var ddSearchRoot = doc.body || doc.documentElement;
      var allDds = queryDeepSelectorAll(ddSearchRoot, win, SR.sel.splDropdown);
      for (var di2 = 0; di2 < allDds.length; di2++) {
        if (!isVisible(allDds[di2], win)) continue;
        var ddText2 = getDeepText(allDds[di2]);
        if (/\bnote\b/i.test(ddText2)) {
          var btn2 = allDds[di2].querySelector(SR.sel.splButton);
          if (btn2) { splBtn = btn2; break; }
        }
      }
    }
    if (!splBtn) return false;

    var strategies = ["native", "shadow", "dispatch"];
    for (var s = 0; s < strategies.length; s++) {
      if (isDropdownMenuOpen(doc)) break;
      singleClick(splBtn, win, strategies[s]);
      await sleep(500);
      if (isDropdownMenuOpen(doc)) break;
    }

    if (!isDropdownMenuOpen(doc)) return false;

    var noteItem = findNoteToSelfItem(doc);
    if (!noteItem) {
      await sleep(400);
      noteItem = findNoteToSelfItem(doc);
    }
    if (!noteItem) return false;

    var inner = null;
    var itemTargets = SR.sel.dropdownItemClickTarget;
    for (var ti = 0; !inner && ti < itemTargets.length; ti++) {
      try { inner = noteItem.querySelector(itemTargets[ti]); } catch (_) {}
    }

    var clickEl = inner || noteItem;
    singleClick(clickEl, win, "dispatch");
    await sleep(300);

    var triggerText = getDeepText(splBtn);
    if (/note\s*to\s*self/i.test(triggerText)) return true;

    singleClick(clickEl, win, "native");
    await sleep(300);
    triggerText = getDeepText(splBtn);
    if (/note\s*to\s*self/i.test(triggerText)) return true;

    singleClick(noteItem, win, "dispatch");
    await sleep(300);
    return true;
  }

  /**
   * Pre-open the Notes tab and select "Note to self" early,
   * so the input is ready by the time keyword scan finishes.
   */
  async function prepareNotesSection(doc, win, log) {
    log = log || [];
    var notesTab = findNotesTab(doc, win);
    if (!notesTab) {
      log.push({ ok: false, msg: "Notes: tab element not found in DOM — cannot open notes (" + describeTabBar(doc, win) + ")" });
      return false;
    }
    log.push({ ok: true, msg: "Notes: tab found, clicking to open" });
    try { notesTab.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
    await sleep(50);
    dispatchClickAtElementCenter(notesTab, win, 0.5);
    try { notesTab.click(); } catch (_) {}
    // Poll until notes input is present instead of a fixed sleep
    var inputFound = false;
    for (var npw = 0; npw < 3000; npw += 200) {
      await sleep(200);
      if (findNotesInput(doc, win)) { inputFound = true; break; }
    }
    if (!inputFound) {
      log.push({ ok: false, msg: "Notes: textarea did not mount within 3s after tab click" });
    }
    var ok = await selectNoteToSelf(doc, win);
    if (!ok) log.push({ ok: false, msg: "Notes: Note-to-self selection failed or could not verify" });
    // Give SR time to re-render the notes form after note-type selection.
    await sleep(600);
    return ok;
  }

  // Sets up a PerformanceObserver that watches for SR's note-save API call to complete.
  // Call BEFORE clicking Post; then call .wait(maxMs) after confirmation polling to block
  // navigation until the actual server round-trip finishes (not just the optimistic UI update).
  // Falls back to a plain sleep when PerformanceObserver is unavailable.
  function beginWatchForNoteSave(win) {
    var resolve;
    var p = new Promise(function(r) { resolve = r; });
    var obs;
    var broken = false;
    try {
      obs = new win.PerformanceObserver(function(list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          var it = e.initiatorType;
          if (it !== "fetch" && it !== "xmlhttprequest" && it !== "beacon") continue;
          var nm = (e.name || "").toLowerCase();
          // SR posts notes through a generic / GraphQL endpoint, so the old
          // indexOf("note") filter never matched. Match the write-ish endpoints
          // SR actually uses while excluding static assets & 3rd-party telemetry.
          var looksSave = nm.indexOf("note") >= 0 || nm.indexOf("comment") >= 0 ||
                          nm.indexOf("activity") >= 0 || nm.indexOf("timeline") >= 0 ||
                          nm.indexOf("message") >= 0 || nm.indexOf("graphql") >= 0 ||
                          nm.indexOf("mutation") >= 0;
          var noise = /(googleapis|google-analytics|googletagmanager|doubleclick|segment\.|sentry|datadog|amplitude|mixpanel|hotjar|fullstory|optimizely|launchdarkly|telemetry|analytics)/.test(nm) ||
                      /\.(png|jpe?g|gif|svg|webp|woff2?|ttf|css|js|map)(\?|$)/.test(nm);
          if (looksSave && !noise) {
            try { obs.disconnect(); } catch (_) {}
            resolve("api-done");
            return;
          }
        }
      });
      obs.observe({ type: "resource", buffered: false });
    } catch (_) {
      broken = true;
    }
    return {
      wait: function(maxMs) {
        if (broken) return sleep(maxMs);
        return Promise.race([
          p,
          sleep(maxMs).then(function() { try { obs.disconnect(); } catch (_) {} return "timeout"; }),
        ]);
      },
    };
  }

  async function postKeywordHitsToNotes(doc, win, hitLabels, hitCount, totalKeywords, log, notePrefix, opts) {
    var partialScan = !!(opts && opts.partialScan);
    // Single combined walk to collect input + noteToSelf state + postBtn
    var ctx = findNotesContext(doc, win);
    var input = ctx.input;

    if (!input) {
      var notesTab2 = findNotesTab(doc, win);
      if (notesTab2) {
        log.push({ ok: true, msg: "Notes: tab found in post fn — clicking (was not pre-opened)" });
        try { notesTab2.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
        await sleep(50);
        dispatchClickAtElementCenter(notesTab2, win, 0.5);
        try { notesTab2.click(); } catch (_) {}
      } else {
        log.push({ ok: false, msg: "Notes: tab not found in DOM during post attempt (" + describeTabBar(doc, win) + ")" });
      }
      for (var wait = 0; wait < 4000; wait += 200) {
        await sleep(200);
        ctx = findNotesContext(doc, win);
        input = ctx.input;
        if (input) break;
      }
    }
    if (!input) {
      log.push({ ok: false, msg: "Notes: textarea not found after 4s wait — could not post" });
      return false;
    }
    log.push({ ok: true, msg: "Notes: textarea found, type=" + (input.tagName || "?").toLowerCase() });

    if (!ctx.isNoteToSelf) {
      log.push({ ok: true, msg: "Notes: Note-to-self not active — selecting now" });
      await selectNoteToSelf(doc, win);
      await sleep(500); // wait for SR to re-render the form after note-type selection
      ctx = findNotesContext(doc, win);
      if (ctx.input) input = ctx.input;  // textarea may have been remounted by SR
    }

    var candidateName = "";
    try { candidateName = getCandidateName(doc); } catch (_) {}
    var profileUrl = "";
    try { profileUrl = (doc.location && doc.location.href) || ""; } catch (_) {}
    var location = "";
    try {
      var loc = getCandidateLocation(doc, (opts && opts.resumeText) || "");
      location = loc.label;
      // Method only — the location itself is candidate data and stays out of the log.
      log.push({ ok: true, msg: "Notes: location " + (location ? "via " + loc.method : "not found") });
    } catch (_) {}
    var headline = "";
    try {
      headline = getCandidateHeadline(doc, candidateName);
      log.push({ ok: true, msg: "Notes: current role " + (headline ? "found" : "not found") });
    } catch (_) {}
    var salaryLines = [];
    try {
      salaryLines = salaryNoteLines((opts && opts.screeningText) || "");
      // Count only — salary figures are candidate data and stay out of the log.
      log.push({ ok: true, msg: "Notes: salary lines " + salaryLines.length });
    } catch (_) {}
    var mode = opts && opts.mode;
    var noteText = formatNoteText(hitLabels, hitCount, totalKeywords, notePrefix, candidateName, profileUrl, partialScan, location, headline, salaryLines, mode);
    var noteMarker = noteConfirmMarker(hitCount, totalKeywords);
    var itag = (input.tagName || "").toLowerCase();
    var isRichEditor = (itag !== "textarea" && itag !== "input");

    if (isRichEditor) {
      var compact = await compactNoteEditorBreaks();
      if (compact && compact.ok) {
        log.push({ ok: true, msg: "Notes: compact line breaks on (" + compact.editors + " editor)" });
      } else {
        log.push({ ok: false, msg: "Notes: could not compact line breaks — note may be double-spaced" + (compact && compact.error ? " (" + compact.error + ")" : "") });
      }
    }

    // Rich-text editor + a profile URL → insert a real "SR Profile" hyperlink via
    // insertHTML. Textareas can't hold anchors, so they fall through to plain text.
    var usedRichHtml = false;
    if (isRichEditor && profileUrl) {
      try {
        var ownerDoc = input.ownerDocument || doc;
        var ownerWin = ownerDoc.defaultView || win;
        input.focus();
        var rsel = ownerWin.getSelection && ownerWin.getSelection();
        if (rsel && rsel.selectAllChildren) rsel.selectAllChildren(input);
        var noteHtml = formatNoteHtml(hitLabels, hitCount, totalKeywords, notePrefix, candidateName, profileUrl, partialScan, location, headline, salaryLines, mode);
        usedRichHtml = ownerDoc.execCommand("insertHTML", false, noteHtml);
      } catch (_) {}
      if (usedRichHtml) {
        try { input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", bubbles: true, composed: true })); } catch (_) {}
        try { input.dispatchEvent(new Event("change", { bubbles: true, composed: true })); } catch (_) {}
        log.push({ ok: true, msg: "Notes: inserted rich text with 'SR Profile' hyperlink" });
      } else {
        log.push({ ok: true, msg: "Notes: rich insertHTML unavailable — falling back to plain text" });
      }
    }

    if (!usedRichHtml) setNativeInputValue(input, noteText);
    await sleep(200);

    if (itag === "textarea" || itag === "input") {
      var curVal = "";
      try { curVal = input.value || ""; } catch (_) {}
      if (_normNoteText(curVal).indexOf(noteMarker) < 0) {
        log.push({ ok: true, msg: "Notes: native setter did not register — trying execCommand" });
        // Strategy 2: execCommand insertText — browser-native, triggers Angular/React bindings
        var inserted = false;
        try {
          input.focus();
          doc.execCommand("selectAll");
          inserted = doc.execCommand("insertText", false, noteText);
        } catch (_) {}
        if (!inserted) {
          log.push({ ok: true, msg: "Notes: execCommand failed — forcing value + events" });
          // Strategy 3: force value + full event set
          try {
            var _proto = HTMLTextAreaElement.prototype;
            var _setter = Object.getOwnPropertyDescriptor(_proto, "value");
            if (_setter && _setter.set) { _setter.set.call(input, noteText); }
            else { input.value = noteText; }
          } catch (_) { try { input.value = noteText; } catch (_2) {} }
          var _evts = ["input", "change", "keyup"];
          for (var _ei = 0; _ei < _evts.length; _ei++) {
            try { input.dispatchEvent(new Event(_evts[_ei], { bubbles: true, composed: true })); } catch (_) {}
          }
        }
        await sleep(200);
      }
    }

    // Soft check — log warning but always proceed to Post (single click already prevents blank notes)
    var finalInputVal = "";
    try {
      finalInputVal = (itag === "textarea" || itag === "input") ? (input.value || "") : (input.textContent || "");
    } catch (_) {}
    if (!finalInputVal || _normNoteText(finalInputVal).indexOf(noteMarker) < 0) {
      log.push({ ok: false, msg: "Notes: value not confirmed in textarea before clicking Post (val='" + String(finalInputVal).slice(0, 40) + "')" });
    } else {
      log.push({ ok: true, msg: "Notes: value confirmed in textarea — clicking Post" });
    }

    // Poll until the Post button is both found AND enabled.
    // SR's Post button starts disabled while the textarea is empty and becomes enabled
    // only after its Angular binding detects the value change, which can lag several
    // render cycles. Clicking a disabled spl-button's inner <button disabled> does nothing.
    var postBtn = null;
    for (var bw = 0; bw < 5000; bw += 300) {
      var candidate = findNotesPostButton(doc, win);
      if (candidate) {
        var innerShadow = null;
        try { if (candidate.shadowRoot) innerShadow = candidate.shadowRoot.querySelector("button"); } catch (_) {}
        var outerOk = !isDisabledish(candidate);
        var innerOk = innerShadow ? !innerShadow.disabled : true;
        if (outerOk && innerOk) { postBtn = candidate; break; }
      }
      await sleep(300);
    }
    if (!postBtn) {
      // Last resort: use whatever button we found even if still disabled
      postBtn = findNotesPostButton(doc, win);
    }
    if (!postBtn) {
      log.push({ ok: false, msg: "Notes: Post button not found — text entered but not submitted" });
      return false;
    }

    // Start watching for SR's note-save API response BEFORE clicking Post so we don't
    // miss a fast response. SR often does an optimistic UI update (clears textarea) before
    // the server round-trip completes — we need to wait for the actual API call to finish
    // so the browser doesn't cancel the in-flight XHR when we navigate to the next profile.
    var noteSaveWatcher = beginWatchForNoteSave(win);

    // The matched-keyword body is profile-specific; record how many copies of it
    // already render in the feed (excluding the compose box) BEFORE we post, so an
    // increase afterwards proves a new note element appeared.
    var baselineFeed = feedCopiesOfNote(doc, win, noteMarker, input);

    // Click Post exactly once — never retry. Retrying risks posting blank notes when SR
    // is slow to clear the textarea after a successful submission.
    singleClick(postBtn, win, "shadow");

    // Confirm the save by racing THREE signals — the old code relied only on the
    // textarea clearing (the div editor never clears detectably) and a network URL
    // containing "note" (SR's endpoint doesn't), so every post logged "UNCONFIRMED"
    // even though it saved. The authoritative human-equivalent signal is the note
    // appearing in the feed:
    //   (a) the note text rendering in the notes feed (works for div + textarea),
    //   (b) SR's note-save API response on the network, and
    //   (c) the compose field clearing or unmounting.
    var apiDone = false;
    noteSaveWatcher.wait(7000).then(function (r) { if (r === "api-done") apiDone = true; });

    var confirmed = false, confirmReason = "";
    for (var pw = 0; pw < 7000; pw += 300) {
      await sleep(300);
      try {
        if (feedCopiesOfNote(doc, win, noteMarker, input) > baselineFeed) {
          confirmed = true; confirmReason = "rendered in feed"; break;
        }
      } catch (_) {}
      if (apiDone) { confirmed = true; confirmReason = "save API"; break; }
      var postCheckVal = "";
      try {
        postCheckVal = (itag === "textarea" || itag === "input") ? (input.value || "") : (input.textContent || "");
      } catch (_) {
        // Element detached — SR unmounted the form after submission.
        confirmed = true; confirmReason = "compose unmounted"; break;
      }
      if (!postCheckVal || postCheckVal.length < 5) { confirmed = true; confirmReason = "compose cleared"; break; }
    }

    if (confirmed) {
      // If we confirmed via the UI before the API response landed, wait for the
      // actual save to finish so the caller's navigation doesn't cancel the XHR.
      if (!apiDone) {
        var late = await noteSaveWatcher.wait(2500);
        if (late === "api-done") apiDone = true;
      }
      log.push({ ok: true, msg: "Notes: confirmed posted (" + hitCount + " matches via " + confirmReason + (apiDone ? " + save API" : "") + ")" });
      return true;
    }

    // Genuinely unconfirmed: the note never rendered, the save API never fired, and
    // the field kept its text. Return true anyway (returning false risks the caller
    // requeuing and double-posting), but log ok:false so it's visible in diagnostics.
    log.push({ ok: false, msg: "Notes: Post clicked but UNCONFIRMED — note did not appear in feed, no save-API response, field retained text (note may not have saved)" });
    return true;
  }

  /**
   * Ask the background to switch off CKEditor's newline after <br> in the notes
   * editor — the editor lives in the page's MAIN world, which this content script
   * can't reach. SR turns that newline into a second <br>, double-spacing every
   * note line. Resolves { ok, editors } or null when unavailable (Node tests, message
   * dropped); a miss only costs layout, so the caller logs it and posts anyway.
   */
  function compactNoteEditorBreaks() {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) { resolve(null); return; }
        var settled = false;
        var timer = setTimeout(function () { if (!settled) { settled = true; resolve(null); } }, 2000);
        chrome.runtime.sendMessage({ type: "srCompactNoteBreaks" }, function (resp) {
          var err = chrome.runtime.lastError;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(err ? null : (resp || null));
        });
      } catch (_) { resolve(null); }
    });
  }

  var api = {
    findNotesTab: findNotesTab,
    describeTabBar: describeTabBar,
    findAllDeepTextareas: findAllDeepTextareas,
    getNotesSection: getNotesSection,
    findNotesInput: findNotesInput,
    findNotesContext: findNotesContext,
    findAllDeepButtons: findAllDeepButtons,
    findNotesPostButton: findNotesPostButton,
    PARTIAL_SCAN_WARNING: PARTIAL_SCAN_WARNING,
    KEYWORD_DISPLAY_CASE: KEYWORD_DISPLAY_CASE,
    KEYWORD_SMALL_WORDS: KEYWORD_SMALL_WORDS,
    displayKeywordLabel: displayKeywordLabel,
    noteBodyLines: noteBodyLines,
    formatNoteText: formatNoteText,
    escapeHtml: escapeHtml,
    formatNoteHtml: formatNoteHtml,
    _normNoteText: _normNoteText,
    _countOccur: _countOccur,
    noteConfirmMarker: noteConfirmMarker,
    feedDeltaCount: feedDeltaCount,
    feedCopiesOfNote: feedCopiesOfNote,
    setNativeInputValue: setNativeInputValue,
    typeIntoElement: typeIntoElement,
    clickSplButton: clickSplButton,
    singleClick: singleClick,
    isDropdownMenuOpen: isDropdownMenuOpen,
    findNoteToSelfItem: findNoteToSelfItem,
    selectNoteToSelf: selectNoteToSelf,
    prepareNotesSection: prepareNotesSection,
    beginWatchForNoteSave: beginWatchForNoteSave,
    postKeywordHitsToNotes: postKeywordHitsToNotes,
    compactNoteEditorBreaks: compactNoteEditorBreaks,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.__srKw = Object.assign(globalThis.__srKw || {}, api);
})();
