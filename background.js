// background.js — service worker: parallel queue coordinator (leases + watchdog) + tab cleanup (MV3)

// SmartRecruiters selectors (globalThis.__SR). Injected page functions can't see this
// worker's globals, so they receive their selector through executeScript `args`.
importScripts("sr-selectors.js");

// GDPR: queue state lives in chrome.storage.session — extension-isolated, in-memory,
// cleared when the browser closes. Content scripts are "untrusted" contexts, so they
// can only read/write session storage after the access level is widened to include
// them. Without this, the *-core.js seed write is silently denied and the *-autorun.js
// content scripts read null, so no queue ever resumes.
// The access level does not reliably persist across service-worker restarts, so we
// re-apply it on every cold start AND expose an awaitable message (srEnsureSessionAccess)
// so the popup can guarantee it is set BEFORE triggering any content-script seed write.
function ensureSessionAccess() {
  // setAccessLevel returns a Promise; do NOT rely on a callback (it may never
  // fire, which would hang the popup's awaited srEnsureSessionAccess round-trip
  // and let it seed before access is granted).
  try {
    const p = chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
    });
    if (p && typeof p.then === "function") {
      return p.then(() => true).catch(() => false);
    }
    return Promise.resolve(true);
  } catch (_) {
    return Promise.resolve(false);
  }
}
ensureSessionAccess();
chrome.runtime.onInstalled.addListener(() => { ensureSessionAccess(); });
chrome.runtime.onStartup.addListener(() => { ensureSessionAccess(); });

// Dev shortcut (manifest "commands": ⌘⇧U / Ctrl+Shift+U): reload the extension, then
// refresh every SmartRecruiters tab — a reload doesn't re-inject content scripts into
// tabs already open. scripts/package.sh strips "commands", so shipped builds have no
// shortcut. The flag goes in storage.local because the reload clears storage.session;
// it only counts for DEV_RELOAD_MAX_AGE_MS, so a reload that never happened can't
// refresh SR tabs on some later wake-up (mid-run).
const DEV_RELOAD_FLAG = "srDevReloadPending";
const DEV_RELOAD_MAX_AGE_MS = 30000;
const isSrTabUrl = (u) => /^https:\/\/([^/]*\.)?smartrecruiters\.com\//.test(u || "");
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command !== "dev-reload") return;
    chrome.storage.local.set({ [DEV_RELOAD_FLAG]: Date.now() }).then(() => chrome.runtime.reload());
  });
}
chrome.storage.local.get(DEV_RELOAD_FLAG).then(async (got) => {
  const at = got && got[DEV_RELOAD_FLAG];
  if (!at) return;
  await chrome.storage.local.remove(DEV_RELOAD_FLAG);
  if (Date.now() - at > DEV_RELOAD_MAX_AGE_MS) return;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (isSrTabUrl(t.url)) chrome.tabs.reload(t.id).catch(() => {});
  }
}).catch(() => {});

/** Randomized delay — returns ms ± ~35% spread to avoid fixed-cadence bot detection. */
function jitter(baseMs) {
  const lo = Math.round(baseMs * 0.65);
  const hi = Math.round(baseMs * 1.35);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Play a two-tone beep in an active SR tab (service worker has no AudioContext). */
async function playBeepInSRTab(returnUrl) {
  try {
    const urlPat = "*://*.smartrecruiters.com/*";
    const allTabs = await chrome.tabs.query({ url: urlPat });
    let tab = null;
    if (returnUrl) {
      const base = returnUrl.replace(/[?#].*$/, "");
      tab = allTabs.find(t => t.url && t.url.startsWith(base)) || null;
    }
    if (!tab) tab = allTabs.find(t => t.active) || allTabs[0] || null;
    if (!tab) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function () {
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtx) return;
          const ctx = new AudioCtx();
          function doPlay() {
            [880, 1100].forEach(function (freq, i) {
              const osc = ctx.createOscillator();
              const g = ctx.createGain();
              osc.connect(g); g.connect(ctx.destination);
              osc.type = "sine"; osc.frequency.value = freq;
              const t = ctx.currentTime + i * 0.22;
              g.gain.setValueAtTime(0, t);
              g.gain.linearRampToValueAtTime(0.28, t + 0.02);
              g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
              osc.start(t); osc.stop(t + 0.5);
            });
          }
          if (ctx.state === "suspended") ctx.resume().then(doPlay).catch(() => {});
          else doPlay();
        } catch (_) {}
      },
    });
  } catch (_) {}
}

function showNotification(id, title, message) {
  try {
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icon.png",
      title: title,
      message: message,
      priority: 1,
    });
  } catch (_) {}
}

// ── Parallel queue: per-URL state with leases ──
// One queue drives both Keyword and Cost Assist (feature: "keyword" | "salary"); only
// the result shape, the saved last-run key and the notification wording differ.
//
// Every URL carries its own state:
//
//   pending ──lease──► leased ──srWorkerDone──► done
//      ▲                 │  lease expired (watchdog) / tab closed
//      └─ attempts left ─┤
//                        └──► failed ("timeout" | "tab_closed")
//
// A lease binds one URL to one worker tab until `leaseUntil`. The whole queue lives in
// chrome.storage.session (in-memory, extension-only, cleared on browser close), so an
// MV3 service-worker restart loses nothing; a chrome.alarms watchdog (which wakes a
// stopped worker, unlike setTimeout) reclaims leases from hung or orphaned tabs. The
// run is finished when no URL is pending or leased.
const QUEUE_KEY = "srParallelQueue";
const WATCHDOG_ALARM = "srQueueWatchdog";
// Assigned → the page must check in via srIsParallelWorker within this window.
const START_TIMEOUT_MS = 60 * 1000;
// Checked in → must report srWorkerDone within this window. Renewed by every message
// the worker sends (resume focus / capture polling), so only a silent tab expires.
const WORK_TIMEOUT_MS = { keyword: 180 * 1000, salary: 90 * 1000 };
const MAX_ATTEMPTS = 2;
// GDPR: abandon runs older than this so candidate URLs don't linger (no real run exceeds 2h).
const STALE_QUEUE_MS = 2 * 60 * 60 * 1000;

