// background.js — service worker: parallel queue coordinator (leases + watchdog) + tab cleanup (MV3)

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

function lease(q, url, tabId) {
  const item = q.items[url];
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
  };
}

const closeTab = (tabId) => { if (tabId != null) chrome.tabs.remove(tabId).catch(() => {}); };

// Open a new worker tab for the next pending URL, if a slot is free.
function launchWorker() {
  return withQueue(async (ctx) => {
    const q = ctx.q;
    if (!q || q.stopped || countIn(q, "leased") >= q.workers) return;
    const url = nextPending(q);
    if (!url) { finishIfDrained(ctx); return; }
    let tab;
    try {
      tab = await chrome.tabs.create({ url, active: false });
    } catch (_) {
      setTimeout(launchWorker, jitter(1600));
      return;
    }
    lease(q, url, tab.id);
  });
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

// Drop the current run without saving results (a new run replaced it, or it went stale).
function abandonQueue(ctx) {
  const q = ctx.q;
  if (!q) return;
  for (const url of q.order) if (q.items[url].state === "leased") closeTab(q.items[url].tabId);
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
  // Failed URLs (tab_closed / timeout) were never scanned — report them apart, not as misses.
  const failed = results.filter((r) => r.error).length;
  const scanned = results.length - failed;
  const plural = (n) => n + " profile" + (n !== 1 ? "s" : "");
  if (q.feature === "salary") {
    const moved = results.filter((r) => r.moved).length;
    chrome.storage.local
      .set({ salaryTriageLastRun: { finishedAt, results, parallel: true } })
      .catch(() => {});
    showNotification(
      "srParallelDone_" + finishedAt,
      "NIQ TA Helper — Cost assist done",
      plural(moved) + " moved forward out of " + scanned + " screened." +
        (failed ? " " + failed + " could not be screened (tab closed or timed out)." : "")
    );
  } else {
    const matched = results.filter((r) => r.hitCount > 0).length;
    chrome.storage.local
      .set({ keywordTriageLastRun: { finishedAt, results, parallel: true } })
      .catch(() => {});
    showNotification(
      "srParallelDone_" + finishedAt,
      "NIQ TA Helper — Keyword search done",
      plural(matched) + " matched out of " + scanned + " scanned." +
        (failed ? " " + failed + " could not be scanned (tab closed or timed out)." : "")
    );
  }
  playBeepInSRTab(q.returnUrl || "");
  ctx.q = null;
  chrome.alarms.clear(WATCHDOG_ALARM).catch(() => {});
  return true;
}

function startQueue(feature, message) {
  return withQueue(async (ctx) => {
    abandonQueue(ctx);
    const urls = [...new Set(message.urls || [])];
    const workers = Math.max(1, Math.min(5, message.workers || 2));
    ctx.q = {
      runId: "r" + Date.now(),
      feature,
      workers,
      returnUrl: message.returnUrl || "",
      startedAt: Date.now(),
      stopped: false,
      order: urls,
      items: Object.fromEntries(urls.map((u) => [u, { state: "pending", attempts: 0 }])),
    };
    // Workers read their config from here when they check in.
    await chrome.storage.local.set({ srParallelWorkerConfig: message.config || {} }).catch(() => {});
    chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
    if (!urls.length) { finishIfDrained(ctx); return { queued: 0, workers }; }
    // Stagger the first tabs (anti-detection): one now, the rest ~2.8s apart.
    let delay = 0;
    for (let i = 0; i < Math.min(workers, urls.length); i++) {
      setTimeout(launchWorker, delay);
      delay += jitter(2800);
    }
    return { queued: urls.length, workers };
  });
}

function handleWorkerCheckIn(tabId) {
  return withQueue((ctx) => {
    const q = ctx.q;
    const l = q && !q.stopped ? leaseOf(q, tabId) : null;
    if (!l) return { active: false, feature: null };
    l.item.started = true;
    l.item.leaseUntil = Date.now() + workTimeout(q);
    return { active: true, feature: q.feature };
  });
}

function handleWorkerDone(tabId, message) {
  return withQueue((ctx) => {
    const q = ctx.q;
    const l = leaseOf(q, tabId);
    // Only the page that checked in for this lease may complete it. Anything else — a
    // duplicate message, a tab whose lease the watchdog reclaimed, a tab from an older
    // run — is ignored, so a URL is never recorded twice or with another URL's result.
    if (!l || !l.item.started) return { next: false };
    release(q, l.url, "done", { result: shapeResult(q.feature, l.url, message) });

    const nextUrl = q.stopped ? null : nextPending(q);
    if (!nextUrl) {
      closeTab(tabId);
      finishIfDrained(ctx);
      return { next: false };
    }
    lease(q, nextUrl, tabId);
    setTimeout(() => navigateWorker(tabId, nextUrl), message.notesPosted ? jitter(2400) : jitter(1600));
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
  withQueue((ctx) => {
    const q = ctx.q;
    if (!q) { chrome.alarms.clear(WATCHDOG_ALARM).catch(() => {}); return; }
    const now = Date.now();
    if (now - q.startedAt > STALE_QUEUE_MS) { abandonQueue(ctx); return; }
    for (const url of q.order) {
      const item = q.items[url];
      if (item.state !== "leased" || item.leaseUntil > now) continue;
      const tabId = item.tabId;
      if (item.attempts < MAX_ATTEMPTS) release(q, url, "pending");
      else release(q, url, "failed", { result: { url, error: "timeout" } });
      closeTab(tabId);
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
  userTabId: null,  // the user's tab to restore once no worker needs focus
  queue: [],        // pending [{ tabId, resolve }]
  timer: null,      // safety auto-release (content script may never send release)
};

function _grantResumeFocus(tabId) {
  resumeFocus.holder = tabId;
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
    // The window must also be focused for visibilityState to become "visible".
    chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  });
  clearTimeout(resumeFocus.timer);
  resumeFocus.timer = setTimeout(() => releaseResumeFocus(tabId), 25000);
}

function acquireResumeFocus(tabId) {
  return new Promise((resolve) => {
    if (resumeFocus.holder === tabId) { resolve(); return; }
    if (resumeFocus.holder != null) { resumeFocus.queue.push({ tabId, resolve }); return; }
    // First steal — remember the user's (non-worker) tab so we can restore it later.
    if (resumeFocus.userTabId == null) {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const t = tabs && tabs[0];
        if (t && !isWorkerTab(t.id)) resumeFocus.userTabId = t.id;
        _grantResumeFocus(tabId);
        resolve();
      });
      return;
    }
    _grantResumeFocus(tabId);
    resolve();
  });
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
    _grantResumeFocus(next.tabId);
    next.resolve();
  } else if (resumeFocus.userTabId != null) {
    // Nobody waiting — restore the user's tab.
    chrome.tabs.update(resumeFocus.userTabId, { active: true }).catch(() => {});
    resumeFocus.userTabId = null;
  }
}

// ── Resume attachment fallback ──
// When the inline resume viewer never renders (even with foreground focus), the
// content script clicks the "Resume" attachment, which opens the full resume in a
// NEW tab. A content script can't read another tab's DOM, so the background catches
// that tab (by openerTabId), foregrounds it so pdf.js renders, extracts the text via
// chrome.scripting, closes it, and hands the text back to the worker.
const resumeCapture = {
  pending: new Map(), // workerTabId -> { armedAt, priorActiveTabId }
  results: new Map(), // workerTabId -> { done, text }
};

// Injected into the resume tab (all frames). Prefers pdf.js text-layer spans, else
// a shadow-piercing text walk. Self-contained — runs in the page's isolated world.
function _extractResumeTextInPage() {
  try {
    var spans = document.querySelectorAll('.textLayer span, [class*="textLayer"] span');
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
  const info = resumeCapture.pending.get(workerTabId) || {};
  let text = "";
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
    // Foreground so pdf.js renders, then give it time to paint the text layer.
    await chrome.tabs.update(resumeTabId, { active: true }).catch(() => {});
    const rt = await chrome.tabs.get(resumeTabId).catch(() => null);
    if (rt) await chrome.windows.update(rt.windowId, { focused: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 6000));
    let results = [];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: resumeTabId, allFrames: true },
        func: _extractResumeTextInPage,
      });
    } catch (_) {}
    for (const r of results || []) { if (r && r.result && r.result.length > text.length) text = r.result; }
  } catch (_) {}
  try { await chrome.tabs.remove(resumeTabId); } catch (_) {}
  if (info.priorActiveTabId != null) chrome.tabs.update(info.priorActiveTabId, { active: true }).catch(() => {});
  resumeCapture.results.set(workerTabId, { done: true, text: text });
  resumeCapture.pending.delete(workerTabId);
}

