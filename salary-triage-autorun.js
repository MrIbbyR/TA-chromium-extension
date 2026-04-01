// salary-triage-autorun.js — URL queue OR click-through queue (same tab, return to Applicants list)

(function () {
  "use strict";

  const KEY = "sr_ext_salary_triage_v1";

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
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
      if (isProfilePage()) return true;
      await sleep(step);
    }
    return isProfilePage();
  }

  async function waitUntilSrControlsReady(maxMs) {
    const step = 200;
    const start = Date.now();
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

  function finishQueue(state, resultsLen) {
    sessionStorage.removeItem(KEY);
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          salaryTriageLastRun: {
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

    const collect = globalThis.__srCollectApplicantClickTargets;
    if (typeof collect !== "function") {
      showToast("Cost assist: extension core missing — reload extension.");
      sessionStorage.removeItem(KEY);
      return;
    }

    const targets = collect();
    if (!targets || !targets.length) {
      showToast("Cost assist: no names on page — scroll Applicants, then Stop queue and retry.");
      sessionStorage.removeItem(KEY);
      return;
    }

    if (state.clickIndex >= targets.length) {
      showToast("Cost assist: fewer rows than queued — scroll to load all, or Stop queue.");
      sessionStorage.removeItem(KEY);
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

  async function main() {
    if (!/smartrecruiters\.com/i.test(location.hostname)) return;
    if (window.top !== window.self) return;

    const raw = sessionStorage.getItem(KEY);
    if (!raw) return;

    let state;
    try {
      state = JSON.parse(raw);
    } catch (_) {
      sessionStorage.removeItem(KEY);
      return;
    }

    const kind = queueKind(state);
    if (!kind || !isValidState(state, kind)) {
      sessionStorage.removeItem(KEY);
      return;
    }

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
      if (!controlsOk) {
        showToast("Cost assist: pipeline UI not ready — increase Wait after Screening or check network.");
        state.log = (state.log || []).concat([
          { ok: false, msg: "Queue: timed out waiting for #st-moveForward / #st-screening after navigation." },
        ]);
        state.results = state.results || [];
        state.results.push({
          url: location.href,
          moved: false,
          amount: null,
          inBudget: null,
          clickIndex: kind === "click" ? state.clickIndex : undefined,
          error: "queue_controls_timeout",
        });
        if (kind === "urls") {
          state.queue.shift();
          if (state.queue.length === 0) {
            finishQueue(state, state.results.length);
            return;
          }
          try {
            sessionStorage.setItem(KEY, JSON.stringify(state));
          } catch (_) {
            sessionStorage.removeItem(KEY);
            return;
          }
          window.location.replace(state.queue[0]);
          return;
        }
        const nextClick = state.clickIndex + 1;
        if (nextClick >= state.total) {
          finishQueue(state, state.results.length);
          return;
        }
        state.clickIndex = nextClick;
        try {
          sessionStorage.setItem(KEY, JSON.stringify(state));
        } catch (_) {
          sessionStorage.removeItem(KEY);
          return;
        }
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
          amount: null,
          inBudget: null,
        };
      }

      state.log = (state.log || []).concat(result.log || []);
      state.results = state.results || [];
      state.results.push({
        url: location.href,
        moved: !!result.moved,
        amount: result.amount,
        inBudget: result.inBudget,
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
          finishQueue(state, state.results.length);
          return;
        }
        try {
          sessionStorage.setItem(KEY, JSON.stringify(state));
        } catch (_) {
          sessionStorage.removeItem(KEY);
          showToast("Cost assist: queue lost (storage full).");
          return;
        }
        window.location.replace(state.queue[0]);
        return;
      }

      const nextClick = state.clickIndex + 1;
      if (nextClick >= state.total) {
        finishQueue(state, state.results.length);
        return;
      }
      state.clickIndex = nextClick;
      try {
        sessionStorage.setItem(KEY, JSON.stringify(state));
      } catch (_) {
        sessionStorage.removeItem(KEY);
        showToast("Cost assist: queue lost (storage full).");
        return;
      }
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