// The pre-lease queue lived in chrome.storage.local — drop any leftovers.
chrome.storage.local.remove([
  "srParallelQueueUrls", "srParallelQueueResults", "srParallelQueueReturnUrl",
  "srParallelQueueWorkers", "srParallelQueueStartedAt", "srParallelQueueFeature",
  "srParallelWorkerActive",
]).catch(() => {});

let queueCache;                    // undefined = not loaded yet, null = no run
let queueLock = Promise.resolve();

// Run fn(ctx) with exclusive access to the queue. ctx.q is the queue (or null) and fn
// may mutate or replace it; the result is persisted before the next caller runs, so
// concurrent worker messages can't interleave a read-modify-write.
function withQueue(fn) {
  const run = queueLock.then(async () => {
    if (queueCache === undefined) {
      const s = await chrome.storage.session.get(QUEUE_KEY).catch(() => ({}));
      queueCache = (s && s[QUEUE_KEY]) || null;
    }
    const ctx = { q: queueCache };
    try {
      return await fn(ctx);
    } finally {
      queueCache = ctx.q;
      if (ctx.q) await chrome.storage.session.set({ [QUEUE_KEY]: ctx.q }).catch(() => {});
      else await chrome.storage.session.remove(QUEUE_KEY).catch(() => {});
    }
  });
  queueLock = run.catch(() => {});
  return run;
}

function leaseOf(q, tabId) {
  if (!q || tabId == null) return null;
  for (const url of q.order) {
    const item = q.items[url];
    if (item.state === "leased" && item.tabId === tabId) return { url, item };
  }
  return null;
}

// Sync check for code outside the lock (resume focus). Workers have always checked in
// via srIsParallelWorker before they ask for focus, so the cache is loaded by then.
function isWorkerTab(tabId) {
  return !!leaseOf(queueCache, tabId);
}

const countIn = (q, state) => q.order.filter((u) => q.items[u].state === state).length;
const nextPending = (q) => q.order.find((u) => q.items[u].state === "pending") || null;
const workTimeout = (q) => WORK_TIMEOUT_MS[q.feature] || WORK_TIMEOUT_MS.keyword;

// ── Pace limit ──
// One slot clock (q.nextSlotAt, persisted) spaces every profile load across all worker
// tabs. The default pace is PROFILES_PER_MINUTE_PER_WORKER × workers (2× = 6/min,
// 3× = 9/min): a single shared 6/min let two tabs use every slot, so 3× never opened
// its third tab and ran no faster than 2×. The popup can pass `profilesPerMinute`;
// the gap between slots is jittered like every other delay.
const PROFILES_PER_MINUTE_PER_WORKER = 3;
const defaultPace = (workers) => PROFILES_PER_MINUTE_PER_WORKER * workers;
const paceMs = (q) => 60000 / (q.profilesPerMinute || defaultPace(q.workers || 2));

// Reserve the next load slot at least minDelayMs from now; returns the wait in ms.
function takeSlot(q, minDelayMs) {
  const now = Date.now();
  const at = Math.max(now + minDelayMs, q.nextSlotAt || 0);
  q.nextSlotAt = at + jitter(paceMs(q));
  return at - now;
}

// Send a leased worker tab to its URL at its slot. `navAt` stays on the item until the
// navigation is issued, so the watchdog can issue it if an SW restart drops the timer.
function scheduleNav(q, url, tabId, minDelayMs) {
  const item = q.items[url];
  const delay = takeSlot(q, minDelayMs);
  item.navAt = Date.now() + delay;
  item.navDelayMs = delay;
  item.leaseUntil = item.navAt + START_TIMEOUT_MS; // waiting for a slot isn't hanging
  setTimeout(() => withQueue((ctx) => kickNav(ctx.q, tabId, url)), delay);
}

function kickNav(q, tabId, url) {
  const l = leaseOf(q, tabId);
  if (!l || l.url !== url || l.item.navAt == null || q.pausedSince) return;
  l.item.navAt = null;
  navigateWorker(tabId, url);
}

function lease(q, url, tabId) {
  const item = q.items[url];
  // Every tab that ever worked this run: tabs they open are closed (see tabs.onCreated).
  q.ownTabs = q.ownTabs || [];
  if (!q.ownTabs.includes(tabId)) q.ownTabs.push(tabId);
  delete item.navDelayMs;
  delete item.navAt;
  item.state = "leased";
  item.tabId = tabId;
  item.started = false;
  item.attempts = (item.attempts || 0) + 1;
  item.leaseUntil = Date.now() + START_TIMEOUT_MS;
}

function release(q, url, state, extra) {
  const item = q.items[url];
  item.state = state;
  item.tabId = null;
  item.started = false;
  item.leaseUntil = null;
  Object.assign(item, extra);
}

function shapeResult(feature, url, m) {
  // GDPR minimization: for salary only `moved` is kept — the amount is never persisted.
  if (feature === "salary") return { url, moved: !!m.moved, error: m.error || undefined };
  return {
    url,
    hitCount: m.hitCount || 0,
    matchedKeywords: m.matchedKeywords || [],
    booleanPass: m.booleanPass,
    notesPosted: !!m.notesPosted,
    notesFailReason: m.notesFailReason || "",
    textStats: m.textStats || null,
    diagLog: m.diagLog || undefined,
    error: m.error || undefined, // e.g. controls_timeout: the page never loaded, nothing was scanned
    timings: phaseTimings(m.timings),
  };
}

// Per-phase durations (ms) from the worker — numbers only, so nothing else rides along.
function phaseTimings(t) {
  if (!t || typeof t !== "object") return undefined;
  const out = {};
  for (const [k, v] of Object.entries(t).slice(0, 30)) {
    if (/^[A-Za-z]{1,32}$/.test(k) && Number.isFinite(v)) out[k] = Math.round(v);
  }
  return Object.keys(out).length ? out : undefined;
}

