'use strict';
// background-harness.js — runs the REAL background.js inside a simulated browser so
// the parallel-queue orchestration can be tested without Chrome.
//
// What it models (only as much as background.js needs):
//   - chrome.storage.local / .session — shared browser state, survives SW restarts
//   - chrome.tabs / windows / notifications / scripting / alarms
//   - a fake clock: every setTimeout / alarm / page delay runs on simulated time
//   - MV3 service-worker lifecycle: killSW() drops all in-memory state and pending
//     timers; the next event (message, tab removal, alarm) boots a fresh instance by
//     re-running background.js, exactly like Chrome waking a stopped worker
//   - worker tabs: each navigation runs an optional `pageScript` after a load delay;
//     a page's pending sleeps die when the tab navigates away or closes
//
// Math.random is seeded so jitter() — and therefore every test — is deterministic.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BG_PATH = path.join(__dirname, '..', '..', 'background.js');
const BG_SRC = fs.readFileSync(BG_PATH, 'utf8');

function createBrowser(opts = {}) {
  const clock = { now: 1_750_000_000_000 };
  const store = { local: { ...(opts.initialLocal || {}) }, session: {} };
  const tabs = new Map();          // id -> { id, url, active, windowId, status, navSeq, openerTabId }
  const alarms = new Map();        // name -> { name, scheduledTime, periodInMinutes, seq }
  const timers = [];               // { id, at, owner, fn }
  const notifications = [];
  const pageLog = [];              // { tabId, url, what, at } recorded by page scripts
  const events = [];               // trace, handy when a test fails
  let nextTabId = 100;
  // Windows: 1 is the recruiter's. A page is visible only when its tab is active and
  // its window is focused — the worst case, where any other window covers it.
  let nextWindowId = 2;
  const windowIds = new Set([1]);
  let focusedWindowId = 1;
  let timerSeq = 0;
  let alarmSeq = 0;
  let swGen = 0;
  let sw = null;                   // live service-worker instance, or null when stopped
  const pageLoadMs = opts.pageLoadMs ?? 1000;
  const seed = opts.seed ?? 42;
  const pageScript = opts.pageScript || null;

  // ── timers ────────────────────────────────────────────────────────────────
  function addTimer(owner, ms, fn) {
    const id = ++timerSeq;
    timers.push({ id, at: clock.now + Math.max(0, Number(ms) || 0), owner, fn });
    return id;
  }
  function removeTimer(id) {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  }
  function ownerAlive(owner) {
    switch (owner.kind) {
      case 'sw': return !!sw && sw.gen === owner.gen;
      case 'page': { const t = tabs.get(owner.tabId); return !!t && t.navSeq === owner.navSeq; }
      case 'alarm': { const a = alarms.get(owner.name); return !!a && a.seq === owner.seq; }
      default: return true; // 'browser'
    }
  }
  const BROWSER = { kind: 'browser' };

  async function flush() {
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const pubTab = (t) => ({
    id: t.id, url: t.url, active: t.active, windowId: t.windowId,
    status: t.status, openerTabId: t.openerTabId,
  });

  function makeEvent(arr) {
    return {
      addListener: (f) => { arr.push(f); },
      removeListener: (f) => { const i = arr.indexOf(f); if (i >= 0) arr.splice(i, 1); },
      hasListener: (f) => arr.includes(f),
    };
  }

  // Deliver a browser event to the service worker, waking it if it's stopped.
  function fireSW(name, args) {
    const inst = ensureSW();
    for (const l of inst.listeners[name].slice()) {
      try { l(...args); } catch (e) { events.push(['listener-error', name, String(e)]); }
    }
  }

  // Logged out of SmartRecruiters: every SR page redirects to the sign-in page, and
  // after login() each tab is sent back to where it was going (as SR does).
  let loggedOut = false;
  const isSR = (u) => /^https?:\/\/[^/]*smartrecruiters\.com\//.test(u || '');

  // DataDome block: while on, every SR page load shows the challenge (t.botCheck) until
  // the recruiter solves it in one tab; that tab then reloads, as DataDome does.
  let botBlocked = false;

  function navigate(t, url) {
    if (loggedOut && isSR(url) && url !== SIGN_IN_URL) { t.returnTo = url; url = SIGN_IN_URL; }
    t.botCheck = botBlocked && isSR(url);
    t.url = url;
    t.navSeq++;
    t.status = 'loading';
    events.push(['nav', t.id, url, clock.now]);
    addTimer(BROWSER, 0, () => { if (tabs.get(t.id) === t && t.url === url) fireSW('tabUpdated', [t.id, { url, status: 'loading' }, pubTab(t)]); });
    const owner = { kind: 'page', tabId: t.id, navSeq: t.navSeq };
    addTimer(owner, pageLoadMs, () => {
      t.status = 'complete';
      if (pageScript) {
        Promise.resolve(pageScript(makePage(t, owner, url))).catch((e) =>
          events.push(['page-error', t.id, String(e)]));
      }
    });
  }

  function makePage(t, owner, url) {
    return {
      tabId: t.id,
      url,
      sendMessage: (message) => sendToSW(message, { tab: { id: t.id, url } }),
      botCheck: () => !!t.botCheck,
      visible: () => t.active && t.windowId === focusedWindowId,
      // Resolves only if the page is still alive; a navigated-away page just stops.
      sleep: (ms) => new Promise((r) => addTimer(owner, ms, r)),
      record: (what) => pageLog.push({ tabId: t.id, url, what, at: clock.now }),
      // A link click that opens a new tab (e.g. the resume attachment): Chrome sets openerTabId.
      openTab: (tabUrl) => openTabFrom(t.id, tabUrl),
    };
  }

  // A tab opened by page content, not by the extension (fires tabs.onCreated).
  function openTabFrom(openerTabId, tabUrl) {
    const opener = tabs.get(openerTabId);
    const windowId = opener ? opener.windowId : 1;
    for (const o of tabs.values()) if (o.windowId === windowId) o.active = false;
    const t = { id: nextTabId++, url: 'about:blank', active: true, windowId, status: 'loading', navSeq: 0, openerTabId };
    tabs.set(t.id, t);
    events.push(['tab-open', t.id, tabUrl, openerTabId, clock.now]);
    navigate(t, tabUrl);
    addTimer(BROWSER, 0, () => fireSW('tabCreated', [pubTab(t)]));
    return t.id;
  }

  // ── chrome.* API for one service-worker instance ─────────────────────────
  function makeChrome(owner, listeners) {
    const runtime = {
      lastError: undefined,
      onMessage: makeEvent(listeners.message),
      onInstalled: makeEvent(listeners.installed),
      onStartup: makeEvent(listeners.startup),
      // chrome.runtime.reload(): the extension restarts — a fresh SW, storage.session cleared.
      reload() {
        events.push(['ext-reload', clock.now]);
        addTimer(BROWSER, 0, () => { killSW(); store.session = {}; ensureSW(); });
      },
    };
    // Chrome: callback given -> returns undefined and reports errors via lastError.
    function withCb(promise, cb) {
      if (typeof cb !== 'function') return promise;
      promise.then(
        (v) => cb(v),
        (err) => {
          runtime.lastError = { message: String((err && err.message) || err) };
          try { cb(undefined); } finally { runtime.lastError = undefined; }
        });
      return undefined;
    }

    function area(name) {
      const a = {
        get(keys, cb) {
          const d = store[name];
          const out = {};
          if (keys == null) Object.assign(out, clone(d));
          else if (typeof keys === 'string') { if (keys in d) out[keys] = clone(d[keys]); }
          else if (Array.isArray(keys)) { for (const k of keys) if (k in d) out[k] = clone(d[k]); }
          else for (const [k, def] of Object.entries(keys)) out[k] = k in d ? clone(d[k]) : def;
          return withCb(Promise.resolve(out), cb);
        },
        set(obj, cb) {
          for (const [k, v] of Object.entries(obj)) store[name][k] = clone(v);
          return withCb(Promise.resolve(), cb);
        },
        remove(keys, cb) {
          for (const k of [].concat(keys)) delete store[name][k];
          return withCb(Promise.resolve(), cb);
        },
      };
      if (name === 'session') a.setAccessLevel = () => Promise.resolve();
      return a;
    }

    const noTab = (id) => Promise.reject(new Error('No tab with id: ' + id + '.'));

    return {
      runtime,
      storage: { local: area('local'), session: area('session') },
      tabs: {
        create(props, cb) {
          const windowId = props.windowId ?? 1;
          if (!windowIds.has(windowId)) return withCb(Promise.reject(new Error('No window with id: ' + windowId + '.')), cb);
          const t = {
            id: nextTabId++, url: 'about:blank', active: !!props.active, windowId,
            status: 'loading', navSeq: 0, openerTabId: props.openerTabId,
          };
          tabs.set(t.id, t);
          events.push(['tab-create', t.id, props.url, clock.now]);
          if (props.url) navigate(t, props.url);
          addTimer(BROWSER, 0, () => fireSW('tabCreated', [pubTab(t)]));
          return withCb(Promise.resolve(pubTab(t)), cb);
        },
        update(id, props, cb) {
          const t = tabs.get(id);
          if (!t) return withCb(noTab(id), cb);
          if (props.url) navigate(t, props.url);
          if ('active' in props) {
            if (props.active) {
              for (const o of tabs.values()) if (o.windowId === t.windowId) o.active = false;
              events.push(['tab-activate', id, t.windowId, clock.now]);
            }
            t.active = !!props.active;
          }
          return withCb(Promise.resolve(pubTab(t)), cb);
        },
        remove(ids, cb) {
          for (const id of [].concat(ids)) {
            if (!tabs.has(id)) return withCb(noTab(id), cb);
            tabs.delete(id);
            events.push(['tab-remove', id, clock.now]);
            addTimer(BROWSER, 0, () => fireSW('tabRemoved', [id, { isWindowClosing: false }]));
          }
          return withCb(Promise.resolve(), cb);
        },
        get(id, cb) {
          const t = tabs.get(id);
          return withCb(t ? Promise.resolve(pubTab(t)) : noTab(id), cb);
        },
        query(q, cb) {
          let list = [...tabs.values()];
          if (q && q.active) list = list.filter((t) => t.active);
          if (q && q.windowId != null) list = list.filter((t) => t.windowId === q.windowId);
          return withCb(Promise.resolve(list.map(pubTab)), cb);
        },
        reload(id) {
          const t = tabs.get(id);
          if (!t) return noTab(id);
          events.push(['tab-reload', id, clock.now]);
          navigate(t, t.url);
          return Promise.resolve();
        },
        onCreated: makeEvent(listeners.tabCreated),
        onRemoved: makeEvent(listeners.tabRemoved),
        onUpdated: makeEvent(listeners.tabUpdated),
      },
      windows: {
        create(props = {}) {
          const id = nextWindowId++;
          windowIds.add(id);
          events.push(['window-create', id, !!props.focused, clock.now]);
          if (props.focused) focusedWindowId = id;
          const t = { id: nextTabId++, url: 'about:blank', active: true, windowId: id, status: 'loading', navSeq: 0 };
          tabs.set(t.id, t);
          events.push(['tab-create', t.id, props.url, clock.now]);
          if (props.url) navigate(t, props.url);
          addTimer(BROWSER, 0, () => fireSW('tabCreated', [pubTab(t)]));
          return Promise.resolve({ id, focused: !!props.focused, tabs: [pubTab(t)] });
        },
        update(id, props = {}) {
          if (!windowIds.has(id)) return Promise.reject(new Error('No window with id: ' + id + '.'));
          if (props.focused) { focusedWindowId = id; events.push(['window-focus', id, clock.now]); }
          return Promise.resolve({ id, focused: focusedWindowId === id });
        },
        getLastFocused() { return Promise.resolve({ id: focusedWindowId, focused: true }); },
      },
      commands: { onCommand: makeEvent(listeners.command) },
      notifications: {
        create(id, options) { notifications.push({ id, ...clone(options), at: clock.now }); },
      },
      scripting: {
        executeScript(inj) {
          events.push(['exec', inj.target.tabId, clock.now]);
          // MAIN-world injections run against the page's own globals (opts.mainWorld(target)).
          if (inj.world === 'MAIN') {
            const win = (opts.mainWorld && opts.mainWorld(inj.target)) || {};
            return Promise.resolve([{ result: vm.runInNewContext('(' + inj.func + ')()', { window: win }) }]);
          }
          // The background's bot-check probe gets the tab's challenge state.
          if (inj.func && inj.func.name === 'botCheckShownInPage') {
            const t = tabs.get(inj.target.tabId);
            return t ? Promise.resolve([{ result: !!t.botCheck }]) : noTab(inj.target.tabId);
          }
          if (inj.func && /visibilityState/.test(String(inj.func))) {
            const t = tabs.get(inj.target.tabId);
            return t ? Promise.resolve([{ result: t.active && t.windowId === focusedWindowId }]) : noTab(inj.target.tabId);
          }
          return Promise.resolve([]);
        },
      },
      alarms: {
        create(name, info = {}) {
          const period = info.periodInMinutes;
          const delay = info.delayInMinutes ?? period ?? 0;
          scheduleAlarm({ name, periodInMinutes: period, scheduledTime: info.when ?? clock.now + delay * 60000 });
          return Promise.resolve();
        },
        clear(name, cb) { const had = alarms.delete(name); return withCb(Promise.resolve(had), cb); },
        get(name, cb) { const a = alarms.get(name); return withCb(Promise.resolve(a && { ...a }), cb); },
        onAlarm: makeEvent(listeners.alarm),
      },
    };
  }

  function scheduleAlarm(a) {
    a.seq = ++alarmSeq;
    alarms.set(a.name, a);
    addTimer({ kind: 'alarm', name: a.name, seq: a.seq }, a.scheduledTime - clock.now, () => {
      if (a.periodInMinutes) scheduleAlarm({ ...a, scheduledTime: clock.now + a.periodInMinutes * 60000 });
      else alarms.delete(a.name);
      fireSW('alarm', [{ name: a.name, scheduledTime: a.scheduledTime }]);
    });
  }

  // ── service-worker lifecycle ──────────────────────────────────────────────
  function bootSW() {
    const gen = ++swGen;
    const owner = { kind: 'sw', gen };
    const listeners = {
      message: [], installed: [], startup: [],
      tabCreated: [], tabRemoved: [], tabUpdated: [], alarm: [], command: [],
    };
    const chrome = makeChrome(owner, listeners);
    const ctx = vm.createContext({
      chrome,
      console: opts.quiet === false ? console : { log() {}, warn() {}, error() {}, info() {}, debug() {} },
      setTimeout: (fn, ms) => addTimer(owner, ms, fn),
      clearTimeout: (id) => removeTimer(id),
      setInterval: () => { throw new Error('setInterval not modelled'); },
      __clockNow: () => clock.now,
    });
    // Service-worker importScripts: run the file in the same global scope, as Chrome does.
    ctx.importScripts = (...files) => {
      for (const f of files) {
        const p = path.join(path.dirname(BG_PATH), f);
        vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: p });
      }
    };
    vm.runInContext(
      'Date.now = () => __clockNow();' +
      '(function(){ var s = ' + (seed + gen) + ';' +
      ' Math.random = function(){ s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();',
      ctx);
    sw = { gen, listeners, chrome, ctx, pending: new Set() };
    events.push(['sw-boot', gen, clock.now]);
    vm.runInContext(BG_SRC, ctx, { filename: BG_PATH });
    return sw;
  }
  function ensureSW() { return sw || bootSW(); }
  function killSW() {
    if (!sw) return;
    events.push(['sw-kill', sw.gen, clock.now]);
    // Callers waiting on a response from the dead worker get nothing back.
    for (const respond of [...sw.pending]) respond(null);
    sw = null;
  }

  // Deliver runtime.sendMessage to the SW; resolves with its sendResponse value.
  function sendToSW(message, sender) {
    const inst = ensureSW();
    return new Promise((resolve) => {
      let done = false;
      const respond = (v) => {
        if (done) return;
        done = true;
        inst.pending.delete(respond);
        resolve(clone(v));
      };
      let keepOpen = false;
      for (const l of inst.listeners.message.slice()) {
        try { if (l(clone(message), sender, respond) === true) keepOpen = true; }
        catch (e) { events.push(['listener-error', 'message', String(e)]); }
      }
      if (!done) {
        if (keepOpen) inst.pending.add(respond);
        else respond(undefined);
      }
    });
  }

  // ── time control ──────────────────────────────────────────────────────────
  async function advance(ms) {
    const target = clock.now + ms;
    await flush();
    for (let guard = 0; guard < 1_000_000; guard++) {
      let next = null;
      for (const t of timers) {
        if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      }
      if (!next) break;
      removeTimer(next.id);
      if (!ownerAlive(next.owner)) continue;
      clock.now = Math.max(clock.now, next.at);
      try { next.fn(); } catch (e) { events.push(['timer-error', String(e)]); }
      await flush();
    }
    clock.now = target;
  }

  // Advance in steps until predicate() is true. Returns true if it became true.
  async function runUntil(predicate, maxMs, stepMs = 500) {
    const deadline = clock.now + maxMs;
    while (clock.now < deadline) {
      if (predicate()) return true;
      await advance(Math.min(stepMs, deadline - clock.now));
    }
    return !!predicate();
  }

  ensureSW(); // extension installed / browser started

  return {
    clock, store, tabs, notifications, pageLog, events,
    advance, runUntil, killSW, bootSW,
    get swAlive() { return !!sw; },
    sendFromPopup: (message) => sendToSW(message, {}),
    // A keyboard shortcut from manifest "commands" (fires commands.onCommand).
    fireCommand: (name) => fireSW('command', [name]),
    // The recruiter closing a tab by hand (fires tabs.onRemoved, waking the SW if needed).
    // In-page route change (pushState): the URL changes but the page — and its content
    // script — keeps running.
    spaNavigate(id, url) {
      const t = tabs.get(id);
      t.url = url;
      events.push(['spa-nav', id, url, clock.now]);
      addTimer(BROWSER, 0, () => fireSW('tabUpdated', [id, { url }, pubTab(t)]));
    },
    logout() {
      loggedOut = true;
      for (const t of tabs.values()) if (isSR(t.url) && t.url !== SIGN_IN_URL) navigate(t, t.url);
    },
    login() {
      loggedOut = false;
      for (const t of tabs.values()) if (t.url === SIGN_IN_URL && t.returnTo) navigate(t, t.returnTo);
    },
    blockBots() { botBlocked = true; },
    // DataDome's overlay over an already-loaded page (a blocked XHR mid-profile).
    showBotCheck(id) { tabs.get(id).botCheck = true; },
    // The recruiter solves the challenge in tab `id`: the block lifts and that tab reloads.
    // reload: false models a challenge that clears without a reload.
    solveBotCheck(id, { reload = true } = {}) {
      botBlocked = false;
      const t = tabs.get(id);
      t.botCheck = false;
      if (reload) navigate(t, t.url);
    },
    // The recruiter's own tab in their window (1), active and focused, e.g. the job list.
    openUserTab(url) {
      for (const o of tabs.values()) if (o.windowId === 1) o.active = false;
      const t = { id: nextTabId++, url, active: true, windowId: 1, status: 'complete', navSeq: 0 };
      tabs.set(t.id, t);
      focusedWindowId = 1;
      return t.id;
    },
    userFocusWindow(id) { focusedWindowId = id; },
    get focusedWindowId() { return focusedWindowId; },
    userCloseTab(id) {
      if (!tabs.delete(id)) return false;
      events.push(['tab-remove', id, clock.now, 'user']);
      addTimer(BROWSER, 0, () => fireSW('tabRemoved', [id, { isWindowClosing: false }]));
      return true;
    },
    sendFromTab: (tabId, message, frameId = 0) => sendToSW(message, { tab: { id: tabId, url: tabs.get(tabId)?.url }, frameId }),
    openTabFrom,
  };
}

