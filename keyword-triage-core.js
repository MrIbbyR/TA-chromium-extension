// keyword-triage-core.js — SmartRecruiters keyword search on resume + notes tagging
// Exposes: __srKeywordTriageRun, __srKeywordTriageRunMulti, __srKeywordTriageStartQueue,
//          __srCollectApplicantClickTargets (shared with salary-triage)

(function () {
  "use strict";

  // KEYWORD_EXPANSIONS, KEYWORD_TYPO_ALIASES, and resolver functions are loaded from
  // keyword-expansions.js (runs as a content script before this file).

  var MOVE_FORWARD_ID = "st-moveForward";

  /* ── Helpers ── */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * Per-phase wall-clock timer for the diagnostics entry. `mark(name)` charges the time
   * since the previous mark to `name` (repeat marks accumulate). `seed` holds phases
   * measured before the core ran (page load, autorun waits) and keeps them first.
   * `now` is injectable for tests.
   */
  function makePhaseTimer(seed, now) {
    now = now || function () { return performance.now(); };
    var phases = {};
    if (seed && typeof seed === "object") {
      for (var k in seed) {
        if (Object.prototype.hasOwnProperty.call(seed, k) && typeof seed[k] === "number") phases[k] = Math.round(seed[k]);
      }
    }
    var last = now();
    return {
      mark: function (name) {
        var t = now();
        phases[name] = (phases[name] || 0) + Math.round(t - last);
        last = t;
      },
      phases: phases,
    };
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
    return Array.from(new Set(out));
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

  /** Synonym forms for one boolean leaf (same table as comma keywords, plus typo table). */
  function expandOneBooleanTerm(term) {
    var t = (term || "").trim();
    if (!t) return [];
    var low = t.toLowerCase();
    if (KEYWORD_TYPO_ALIASES[low]) t = KEYWORD_TYPO_ALIASES[low];
    var table = buildExpansionTable();
    var out = [];
    var seen = {};
    function push(s) {
      var x = (s || "").trim();
      if (!x) return;
      var k = x.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(x);
    }
    push(t);
    var forms = table[t.toLowerCase()];
    if (forms) {
      for (var i = 0; i < forms.length; i++) push(forms[i]);
    }
    return out;
  }

  /* ── Text normalization (ported from req.py _normalize_for_kw) ── */

  function normalizeForKw(s) {
    if (!s) return "";
    s = String(s);
    try {
      if (typeof s.normalize === "function") s = s.normalize("NFKC");
    } catch (_) {}
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
    s = s.replace(/\u00AD/g, "");
    s = s.replace(/\u2060/g, "");
    s = s.replace(/\u00A0/g, " ").replace(/\u202F/g, " ").replace(/\u2007/g, " ");
    s = s.replace(/\u00B7/g, " ").replace(/\u2022/g, " ");
    s = s.replace(/\s+/g, " ");
    return s.trim();
  }

  /**
   * Collapse exact-duplicate text segments before keyword counting.
   *
   * SR assembles candidate text from many overlapping sources: the resume, a
   * full-page shadow-DOM scan that re-captures that same resume, and
   * getProfileOverviewText's selector list (`[class*="profile"]`, `*="skills"`,
   * `*="summary"`, `*="education"` …) which matches nested and repeated elements.
   * The identical chunk can therefore land in allText 5-10×, inflating occurrence
   * counts (e.g. "phd (x65)" when the resume says PhD six times).
   *
   * Splitting on newlines and dropping repeat segments removes that duplication.
   * Every distinct segment is kept once, so keyword *presence* — and thus the
   * Matched X/Y hit/miss result — is unchanged; only the displayed counts shrink
   * to their true values. Short segments (< 12 chars) are kept verbatim so unique
   * one-word data is never lost.
   */
  function dedupeTextSegments(text) {
    if (!text) return text;
    var segs = String(text).split(/\n+/);
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var key = segs[i].replace(/\s+/g, " ").trim().toLowerCase();
      if (!key) continue;
      if (key.length >= 12) {
        if (seen[key]) continue;
        seen[key] = true;
      }
      out.push(segs[i]);
    }
    return out.join("\n");
  }

  /**
   * Collapse phrase runs that are immediately repeated within a single line.
   *
   * dedupeTextSegments only folds duplication that sits on its own newline. But
   * SR renders most resumes through pdf.js, whose text layer (and many
   * graphically-designed CV templates) emit the same visual text 2-3× as
   * overlapping spans. getPdfTextLayerText space-joins those spans into one
   * newline-free blob, so a single "Azure" mention is tokenised 3-4× and counted
   * as "azure (x20)" — even though a recruiter reading the page sees it ~5×.
   *
   * This collapses runs the way a human reads the page once: it removes only a
   * run that is IMMEDIATELY repeated, so genuine repeats in different sentences
   * survive and counts stay truthful. The comparison runs on a lowercased,
   * separator-free character stream, so the spacing variants pdf.js emits
   * ("AI Fundamentals" vs "AIFundamentals") collapse to the same unit. Survivors
   * keep their original casing and punctuation, so downstream camelCase
   * splitting and phrase matching are unchanged.
   */
  function collapseInlineRepeats(text) {
    if (!text) return text;
    var s = String(text);
    var re = /[A-Za-z0-9]+/g, m, toks = [];
    while ((m = re.exec(s)) !== null) {
      toks.push({ s: m.index, e: re.lastIndex });
      if (toks.length > 80000) return text; // pathological input — bail, unchanged
    }
    var n = toks.length;
    if (n < 4) return text;

    // Separator-free lowercased char stream + each token's start offset in it.
    var C = "", coff = new Array(n);
    for (var i = 0; i < n; i++) {
      coff[i] = C.length;
      C += s.slice(toks[i].s, toks[i].e).toLowerCase();
    }
    var Clen = C.length;
    var MAXM = 200; // longest repeated unit (in chars) we will collapse

    function eqAt(a, b, len) {
      for (var k = 0; k < len; k++) {
        if (C.charCodeAt(a + k) !== C.charCodeAt(b + k)) return false;
      }
      return true;
    }

    var keep = new Array(n);
    for (var k0 = 0; k0 < n; k0++) keep[k0] = true;

    var t = 0;
    while (t < n) {
      var p = coff[t];
      // Largest unit [t, bestEnd) whose chars are immediately repeated next.
      var bestEnd = -1, bestM = 0;
      for (var e = t + 1; e < n; e++) {
        var mlen = coff[e] - p;
        if (mlen > MAXM) break;
        if (p + 2 * mlen > Clen) break;
        if (eqAt(p, p + mlen, mlen)) { bestEnd = e; bestM = mlen; }
      }
      if (bestEnd > t) {
        // Keep the first copy [t, bestEnd); drop every immediately-repeated copy.
        var nextStart = p + bestM;
        var j = bestEnd;
        while (nextStart + bestM <= Clen && eqAt(p, nextStart, bestM)) {
          while (j < n && coff[j] < nextStart + bestM) { keep[j] = false; j++; }
          nextStart += bestM;
        }
        t = j; // resume after the dropped copies
      } else {
        t++;
      }
    }

    // Rebuild: emit survivors with their original text; replace each dropped
    // token (and the separator before it) with a single space.
    var out = "", cursor = 0;
    for (var x = 0; x < n; x++) {
      if (keep[x]) {
        out += s.slice(cursor, toks[x].e);
        cursor = toks[x].e;
      } else {
        out += " ";
        cursor = toks[x].e;
      }
    }
    out += s.slice(cursor);
    return out;
  }

  /* ── Excluded regions: sidebar / job metadata that should NOT be scanned ── */

  var EXCLUDED_SELECTORS = [
    "sr-job-application-sidebar",
    "sr-job-application-details",
    "sr-job-application-overview",
    '[class*="job-application-sidebar"]',
    '[class*="job-application-details"]',
    "aside sr-job-application-sidebar",
    // "aside" removed — too broad; stripped candidate skills sections if SR uses aside for profile layout
  ];

  function getExcludedText(doc) {
    var parts = [];
    var root = doc.querySelector("#st-candidateView") || doc.body;
    if (!root) return "";
    for (var i = 0; i < EXCLUDED_SELECTORS.length; i++) {
      try {
        var els = root.querySelectorAll(EXCLUDED_SELECTORS[i]);
        for (var j = 0; j < els.length; j++) {
          var t = (els[j].innerText || els[j].textContent || "").replace(/\s+/g, " ").trim();
          if (t.length > 5) parts.push(t);
        }
      } catch (_) {}
    }
    return parts.join("\n\n");
  }

  function stripExcludedText(allText, excludedText) {
    if (!excludedText || !allText) return allText;
    var phrases = excludedText.split(/\n\n/);
    for (var i = 0; i < phrases.length; i++) {
      var p = phrases[i].trim();
      if (p.length < 10) continue;
      var idx = allText.indexOf(p);
      while (idx >= 0) {
        allText = allText.substring(0, idx) + " " + allText.substring(idx + p.length);
        idx = allText.indexOf(p);
      }
    }
    return allText.replace(/\s+/g, " ").trim();
  }

  /* ── Resume text extraction from DOM (ported from req.py get_dom_resume_text) ── */

  function collectDeepText(root, minChunk) {
    minChunk = minChunk || 30;
    var chunks = [];
    var visited = new Set();
    var buf = [];

    var BLOCK = { div:1,p:1,br:1,li:1,ul:1,ol:1,tr:1,td:1,th:1,table:1,
      section:1,article:1,h1:1,h2:1,h3:1,h4:1,h5:1,h6:1,
      header:1,footer:1,nav:1,main:1,aside:1,blockquote:1 };

    function flushBuf() {
      var t = buf.join(" ").replace(/\s+/g, " ").trim();
      if (t.length >= minChunk) chunks.push(t);
      buf = [];
    }

    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 3) {
        var v = (node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (v) buf.push(v);
      } else if (node.nodeType === 1) {
        var tag = (node.tagName || "").toLowerCase();
        if (BLOCK[tag]) flushBuf();
      }
      if (node.shadowRoot) { flushBuf(); walk(node.shadowRoot); flushBuf(); }
      if (node.childNodes) {
        for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
      }
      if (node.nodeType === 1) {
        var tag2 = (node.tagName || "").toLowerCase();
        if (BLOCK[tag2]) flushBuf();
      }
    }

    walk(root);
    flushBuf();
    return chunks;
  }

  function getResumeText(doc) {
    var root = doc.querySelector("#st-candidateView") || doc.body;
    if (!root) return "";
    var selectors = [
      "sr-resume-viewer",
      "sr-candidate-resume",
      "sr-resume",
      '[data-testid*="resume"]',
      '[data-testid*="Resume"]',
      '[class*="resume"]',
      '[id*="resume"]',
    ];
    var chunks = [];
    var minChunk = 30;

    function pushText(raw) {
      var t = (raw || "").replace(/\s+/g, " ").trim();
      if (t.length >= minChunk) chunks.push(t);
    }

    function collectFromEl(el) {
      if (!el) return;
      try {
        pushText(el.innerText || el.textContent || "");
        if (el.shadowRoot) {
          try {
            pushText(el.shadowRoot.innerText || el.shadowRoot.textContent || "");
            var deep = collectDeepText(el.shadowRoot, minChunk);
            for (var d = 0; d < deep.length; d++) chunks.push(deep[d]);
          } catch (_) {}
        }
      } catch (_) {}
    }

    for (var i = 0; i < selectors.length; i++) {
      try {
        // queryDeepSelectorAll pierces shadow roots so sr-resume-viewer nested inside
        // a spl-tab-container shadow host is still reachable.
        var els = queryDeepSelectorAll(root, null, selectors[i]);
        for (var j = 0; j < els.length; j++) collectFromEl(els[j]);
      } catch (_) {}
    }

    var merged = chunks.length ? chunks.join("\n\n") : "";
    if (merged.length >= 500) return merged;

    // Try same-origin iframes — SR often embeds the resume PDF in an <iframe>.
    // collectDeepText stops at iframe boundaries, so we must read contentDocument directly.
    // Cross-origin frames throw on access and are silently skipped.
    try {
      var iframes = Array.from(doc.querySelectorAll("iframe"));
      for (var fi = 0; fi < iframes.length; fi++) {
        try {
          var fd = iframes[fi].contentDocument ||
                   (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
          if (!fd) continue;
          var ft = ((fd.body && fd.body.innerText) || (fd.body && fd.body.textContent) || "").trim();
          if (ft.length > 100) chunks.push(ft);
          var fdeep = collectDeepText(fd.body || fd.documentElement, 20);
          for (var fd2 = 0; fd2 < fdeep.length; fd2++) chunks.push(fdeep[fd2]);
        } catch (_) {}
      }
    } catch (_) {}
    merged = chunks.length ? chunks.join("\n\n") : "";
    if (merged.length >= 500) return merged;

    var fullRoot = (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim();
    if (merged && fullRoot) return merged + "\n\n" + fullRoot;
    return merged || fullRoot;
  }

  /**
   * Resume-viewer content only — no fullRoot fallback.
   * Used exclusively for the poll readiness check: returns "" until the PDF/resume
   * element actually renders text (≥200 chars), so the poll doesn't exit early
   * on page-header text before the resume has loaded.
   */
  function getResumeOnlyText(doc) {
    var root = doc.querySelector("#st-candidateView") || doc.body;
    if (!root) return "";
    var selectors = [
      "sr-resume-viewer",
      "sr-candidate-resume",
      "sr-resume",
      '[data-testid*="resume"]',
      '[data-testid*="Resume"]',
      '[class*="resume"]',
      '[id*="resume"]',
    ];
    var chunks = [];
    var minChunk = 30;

    function pushText(raw) {
      var t = (raw || "").replace(/\s+/g, " ").trim();
      if (t.length >= minChunk) chunks.push(t);
    }

    function collectFromEl(el) {
      if (!el) return;
      try {
        pushText(el.innerText || el.textContent || "");
        if (el.shadowRoot) {
          try {
            pushText(el.shadowRoot.innerText || el.shadowRoot.textContent || "");
            var deep = collectDeepText(el.shadowRoot, minChunk);
            for (var d = 0; d < deep.length; d++) chunks.push(deep[d]);
          } catch (_) {}
        }
      } catch (_) {}
    }

    for (var i = 0; i < selectors.length; i++) {
      try {
        var els = queryDeepSelectorAll(root, null, selectors[i]);
        for (var j = 0; j < els.length; j++) collectFromEl(els[j]);
      } catch (_) {}
    }

    // Also scan same-origin iframes so the readiness poll triggers correctly
    // when SR embeds the resume PDF viewer inside an <iframe>.
    try {
      var iframes = Array.from(doc.querySelectorAll("iframe"));
      for (var fi = 0; fi < iframes.length; fi++) {
        try {
          var fd = iframes[fi].contentDocument ||
                   (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
          if (!fd) continue;
          var ft = ((fd.body && fd.body.innerText) || (fd.body && fd.body.textContent) || "").trim();
          if (ft.length > 30) chunks.push(ft);
        } catch (_) {}
      }
    } catch (_) {}

    return chunks.join("\n\n");
  }

  /**
   * True when `text` is SR's candidate-summary sidebar / profile chrome rather than
   * the real resume PDF.  getResumeText's fullRoot fallback returns this ~1000-char
   * boilerplate ("Candidate summary · High priority skills X/8 · Other skills X/33 ·
   * See details · Order assessments") whenever the PDF text layer has not rendered.
   * It sneaks past a length-only retry gate, so we detect it by content instead and
   * force the resume wait to keep trying for the actual PDF.
   *
   * The markers below are SR UI strings that never appear inside a candidate's
   * resume, so a false positive on real resume text is effectively impossible.
   */
  function looksLikeSrSummaryChrome(text) {
    if (!text) return false;
    var t = String(text);
    var hits = 0;
    if (/candidate summary/i.test(t)) hits++;
    if (/\bOther skills\b|\bHigh priority skills\b/i.test(t)) hits++;
    if (/order assessments|no assessment orders/i.test(t)) hits++;
    if (/no tags added for this candidate/i.test(t)) hits++;
    if (/See details\b/i.test(t) && /View Profile\b/i.test(t)) hits++;
    return hits >= 2;
  }

  /**
   * True when we actually read the candidate's resume PDF — i.e. we have
   * substantial text that isn't SR's summary chrome. Used to set the note's
   * "partial scan" honesty flag: when this is false the resume PDF never
   * rendered, so missed keywords are uncertain (Ctrl+F couldn't see the page).
   * Shared by the keyword and boolean paths so they flag identically.
   */
  function resumeWasRead(resumeText, isChrome) {
    if (isChrome) return false;
    if (!resumeText) return false;
    return String(resumeText).replace(/\s+/g, "").length >= 50;
  }

  /**
   * Nudge the resume viewer to scroll through its full height. pdf.js renders text
   * layers lazily — only for pages near the viewport — so in a background worker tab
   * the lower pages of a multi-page resume never produce extractable spans until
   * scrolled into view. Scrolling every plausible resume/scroll container (across
   * shadow roots) forces those text layers to render.
   */
  function nudgeResumeViewerScroll(doc) {
    var root = doc.querySelector("#st-candidateView") || doc.body;
    if (!root) return;
    var selectors = ["sr-resume-viewer", "sr-candidate-resume", "sr-resume",
      '[data-testid*="resume"]', '[class*="resume"]', ".pdfViewer", '[class*="pdfViewer"]'];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var els = queryDeepSelectorAll(root, null, selectors[i]);
        for (var j = 0; j < els.length; j++) {
          var el = els[j];
          // Scroll the element itself and any scrollable ancestor through its height.
          for (var up = 0, node = el; node && up < 6; up++, node = node.parentElement || (node.getRootNode && node.getRootNode().host)) {
            try {
              if (node.scrollHeight && node.scrollHeight > node.clientHeight + 40) {
                node.scrollTop = node.scrollHeight;
                node.scrollTop = 0;
              }
            } catch (_) {}
          }
          try { el.scrollIntoView({ block: "end", behavior: "instant" }); } catch (_) {}
          try { el.scrollIntoView({ block: "start", behavior: "instant" }); } catch (_) {}
        }
      } catch (_) {}
    }
  }

  /**
   * Ask the background service worker to briefly foreground this (hidden worker) tab
   * so pdf.js will render the resume text layer. Returns true if focus was granted
   * (caller must then call releaseResumeRenderFocus). No-ops — and returns false —
   * when already visible (single-tab / foreground run) or outside the extension
   * (Node tests), so it is always safe to call.
   */
  function requestResumeRenderFocus(doc) {
    try {
      if (doc && doc.visibilityState === "visible") return Promise.resolve(false);
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
        return Promise.resolve(false);
      }
    } catch (_) { return Promise.resolve(false); }
    function sendFocusReq() {
      return new Promise(function (resolve) {
        try {
          chrome.runtime.sendMessage({ type: "srRequestResumeFocus" }, function (resp) {
            // null result (not an explicit ok:false) means the message dropped while
            // the MV3 worker was waking — signal a retryable miss.
            if (chrome.runtime.lastError) { resolve(null); return; }
            resolve(!!(resp && resp.ok));
          });
        } catch (_) { resolve(null); }
      });
    }
    return sendFocusReq().then(function (r) {
      if (r !== null) return r;          // got a definite answer
      return sleep(350).then(sendFocusReq).then(function (r2) { return r2 === null ? false : r2; });
    });
  }

  function releaseResumeRenderFocus() {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
      chrome.runtime.sendMessage({ type: "srReleaseResumeFocus" }, function () {
        // Touch lastError so Chrome doesn't log "unchecked runtime.lastError".
        try { void chrome.runtime.lastError; } catch (_) {}
      });
    } catch (_) {}
  }

  /**
   * Find the "Resume" / "Latest Resume" attachment link in the job-application
   * sidebar. Clicking it opens the full resume in a new tab (the background then
   * captures + closes it). Prefers "Latest Resume" (most recent upload).
   */
  function findResumeAttachmentLink(doc) {
    var root = doc.querySelector("#st-candidateView") || doc.body;
    if (!root) return null;
    var areas = queryDeepSelectorAll(root, null,
      "sr-attachments-v2, sr-attachments-container, sr-attachment-row, sr-job-application-sidebar");
    var searchRoots = areas.length ? areas : [root];
    var latest = null, plain = null, any = null;
    for (var i = 0; i < searchRoots.length; i++) {
      var links = queryDeepSelectorAll(searchRoots[i], null, "spl-link-button, a, [role='link'], button");
      for (var j = 0; j < links.length; j++) {
        var t = (getDeepText(links[j]) || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (t.length > 40 || t.indexOf("resume") < 0) continue;
        any = any || links[j];
        if (t.indexOf("latest resume") >= 0 && !latest) latest = links[j];
        else if (/^resume\b/.test(t) && !plain) plain = links[j];
      }
    }
    return latest || plain || any;
  }

  /**
   * Fallback when the inline resume viewer never renders: open the resume attachment
   * in a new tab (background captures its text and closes it). Returns the resume
   * text, or "" if unavailable. Only works inside the extension (no-ops in tests).
   */
  async function tryAttachmentResumeFallback(doc, win, log) {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return "";
      var link = findResumeAttachmentLink(doc);
      if (!link) { log.push({ ok: false, msg: "Fallback: resume attachment link not found" }); return ""; }
      // The MV3 service worker is usually asleep by the time this fallback fires
      // (~30s into a slow resume phase). The FIRST sendMessage after idle commonly
      // loses its response ("message port closed") while Chrome is still spinning the
      // worker back up — so capture the real lastError and retry once before giving up.
      var armErr = "";
      function sendArm() {
        return new Promise(function (resolve) {
          try {
            chrome.runtime.sendMessage({ type: "srArmResumeCapture" }, function (r) {
              if (chrome.runtime.lastError) { armErr = chrome.runtime.lastError.message || "message channel closed"; resolve(false); return; }
              resolve(!!(r && r.ok));
            });
          } catch (e) { armErr = (e && e.message) || String(e); resolve(false); }
        });
      }
      var armed = await sendArm();
      if (!armed) { await sleep(350); armErr = ""; armed = await sendArm(); } // retry once after waking the SW
      if (!armed) { log.push({ ok: false, msg: "Fallback: could not arm background capture" + (armErr ? " (" + armErr + ")" : "") }); return ""; }
      log.push({ ok: true, msg: "Fallback: opening resume attachment in a new tab to read the PDF" });
      try { link.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
      try { link.click(); } catch (_) { try { dispatchClickAtElementCenter(link, win, 0.5); } catch (_2) {} }
      var text = "";
      for (var w = 0; w < 24000; w += 600) {
        await sleep(600);
        var res = await new Promise(function (resolve) {
          try {
            chrome.runtime.sendMessage({ type: "srGetResumeCapture" }, function (r) {
              if (chrome.runtime.lastError) { resolve(null); return; }
              resolve(r || null);
            });
          } catch (_) { resolve(null); }
        });
        if (res && res.done) { text = res.text || ""; break; }
      }
      log.push({ ok: !!(text && text.length >= 300),
                 msg: "Fallback: resume tab returned " + (text ? text.length : 0) + " chars" });
      return text;
    } catch (e) {
      log.push({ ok: false, msg: "Fallback error: " + ((e && e.message) || String(e)) });
      return "";
    }
  }

  /**
   * Extract the candidate header — name, title, and top-bar info that is ALWAYS
   * visible regardless of which tab is active.  This is the fastest, most reliable
   * text source on the page and catches titles like "IAM SailPoint Developer".
   */
  function getCandidateHeaderText(doc) {
    var root = doc.querySelector("#st-candidateView") || doc.body;
    if (!root) return "";
    var selectors = [
      "sr-candidate-header",
      '[data-testid="candidate-header"]',
      '[data-testid*="candidateHeader"]',
      '[class*="candidate-header"]',
      '[class*="candidateHeader"]',
      '[class*="candidate-name"]',
      '[class*="candidateName"]',
      '[data-testid*="candidate-name"]',
      "sr-candidate-summary",
      '[class*="candidate-summary"]',
      '[class*="candidateSummary"]',
    ];
    var chunks = [];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var els = root.querySelectorAll(selectors[i]);
        for (var j = 0; j < els.length; j++) {
          var deep = collectDeepText(els[j], 10);
          for (var d = 0; d < deep.length; d++) chunks.push(deep[d]);
        }
      } catch (_) {}
    }
    if (!chunks.length) {
      try {
        var headings = root.querySelectorAll("h1, h2, h3");
        for (var hi = 0; hi < headings.length; hi++) {
          var ht = (headings[hi].innerText || headings[hi].textContent || "").replace(/\s+/g, " ").trim();
          if (ht.length >= 5 && ht.length < 200) chunks.push(ht);
        }
      } catch (_) {}
    }
    return chunks.join("\n\n");
  }

  /**
   * Extract just the candidate's name from the profile header.  Reuses the
   * name-specific selectors from getCandidateHeaderText (shadow-piercing), and
   * falls back to the first header chunk when no dedicated name element exists.
   */
  function getCandidateName(doc) {
    var root = doc.querySelector("#st-candidateView") || doc.body;
    if (!root) return "";
    // Primary: SR's stable applicant-name element. The #st-applicantName id does
    // not change across profiles, and its <spl-truncate> slot holds the full name.
    try {
      var applicant = null;
      try { applicant = doc.querySelector("#st-applicantName"); } catch (_) {}
      if (!applicant) applicant = findElementByIdDeep(doc.documentElement || doc.body, "st-applicantName");
      if (applicant) {
        var nameTxt = (applicant.innerText || applicant.textContent || "").replace(/\s+/g, " ").trim();
        if (nameTxt.length >= 2 && nameTxt.length < 120) return nameTxt;
      }
    } catch (_) {}
    var nameSelectors = [
      '[class*="candidate-name"]',
      '[class*="candidateName"]',
      '[data-testid*="candidate-name"]',
    ];
    for (var i = 0; i < nameSelectors.length; i++) {
      try {
        var els = queryDeepSelectorAll(root, null, nameSelectors[i]);
        for (var j = 0; j < els.length; j++) {
          var t = (els[j].innerText || els[j].textContent || "").replace(/\s+/g, " ").trim();
          if (t.length >= 2 && t.length < 120) return t;
        }
      } catch (_) {}
    }
    // Fallback: the first chunk of the header blob is usually the name.
    try {
      var header = getCandidateHeaderText(doc);
      if (header) {
        var first = header.split("\n\n")[0].replace(/\s+/g, " ").trim();
        if (first.length >= 2 && first.length < 120) return first;
      }
    } catch (_) {}
    return "";
  }

  /**
   * Extract text from pdf.js text layers — SR sometimes renders resumes via
   * pdf.js which overlays <span> elements on a <canvas>.  The canvas itself
   * is pixels (invisible to innerText) but the text layer spans are real DOM.
   */
  function getPdfTextLayerText(doc) {
    var chunks = [];
    var pdfRoot = doc.querySelector("#st-candidateView") || doc.body || doc.documentElement;
    var selectors = [
      ".textLayer span",
      '[class*="textLayer"] span',
      '[class*="text-layer"] span',
      ".pdfViewer .page .textLayer span",
    ];
    // These selectors overlap heavily (".textLayer span" ⊆ "[class*=textLayer] span"
    // ⊆ ".pdfViewer .page .textLayer span"), so iterating each and pushing a chunk
    // re-captured the SAME spans 2-3× and inflated occurrence counts. Collect the
    // union of unique elements once instead.
    var seenSpan = (typeof Set === "function") ? new Set() : null;
    var uParts = [];
    for (var si = 0; si < selectors.length; si++) {
      try {
        // Pierce shadow roots — pdf.js text layers live inside sr-resume-viewer's shadow DOM.
        var spans = queryDeepSelectorAll(pdfRoot, null, selectors[si]);
        for (var i = 0; i < spans.length; i++) {
          if (seenSpan) {
            if (seenSpan.has(spans[i])) continue;
            seenSpan.add(spans[i]);
          }
          var t = (spans[i].textContent || "").trim();
          if (t) uParts.push(t);
        }
      } catch (_) {}
    }
    if (uParts.length > 20) chunks.push(uParts.join(" "));
    try {
      var iframes = Array.from(doc.querySelectorAll("iframe"));
      for (var fi = 0; fi < iframes.length; fi++) {
        try {
          var fd = iframes[fi].contentDocument ||
                   (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
          if (!fd) continue;
          var seenSpan2 = (typeof Set === "function") ? new Set() : null;
          var parts2 = [];
          for (var si2 = 0; si2 < selectors.length; si2++) {
            var spans2 = fd.querySelectorAll(selectors[si2]);
            for (var j = 0; j < spans2.length; j++) {
              if (seenSpan2) {
                if (seenSpan2.has(spans2[j])) continue;
                seenSpan2.add(spans2[j]);
              }
              var t2 = (spans2[j].textContent || "").trim();
              if (t2) parts2.push(t2);
            }
          }
          if (parts2.length > 20) chunks.push(parts2.join(" "));
        } catch (_) {}
      }
    } catch (_) {}
    return chunks.join("\n\n");
  }

  function getProfileOverviewText(doc) {
    var root = doc.querySelector("#st-candidateView") || doc.body;
    if (!root) return "";
    var selectors = [
      '[data-testid*="profile"]',
      '[data-testid*="Profile"]',
      '[class*="profile"]',
      '[id*="profile"]',
      '[data-testid*="overview"]',
      '[class*="overview"]',
      '[class*="skills"]',
      '[class*="summary"]',
      '[class*="experience"]',
      '[class*="education"]',
      "sr-candidate-profile",
      "sr-candidate-details",
      "sr-candidate-overview",
    ];
    var chunks = [];

    for (var i = 0; i < selectors.length; i++) {
      try {
        var els = queryDeepSelectorAll(root, null, selectors[i]);
        for (var j = 0; j < els.length; j++) {
          var deep = collectDeepText(els[j], 30);
          for (var d = 0; d < deep.length; d++) chunks.push(deep[d]);
        }
      } catch (_) {}
    }
    return chunks.join("\n\n");
  }

  function getFullPageText(doc) {
    var root = doc.querySelector("#st-candidateView") || doc.body || doc.documentElement;
    if (!root) return "";
    var deep = collectDeepText(root, 20);
    if (deep.length) return deep.join("\n\n");
    return (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim();
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

  async function ensureResumeTabActive(doc, win) {
    var tabSelectors = [
      'button[data-testid="resume-tab"]',
      'button[data-testid="Resume"]',
      '[role="tab"]',
      'a[href*="resume"]',
      'button',
    ];
    var root = doc.querySelector("#st-candidateView") || doc.body;
    if (!root) return false;

    function findResumeTab(r) {
      for (var s = 0; s < tabSelectors.length; s++) {
        try {
          var els = r.querySelectorAll(tabSelectors[s]);
          for (var i = 0; i < els.length; i++) {
            var txt = (els[i].textContent || els[i].innerText || "").trim().toLowerCase();
            if (txt.includes("resume") || txt.includes("résumé") || txt === "cv") return els[i];
          }
        } catch (_) {}
      }
      var visited = new Set();
      var found = null;
      function walkSR(node) {
        if (!node || visited.has(node) || found) return;
        visited.add(node);
        if (node.nodeType === 1) {
          var t = (node.textContent || "").trim().toLowerCase();
          if ((t.includes("resume") || t.includes("résumé") || t === "cv") &&
              (node.tagName === "BUTTON" || node.tagName === "A" ||
               (node.getAttribute && node.getAttribute("role") === "tab"))) {
            found = node;
            return;
          }
        }
        if (node.shadowRoot) walkSR(node.shadowRoot);
        if (node.childNodes) {
          for (var c = 0; c < node.childNodes.length; c++) walkSR(node.childNodes[c]);
        }
      }
      walkSR(r);
      return found;
    }

    var tab = findResumeTab(root);
    if (!tab) return false;

    try {
      tab.scrollIntoView({ block: "center", behavior: "instant" });
      await sleep(100);
      tab.click();
      // No fixed sleep here — caller uses makeResumeTextWaiter (started before this click)
      // to react to DOM content appearing rather than waiting a fixed interval.
    } catch (_) {}
    return true;
  }

  /**
   * Returns a Promise that resolves to the full resume text as soon as the resume
   * viewer has ≥200 chars of content, or to whatever is available when maxMs expires.
   *
   * Start this BEFORE calling ensureResumeTabActive so the MutationObserver is
   * already watching when the tab click triggers SR's SPA to mount the PDF viewer.
   * This avoids the race window where a very fast render could be missed.
   *
   * Uses an 80 ms debounce on observer callbacks so rapid SPA re-renders don't
   * spam getResumeOnlyText (which does shadow-DOM traversal) on every mutation.
   * A 500 ms fallback poll catches anything the observer might miss.
   */
  var PDF_SETTLE_MS = 800;

  function makeResumeTextWaiter(doc, maxMs) {
    return new Promise(function (resolve) {
      var done = false;
      var pdfLen = 0, pdfChangedAt = 0;

      function finish(pdfText) {
        if (done) return;
        done = true;
        if (obs) obs.disconnect();   // unset when the immediate first check() finishes
        clearTimeout(timer);
        clearInterval(fallbackPoll);
        var text = pdfText || "";
        if (!text) { try { text = getResumeText(doc); } catch (_) {} }
        resolve(text);
      }

      function check() {
        if (done) return;
        var preview = "";
        try { preview = getResumeOnlyText(doc); } catch (_) {}
        // Resolve only on real resume text — never on SR's summary chrome, which can
        // appear inside the resume-viewer selectors before pdf.js renders the PDF.
        if (preview && preview.length >= 200 && !looksLikeSrSummaryChrome(preview)) { finish(); return; }
        // On live SR pages the viewer selectors also match the summary sidebar, so the
        // preview reads as chrome even after the PDF has rendered. The pdf.js text layer
        // holds only the PDF's own text: resolve once it has ≥200 chars and has stopped
        // growing for PDF_SETTLE_MS (later pages render lazily, nudged by scrolling).
        var pdf = "";
        try { pdf = getPdfTextLayerText(doc); } catch (_) {}
        var len = pdf.length;
        if (len < 200) return;
        var now = Date.now();
        if (len !== pdfLen) {
          pdfLen = len;
          pdfChangedAt = now;
          try { nudgeResumeViewerScroll(doc); } catch (_) {}
          return;
        }
        if (now - pdfChangedAt >= PDF_SETTLE_MS) finish(pdf);
      }

      // Immediate check — content may already be present (e.g. tab was already active).
      check();
      if (done) return;

      var root = doc.querySelector("#st-candidateView") || doc.body || doc.documentElement;
      var pending = false;
      var obs = new MutationObserver(function () {
        if (pending || done) return;
        pending = true;
        setTimeout(function () { pending = false; check(); }, 80);
      });
      obs.observe(root, { childList: true, subtree: true, characterData: true });

      // Fallback poll — safety net in case observer misses a mutation.
      var fallbackPoll = setInterval(check, 500);

      var timer = setTimeout(function () { if (!done) finish(); }, maxMs);
    });
  }

  async function ensureProfileTabActive(doc, win) {
    var root = doc.querySelector("#st-candidateView") || doc.body;
    if (!root) return false;

    function findProfileTab(r) {
      var visited = new Set();
      var found = null;
      function walkSR(node) {
        if (!node || visited.has(node) || found) return;
        visited.add(node);
        if (node.nodeType === 1) {
          var t = (node.textContent || "").trim().toLowerCase();
          if ((t === "profile" || t.startsWith("profile")) &&
              (node.tagName === "BUTTON" || node.tagName === "A" ||
               (node.getAttribute && node.getAttribute("role") === "tab"))) {
            found = node;
            return;
          }
        }
        if (node.shadowRoot) walkSR(node.shadowRoot);
        if (node.childNodes) {
          for (var c = 0; c < node.childNodes.length; c++) walkSR(node.childNodes[c]);
        }
      }
      walkSR(r);
      return found;
    }

    var tab = findProfileTab(root);
    if (!tab) return false;
    try {
      tab.scrollIntoView({ block: "center", behavior: "instant" });
      await sleep(100);
      tab.click();
      await sleep(500);
    } catch (_) {}
    return true;
  }

  /* ── Keyword matching (ported from req.py find_keyword_hits) ── */

  function sepFlexiblePatternSource(kwNorm, withSuffix) {
    var tokens = kwNorm.match(/[A-Za-z]+|\d+/g);
    if (!tokens || !tokens.length) return "";
    var mid = "[\\W_]*";
    var body = tokens
      .map(function (t) {
        return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join(mid);
    if (!body) return "";
    var trailingBoundary = withSuffix
      ? "(?:e?s|ed|ing)?(?![A-Za-z0-9])"
      : "(?![A-Za-z0-9])";
    return "(?<![A-Za-z0-9])" + body + trailingBoundary;
  }

  /** ISO list heuristic: "ISO Standard (9001, 45001)" matches keyword "ISO 45001".
   *  Uses a proximity window because normalizeForKw strips newlines from hay. */
  function isoListHit(hay, num) {
    if (!num) return false;
    var numStr = String(num);
    var numRxSrc;
    try {
      var esc = numStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      numRxSrc = "(?<!\\d)" + esc + "(?!\\d)";
    } catch (_) {
      return false;
    }
    var isoRx = /\bISO\b/gi;
    var numRx;
    try { numRx = new RegExp(numRxSrc, "i"); } catch (_) { return false; }
    var WINDOW = 200;
    var m;
    while ((m = isoRx.exec(hay)) !== null) {
      var start = Math.max(0, m.index - 20);
      var end = Math.min(hay.length, m.index + WINDOW);
      if (numRx.test(hay.slice(start, end))) return true;
    }
    return false;
  }

  /**
   * Build unigram / bigram / trigram count maps from normalised haystack text.
   *
   * CamelCase tokens are split before indexing so expansion forms like "tensor flow"
   * and "py torch" match resume text written as "TensorFlow" / "PyTorch":
   *   "TensorFlow" → ["tensor","flow"]   "PyTorch" → ["py","torch"]
   *
   * Tokens are lowercased and split on every non-alphanumeric character, so
   * "tf.keras" → ["tf","keras"], "ci/cd" → ["ci","cd"], "k8s" → ["k8s"].
   */
  function buildTokenIndex(hay) {
    var split = hay
      .replace(/([a-z\d])([A-Z])/g,        "$1 $2")   // fooBar  → foo Bar
      .replace(/([A-Z]{2,})([A-Z][a-z])/g, "$1 $2");  // ABCDef  → ABC Def

    var rawParts = split.toLowerCase().split(/[^a-z0-9]+/);
    var tokens = [];
    for (var ti = 0; ti < rawParts.length; ti++) {
      if (rawParts[ti]) tokens.push(rawParts[ti]);
    }

    var uni = Object.create(null);  // token            → count
    var bi  = Object.create(null);  // "t1\x00t2"       → count
    var tri = Object.create(null);  // "t1\x00t2\x00t3" → count

    for (var i = 0; i < tokens.length; i++) {
      var a = tokens[i];
      uni[a] = (uni[a] || 0) + 1;
      if (i + 1 < tokens.length) {
        var b = tokens[i + 1];
        var kb = a + "\x00" + b;
        bi[kb] = (bi[kb] || 0) + 1;
        if (i + 2 < tokens.length) {
          var c = tokens[i + 2];
          tri[kb + "\x00" + c] = (tri[kb + "\x00" + c] || 0) + 1;
        }
      }
    }
    return { uni: uni, bi: bi, tri: tri };
  }

  // Suffix variants mirror the (?:e?s|ed|ing)? suffix in sepFlexiblePatternSource
  // so "publications" matches keyword "publication", "researching" matches "research", etc.
  var _KW_SFX = ["", "s", "es", "ed", "ing"];

  /**
   * Look up a normalised keyword in the token index.
   * Returns hit count (≥1), 0 (not found), or -1 (needs regex — 4+ token phrase
   * or multi-token wildcard the index can't resolve directly).
   */
  function kwHitsInIndex(kwNorm, idx, isWildcard) {
    var toks = kwNorm.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!toks.length) return 0;

    // Wildcard: iterate unigrams for any token that starts with the prefix.
    if (isWildcard) {
      if (toks.length !== 1) return -1; // multi-token wildcard → regex
      var pref = toks[0];
      var wTotal = 0;
      for (var wt in idx.uni) {
        if (wt.length >= pref.length && wt.substring(0, pref.length) === pref) {
          wTotal += idx.uni[wt];
        }
      }
      return wTotal;
    }

    if (toks.length === 1) {
      var stem = toks[0];
      var uTotal = 0;
      for (var si = 0; si < _KW_SFX.length; si++) {
        uTotal += idx.uni[stem + _KW_SFX[si]] || 0;
      }
      return uTotal;
    }

    if (toks.length === 2) {
      var base2 = toks[0] + "\x00" + toks[1];
      if (idx.bi[base2]) return idx.bi[base2];
      for (var si2 = 1; si2 < _KW_SFX.length; si2++) {
        var k2 = toks[0] + "\x00" + toks[1] + _KW_SFX[si2];
        if (idx.bi[k2]) return idx.bi[k2];
      }
      return 0;
    }

    if (toks.length === 3) {
      var base3 = toks[0] + "\x00" + toks[1] + "\x00" + toks[2];
      if (idx.tri[base3]) return idx.tri[base3];
      for (var si3 = 1; si3 < _KW_SFX.length; si3++) {
        var k3 = toks[0] + "\x00" + toks[1] + "\x00" + toks[2] + _KW_SFX[si3];
        if (idx.tri[k3]) return idx.tri[k3];
      }
      return 0;
    }

    return -1; // 4+ token phrase → regex fallback
  }

  /**
   * @param {string|string[]} texts - haystack(s); joined with space then normalised
   * @param {string[]} keywords
   * @param {{ maxItems?: number, scanEveryKeyword?: boolean }} opts
   */
  function findKeywordHits(texts, keywords, opts) {
    opts = opts || {};
    var rawCap = parseInt(opts.maxItems, 10);
    var maxItems = Number.isFinite(rawCap) && rawCap > 0 ? Math.min(15000, rawCap) : 50;
    var scanEveryKeyword = !!(opts && opts.scanEveryKeyword);
    var joined =
      typeof texts === "string"
        ? texts
        : Array.isArray(texts)
          ? texts.filter(Boolean).join(" ")
          : "";
    var hay = normalizeForKw(joined);
    if (!hay) return { hits: [], hitCount: 0 };

    // Build token index once — all keyword lookups in this call share it.
    var idx = buildTokenIndex(hay);

    var found = [];
    var seenLower = {};

    for (var i = 0; i < keywords.length; i++) {
      if (!scanEveryKeyword && found.length >= maxItems) break;
      var kwDisp = (keywords[i] || "").trim();
      if (!kwDisp) continue;
      var kwKey = kwDisp;
      if (kwKey.charAt(0) === "(" && kwKey.charAt(kwKey.length - 1) === ")") {
        var inner2 = kwKey.slice(1, -1).trim();
        if (inner2) kwKey = inner2;
      }
      var kwNorm = normalizeForKw(kwKey);
      if (!kwNorm) continue;

      // Trailing * = prefix wildcard (LinkedIn-style)
      var isWildcard = kwNorm.charAt(kwNorm.length - 1) === "*";
      if (isWildcard) {
        kwNorm = kwNorm.slice(0, -1).replace(/\s+$/, "");
        if (!kwNorm) continue;
      }

      var count = 0;
      var idxResult = kwHitsInIndex(kwNorm, idx, isWildcard);

      if (idxResult > 0) {
        count = idxResult;
      } else if (idxResult === -1 || idxResult === 0) {
        // -1: 4+ token phrase or multi-token wildcard.
        // 0: 1–3 token keyword not found in token index — try separator-flexible
        //    regex to catch compound forms like "gpt4" matching "GPT-4".
        var src = sepFlexiblePatternSource(kwNorm, !isWildcard);
        if (isWildcard && src) {
          var tail = "(?![A-Za-z0-9])";
          var tailIdx = src.lastIndexOf(tail);
          if (tailIdx >= 0) src = src.slice(0, tailIdx) + "[A-Za-z0-9]*";
        }
        if (src) {
          try {
            var rx = new RegExp(src, "gi");
            var m = hay.match(rx);
            count = m ? m.length : 0;
          } catch (_) {
            count = 0;
          }
        }
      }

      // ISO list heuristic: "ISO Standard 9001, 45001" — number not adjacent to ISO token.
      if (count === 0) {
        var toks = kwNorm.match(/[A-Za-z]+|\d+/g);
        if (toks && toks.length && toks[0].toLowerCase() === "iso") {
          var num = "";
          for (var t = 1; t < toks.length; t++) {
            if (/^\d+$/.test(toks[t])) { num = toks[t]; break; }
          }
          if (num && isoListHit(hay, num)) count = 1;
        }
      }

      if (count > 0) {
        var keyL = kwDisp.toLowerCase();
        if (!seenLower[keyL]) {
          seenLower[keyL] = true;
          found.push({ keyword: kwDisp, count: count });
        }
      }
    }
    return { hits: found, hitCount: found.length };
  }

  /**
   * Collapse expansion aliases back to the canonical (user-typed) keyword.
   *
   * When resolveKeywordsWithMeta expands "pytorch" into "py torch", "torch", etc.,
   * all those aliases may match the same occurrences in the text. This function
   * folds them into one entry under the canonical name, taking the MAX count
   * across the group so the count reflects the strongest signal.
   *
   * If a form has no entry in canonicalMap it is treated as its own canonical.
   * Pass null/undefined canonicalMap to skip deduplication (no-op passthrough).
   */
  function deduplicateHitsByCanonical(hits, canonicalMap) {
    if (!canonicalMap) return hits;
    var groups = Object.create(null);
    var order = [];
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var canon = canonicalMap[h.keyword.toLowerCase()] || h.keyword;
      var cl = canon.toLowerCase();
      if (!groups[cl]) {
        groups[cl] = { keyword: canon, count: 0 };
        order.push(cl);
      }
      if (h.count > groups[cl].count) groups[cl].count = h.count;
    }
    return order.map(function (cl) { return groups[cl]; });
  }

  /**
   * Per-canonical occurrence counts computed from the RESUME text alone.
   *
   * Displayed counts ("phd (x25)") get inflated when an expansion alias such as
   * "doctorate" matches SR's repeated profile/skill chrome. Counting against the
   * resume only — which never contains that chrome — yields the true number of
   * times the candidate's resume mentions the keyword.
   *
   * Returns a map { canonicalLower: count }, or null when there is no real resume
   * (sparse, or SR summary chrome) so the caller falls back to the union count.
   */
  function countsFromResume(resumeText, keywords, canonicalMap) {
    if (!resumeText || resumeText.length < 300) return null;
    if (looksLikeSrSummaryChrome(resumeText)) return null;
    var clean = normalizeForKw(collapseInlineRepeats(dedupeTextSegments(resumeText)));
    if (!clean) return null;
    var hits = findKeywordHits(clean, keywords).hits;
    var deduped = deduplicateHitsByCanonical(hits, canonicalMap);
    var map = Object.create(null);
    for (var i = 0; i < deduped.length; i++) map[deduped[i].keyword.toLowerCase()] = deduped[i].count;
    return map;
  }

  /* ── Boolean search parser (LinkedIn Recruiter–style syntax) ── */

  function tokenizeBoolean(input) {
    var tokens = [];
    var i = 0;
    var s = String(input || "");
    while (i < s.length) {
      if (/\s/.test(s[i])) {
        i++;
        continue;
      }
      if (s[i] === '"' || s[i] === "\u201C" || s[i] === "\u201D") {
        var closeChars = ['"', "\u201C", "\u201D"];
        i++;
        var start = i;
        while (i < s.length && closeChars.indexOf(s[i]) < 0) i++;
        var phrase = s.slice(start, i).trim();
        if (i < s.length) i++;
        if (phrase) tokens.push({ type: "PHRASE", value: phrase });
        continue;
      }
      if (s[i] === "(") {
        tokens.push({ type: "LPAREN" });
        i++;
        continue;
      }
      if (s[i] === ")") {
        tokens.push({ type: "RPAREN" });
        i++;
        continue;
      }
      var wStart = i;
      while (i < s.length && !/\s/.test(s[i]) && s[i] !== "(" && s[i] !== ")" && s[i] !== '"' && s[i] !== "\u201C" && s[i] !== "\u201D")
        i++;
      var word = s.slice(wStart, i);
      if (!word) continue;
      var upper = word.toUpperCase();
      if (upper === "AND") tokens.push({ type: "AND" });
      else if (upper === "OR") tokens.push({ type: "OR" });
      else if (upper === "NOT") tokens.push({ type: "NOT" });
      else tokens.push({ type: "TERM", value: word });
    }
    return tokens;
  }

  function parseBooleanQuery(input) {
    var tokens = tokenizeBoolean(input);
    var pos = 0;

    function peek() {
      return pos < tokens.length ? tokens[pos] : null;
    }
    function consume() {
      return tokens[pos++];
    }

    function parseOr() {
      var left = parseAnd();
      while (peek() && peek().type === "OR") {
        consume();
        var right = parseAnd();
        left = { type: "OR", left: left, right: right };
      }
      return left;
    }

    function parseAnd() {
      var left = parseNot();
      while (peek()) {
        var t = peek();
        if (t.type === "AND") {
          consume();
          var right = parseNot();
          left = { type: "AND", left: left, right: right };
        } else if (t.type === "TERM" || t.type === "PHRASE" || t.type === "LPAREN" || t.type === "NOT") {
          var right2 = parseNot();
          left = { type: "AND", left: left, right: right2 };
        } else {
          break;
        }
      }
      return left;
    }

    function parseNot() {
      if (peek() && peek().type === "NOT") {
        consume();
        var operand = parseAtom();
        return { type: "NOT", operand: operand };
      }
      return parseAtom();
    }

    function parseAtom() {
      var t = peek();
      if (!t) return { type: "TERM", value: "" };

      if (t.type === "LPAREN") {
        consume();
        var expr = parseOr();
        if (peek() && peek().type === "RPAREN") consume();
        return expr;
      }

      if (t.type === "PHRASE") {
        consume();
        return { type: "TERM", value: t.value, quoted: true };
      }

      if (t.type === "TERM") {
        consume();
        return { type: "TERM", value: t.value };
      }

      consume();
      return { type: "TERM", value: "" };
    }

    if (!tokens.length) return { type: "TERM", value: "" };
    return parseOr();
  }

  function extractLeafTerms(ast, negated) {
    negated = !!negated;
    if (!ast) return [];
    if (ast.type === "TERM") {
      if (!ast.value) return [];
      return [{ value: ast.value, negated: negated }];
    }
    if (ast.type === "NOT") {
      return extractLeafTerms(ast.operand, true);
    }
    if (ast.type === "AND" || ast.type === "OR") {
      return extractLeafTerms(ast.left, negated).concat(extractLeafTerms(ast.right, negated));
    }
    return [];
  }

  function evaluateBooleanAst(ast, matchedSet) {
    if (!ast) return false;
    if (ast.type === "TERM") {
      var key = (ast.value || "").toLowerCase();
      return !!matchedSet[key];
    }
    if (ast.type === "NOT") {
      return !evaluateBooleanAst(ast.operand, matchedSet);
    }
    if (ast.type === "AND") {
      return evaluateBooleanAst(ast.left, matchedSet) && evaluateBooleanAst(ast.right, matchedSet);
    }
    if (ast.type === "OR") {
      return evaluateBooleanAst(ast.left, matchedSet) || evaluateBooleanAst(ast.right, matchedSet);
    }
    return false;
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

  /* ── Post keyword hits to the Notes tab on the prospect profile ── */

  /* ── Notes helpers ── */

  function findNotesTab(doc, win) {
    var root = doc.body || doc.documentElement;
    var candidates = [];
    try { candidates = candidates.concat(Array.from(doc.querySelectorAll("a > spl-tab-label > div"))); } catch (_) {}
    try { candidates = candidates.concat(Array.from(doc.querySelectorAll("a > spl-tab-label"))); } catch (_) {}
    try { candidates = candidates.concat(Array.from(doc.querySelectorAll('[role="tab"]'))); } catch (_) {}
    try { candidates = candidates.concat(queryDeepSelectorAll(root, win, "spl-tab-label")); } catch (_) {}
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
    return null;
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
            if (node.matches('[contenteditable="true"], div[role="textbox"]')) out.push(node);
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
    try { sec = doc.querySelector("#st-notes"); } catch (_) {}
    // #st-notes may be a <spl-tab> (tab button) rather than the notes form panel.
    // When it's a tab, the form lives elsewhere — return null so callers fall back to body.
    if (sec) {
      var stag = (sec.tagName || "").toLowerCase();
      if (stag === "spl-tab" || (sec.getAttribute && sec.getAttribute("role") === "tab")) sec = null;
    }
    if (!sec) try { sec = doc.querySelector('[data-test="notes"]'); } catch (_) {}
    if (!sec) try { sec = doc.querySelector("sr-notes"); } catch (_) {}
    if (!sec) try { sec = doc.querySelector("app-notes"); } catch (_) {}
    if (!sec) {
      try {
        var deep = findElementByIdDeep(doc.documentElement || doc.body, "st-notes");
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
              if (node.matches('[contenteditable="true"], div[role="textbox"]') && isVisible(node, win))
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
            try { if (node.closest && node.closest("spl-dropdown")) skip = true; } catch (_) {}
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

  function getDeepText(el) {
    var t = "";
    try { t = (el.textContent || el.innerText || "").replace(/\s+/g, " ").trim(); } catch (_) {}
    if (!t && el.shadowRoot) {
      try { t = (el.shadowRoot.textContent || "").replace(/\s+/g, " ").trim(); } catch (_) {}
    }
    return t.toLowerCase();
  }

  function findNotesPostButton(doc, win) {
    // Pass 1: search all spl-form-element containers (ID index varies per page load)
    var formEls = doc.querySelectorAll('[id^="spl-form-element_"]');
    for (var fi = 0; fi < formEls.length; fi++) {
      try {
        var allBtns = formEls[fi].querySelectorAll("spl-button");
        for (var b = 0; b < allBtns.length; b++) {
          if (!isVisible(allBtns[b], win)) continue;
          if (allBtns[b].closest && allBtns[b].closest("spl-dropdown")) continue;
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
      if (deepBtns[i].closest && deepBtns[i].closest("spl-dropdown")) continue;
      var dtxt = getDeepText(deepBtns[i]);
      if (/^post$/i.test(dtxt)) return deepBtns[i];
    }
    // Pass 3: if notes section was too narrow, search full body
    if (notesSection) {
      var bodyBtns = findAllDeepButtons(doc.body || doc.documentElement, win);
      for (var j = 0; j < bodyBtns.length; j++) {
        if (isDisabledish(bodyBtns[j])) continue;
        if (bodyBtns[j].closest && bodyBtns[j].closest("spl-dropdown")) continue;
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

  function formatNoteText(hitLabels, hitCount, totalKeywords, notePrefix, candidateName, profileUrl, partialScan) {
    var body = (hitCount === 0 || !hitLabels || !hitLabels.length)
      ? "No keyword tagged"
      : hitLabels.join(", ");
    var summary = (notePrefix || "") + body + " - Matched " + hitCount + "/" + totalKeywords;
    if (partialScan) summary += "\n" + PARTIAL_SCAN_WARNING;
    // SR notes are plain-text, so name + URL go in as a plain header line (no markup).
    var header = [candidateName, profileUrl].filter(function (p) { return p; }).join(" | ");
    return header ? header + "\n" + summary : summary;
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
  function formatNoteHtml(hitLabels, hitCount, totalKeywords, notePrefix, candidateName, profileUrl, partialScan) {
    var body = (hitCount === 0 || !hitLabels || !hitLabels.length)
      ? "No keyword tagged"
      : hitLabels.join(", ");
    var summary = escapeHtml((notePrefix || "") + body + " - Matched " + hitCount + "/" + totalKeywords);
    if (partialScan) summary += "<br>" + escapeHtml(PARTIAL_SCAN_WARNING);
    var parts = [];
    if (candidateName) parts.push(escapeHtml(candidateName));
    if (profileUrl) parts.push('<a href="' + escapeHtml(profileUrl) + '">SR Profile</a>');
    var header = parts.join(" | ");
    return header ? header + "<br>" + summary : summary;
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
   * Distinctive, render-stable marker for a just-composed note: the matched
   * keyword body (or "No keyword tagged"), normalised and capped. The matched
   * keyword list is profile-specific, so its appearance in the notes feed is a
   * reliable "this note saved and rendered" signal — unlike a URL substring or
   * the compose field clearing, neither of which fires for SR's div editor.
   */
  function noteConfirmMarker(hitLabels, hitCount) {
    var body = (!hitCount || !hitLabels || !hitLabels.length)
      ? "No keyword tagged"
      : hitLabels.join(", ");
    return _normNoteText(body).slice(0, 60);
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
      var menus = doc.querySelectorAll("[id^='spl-dropdown-menu']");
      for (var i = 0; i < menus.length; i++) {
        var r = menus[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    } catch (_) {}
    return false;
  }

  /** Find the "Note to self" item from any visible dropdown menu. */
  function findNoteToSelfItem(doc) {
    var menus = doc.querySelectorAll("[id^='spl-dropdown-menu']");
    for (var m = 0; m < menus.length; m++) {
      var items = menus[m].querySelectorAll("spl-dropdown-item");
      for (var i = 0; i < items.length; i++) {
        if (/note\s*to\s*self/i.test(getDeepText(items[i]))) return items[i];
      }
      if (items.length >= 3) return items[2];
    }
    var loose = doc.querySelectorAll("spl-dropdown-item");
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
    var formEls = doc.querySelectorAll('[id^="spl-form-element_"]');
    for (var fi = 0; fi < formEls.length && !splBtn; fi++) {
      try {
        var dds = formEls[fi].querySelectorAll("spl-dropdown");
        for (var di = 0; di < dds.length; di++) {
          var dd = dds[di];
          if (!isVisible(dd, win)) continue;
          var ddText = getDeepText(dd);
          if (/\bnote\b/i.test(ddText)) {
            var btn = dd.querySelector("spl-button");
            if (btn) { splBtn = btn; break; }
          }
        }
      } catch (_) {}
    }
    // Fallback: deep search entire body for note-type dropdown
    if (!splBtn) {
      var ddSearchRoot = doc.body || doc.documentElement;
      var allDds = queryDeepSelectorAll(ddSearchRoot, win, "spl-dropdown");
      for (var di2 = 0; di2 < allDds.length; di2++) {
        if (!isVisible(allDds[di2], win)) continue;
        var ddText2 = getDeepText(allDds[di2]);
        if (/\bnote\b/i.test(ddText2)) {
          var btn2 = allDds[di2].querySelector("spl-button");
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
    try { inner = noteItem.querySelector("div > spl-icon"); } catch (_) {}
    if (!inner) { try { inner = noteItem.querySelector("div > div > spl-typography-body"); } catch (_) {} }
    if (!inner) { try { inner = noteItem.querySelector("div"); } catch (_) {} }

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
      log.push({ ok: false, msg: "Notes: tab element not found in DOM — cannot open notes" });
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
        log.push({ ok: false, msg: "Notes: tab not found in DOM during post attempt" });
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
    var noteText = formatNoteText(hitLabels, hitCount, totalKeywords, notePrefix, candidateName, profileUrl, partialScan);
    var itag = (input.tagName || "").toLowerCase();
    var isRichEditor = (itag !== "textarea" && itag !== "input");

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
        var noteHtml = formatNoteHtml(hitLabels, hitCount, totalKeywords, notePrefix, candidateName, profileUrl, partialScan);
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
      if (curVal.indexOf("Matched") < 0) {
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
    if (!finalInputVal || finalInputVal.indexOf("Matched") < 0) {
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
    var noteMarker = noteConfirmMarker(hitLabels, hitCount);
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

  /* ── Per-profile diagnostics: capture extracted text + matched/missed keywords ── */

  var DIAG_KEY_PREFIX = "lastRunDiag_";
  var DIAG_MAX_ENTRIES = 20;
  var DIAG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // GDPR storage limitation (Art. 5(1)(e)): 7-day TTL
  var DIAG_TEXT_CAP = 50 * 1024;      // 50 KB — full normalized allText
  var DIAG_SOURCE_CAP = 15 * 1024;    // 15 KB per individual source

  function capText(s, maxChars) {
    if (s == null) return "";
    s = String(s);
    if (s.length <= maxChars) return s;
    var extra = s.length - maxChars;
    return s.slice(0, maxChars) + "\n...[truncated +" + extra + " chars]";
  }

  /**
   * GDPR data-minimization gate (Art. 5(1)(c)). Resolves to the recruiter/dev's
   * `srDiagRawCapture` setting in chrome.storage.local. Default FALSE: raw candidate
   * text (resume, screening answers) is NOT persisted. Flip to true only while actively
   * debugging a keyword miss, then flip back. Resolves false in the Node test harness.
   */
  function getDiagRawCapture() {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return resolve(false);
        chrome.storage.local.get(["srDiagRawCapture"], function (r) {
          try { chrome.runtime && chrome.runtime.lastError; } catch (_) {}
          resolve(!!(r && r.srDiagRawCapture === true));
        });
      } catch (_) { resolve(false); }
    });
  }

  /**
   * Strip raw candidate text from a diagnostic entry unless raw capture is enabled.
   * When `rawCapture` is false (the default), drops `extractedText`, blanks every
   * `textSources.*` value, and removes raw-text log lines (TEXT_SAMPLE / salary "A:")
   * while preserving all debugging metadata (text lengths, keyword lists, timing).
   * Pure + exported for unit testing.
   */
  function sanitizeDiagEntry(entry, rawCapture) {
    if (rawCapture === true) return entry;
    if (!entry || typeof entry !== "object") return entry;
    var clean = Object.assign({}, entry);
    clean.rawCaptured = false;
    if ("extractedText" in clean) clean.extractedText = "";
    if (clean.textSources && typeof clean.textSources === "object") {
      var src = {};
      for (var k in clean.textSources) {
        if (Object.prototype.hasOwnProperty.call(clean.textSources, k)) src[k] = "";
      }
      clean.textSources = src;
    }
    if (Array.isArray(clean.log)) {
      clean.log = clean.log.filter(function (e) {
        var m = (e && e.msg) || "";
        return !/^(TEXT_SAMPLE:|A:\s)/.test(m);
      });
    }
    return clean;
  }

  /**
   * Fire-and-forget save of a per-profile diagnostic entry to chrome.storage.local.
   * Keyed by `lastRunDiag_<timestamp>`; prunes to the most recent DIAG_MAX_ENTRIES.
   * `rawCapture` defaults to false — raw candidate text is stripped before persisting.
   * Silently no-ops when chrome.storage is unavailable (Node test harness).
   */
  function saveProfileDiag(entry, rawCapture) {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
    } catch (_) { return; }
    entry = sanitizeDiagEntry(entry, rawCapture === true);
    var key = DIAG_KEY_PREFIX + entry.timestamp;
    var payload = {};
    payload[key] = entry;
    try {
      chrome.storage.local.set(payload, function () {
        try { chrome.runtime && chrome.runtime.lastError; } catch (_) {}
        try {
          chrome.storage.local.get(null, function (all) {
            try { chrome.runtime && chrome.runtime.lastError; } catch (_) {}
            if (!all) return;
            var keys = [];
            for (var k in all) {
              if (Object.prototype.hasOwnProperty.call(all, k) && k.indexOf(DIAG_KEY_PREFIX) === 0) keys.push(k);
            }
            // Descending by timestamp suffix — newest first.
            keys.sort(function (a, b) {
              var ta = parseInt(a.slice(DIAG_KEY_PREFIX.length), 10) || 0;
              var tb = parseInt(b.slice(DIAG_KEY_PREFIX.length), 10) || 0;
              return tb - ta;
            });
            // Lazy GC: prune by age (storage limitation) and by count, in one sweep.
            var cutoff = Date.now() - DIAG_MAX_AGE_MS;
            var removeSet = {};
            for (var ci = DIAG_MAX_ENTRIES; ci < keys.length; ci++) removeSet[keys[ci]] = true;
            for (var ai = 0; ai < keys.length; ai++) {
              var ts = parseInt(keys[ai].slice(DIAG_KEY_PREFIX.length), 10) || 0;
              if (ts < cutoff) removeSet[keys[ai]] = true;
            }
            var toRemove = Object.keys(removeSet);
            if (toRemove.length) {
              try { chrome.storage.local.remove(toRemove, function () { try { chrome.runtime && chrome.runtime.lastError; } catch (_) {} }); } catch (_) {}
            }
          });
        } catch (_) {}
      });
    } catch (_) {}
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

    var isBooleanMode = config.mode === "boolean" && String(config.booleanQuery || "").trim();
    if (isBooleanMode) {
      return runBooleanTriageWithDoc(doc, win, config, options, log);
    }

    var diagRawCapture = await getDiagRawCapture();

    var kwMeta = (typeof resolveKeywordsWithMeta === "function")
      ? resolveKeywordsWithMeta(config.keywords || "")
      : { keywords: resolveKeywords(config.keywords || ""), canonicalMap: null, userCount: null, userKeywordsList: [] };
    var keywords = kwMeta.keywords;
    var canonicalMap = kwMeta.canonicalMap;
    var userKeywordCount = kwMeta.userCount != null ? kwMeta.userCount : keywords.length;
    var userKeywordsList = kwMeta.userKeywordsList || [];
    var postToNotes = !!config.postToNotes;

    if (!keywords.length) {
      log.push({ ok: false, msg: "No keywords provided." });
      return { log: log, moved: false, skipped: true, matchedKeywords: [], hitCount: 0 };
    }

    log.push({ ok: true, msg: "Keywords (" + userKeywordCount + " → " + keywords.length + " with expansions): " + keywords.slice(0, 8).join(", ") + (keywords.length > 8 ? "..." : "") });

    var resumeWaitMs = Math.max(1500, parseInt(config.resumeWaitMs, 10) || 3000);
    var textParts = [];
    var _t0 = performance.now();
    var phase = makePhaseTimer(config.__prePhases);

    // Candidate header (name + title) — always visible, loads instantly.
    // Catches titles like "IAM SailPoint Developer" that other sources may miss
    // if the resume viewer renders as canvas or the profile tab doesn't load.
    var headerText = "";
    try { headerText = getCandidateHeaderText(doc); } catch (_) {}
    if (headerText) textParts.push(headerText);
    phase.mark("header");

    // Briefly foreground this worker tab so pdf.js renders the resume text layer
    // (it's paused while the tab is hidden). Released once resume extraction is done.
    var gotRenderFocus = false;
    try { gotRenderFocus = await requestResumeRenderFocus(doc); } catch (_) {}
    if (gotRenderFocus) { log.push({ ok: true, msg: "Resume: foregrounded worker tab so pdf.js can render" }); await sleep(250); }
    phase.mark("focusWait");

    // MutationObserver-based resume wait: start the waiter BEFORE clicking the resume
    // tab so the observer is already watching when SR's SPA mounts the PDF viewer.
    // Resolves as soon as ≥200 chars of resume-viewer text appears (or on timeout).
    var resumeText = "";
    var resumeWaiter = makeResumeTextWaiter(doc, Math.max(resumeWaitMs, 12000));
    try { await ensureResumeTabActive(doc, win); } catch (_) {}
    try { resumeText = await resumeWaiter; } catch (_) {}
    if (!resumeText) { try { resumeText = getResumeText(doc); } catch (_) {} }
    // pdf.js text layer fallback — canvas-rendered PDFs have an invisible text
    // layer overlay whose spans contain the real text. Always check regardless of
    // resumeText length: getResumeText's fullRoot fallback can return SR sidebar
    // boilerplate (~982 chars) that satisfies the old length < 200 gate while
    // containing no actual resume content.
    try {
      var pdfText = getPdfTextLayerText(doc);
      if (pdfText.length > (resumeText || "").length) resumeText = pdfText;
    } catch (_) {}
    phase.mark("resumeRender");
    // Retry if the resume is sparse OR is actually SR's summary chrome (the
    // ~1000-char sidebar boilerplate that masquerades as a resume and sneaks past a
    // length-only gate — see looksLikeSrSummaryChrome). The PDF text layer often
    // hasn't rendered yet in a background worker tab, so re-activate the resume tab,
    // scroll the viewer to force pdf.js to render every page, and poll the clean
    // resume-only signal until real (non-chrome) text appears.
    var resumeIsChrome = looksLikeSrSummaryChrome(resumeText);
    if (!resumeText || resumeText.length < 1000 || resumeIsChrome) {
      if (resumeIsChrome) {
        log.push({ ok: false, msg: "Resume: captured SR summary chrome, not the PDF — re-activating resume tab and waiting for text layer" });
      }
      for (var rwait = 0; rwait < 16000; rwait += 1500) {
        try { await ensureResumeTabActive(doc, win); } catch (_) {}
        try { nudgeResumeViewerScroll(doc); } catch (_) {}
        await sleep(1500);
        var retryResume = "";
        try { retryResume = getResumeText(doc); } catch (_) {}
        try { var retryPdf = getPdfTextLayerText(doc); if (retryPdf.length > (retryResume || "").length) retryResume = retryPdf; } catch (_) {}
        var retryIsChrome = looksLikeSrSummaryChrome(retryResume);
        // Prefer real resume text; only overwrite chrome with chrome if it's longer.
        if (retryResume && retryResume.length > (resumeText || "").length &&
            (!retryIsChrome || resumeIsChrome)) {
          resumeText = retryResume;
          resumeIsChrome = retryIsChrome;
        }
        if (resumeText && resumeText.length >= 500 && !resumeIsChrome) {
          log.push({ ok: true, msg: "Resume retry: recovered " + resumeText.length + " chars of real PDF text after re-activating resume tab" });
          break;
        }
      }
      // Last resort: open the resume attachment in a new tab and read it there.
      if (resumeIsChrome) {
        var fbText = await tryAttachmentResumeFallback(doc, win, log);
        if (fbText && fbText.length >= 300 && !looksLikeSrSummaryChrome(fbText)) {
          resumeText = fbText;
          resumeIsChrome = false;
          log.push({ ok: true, msg: "Resume: recovered via attachment fallback (" + fbText.length + " chars)" });
        }
      }
      if (resumeIsChrome) {
        log.push({ ok: false, msg: "Resume: PDF text layer never rendered — scan limited to SR profile/skills data (resume-only keywords may be missed)" });
      }
    }
    phase.mark("resumeRetry");
    log.push({ ok: !!(resumeText && resumeText.length >= 50),
               msg: "Resume: " + (resumeText ? resumeText.length : 0) + " chars" +
                    (resumeText && resumeText.length < 200 ? " (sparse — continuing scan)" : ""),
               ms: Math.round(performance.now() - _t0) });
    if (resumeText) textParts.push(resumeText);

    // Full-page shadow-DOM scan while resume tab is still active. Catches resume
    // content rendered in shadow components not matched by getResumeText's selector
    // list. Must run before ensureProfileTabActive — SR's SPA unmounts the resume
    // viewer when switching tabs, so this text is unavailable afterward.
    var resumeTabScan = "";
    try { resumeTabScan = getFullPageText(doc); } catch (_) {}
    // Resume PDF + full-page scan captured — hand foreground back to the next worker
    // (or restore the user's tab if none are waiting).
    if (gotRenderFocus) { releaseResumeRenderFocus(); gotRenderFocus = false; }
    if (resumeTabScan && resumeTabScan.length > (resumeText || "").length) {
      textParts.push(resumeTabScan);
      log.push({ ok: true, msg: "Resume tab full-page: " + resumeTabScan.length + " chars" });
    }
    phase.mark("resumeTabScan");

    var _t1 = performance.now();
    try { await ensureProfileTabActive(doc, win); } catch (_) {}
    // Adaptive wait: SR fetches profile content (skills, work history) asynchronously
    // after the tab click. Poll until getProfileOverviewText reaches 600 chars — a
    // reliable signal the async load finished — or bail after 1500 ms.
    // Combined with the 500 ms sleep inside ensureProfileTabActive this gives up to
    // 2 s total for the profile panel to render before we extract text.
    var _ppw = 0;
    while (_ppw < 1500) {
      await sleep(250);
      _ppw += 250;
      try { if (getProfileOverviewText(doc).length >= 600) break; } catch (_) {}
    }

    var profileText = "";
    try { profileText = getProfileOverviewText(doc); } catch (_) {}
    if (profileText) textParts.push(profileText);

    var screeningText = "";
    try { screeningText = getScreeningText(doc, win); } catch (_) {}
    if (screeningText) textParts.push(screeningText);
    phase.mark("profileTab");

    var allText = textParts.join("\n\n").trim();

    // Retry once if text is sparse — the SPA may still be rendering.
    if (allText.length < 200) {
      log.push({ ok: false, msg: "Sparse text (" + allText.length + " chars) — waiting 3s and retrying extraction" });
      await sleep(3000);
      var retryParts = [];
      try { var rh = getCandidateHeaderText(doc); if (rh) retryParts.push(rh); } catch (_) {}
      try { var rr = getResumeText(doc); if (rr) retryParts.push(rr); } catch (_) {}
      try { var rp = getProfileOverviewText(doc); if (rp) retryParts.push(rp); } catch (_) {}
      try { var rpdf = getPdfTextLayerText(doc); if (rpdf) retryParts.push(rpdf); } catch (_) {}
      var retryText = retryParts.join("\n\n").trim();
      if (retryText.length > allText.length) {
        allText = retryText;
        log.push({ ok: true, msg: "Retry recovered " + allText.length + " chars" });
      }
    }
    phase.mark("sparseRetry");

    // Always run a full-page shadow-DOM scan — replicates Ctrl+F behavior by walking every
    // text node in every shadow root unconditionally. Class-selector extraction misses SR
    // custom elements (e.g. <sr-work-experience>) that carry no class attribute.
    var fullPage = "";
    try { fullPage = getFullPageText(doc); } catch (_) {}
    if (fullPage.length > allText.length) {
      log.push({ ok: true, msg: "Full-page scan: " + fullPage.length + " chars (targeted: " + allText.length + " chars) — using full-page" });
      allText = fullPage;
    }

    var _preDedupLen = allText.length;
    allText = dedupeTextSegments(allText);
    if (allText.length < _preDedupLen) {
      log.push({ ok: true, msg: "Dedup: removed " + (_preDedupLen - allText.length) + " duplicate chars (" + _preDedupLen + " → " + allText.length + ") for accurate counts" });
    }
    allText = normalizeForKw(allText);
    var excludedKw = "";
    try { excludedKw = getExcludedText(doc); } catch (_) {}
    if (excludedKw) allText = stripExcludedText(allText, excludedKw);
    var textLen = allText.length;
    phase.mark("textProcessing");
    log.push({ ok: textLen >= 50, msg: "Total text: " + textLen + " chars (header: " + (headerText || "").length + ", resume: " + (resumeText || "").length + ", profile: " + (profileText || "").length + ", screening: " + screeningText.length + ")",
               ms: Math.round(performance.now() - _t1) });

    if (textLen < 50) {
      log.push({ ok: false, msg: "Very little text found on page — resume may not have loaded." });
      try {
        saveProfileDiag({
          schemaVersion: 1, type: "keyword", timestamp: Date.now(),
          profileUrl: (function () { try { return doc.location.href; } catch (_) { return ""; } })(),
          userInput: String(config.keywords || ""),
          userKeywords: userKeywordsList.slice(),
          expandedKeywords: keywords.slice(),
          matchedUserKeywords: [],
          missedUserKeywords: userKeywordsList.slice(),
          textSources: {
            header: capText(headerText || "", DIAG_SOURCE_CAP),
            resume: capText(resumeText || "", DIAG_SOURCE_CAP),
            profile: capText(profileText || "", DIAG_SOURCE_CAP),
            screening: capText(screeningText || "", DIAG_SOURCE_CAP),
            fullPage: capText(fullPage || "", DIAG_SOURCE_CAP),
          },
          extractedText: capText(allText, DIAG_TEXT_CAP),
          textStats: {
            headerLen: (headerText || "").length, resumeLen: (resumeText || "").length,
            profileLen: (profileText || "").length, screeningLen: (screeningText || "").length,
            fullPageLen: (fullPage || "").length, totalLen: textLen,
          },
          durationMs: Math.round(performance.now() - _t0),
          timings: phase.phases,
          log: log.slice(),
        }, diagRawCapture);
      } catch (_) {}
      return { log: log, moved: false, skipped: true, matchedKeywords: [], hitCount: 0, timings: phase.phases,
               textStats: { headerLen: (headerText||"").length, resumeLen: 0, profileLen: 0, totalLen: 0 } };
    }

    var _t2 = performance.now();
    var result = findKeywordHits(allText, keywords);
    var dedupedHits = deduplicateHitsByCanonical(result.hits, canonicalMap);
    // Displayed counts come from the RESUME only (when we have a real one) so an
    // expansion alias like "doctorate" matching SR's repeated profile/skill chrome
    // doesn't inflate e.g. "phd (x25)". Presence / Matched X/Y still uses the full
    // union below, so a keyword found only in profile data is still flagged.
    var countMap = countsFromResume(resumeText, keywords, canonicalMap);
    var hitLabels = dedupedHits.map(function (h) {
      var c = countMap ? countMap[h.keyword.toLowerCase()] : undefined;
      if (c == null) c = h.count;   // matched outside the resume — keep union count
      return c > 1 ? h.keyword + " (x" + c + ")" : h.keyword;
    });
    var hitCount = dedupedHits.length;
    var matchedUserKw = dedupedHits.map(function (h) { return h.keyword; });
    var matchedLowerMap = {};
    for (var _mi = 0; _mi < matchedUserKw.length; _mi++) matchedLowerMap[matchedUserKw[_mi].toLowerCase()] = true;
    var missedUserKw = userKeywordsList.filter(function (k) { return !matchedLowerMap[k.toLowerCase()]; });

    log.push({ ok: true, msg: "Matched " + hitCount + "/" + userKeywordCount + " keywords: " + (hitLabels.length ? hitLabels.join(", ") : "(none)"),
               ms: Math.round(performance.now() - _t2) });

    if (diagRawCapture && hitCount === 0 && textLen >= 200) {
      var sample = allText.slice(0, 300).replace(/\s+/g, " ");
      log.push({ ok: false, msg: "TEXT_SAMPLE: " + sample });
    }
    phase.mark("match");

    var notesPosted = false;
    var _t3 = performance.now();
    // Post when there are hits, OR when zero hits but real text was extracted (so a
    // "No keyword tagged" note is recorded). Skip on extraction failures (textLen < 200)
    // to avoid mislabelling a profile whose resume never loaded as having no keywords.
    var shouldPostNote = postToNotes && (hitCount > 0 || textLen >= 200);
    if (shouldPostNote) {
      try { await prepareNotesSection(doc, win, log); } catch (_) {}
      phase.mark("notesPrepare");
      try {
        notesPosted = await postKeywordHitsToNotes(doc, win, hitLabels, hitCount, userKeywordCount, log, "", { partialScan: !resumeWasRead(resumeText, resumeIsChrome) });
      } catch (e) {
        log.push({ ok: false, msg: "Notes post error: " + ((e && e.message) || String(e)) });
      }
      phase.mark("notesPost");
    }

    var _tNotes = Math.round(performance.now() - _t3);
    if (shouldPostNote) {
      log.push({ ok: notesPosted, msg: "Notes phase: " + (notesPosted ? "posted" : "failed"), ms: _tNotes });
    }

    var notesFailReason = "";
    if (!notesPosted && shouldPostNote) {
      for (var nfi = log.length - 1; nfi >= 0; nfi--) {
        if (!log[nfi].ok && log[nfi].msg) { notesFailReason = log[nfi].msg; break; }
      }
    }

    var _totalMs = Math.round(performance.now() - _t0);
    try {
      saveProfileDiag({
        schemaVersion: 1, type: "keyword", timestamp: Date.now(),
        profileUrl: (function () { try { return doc.location.href; } catch (_) { return ""; } })(),
        userInput: String(config.keywords || ""),
        userKeywords: userKeywordsList.slice(),
        expandedKeywords: keywords.slice(),
        matchedUserKeywords: matchedUserKw,
        missedUserKeywords: missedUserKw,
        textSources: {
          header: capText(headerText || "", DIAG_SOURCE_CAP),
          resume: capText(resumeText || "", DIAG_SOURCE_CAP),
          profile: capText(profileText || "", DIAG_SOURCE_CAP),
          screening: capText(screeningText || "", DIAG_SOURCE_CAP),
          fullPage: capText(fullPage || "", DIAG_SOURCE_CAP),
        },
        extractedText: capText(allText, DIAG_TEXT_CAP),
        textStats: {
          headerLen: (headerText || "").length, resumeLen: (resumeText || "").length,
          profileLen: (profileText || "").length, screeningLen: (screeningText || "").length,
          fullPageLen: (fullPage || "").length, totalLen: textLen,
        },
        durationMs: _totalMs,
        timings: phase.phases,
        log: log.slice(),
      }, diagRawCapture);
    } catch (_) {}
    return { log: log, moved: false, skipped: false, matchedKeywords: hitLabels, hitCount: hitCount,
             notesPosted: notesPosted, notesFailReason: notesFailReason, totalMs: _totalMs, timings: phase.phases,
             textStats: { headerLen: (headerText||"").length, resumeLen: (resumeText||"").length,
                          profileLen: (profileText||"").length, totalLen: textLen } };
  }

  async function runBooleanTriageWithDoc(doc, win, config, options, log) {
    var _tBool0 = performance.now();
    var diagRawCapture = await getDiagRawCapture();
    var postToNotes = !!config.postToNotes;
    var booleanQueryRaw = String(config.booleanQuery || "").trim();
    var opens = (booleanQueryRaw.match(/\(/g) || []).length;
    var closes = (booleanQueryRaw.match(/\)/g) || []).length;
    var booleanQuery = booleanQueryRaw;
    if (closes > opens) {
      for (var mo = 0; mo < closes - opens; mo++) booleanQuery = "(" + booleanQuery;
      log.push({ ok: false, msg: "Boolean: unbalanced parentheses — prepended " + (closes - opens) + " '(' to fix query (check your query)" });
    } else if (opens > closes) {
      for (var mc = 0; mc < opens - closes; mc++) booleanQuery = booleanQuery + ")";
      log.push({ ok: false, msg: "Boolean: unbalanced parentheses — appended " + (opens - closes) + " ')' to fix query (check your query)" });
    }

    var ast;
    try {
      ast = parseBooleanQuery(booleanQuery);
    } catch (e) {
      log.push({ ok: false, msg: "Boolean parse error: " + ((e && e.message) || String(e)) });
      return { log: log, moved: false, skipped: true, matchedKeywords: [], hitCount: 0 };
    }

    var allLeaves = extractLeafTerms(ast);
    var positiveTerms = [];
    var negativeTerms = [];
    var seenLeaf = {};
    for (var li = 0; li < allLeaves.length; li++) {
      var leaf = allLeaves[li];
      var lKey = leaf.value.toLowerCase();
      if (seenLeaf[lKey]) continue;
      seenLeaf[lKey] = true;
      if (leaf.negated) negativeTerms.push(leaf.value);
      else positiveTerms.push(leaf.value);
    }

    var totalTerms = positiveTerms.length + negativeTerms.length;
    log.push({ ok: true, msg: "Boolean search: " + totalTerms + " terms (" + positiveTerms.length + " positive, " + negativeTerms.length + " NOT)" });
    if (positiveTerms.length) {
      log.push({ ok: true, msg: "Scanning: " + positiveTerms.slice(0, 10).join(", ") + (positiveTerms.length > 10 ? "..." : "") });
    }

    var resumeWaitMs = Math.max(1500, parseInt(config.resumeWaitMs, 10) || 3000);

    /* ── Multi-source text extraction — MutationObserver-based resume wait ── */
    var textParts = [];
    var phase = makePhaseTimer(config.__prePhases);

    var headerText = "";
    try { headerText = getCandidateHeaderText(doc); } catch (_) {}
    if (headerText) textParts.push(headerText);
    phase.mark("header");

    // Briefly foreground this worker tab so pdf.js renders the resume text layer.
    var gotRenderFocusBool = false;
    try { gotRenderFocusBool = await requestResumeRenderFocus(doc); } catch (_) {}
    if (gotRenderFocusBool) { log.push({ ok: true, msg: "Resume: foregrounded worker tab so pdf.js can render" }); await sleep(250); }
    phase.mark("focusWait");

    var resumeText = "";
    var resumeWaiterBool = makeResumeTextWaiter(doc, Math.max(resumeWaitMs, 12000));
    try { await ensureResumeTabActive(doc, win); } catch (_) {}
    try { resumeText = await resumeWaiterBool; } catch (_) {}
    if (!resumeText) { try { resumeText = getResumeText(doc); } catch (_) {} }
    try {
      var pdfTextBool = getPdfTextLayerText(doc);
      if (pdfTextBool.length > (resumeText || "").length) resumeText = pdfTextBool;
    } catch (_) {}
    phase.mark("resumeRender");
    // Same chrome-aware retry as the keyword path: if we only captured SR's summary
    // sidebar (not the real PDF), re-activate the resume tab, scroll the viewer to
    // force pdf.js rendering, and poll until real resume text appears.
    var resumeIsChromeBool = looksLikeSrSummaryChrome(resumeText);
    if (!resumeText || resumeText.length < 1000 || resumeIsChromeBool) {
      if (resumeIsChromeBool) {
        log.push({ ok: false, msg: "Resume: captured SR summary chrome, not the PDF — re-activating resume tab and waiting for text layer" });
      }
      for (var rwaitB = 0; rwaitB < 16000; rwaitB += 1500) {
        try { await ensureResumeTabActive(doc, win); } catch (_) {}
        try { nudgeResumeViewerScroll(doc); } catch (_) {}
        await sleep(1500);
        var retryResumeB = "";
        try { retryResumeB = getResumeText(doc); } catch (_) {}
        try { var retryPdfB = getPdfTextLayerText(doc); if (retryPdfB.length > (retryResumeB || "").length) retryResumeB = retryPdfB; } catch (_) {}
        var retryIsChromeB = looksLikeSrSummaryChrome(retryResumeB);
        if (retryResumeB && retryResumeB.length > (resumeText || "").length &&
            (!retryIsChromeB || resumeIsChromeBool)) {
          resumeText = retryResumeB;
          resumeIsChromeBool = retryIsChromeB;
        }
        if (resumeText && resumeText.length >= 500 && !resumeIsChromeBool) {
          log.push({ ok: true, msg: "Resume retry: recovered " + resumeText.length + " chars of real PDF text after re-activating resume tab" });
          break;
        }
      }
      if (resumeIsChromeBool) {
        var fbTextB = await tryAttachmentResumeFallback(doc, win, log);
        if (fbTextB && fbTextB.length >= 300 && !looksLikeSrSummaryChrome(fbTextB)) {
          resumeText = fbTextB;
          resumeIsChromeBool = false;
          log.push({ ok: true, msg: "Resume: recovered via attachment fallback (" + fbTextB.length + " chars)" });
        }
      }
      if (resumeIsChromeBool) {
        log.push({ ok: false, msg: "Resume: PDF text layer never rendered — scan limited to SR profile/skills data (resume-only terms may be missed)" });
      }
    }
    phase.mark("resumeRetry");
    log.push({ ok: !!(resumeText && resumeText.length >= 50),
               msg: "Resume: " + (resumeText ? resumeText.length : 0) + " chars" +
                    (resumeText && resumeText.length < 200 ? " (sparse)" : "") });
    if (resumeText) textParts.push(resumeText);

    var resumeTabScanBool = "";
    try { resumeTabScanBool = getFullPageText(doc); } catch (_) {}
    // Resume PDF + full-page scan captured — hand foreground back.
    if (gotRenderFocusBool) { releaseResumeRenderFocus(); gotRenderFocusBool = false; }
    if (resumeTabScanBool && resumeTabScanBool.length > (resumeText || "").length) {
      textParts.push(resumeTabScanBool);
      log.push({ ok: true, msg: "Resume tab full-page: " + resumeTabScanBool.length + " chars" });
    }
    phase.mark("resumeTabScan");

    try { await ensureProfileTabActive(doc, win); } catch (_) {}
    var _ppwB = 0;
    while (_ppwB < 1500) {
      await sleep(250);
      _ppwB += 250;
      try { if (getProfileOverviewText(doc).length >= 600) break; } catch (_) {}
    }

    var profileText = "";
    try { profileText = getProfileOverviewText(doc); } catch (_) {}
    if (profileText) textParts.push(profileText);

    var screeningText = "";
    try { screeningText = getScreeningText(doc, win); } catch (_) {}
    if (screeningText) textParts.push(screeningText);
    phase.mark("profileTab");

    var allText = textParts.join("\n\n").trim();

    if (allText.length < 200) {
      log.push({ ok: false, msg: "Sparse text (" + allText.length + " chars) — waiting 3s and retrying extraction" });
      await sleep(3000);
      var retryPartsBool = [];
      try { var rh2 = getCandidateHeaderText(doc); if (rh2) retryPartsBool.push(rh2); } catch (_) {}
      try { var rr2 = getResumeText(doc); if (rr2) retryPartsBool.push(rr2); } catch (_) {}
      try { var rp2 = getProfileOverviewText(doc); if (rp2) retryPartsBool.push(rp2); } catch (_) {}
      try { var rpdf2 = getPdfTextLayerText(doc); if (rpdf2) retryPartsBool.push(rpdf2); } catch (_) {}
      var retryTextBool = retryPartsBool.join("\n\n").trim();
      if (retryTextBool.length > allText.length) {
        allText = retryTextBool;
        log.push({ ok: true, msg: "Retry recovered " + allText.length + " chars" });
      }
    }
    phase.mark("sparseRetry");

    var fullPage = "";
    try { fullPage = getFullPageText(doc); } catch (_) {}
    if (fullPage.length > allText.length) {
      log.push({ ok: true, msg: "Full-page scan: " + fullPage.length + " chars (targeted: " + allText.length + " chars) — using full-page" });
      allText = fullPage;
    }

    var _preDedupLenB = allText.length;
    allText = dedupeTextSegments(allText);
    if (allText.length < _preDedupLenB) {
      log.push({ ok: true, msg: "Dedup: removed " + (_preDedupLenB - allText.length) + " duplicate chars (" + _preDedupLenB + " → " + allText.length + ") for accurate counts" });
    }
    allText = normalizeForKw(allText);
    var excludedBool = "";
    try { excludedBool = getExcludedText(doc); } catch (_) {}
    if (excludedBool) allText = stripExcludedText(allText, excludedBool);
    var textLen = allText.length;
    phase.mark("textProcessing");
    log.push({ ok: textLen >= 50, msg: "Total text: " + textLen + " chars (header: " + (headerText || "").length + ", resume: " + (resumeText || "").length + ", profile: " + profileText.length + ", screening: " + screeningText.length + ")" });

    if (textLen < 50) {
      log.push({ ok: false, msg: "Very little text found on page — resume may not have loaded." });
      try {
        saveProfileDiag({
          schemaVersion: 1, type: "boolean", timestamp: Date.now(),
          profileUrl: (function () { try { return doc.location.href; } catch (_) { return ""; } })(),
          userInput: booleanQueryRaw,
          userKeywords: positiveTerms.slice(),
          expandedKeywords: [],
          matchedUserKeywords: [],
          missedUserKeywords: positiveTerms.slice(),
          textSources: {
            header: capText(headerText || "", DIAG_SOURCE_CAP),
            resume: capText(resumeText || "", DIAG_SOURCE_CAP),
            profile: capText(profileText || "", DIAG_SOURCE_CAP),
            screening: capText(screeningText || "", DIAG_SOURCE_CAP),
            fullPage: capText(fullPage || "", DIAG_SOURCE_CAP),
          },
          extractedText: capText(allText, DIAG_TEXT_CAP),
          textStats: {
            headerLen: (headerText || "").length, resumeLen: (resumeText || "").length,
            profileLen: (profileText || "").length, screeningLen: (screeningText || "").length,
            fullPageLen: (fullPage || "").length, totalLen: textLen,
          },
          durationMs: Math.round(performance.now() - _tBool0),
          timings: phase.phases,
          log: log.slice(),
        }, diagRawCapture);
      } catch (_) {}
      return { log: log, moved: false, skipped: true, matchedKeywords: [], hitCount: 0, timings: phase.phases,
               textStats: { headerLen: (headerText||"").length, resumeLen: 0, profileLen: 0, totalLen: 0 } };
    }

    var scanLowerToCanons = {};
    var scanLowerDisplay = {};
    function registerBooleanScans(leafValue, negated) {
      var canonKey = leafValue.trim().toLowerCase();
      var forms = expandOneBooleanTerm(leafValue);
      for (var fi = 0; fi < forms.length; fi++) {
        var sc = forms[fi].trim();
        if (!sc) continue;
        var sl = sc.toLowerCase();
        if (!scanLowerDisplay[sl]) scanLowerDisplay[sl] = sc;
        if (!scanLowerToCanons[sl]) scanLowerToCanons[sl] = [];
        var row = { canon: canonKey, negated: negated };
        var dup = false;
        for (var d = 0; d < scanLowerToCanons[sl].length; d++) {
          if (scanLowerToCanons[sl][d].canon === canonKey && scanLowerToCanons[sl][d].negated === negated) {
            dup = true;
            break;
          }
        }
        if (!dup) scanLowerToCanons[sl].push(row);
      }
    }
    for (var pi0 = 0; pi0 < positiveTerms.length; pi0++) registerBooleanScans(positiveTerms[pi0], false);
    for (var ni0 = 0; ni0 < negativeTerms.length; ni0++) registerBooleanScans(negativeTerms[ni0], true);

    var uniqueScans = [];
    for (var slk in scanLowerDisplay) {
      if (Object.prototype.hasOwnProperty.call(scanLowerDisplay, slk)) uniqueScans.push(scanLowerDisplay[slk]);
    }

    var scanResult = findKeywordHits(allText, uniqueScans, { maxItems: 15000, scanEveryKeyword: true });

    var matchedSet = {};
    for (var hi = 0; hi < scanResult.hits.length; hi++) {
      var hk = scanResult.hits[hi].keyword.toLowerCase();
      var metas = scanLowerToCanons[hk];
      if (!metas) continue;
      for (var mi = 0; mi < metas.length; mi++) {
        matchedSet[metas[mi].canon] = true;
      }
    }

    var booleanPass = evaluateBooleanAst(ast, matchedSet);

    /* ── Collect ALL hits for notes — every term found goes in, regardless of NOT ── */
    // Counts come from the resume when available, so profile/skill chrome doesn't inflate them.
    var boolCountMap = countsFromResume(resumeText, uniqueScans, null);
    var allHitLabels = [];
    var seenHitLabel = {};
    for (var pi = 0; pi < scanResult.hits.length; pi++) {
      var hit = scanResult.hits[pi];
      var bc = boolCountMap ? boolCountMap[hit.keyword.toLowerCase()] : undefined;
      if (bc == null) bc = hit.count;
      var label = bc > 1 ? hit.keyword + " (x" + bc + ")" : hit.keyword;
      var lbl = label.toLowerCase();
      if (seenHitLabel[lbl]) continue;
      seenHitLabel[lbl] = true;
      allHitLabels.push(label);
    }

    log.push({ ok: true, msg: "Boolean: " + allHitLabels.length + " terms matched out of " + uniqueScans.length + " scanned" });
    if (allHitLabels.length) {
      log.push({ ok: true, msg: "Hits: " + allHitLabels.join(", ") });
    }
    phase.mark("match");

    var notesPosted = false;
    // Post on any match, or on zero matches when real text was extracted (records a
    // "No keyword tagged" note). Skip on extraction failures to avoid false negatives.
    var shouldPostBoolNote = postToNotes && (allHitLabels.length > 0 || textLen >= 200);
    if (shouldPostBoolNote) {
      try { await prepareNotesSection(doc, win, log); } catch (_) {}
      phase.mark("notesPrepare");
      var boolPrefix = booleanPass ? "[PASS] " : "[FAIL] ";
      try {
        notesPosted = await postKeywordHitsToNotes(doc, win, allHitLabels, allHitLabels.length, totalTerms, log, boolPrefix, { partialScan: !resumeWasRead(resumeText, resumeIsChromeBool) });
      } catch (e) {
        log.push({ ok: false, msg: "Notes post error: " + ((e && e.message) || String(e)) });
      }
      phase.mark("notesPost");
    }

    var notesFailReason = "";
    if (!notesPosted && shouldPostBoolNote) {
      for (var bfi = log.length - 1; bfi >= 0; bfi--) {
        if (!log[bfi].ok && log[bfi].msg) { notesFailReason = log[bfi].msg; break; }
      }
    }

    var matchedPositiveCanons = positiveTerms.filter(function (t) { return !!matchedSet[t.trim().toLowerCase()]; });
    var missedPositiveCanons  = positiveTerms.filter(function (t) { return  !matchedSet[t.trim().toLowerCase()]; });

    try {
      saveProfileDiag({
        schemaVersion: 1, type: "boolean", timestamp: Date.now(),
        profileUrl: (function () { try { return doc.location.href; } catch (_) { return ""; } })(),
        userInput: booleanQueryRaw,
        userKeywords: positiveTerms.slice(),
        expandedKeywords: uniqueScans.slice(),
        matchedUserKeywords: matchedPositiveCanons,
        missedUserKeywords: missedPositiveCanons,
        textSources: {
          header: capText(headerText || "", DIAG_SOURCE_CAP),
          resume: capText(resumeText || "", DIAG_SOURCE_CAP),
          profile: capText(profileText || "", DIAG_SOURCE_CAP),
          screening: capText(screeningText || "", DIAG_SOURCE_CAP),
          fullPage: capText(fullPage || "", DIAG_SOURCE_CAP),
        },
        extractedText: capText(allText, DIAG_TEXT_CAP),
        textStats: {
          headerLen: (headerText || "").length, resumeLen: (resumeText || "").length,
          profileLen: (profileText || "").length, screeningLen: (screeningText || "").length,
          fullPageLen: (fullPage || "").length, totalLen: textLen,
        },
        durationMs: Math.round(performance.now() - _tBool0),
        timings: phase.phases,
        log: log.slice(),
        booleanPass: booleanPass,
      }, diagRawCapture);
    } catch (_) {}

    return {
      log: log,
      moved: false,
      skipped: false,
      matchedKeywords: allHitLabels,
      hitCount: allHitLabels.length,
      notesPosted: notesPosted,
      notesFailReason: notesFailReason,
      booleanPass: booleanPass,
      timings: phase.phases,
      textStats: { headerLen: (headerText||"").length, resumeLen: (resumeText||"").length,
                   profileLen: profileText.length, totalLen: textLen },
    };
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

  async function startQueueFromPage(config) {
    var doc = document;
    var win = window;
    var log = [];
    var KEY = "sr_ext_keyword_triage_v1";
    var resumeWaitMs = Math.max(1500, parseInt(config.resumeWaitMs, 10) || 3000);
    var queueReadyMaxMs = Math.max(2000, parseInt(config.queueReadyMaxMs, 10) || 16000);
    var baseState = {
      returnUrl: win.location.href,
      initialDelayMs: Math.max(400, resumeWaitMs),
      config: {
        mode: config.mode || "keywords",
        booleanQuery: config.booleanQuery || "",
        keywords: config.keywords,
        postToNotes: !!config.postToNotes,
        resumeWaitMs: resumeWaitMs,
        queueReadyMaxMs: queueReadyMaxMs,
      },
      log: [],
      results: [],
      startedAt: Date.now(),
    };

    if (typeof globalThis.__srAutoscrollApplicantListUntilLoaded === "function") {
      try {
        var si = await globalThis.__srAutoscrollApplicantListUntilLoaded();
        if (si && !si.skipped) {
          log.push({
            ok: true,
            msg:
              "Autoscrolled applicant list — " +
              si.uniqueLinks +
              " profile link(s)" +
              (si.expectedTotal != null ? " (list total " + si.expectedTotal + ")" : "") +
              (si.timedOut ? ", stopped at time cap" : "") +
              " in " +
              Math.round(si.ms || 0) +
              "ms",
          });
        }
      } catch (e) {
        log.push({ ok: false, msg: "Autoscroll failed: " + ((e && e.message) || String(e)) });
      }
    }

    var urls = harvestProfileUrls(doc, win);
    if (urls.length) {
      var state = Object.assign({}, baseState, { kind: "urls", queue: urls.slice() });
      // GDPR: seed the queue into chrome.storage.session via the shim (extension-isolated),
      // not page-origin sessionStorage. Must await before navigating so the write lands.
      if (typeof __srSessionSet !== "function") {
        log.push({ ok: false, msg: "Session storage shim not loaded (storage-session-shim.js)" });
        return { ok: false, log: log, queued: 0 };
      }
      var _seedOk = await __srSessionSet(KEY, JSON.stringify(state));
      if (!_seedOk) {
        log.push({ ok: false, msg: "Queue write denied: " + (globalThis.__srSessionLastError || "unknown reason") });
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
    // GDPR: seed via chrome.storage.session shim (extension-isolated), await before click-through.
    if (typeof __srSessionSet !== "function") {
      log.push({ ok: false, msg: "Session storage shim not loaded (storage-session-shim.js)" });
      return { ok: false, log: log, queued: 0 };
    }
    var _seedOk2 = await __srSessionSet(KEY, JSON.stringify(state2));
    if (!_seedOk2) {
      log.push({ ok: false, msg: "Queue write denied: " + (globalThis.__srSessionLastError || "unknown reason") });
      return { ok: false, log: log, queued: 0 };
    }
    log.push({ ok: true, msg: "Queued " + targets.length + " applicants (click names)" });
    fireClick(win, targets[0]);
    return { ok: true, log: log, queued: targets.length, mode: "click" };
  }

  /* ── Exports ── */

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      normalizeForKw: normalizeForKw,
      buildTokenIndex: buildTokenIndex,
      kwHitsInIndex: kwHitsInIndex,
      sepFlexiblePatternSource: sepFlexiblePatternSource,
      isoListHit: isoListHit,
      findKeywordHits: findKeywordHits,
      deduplicateHitsByCanonical: deduplicateHitsByCanonical,
      formatNoteText: formatNoteText,
      formatNoteHtml: formatNoteHtml,
      dedupeTextSegments: dedupeTextSegments,
      collapseInlineRepeats: collapseInlineRepeats,
      noteConfirmMarker: noteConfirmMarker,
      feedDeltaCount: feedDeltaCount,
      looksLikeSrSummaryChrome: looksLikeSrSummaryChrome,
      resumeWasRead: resumeWasRead,
      countsFromResume: countsFromResume,
      parseBooleanQuery: parseBooleanQuery,
      evaluateBooleanAst: evaluateBooleanAst,
      extractLeafTerms: extractLeafTerms,
      stripExcludedText: stripExcludedText,
      capText: capText,
      makePhaseTimer: makePhaseTimer,
      saveProfileDiag: saveProfileDiag,
      sanitizeDiagEntry: sanitizeDiagEntry,
      getDiagRawCapture: getDiagRawCapture,
      DIAG_KEY_PREFIX: DIAG_KEY_PREFIX,
      DIAG_MAX_ENTRIES: DIAG_MAX_ENTRIES,
      DIAG_TEXT_CAP: DIAG_TEXT_CAP,
      DIAG_SOURCE_CAP: DIAG_SOURCE_CAP,
    };
    return;
  }

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
  globalThis.__srWaitForResumeText = function (maxMs) {
    return makeResumeTextWaiter(document, maxMs);
  };
  globalThis.__srHarvestProfileUrls = function () {
    return harvestProfileUrls(document, window);
  };
  globalThis.__srHasSrProfileChrome = function (doc) {
    return hasSrProfileChrome(doc || document);
  };
})();
