// run-summary.js — pure formatting of a finished Keyword run for the popup's "Last run" log.
// Loaded by popup.html before popup.js; exported for node tests.
// Exposes globals: summarizeKeywordRun, formatKeywordResult

// A result the background queue could not produce (see background.js) carries `error`
// and no scan data. It must never read as "0 hits" — that means "candidate lacks the skills".
const FAILURE_LABELS = { tab_closed: "tab closed", timeout: "timed out" };
const failureLabel = (error) => FAILURE_LABELS[error] || String(error);

// Counts for the summary line.
function summarizeKeywordRun(results) {
  return {
    total: results.length,
    failed: results.filter((r) => r.error).length,
    matched: results.filter((r) => r.hitCount > 0).length,
    notesPosted: results.filter((r) => r.notesPosted).length,
    moved: results.filter((r) => r.moved).length,
    skipped: results.filter((r) => r.skipped).length,
    notesFailed: results.filter((r) => r.hitCount > 0 && !r.notesPosted).length,
  };
}

// One result → { icon, text } for its log line.
function formatKeywordResult(r) {
  const seg = (r.url || "").split("/").slice(-2, -1)[0] || r.url.slice(-20);
  if (r.error) return { icon: "⚠", text: `[${seg}] not scanned — ${failureLabel(r.error)}` };
  const kws = (r.matchedKeywords || []).slice(0, 3).join(", ") || "";
  const boolTag = (r.booleanPass != null) ? (r.booleanPass ? " PASS" : " FAIL") : "";
  // For 0-hit profiles, show text-source breakdown so extraction failures are obvious.
  // e.g. "0 hits [rsm:0 ttl:312]" means resume was empty but header/page text was found.
  const textHint = (r.hitCount === 0 && r.textStats)
    ? ` [rsm:${r.textStats.resumeLen} ttl:${r.textStats.totalLen}]` : "";
  const timeTag = r.totalMs ? `${(r.totalMs / 1000).toFixed(1)}s` : "";
  const tags = [
    r.skipped ? "skip" : "",
    r.hitCount > 0 ? r.hitCount + " hits" : "0 hits" + textHint,
    kws,
    boolTag,
    r.notesPosted ? "note✓" : (r.hitCount > 0 ? "note✗" + (r.notesFailReason ? " [" + r.notesFailReason.replace(/\s*—.*/, "").trim().slice(0, 30) + "]" : "") : ""),
    r.moved ? "fwd✓" : "",
    timeTag,
  ].filter(Boolean).join(" · ");
  return { icon: r.hitCount > 0 ? "✓" : "✗", text: `[${seg}] ${tags}` };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { summarizeKeywordRun, formatKeywordResult };
}
