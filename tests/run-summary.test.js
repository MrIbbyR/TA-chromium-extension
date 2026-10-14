'use strict';
// Popup "Last run" formatting (run-summary.js). A profile the queue could not scan
// (worker tab closed, or timed out) is saved as { url, error } with no hitCount — it
// must never read as "0 hits", which a recruiter takes to mean "candidate lacks the skills".
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeKeywordRun, formatKeywordResult, stoppedEarlyLine,
  summarizePhaseTimings, formatPhaseTimings,
} = require('../run-summary.js');

const url = (id) => `https://www.smartrecruiters.com/app/people/applications/${id}/notes`;
const scanned = (id, over = {}) => ({
  url: url(id), hitCount: 0, matchedKeywords: [], notesPosted: true,
  textStats: { resumeLen: 100, totalLen: 300 }, ...over,
});

describe('formatKeywordResult: scanned profiles', () => {
  it('matched profile with a posted note', () => {
    const r = scanned('a1', { hitCount: 2, matchedKeywords: ['nlp', 'azure'] });
    assert.deepEqual(formatKeywordResult(r), { icon: '✓', text: '[a1] 2 hits · nlp, azure · note✓' });
  });

  it('0-hit profile shows the text-source breakdown', () => {
    assert.deepEqual(formatKeywordResult(scanned('b2')),
      { icon: '✗', text: '[b2] 0 hits [rsm:100 ttl:300] · note✓' });
  });

  it('matched profile whose note failed shows the reason', () => {
    const r = scanned('c3', { hitCount: 1, matchedKeywords: ['phd'], notesPosted: false, notesFailReason: 'Post button missing — gave up' });
    assert.equal(formatKeywordResult(r).text, '[c3] 1 hits · phd · note✗ [Post button missing]');
  });
});

describe('formatKeywordResult: profiles the queue could not scan', () => {
  it('tab_closed is shown as not scanned, not as 0 hits', () => {
    assert.deepEqual(formatKeywordResult({ url: url('d4'), error: 'tab_closed' }),
      { icon: '⚠', text: '[d4] not scanned — tab closed' });
  });

  it('timeout is shown as not scanned, not as 0 hits', () => {
    assert.deepEqual(formatKeywordResult({ url: url('e5'), error: 'timeout' }),
      { icon: '⚠', text: '[e5] not scanned — timed out' });
  });

  it('an unknown error code is shown verbatim', () => {
    assert.deepEqual(formatKeywordResult({ url: url('f6'), error: 'weird_code' }),
      { icon: '⚠', text: '[f6] not scanned — weird_code' });
  });
});

describe('summarizeKeywordRun', () => {
  const results = [
    scanned('a1', { hitCount: 2 }),
    scanned('b2'),
    scanned('c3', { hitCount: 1, notesPosted: false }),
    { url: url('d4'), error: 'tab_closed' },
    { url: url('e5'), error: 'timeout' },
  ];

  it('counts matched, notes and note failures over scanned profiles', () => {
    const s = summarizeKeywordRun(results);
    assert.equal(s.total, 5);
    assert.equal(s.matched, 2);
    assert.equal(s.notesPosted, 2);
    assert.equal(s.notesFailed, 1);
  });

  it('counts profiles that could not be scanned', () => {
    assert.equal(summarizeKeywordRun(results).failed, 2);
    assert.equal(summarizeKeywordRun(results.slice(0, 3)).failed, 0);
  });
});

describe('popup wiring', () => {
  it('popup.html loads run-summary.js before popup.js (else "Last run" throws in Chrome)', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'popup.html'), 'utf8');
    const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.includes('run-summary.js'), 'run-summary.js is not loaded by popup.html');
    assert.ok(srcs.indexOf('run-summary.js') < srcs.indexOf('popup.js'), 'run-summary.js must load before popup.js');
    assert.ok(srcs.includes('run-preflight.js'), 'run-preflight.js is not loaded by popup.html');
    assert.ok(srcs.indexOf('run-summary.js') < srcs.indexOf('run-preflight.js'), 'run-preflight.js uses failureLabel from run-summary.js');
    assert.ok(srcs.indexOf('run-preflight.js') < srcs.indexOf('popup.js'), 'run-preflight.js must load before popup.js');
  });
});