// ── Logged out mid-run: pause, don't fail ──
// Signing out of SmartRecruiters sends every SR tab — worker tabs included — to the
// sign-in page. That says nothing about the profiles, so the run pauses (no launches,
// no lease expiry, no breaker) and resumes as soon as a worker tab is back on a normal
// SR page after login. Still logged out after LOGOUT_WAIT_MAX_MS → stop ("logged_out").
const SIGN_IN_RE = /^https?:\/\/[^/]*smartrecruiters\.com\/account\/(sign-?in|login)\b/i;
const LOGOUT_WAIT_MAX_MS = 15 * 60 * 1000;
const isSignInUrl = (u) => SIGN_IN_RE.test(u || "");
const isSrUrl = (u) => /^https?:\/\/[^/]*smartrecruiters\.com\//i.test(u || "");

function pauseForLogout(q) {
  if (q.pausedSince) return;
  q.pausedSince = Date.now();
  q.pauseReason = "logged_out";
  showNotification(
    "srLoggedOut_" + q.pausedSince,
    "NIQ TA Helper — Paused: logged out",
    "SmartRecruiters logged you out. Log back in within 15 minutes and the run continues where it left off."
  );
}

function resumeAfterLogin(q) {
  if (!q.pausedSince) return;
  q.pausedSince = null;
  q.pauseReason = null;
  // Each in-flight profile restarts from a fresh page load: give it a new start window.
  // A tab that doesn't come back from the sign-in page is reclaimed by the watchdog.
  const now = Date.now();
  for (const url of q.order) {
    const item = q.items[url];
    if (item.state === "leased") { item.started = false; item.leaseUntil = now + START_TIMEOUT_MS; }
  }
  scheduleFill(q);
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  withQueue((ctx) => {
    const q = ctx.q;
    if (!q || q.stopped || !leaseOf(q, tabId)) return;
    if (isSignInUrl(change.url)) pauseForLogout(q);
    else if (q.pausedSince && q.pauseReason !== "bot_check" && isSrUrl(change.url)) resumeAfterLogin(q);
  });
});

// ── Bot check mid-run: pause, hand it to the recruiter ──
// DataDome (SR's bot protection) can put its challenge on any page load or over a page
// mid-profile. Workers report it (`botCheck` on check-in / srWorkerDone). The run pauses
// — no new loads, no lease expiry, no breaker — and that tab is brought to the front so
// the recruiter can solve it. We never interact with the challenge ourselves.
// Resume: the paused tab checks in clean (DataDome reloads the page once solved), or the
// watchdog finds the challenge gone. Unsolved after BOT_CHECK_WAIT_MAX_MS → stop ("bot_check").
const BOT_CHECK_WAIT_MAX_MS = 15 * 60 * 1000;

function pauseForBotCheck(q, tabId) {
  const l = leaseOf(q, tabId);
  // Whatever this tab was doing is suspect: reload its profile after the pause.
  if (l) { l.item.started = false; l.item.navAt = null; }
  if (q.pausedSince) return;
  q.pausedSince = Date.now();
  q.pauseReason = "bot_check";
  q.pauseTabId = tabId;
  chrome.tabs.update(tabId, { active: true }).then(
    (tab) => tab && chrome.windows.update(tab.windowId, { focused: true }),
  ).catch(() => {});
  showNotification(
    "srBotCheck_" + q.pausedSince,
    "NIQ TA Helper — Paused: bot check",
    "SmartRecruiters is asking you to confirm you're human. Solve it in the tab that just opened; the run continues by itself. It stops if not solved within 15 minutes."
  );
}

function resumeAfterBotCheck(q, checkedInTabId) {
  q.pausedSince = null;
  q.pauseReason = null;
  q.pauseTabId = null;
  const now = Date.now();
  for (const url of q.order) {
    const item = q.items[url];
    if (item.state !== "leased") continue;
    if (item.started) item.leaseUntil = Math.max(item.leaseUntil, now + workTimeout(q));
    // Not started: idle, or on the challenge page — reload its profile at its pace slot.
    else if (item.tabId !== checkedInTabId) scheduleNav(q, url, item.tabId, jitter(1500));
  }
  scheduleFill(q);
}

// Runs in the paused tab: is DataDome's challenge still there?
function botCheckShownInPage(botCheckSel) {
  return !!document.querySelector(botCheckSel);
}

// Runs in the profile page's MAIN world — CKEditor lives there, not in the content
// script's isolated world. SR's notes editor is CKEditor 4, whose writer puts "\n" after
// every <br> in getData(); SR turns each "\n" into another <br>, so every note line was
// double-spaced. Dropping that newline keeps keyword notes compact. Returns the number
// of editors changed.
function compactNoteBreaksInPage() {
  const C = window.CKEDITOR;
  if (!C || !C.instances) return 0;
  let n = 0;
  for (const ed of Object.values(C.instances)) {
    try {
      ed.dataProcessor.writer.setRules("br", { breakAfterOpen: false, breakAfterClose: false });
      n++;
    } catch (_) {}
  }
  return n;
}

async function botCheckStillShown(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: botCheckShownInPage, args: [__SR.sel.botCheck] });
    return !!(r && r.result);
  } catch (_) {
    return false; // tab gone or not scriptable: resume — the next page load reports it again
  }
}

// ── Circuit breaker ──
// BREAKER_TRIP_COUNT profiles in a row failing for the same reason means SmartRecruiters
// itself is wrong (logged out, bot check, notes UI changed): stop instead of burning
// through the list. The streak lives on the queue, so it survives an SW restart.
const BREAKER_TRIP_COUNT = 3;
const BREAKER_LABELS = {
  controls_timeout: "page never finished loading",
  timeout: "tab hung",
  notes_failed: "note not posted",
  logged_out: "logged out of SmartRecruiters",
  bot_check: "SmartRecruiters bot check not solved",
};
// Stops from a pause that ran out, not from BREAKER_TRIP_COUNT failures in a row.
const PAUSE_STOP_REASONS = ["logged_out", "bot_check"];

