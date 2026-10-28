// keyword-diag.js — keyword search: limits for the per-profile diagnostics that the
// dev-only "Diagnose this profile" button shows. A scan builds them only when
// config.diagnose is set and returns them to the popup; nothing is ever stored.
// One of the keyword-*.js modules that keyword-triage-core.js runs. They share the
// globalThis.__srKw namespace (require() under Node) and load in dependency order:
// dom → matching → extract → pipeline → notes → diag → core.

(function () {
  "use strict";

  var DIAG_TEXT_CAP = 50 * 1024;      // 50 KB — full normalized allText
  var DIAG_SOURCE_CAP = 15 * 1024;    // 15 KB per individual source

  function capText(s, maxChars) {
    if (s == null) return "";
    s = String(s);
    if (s.length <= maxChars) return s;
    var extra = s.length - maxChars;
    return s.slice(0, maxChars) + "\n...[truncated +" + extra + " chars]";
  }

  var api = {
    DIAG_TEXT_CAP: DIAG_TEXT_CAP,
    DIAG_SOURCE_CAP: DIAG_SOURCE_CAP,
    capText: capText,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.__srKw = Object.assign(globalThis.__srKw || {}, api);
})();
