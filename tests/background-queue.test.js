'use strict';
// Parallel queue orchestration in background.js, run against a simulated browser
// (tests/helpers/background-harness.js) with MV3 service-worker restarts, hung tabs,
// closed tabs and duplicate messages. The core invariants a finished run must satisfy:
//   - every queued URL is processed and reported exactly once, under its own URL
//   - the run always terminates (done notification + last-run saved)
//   - no worker tabs are left open afterwards
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBrowser, workerPage, RESUME_TAB_URL, SIGN_IN_URL } = require('./helpers/background-harness');

const SEC = 1000;
const MIN = 60 * SEC;

const url = (n) => `https://jobs.smartrecruiters.com/app/people/profile/c${n}`;
const idOf = (u) => Number(/\/c(\d+)$/.exec(u)?.[1]);
// Each profile's "hit count" is its id, so a result reported under the wrong URL is detectable.
const kwReport = (u) => ({ hitCount: idOf(u), matchedKeywords: [], notesPosted: true });
const normal = (workMs) => (u) => ({ workMs, report: kwReport(u) });

// profilesPerMinute: the queue mechanics tests run at the fastest allowed pace so pacing
// doesn't change which tab gets which URL; the pace-limit tests pass null (the default).
function setup({ n, workers = 2, feature = 'keyword', behaviour = normal(5 * SEC), reportTwice = false, initialLocal, pageLoadMs, silentOn, profilesPerMinute = 30 }) {
  // Both autoruns run on every profile page, as in the real extension; each must claim
  // only its own feature's worker tabs.
  const kw = workerPage({ feature: 'keyword', behaviour, reportTwice });
  const sal = workerPage({ feature: 'salary', behaviour, reportTwice });
  // silentOn(url): pages where no content script runs (e.g. it failed to inject).
  const browser = createBrowser({ initialLocal, pageLoadMs, pageScript: (p) => (silentOn && silentOn(p.url) ? null : Promise.all([kw(p), sal(p)])) });
  const urls = Array.from({ length: n }, (_, i) => url(i + 1));
  const start = () => browser.sendFromPopup({
    type: feature === 'salary' ? 'srStartParallelSalaryQueue' : 'srStartParallelKeywordQueue',
    urls, workers, config: { keywords: 'python' },
    returnUrl: 'https://jobs.smartrecruiters.com/app/jobs/123',
    ...(profilesPerMinute != null ? { profilesPerMinute } : {}),
  });
  const lastRunKey = feature === 'salary' ? 'salaryTriageLastRun' : 'keywordTriageLastRun';
  const lastRun = () => browser.store.local[lastRunKey];
  const finished = () => !!lastRun();
  const workerTabs = () => [...browser.tabs.values()].filter((t) => /\/profile\/c\d+$/.test(t.url));
  const tabFor = (u) => [...browser.tabs.values()].find((t) => t.url === u);
  const processed = (u) => browser.pageLog.some((p) => p.url === u && p.what === 'processed');
  const visits = (u) => browser.events.filter((e) => e[0] === 'nav' && e[2] === u).length;
  return { browser, urls, start, lastRun, finished, workerTabs, tabFor, processed, visits };
}

// Invariants for a completed run where every URL was processable.
function assertCleanRun(ctx) {
  const { browser, urls, lastRun, workerTabs } = ctx;
  const run = lastRun();
  assert.ok(run, 'run never finished (no last-run saved)');
  const got = run.results.map((r) => r.url);
  assert.deepEqual([...got].sort(), [...urls].sort(),
    'each URL must be reported exactly once, under its own URL');
  for (const r of run.results) {
    assert.equal(r.error, undefined, `unexpected error for ${r.url}: ${r.error}`);
    if ('hitCount' in r) assert.equal(r.hitCount, idOf(r.url), `result for ${r.url} carries another profile's data`);
  }
  assert.equal(workerTabs().length, 0, 'worker tabs left open after the run');
  const done = browser.notifications.filter((n) => /done/i.test(n.title));
  assert.equal(done.length, 1, 'expected exactly one done notification');
}