// Why a finished URL counts against the breaker, or null (success — resets the streak).
// tab_closed never gets here: the recruiter's own action neither counts nor resets.
function breakerReason(result) {
  if (result.error) return result.error;
  if (result.hitCount > 0 && !result.notesPosted) return "notes_failed";
  return null;
}

// Record a finished URL's result; returns true if the breaker tripped (run is stopped).
function recordOutcome(ctx, result) {
  const q = ctx.q;
  const reason = breakerReason(result);
  const b = q.breaker || (q.breaker = { reason: null, count: 0 });
  if (reason === null) { b.reason = null; b.count = 0; return false; }
  if (b.reason === reason) b.count++;
  else { b.reason = reason; b.count = 1; }
  if (b.count < BREAKER_TRIP_COUNT) return false;
  q.stopped = true;
  q.trippedReason = reason;
  finishIfDrained(ctx, { stopped: true });
  return true;
}

const closeTab = (tabId) => { if (tabId != null) chrome.tabs.remove(tabId).catch(() => {}); };

// Tab launches holding a pace slot but not yet opened (times, persisted). They count
// toward q.workers so a free worker isn't launched twice. An entry well past its time
// is a timer lost to a service-worker restart, so it stops counting.
const LAUNCH_RESERVATION_GRACE_MS = 30000;
function launchesPending(q) {
  const cutoff = Date.now() - LAUNCH_RESERVATION_GRACE_MS;
  q.launchAt = (q.launchAt || []).filter((t) => t > cutoff);
  return q.launchAt.length;
}

// Reserve a pace slot for a new worker tab, then open it when the slot comes up.
// The slot is reserved up front like a reused tab's navigation (scheduleNav): a launch
// that only re-checked the clock lost every slot to busy reused tabs, so the last
// worker of a 3× run never opened.
function launchWorker() {
  return withQueue((ctx) => {
    const q = ctx.q;
    if (!q || q.stopped || q.pausedSince) return;
    if (countIn(q, "leased") + launchesPending(q) >= q.workers) return;
    if (!nextPending(q)) { finishIfDrained(ctx); return; }
    const wait = takeSlot(q, 0);
    const at = Date.now() + wait;
    q.launchAt.push(at);
    setTimeout(() => openWorkerTab(at), wait);
  });
}

function openWorkerTab(at) {
  return withQueue(async (ctx) => {
    const q = ctx.q;
    if (!q) return;
    const i = (q.launchAt || []).indexOf(at);
    if (i < 0) return; // run restarted or reservation expired
    q.launchAt.splice(i, 1);
    if (q.stopped || q.pausedSince || countIn(q, "leased") >= q.workers) return;
    const url = nextPending(q);
    if (!url) { finishIfDrained(ctx); return; }
    let tab;
    try {
      tab = await createWorkerTab(q, url);
    } catch (_) {
      setTimeout(launchWorker, jitter(1600));
      return;
    }
    lease(q, url, tab.id);
  });
}

// Worker tabs live in their own unfocused window (q.workerWindowId), so activating one
// to render a resume never switches the tab the recruiter is on, and their clicking
// around in other windows never lands on a worker. Falls back to a background tab in
// the current window if a window can't be opened.
async function createWorkerTab(q, url) {
  if (q.workerWindowId != null) {
    try { return await chrome.tabs.create({ windowId: q.workerWindowId, url, active: false }); }
    catch (_) { q.workerWindowId = null; } // the recruiter closed the worker window
  }
  try {
    const win = await chrome.windows.create({ url, focused: false, type: "normal" });
    const tab = win && win.tabs && win.tabs[0];
    if (tab) { q.workerWindowId = win.id; return tab; }
  } catch (_) {}
  return chrome.tabs.create({ url, active: false });
}

// Schedule launches for free worker slots (e.g. after a timeout or closed tab).
// Surplus calls are harmless: launchWorker re-checks capacity under the lock.
function scheduleFill(q) {
  if (!q || q.stopped) return;
  const free = Math.min(q.workers - countIn(q, "leased"), countIn(q, "pending"));
  for (let i = 1; i <= free; i++) setTimeout(launchWorker, jitter(1800) * i);
}

// Reuse a worker tab for its next URL (fewer fresh tabs = less bot-like).
function navigateWorker(tabId, url) {
  chrome.tabs.update(tabId, { url }).catch(() => {
    // Tab vanished before reuse — nothing was processed, so put the URL back.
    withQueue((ctx) => {
      const l = leaseOf(ctx.q, tabId);
      if (!l || l.url !== url || l.item.started) return;
      release(ctx.q, url, "pending", { attempts: l.item.attempts - 1 });
      scheduleFill(ctx.q);
    });
  });
}

// A finished run's worker tabs, kept briefly: a resume tab can open just after its
// worker finished (slow attachment click), and would otherwise outlive the run.
const RECENT_WORKER_TABS_KEY = "srRecentWorkerTabs";
const RECENT_WORKER_TABS_MS = 2 * 60 * 1000;

// Close every tab this run's workers opened that is still around, and remember the
// worker tabs for RECENT_WORKER_TABS_MS (see tabs.onCreated).
function sweepRunTabs(q) {
  const own = q.ownTabs || [];
  if (!own.length) return;
  chrome.storage.session.set({ [RECENT_WORKER_TABS_KEY]: { tabIds: own, until: Date.now() + RECENT_WORKER_TABS_MS } }).catch(() => {});
  chrome.tabs.query({}).then((all) => {
    for (const t of all || []) if (t.openerTabId != null && own.includes(t.openerTabId)) closeTab(t.id);
  }).catch(() => {});
}

// Drop the current run without saving results (a new run replaced it, or it went stale).
function abandonQueue(ctx) {
  const q = ctx.q;
  if (!q) return;
  for (const url of q.order) if (q.items[url].state === "leased") closeTab(q.items[url].tabId);
  sweepRunTabs(q);
  ctx.q = null;
  chrome.alarms.clear(WATCHDOG_ALARM).catch(() => {});
}

