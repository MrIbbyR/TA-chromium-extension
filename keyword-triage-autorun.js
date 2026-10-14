
// keyword-triage-autorun.js — URL queue OR click-through queue for keyword triage

(function () {
  "use strict";

  var KEY = "sr_ext_keyword_triage_v1";

  var __aborted = false;
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && changes.srAbortAll && changes.srAbortAll.newValue) __aborted = true;
    });
  } catch (_) {}

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function jitter(baseMs) {
    var lo = Math.round(baseMs * 0.65);
    var hi = Math.round(baseMs * 1.35);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  function sleepJitter(baseMs) {
    return sleep(jitter(baseMs));
  }

  function roundPhases(p) {
    var out = {};
    for (var k in p) if (typeof p[k] === "number") out[k] = Math.round(p[k]);
    return out;
  }

  function normUrl(u) {
    try {
      var x = new URL(u, location.href);
      return (x.origin + x.pathname.replace(/\/$/, "")).toLowerCase();
    } catch (_) { return ""; }
  }

  function isProfilePage() {
    return /\/app\/people\/(?:applications|profile)\/[^/?#]+/i.test(location.pathname);
  }

  function hasSrQueueControls() {
    if (typeof globalThis.__srHasSrProfileChrome === "function") {
      try { return globalThis.__srHasSrProfileChrome(document); } catch (_) {}
    }
    try {
      return !!document.getElementById("st-moveForward") || !!document.getElementById("st-screening");
    } catch (_) { return false; }
  }

  async function waitUntilProfileAfterListClick(maxMs) {
    var step = 200;
    var start = Date.now();
    while (Date.now() - start < maxMs) {
      if (__aborted) return false;
      if (isProfilePage()) return true;
      await sleep(step);
    }
    return isProfilePage();
  }

  async function waitUntilSrControlsReady(maxMs) {
    var step = 200;
    var start = Date.now();
    while (Date.now() - start < maxMs) {
      if (__aborted) return false;
      if (isProfilePage() && hasSrQueueControls()) return true;
      await sleep(step);
    }
    return hasSrQueueControls();
  }

  function queueKind(state) {
    if (state.kind === "click" || state.kind === "urls") return state.kind;
    if (state.queue && state.queue.length > 0) return "urls";
    return null;
  }

  function isValidState(state, kind) {
    if (kind === "urls") return state.queue && Array.isArray(state.queue) && state.queue.length > 0;
    if (kind === "click")
      return state.total > 0 && typeof state.clickIndex === "number" &&
        state.clickIndex >= 0 && state.clickIndex < state.total && !!state.returnUrl;
    return false;
  }

  function playBeep(type) {
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      var ctx = new AudioCtx();
      var freqs = type === "done" ? [880, 1100] : [440];
      function doPlay() {
        freqs.forEach(function (freq, i) {
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = "sine";
          osc.frequency.value = freq;
          var t = ctx.currentTime + i * 0.22;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(0.28, t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
          osc.start(t);
          osc.stop(t + 0.5);
        });
      }
      if (ctx.state === "suspended") {
        ctx.resume().then(doPlay).catch(function () {});
      } else {
        doPlay();
      }
    } catch (_) {}
  }

  function showToast(msg) {
    var d = document.createElement("div");
    d.textContent = msg;
    d.style.cssText =
      "position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:280px;padding:12px 14px;background:#111;color:#6ea8ff;font:12px system-ui,Segoe UI,sans-serif;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.55);border:1px solid #222";
    document.body.appendChild(d);
    setTimeout(function () { try { d.remove(); } catch (_) {} }, 5000);
  }

  async function finishQueue(state, resultsLen) {                              // P0-2: made async
    try { playBeep("done"); } catch (_) {}
    try {
      if (chrome.runtime && chrome.runtime.sendMessage) {
        var matched = (state.results || []).filter(function (r) { return r.hitCount > 0; }).length;
        chrome.runtime.sendMessage(
          { type: "srQueueDone", resultsLen: resultsLen, matchedLen: matched },
          function () { chrome.runtime.lastError; }
        );
      }
    } catch (_) {}
    await __srSessionRemove(KEY);                                              // P0-2: was sessionStorage.removeItem
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          keywordTriageLastRun: {
            finishedAt: Date.now(),
            log: state.log || [],
            results: state.results || [],
          },
        });
      }
    } catch (_) {}
    try {
      if (chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: "srCloseExtraProfileTabs" }, function () {
          chrome.runtime.lastError;
        });
      }
    } catch (_) {}
    var back = state.returnUrl && String(state.returnUrl).trim();
    if (back && /^https?:\/\//i.test(back) && /smartrecruiters\.com/i.test(back)) {
      showToast("Keyword search: done — returning to list.");
      setTimeout(function () { window.location.replace(back); }, 400);
    } else {
      showToast("Keyword search: finished (" + resultsLen + " profiles).");
    }
  }

  async function runClickListStep(state) {
    var ru = normUrl(state.returnUrl);
    var here = normUrl(location.href);
    if (ru && here !== ru) {
      window.location.replace(state.returnUrl);
      return;
    }
    await sleep(650);
    if (typeof globalThis.__srAutoscrollApplicantListUntilLoaded === "function") {
      try {
        await globalThis.__srAutoscrollApplicantListUntilLoaded();
      } catch (_) {}
    }
    var collect = globalThis.__srCollectApplicantClickTargets;
    if (typeof collect !== "function") {
      showToast("Keyword search: extension core missing — reload extension.");
      await __srSessionRemove(KEY);                                            // P0-2: was sessionStorage.removeItem
      return;
    }
    var targets = collect();
    if (!targets || !targets.length) {
      showToast("Keyword search: no names on page — scroll Applicants, then Stop and retry.");
      await __srSessionRemove(KEY);                                            // P0-2: was sessionStorage.removeItem
      return;
    }
    if (state.clickIndex >= targets.length) {
      showToast("Keyword search: fewer rows than queued — scroll to load all, or Stop.");
      await __srSessionRemove(KEY);                                            // P0-2: was sessionStorage.removeItem
      return;
    }
    var el = targets[state.clickIndex];
    try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
    await sleep(200);
    try { el.click(); } catch (_) {
      try {
        var r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent("click", {
          bubbles: true, cancelable: true,
          clientX: r.left + Math.min(r.width / 2, 80),
          clientY: r.top + Math.min(r.height / 2, 20),
          view: window,
        }));
      } catch (_) {}
    }
  }

  // DataDome (SR's bot protection) shows its challenge in an iframe from captcha-delivery.com.
  // The background pauses the run and hands the tab to the recruiter.
  function botCheckVisible() {
    try {
      return !!document.querySelector('iframe[src*="captcha-delivery.com"], #ddChallengeBody');
    } catch (_) {
      return false;
    }
  }

  async function runAsParallelWorker(pageLoadMs) {
    if (!isProfilePage()) return false;
    if (window.__srParallelWorkerLock) return false;
    window.__srParallelWorkerLock = true;

    var pre = { pageLoad: pageLoadMs };
    var _tp = performance.now();
    var isWorker = false;
    try {
      var resp = await new Promise(function (resolve) {
        chrome.runtime.sendMessage({ type: "srIsParallelWorker", botCheck: botCheckVisible() }, function (r) {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r);
        });
      });
      // Only claim tabs belonging to a KEYWORD queue — the salary autorun runs on the
      // same profile pages and claims feature === "salary" tabs (undefined = legacy keyword).
      isWorker = resp && resp.active && (resp.feature === "keyword" || resp.feature == null);
    } catch (_) {}
    if (!isWorker) { window.__srParallelWorkerLock = false; return false; }

    var cfgData = null;
    try {
      var store = await chrome.storage.local.get(["srParallelWorkerConfig"]);
      cfgData = store.srParallelWorkerConfig;
    } catch (_) {}
    if (!cfgData) { window.__srParallelWorkerLock = false; return false; }
    pre.checkIn = performance.now() - _tp; _tp = performance.now();

    await sleepJitter(Math.max(1500, parseInt(cfgData.resumeWaitMs, 10) || 3000));
    pre.preStartWait = performance.now() - _tp; _tp = performance.now();

    var controlsOk = await waitUntilSrControlsReady(12000);
    pre.controlsWait = performance.now() - _tp;
    if (!controlsOk) {
      try {
        chrome.runtime.sendMessage(
          {
            type: "srWorkerDone",
            hitCount: 0,
            matchedKeywords: [],
            notesPosted: false,
            error: "controls_timeout",
            botCheck: botCheckVisible(),
            timings: roundPhases(pre),
          },
          function () {
            chrome.runtime.lastError;
          }
        );
      } catch (_) {}
      return true;
    }

    var result;
    try {
      var runner =
        typeof globalThis.__srKeywordTriageRunMulti === "function"
          ? globalThis.__srKeywordTriageRunMulti
          : globalThis.__srKeywordTriageRun;
      result = await runner(Object.assign({}, cfgData, { __prePhases: pre }));
    } catch (e) {
      result = {
        hitCount: 0,
        matchedKeywords: [],
        moved: false,
        log: [{ ok: false, msg: String((e && e.message) || e) }],
      };
    }
    var timings = Object.assign(roundPhases(pre), result.timings || {});

    var workerNotesFailed = (result.hitCount || 0) > 0 && !result.notesPosted;
    var workerNoHits = (result.hitCount || 0) === 0;
    var workerDiagLog = [];
    if (workerNotesFailed || workerNoHits) {
      workerDiagLog = (result.log || []).filter(function (e) {
        if (!e.ok) return true;
        var m = e.msg || "";
        return /^(Resume:|Total text:|Shadow-DOM|Extended scan|Retry recovered|Notes:\s*(confirmed|Post clicked|UNCONFIRMED|value confirmed))/i.test(m);
      }).map(function (e) { return (e.ok ? "· " : "✗ ") + (e.msg || ""); }).filter(Boolean).slice(0, 12);
    }

    try {
      var resp2 = await new Promise(function (resolve) {
        chrome.runtime.sendMessage(
          {
            type: "srWorkerDone",
            hitCount: result.hitCount || 0,
            matchedKeywords: result.matchedKeywords || [],
            booleanPass: result.booleanPass,
            notesPosted: !!result.notesPosted,
            notesFailReason: result.notesFailReason || "",
            textStats: result.textStats || null,
            diagLog: workerDiagLog.length ? workerDiagLog : undefined,
            botCheck: botCheckVisible(),
            timings: timings,
          },
          function (r) {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(r);
          }
        );
      });
      if (resp2 && resp2.next && resp2.url) {
        return true;
      }
    } catch (_) {}

    return true;
  }

  async function main() {
    if (!/smartrecruiters\.com/i.test(location.hostname)) return;
    if (window.top !== window.self) return;
    // performance.now() is relative to this document's navigation start.
    var pageLoadMs = performance.now();

    try {
      var wasWorker = await runAsParallelWorker(pageLoadMs);
      if (wasWorker) return;
    } catch (_) {}

    var raw = await __srSessionGet(KEY);                                       // P0-2: was sessionStorage.getItem
    if (!raw) return;

    var state;
    try { state = JSON.parse(raw); } catch (_) {
      await __srSessionRemove(KEY);                                            // P0-2: was sessionStorage.removeItem
      return;
    }

    var kind = queueKind(state);
    if (!kind || !isValidState(state, kind)) {
      await __srSessionRemove(KEY);                                            // P0-2: was sessionStorage.removeItem
      return;
    }

    __aborted = false;
    try {
      var stored = await new Promise(function (r) { chrome.storage.local.get(["srAbortAll"], r); });
      if (stored && stored.srAbortAll) { await __srSessionRemove(KEY); return; } // P0-2: was sessionStorage.removeItem
    } catch (_) {}

    if (typeof globalThis.__srKeywordTriageRun !== "function" &&
        typeof globalThis.__srKeywordTriageRunMulti !== "function") return;

    var g = window;
    if (g.__srKeywordAutorunLock) return;
    g.__srKeywordAutorunLock = true;

    try {
      var queueReadyCap = Math.max(3000, parseInt(state.config && state.config.queueReadyMaxMs, 10) || 16000);

      if (kind === "click" && !isProfilePage()) {
        await runClickListStep(state);
        var arrived = await waitUntilProfileAfterListClick(queueReadyCap);
        if (!arrived) {
          showToast("Keyword search: profile did not open — skipping candidate.");
          state.results = state.results || [];
          state.results.push({ url: state.returnUrl, clickIndex: state.clickIndex, skipped: true, error: "click_navigate_timeout" });
          var nextAfterMiss = state.clickIndex + 1;
          if (nextAfterMiss >= state.total) { await finishQueue(state, state.results.length); return; } // P0-2: await async finishQueue
          state.clickIndex = nextAfterMiss;
          await __srSessionSet(KEY, JSON.stringify(state));                     // P0-2: was sessionStorage.setItem
          await sleepJitter(1000);
          window.location.replace(state.returnUrl);
          return;
        }
      }

      if (kind === "urls" && !isProfilePage()) {
        var next = state.queue[0];
        if (next && normUrl(location.href) !== normUrl(next)) {
          window.location.replace(next);
        }
        return;
      }

      if (kind === "urls" && isProfilePage()) {
        var here = normUrl(location.href);
        var first = normUrl(state.queue[0]);
        if (here !== first) {
          window.location.replace(state.queue[0]);
          return;
        }
      }

      if (!isProfilePage()) return;

      var _qT0 = performance.now();
      var qPre = { pageLoad: pageLoadMs };
      var cfgWait = state.config && state.config.resumeWaitMs;
      var delay = Math.max(400, parseInt(state.initialDelayMs, 10) || parseInt(cfgWait, 10) || 2000);
      await sleep(delay);
      qPre.preStartWait = performance.now() - _qT0;

      var controlsOk = await waitUntilSrControlsReady(queueReadyCap);
      qPre.controlsWait = performance.now() - _qT0 - qPre.preStartWait;
      if (__aborted) { await __srSessionRemove(KEY); return; }                 // P0-2: was sessionStorage.removeItem
      if (!controlsOk) {
        showToast("Keyword search: pipeline UI not ready — check network.");
        state.log = (state.log || []).concat([
          { ok: false, msg: "Queue: timed out waiting for SR controls after navigation." },
        ]);
        state.results = state.results || [];
        state.results.push({
          url: location.href, moved: false, hitCount: 0,
          matchedKeywords: [], clickIndex: kind === "click" ? state.clickIndex : undefined,
          error: "queue_controls_timeout",
        });
        if (kind === "urls") {
          state.queue.shift();
          if (state.queue.length === 0) { await finishQueue(state, state.results.length); return; } // P0-2: await async finishQueue
          var _ok = await __srSessionSet(KEY, JSON.stringify(state));           // P0-2: was sessionStorage.setItem
          if (!_ok) { await __srSessionRemove(KEY); return; }                  // P0-2: was catch → removeItem
          await sleepJitter(2200);
          window.location.replace(state.queue[0]);
          return;
        }
        var nextClick = state.clickIndex + 1;
        if (nextClick >= state.total) { await finishQueue(state, state.results.length); return; } // P0-2: await async finishQueue
        state.clickIndex = nextClick;
        var _ok2 = await __srSessionSet(KEY, JSON.stringify(state));            // P0-2: was sessionStorage.setItem
        if (!_ok2) { await __srSessionRemove(KEY); return; }                   // P0-2: was catch → removeItem
        await sleepJitter(2200);
        window.location.replace(state.returnUrl);
        return;
      }

      var result;
      try {
        var runner = typeof globalThis.__srKeywordTriageRunMulti === "function"
          ? globalThis.__srKeywordTriageRunMulti
          : globalThis.__srKeywordTriageRun;
        result = await runner(Object.assign({}, state.config || {}, { __prePhases: qPre }));
      } catch (e) {
        result = {
          log: [{ ok: false, msg: String((e && e.message) || e) }],
          moved: false, skipped: true, matchedKeywords: [], hitCount: 0,
        };
      }

      state.log = (state.log || []).concat(result.log || []);
      state.results = state.results || [];
      // Build a compact diagnostic log for failures. Only stored when notes failed or
      // 0 hits were found — no storage cost on successful profiles.
      // Contains: all error entries + key stat/confirmation lines (max 12).
      var notesFailed = result.hitCount > 0 && !result.notesPosted;
      var noHits = result.hitCount === 0 && !result.skipped;
      var diagLog = [];
      if (notesFailed || noHits) {
        diagLog = (result.log || []).filter(function(e) {
          if (!e.ok) return true;
          var m = e.msg || "";
          return /^(Resume:|Total text:|Shadow-DOM|Extended scan|Retry recovered|Notes:\s*(confirmed|Post clicked|UNCONFIRMED|value confirmed))/i.test(m);
        }).map(function(e) {
          return (e.ok ? "· " : "✗ ") + (e.msg || "");
        }).filter(Boolean).slice(0, 12);
      }

      state.results.push({
        url: location.href,
        moved: !!result.moved,
        hitCount: result.hitCount || 0,
        matchedKeywords: result.matchedKeywords || [],
        notesPosted: !!result.notesPosted,
        notesFailReason: result.notesFailReason || "",
        booleanPass: result.booleanPass,
        skipped: !!result.skipped,
        textStats: result.textStats || null,
        totalMs: Math.round(performance.now() - _qT0),
        coreMs: result.totalMs || null,
        timings: Object.assign(roundPhases(qPre), result.timings || {}),
        diagLog: diagLog.length ? diagLog : undefined,
        clickIndex: kind === "click" ? state.clickIndex : undefined,
      });

      var afterMoveMs = Math.max(500, parseInt(state.config && state.config.afterMoveNavigateMs, 10) || 1600);
      if (result.moved) await sleep(afterMoveMs);
      // Small settle buffer after note-save (the API wait is done inside postKeywordHitsToNotes)
      if (result.notesPosted) await sleep(jitter(600));

      if (kind === "urls") {
        state.queue.shift();
        if (state.queue.length === 0) { await finishQueue(state, state.results.length); return; } // P0-2: await async finishQueue
        var _ok3 = await __srSessionSet(KEY, JSON.stringify(state));            // P0-2: was sessionStorage.setItem
        if (!_ok3) {                                                           // P0-2: was catch → removeItem
          await __srSessionRemove(KEY);
          showToast("Keyword search: queue lost (storage full).");
          return;
        }
        await sleepJitter(2200);
        window.location.replace(state.queue[0]);
        return;
      }

      var nextClick2 = state.clickIndex + 1;
      if (nextClick2 >= state.total) { await finishQueue(state, state.results.length); return; } // P0-2: await async finishQueue
      state.clickIndex = nextClick2;
      var _ok4 = await __srSessionSet(KEY, JSON.stringify(state));              // P0-2: was sessionStorage.setItem
      if (!_ok4) {                                                             // P0-2: was catch → removeItem
        await __srSessionRemove(KEY);
        showToast("Keyword search: queue lost (storage full).");
        return;
      }
      await sleepJitter(2200);
      window.location.replace(state.returnUrl);
    } finally {
      try { delete g.__srKeywordAutorunLock; } catch (_) { g.__srKeywordAutorunLock = false; }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { main().catch(function () {}); });
  } else {
    main().catch(function () {});
  }
})();