describe('circuit breaker display', () => {
  it('a page that never loaded is shown as not scanned', () => {
    assert.deepEqual(formatKeywordResult({ url: url('g7'), error: 'controls_timeout', hitCount: 0, notesPosted: false }),
      { icon: '⚠', text: '[g7] not scanned — page never finished loading' });
  });

  it('stopped-early line names the reason and how far the run got', () => {
    assert.equal(stoppedEarlyLine({ stoppedReason: 'notes_failed', total: 20, results: [1, 2, 3, 4, 5] }),
      'Stopped early: 3 profiles in a row — note not posted. 5 of 20 profiles processed; check SmartRecruiters, then re-run.');
  });

  it('a pause that ran out is not described as 3 failures in a row', () => {
    assert.equal(stoppedEarlyLine({ stoppedReason: 'logged_out', total: 8, results: [1, 2] }),
      'Stopped: logged out of SmartRecruiters for 15 minutes. 2 of 8 profiles processed; check SmartRecruiters, then re-run.');
    assert.equal(stoppedEarlyLine({ stoppedReason: 'bot_check', total: 8, results: [1] }),
      'Stopped: SmartRecruiters bot check not solved for 15 minutes. 1 of 8 profiles processed; check SmartRecruiters, then re-run.');
  });

  it('no stopped-early line for a normal run', () => {
    assert.equal(stoppedEarlyLine({ total: 5, results: [1, 2, 3, 4, 5] }), null);
  });
});

describe('phase timings', () => {
  const timed = (id, timings, over = {}) => scanned(id, { timings, ...over });
  const results = [
    timed('a1', { pageLoad: 4000, resumeRender: 2000, notesPost: 2000 }),
    timed('b2', { pageLoad: 6000, resumeRender: 6000 }),                    // no note posted
    timed('c3', { pageLoad: 5000, resumeRender: 1000, notesPost: 4000 }),
    { url: url('d4'), error: 'controls_timeout', timings: { pageLoad: 90000 } },
  ];

  it('per-profile total and median/p90 per phase, over scanned profiles only', () => {
    const s = summarizePhaseTimings(results);
    assert.equal(s.profiles, 3, 'a failed profile must not count');
    assert.equal(s.median, 10000);
    assert.equal(s.p90, 12000);
    const byPhase = Object.fromEntries(s.phases.map((p) => [p.phase, p]));
    assert.equal(byPhase.pageLoad.median, 5000);
    assert.equal(byPhase.pageLoad.p90, 6000);
    assert.equal(byPhase.notesPost.median, 2000, 'a skipped phase counts as 0 for that profile');
    assert.equal(byPhase.resumeRender.share, 9000 / 30000);
  });

  it('phases are listed in the order a profile goes through them', () => {
    const s = summarizePhaseTimings([timed('a1', { notesPost: 1, weirdNew: 1, pageLoad: 1, navDelay: 1 })]);
    assert.deepEqual(s.phases.map((p) => p.phase), ['navDelay', 'pageLoad', 'notesPost', 'weirdNew']);
  });

  it('no timings → no summary', () => {
    assert.equal(summarizePhaseTimings([scanned('a1')]), null);
    assert.deepEqual(formatPhaseTimings(null), []);
  });

  it('log lines: header, then biggest share first, phases under 1% dropped', () => {
    const lines = formatPhaseTimings(summarizePhaseTimings([
      timed('a1', { pageLoad: 3000, resumeRender: 6940, match: 60 }),
    ]));
    assert.deepEqual(lines, [
      'Timing over 1 profile: median 10.0s · p90 10.0s per profile',
      'resume render: 69% · median 6.9s · p90 6.9s',
      'page load: 30% · median 3.0s · p90 3.0s',
    ]);
  });

  it('a parallel-run result (no totalMs) shows its time from the phase timings', () => {
    const r = timed('a1', { pageLoad: 4000, notesPost: 2500 }, { hitCount: 1, matchedKeywords: ['nlp'] });
    assert.equal(formatKeywordResult(r).text, '[a1] 1 hits · nlp · note✓ · 6.5s');
  });
});