// If nothing is pending or leased (or the run was stopped), save results, notify and
// clear the queue. Returns true if the run finished.
function finishIfDrained(ctx, { stopped = false } = {}) {
  const q = ctx.q;
  if (!q) return false;
  if (!stopped && (countIn(q, "pending") || countIn(q, "leased"))) return false;

  for (const url of q.order) {
    const item = q.items[url];
    if (item.state === "leased") { closeTab(item.tabId); release(q, url, "pending"); }
  }
  const results = q.order
    .map((u) => q.items[u])
    .filter((item) => item.state === "done" || item.state === "failed")
    .map((item) => item.result);

  const finishedAt = Date.now();
  // Failed URLs (tab_closed / timeout / controls_timeout) were never scanned — report
  // them apart, not as misses.
  const failed = results.filter((r) => r.error).length;
  const scanned = results.length - failed;
  const plural = (n) => n + " profile" + (n !== 1 ? "s" : "");
  const salary = q.feature === "salary";
  const lastRun = { finishedAt, results, parallel: true, total: q.order.length, stoppedReason: q.trippedReason };
  chrome.storage.local
    .set({ [salary ? "salaryTriageLastRun" : "keywordTriageLastRun"]: lastRun })
    .catch(() => {});
  if (q.trippedReason) {
    const label = BREAKER_LABELS[q.trippedReason] || q.trippedReason;
    showNotification(
      "srParallelTripped_" + finishedAt,
      "NIQ TA Helper — Run stopped early",
      (PAUSE_STOP_REASONS.includes(q.trippedReason)
        ? "Stopped: " + label + " for 15 minutes. "
        : "Stopped after " + BREAKER_TRIP_COUNT + " profiles in a row failed (" + label + "). ") +
        results.length + " of " + q.order.length + " processed — check SmartRecruiters, then re-run."
    );
  } else if (salary) {
    const moved = results.filter((r) => r.moved).length;
    showNotification(
      "srParallelDone_" + finishedAt,
      "NIQ TA Helper — Cost assist done",
      plural(moved) + " moved forward out of " + scanned + " screened." +
        (failed ? " " + failed + " could not be screened (see the popup for why)." : "")
    );
  } else {
    const matched = results.filter((r) => r.hitCount > 0).length;
    showNotification(
      "srParallelDone_" + finishedAt,
      "NIQ TA Helper — Keyword search done",
      plural(matched) + " matched out of " + scanned + " scanned." +
        (failed ? " " + failed + " could not be scanned (see the popup for why)." : "")
    );
  }
  playBeepInSRTab(q.returnUrl || "");
  pruneProfileDiags();
  sweepRunTabs(q);
  ctx.q = null;
  chrome.alarms.clear(WATCHDOG_ALARM).catch(() => {});
  return true;
}

// Per-profile diagnostics (lastRunDiag_<ts>, candidate PII) are capped at 20. The worker
// trims after each save, but a worker tab closed right after its last profile can die
// before its trim runs — so trim once more here, where nothing closes under us.
const DIAG_PREFIX = "lastRunDiag_";
const DIAG_MAX_ENTRIES = 20;
function pruneProfileDiags() {
  chrome.storage.local.get(null).then((all) => {
    const ts = (k) => parseInt(k.slice(DIAG_PREFIX.length), 10) || 0;
    const extra = Object.keys(all || {})
      .filter((k) => k.startsWith(DIAG_PREFIX))
      .sort((a, b) => ts(b) - ts(a))
      .slice(DIAG_MAX_ENTRIES);
    if (extra.length) return chrome.storage.local.remove(extra);
  }).catch(() => {});
}

function startQueue(feature, message) {
  return withQueue(async (ctx) => {
    abandonQueue(ctx);
    const urls = [...new Set(message.urls || [])];
    const workers = Math.max(1, Math.min(5, message.workers || 2));
    const ppm = Number(message.profilesPerMinute);
    const profilesPerMinute = Number.isFinite(ppm) && ppm > 0 ? Math.min(30, ppm) : defaultPace(workers);
    ctx.q = {
      runId: "r" + Date.now(),
      feature,
      workers,
      profilesPerMinute,
      nextSlotAt: 0,
      returnUrl: message.returnUrl || "",
      startedAt: Date.now(),
      stopped: false,
      order: urls,
      items: Object.fromEntries(urls.map((u) => [u, { state: "pending", attempts: 0 }])),
    };
    // Workers read their config from here when they check in.
    await chrome.storage.local.set({ srParallelWorkerConfig: message.config || {} }).catch(() => {});
    chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
    if (!urls.length) { finishIfDrained(ctx); return { queued: 0, workers, profilesPerMinute }; }
    // Stagger the first tabs (anti-detection); launchWorker also waits for its pace slot.
    let delay = 0;
    for (let i = 0; i < Math.min(workers, urls.length); i++) {
      setTimeout(launchWorker, delay);
      delay += jitter(2800);
    }
    return { queued: urls.length, workers, profilesPerMinute };
  });
}

function handleWorkerCheckIn(tabId, pageUrl, botCheck) {
  return withQueue((ctx) => {
    const q = ctx.q;
    const l = q && !q.stopped ? leaseOf(q, tabId) : null;
    if (!l) return { active: false, feature: null };
    // On the sign-in page there's no profile to scan: pause, and keep the worker idle.
    if (isSignInUrl(pageUrl)) { pauseForLogout(q); return { active: false, feature: null }; }
    if (botCheck) { pauseForBotCheck(q, tabId); return { active: false, feature: null }; }
    if (q.pausedSince && q.pauseReason === "bot_check") {
      // Only the challenge tab coming back clean ends the pause; other tabs wait and
      // are reloaded on resume.
      if (q.pauseTabId !== tabId) return { active: false, feature: null };
      resumeAfterBotCheck(q, tabId);
    }
    l.item.navAt = null;
    l.item.started = true;
    l.item.leaseUntil = Date.now() + workTimeout(q);
    return { active: true, feature: q.feature };
  });
}

