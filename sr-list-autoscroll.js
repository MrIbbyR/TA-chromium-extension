// sr-list-autoscroll.js — virtual applicant/prospect list loader (port of Playwright collect_all_profile_links scroll phase)
// Exposes: globalThis.__srAutoscrollApplicantListUntilLoaded() -> Promise<scrollResult>

(function () {
  "use strict";

  function isProfileListPage() {
    if (!/smartrecruiters\.com/i.test(location.hostname || "")) return false;
    if (/\/app\/people\/(?:applications|profile)\/[^/?#]+/i.test(location.pathname)) return false;
    return true;
  }

  /**
   * Scroll the SR applicants/prospects grid until lazy rows stop growing (or "Showing n of m" is satisfied).
   * Mirrors the in-page Promise used by the Python Playwright scraper.
   * @returns {Promise<{skipped:boolean,reason?:string,uniqueLinks:number,expectedTotal:number|null,ms:number}>}
   */
  globalThis.__srAutoscrollApplicantListUntilLoaded = function () {
    if (!isProfileListPage()) {
      return Promise.resolve({
        skipped: true,
        reason: "not_applicant_list_context",
        uniqueLinks: 0,
        expectedTotal: null,
        ms: 0,
      });
    }

    const t0 = Date.now();
    const SR = globalThis.__SR; // sr-selectors.js loads first

    return new Promise(function (resolve) {
      const normalizePath = function (raw) {
        try {
          const u = new URL(raw, location.origin);
          const m = u.pathname.match(/^(\/app\/people\/(?:applications|profile)\/[^/]+)\/?/i);
          return m ? (u.origin + m[1] + "/").toLowerCase() : "";
        } catch (_) {
          return "";
        }
      };

      const textAll = function (root) {
        root = root || document.body;
        return (root && (root.innerText || root.textContent)) || "";
      };

      const parseExpectedTotal = function () {
        const txt = textAll().replace(/,/g, " ");
        const m = txt.match(/Showing\s+\d+\s+of\s+(\d+)\s+(applicants|prospects|people)/i);
        return m ? parseInt(m[1], 10) : null;
      };

      const style = function (el) {
        return el ? getComputedStyle(el) : null;
      };

      const isScrollable = function (el) {
        return (
          !!el &&
          el.scrollHeight - el.clientHeight > 8 &&
          /(auto|scroll)/i.test((style(el).overflowY || style(el).overflow || ""))
        );
      };

      const scroller = (function () {
        const candidates = SR.sel.listScroller;
        for (let i = 0; i < candidates.length; i++) {
          const el = document.querySelector(candidates[i]);
          if (isScrollable(el)) return el;
        }
        let el = document.querySelector(SR.sel.profileLinks);
        while (el && el !== document.body) {
          if (isScrollable(el)) return el;
          el = el.parentElement;
        }
        return document.scrollingElement || document.documentElement;
      })();

      const clickLoadMoreIfAny = function () {
        const all = Array.from(document.querySelectorAll("button, [role='button']"));
        for (let i = 0; i < all.length; i++) {
          const b = all[i];
          const t = ((b.innerText || b.textContent || "") + "").trim().toLowerCase();
          if (!t) continue;
          if (t === "load more" || t.startsWith("load")) {
            if (!b.disabled) {
              try {
                b.click();
                return true;
              } catch (_) {}
            }
          }
        }
        return false;
      };

      const linkSel = SR.sel.profileLinks;

      const seen = new Set();
      let expectedTotal = parseExpectedTotal();
      const MAX_RUN_MS = 3 * 60 * 1000;
      const IDLE_NO_GROW_MS = 2500;
      const CONFIRM_STABLE_MS = 900;
      const LOAD_MORE_COOLDOWN_MS = 600;
      let lastAddTime = performance.now();
      const startTime = performance.now();
      let reachedExpectedAt = null;
      let lastLoadMore = 0;

      const harvest = function () {
        let nodes;
        try {
          nodes = document.querySelectorAll(linkSel);
        } catch (_) {
          nodes = [];
        }
        let added = 0;
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          const raw = (n.getAttribute && n.getAttribute("href")) || n.href || "";
          const norm = normalizePath(raw);
          if (norm && !seen.has(norm)) {
            seen.add(norm);
            added++;
          }
        }
        if (added > 0) lastAddTime = performance.now();
        return added;
      };

      harvest();

      const step = function () {
        const before = scroller.scrollTop;
        scroller.scrollTop = Math.min(
          scroller.scrollTop + scroller.clientHeight * 1.6,
          scroller.scrollHeight
        );
        if (scroller.scrollTop === before) {
          scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 1;
        }
        const now = performance.now();
        if (now - lastAddTime > 400 && now - lastLoadMore > LOAD_MORE_COOLDOWN_MS) {
          if (clickLoadMoreIfAny()) lastLoadMore = now;
        }
        harvest();
        if (expectedTotal && seen.size >= expectedTotal) {
          if (reachedExpectedAt === null) reachedExpectedAt = now;
          if (now - reachedExpectedAt >= CONFIRM_STABLE_MS) {
            return resolve({
              skipped: false,
              uniqueLinks: seen.size,
              expectedTotal: expectedTotal,
              ms: Date.now() - t0,
            });
          }
        }
        if (!expectedTotal) {
          if (now - lastAddTime >= IDLE_NO_GROW_MS) {
            return resolve({
              skipped: false,
              uniqueLinks: seen.size,
              expectedTotal: null,
              ms: Date.now() - t0,
            });
          }
        }
        if (now - startTime >= MAX_RUN_MS) {
          return resolve({
            skipped: false,
            uniqueLinks: seen.size,
            expectedTotal: expectedTotal,
            ms: Date.now() - t0,
            timedOut: true,
          });
        }
        requestAnimationFrame(step);
      };

      requestAnimationFrame(step);
    });
  };
})();
