// keyword-dom.js — keyword search: shadow-piercing DOM queries, visibility and click helpers.
// One of the keyword-*.js modules that keyword-triage-core.js runs. They share the
// globalThis.__srKw namespace (require() under Node) and load in dependency order:
// dom → matching → extract → pipeline → notes → diag → core.

(function () {
  "use strict";

  // SmartRecruiters selectors and element ids live in sr-selectors.js, which loads first.
  var SR = globalThis.__SR || (typeof require === "function" ? require("./sr-selectors.js").SR : null);
  if (!SR) throw new Error("sr-selectors.js must load before keyword-dom.js");

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
    var raw = queryDeepSelectorAll(root, win, SR.sel.clickable);
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

  function getDeepText(el) {
    var t = "";
    try { t = (el.textContent || el.innerText || "").replace(/\s+/g, " ").trim(); } catch (_) {}
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
