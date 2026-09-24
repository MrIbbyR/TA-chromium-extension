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

  function navigate(t, url) {
    t.url = url;
    t.navSeq++;
    t.status = 'loading';
    events.push(['nav', t.id, url, clock.now]);
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
      // Resolves only if the page is still alive; a navigated-away page just stops.
      sleep: (ms) => new Promise((r) => addTimer(owner, ms, r)),
      record: (what) => pageLog.push({ tabId: t.id, url, what, at: clock.now }),
      // A link click that opens a new tab (e.g. the resume attachment): Chrome sets openerTabId.
      openTab: (tabUrl) => openTabFrom(t.id, tabUrl),
    };
  }

  // A tab opened by page content, not by the extension (fires tabs.onCreated).
  function openTabFrom(openerTabId, tabUrl) {
    const t = { id: nextTabId++, url: 'about:blank', active: true, windowId: 1, status: 'loading', navSeq: 0, openerTabId };
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
          const t = {
            id: nextTabId++, url: 'about:blank', active: !!props.active, windowId: 1,
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
          if ('active' in props) t.active = !!props.active;
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
          return withCb(Promise.resolve(list.map(pubTab)), cb);
        },
        onCreated: makeEvent(listeners.tabCreated),
        onRemoved: makeEvent(listeners.tabRemoved),
        onUpdated: makeEvent(listeners.tabUpdated),
      },
      windows: { update: () => Promise.resolve({}) },
      notifications: {
        create(id, options) { notifications.push({ id, ...clone(options), at: clock.now }); },
      },
      scripting: {
        executeScript(inj) { events.push(['exec', inj.target.tabId, clock.now]); return Promise.resolve([]); },
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
      tabCreated: [], tabRemoved: [], tabUpdated: [], alarm: [],
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
    // The recruiter closing a tab by hand (fires tabs.onRemoved, waking the SW if needed).
    userCloseTab(id) {
      if (!tabs.delete(id)) return false;
      events.push(['tab-remove', id, clock.now, 'user']);
      addTimer(BROWSER, 0, () => fireSW('tabRemoved', [id, { isWindowClosing: false }]));
      return true;
    },
    sendFromTab: (tabId, message) => sendToSW(message, { tab: { id: tabId, url: tabs.get(tabId)?.url } }),
    openTabFrom,
  };
}

// A parallel-worker content script, reduced to its contract with background.js (see
// runAsParallelWorker in keyword-/salary-triage-autorun.js): ask srIsParallelWorker,
// claim the tab only if the feature matches, do the work, report srWorkerDone.
//
// behaviour(url, visit) — visit counts 1, 2, ... per URL — returns 'hang' or
//   { workMs, report: { ...srWorkerDone fields }, pingEveryMs? }
// pingEveryMs sends srGetResumeCapture while working, like a worker waiting on a
// slow resume capture.
// opensTab: 'stray' opens a resume tab without arming a capture (like a stray click on
//   the attachment link); 'fallback' arms srArmResumeCapture first, as the real
//   attachment fallback does. Either way the tab opens halfway through the work.
const RESUME_TAB_URL = 'https://www.smartrecruiters.com/app/attachments/latest-resume';

function workerPage({ feature = 'keyword', behaviour, reportTwice = false }) {
  const visits = new Map();
  return async (page) => {
    const resp = await page.sendMessage({ type: 'srIsParallelWorker' });
    const mine = resp && resp.active && (resp.feature === feature || (feature === 'keyword' && resp.feature == null));
    if (!mine) { page.record('idle'); return; }
    const visit = (visits.get(page.url) || 0) + 1;
    visits.set(page.url, visit);
    const b = behaviour(page.url, visit);
    if (b === 'hang') { page.record('hang'); return; }
    if (b.opensTab) {
      await page.sleep(b.workMs / 2);
      if (b.opensTab === 'fallback') await page.sendMessage({ type: 'srArmResumeCapture' });
      page.openTab(RESUME_TAB_URL);
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
    const done = { type: 'srWorkerDone', ...b.report };
    page.sendMessage(done);
    if (reportTwice) page.sendMessage(done);
  };
}

module.exports = { createBrowser, workerPage, RESUME_TAB_URL };