function handleWorkerDone(tabId, message, pageUrl) {
  return withQueue((ctx) => {
    const q = ctx.q;
    // A report from the sign-in page is about the logout, not the profile.
    if (isSignInUrl(pageUrl)) { if (q && leaseOf(q, tabId)) pauseForLogout(q); return { next: false }; }
    const l = leaseOf(q, tabId);
    // Only the page that checked in for this lease may complete it. Anything else — a
    // duplicate message, a tab whose lease the watchdog reclaimed, a tab from an older
    // run — is ignored, so a URL is never recorded twice or with another URL's result.
    if (!l || !l.item.started) return { next: false };
    // The challenge covered this page mid-profile: its result can't be trusted.
    if (message.botCheck) { pauseForBotCheck(q, tabId); return { next: false }; }
    const result = shapeResult(q.feature, l.url, message);
    if (result.timings && l.item.navDelayMs != null) result.timings = { navDelay: l.item.navDelayMs, ...result.timings };
    release(q, l.url, "done", { result });
    if (recordOutcome(ctx, result)) { closeTab(tabId); return { next: false }; }

    // Paused for a bot check: load nothing new. The slot is refilled on resume.
    const nextUrl = q.stopped || q.pauseReason === "bot_check" ? null : nextPending(q);
    if (!nextUrl) {
      closeTab(tabId);
      finishIfDrained(ctx);
      return { next: false };
    }
    lease(q, nextUrl, tabId);
    scheduleNav(q, nextUrl, tabId, message.notesPosted ? jitter(2400) : jitter(1600));
    scheduleFill(q);
    return { next: true, url: nextUrl };
  });
}

// Any message from a worker that's still working proves it's alive — extend its lease.
function renewLease(tabId) {
  if (tabId == null) return;
  withQueue((ctx) => {
    const l = leaseOf(ctx.q, tabId);
    if (l && l.item.started) l.item.leaseUntil = Date.now() + workTimeout(ctx.q);
  });
}

function stopQueue() {
  return withQueue((ctx) => {
    const q = ctx.q;
    if (!q) return null;
    const doneCount = countIn(q, "done") + countIn(q, "failed");
    q.stopped = true;
    finishIfDrained(ctx, { stopped: true });
    return doneCount;
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  withQueue(async (ctx) => {
    const q = ctx.q;
    if (!q) { chrome.alarms.clear(WATCHDOG_ALARM).catch(() => {}); return; }
    const now = Date.now();
    if (now - q.startedAt > STALE_QUEUE_MS) { abandonQueue(ctx); return; }
    if (q.pausedSince) {
      const botCheck = q.pauseReason === "bot_check";
      if (now - q.pausedSince >= (botCheck ? BOT_CHECK_WAIT_MAX_MS : LOGOUT_WAIT_MAX_MS)) {
        q.stopped = true;
        q.trippedReason = botCheck ? "bot_check" : "logged_out";
        finishIfDrained(ctx, { stopped: true });
        return;
      }
      if (botCheck && !(await botCheckStillShown(q.pauseTabId))) resumeAfterBotCheck(q);
      return; // leases can't expire while we wait for the recruiter
    }
    // Navigations whose timer died with a stopped service worker.
    for (const url of q.order) {
      const item = q.items[url];
      if (item.state === "leased" && item.navAt != null && item.navAt <= now) kickNav(q, item.tabId, url);
    }
    for (const url of q.order) {
      const item = q.items[url];
      if (item.state !== "leased" || item.leaseUntil > now) continue;
      const tabId = item.tabId;
      closeTab(tabId);
      if (item.attempts < MAX_ATTEMPTS) { release(q, url, "pending"); continue; }
      const result = { url, error: "timeout" };
      release(q, url, "failed", { result });
      if (recordOutcome(ctx, result)) return;
    }
    if (!finishIfDrained(ctx)) scheduleFill(q);
  });
});

// ── Resume-render focus manager ──
// pdf.js does NOT render in hidden (background) worker tabs — Chrome pauses
// requestAnimationFrame when document.visibilityState === "hidden", so the resume
// text layer never appears and extraction falls back to SR's profile chrome. To get
// the real resume we briefly foreground the worker tab while it reads the PDF, then
// restore the user's tab. Serialized: only one worker holds focus at a time, and
// focus hands off directly between workers so the user's tab isn't bounced each pass.
const resumeFocus = {
  holder: null,     // tabId currently foregrounded for resume rendering
  restore: null,    // what to give back once no worker needs focus (see showTabForRender)
  queue: [],        // pending [{ tabId, resolve }]
  timer: null,      // safety auto-release (content script may never send release)
};

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tabIsVisible(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.visibilityState === "visible",
    });
    return !!(r && r.result);
  } catch (_) {
    return false;
  }
}