// A parallel-worker content script, reduced to its contract with background.js (see
// runAsParallelWorker in keyword-/salary-triage-autorun.js): ask srIsParallelWorker,
// claim the tab only if the feature matches, do the work, report srWorkerDone.
//
// behaviour(url, visit) — visit counts 1, 2, ... per URL — returns 'hang' or
//   { workMs, report: { ...srWorkerDone fields }, pingEveryMs? }
// focus: true holds srRequestResumeFocus for the first half of the work.
// pingEveryMs sends srGetResumeCapture while working, like a worker waiting on a
// slow resume capture.
// opensTab: 'stray' opens a resume tab without arming a capture (like a stray click on
//   the attachment link); 'fallback' arms srArmResumeCapture first, as the real
//   attachment fallback does. Either way the tab opens halfway through the work.
//   'fallback-no-tab' arms but the click opens nothing (the link wasn't a viewable
//   resume). Each records whether srGetResumeCapture then reports the tab as opened.
const SIGN_IN_URL = 'https://www.smartrecruiters.com/account/sign-in';
const RESUME_TAB_URL = 'https://www.smartrecruiters.com/app/attachments/latest-resume';

function workerPage({ feature = 'keyword', behaviour, reportTwice = false }) {
  const visits = new Map();
  return async (page) => {
    const resp = await page.sendMessage({ type: 'srIsParallelWorker', botCheck: page.botCheck() });
    const mine = resp && resp.active && (resp.feature === feature || (feature === 'keyword' && resp.feature == null));
    if (!mine) { page.record('idle'); return; }
    const visit = (visits.get(page.url) || 0) + 1;
    visits.set(page.url, visit);
    const b = behaviour(page.url, visit);
    if (b === 'hang') { page.record('hang'); return; }
    if (b.focus) {
      // Resume render in a hidden tab: hold the focus lock for part of the work.
      await page.sendMessage({ type: 'srRequestResumeFocus' });
      page.record('focus-' + (page.visible() ? 'visible' : 'hidden'));
      await page.sleep(b.workMs / 2);
      await page.sendMessage({ type: 'srReleaseResumeFocus' });
      b.workMs = b.workMs / 2;
    }
    if (b.opensTab) {
      await page.sleep(b.workMs / 2);
      if (b.opensTab !== 'stray') await page.sendMessage({ type: 'srArmResumeCapture' });
      if (b.opensTab !== 'fallback-no-tab') page.openTab(RESUME_TAB_URL);
      await page.sleep(1000);
      const poll = await page.sendMessage({ type: 'srGetResumeCapture' });
      page.record(poll && poll.opened ? 'capture-opened' : 'capture-not-opened');
      b.workMs = b.workMs / 2;
    }
    if (b.pingEveryMs) {
      for (let t = 0; t < b.workMs; t += b.pingEveryMs) {
        await page.sleep(Math.min(b.pingEveryMs, b.workMs - t));
        page.sendMessage({ type: 'srGetResumeCapture' });
      }
    } else {
      await page.sleep(b.workMs);
    }
    page.record('processed');
    const done = { type: 'srWorkerDone', ...b.report, botCheck: page.botCheck() };
    page.sendMessage(done);
    if (reportTwice) page.sendMessage(done);
  };
}

module.exports = { createBrowser, workerPage, RESUME_TAB_URL, SIGN_IN_URL };
