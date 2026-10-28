'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  capText,
  makePhaseTimer,
  DIAG_TEXT_CAP,
  DIAG_SOURCE_CAP,
} = require('../keyword-triage-core.js');
const { resolveKeywordsWithMeta } = require('../keyword-expansions.js');

describe('makePhaseTimer', () => {
  it('charges the time since the previous mark to each phase, accumulating repeats', () => {
    let t = 1000;
    const timer = makePhaseTimer(null, () => t);
    t += 120.4; timer.mark('header');
    t += 3000; timer.mark('resumeRender');
    t += 50; timer.mark('header');
    assert.deepEqual(timer.phases, { header: 170, resumeRender: 3000 });
  });

  it('keeps seeded pre-core phases first, rounded, and ignores non-numbers', () => {
    let t = 0;
    const timer = makePhaseTimer({ pageLoad: 4200.7, controlsWait: 800, junk: 'x' }, () => t);
    t += 10; timer.mark('header');
    assert.deepEqual(Object.entries(timer.phases), [['pageLoad', 4201], ['controlsWait', 800], ['header', 10]]);
  });
});

describe('capText', () => {
  it('returns string under cap unchanged', () => {
    assert.strictEqual(capText('hello world', 100), 'hello world');
  });

  it('truncates over-cap string and appends marker', () => {
    const big = 'x'.repeat(200);
    const out = capText(big, 50);
    assert.ok(out.startsWith('x'.repeat(50)));
    assert.ok(out.includes('[truncated +150 chars]'));
  });

  it('handles null/undefined gracefully', () => {
    assert.strictEqual(capText(null, 10), '');
    assert.strictEqual(capText(undefined, 10), '');
  });

  it('handles non-string by stringifying', () => {
    assert.strictEqual(capText(42, 10), '42');
  });

  it('cap matches exact length', () => {
    const exact = 'a'.repeat(10);
    assert.strictEqual(capText(exact, 10), exact);  // no truncation marker
  });
});

describe('resolveKeywordsWithMeta exposes userKeywordsList', () => {
  it('returns parsed user keywords pre-expansion', () => {
    const meta = resolveKeywordsWithMeta('docker, kubernetes, python');
    assert.ok(Array.isArray(meta.userKeywordsList));
    assert.deepStrictEqual(meta.userKeywordsList, ['docker', 'kubernetes', 'python']);
  });

  it('preserves user casing in userKeywordsList', () => {
    const meta = resolveKeywordsWithMeta('Docker, Kubernetes');
    assert.deepStrictEqual(meta.userKeywordsList, ['Docker', 'Kubernetes']);
  });

  it('applies typo fix before populating userKeywordsList', () => {
    // pytroch -> pytorch via KEYWORD_TYPO_ALIASES
    const meta = resolveKeywordsWithMeta('pytroch');
    assert.deepStrictEqual(meta.userKeywordsList, ['pytorch']);
  });

  it('userKeywordsList is a separate array from keywords', () => {
    const meta = resolveKeywordsWithMeta('pytorch');
    assert.ok(meta.userKeywordsList.length < meta.keywords.length,
      'expansions should add more entries to keywords');
  });
});

describe('cap constants are sensible', () => {
  it('DIAG_TEXT_CAP is at least 10 KB', () => {
    assert.ok(DIAG_TEXT_CAP >= 10 * 1024);
  });
  it('DIAG_SOURCE_CAP is smaller than DIAG_TEXT_CAP', () => {
    assert.ok(DIAG_SOURCE_CAP < DIAG_TEXT_CAP);
  });
});
