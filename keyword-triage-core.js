// keyword-triage-core.js — SmartRecruiters keyword search on resume + notes tagging
// Exposes: __srKeywordTriageRun, __srKeywordTriageRunMulti, __srKeywordTriageStartQueue,
//          __srCollectApplicantClickTargets (shared with salary-triage)
// Runs a scan with the keyword-*.js modules (dom, matching, extract, pipeline, notes,
// diag), which load before it; see their headers.

(function () {
  "use strict";

  // Node: require(). Browser: modules loaded earlier put their exports on
  // globalThis.__srKw; a missing name means a loader got the order wrong.
  function need(file, names) {
    var mod = typeof module !== "undefined" && module.exports ? require("./" + file) : globalThis.__srKw || {};
    names.forEach(function (n) {
      if (mod[n] === undefined) throw new Error(n + " missing: load " + file + " before keyword-triage-core.js");
    });
    return mod;
  }
  var domMod = need("keyword-dom.js", ["sleep", "makePhaseTimer", "isCandidateProfilePage"]);
  var matchingMod = need("keyword-matching.js", [
    "expandOneBooleanTerm", "normalizeForKw", "dedupeTextSegments", "collapseInlineRepeats",
    "sepFlexiblePatternSource", "isoListHit", "buildTokenIndex", "kwHitsInIndex", "findKeywordHits",
    "deduplicateHitsByCanonical", "countsFromResume", "parseBooleanQuery", "extractLeafTerms",
    "evaluateBooleanAst", "looksLikeSrSummaryChrome"
  ]);
  var extractMod = need("keyword-extract.js", [
    "getExcludedText", "stripExcludedText", "getResumeText", "resumeWasRead",
    "nudgeResumeViewerScroll", "requestResumeRenderFocus", "releaseResumeRenderFocus",
    "describeResumeViewer", "tryAttachmentResumeFallback", "getCandidateHeaderText",
    "getPdfTextLayerText", "getProfileOverviewText", "getFullPageText", "getScreeningText",
    "ensureResumeTabActive", "makeResumeTextWaiter", "ensureProfileTabActive",
    "salaryNoteLines", "readScreeningTab"
  ]);
  var pipelineMod = need("keyword-pipeline.js", [
    "hasSrProfileChrome", "harvestProfileUrls", "collectApplicantClickTargets", "fireClick", "readJobCountry"
  ]);
  var notesMod = need("keyword-notes.js", [
    "displayKeywordLabel", "formatNoteText", "formatNoteHtml", "noteConfirmMarker", "feedDeltaCount",
    "prepareNotesSection", "postKeywordHitsToNotes"
  ]);
  var diagMod = need("keyword-diag.js", [
    "DIAG_KEY_PREFIX", "DIAG_MAX_ENTRIES", "DIAG_TEXT_CAP", "DIAG_SOURCE_CAP", "capText",
    "getDiagRawCapture", "sanitizeDiagEntry", "saveProfileDiag"
  ]);
  var sleep = domMod.sleep,
      makePhaseTimer = domMod.makePhaseTimer,
      isCandidateProfilePage = domMod.isCandidateProfilePage;
  var expandOneBooleanTerm = matchingMod.expandOneBooleanTerm,
      normalizeForKw = matchingMod.normalizeForKw,
      dedupeTextSegments = matchingMod.dedupeTextSegments,
      collapseInlineRepeats = matchingMod.collapseInlineRepeats,
      sepFlexiblePatternSource = matchingMod.sepFlexiblePatternSource,
      isoListHit = matchingMod.isoListHit,
      buildTokenIndex = matchingMod.buildTokenIndex,
      kwHitsInIndex = matchingMod.kwHitsInIndex,
      findKeywordHits = matchingMod.findKeywordHits,
      deduplicateHitsByCanonical = matchingMod.deduplicateHitsByCanonical,
      countsFromResume = matchingMod.countsFromResume,
      parseBooleanQuery = matchingMod.parseBooleanQuery,
      extractLeafTerms = matchingMod.extractLeafTerms,
      evaluateBooleanAst = matchingMod.evaluateBooleanAst,
      looksLikeSrSummaryChrome = matchingMod.looksLikeSrSummaryChrome;
  var getExcludedText = extractMod.getExcludedText,
      stripExcludedText = extractMod.stripExcludedText,
      getResumeText = extractMod.getResumeText,
      resumeWasRead = extractMod.resumeWasRead,
      nudgeResumeViewerScroll = extractMod.nudgeResumeViewerScroll,
      requestResumeRenderFocus = extractMod.requestResumeRenderFocus,
      releaseResumeRenderFocus = extractMod.releaseResumeRenderFocus,
      describeResumeViewer = extractMod.describeResumeViewer,
      tryAttachmentResumeFallback = extractMod.tryAttachmentResumeFallback,
      getCandidateHeaderText = extractMod.getCandidateHeaderText,
      getPdfTextLayerText = extractMod.getPdfTextLayerText,
      getProfileOverviewText = extractMod.getProfileOverviewText,
      getFullPageText = extractMod.getFullPageText,
      getScreeningText = extractMod.getScreeningText,
      ensureResumeTabActive = extractMod.ensureResumeTabActive,
      makeResumeTextWaiter = extractMod.makeResumeTextWaiter,
      ensureProfileTabActive = extractMod.ensureProfileTabActive,
      salaryNoteLines = extractMod.salaryNoteLines,
      readScreeningTab = extractMod.readScreeningTab;
  var hasSrProfileChrome = pipelineMod.hasSrProfileChrome,
      harvestProfileUrls = pipelineMod.harvestProfileUrls,
      collectApplicantClickTargets = pipelineMod.collectApplicantClickTargets,
      fireClick = pipelineMod.fireClick,
      readJobCountry = pipelineMod.readJobCountry;
  var displayKeywordLabel = notesMod.displayKeywordLabel,
      formatNoteText = notesMod.formatNoteText,
      formatNoteHtml = notesMod.formatNoteHtml,
      noteConfirmMarker = notesMod.noteConfirmMarker,
      feedDeltaCount = notesMod.feedDeltaCount,
      prepareNotesSection = notesMod.prepareNotesSection,
      postKeywordHitsToNotes = notesMod.postKeywordHitsToNotes;
  var DIAG_KEY_PREFIX = diagMod.DIAG_KEY_PREFIX,
      DIAG_MAX_ENTRIES = diagMod.DIAG_MAX_ENTRIES,
      DIAG_TEXT_CAP = diagMod.DIAG_TEXT_CAP,
      DIAG_SOURCE_CAP = diagMod.DIAG_SOURCE_CAP,
      capText = diagMod.capText,
      getDiagRawCapture = diagMod.getDiagRawCapture,
      sanitizeDiagEntry = diagMod.sanitizeDiagEntry,
      saveProfileDiag = diagMod.saveProfileDiag;

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
        try { log.push({ ok: false, msg: describeResumeViewer(doc) }); } catch (_) {}
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
      // Salary answers are on the Screening tab, not the Profile tab: open it only
      // when the profile-tab text had none (it is a note-only field). Off unless the
      // popup found a non-EU/EEA job country at run start (config.salaryNotes).
      if (!config.salaryNotes) {
        log.push({ ok: true, msg: "Salary: off for this run (job country EU/EEA or unknown)" });
      } else if (!salaryNoteLines(screeningText).length) {
        try { var tabScreening = await readScreeningTab(doc, win, log); if (tabScreening) screeningText = tabScreening; } catch (_) {}
      }
      phase.mark("screeningTab");
      try { await prepareNotesSection(doc, win, log); } catch (_) {}
      phase.mark("notesPrepare");
      try {
        notesPosted = await postKeywordHitsToNotes(doc, win, hitLabels, hitCount, userKeywordCount, log, "", { partialScan: !resumeWasRead(resumeText, resumeIsChrome), resumeText: resumeWasRead(resumeText, resumeIsChrome) ? resumeText : "", screeningText: config.salaryNotes ? screeningText : "" });
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
        try { log.push({ ok: false, msg: describeResumeViewer(doc) }); } catch (_) {}
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
      // Salary answers are on the Screening tab, not the Profile tab: open it only
      // when the profile-tab text had none (it is a note-only field). Off unless the
      // popup found a non-EU/EEA job country at run start (config.salaryNotes).
      if (!config.salaryNotes) {
        log.push({ ok: true, msg: "Salary: off for this run (job country EU/EEA or unknown)" });
      } else if (!salaryNoteLines(screeningText).length) {
        try { var tabScreening = await readScreeningTab(doc, win, log); if (tabScreening) screeningText = tabScreening; } catch (_) {}
      }
      phase.mark("screeningTab");
      try { await prepareNotesSection(doc, win, log); } catch (_) {}
      phase.mark("notesPrepare");
      var boolPrefix = booleanPass ? "[PASS] " : "[FAIL] ";
      try {
        notesPosted = await postKeywordHitsToNotes(doc, win, allHitLabels, allHitLabels.length, totalTerms, log, boolPrefix, { partialScan: !resumeWasRead(resumeText, resumeIsChromeBool), resumeText: resumeWasRead(resumeText, resumeIsChromeBool) ? resumeText : "", screeningText: config.salaryNotes ? screeningText : "" });
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
      displayKeywordLabel: displayKeywordLabel,
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
  globalThis.__srEnsureResumeTabActive = function () {
    return ensureResumeTabActive(document, window);
  };
  globalThis.__srWaitForResumeText = function (maxMs) {
    return makeResumeTextWaiter(document, maxMs);
  };
  globalThis.__srReadJobCountry = function () {
    return readJobCountry(document, window);
  };
  globalThis.__srHarvestProfileUrls = function () {
    return harvestProfileUrls(document, window);
  };
  globalThis.__srHasSrProfileChrome = function (doc) {
    return hasSrProfileChrome(doc || document);
  };
})();
