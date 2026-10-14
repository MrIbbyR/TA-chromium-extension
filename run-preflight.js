// run-preflight.js — checks before a parallel run starts. Loaded by popup.html after
// run-summary.js (uses failureLabel) and before popup.js; exported for node tests.
// The popup shows the warnings and lets the recruiter start anyway.
// Exposes globals: preflightWarnings

var _failureLabel = (typeof failureLabel === "function")
  ? failureLabel
  : require("./run-summary.js").failureLabel;

// A breaker trip older than this is history, not a warning.
const PREFLIGHT_RECENT_TRIP_MS = 30 * 60 * 1000;
const LOGIN_URL_RE = /(^https?:\/\/login\.|\/(sign-?in|login|sso)(\/|$|\?))/i;

// facts: { pageUrl, loginFormVisible, botCheckVisible, runInProgress, lastRun, now }
function preflightWarnings(facts) {
  const w = [];
  if (facts.botCheckVisible) {
    w.push("SmartRecruiters is showing a bot check (captcha) — solve it in this tab first.");
  }
  if (facts.loginFormVisible || LOGIN_URL_RE.test(facts.pageUrl || "")) {
    w.push("SmartRecruiters looks logged out — log in first.");
  }
  if (facts.runInProgress) {
    w.push("A run is already in progress — starting a new one will cancel it.");
  }
  const last = facts.lastRun;
  if (last && last.stoppedReason && facts.now - last.finishedAt < PREFLIGHT_RECENT_TRIP_MS) {
    w.push("The last run stopped early (3 profiles in a row — " + _failureLabel(last.stoppedReason) +
      "). Check that's fixed before re-running.");
  }
  return w;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { preflightWarnings };
}
