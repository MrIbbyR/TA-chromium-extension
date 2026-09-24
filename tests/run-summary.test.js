'use strict';
// Popup "Last run" formatting (run-summary.js). A profile the queue could not scan
// (worker tab closed, or timed out) is saved as { url, error } with no hitCount — it
// must never read as "0 hits", which a recruiter takes to mean "candidate lacks the skills".
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeKeywordRun, formatKeywordResult } = require('../run-summary.js');

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
  });
});