describe('background parallel queue: happy path', () => {
  it('processes every URL once and cleans up (no faults)', async () => {
    const ctx = setup({ n: 6, workers: 2 });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN); // let tab cleanup settle
    assertCleanRun(ctx);
    assert.match(ctx.browser.notifications.at(-1).message, /out of 6 scanned/);
    assert.equal(ctx.browser.events.filter((e) => e[0] === 'tab-create').length, 2,
      'worker tabs should be reused, not reopened per profile');
  });

  it('Cost Assist: salary workers claim salary runs, results keep only `moved`', async () => {
    const ctx = setup({
      n: 4, workers: 2, feature: 'salary',
      behaviour: (u) => ({ workMs: 3 * SEC, report: { moved: idOf(u) % 2 === 0, salary: 999999 } }),
    });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
    for (const r of ctx.lastRun().results) {
      assert.deepEqual(Object.keys(r).filter((k) => r[k] !== undefined).sort(), ['moved', 'url'],
        'GDPR: salary results must not carry anything beyond url + moved');
      assert.equal(r.moved, idOf(r.url) % 2 === 0);
    }
    assert.match(ctx.browser.notifications.at(-1).message, /2 profiles moved forward out of 4 screened/);
    assert.equal(ctx.browser.store.local.keywordTriageLastRun, undefined);
  });

  it('keeps queue state in chrome.storage.session only, and clears it when done', async () => {
    const ctx = setup({ n: 3 });
    await ctx.start();
    await ctx.browser.advance(3 * SEC);
    assert.ok(ctx.browser.store.session.srParallelQueue, 'queue should be in session storage mid-run');
    assert.deepEqual(Object.keys(ctx.browser.store.local).filter((k) => k.startsWith('srParallelQueue')), []);
    await ctx.browser.runUntil(ctx.finished, 10 * MIN);
    await ctx.browser.advance(1 * MIN);
    assert.equal(ctx.browser.store.session.srParallelQueue, undefined, 'queue must be cleared after the run');
  });

  it('a finished run trims per-profile diagnostics to the newest 20 (GDPR cap)', async () => {
    // Worker tabs closed right after their last profile can die before their own trim.
    const diags = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`lastRunDiag_${1000 + i}`, { timestamp: 1000 + i }]));
    const ctx = setup({ n: 2, initialLocal: { ...diags, keepMe: 1 } });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * SEC);
    const left = Object.keys(ctx.browser.store.local).filter((k) => k.startsWith('lastRunDiag_')).sort();
    assert.equal(left.length, 20);
    assert.equal(left[0], 'lastRunDiag_1005', 'the oldest entries go first');
    assert.equal(ctx.browser.store.local.keepMe, 1, 'other settings are untouched');
  });

  it('removes queue keys left in chrome.storage.local by older versions', async () => {
    const ctx = setup({
      n: 1,
      initialLocal: {
        srParallelQueueUrls: [url(9)], srParallelQueueResults: [{ url: url(8) }],
        srParallelWorkerActive: true, srParallelQueueStartedAt: 1, keepMe: 1,
      },
    });
    await ctx.browser.advance(1 * SEC);
    assert.deepEqual(Object.keys(ctx.browser.store.local), ['keepMe']);
  });
});

describe('background parallel queue: service-worker restarts', () => {
  it('SW restart mid-run keeps track of which URL each tab is working on', async () => {
    // Long work so both workers are mid-profile when Chrome stops the service worker.
    const ctx = setup({ n: 4, workers: 2, behaviour: normal(20 * SEC) });
    await ctx.start();
    await ctx.browser.advance(10 * SEC);
    assert.equal(ctx.workerTabs().length, 2, 'precondition: both workers busy');
    ctx.browser.killSW();

    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });

  it('SW restart with the last URLs in flight does not finish early or drop results', async () => {
    const ctx = setup({ n: 2, workers: 2, behaviour: normal(20 * SEC) });
    await ctx.start();
    await ctx.browser.advance(10 * SEC);
    assert.equal(ctx.workerTabs().length, 2, 'precondition: both workers busy');
    ctx.browser.killSW();

    await ctx.browser.runUntil(ctx.finished, 10 * MIN);
    await ctx.browser.advance(2 * MIN); // give the second worker time to report too
    assertCleanRun(ctx);
  });

  it('SW restart while a tab loads its next profile does not orphan that tab', async () => {
    const ctx = setup({ n: 4, workers: 2 });
    await ctx.start();
    // Stop the SW right after it navigates a worker to URL #3, before the page asks
    // srIsParallelWorker — the woken SW must still recognise the tab as a worker.
    const navigatedTo3 = () => ctx.browser.events.some((e) => e[0] === 'nav' && e[2] === url(3));
    assert.ok(await ctx.browser.runUntil(navigatedTo3, 2 * MIN, 50), 'precondition: tab sent to #3');
    ctx.browser.killSW();

    await ctx.browser.runUntil(ctx.finished, 10 * MIN);
    await ctx.browser.advance(2 * MIN);
    for (const u of ctx.urls) assert.ok(ctx.processed(u), `${u} was never processed`);
    assertCleanRun(ctx);
  });

  it('SW restart between "done" and navigating the tab: the watchdog recovers the URL', async () => {
    // The pending tabs.update timer dies with the SW, so the leased tab never navigates.
    const ctx = setup({ n: 3, workers: 1 });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(() => ctx.processed(url(1)), 2 * MIN, 50));
    await ctx.browser.advance(200); // done handled, navigation still pending
    ctx.browser.killSW();

    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });
});

