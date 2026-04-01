// keyword-triage-autorun.js — URL queue OR click-through queue for keyword triage

(function () {
  "use strict";

  var KEY = "sr_ext_keyword_triage_v1";

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
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
    try {
      return !!document.getElementById("st-moveForward") || !!document.getElementById("st-screening");
    } catch (_) { return false; }
  }

  async function waitUntilProfileAfterListClick(maxMs) {
    var step = 200;
    var start = Date.now();
    while (Date.now() - start < maxMs) {
      if (isProfilePage()) return true;
      await sleep(step);
    }
    return isProfilePage();
  }

  async function waitUntilSrControlsReady(maxMs) {
    var step = 200;
    var start = Date.now();
    while (Date.now() - start < maxMs) {
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

  function showToast(msg) {
    var d = document.createElement("div");
    d.textContent = msg;
    d.style.cssText =
      "position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:280px;padding:12px 14px;background:#111;color:#6ea8ff;font:12px system-ui,Segoe UI,sans-serif;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.55);border:1px solid #222";
    document.body.appendChild(d);
    setTimeout(function () { try { d.remove(); } catch (_) {} }, 5000);
  }

  function finishQueue(state, resultsLen) {
    sessionStorage.removeItem(KEY);
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
    var collect = globalThis.__srCollectApplicantClickTargets;
    if (typeof collect !== "function") {
      showToast("Keyword search: extension core missing — reload extension.");
      sessionStorage.removeItem(KEY);
      return;
    }
    var targets = collect();
    if (!targets || !targets.length) {
      showToast("Keyword search: no names on page — scroll Applicants, then Stop and retry.");
      sessionStorage.removeItem(KEY);
      return;
    }
    if (state.clickIndex >= targets.length) {
      showToast("Keyword search: fewer rows than queued — scroll to load all, or Stop.");
      sessionStorage.removeItem(KEY);
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

  async function main() {
    if (!/smartrecruiters\.com/i.test(location.hostname)) return;
    if (window.top !== window.self) return;

    var raw = sessionStorage.getItem(KEY);
    if (!raw) return;

    var state;
    try { state = JSON.parse(raw); } catch (_) {
      sessionStorage.removeItem(KEY);
      return;
    }

    var kind = queueKind(state);
    if (!kind || !isValidState(state, kind)) {
      sessionStorage.removeItem(KEY);
      return;
    }

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
          showToast("Keyword search: profile did not open (waited " + Math.round(queueReadyCap / 1000) + "s).");
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

      var cfgWait = state.config && state.config.resumeWaitMs;
      var delay = Math.max(400, parseInt(state.initialDelayMs, 10) || parseInt(cfgWait, 10) || 2000);
      await sleep(delay);

      var controlsOk = await waitUntilSrControlsReady(queueReadyCap);
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
          if (state.queue.length === 0) { finishQueue(state, state.results.length); return; }
          try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { sessionStorage.removeItem(KEY); return; }
          window.location.replace(state.queue[0]);
          return;
        }
        var nextClick = state.clickIndex + 1;
        if (nextClick >= state.total) { finishQueue(state, state.results.length); return; }
        state.clickIndex = nextClick;
        try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { sessionStorage.removeItem(KEY); return; }
        window.location.replace(state.returnUrl);
        return;
      }

      var result;
      try {
        var runner = typeof globalThis.__srKeywordTriageRunMulti === "function"
          ? globalThis.__srKeywordTriageRunMulti
          : globalThis.__srKeywordTriageRun;
        result = await runner(state.config || {});
      } catch (e) {
        result = {
          log: [{ ok: false, msg: String((e && e.message) || e) }],
          moved: false, skipped: true, matchedKeywords: [], hitCount: 0,
        };
      }

      state.log = (state.log || []).concat(result.log || []);
      state.results = state.results || [];
      state.results.push({
        url: location.href,
        moved: !!result.moved,
        hitCount: result.hitCount || 0,
        matchedKeywords: result.matchedKeywords || [],
        clickIndex: kind === "click" ? state.clickIndex : undefined,
      });

      var afterMoveMs = Math.max(500, parseInt(state.config && state.config.afterMoveNavigateMs, 10) || 1600);
      if (result.moved) await sleep(afterMoveMs);

      if (kind === "urls") {
        state.queue.shift();
        if (state.queue.length === 0) { finishQueue(state, state.results.length); return; }
        try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {
          sessionStorage.removeItem(KEY);
          showToast("Keyword search: queue lost (storage full).");
          return;
        }
        window.location.replace(state.queue[0]);
        return;
      }

      var nextClick2 = state.clickIndex + 1;
      if (nextClick2 >= state.total) { finishQueue(state, state.results.length); return; }
      state.clickIndex = nextClick2;
      try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {
        sessionStorage.removeItem(KEY);
        showToast("Keyword search: queue lost (storage full).");
        return;
      }
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
