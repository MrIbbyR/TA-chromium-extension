// @ts-check
// keyword-dom.js — keyword search: shadow-piercing DOM queries, visibility and click helpers.
// One of the keyword-*.js modules that keyword-triage-core.js runs. They share the
// globalThis.__srKw namespace (require() under Node) and load in dependency order:
// dom → matching → extract → pipeline → notes → diag → core.

(function () {
  "use strict";

  // SmartRecruiters selectors and element ids live in sr-selectors.js, which loads first.
  var SR = globalThis.__SR || (typeof require === "function" ? require("./sr-selectors.js").SR : null);
  if (!SR) throw new Error("sr-selectors.js must load before keyword-dom.js");
  var sel = SR.sel;

  /* ── Helpers ── */

  /** @param {number} ms */
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * Per-phase wall-clock timer for the diagnostics entry. `mark(name)` charges the time
   * since the previous mark to `name` (repeat marks accumulate). `seed` holds phases
   * measured before the core ran (page load, autorun waits) and keeps them first.
   * `now` is injectable for tests.
   * @param {Record<string, unknown> | null | undefined} seed
   * @param {() => number} [now]
   * @returns {{ mark: (name: string) => void, phases: Record<string, number> }}
   */
  function makePhaseTimer(seed, now) {
    var clock = now || function () { return performance.now(); };
    /** @type {Record<string, number>} */
    var phases = {};
    if (seed && typeof seed === "object") {
      for (var k in seed) {
        var v = seed[k];
        if (Object.prototype.hasOwnProperty.call(seed, k) && typeof v === "number") phases[k] = Math.round(v);
      }
    }
    var last = clock();
    return {
      mark: function (name) {
        var t = clock();
        phases[name] = (phases[name] || 0) + Math.round(t - last);
        last = t;
      },
      phases: phases,
    };
  }

  /**
   * @param {Element | null | undefined} el
   * @param {Window} win
   */
  function isVisible(el, win) {
    if (!el) return false;
    var style = win.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0)
      return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** @param {Element | null | undefined} el */
  function isDisabledish(el) {
    if (!el) return true;
    try { if (/** @type {HTMLButtonElement} */ (el).disabled === true) return true; } catch (_) {}
    try {
      if (el.getAttribute && el.getAttribute("disabled") != null) return true;
      if (String(el.getAttribute && el.getAttribute("aria-disabled")).toLowerCase() === "true") return true;
    } catch (_) {}
    return false;
  }

  /**
   * Depth-first walk that also descends into open shadow roots.
   * @param {Node | null | undefined} node
   * @param {(n: Node) => void} visitor
   * @param {Set<Node>} visited
   */
  function walkShadow(node, visitor, visited) {
    if (!node || visited.has(node)) return;
    visited.add(node);
    visitor(node);
    if (node.childNodes && node.childNodes.length) {
      for (var i = 0; i < node.childNodes.length; i++) walkShadow(node.childNodes[i], visitor, visited);
    }
    var sr = /** @type {Element} */ (node).shadowRoot;
    if (sr) walkShadow(sr, visitor, visited);
  }

  /**
   * Shadow-piercing querySelectorAll. `win` is unused (kept for call-site symmetry).
   * @param {Node | null | undefined} root
   * @param {Window | null} win
   * @param {string} selector
   * @returns {Element[]}
   */
  function queryDeepSelectorAll(root, win, selector) {
    /** @type {Element[]} */
    var out = [];
    var visited = new Set();
    walkShadow(root, function (n) {
      if (n.nodeType === 1) {
        var el = /** @type {Element} */ (n);
        try {
          if (el.matches && el.matches(selector)) out.push(el);
          out.push.apply(out, Array.from(el.querySelectorAll(selector)));
        } catch (_) {}
      }
    }, visited);
    return Array.from(new Set(out));
  }

  /**
   * @param {Node} root
   * @param {Window} win
   */
  function collectClickablesDeep(root, win) {
    var raw = queryDeepSelectorAll(root, win, sel.clickable);
    return raw.filter(function (el) { return isVisible(el, win); });
  }

  /**
   * getElementById that also searches open shadow roots.
   * @param {Node | null | undefined} root
   * @param {string} id
   * @param {Set<Node>} [visited]
   * @returns {Element | null}
   */
  function findElementByIdDeep(root, id, visited) {
    if (!visited) visited = new Set();
    if (!root || visited.has(root)) return null;
    visited.add(root);
    if (root.nodeType === 1) {
      var el = /** @type {Element} */ (root);
      try {
        if (el.id === id) return el;
        if (el.getAttribute && el.getAttribute("id") === id) return el;
      } catch (_) {}
    }
    if (root.childNodes) {
      for (var i = 0; i < root.childNodes.length; i++) {
        var f = findElementByIdDeep(root.childNodes[i], id, visited);
        if (f) return f;
      }
    }
    var shadow = /** @type {Element} */ (root).shadowRoot;
    if (shadow) {
      var f2 = findElementByIdDeep(shadow, id, visited);
      if (f2) return f2;
    }
    return null;
  }

  /** @param {Document} doc */
  function isCandidateProfilePage(doc) {
    try {
      var p = (doc.location && doc.location.pathname) || "";
      return /\/app\/people\/(?:applications|profile)\/[^/?#]+/i.test(p);
    } catch (_) { return false; }
  }

  /**
   * Pointer + mouse event sequence at a point inside `el` (SR buttons listen for both).
   * @param {Element | null | undefined} el
   * @param {Window & typeof globalThis} win
   * @param {number} [xBias] - horizontal position as a fraction of the width (default 0.35)
   */
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

  /**
   * Lowercased, whitespace-collapsed text of `el`, falling back to its shadow root.
   * @param {Element} el
   * @returns {string}
   */
  function getDeepText(el) {
    var t = "";
    try { t = (el.textContent || /** @type {HTMLElement} */ (el).innerText || "").replace(/\s+/g, " ").trim(); } catch (_) {}
    if (!t && el.shadowRoot) {
      try { t = (el.shadowRoot.textContent || "").replace(/\s+/g, " ").trim(); } catch (_) {}
    }
    return t.toLowerCase();
  }

  var api = {
    sleep: sleep,
    makePhaseTimer: makePhaseTimer,
    isVisible: isVisible,
    isDisabledish: isDisabledish,
    walkShadow: walkShadow,
    queryDeepSelectorAll: queryDeepSelectorAll,
    collectClickablesDeep: collectClickablesDeep,
    findElementByIdDeep: findElementByIdDeep,
    isCandidateProfilePage: isCandidateProfilePage,
    dispatchClickAtElementCenter: dispatchClickAtElementCenter,
    getDeepText: getDeepText,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.__srKw = Object.assign(globalThis.__srKw || {}, api);
})();