chrome.tabs.onCreated.addListener((tab) => {
  const opener = tab.openerTabId;
  if (opener == null) return;
  if (resumeCapture.pending.has(opener)) {
    captureResumeFromTab(opener, tab.id);
    return;
  }
  // Any other tab a parallel worker opens (e.g. a resume-tab click that hit the
  // attachment link) is a side effect nobody will look at — close it, or recruiters
  // are left with a pile of "latest-resume" tabs. Only worker tabs: never a tab
  // opened from the recruiter's own tabs. Via withQueue so it holds after an SW restart.
  withQueue((ctx) => { if (leaseOf(ctx.q, opener)) closeTab(tab.id); });
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
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const prior = tabs && tabs[0] ? tabs[0].id : null;
      resumeCapture.pending.set(tabId, { armedAt: Date.now(), priorActiveTabId: prior });
      resumeCapture.results.delete(tabId);
      // Expire a stale arm if the expected tab never opened.
      setTimeout(() => {
        const p = resumeCapture.pending.get(tabId);
        if (p && Date.now() - p.armedAt >= 14000) resumeCapture.pending.delete(tabId);
      }, 15000);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "srGetResumeCapture") {
    const tabId = sender.tab && sender.tab.id;
    const res = tabId != null ? resumeCapture.results.get(tabId) : null;
    if (res && res.done) { resumeCapture.results.delete(tabId); sendResponse({ done: true, text: res.text }); }
    else sendResponse({ done: false });
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
    startQueue(feature, message).then(({ queued, workers }) =>
      sendResponse({ ok: true, queued, workers, feature }));
    return true;
  }

  if (message.type === "srWorkerDone") {
    handleWorkerDone(sender.tab && sender.tab.id, message).then(sendResponse);
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
    handleWorkerCheckIn(sender.tab && sender.tab.id).then(sendResponse);
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
    if (l.item.started) {
      // Closed mid-profile — report it, don't retry (the recruiter may have closed it on purpose).
      release(ctx.q, l.url, "failed", { result: { url: l.url, error: "tab_closed" } });
    } else {
      // Closed between profiles — nothing was processed, so the URL goes back in the queue.
      release(ctx.q, l.url, "pending", { attempts: l.item.attempts - 1 });
    }
    if (!finishIfDrained(ctx)) scheduleFill(ctx.q);
  });
});
