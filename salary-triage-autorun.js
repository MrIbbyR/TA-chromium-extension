// salary-triage-autorun.js — URL queue OR click-through queue (same tab, return to Applicants list)

(function () {
  "use strict";

  const KEY = "sr_ext_salary_triage_v1";

  let __aborted = false;
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && changes.srAbortAll && changes.srAbortAll.newValue) __aborted = true;
    });
  } catch (_) {}

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function jitter(baseMs) {
    var lo = Math.round(baseMs * 0.65);
    var hi = Math.round(baseMs * 1.35);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  function sleepJitter(baseMs) {
    return sleep(jitter(baseMs));
  }

  function normUrl(u) {
    try {
      const x = new URL(u, location.href);
      return (x.origin + x.pathname.replace(/\/$/, "")).toLowerCase();
    } catch (_) {
      return "";
    }
  }

  function isProfilePage() {
    return /\/app\/people\/(?:applications|profile)\/[^/?#]+/i.test(location.pathname);
  }

  /** SR pipeline / screening hosts (light DOM ids — same as salary-triage-core). */
  function hasSrQueueControls() {
    if (typeof globalThis.__srHasSrProfileChrome === "function") {
      try { return globalThis.__srHasSrProfileChrome(document); } catch (_) {}
    }
    try {
      return !!document.getElementById("st-moveForward") || !!document.getElementById("st-screening");
    } catch (_) {
      return false;
    }
  }

  async function waitUntilProfileAfterListClick(maxMs) {
    const step = 200;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (__aborted) return false;
      if (isProfilePage()) return true;
      await sleep(step);
    }
    return isProfilePage();
  }

  async function waitUntilSrControlsReady(maxMs) {
    const step = 200;
    const start = Date.now();
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
      return (
        state.total > 0 &&
        typeof state.clickIndex === "number" &&
        state.clickIndex >= 0 &&
        state.clickIndex < state.total &&
        !!state.returnUrl
      );
    return false;
  }

  function showToast(msg) {
    const d = document.createElement("div");
    d.textContent = msg;
    d.style.cssText =
      "position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:280px;padding:12px 14px;background:#111;color:#00e5a0;font:12px system-ui,Segoe UI,sans-serif;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.55);border:1px solid #222";
    document.body.appendChild(d);
    setTimeout(function () {
      try {
        d.remove();
      } catch (_) {}
    }, 5000);
  }

  async function finishQueue(state, resultsLen) {                              // P0-2: made async
    await __srSessionRemove(KEY);                                              // P0-2: was sessionStorage.removeItem
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          salaryTriageLastRun: {
            finishedAt: Date.now(),
            log: (state.log || []).filter(function (e) {                       // P0-3: filter salary amounts from log
              return !(e.msg && /^Parsed amount:/i.test(e.msg));
            }),
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
    const back = state.returnUrl && String(state.returnUrl).trim();
    if (back && /^https?:\/\//i.test(back) && /smartrecruiters\.com/i.test(back)) {
      showToast("Cost assist: done — returning to list.");
      setTimeout(function () {
        window.location.replace(back);
      }, 400);
    } else {
      showToast("Cost assist: finished (" + resultsLen + " profiles).");
    }
  }

  async function runClickListStep(state) {
    const ru = normUrl(state.returnUrl);
    const here = normUrl(location.href);
    if (ru && here !== ru) {
      window.location.replace(state.returnUrl);
      return;
    }

    await sleep(300);

    if (typeof globalThis.__srAutoscrollApplicantListUntilLoaded === "function") {
      try {
        await globalThis.__srAutoscrollApplicantListUntilLoaded();
      } catch (_) {}
    }

    const collect = globalThis.__srCollectApplicantClickTargets;
    if (typeof collect !== "function") {
      showToast("Cost assist: extension core missing — reload extension.");
      await __srSessionRemove(KEY);                                            // P0-2: was sessionStorage.removeItem
      return;
    }

    const targets = collect();
    if (!targets || !targets.length) {
      showToast("Cost assist: no names on page — scroll Applicants, then Stop queue and retry.");
      await __srSessionRemove(KEY);                                            // P0-2: was sessionStorage.removeItem
      return;
    }

    if (state.clickIndex >= targets.length) {
      showToast("Cost assist: fewer rows than queued — scroll to load all, or Stop queue.");
      await __srSessionRemove(KEY);                                            // P0-2: was sessionStorage.removeItem
      return;
    }

    const el = targets[state.clickIndex];
    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (_) {}
    await sleep(200);
    try {
      el.click();
    } catch (_) {
      try {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            clientX: r.left + Math.min(r.width / 2, 80),
            clientY: r.top + Math.min(r.height / 2, 20),
            view: window,
          })
        );
      } catch (_) {}
    }
  }

  // ── Parallel worker path ──
  // The background opens 2–3 background tabs and feeds each a profile URL (mirrors the
  // keyword 2×/3× flow). Cost assist reads screening answers straight from the DOM with
  // no PDF/resume render, so worker tabs can stay hidden — none of the resume-focus dance.
  // DataDome (SR's bot protection) shows its challenge in an iframe from captcha-delivery.com.
  // The background pauses the run and hands the tab to the recruiter.
  function botCheckVisible() {
    try {
      return !!document.querySelector('iframe[src*="captcha-delivery.com"], #ddChallengeBody');
    } catch (_) {
      return false;
    }
  }

  async function runAsParallelWorker() {
    if (!isProfilePage()) return false;
    if (window.__srSalaryParallelWorkerLock) return false;
    window.__srSalaryParallelWorkerLock = true;

    let isWorker = false;
    try {
      const resp = await new Promise(function (resolve) {
        chrome.runtime.sendMessage({ type: "srIsParallelWorker", botCheck: botCheckVisible() }, function (r) {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r);
        });
      });
      // Claim only SALARY worker tabs — the keyword autorun runs on the same page and
      // claims feature === "keyword" tabs.
      isWorker = resp && resp.active && resp.feature === "salary";
    } catch (_) {}
    if (!isWorker) { window.__srSalaryParallelWorkerLock = false; return false; }

    let cfgData = null;
    try {
      const store = await chrome.storage.local.get(["srParallelWorkerConfig"]);
      cfgData = store.srParallelWorkerConfig;
    } catch (_) {}
    if (!cfgData) { window.__srSalaryParallelWorkerLock = false; return false; }

    const settle = Math.max(500, parseInt(cfgData.screeningWaitMs, 10) || 600);
    await sleepJitter(settle);

    const queueReadyCap = Math.max(3000, parseInt(cfgData.queueReadyMaxMs, 10) || 16000);
    const controlsOk = await waitUntilSrControlsReady(queueReadyCap);
    if (!controlsOk) {
      try {
        chrome.runtime.sendMessage(
          { type: "srWorkerDone", moved: false, error: "controls_timeout", botCheck: botCheckVisible() },
          function () { chrome.runtime.lastError; }
        );
      } catch (_) {}
      return true;
    }

    let result;
    try {
      const runner =
        typeof globalThis.__srSalaryTriageRunMulti === "function"
          ? globalThis.__srSalaryTriageRunMulti
          : globalThis.__srSalaryTriageRun;
      result = await runner(cfgData || {});
    } catch (e) {
      result = { moved: false, log: [{ ok: false, msg: String((e && e.message) || e) }] };
    }

    const afterMoveMs = Math.max(300, parseInt(cfgData.afterMoveNavigateMs, 10) || 600);
    if (result && result.moved) await sleep(afterMoveMs);

    try {
      // Background navigates the tab to the next URL itself (resp.next) — the worker
      // just reports and returns; the reloaded page re-enters runAsParallelWorker.
      await new Promise(function (resolve) {
        chrome.runtime.sendMessage(
          { type: "srWorkerDone", moved: !!(result && result.moved), botCheck: botCheckVisible() },
          function (r) { chrome.runtime.lastError; resolve(r); }
        );
      });
    } catch (_) {}

    return true;
  }

  async function main() {
    if (!/smartrecruiters\.com/i.test(location.hostname)) return;
    if (window.top !== window.self) return;

    try {
      const wasWorker = await runAsParallelWorker();
      if (wasWorker) return;
    } catch (_) {}

    const raw = await __srSessionGet(KEY);                                     // P0-2: was sessionStorage.getItem
    if (!raw) return;

    let state;
    try {
      state = JSON.parse(raw);
    } catch (_) {
      await __srSessionRemove(KEY);                                            // P0-2: was sessionStorage.removeItem
      return;
    }

    const kind = queueKind(state);
    if (!kind || !isValidState(state, kind)) {
      await __srSessionRemove(KEY);                                            // P0-2: was sessionStorage.removeItem
      return;
    }

    __aborted = false;
    try {
      const stored = await new Promise(function (r) { chrome.storage.local.get(["srAbortAll"], r); });
      if (stored && stored.srAbortAll) { await __srSessionRemove(KEY); return; } // P0-2: was sessionStorage.removeItem
    } catch (_) {}

    if (typeof globalThis.__srSalaryTriageRun !== "function" && typeof globalThis.__srSalaryTriageRunMulti !== "function")
      return;

    const g = window;
    if (g.__srSalaryAutorunLock) return;
    g.__srSalaryAutorunLock = true;

    try {
      const queueReadyCap = Math.max(3000, parseInt(state.config && state.config.queueReadyMaxMs, 10) || 16000);

      if (kind === "click" && !isProfilePage()) {
        await runClickListStep(state);
        const arrived = await waitUntilProfileAfterListClick(queueReadyCap);
        if (!arrived) {
          showToast(
            "Cost assist: profile did not open (waited " + Math.round(queueReadyCap / 1000) + "s). Retry or use URL queue."
          );
          return;
        }
      }

      if (kind === "urls" && !isProfilePage()) {
        const next = state.queue[0];
        if (next && normUrl(location.href) !== normUrl(next)) {
          window.location.replace(next);
        }
        return;
      }

      if (kind === "urls" && isProfilePage()) {
        const here = normUrl(location.href);
        const first = normUrl(state.queue[0]);
        if (here !== first) {
          window.location.replace(state.queue[0]);
          return;
        }
      }

      if (!isProfilePage()) return;

      const cfgWait = state.config && state.config.screeningWaitMs;
      const delay = Math.max(250, parseInt(state.initialDelayMs, 10) || parseInt(cfgWait, 10) || 500);
      await sleep(delay);

      const controlsOk = await waitUntilSrControlsReady(queueReadyCap);
      if (__aborted) { await __srSessionRemove(KEY); return; }                 // P0-2: was sessionStorage.removeItem
      if (!controlsOk) {
        showToast("Cost assist: pipeline UI not ready — increase Wait after Screening or check network.");
        state.log = (state.log || []).concat([
          { ok: false, msg: "Queue: timed out waiting for #st-moveForward / #st-screening after navigation." },
        ]);
        state.results = state.results || [];
        state.results.push({
          url: location.href,
          moved: false,
          // GDPR minimization (Art. 5(1)(c)): inBudget dropped — salary-inferrable; `moved` is sufficient.
          clickIndex: kind === "click" ? state.clickIndex : undefined,
          error: "queue_controls_timeout",
        });
        if (kind === "urls") {
          state.queue.shift();
          if (state.queue.length === 0) {
            await finishQueue(state, state.results.length);                    // P0-2: finishQueue is now async
            return;
          }
          var _ok = await __srSessionSet(KEY, JSON.stringify(state));           // P0-2: was sessionStorage.setItem
          if (!_ok) { await __srSessionRemove(KEY); return; }                  // P0-2: was catch → removeItem
          await sleepJitter(2200);
          window.location.replace(state.queue[0]);
          return;
        }
        const nextClick = state.clickIndex + 1;
        if (nextClick >= state.total) {
          await finishQueue(state, state.results.length);                      // P0-2: finishQueue is now async
          return;
        }
        state.clickIndex = nextClick;
        var _ok2 = await __srSessionSet(KEY, JSON.stringify(state));            // P0-2: was sessionStorage.setItem
        if (!_ok2) { await __srSessionRemove(KEY); return; }                   // P0-2: was catch → removeItem
        await sleepJitter(2200);
        window.location.replace(state.returnUrl);
        return;
      }

      let result;
      try {
        const runner =
          typeof globalThis.__srSalaryTriageRunMulti === "function"
            ? globalThis.__srSalaryTriageRunMulti
            : globalThis.__srSalaryTriageRun;
        result = await runner(state.config || {});
      } catch (e) {
        result = {
          log: [{ ok: false, msg: String((e && e.message) || e) }],
          moved: false,
          skipped: true,
        };
      }

      state.log = (state.log || []).concat(result.log || []);
      state.results = state.results || [];
      state.results.push({
        url: location.href,
        moved: !!result.moved,
        // GDPR minimization (Art. 5(1)(c)): inBudget dropped — salary-inferrable; `moved` is sufficient.
        clickIndex: kind === "click" ? state.clickIndex : undefined,
      });

      const afterMoveMs = Math.max(
        300,
        parseInt(state.config && state.config.afterMoveNavigateMs, 10) || 600
      );
      if (result.moved) await sleep(afterMoveMs);

      if (kind === "urls") {
        state.queue.shift();
        if (state.queue.length === 0) {
          await finishQueue(state, state.results.length);                      // P0-2: finishQueue is now async
          return;
        }
        var _ok3 = await __srSessionSet(KEY, JSON.stringify(state));            // P0-2: was sessionStorage.setItem
        if (!_ok3) {                                                           // P0-2: was catch → removeItem
          await __srSessionRemove(KEY);
          showToast("Cost assist: queue lost (storage full).");
          return;
        }
        await sleepJitter(2200);
        window.location.replace(state.queue[0]);
        return;
      }

      const nextClick = state.clickIndex + 1;
      if (nextClick >= state.total) {
        await finishQueue(state, state.results.length);                        // P0-2: finishQueue is now async
        return;
      }
      state.clickIndex = nextClick;
      var _ok4 = await __srSessionSet(KEY, JSON.stringify(state));              // P0-2: was sessionStorage.setItem
      if (!_ok4) {                                                             // P0-2: was catch → removeItem
        await __srSessionRemove(KEY);
        showToast("Cost assist: queue lost (storage full).");
        return;
      }
      await sleepJitter(2200);
      window.location.replace(state.returnUrl);
    } finally {
      try {
        delete g.__srSalaryAutorunLock;
      } catch (_) {
        g.__srSalaryAutorunLock = false;
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      main().catch(function () {});
    });
  } else {
    main().catch(function () {});
  }
})();