// Get a tab on screen so pdf.js renders, disturbing the recruiter as little as possible:
// 1. Activate it inside its own window. In the worker window that touches nothing of
//    theirs; in their window (fallback, no worker window) note their tab to give back.
// 2. Only if the page is still hidden (window covered or behind others), raise its
//    window, noting the window they were in.
// Returns { windowId, raisedFrom, priorTabId } for giveFocusBack.
async function showTabForRender(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  const out = { windowId: tab.windowId, tabId, raisedFrom: null, priorTabId: null };
  if (!tab.active) {
    const [prior] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
    if (prior && !isWorkerTab(prior.id) && prior.id !== tabId) out.priorTabId = prior.id;
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await _sleep(150);
  }
  if (!(await tabIsVisible(tabId))) {
    const focused = await chrome.windows.getLastFocused().catch(() => null);
    if (focused && focused.id !== tab.windowId) out.raisedFrom = focused.id;
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return out;
}

// Undo showTabForRender, but only what still looks like ours: if the recruiter has
// since switched tab or window themselves, leave them where they are.
async function giveFocusBack(r) {
  if (!r) return;
  if (r.priorTabId != null) {
    const [active] = await chrome.tabs.query({ active: true, windowId: r.windowId }).catch(() => []);
    if (!active || active.id === r.tabId || isWorkerTab(active.id)) {
      chrome.tabs.update(r.priorTabId, { active: true }).catch(() => {});
    }
  }
  if (r.raisedFrom != null) {
    const focused = await chrome.windows.getLastFocused().catch(() => null);
    if (!focused || focused.id === r.windowId) chrome.windows.update(r.raisedFrom, { focused: true }).catch(() => {});
  }
}

async function _grantResumeFocus(tabId) {
  resumeFocus.holder = tabId;
  clearTimeout(resumeFocus.timer);
  resumeFocus.timer = setTimeout(() => releaseResumeFocus(tabId), 25000);
  const r = await showTabForRender(tabId);
  // Focus hands off between workers: keep the first thing to give back to the recruiter.
  if (r && (r.priorTabId != null || r.raisedFrom != null)) {
    const keep = resumeFocus.restore;
    if (!keep) resumeFocus.restore = r;
    else {
      if (keep.priorTabId == null && r.priorTabId != null) { keep.priorTabId = r.priorTabId; keep.windowId = r.windowId; keep.tabId = r.tabId; }
      if (keep.raisedFrom == null) keep.raisedFrom = r.raisedFrom;
    }
  }
}

function acquireResumeFocus(tabId) {
  if (resumeFocus.holder === tabId) return Promise.resolve();
  if (resumeFocus.holder != null) return new Promise((resolve) => resumeFocus.queue.push({ tabId, resolve }));
  return _grantResumeFocus(tabId);
}

function releaseResumeFocus(tabId) {
  if (resumeFocus.holder !== tabId) {
    // Tab was queued but never got focus — drop it from the queue.
    resumeFocus.queue = resumeFocus.queue.filter((q) => q.tabId !== tabId);
    return;
  }
  clearTimeout(resumeFocus.timer);
  resumeFocus.holder = null;
  const next = resumeFocus.queue.shift();
  if (next) {
    _grantResumeFocus(next.tabId).then(next.resolve);
  } else {
    // Nobody waiting — give the recruiter back their tab/window.
    const r = resumeFocus.restore;
    resumeFocus.restore = null;
    giveFocusBack(r);
  }
}

// ── Resume attachment fallback ──
// When the inline resume viewer never renders (even with foreground focus), the
// content script clicks the "Resume" attachment, which opens the full resume in a
// NEW tab. A content script can't read another tab's DOM, so the background catches
// that tab (by openerTabId), foregrounds it so pdf.js renders, extracts the text via
// chrome.scripting, closes it, and hands the text back to the worker.
const resumeCapture = {
  pending: new Map(), // workerTabId -> { armedAt, opened }
  results: new Map(), // workerTabId -> { done, text }
};

// Injected into the resume tab (all frames). Prefers pdf.js text-layer spans, else
// a shadow-piercing text walk. Self-contained — runs in the page's isolated world.
function _extractResumeTextInPage(spanSel) {
  try {
    var spans = document.querySelectorAll(spanSel);
    if (spans.length > 20) {
      var parts = [];
      for (var i = 0; i < spans.length; i++) { var t = (spans[i].textContent || "").trim(); if (t) parts.push(t); }
      if (parts.join(" ").length > 200) return parts.join(" ");
    }
  } catch (_) {}
  function deepText(root) {
    var out = [], seen = new Set();
    (function walk(n) {
      if (!n || seen.has(n)) return; seen.add(n);
      if (n.nodeType === 3) { var t = (n.nodeValue || "").trim(); if (t) out.push(t); return; }
      if (n.shadowRoot) walk(n.shadowRoot);
      var k = n.childNodes; if (k) for (var i = 0; i < k.length; i++) walk(k[i]);
    })(root);
    return out.join(" ");
  }
  try { return deepText(document.body || document.documentElement); } catch (_) { return ""; }
}

async function captureResumeFromTab(workerTabId, resumeTabId) {
  let text = "";
  let shown = null;
  try {
    // Wait for the resume tab to finish loading.
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(to); resolve(); } };
      const to = setTimeout(finish, 10000);
      function onUpd(tid, ch) { if (tid === resumeTabId && ch.status === "complete") finish(); }
      chrome.tabs.onUpdated.addListener(onUpd);
      chrome.tabs.get(resumeTabId, (t) => { if (!chrome.runtime.lastError && t && t.status === "complete") finish(); });
    });
    // On screen so pdf.js renders (its window is raised only if it stays hidden), then
    // give it time to paint the text layer.
    shown = await showTabForRender(resumeTabId);
    await _sleep(6000);
    let results = [];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: resumeTabId, allFrames: true },
        func: _extractResumeTextInPage,
        args: [__SR.sel.pdfTextSpans],
      });
    } catch (_) {}
    for (const r of results || []) { if (r && r.result && r.result.length > text.length) text = r.result; }
  } catch (_) {}
  try { await chrome.tabs.remove(resumeTabId); } catch (_) {}
  // The resume tab opened next to its worker; the worker's own focus (if it holds it)
  // is restored by releaseResumeFocus, so only undo what showing this tab did.
  if (shown) { shown.priorTabId = null; giveFocusBack(shown); }
  resumeCapture.results.set(workerTabId, { done: true, text: text });
  resumeCapture.pending.delete(workerTabId);
}

chrome.tabs.onCreated.addListener((tab) => {
  const opener = tab.openerTabId;
  if (opener == null) return;
  if (resumeCapture.pending.has(opener)) {
    resumeCapture.pending.get(opener).opened = true;
    captureResumeFromTab(opener, tab.id);
    return;
  }
  // Any other tab a parallel worker opens (e.g. a resume-tab click that hit the
  // attachment link) is a side effect nobody will look at — close it, or recruiters
  // are left with a pile of "latest-resume" tabs. Any tab that worked this run counts,
  // not just one holding a lease: the tab can open after its worker finished, or just
  // after the run ended. Never a tab opened from the recruiter's own tabs. Via
  // withQueue so it holds after an SW restart.
  withQueue(async (ctx) => {
    if (ctx.q && (ctx.q.ownTabs || []).includes(opener)) { closeTab(tab.id); return; }
    const got = await chrome.storage.session.get(RECENT_WORKER_TABS_KEY).catch(() => ({}));
    const recent = got && got[RECENT_WORKER_TABS_KEY];
    if (recent && recent.until > Date.now() && recent.tabIds.includes(opener)) closeTab(tab.id);
  });
});

