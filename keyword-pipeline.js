// keyword-pipeline.js — keyword search: Move Forward control and applicant-list URL / click-target harvesting.
// One of the keyword-*.js modules that keyword-triage-core.js runs. They share the
// globalThis.__srKw namespace (require() under Node) and load in dependency order:
// dom → matching → extract → pipeline → notes → diag → core.

(function () {
  "use strict";

  // SmartRecruiters selectors and element ids live in sr-selectors.js, which loads first.
  var SR = globalThis.__SR || (typeof require === "function" ? require("./sr-selectors.js").SR : null);
  if (!SR) throw new Error("sr-selectors.js must load before keyword-pipeline.js");

  // Node: require(). Browser: modules loaded earlier put their exports on
  // globalThis.__srKw; a missing name means a loader got the order wrong.
  function need(file, names) {
    var mod = typeof module !== "undefined" && module.exports ? require("./" + file) : globalThis.__srKw || {};
    names.forEach(function (n) {
      if (mod[n] === undefined) throw new Error(n + " missing: load " + file + " before keyword-pipeline.js");
    });
    return mod;
  }
  var domMod = need("keyword-dom.js", [
    "isVisible", "isDisabledish", "queryDeepSelectorAll", "collectClickablesDeep",
    "findElementByIdDeep", "dispatchClickAtElementCenter"
  ]);
  var isVisible = domMod.isVisible,
      isDisabledish = domMod.isDisabledish,
      queryDeepSelectorAll = domMod.queryDeepSelectorAll,
      collectClickablesDeep = domMod.collectClickablesDeep,
      findElementByIdDeep = domMod.findElementByIdDeep,
      dispatchClickAtElementCenter = domMod.dispatchClickAtElementCenter;

  var MOVE_FORWARD_ID = SR.id.moveForward;

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
    try { sc = doc.getElementById(SR.id.screening); } catch (_) {}
    if (!sc) {
      try { sc = findElementByIdDeep(doc.documentElement || doc.body, SR.id.screening); } catch (_) {}
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
    var broadSel = SR.sel.profileLinks;
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
      doc.querySelectorAll(SR.sel.jobListLinks).forEach(function (n) { addRaw(hrefFromNode(n)); });
    } catch (_) {}
    var nameHosts = new Set();
    try {
      doc.querySelectorAll(SR.sel.applicantName).forEach(function (n) { nameHosts.add(n); });
    } catch (_) {}
    try {
      queryDeepSelectorAll(root, win, SR.sel.applicantNameDeep).forEach(function (n) { nameHosts.add(n); });
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
      var inJobList = host.closest && host.closest(SR.sel.jobDetailsPage);
      if (inJobList) {
        var directA = host.closest && host.closest(SR.sel.jobListRowLink);
        if (directA) return directA;
      }
    } catch (_) {}
    try {
      var cell = host.closest && (host.closest("td") || host.closest('[role="gridcell"]'));
      if (cell) {
        var a = cell.querySelector(SR.sel.cellProfileLink);
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
      doc.querySelectorAll(SR.sel.jobListClickLinks).forEach(function (linkEl) {
        var underTable = linkEl.closest && linkEl.closest(SR.sel.applicantTable);
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
    try { doc.querySelectorAll(SR.sel.applicantName).forEach(considerHost); } catch (_) {}
    try { queryDeepSelectorAll(root, win, SR.sel.applicantNameDeep).forEach(considerHost); } catch (_) {}
    try {
      doc.querySelectorAll(SR.sel.jobListNames).forEach(considerHost);
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

  /* ── Job country (salary-in-notes gate) ── */

  // EU 27 + EEA (Iceland, Liechtenstein, Norway): the EU Pay Transparency Directive
  // bars asking candidates about pay history, so salary never goes in notes there.
  var EEA_COUNTRIES = ["austria", "belgium", "bulgaria", "croatia", "cyprus", "czechia",
    "czech republic", "denmark", "estonia", "finland", "france", "germany", "greece", "hungary",
    "ireland", "italy", "latvia", "lithuania", "luxembourg", "malta", "netherlands",
    "the netherlands", "poland", "portugal", "romania", "slovakia", "slovenia", "spain", "sweden",
    "iceland", "liechtenstein", "norway"];

  function isEeaCountry(country) {
    var c = String(country || "").toLowerCase().replace(/\s+/g, " ").trim();
    return EEA_COUNTRIES.indexOf(c) >= 0;
  }

  /** Salary goes in notes only for a known, non-EU/EEA job country (unknown → off). */
  function salaryAllowedForJobCountry(country) {
    return !!String(country || "").trim() && !isEeaCountry(country);
  }

  /** [{ name, value }] → the "Job Country" value, else any "…Country" field, else "". */
  function jobCountryFromFields(rows) {
    var clean = function (s) { return String(s || "").replace(/\*/g, "").replace(/\s+/g, " ").trim(); };
    var byName = function (re) {
      for (var i = 0; i < rows.length; i++) if (re.test(clean(rows[i].name)) && clean(rows[i].value)) return clean(rows[i].value);
      return "";
    };
    return byName(/^job country$/i) || byName(/\bcountry\b/i);
  }

  function readJobFieldRows(doc, win) {
    var root = doc.documentElement || doc.body;
    var lis = [];
    try { lis = queryDeepSelectorAll(root, win, SR.sel.jobFormField); } catch (_) {}
    return lis.map(function (li) {
      var n = li.querySelector(SR.sel.jobFieldName), v = li.querySelector(SR.sel.jobFieldValue);
      return { name: n ? n.textContent : "", value: v ? v.textContent : "" };
    });
  }

  /**
   * Run start, on the job page: open the Job details tab, read Job Country, then go
   * back to Applicants (the list is harvested before this, so it needn't reload).
   * Returns { country, salaryNotes, reason }.
   */
  async function readJobCountry(doc, win) {
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var root = doc.documentElement || doc.body;
    var country = jobCountryFromFields(readJobFieldRows(doc, win));
    var reason = "";
    if (!country) {
      var tab = null;
      try { tab = queryDeepSelectorAll(root, win, SR.sel.jobDetailsTabLink)[0]; } catch (_) {}
      if (!tab) {
        reason = "no_job_details_tab";
      } else {
        try { tab.click(); } catch (_) {}
        for (var t = 0; t < 8000 && !country; t += 250) {
          await wait(250);
          country = jobCountryFromFields(readJobFieldRows(doc, win));
        }
        if (!country) reason = "no_job_country_field";
        var back = null;
        try { back = queryDeepSelectorAll(root, win, SR.sel.jobApplicantsTabLink)[0]; } catch (_) {}
        if (back) { try { back.click(); } catch (_) {} }
      }
    }
    return { country: country, salaryNotes: salaryAllowedForJobCountry(country), reason: reason || (isEeaCountry(country) ? "eea" : "") };
  }

  var api = {
    isEeaCountry: isEeaCountry,
    salaryAllowedForJobCountry: salaryAllowedForJobCountry,
    jobCountryFromFields: jobCountryFromFields,
    readJobCountry: readJobCountry,
    MOVE_FORWARD_ID: MOVE_FORWARD_ID,
    resolveMoveForwardClickTarget: resolveMoveForwardClickTarget,
    fireMoveForwardPipelineClick: fireMoveForwardPipelineClick,
    findMoveControl: findMoveControl,
    hasSrProfileChrome: hasSrProfileChrome,
    normalizeProfilePath: normalizeProfilePath,
    hrefFromNode: hrefFromNode,
    harvestProfileUrls: harvestProfileUrls,
    resolveApplicantClickTarget: resolveApplicantClickTarget,
    collectApplicantClickTargets: collectApplicantClickTargets,
    fireClick: fireClick,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.__srKw = Object.assign(globalThis.__srKw || {}, api);
})();