describe('background parallel queue: hung and slow workers', () => {
  it('a hung worker tab is retried, then reported as failed, and the run still finishes', async () => {
    // #2 never reports back (e.g. stuck on a bot-check or a page that never loads).
    const ctx = setup({
      n: 4, workers: 2,
      behaviour: (u) => (idOf(u) === 2 ? 'hang' : { workMs: 5 * SEC, report: kwReport(u) }),
    });
    await ctx.start();

    assert.ok(await ctx.browser.runUntil(ctx.finished, 15 * MIN), 'run never finished — hung tab stalled it');
    await ctx.browser.advance(1 * MIN);
    const results = ctx.lastRun().results;
    assert.deepEqual(results.map((r) => r.url).sort(), [...ctx.urls].sort());
    assert.equal(results.find((r) => r.url === url(2)).error, 'timeout');
    assert.equal(ctx.visits(url(2)), 2, 'hung URL should get exactly one retry');
    assert.equal(ctx.workerTabs().length, 0, 'hung tab left open');
  });

  it('a URL that hangs once succeeds on its retry', async () => {
    const ctx = setup({
      n: 3, workers: 2,
      behaviour: (u, visit) => (idOf(u) === 1 && visit === 1 ? 'hang' : { workMs: 5 * SEC, report: kwReport(u) }),
    });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 15 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
    assert.equal(ctx.visits(url(1)), 2);
  });

  it('a slow worker that keeps pinging is not timed out', async () => {
    // 5 minutes of work — well past the 180s work timeout — with activity every 20s.
    const ctx = setup({
      n: 2, workers: 1,
      behaviour: (u) => ({ workMs: 5 * MIN, pingEveryMs: 20 * SEC, report: kwReport(u) }),
    });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
    for (const u of ctx.urls) assert.equal(ctx.visits(u), 1, `${u} was retried despite being alive`);
  });

  it('abandons a run older than 2 hours without saving results (GDPR)', async () => {
    const ctx = setup({
      n: 2, workers: 1,
      behaviour: (u) => ({ workMs: 3 * 60 * MIN, pingEveryMs: 20 * SEC, report: kwReport(u) }),
    });
    await ctx.start();
    await ctx.browser.advance(2 * 60 * MIN + 2 * MIN);
    assert.equal(ctx.browser.store.session.srParallelQueue, undefined, 'stale queue should be dropped');
    assert.equal(ctx.lastRun(), undefined);
    assert.equal(ctx.workerTabs().length, 0, 'stale run tabs should be closed');
  });
});

describe('background parallel queue: tabs and messages', () => {
  it('a duplicate srWorkerDone from the same tab is ignored', async () => {
    const ctx = setup({ n: 4, workers: 2, reportTwice: true });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    for (const u of ctx.urls) assert.ok(ctx.processed(u), `${u} reported done but never processed`);
    assertCleanRun(ctx);
  });

  it('srWorkerDone from a tab that is not a worker is ignored', async () => {
    const ctx = setup({ n: 2, workers: 1, behaviour: normal(20 * SEC) });
    await ctx.start();
    await ctx.browser.advance(5 * SEC);
    const resp = await ctx.browser.sendFromTab(999, { type: 'srWorkerDone', hitCount: 7 });
    assert.deepEqual(resp, { next: false });
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN));
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });

  it('recruiter closes a worker tab mid-profile: reported as tab_closed, run continues', async () => {
    const ctx = setup({ n: 4, workers: 2, behaviour: normal(20 * SEC) });
    await ctx.start();
    await ctx.browser.advance(5 * SEC); // #1 checked in and working
    assert.ok(ctx.browser.userCloseTab(ctx.tabFor(url(1)).id));

    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    const results = ctx.lastRun().results;
    assert.deepEqual(results.map((r) => r.url).sort(), [...ctx.urls].sort());
    assert.equal(results.find((r) => r.url === url(1)).error, 'tab_closed');
    for (const u of ctx.urls.slice(1)) assert.ok(ctx.processed(u));
    assert.equal(ctx.workerTabs().length, 0);
  });

  it('done notification counts a closed-tab profile as not scanned', async () => {
    const ctx = setup({ n: 4, workers: 2, behaviour: normal(20 * SEC) });
    await ctx.start();
    await ctx.browser.advance(5 * SEC);
    assert.ok(ctx.browser.userCloseTab(ctx.tabFor(url(1)).id));
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    assert.equal(ctx.browser.notifications.at(-1).message,
      '3 profiles matched out of 3 scanned. 1 could not be scanned (see the popup for why).');
  });

  it('Cost Assist done notification counts a timed-out profile as not screened', async () => {
    const ctx = setup({
      n: 3, workers: 2, feature: 'salary',
      behaviour: (u) => (idOf(u) === 2 ? 'hang' : { workMs: 3 * SEC, report: { moved: true } }),
    });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 15 * MIN), 'run did not finish');
    assert.equal(ctx.browser.notifications.at(-1).message,
      '2 profiles moved forward out of 2 screened. 1 could not be screened (see the popup for why).');
  });

  it('recruiter closes a worker tab between profiles: the next URL is requeued, not lost', async () => {
    const ctx = setup({ n: 3, workers: 1 });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(() => ctx.processed(url(1)), 2 * MIN, 50));
    await ctx.browser.advance(200); // #2 leased to the tab, navigation not yet sent
    assert.ok(ctx.browser.userCloseTab(ctx.tabFor(url(1)).id));

    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });

  it('Stop ends the run: partial results saved, tabs closed, nothing new launched', async () => {
    const ctx = setup({ n: 6, workers: 2, behaviour: normal(10 * SEC) });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(() => ctx.processed(url(1)), 2 * MIN, 50));
    await ctx.browser.advance(500);
    await ctx.browser.sendFromPopup({ type: 'srStopParallelKeywordQueue' });
    await ctx.browser.advance(5 * MIN);

    const results = ctx.lastRun().results;
    assert.ok(results.length >= 1 && results.length < 6, `expected partial results, got ${results.length}`);
    for (const r of results) assert.ok(ctx.processed(r.url), `${r.url} saved but never processed`);
    assert.equal(ctx.workerTabs().length, 0, 'worker tabs left open after Stop');
    assert.ok(ctx.browser.notifications.some((n) => /stopped/i.test(n.title)));
    assert.equal(ctx.browser.store.session.srParallelQueue, undefined);
    const createdAfterStop = ctx.browser.events.filter((e) => e[0] === 'tab-create').length;
    await ctx.browser.advance(5 * MIN);
    assert.equal(ctx.browser.events.filter((e) => e[0] === 'tab-create').length, createdAfterStop);
  });

  it('starting a new run replaces the old one and closes its tabs', async () => {
    const ctx = setup({ n: 4, workers: 2, behaviour: normal(20 * SEC) });
    await ctx.start();
    await ctx.browser.advance(8 * SEC);
    const oldTabs = ctx.workerTabs().map((t) => t.id);
    assert.equal(oldTabs.length, 2);
    await ctx.start(); // same URLs, fresh run
    await ctx.browser.advance(1 * SEC);
    for (const id of oldTabs) assert.ok(!ctx.browser.tabs.has(id), 'old run tab still open');
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN));
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });
});

