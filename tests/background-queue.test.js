'use strict';
// Parallel queue orchestration in background.js, run against a simulated browser
// (tests/helpers/background-harness.js) with MV3 service-worker restarts, hung tabs,
// closed tabs and duplicate messages. The core invariants a finished run must satisfy:
//   - every queued URL is processed and reported exactly once, under its own URL
//   - the run always terminates (done notification + last-run saved)
//   - no worker tabs are left open afterwards
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBrowser, workerPage, RESUME_TAB_URL } = require('./helpers/background-harness');

const SEC = 1000;
const MIN = 60 * SEC;

const url = (n) => `https://jobs.smartrecruiters.com/app/people/profile/c${n}`;
const idOf = (u) => Number(/\/c(\d+)$/.exec(u)?.[1]);
// Each profile's "hit count" is its id, so a result reported under the wrong URL is detectable.
const kwReport = (u) => ({ hitCount: idOf(u), matchedKeywords: [], notesPosted: false });
const normal = (workMs) => (u) => ({ workMs, report: kwReport(u) });

function setup({ n, workers = 2, feature = 'keyword', behaviour = normal(5 * SEC), reportTwice = false, initialLocal }) {
  // Both autoruns run on every profile page, as in the real extension; each must claim
  // only its own feature's worker tabs.
  const kw = workerPage({ feature: 'keyword', behaviour, reportTwice });
  const sal = workerPage({ feature: 'salary', behaviour, reportTwice });
  const browser = createBrowser({ initialLocal, pageScript: (p) => Promise.all([kw(p), sal(p)]) });
  const urls = Array.from({ length: n }, (_, i) => url(i + 1));
  const start = () => browser.sendFromPopup({
    type: feature === 'salary' ? 'srStartParallelSalaryQueue' : 'srStartParallelKeywordQueue',
    urls, workers, config: { keywords: 'python' },
    returnUrl: 'https://jobs.smartrecruiters.com/app/jobs/123',
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
      '3 profiles matched out of 3 scanned. 1 could not be scanned (tab closed or timed out).');
  });

  it('Cost Assist done notification counts a timed-out profile as not screened', async () => {
    const ctx = setup({
      n: 3, workers: 2, feature: 'salary',
      behaviour: (u) => (idOf(u) === 2 ? 'hang' : { workMs: 3 * SEC, report: { moved: true } }),
    });
    await ctx.start();
    assert.ok(await ctx.browser.runUntil(ctx.finished, 15 * MIN), 'run did not finish');
    assert.equal(ctx.browser.notifications.at(-1).message,
      '2 profiles moved forward out of 2 screened. 1 could not be screened (tab closed or timed out).');
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
