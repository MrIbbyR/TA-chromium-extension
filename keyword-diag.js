// keyword-diag.js — keyword search: per-profile diagnostics saved for the popup's Inspect diagnostics.
// One of the keyword-*.js modules that keyword-triage-core.js runs. They share the
// globalThis.__srKw namespace (require() under Node) and load in dependency order:
// dom → matching → extract → pipeline → notes → diag → core.

(function () {
  "use strict";

  /* ── Per-profile diagnostics: capture extracted text + matched/missed keywords ── */

  var DIAG_KEY_PREFIX = "lastRunDiag_";
  var DIAG_MAX_ENTRIES = 20;
  var DIAG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // GDPR storage limitation (Art. 5(1)(e)): 7-day TTL
  var DIAG_TEXT_CAP = 50 * 1024;      // 50 KB — full normalized allText
  var DIAG_SOURCE_CAP = 15 * 1024;    // 15 KB per individual source

  function capText(s, maxChars) {
    if (s == null) return "";
    s = String(s);
    if (s.length <= maxChars) return s;
    var extra = s.length - maxChars;
    return s.slice(0, maxChars) + "\n...[truncated +" + extra + " chars]";
  }

  /**
   * GDPR data-minimization gate (Art. 5(1)(c)). Resolves to the recruiter/dev's
   * `srDiagRawCapture` setting in chrome.storage.local. Default FALSE: raw candidate
   * text (resume, screening answers) is NOT persisted. Flip to true only while actively
   * debugging a keyword miss, then flip back. Resolves false in the Node test harness.
   */
  function getDiagRawCapture() {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return resolve(false);
        chrome.storage.local.get(["srDiagRawCapture"], function (r) {
          try { chrome.runtime && chrome.runtime.lastError; } catch (_) {}
          resolve(!!(r && r.srDiagRawCapture === true));
        });
      } catch (_) { resolve(false); }
    });
  }

  /**
   * Strip raw candidate text from a diagnostic entry unless raw capture is enabled.
   * When `rawCapture` is false (the default), drops `extractedText`, blanks every
   * `textSources.*` value, and removes raw-text log lines (TEXT_SAMPLE / salary "A:")
   * while preserving all debugging metadata (text lengths, keyword lists, timing).
   * Pure + exported for unit testing.
   */
  function sanitizeDiagEntry(entry, rawCapture) {
    if (rawCapture === true) return entry;
    if (!entry || typeof entry !== "object") return entry;
    var clean = Object.assign({}, entry);
    clean.rawCaptured = false;
    if ("extractedText" in clean) clean.extractedText = "";
    if (clean.textSources && typeof clean.textSources === "object") {
      var src = {};
      for (var k in clean.textSources) {
        if (Object.prototype.hasOwnProperty.call(clean.textSources, k)) src[k] = "";
      }
      clean.textSources = src;
    }
    if (Array.isArray(clean.log)) {
      clean.log = clean.log.filter(function (e) {
        var m = (e && e.msg) || "";
        return !/^(TEXT_SAMPLE:|A:\s)/.test(m);
      });
    }
    return clean;
  }

  /**
   * Fire-and-forget save of a per-profile diagnostic entry to chrome.storage.local.
   * Keyed by `lastRunDiag_<timestamp>`; prunes to the most recent DIAG_MAX_ENTRIES.
   * `rawCapture` defaults to false — raw candidate text is stripped before persisting.
   * Silently no-ops when chrome.storage is unavailable (Node test harness).
   */
  function saveProfileDiag(entry, rawCapture) {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
    } catch (_) { return; }
    entry = sanitizeDiagEntry(entry, rawCapture === true);
    var key = DIAG_KEY_PREFIX + entry.timestamp;
    var payload = {};
    payload[key] = entry;
    try {
      chrome.storage.local.set(payload, function () {
        try { chrome.runtime && chrome.runtime.lastError; } catch (_) {}
        try {
          chrome.storage.local.get(null, function (all) {
            try { chrome.runtime && chrome.runtime.lastError; } catch (_) {}
            if (!all) return;
            var keys = [];
            for (var k in all) {
              if (Object.prototype.hasOwnProperty.call(all, k) && k.indexOf(DIAG_KEY_PREFIX) === 0) keys.push(k);
            }
            // Descending by timestamp suffix — newest first.
            keys.sort(function (a, b) {
              var ta = parseInt(a.slice(DIAG_KEY_PREFIX.length), 10) || 0;
              var tb = parseInt(b.slice(DIAG_KEY_PREFIX.length), 10) || 0;
              return tb - ta;
            });
            // Lazy GC: prune by age (storage limitation) and by count, in one sweep.
            var cutoff = Date.now() - DIAG_MAX_AGE_MS;
            var removeSet = {};
            for (var ci = DIAG_MAX_ENTRIES; ci < keys.length; ci++) removeSet[keys[ci]] = true;
            for (var ai = 0; ai < keys.length; ai++) {
              var ts = parseInt(keys[ai].slice(DIAG_KEY_PREFIX.length), 10) || 0;
              if (ts < cutoff) removeSet[keys[ai]] = true;
            }
            var toRemove = Object.keys(removeSet);
            if (toRemove.length) {
              try { chrome.storage.local.remove(toRemove, function () { try { chrome.runtime && chrome.runtime.lastError; } catch (_) {} }); } catch (_) {}
            }
          });
        } catch (_) {}
      });
    } catch (_) {}
  }

  var api = {
    DIAG_KEY_PREFIX: DIAG_KEY_PREFIX,
    DIAG_MAX_ENTRIES: DIAG_MAX_ENTRIES,
    DIAG_MAX_AGE_MS: DIAG_MAX_AGE_MS,
    DIAG_TEXT_CAP: DIAG_TEXT_CAP,
    DIAG_SOURCE_CAP: DIAG_SOURCE_CAP,
    capText: capText,
    getDiagRawCapture: getDiagRawCapture,
    sanitizeDiagEntry: sanitizeDiagEntry,
    saveProfileDiag: saveProfileDiag,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.__srKw = Object.assign(globalThis.__srKw || {}, api);
})();