// A worker tab can open the resume attachment in a new tab. The armed fallback captures
// and closes it; anything else a worker opens must be closed too, or recruiters are left
// with a pile of "latest-resume" tabs after every run (seen live, v2.4.0).
describe('background parallel queue: tabs opened by worker tabs', () => {
  const resumeTabs = (ctx) => [...ctx.browser.tabs.values()].filter((t) => t.url === RESUME_TAB_URL);
  const opensTab = (kind, which) => (u) =>
    ({ workMs: 20 * SEC, report: kwReport(u), ...(which(u) ? { opensTab: kind } : {}) });

  it('a stray resume tab opened by a worker (no capture armed) is closed', async () => {
    const ctx = setup({ n: 4, workers: 2, behaviour: opensTab('stray', (u) => idOf(u) % 2 === 1) });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assert.equal(ctx.browser.events.filter((e) => e[0] === 'tab-open').length, 2, 'setup: expected 2 stray tabs');
    assert.equal(resumeTabs(ctx).length, 0, 'stray resume tabs left open');
    assert.ok(!ctx.browser.events.some((e) => e[0] === 'exec'), 'stray tabs should be closed, not read');
    assertCleanRun(ctx);
  });

  it('a stray tab is still closed right after a service-worker restart', async () => {
    const ctx = setup({ n: 2, workers: 1, behaviour: opensTab('stray', (u) => idOf(u) === 1) });
    await ctx.start();
    await ctx.browser.advance(5 * SEC); // #1 checked in and working
    ctx.browser.killSW();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assert.equal(resumeTabs(ctx).length, 0, 'stray resume tab left open after SW restart');
    assertCleanRun(ctx);
  });

  it('the armed attachment fallback still captures and closes its tab', async () => {
    const ctx = setup({ n: 2, workers: 1, behaviour: opensTab('fallback', () => true) });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    const opened = ctx.browser.events.filter((e) => e[0] === 'tab-open').map((e) => e[1]);
    assert.equal(opened.length, 2);
    for (const id of opened) {
      assert.ok(ctx.browser.events.some((e) => e[0] === 'exec' && e[1] === id), `resume tab ${id} was closed without being read`);
    }
    assert.equal(resumeTabs(ctx).length, 0, 'fallback resume tab left open');
    assertCleanRun(ctx);
  });

  it("never closes a tab the recruiter opens from their own tab during a run", async () => {
    const ctx = setup({ n: 3, workers: 2, behaviour: normal(20 * SEC) });
    const own = ctx.browser.openTabFrom(undefined, 'https://www.smartrecruiters.com/app/jobs/123');
    await ctx.start();
    await ctx.browser.advance(5 * SEC);
    const child = ctx.browser.openTabFrom(own, RESUME_TAB_URL);
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assert.ok(ctx.browser.tabs.has(own), "recruiter's own tab was closed");
    assert.ok(ctx.browser.tabs.has(child), "tab the recruiter opened was closed");
  });
});

