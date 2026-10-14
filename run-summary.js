// run-summary.js — pure formatting of a finished Keyword run for the popup's "Last run" log.
// Loaded by popup.html before popup.js; exported for node tests.
// Exposes globals: summarizeKeywordRun, formatKeywordResult, stoppedEarlyLine, failureLabel,
//                  summarizePhaseTimings, formatPhaseTimings

// A result the background queue could not produce (see background.js) carries `error`
// and no scan data. It must never read as "0 hits" — that means "candidate lacks the skills".
const FAILURE_LABELS = {
  tab_closed: "tab closed",
  timeout: "timed out",
  controls_timeout: "page never finished loading",
  notes_failed: "note not posted", // circuit-breaker reasons only (see background.js)
  logged_out: "logged out of SmartRecruiters",
  bot_check: "SmartRecruiters bot check not solved",
};
const failureLabel = (error) => FAILURE_LABELS[error] || String(error);
// Stop reasons from a pause that ran out (background.js), not from 3 failures in a row.
const PAUSE_STOP_REASONS = ["logged_out", "bot_check"];

// The background's circuit breaker stops a run after 3 same-reason failures in a row
// and saves `stoppedReason` + `total` on the last run. null for a normal run.
function stoppedEarlyLine(run) {
  if (!run || !run.stoppedReason) return null;
  const done = (run.results || []).length;
  const why = PAUSE_STOP_REASONS.includes(run.stoppedReason)
    ? `Stopped: ${failureLabel(run.stoppedReason)} for 15 minutes. `
    : `Stopped early: 3 profiles in a row — ${failureLabel(run.stoppedReason)}. `;
  return why + `${done} of ${run.total != null ? run.total : done} profiles processed; check SmartRecruiters, then re-run.`;
}

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
  const ms = r.totalMs || sumTimings(r.timings);
  const timeTag = ms ? `${(ms / 1000).toFixed(1)}s` : "";
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

// ── Per-phase timings ──
// Each scanned result carries `timings`: { phase: ms } in the order the profile went
// through them (background navDelay, then page load and autorun waits, then the core).
const PHASE_LABELS = {
  navDelay: "pause before next profile",
  pageLoad: "page load",
  checkIn: "worker check-in",
  preStartWait: "fixed wait before scan",
  controlsWait: "wait for SR controls",
  header: "read header",
  focusWait: "wait for foreground (pdf.js)",
  resumeRender: "resume render",
  resumeRetry: "resume retry / fallback",
  resumeTabScan: "resume-tab page scan",
  profileTab: "profile tab",
  sparseRetry: "sparse-text retry",
  textProcessing: "text processing",
  match: "keyword match",
  notesPrepare: "open notes",
  notesPost: "post note",
};
const PHASE_ORDER = Object.keys(PHASE_LABELS);

function sumTimings(t) {
  if (!t) return 0;
  return Object.values(t).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
}

// Nearest-rank percentile of an ascending array.
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

// Median / p90 per phase across the results that were actually scanned. A phase a
// profile skipped (e.g. no note posted) counts as 0 for it, so shares add up to 100%.
function summarizePhaseTimings(results) {
  const rows = (results || []).filter((r) => r && !r.error && r.timings && sumTimings(r.timings) > 0);
  if (!rows.length) return null;
  const keys = new Set();
  for (const r of rows) for (const k of Object.keys(r.timings)) keys.add(k);
  const ordered = PHASE_ORDER.filter((k) => keys.has(k)).concat([...keys].filter((k) => !PHASE_LABELS[k]));
  const totals = rows.map((r) => sumTimings(r.timings)).sort((a, b) => a - b);
  const grand = totals.reduce((a, b) => a + b, 0);
  const phases = ordered.map((k) => {
    const vals = rows.map((r) => r.timings[k] || 0).sort((a, b) => a - b);
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      phase: k,
      label: PHASE_LABELS[k] || k,
      median: percentile(vals, 50),
      p90: percentile(vals, 90),
      mean: Math.round(sum / vals.length),
      share: grand ? sum / grand : 0,
    };
  });
  return { profiles: rows.length, median: percentile(totals, 50), p90: percentile(totals, 90), phases };
}

// Summary → log lines, biggest share first; phases under 1% of the time are left out.
function formatPhaseTimings(summary) {
  if (!summary) return [];
  const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const lines = [`Timing over ${summary.profiles} profile${summary.profiles > 1 ? "s" : ""}: ` +
    `median ${s(summary.median)} · p90 ${s(summary.p90)} per profile`];
  for (const p of [...summary.phases].sort((a, b) => b.share - a.share)) {
    if (p.share < 0.01) continue;
    lines.push(`${p.label}: ${Math.round(p.share * 100)}% · median ${s(p.median)} · p90 ${s(p.p90)}`);
  }
  return lines;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    summarizeKeywordRun, formatKeywordResult, stoppedEarlyLine, failureLabel,
    summarizePhaseTimings, formatPhaseTimings,
  };
}