// ── Message handler ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "srRequestResumeFocus" || message.type === "srReleaseResumeFocus" ||
      message.type === "srArmResumeCapture" || message.type === "srGetResumeCapture") {
    // Mid-profile worker activity (slow resume render/capture) — keep its lease alive.
    renewLease(sender.tab && sender.tab.id);
  }

  if (message.type === "srEnsureSessionAccess") {
    // Popup awaits this before seeding a queue so the content-script write to
    // chrome.storage.session is not denied by a not-yet-applied access level.
    ensureSessionAccess().then((ok) => sendResponse({ ok }));
    return true;
  }

  if (message.type === "srArmResumeCapture") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) { sendResponse({ ok: false }); return; }
    resumeCapture.pending.set(tabId, { armedAt: Date.now() });
    resumeCapture.results.delete(tabId);
    // Expire a stale arm if the expected tab never opened.
    setTimeout(() => {
      const p = resumeCapture.pending.get(tabId);
      if (p && Date.now() - p.armedAt >= 14000) resumeCapture.pending.delete(tabId);
    }, 15000);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "srGetResumeCapture") {
    const tabId = sender.tab && sender.tab.id;
    const res = tabId != null ? resumeCapture.results.get(tabId) : null;
    if (res && res.done) { resumeCapture.results.delete(tabId); sendResponse({ done: true, text: res.text }); }
    else {
      const p = tabId != null ? resumeCapture.pending.get(tabId) : null;
      sendResponse({ done: false, opened: !!(p && p.opened) });
    }
    return true;
  }

  if (message.type === "srRequestResumeFocus") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) { sendResponse({ ok: false }); return; }
    acquireResumeFocus(tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "srReleaseResumeFocus") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) releaseResumeFocus(tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "srCompactNoteBreaks") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) { sendResponse({ ok: false }); return; }
    const target = { tabId };
    if (sender.frameId != null) target.frameIds = [sender.frameId];
    chrome.scripting.executeScript({ target, world: "MAIN", func: compactNoteBreaksInPage })
      .then((res) => {
        const editors = (res && res[0] && res[0].result) || 0;
        sendResponse({ ok: editors > 0, editors });
      })
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (message.type === "srCloseExtraProfileTabs") {
    const keepId = sender.tab && sender.tab.id;
    chrome.tabs.query({ url: "*://*.smartrecruiters.com/*" }, (tabs) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      for (const t of tabs) {
        const u = t.url || "";
        if (!/\/app\/people\/(applications|profile)\//i.test(u)) continue;
        if (keepId != null && t.id === keepId) continue;
        chrome.tabs.remove(t.id).catch(() => {});
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "srStartParallelKeywordQueue" || message.type === "srStartParallelSalaryQueue") {
    const feature = message.type === "srStartParallelSalaryQueue" ? "salary" : "keyword";
    startQueue(feature, message).then(({ queued, workers, profilesPerMinute }) =>
      sendResponse({ ok: true, queued, workers, profilesPerMinute, feature }));
    return true;
  }

  if (message.type === "srQueueStatus") {
    // Popup preflight: is a run going? (Starting a new one replaces it.)
    withQueue((ctx) => (ctx.q && !ctx.q.stopped ? { running: true, feature: ctx.q.feature } : { running: false }))
      .then(sendResponse);
    return true;
  }

  if (message.type === "srWorkerDone") {
    handleWorkerDone(sender.tab && sender.tab.id, message, sender.tab && sender.tab.url).then(sendResponse);
    return true;
  }

  if (message.type === "srStopParallelKeywordQueue") {
    stopQueue().then((doneCount) => {
      if (doneCount != null) {
        showNotification(
          "srStopped_" + Date.now(),
          "NIQ TA Helper — Search stopped",
          "Stopped after " + doneCount + " profile" + (doneCount !== 1 ? "s" : "") + "."
        );
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "srQueueDone") {
    showNotification(
      "srQueueDone_" + Date.now(),
      "NIQ TA Helper — Keyword search done",
      (message.matchedLen || 0) + " profile" + (message.matchedLen !== 1 ? "s" : "") +
        " matched out of " + (message.resultsLen || 0) + " scanned."
    );
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "srIsParallelWorker") {
    // Also the worker's check-in: it starts the lease's work timer. `feature` lets each
    // autorun (salary and keyword both run on every profile page) claim only its own tabs.
    handleWorkerCheckIn(sender.tab && sender.tab.id, sender.tab && sender.tab.url, !!message.botCheck).then(sendResponse);
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Free the resume-focus lock if a holding/queued worker tab is closed.
  if (resumeFocus.holder === tabId || resumeFocus.queue.some((q) => q.tabId === tabId)) {
    releaseResumeFocus(tabId);
  }
  withQueue((ctx) => {
    const l = leaseOf(ctx.q, tabId);
    if (!l) return; // not a worker, or one we closed ourselves (lease already released)
    if (ctx.q.pausedSince) {
      // Closed while logged out (by the recruiter or SR's sign-out): nothing was scanned.
      release(ctx.q, l.url, "pending", { attempts: Math.max(0, l.item.attempts - 1) });
      return;
    }
    if (l.item.started) {
      // Closed mid-profile — report it, don't retry (the recruiter may have closed it on
      // purpose). Not passed to recordOutcome: it says nothing about SmartRecruiters' health.
      release(ctx.q, l.url, "failed", { result: { url: l.url, error: "tab_closed" } });
    } else {
      // Closed between profiles — nothing was processed, so the URL goes back in the queue.
      release(ctx.q, l.url, "pending", { attempts: l.item.attempts - 1 });
    }
    if (!finishIfDrained(ctx)) scheduleFill(ctx.q);
  });
});