// Circuit breaker: 3 profiles in a row failing for the same reason means something is
// wrong with SmartRecruiters (logged out, bot check, notes UI changed) — stop instead of
// burning through the list. A recruiter-closed tab neither counts nor resets the streak.
describe('background parallel queue: circuit breaker', () => {
  const fail = (report) => ({ workMs: 5 * SEC, report });
  const CONTROLS = { hitCount: 0, matchedKeywords: [], notesPosted: false, error: 'controls_timeout' };
  const NOTE_FAIL = { hitCount: 2, matchedKeywords: ['x'], notesPosted: false, notesFailReason: 'Post button missing' };
  const stoppedEarly = (ctx) => ctx.browser.notifications.filter((n) => /stopped early/i.test(n.title));

  it('keeps the error on keyword results (a page that never loaded is not "0 hits")',async () => {
    const ctx = setup({ n: 2, workers: 1, behaviour: (u) => (idOf(u) === 1 ? fail(CONTROLS) : normal(5 * SEC)(u)) });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    assert.equal(ctx.lastRun().results.find((r) => r.url === url(1)).error, 'controls_timeout');
  });

  it('3 pages in a row that never load: the run stops early with the reason',async () => {
    const ctx = setup({ n: 10, workers: 1, behaviour: (u) => (idOf(u) >= 3 ? fail(CONTROLS) : normal(5 * SEC)(u)) });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    const run = ctx.lastRun();
    assert.equal(run.stoppedReason, 'controls_timeout');
    assert.equal(run.total, 10);
    assert.deepEqual(run.results.map((r) => r.url), [url(1), url(2), url(3), url(4), url(5)],
      'should stop right after the 3rd consecutive failure');
    assert.equal(ctx.visits(url(6)), 0, 'no profile should be opened after the breaker trips');
    assert.equal(ctx.workerTabs().length, 0, 'worker tabs left open');
    assert.equal(stoppedEarly(ctx).length, 1, 'expected one "stopped early" notification');
    assert.match(stoppedEarly(ctx)[0].message, /3 profiles in a row/);
    assert.equal(ctx.browser.notifications.filter((n) => /done/i.test(n.title)).length, 0,
      'a tripped run must not also claim to be done');
  });

  it('3 notes in a row that fail to post trip it too',async () => {
    const ctx = setup({ n: 6, workers: 1, behaviour: () => fail(NOTE_FAIL) });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish');
    assert.equal(ctx.lastRun().stoppedReason, 'notes_failed');
    assert.equal(ctx.lastRun().results.length, 3);
  });

  it('3 hung tabs in a row (after their retry) trip it',async () => {
    const ctx = setup({ n: 6, workers: 1, behaviour: () => 'hang' });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 60 * MIN), 'run did not finish');
    assert.equal(ctx.lastRun().stoppedReason, 'timeout');
    assert.equal(ctx.lastRun().results.length, 3);
  });

  it('a success in between resets the streak', async () => {
    // fail fail ok fail fail ok ... never 3 in a row
    const ctx = setup({ n: 8, workers: 1, behaviour: (u) => (idOf(u) % 3 === 0 ? normal(5 * SEC)(u) : fail(CONTROLS)) });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish');
    assert.equal(ctx.lastRun().results.length, 8);
    assert.equal(ctx.lastRun().stoppedReason, undefined);
  });

  it('different reasons in a row do not trip it', async () => {
    const ctx = setup({ n: 6, workers: 1, behaviour: (u) => fail(idOf(u) % 2 ? CONTROLS : NOTE_FAIL) });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish');
    assert.equal(ctx.lastRun().results.length, 6);
    assert.equal(ctx.lastRun().stoppedReason, undefined);
  });

  it('recruiter-closed tabs never trip it', async () => {
    const ctx = setup({ n: 6, workers: 1, behaviour: normal(20 * SEC) });
    await ctx.start();
    for (let i = 1; i <= 3; i++) {
      assert.ok(await ctx.browser.runUntil(() => !!ctx.tabFor(url(i)), 2 * MIN, 50), `#${i} never opened`);
      await ctx.browser.advance(3 * SEC); // loaded + checked in, 20s of work left
      assert.ok(ctx.browser.userCloseTab(ctx.tabFor(url(i)).id));
    }
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish');
    assert.deepEqual(ctx.lastRun().results.map((r) => r.error || 'ok'),
      ['tab_closed', 'tab_closed', 'tab_closed', 'ok', 'ok', 'ok'], 'setup: expected 3 recruiter closes in a row');
    assert.equal(ctx.lastRun().stoppedReason, undefined);
  });

  it('the streak survives a service-worker restart',async () => {
    const ctx = setup({ n: 8, workers: 1, behaviour: (u) => fail(CONTROLS) });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(() => ctx.lastRun() || ctx.processed(url(2)) || ctx.visits(url(3)) > 0, 5 * MIN, 50));
    ctx.browser.killSW();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish');
    assert.equal(ctx.lastRun().stoppedReason, 'controls_timeout');
    assert.equal(ctx.lastRun().results.length, 3);
  });

  it('Cost Assist: 3 pages in a row that never load trip it',async () => {
    const ctx = setup({ n: 6, workers: 1, feature: 'salary', behaviour: () => fail({ moved: false, error: 'controls_timeout' }) });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish');
    assert.equal(ctx.lastRun().stoppedReason, 'controls_timeout');
    assert.equal(ctx.lastRun().results.length, 3);
  });
});

