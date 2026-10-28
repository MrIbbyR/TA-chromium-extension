// keyword-extract.js — keyword search: reads candidate text off the profile page (resume, header, location, screening).
// One of the keyword-*.js modules that keyword-triage-core.js runs. They share the
// globalThis.__srKw namespace (require() under Node) and load in dependency order:
// dom → matching → extract → pipeline → notes → diag → core.

(function () {
  "use strict";

  // SmartRecruiters selectors and element ids live in sr-selectors.js, which loads first.
  var SR = globalThis.__SR || (typeof require === "function" ? require("./sr-selectors.js").SR : null);
  if (!SR) throw new Error("sr-selectors.js must load before keyword-extract.js");

  // Node: require(). Browser: modules loaded earlier put their exports on
  // globalThis.__srKw; a missing name means a loader got the order wrong.
  function need(file, names) {
    var mod = typeof module !== "undefined" && module.exports ? require("./" + file) : globalThis.__srKw || {};
    names.forEach(function (n) {
      if (mod[n] === undefined) throw new Error(n + " missing: load " + file + " before keyword-extract.js");
    });
    return mod;
  }
  var domMod = need("keyword-dom.js", [
    "sleep", "queryDeepSelectorAll", "findElementByIdDeep", "dispatchClickAtElementCenter",
    "getDeepText"
  ]);
  var matchingMod = need("keyword-matching.js", ["looksLikeSrSummaryChrome"]);
  var sleep = domMod.sleep,
      queryDeepSelectorAll = domMod.queryDeepSelectorAll,
      findElementByIdDeep = domMod.findElementByIdDeep,
      dispatchClickAtElementCenter = domMod.dispatchClickAtElementCenter,
      getDeepText = domMod.getDeepText;
  var looksLikeSrSummaryChrome = matchingMod.looksLikeSrSummaryChrome;

  /* ── Excluded regions: sidebar / job metadata that should NOT be scanned ── */

  var EXCLUDED_SELECTORS = SR.sel.excludedSidebar;

  function getExcludedText(doc) {
    var parts = [];
    var root = doc.querySelector(SR.sel.candidateView) || doc.body;
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
    var root = doc.querySelector(SR.sel.candidateView) || doc.body;
    if (!root) return "";
    var selectors = SR.sel.resumeViewer;
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
    var root = doc.querySelector(SR.sel.candidateView) || doc.body;
    if (!root) return "";
    var selectors = SR.sel.resumeViewer;
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
    var root = doc.querySelector(SR.sel.candidateView) || doc.body;
    if (!root) return;
    var selectors = SR.sel.resumeScroller;
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
    var root = doc.querySelector(SR.sel.candidateView) || doc.body;
    if (!root) return null;
    var areas = queryDeepSelectorAll(root, null, SR.sel.attachmentAreas);
    var searchRoots = areas.length ? areas : [root];
    var latest = null, plain = null, any = null;
    for (var i = 0; i < searchRoots.length; i++) {
      var links = queryDeepSelectorAll(searchRoots[i], null, SR.sel.attachmentAreaLinks);
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
   * One-line structural summary of what the resume tab holds when no text was read —
   * counts only, never content (diagnostics are PII-sensitive). Tells apart "no
   * document mounted", "pages drawn but no text layer" (scanned/image file) and
   * "a non-PDF preview".
   */
  function describeResumeViewer(doc) {
    var root = doc.querySelector(SR.sel.candidateView) || doc.body;
    function count(sel) { try { return queryDeepSelectorAll(root, null, sel).length; } catch (_) { return 0; } }
    var names = [];
    try {
      var links = queryDeepSelectorAll(root, null, SR.sel.attachmentLinks);
      for (var i = 0; i < links.length && names.length < 5; i++) {
        var t = (getDeepText(links[i]) || "").replace(/\s+/g, " ").trim();
        var ext = (t.match(/\.(pdf|docx?|rtf|odt|txt|png|jpe?g)\b/i) || [])[1];
        var kind = /cover/i.test(t) ? "cover letter" : /resume|cv\b/i.test(t) ? "resume" : "other";
        names.push(kind + (ext ? " ." + ext.toLowerCase() : ""));
      }
    } catch (_) {}
    return "Resume viewer: " + count(SR.sel.pdfPages) + " PDF pages, " +
      count("canvas") + " canvases, " + count(SR.sel.pdfTextSpans) + " text spans, " +
      count("iframe, embed, object") + " frames/embeds" +
      "; attachments: " + (names.length ? names.join(", ") : "none found");
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
      var tabOpened = false;
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
        if (res && res.opened) tabOpened = true;
        // A real attachment opens its tab within a second of the click; past 6s the
        // link opened nothing (e.g. it isn't a viewable resume), so stop waiting.
        if (!tabOpened && w >= 6000) {
          log.push({ ok: false, msg: "Fallback: no resume tab opened after clicking \"" +
            (getDeepText(link) || "").replace(/\s+/g, " ").trim().slice(0, 40) + "\" — giving up" });
          return "";
        }
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
    var root = doc.querySelector(SR.sel.candidateView) || doc.body;
    if (!root) return "";
    var selectors = SR.sel.candidateHeader;
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
    var root = doc.querySelector(SR.sel.candidateView) || doc.body;
    if (!root) return "";
    // Primary: SR's stable applicant-name element. The #st-applicantName id does
    // not change across profiles, and its <spl-truncate> slot holds the full name.
    try {
      var applicant = null;
      try { applicant = doc.querySelector(SR.sel.applicantNameHeader); } catch (_) {}
      if (!applicant) applicant = findElementByIdDeep(doc.documentElement || doc.body, SR.id.applicantName);
      if (applicant) {
        var nameTxt = (applicant.innerText || applicant.textContent || "").replace(/\s+/g, " ").trim();
        if (nameTxt.length >= 2 && nameTxt.length < 120) return nameTxt;
      }
    } catch (_) {}
    var nameSelectors = SR.sel.candidateName;
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

  function elText(el) {
    return String((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  }

  /**
   * Profile-side inputs for the note's location line, read from SR's
   * personal-info row (sr-candidate-personal-info → flex row → items):
   *   slotTexts  — the first item, SR's location slot; the deep fallback
   *                covers shadow-root rendering.
   *   otherTexts — every other spl-typography-body in the row (title, phone…).
   *   phone      — a tel: link, else a +CC number shown in the row.
   */
  function getProfileLocationInputs(doc) {
    var ITEM = SR.sel.personalInfoLocation;
    var infos = [];
    try { infos = Array.prototype.slice.call(doc.querySelectorAll(SR.sel.personalInfo)); } catch (_) {}
    if (!infos.length) {
      try { infos = queryDeepSelectorAll(doc.documentElement || doc.body, null, SR.sel.personalInfoHost); } catch (_) {}
    }
    var slotEls = [], bodyEls = [];
    for (var i = 0; i < infos.length; i++) {
      try { slotEls = slotEls.concat(queryDeepSelectorAll(infos[i], null, ITEM)); } catch (_) {}
      try { bodyEls = bodyEls.concat(queryDeepSelectorAll(infos[i], null, SR.sel.personalInfoItem)); } catch (_) {}
    }
    var slotTexts = slotEls.map(elText).filter(Boolean);
    var otherTexts = bodyEls.filter(function (el) { return slotEls.indexOf(el) < 0; }).map(elText).filter(Boolean);
    var phone = "";
    try {
      var tels = queryDeepSelectorAll(doc.documentElement || doc.body, null, 'a[href^="tel:"]');
      if (tels.length) phone = String(tels[0].getAttribute("href") || "").replace(/^tel:/i, "").trim();
    } catch (_) {}
    if (!phone) {
      var all = slotTexts.concat(otherTexts);
      for (var k = 0; k < all.length && !phone; k++) {
        var m = /\+\d[\d\s\-()]{7,}/.exec(all[k]);
        if (m) phone = m[0].trim();
      }
    }
    return { slotTexts: slotTexts, otherTexts: otherTexts, phone: phone };
  }

  /**
   * "Chennai, India (verified)" from the profile field, else a location inferred
   * from the resume text ("(from resume)"), else the phone's country ("(from
   * phone)"). Rules live in location-infer.js (__srLocation). resumeText must be
   * the real resume — pass "" when only SR profile chrome was captured.
   */
  function getCandidateLocation(doc, resumeText) {
    var L = (typeof __srLocation !== "undefined" && __srLocation) ||
      (typeof require === "function" ? require("./location-infer.js") : null);
    if (!L) return { label: "", method: "" };
    var inputs = getProfileLocationInputs(doc);
    inputs.resumeText = resumeText || "";
    var res = L.resolveCandidateLocation(inputs);
    return { label: L.formatLocationLabel(res), method: res ? res.method : "none" };
  }

  /**
   * First "<title> at <company>" line among texts, e.g. "Data Annotator at
   * Samsung R&D Institute India - Bangalore". The " at " shape keeps the
   * location slot, phone numbers and the name itself out.
   */
  function pickCandidateHeadline(texts, name) {
    var norm = String(name || "").replace(/\s+/g, " ").trim().toLowerCase();
    for (var i = 0; i < (texts || []).length; i++) {
      var lines = String(texts[i] || "").split(/\n+/);
      for (var j = 0; j < lines.length; j++) {
        var t = lines[j].replace(/\s+/g, " ").trim();
        if (t.length < 5 || t.length > 200) continue;
        if (norm && t.toLowerCase() === norm) continue;
        if (/^applied\b/i.test(t)) continue;
        if (/\S\s+(?:at|@)\s+\S/i.test(t)) return t;
      }
    }
    return "";
  }

  /* ── Salary from screening answers (current / expected CTC) ── */

  var CURRENCY_CODES = ["INR", "EUR", "USD", "GBP", "SGD", "AUD", "CAD", "AED", "MYR", "PHP",
    "PLN", "CHF", "JPY", "CNY", "HKD", "NZD", "ZAR", "BRL", "MXN", "BGN", "RON", "CZK", "HUF", "SEK", "NOK", "DKK"];

  function detectCurrency(s) {
    s = String(s || "");
    if (/₹|\brs\.?(?=\s|\d)|rupee/i.test(s)) return "INR";
    var m = new RegExp("\\b(" + CURRENCY_CODES.join("|") + ")\\b", "i").exec(s);
    if (m) return m[1].toUpperCase();
    if (/€/.test(s)) return "EUR";
    if (/£/.test(s)) return "GBP";
    if (/\$/.test(s)) return "USD";
    return "";
  }

  /** Multiplier named right after a number: "25 LPA", "1.2 Cr", "45k", "2 million". */
  function unitMult(s) {
    s = String(s || "").toLowerCase().replace(/^\s*\+/, "");
    if (/^\s*(?:cr|crores?)\b/.test(s)) return 1e7;
    if (/^\s*(?:l|lpa|lakhs?|lacs?|lakh)\b/.test(s)) return 1e5;
    if (/^\s*(?:m|mn|million)\b/.test(s)) return 1e6;
    if (/^\s*k\b/.test(s)) return 1e3;
    return 0;
  }

  /**
   * "2,00,000 to 5,00,000 INR" → { lo: 200000, hi: 500000, currency: "INR" }.
   * Open bands: "Above 30 LPA" → { lo, hi: null }; "Up to 5 LPA" → { lo: null, hi }.
   * A unit on either side applies to both ("8 to 11 LPA"). null if no number.
   */
  function parseSalaryBand(text) {
    var s = String(text || "").replace(/[–—]/g, "-");
    var re = /\d[\d,]*(?:\.\d+)?/g, m, nums = [];
    while ((m = re.exec(s))) nums.push({ v: parseFloat(m[0].replace(/,/g, "")), end: m.index + m[0].length, start: m.index });
    if (!nums.length) return null;
    var mults = nums.map(function (n, i) {
      var seg = s.slice(n.end, i + 1 < nums.length ? nums[i + 1].start : s.length);
      return unitMult(seg);
    });
    var shared = 0;
    for (var k = 0; k < mults.length; k++) if (mults[k]) shared = mults[k];
    var vals = nums.map(function (n, i) { return n.v * (mults[i] || shared || 1); });
    var currency = detectCurrency(s);
    // Indian lakh grouping (2,00,000) or a lakh/crore unit means rupees.
    if (!currency && (/\d,\d\d,\d{3}/.test(s) || shared === 1e5 || shared === 1e7)) currency = "INR";
    var isRange = vals.length >= 2 && (/\d[^\d]*?(?:-|\bto\b)\s*[^\d]*\d/i.test(s) || /\bbetween\b/i.test(s));
    if (isRange) return { lo: Math.min(vals[0], vals[1]), hi: Math.max(vals[0], vals[1]), currency: currency };
    var v = vals[0];
    if (/\b(?:above|over|more than|greater than|min(?:imum)?)\b|\d\s*\+/i.test(s)) return { lo: v, hi: null, currency: currency };
    if (/\b(?:below|under|less than|up ?to|max(?:imum)?)\b/i.test(s)) return { lo: null, hi: v, currency: currency };
    return { lo: v, hi: v, currency: currency };
  }

  /** India only: "2–5 L INR", "30+ L INR", "up to 5 L INR". */
  function formatLakhBand(b) {
    var f = function (v) { return String(Math.round(v / 1e5 * 10) / 10); };
    var body;
    if (b.lo != null && b.hi != null) body = b.lo === b.hi ? f(b.lo) : f(b.lo) + "–" + f(b.hi);
    else if (b.lo != null) body = f(b.lo) + "+";
    else body = "up to " + f(b.hi);
    return body + " L INR";
  }

  var SALARY_Q = /\b(?:ctc|salary|compensation|remuneration|pay|package|wages?)\b|cost to (?:the )?company/i;
  var CURRENT_Q = /\b(?:current|present|existing|last drawn|latest)\b/i;
  var EXPECTED_Q = /\b(?:expected|expectations?|desired|expect|requirements?|looking for)\b/i;
  var MONTHLY_Q = /\b(?:monthly|per month|a month|p\.?m\.?)\b/i;

  // A prompt that doesn't end in "?"/":" — "Please, specify your salary expectations
  // in the currency of the country you're applying for (gross per year)" (Israel).
  var PROMPT_START = /^(?:please|kindly|what|how|which|specify|enter|provide|state|mention|share|indicate)\b/i;

  /**
   * Screening card text → [[question, answer], …]. A question ends in ":" or "?"
   * (a trailing "(…)" aside), or is a long line opening like a prompt.
   */
  function isScreeningQuestion(line) {
    if (/[?:]$/.test(line.replace(/(?:\s*\([^()]*\))+$/, ""))) return true;
    return line.length >= 25 && PROMPT_START.test(line);
  }

  function screeningPairs(text) {
    var lines = String(text || "").split(/\n+/).map(function (l) { return l.replace(/\s+/g, " ").trim(); })
      .filter(function (l) { return l && !/^(?:screening questions|see versions|last edit was made\b.*)$/i.test(l); });
    var pairs = [], q = null, ans = [];
    for (var i = 0; i < lines.length; i++) {
      if (isScreeningQuestion(lines[i])) {
        if (q) pairs.push([q, ans.join(" ")]);
        q = lines[i]; ans = [];
      } else if (q) ans.push(lines[i]);
    }
    if (q) pairs.push([q, ans.join(" ")]);
    return pairs;
  }

  /**
   * Note lines for the candidate's current and expected salary, from the screening
   * answers. Rupee answers keep the lakh shorthand recruiters in India use
   * ("Current CTC: 2–5 L INR"); every other answer goes in exactly as the candidate
   * typed it ("Expected salary: 27000"), so there's no doubt about what they said.
   */
  var SALARY_ANSWER_MAX = 200;
  function salaryNoteLines(screeningText) {
    var found = { current: null, expected: null };
    var pairs = screeningPairs(screeningText);
    for (var i = 0; i < pairs.length; i++) {
      var q = pairs[i][0], a = pairs[i][1];
      if (!a || !SALARY_Q.test(q)) continue;
      var isCur = CURRENT_Q.test(q), isExp = EXPECTED_Q.test(q);
      var kind = isExp && !isCur ? "expected" : isCur && !isExp ? "current" : null;
      if (!kind || found[kind]) continue;
      var band = parseSalaryBand(a);
      if (band && !band.currency) band.currency = detectCurrency(q);
      found[kind] = {
        label: (/\bctc\b|cost to/i.test(q) ? "CTC" : "salary") + (MONTHLY_Q.test(q) ? " (monthly)" : ""),
        answer: band && band.currency === "INR" ? formatLakhBand(band)
          : a.length > SALARY_ANSWER_MAX ? a.slice(0, SALARY_ANSWER_MAX - 1) + "…" : a,
      };
    }
    var lines = [];
    ["current", "expected"].forEach(function (kind) {
      var f = found[kind];
      if (!f) return;
      lines.push((kind === "current" ? "Current " : "Expected ") + f.label + ": " + f.answer);
    });
    return lines;
  }

  /**
   * Screening answers live on their own tab (#st-screening) and aren't in the DOM
   * while the Profile tab is open (live: screening 0 chars on every profile). Open
   * it, wait until the salary answers render (≤ SCREENING_WAIT_MS), and return the
   * card text. "" when the profile has no Screening tab (no extra wait then).
   */
  var SCREENING_WAIT_MS = 3000;
  async function readScreeningTab(doc, win, log) {
    var host = null;
    try { host = doc.getElementById(SR.id.screening); } catch (_) {}
    if (!host) host = findElementByIdDeep(doc.documentElement || doc.body, SR.id.screening);
    if (!host) { log.push({ ok: true, msg: "Salary: no Screening tab" }); return ""; }
    var target = host;
    try {
      if (!(host.matches && host.matches(SR.sel.screeningTabHost))) target = host.querySelector(SR.sel.screeningTabInner) || host;
    } catch (_) {}
    try { target.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
    await sleep(50);
    try { target.click(); } catch (_) {}
    var text = "", lastLen = -1, t0 = Date.now();
    while (Date.now() - t0 < SCREENING_WAIT_MS) {
      await sleep(200);
      try { text = getScreeningText(doc, win); } catch (_) { text = ""; }
      if (text && salaryNoteLines(text).length) break;
      // Answers rendered but none is a salary question: stop once the text is stable.
      if (text && text.length === lastLen) break;
      lastLen = text ? text.length : -1;
    }
    log.push({ ok: true, msg: "Salary: Screening tab read (" + text.length + " chars, " + (Date.now() - t0) + " ms)" });
    return text;
  }

  /**
   * The headline under the candidate's name (current title and company): the
   * personal-info row first, then the candidate header blob.
   */
  function getCandidateHeadline(doc, name) {
    var texts = [];
    try {
      var inputs = getProfileLocationInputs(doc);
      texts = inputs.otherTexts.concat(inputs.slotTexts);
    } catch (_) {}
    var hit = pickCandidateHeadline(texts, name);
    if (hit) return hit;
    try { return pickCandidateHeadline([getCandidateHeaderText(doc)], name); } catch (_) {}
    return "";
  }

  /**
   * Extract text from pdf.js text layers — SR sometimes renders resumes via
   * pdf.js which overlays <span> elements on a <canvas>.  The canvas itself
   * is pixels (invisible to innerText) but the text layer spans are real DOM.
   */
  function getPdfTextLayerText(doc) {
    var chunks = [];
    var pdfRoot = doc.querySelector(SR.sel.candidateView) || doc.body || doc.documentElement;
    var selectors = SR.sel.pdfTextLayer;
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
    var root = doc.querySelector(SR.sel.candidateView) || doc.body;
    if (!root) return "";
    var selectors = SR.sel.profileOverview;
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
    var root = doc.querySelector(SR.sel.candidateView) || doc.body || doc.documentElement;
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
    var tabSelectors = SR.sel.resumeTab;
    var root = doc.querySelector(SR.sel.candidateView) || doc.body;
    if (!root) return false;

    // The "Latest Resume" attachment link also says "resume", but clicking it opens the
    // file in a NEW tab instead of switching the viewer — those tabs were left open
    // after runs. Never click a link that leaves the page; the attachment fallback
    // (srArmResumeCapture) opens it deliberately when it's really needed.
    function opensNewPage(el) {
      if (!el || el.tagName !== "A") return false;
      var href = (el.getAttribute && el.getAttribute("href")) || "";
      var target = (el.getAttribute && el.getAttribute("target")) || "";
      var txt = (el.textContent || "").trim().toLowerCase();
      return target === "_blank" || /attachment|download/i.test(href) || /^latest\s+r[eé]sum[eé]/.test(txt);
    }

    function findResumeTab(r) {
      for (var s = 0; s < tabSelectors.length; s++) {
        try {
          var els = r.querySelectorAll(tabSelectors[s]);
          for (var i = 0; i < els.length; i++) {
            if (opensNewPage(els[i])) continue;
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
          if ((t.includes("resume") || t.includes("résumé") || t === "cv") && !opensNewPage(node) &&
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

      var root = doc.querySelector(SR.sel.candidateView) || doc.body || doc.documentElement;
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
    var root = doc.querySelector(SR.sel.candidateView) || doc.body;
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

  var api = {
    EXCLUDED_SELECTORS: EXCLUDED_SELECTORS,
    getExcludedText: getExcludedText,
    stripExcludedText: stripExcludedText,
    collectDeepText: collectDeepText,
    getResumeText: getResumeText,
    getResumeOnlyText: getResumeOnlyText,
    resumeWasRead: resumeWasRead,
    nudgeResumeViewerScroll: nudgeResumeViewerScroll,
    requestResumeRenderFocus: requestResumeRenderFocus,
    releaseResumeRenderFocus: releaseResumeRenderFocus,
    findResumeAttachmentLink: findResumeAttachmentLink,
    describeResumeViewer: describeResumeViewer,
    tryAttachmentResumeFallback: tryAttachmentResumeFallback,
    getCandidateHeaderText: getCandidateHeaderText,
    getCandidateName: getCandidateName,
    elText: elText,
    getProfileLocationInputs: getProfileLocationInputs,
    getCandidateLocation: getCandidateLocation,
    pickCandidateHeadline: pickCandidateHeadline,
    getCandidateHeadline: getCandidateHeadline,
    salaryNoteLines: salaryNoteLines,
    parseSalaryBand: parseSalaryBand,
    readScreeningTab: readScreeningTab,
    getPdfTextLayerText: getPdfTextLayerText,
    getProfileOverviewText: getProfileOverviewText,
    getFullPageText: getFullPageText,
    getScreeningText: getScreeningText,
    ensureResumeTabActive: ensureResumeTabActive,
    PDF_SETTLE_MS: PDF_SETTLE_MS,
    makeResumeTextWaiter: makeResumeTextWaiter,
    ensureProfileTabActive: ensureProfileTabActive,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.__srKw = Object.assign(globalThis.__srKw || {}, api);
})();