describe('background parallel queue: status for the popup preflight', () => {
  it('srQueueStatus reports whether a run is in progress', async () => {
    const ctx = setup({ n: 2, workers: 1 });
    assert.deepEqual(await ctx.browser.sendFromPopup({ type: 'srQueueStatus' }), { running: false });
    await ctx.start();
    await ctx.browser.advance(2 * SEC);
    assert.deepEqual(await ctx.browser.sendFromPopup({ type: 'srQueueStatus' }), { running: true, feature: 'keyword' });
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN));
    assert.deepEqual(await ctx.browser.sendFromPopup({ type: 'srQueueStatus' }), { running: false });
  });
});

// Logged out of SmartRecruiters mid-run: every worker tab lands on /account/sign-in.
// The run must pause (not fail profiles, not trip the breaker), resume after login, and
// give up with "logged_out" if nobody logs back in within 15 minutes.
describe('background parallel queue: logged out mid-run', () => {
  // On the sign-in page the real autorun can't find profile controls → controls_timeout.
  const srAware = (b) => (u, v) => (u === SIGN_IN_URL
    ? { workMs: 12 * SEC, report: { hitCount: 0, matchedKeywords: [], notesPosted: false, error: 'controls_timeout' } }
    : b(u, v));
  const loggedOutNotes = (ctx) => ctx.browser.notifications.filter((n) => /logged out/i.test(n.title));
  const creates = (ctx) => ctx.browser.events.filter((e) => e[0] === 'tab-create').length;
  const queueItems = (ctx) => Object.values(ctx.browser.store.session.srParallelQueue?.items || {});
  const pausedNow = (ctx) => !!ctx.browser.store.session.srParallelQueue?.pausedSince;

  async function startAndLogOut(n = 8, opts = {}) {
    const ctx = setup({ n, workers: 2, behaviour: srAware(normal(20 * SEC)), ...opts });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(() => ctx.processed(url(2)), 5 * MIN, 50));
    await ctx.browser.advance(3 * SEC);
    ctx.browser.logout();
    return ctx;
  }

  it('pauses instead of failing, then resumes after login and finishes cleanly',async () => {
    const ctx = await startAndLogOut();
    const createsAtLogout = creates(ctx);
    await ctx.browser.advance(5 * MIN);
    assert.equal(ctx.lastRun(), undefined, 'run should be paused, not finished');
    assert.deepEqual(queueItems(ctx).filter((i) => i.state === 'failed'), [], 'no profile may fail while logged out');
    assert.equal(loggedOutNotes(ctx).length, 1, 'expected one "logged out" notification');
    assert.equal(creates(ctx), createsAtLogout, 'no new worker tabs while logged out');

    assert.ok(pausedNow(ctx), 'run should be flagged paused');
    ctx.browser.login();
    await ctx.browser.advance(5 * SEC);
    assert.ok(!pausedNow(ctx), 'login must clear the pause (else no new tabs, and the 15-min give-up still fires)');
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish after login');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });

  it('stays logged out for 15 minutes: stops with "logged_out"',async () => {
    const ctx = await startAndLogOut();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run never gave up');
    await ctx.browser.advance(1 * MIN);
    assert.equal(ctx.lastRun().stoppedReason, 'logged_out');
    assert.ok(ctx.browser.notifications.some((n) => /stopped early/i.test(n.title)));
    assert.equal(ctx.workerTabs().length + [...ctx.browser.tabs.values()].filter((t) => t.url === SIGN_IN_URL).length, 0,
      'worker tabs left open');
  });

  it('the pause survives a service-worker restart',async () => {
    const ctx = await startAndLogOut();
    await ctx.browser.advance(1 * MIN);
    ctx.browser.killSW();
    await ctx.browser.advance(3 * MIN);
    assert.equal(ctx.lastRun(), undefined, 'run should still be paused');
    ctx.browser.login();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish after login');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });

  it('a worker tab closed while logged out goes back in the queue',async () => {
    const ctx = await startAndLogOut();
    await ctx.browser.advance(30 * SEC);
    const onSignIn = [...ctx.browser.tabs.values()].filter((t) => t.url === SIGN_IN_URL);
    assert.ok(onSignIn.length > 0, 'setup: expected worker tabs on the sign-in page');
    ctx.browser.userCloseTab(onSignIn[0].id);
    await ctx.browser.advance(1 * MIN);
    ctx.browser.login();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish after login');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });

  it('detects logout and login from navigation alone (no content script on the sign-in page)', async () => {
    const ctx = await startAndLogOut(8, { silentOn: (u) => u === SIGN_IN_URL });
    await ctx.browser.advance(5 * MIN);
    assert.equal(ctx.lastRun(), undefined, 'run should be paused, not finished');
    assert.equal(loggedOutNotes(ctx).length, 1);
    ctx.browser.login();
    await ctx.browser.advance(5 * SEC);
    assert.ok(!pausedNow(ctx), 'navigation back to SR must clear the pause');
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not resume after login');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });

  it('a result reported from the sign-in page (in-page sign-out mid-profile) is not recorded', async () => {
    const ctx = setup({ n: 3, workers: 1, behaviour: normal(20 * SEC) });
    await ctx.start();
    await ctx.browser.advance(5 * SEC); // #1 checked in, mid-profile
    const tab = ctx.tabFor(url(1));
    ctx.browser.spaNavigate(tab.id, SIGN_IN_URL);
    await ctx.browser.advance(1 * SEC);
    const resp = await ctx.browser.sendFromTab(tab.id, { type: 'srWorkerDone', hitCount: 0, notesPosted: false, error: 'controls_timeout' });
    assert.deepEqual(resp, { next: false });
    assert.equal(queueItems(ctx).filter((i) => i.state === 'done' || i.state === 'failed').length, 0,
      'a sign-in page report must not complete the profile');
  });

  it('logging out right after Start: the staggered second worker is not launched', async () => {
    const ctx = setup({ n: 6, workers: 2, behaviour: srAware(normal(20 * SEC)) });
    await ctx.start();
    await ctx.browser.advance(1500); // worker 1 loaded; worker 2 still scheduled (~2.8s stagger)
    ctx.browser.logout();
    await ctx.browser.advance(5 * MIN);
    assert.equal(creates(ctx), 1, 'no worker tab may be launched while logged out');
    ctx.browser.login();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish after login');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });

  it('after a long pause, a slow-loading page is not reclaimed before it checks in', async () => {
    // 40s page loads outlast a watchdog tick (30s); the pause outlasts the work timeout.
    const ctx = await startAndLogOut(6, { pageLoadMs: 40 * SEC });
    await ctx.browser.advance(5 * MIN);
    const createsBeforeLogin = creates(ctx);
    ctx.browser.login();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 30 * MIN), 'run did not finish after login');
    await ctx.browser.advance(1 * MIN);
    assert.equal(creates(ctx), createsBeforeLogin, 'a worker tab was reclaimed and relaunched after login');
    assertCleanRun(ctx);
  });

  it('a worker on the sign-in page is told not to scan it', async () => {
    const ctx = setup({ n: 3, workers: 1, behaviour: normal(20 * SEC) });
    await ctx.start();
    await ctx.browser.advance(5 * SEC);
    const tab = ctx.tabFor(url(1));
    ctx.browser.spaNavigate(tab.id, SIGN_IN_URL);
    await ctx.browser.advance(1 * SEC);
    assert.deepEqual(await ctx.browser.sendFromTab(tab.id, { type: 'srIsParallelWorker' }), { active: false, feature: null });
  });
});

describe('background parallel queue: phase timings', () => {
  const timedReport = (u) => ({
    ...kwReport(u),
    timings: { pageLoad: 4000.4, resumeRender: 2000, notesPost: 'x', 'bad key': 5, nested: { a: 1 } },
  });

  it('keeps numeric worker timings and records the pause before each reused-tab navigation', async () => {
    const ctx = setup({ n: 3, workers: 1, behaviour: (u) => ({ workMs: 5 * SEC, report: timedReport(u) }) });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
    const [first, ...rest] = ctx.lastRun().results;
    assert.deepEqual(first.timings, { pageLoad: 4000, resumeRender: 2000 },
      'only finite numbers under plain keys are kept; a freshly opened tab has no navDelay');
    for (const r of rest) {
      assert.deepEqual(Object.keys(r.timings), ['navDelay', 'pageLoad', 'resumeRender']);
      // notesPosted → jitter(2400): 65%..135%
      assert.ok(r.timings.navDelay >= 1560 && r.timings.navDelay <= 3240, `navDelay ${r.timings.navDelay} out of range`);
    }
  });

  it('a worker that reports no timings leaves the result without them', async () => {
    const ctx = setup({ n: 2, workers: 1 });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    for (const r of ctx.lastRun().results) assert.equal(r.timings, undefined);
  });
});

// One pace limit across all worker tabs: more workers must not mean a higher request rate.
describe('background parallel queue: pace limit', () => {
  // Profile loads (first load per URL), in time order.
  const profileLoads = (ctx) => ctx.browser.events.filter((e) => e[0] === 'nav' && /\/profile\/c\d+$/.test(e[2])).map((e) => e[3]);
  const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);

  it('3 fast workers stay at the default 6 profiles a minute', async () => {
    const ctx = setup({ n: 12, workers: 3, behaviour: normal(2 * SEC), profilesPerMinute: null });
    const resp = await ctx.start();
    assert.equal(resp.profilesPerMinute, 6);
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
    const loads = profileLoads(ctx);
    assert.equal(loads.length, 12, 'each profile loaded once');
    // 10s per slot, jittered ±35%.
    for (const g of gaps(loads)) assert.ok(g >= 6500, `two profile loads only ${g}ms apart`);
    const perMin = (loads.length - 1) / ((loads.at(-1) - loads[0]) / MIN);
    assert.ok(perMin <= 7, `ran at ${perMin.toFixed(1)} profiles/min`);
  });

  it('honours the popup pace, capped at 30 a minute', async () => {
    const ctx = setup({ n: 2, workers: 2, profilesPerMinute: 100 });
    const resp = await ctx.start();
    assert.equal(resp.profilesPerMinute, 30);
  });

  it('a navigation waiting for its slot still happens after a service-worker restart', async () => {
    const ctx = setup({ n: 4, workers: 1, behaviour: normal(2 * SEC), profilesPerMinute: null });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(() => ctx.processed(url(1)), 1 * MIN, 50));
    await ctx.browser.advance(1 * SEC); // done reported; #2 waits for its slot
    ctx.browser.killSW();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
    for (const u of ctx.urls) assert.equal(ctx.visits(u), 1, `${u} loaded more than once`);
    assert.equal(ctx.browser.events.filter((e) => e[0] === 'tab-create').length, 1,
      'the waiting tab must be reused, not reclaimed by the watchdog');
  });
});

// DataDome's challenge mid-run: pause, bring that tab to the recruiter, never fail
// profiles or trip the breaker; resume once solved; give up after 15 minutes.
describe('background parallel queue: bot check mid-run', () => {
  const queue = (ctx) => ctx.browser.store.session.srParallelQueue;
  const botNotes = (ctx) => ctx.browser.notifications.filter((n) => /bot check/i.test(n.title));
  const creates = (ctx) => ctx.browser.events.filter((e) => e[0] === 'tab-create').length;

  async function startAndBlock(opts = {}) {
    const ctx = setup({ n: 6, workers: 2, behaviour: normal(20 * SEC), ...opts });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(() => ctx.processed(url(1)), 5 * MIN, 50));
    ctx.browser.blockBots(); // the next profile load gets the challenge
    assert.ok(await ctx.browser.runUntil(() => !!queue(ctx)?.pausedSince, 2 * MIN), 'run never paused');
    return ctx;
  }

  it('challenge on a page load: pauses, foregrounds that tab, resumes once solved', async () => {
    const ctx = await startAndBlock();
    const tabId = queue(ctx).pauseTabId;
    assert.ok(!ctx.processed(ctx.browser.tabs.get(tabId).url), 'a page under the challenge must not be scanned');
    assert.equal(ctx.browser.tabs.get(tabId).active, true, 'the challenge tab must be brought to the front');
    assert.equal(botNotes(ctx).length, 1, 'expected one "bot check" notification');
    const createsAtPause = creates(ctx);
    await ctx.browser.advance(5 * MIN);
    assert.equal(ctx.lastRun(), undefined, 'run should be paused, not finished');
    assert.deepEqual(Object.values(queue(ctx).items).filter((i) => i.state === 'failed'), [], 'no profile may fail');
    assert.equal(creates(ctx), createsAtPause, 'no new worker tabs while paused');

    ctx.browser.solveBotCheck(tabId);
    await ctx.browser.advance(5 * SEC);
    assert.ok(!queue(ctx)?.pausedSince, 'the clean reload must end the pause');
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish after the check was solved');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });

  it('challenge over a page mid-profile: that result is dropped and the profile re-scanned', async () => {
    const ctx = setup({ n: 3, workers: 1, behaviour: normal(20 * SEC) });
    await ctx.start();
    await ctx.browser.advance(5 * SEC); // #1 checked in, mid-profile
    const tab = ctx.tabFor(url(1));
    ctx.browser.showBotCheck(tab.id);
    assert.ok(await ctx.browser.runUntil(() => !!queue(ctx)?.pausedSince, 1 * MIN), 'run never paused');
    assert.ok(!queue(ctx).items[url(1)].result, 'a result from under the challenge must not be recorded');
    // Solved without a reload: the watchdog notices the challenge is gone and reloads the profile.
    ctx.browser.solveBotCheck(tab.id, { reload: false });
    assert.ok(await ctx.browser.runUntil(ctx.finished, 10 * MIN), 'run did not finish');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
    assert.equal(ctx.visits(url(1)), 2, 'profile #1 should be loaded again after the check');
  });

  it('not solved within 15 minutes: stops with "bot_check" and closes worker tabs', async () => {
    const ctx = await startAndBlock();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run never gave up');
    await ctx.browser.advance(1 * MIN);
    assert.equal(ctx.lastRun().stoppedReason, 'bot_check');
    assert.ok(ctx.lastRun().results.every((r) => !r.error), 'no profile is failed by the pause');
    assert.ok(ctx.browser.notifications.some((n) => /Stopped: SmartRecruiters bot check not solved/.test(n.message)));
    assert.equal(ctx.workerTabs().length, 0, 'worker tabs left open');
  });

  it('the pause survives a service-worker restart', async () => {
    const ctx = await startAndBlock();
    const tabId = queue(ctx).pauseTabId;
    await ctx.browser.advance(1 * MIN);
    ctx.browser.killSW();
    await ctx.browser.advance(3 * MIN);
    assert.equal(ctx.lastRun(), undefined, 'run should still be paused');
    ctx.browser.solveBotCheck(tabId);
    assert.ok(await ctx.browser.runUntil(ctx.finished, 20 * MIN), 'run did not finish after the check was solved');
    await ctx.browser.advance(1 * MIN);
    assertCleanRun(ctx);
  });
});
