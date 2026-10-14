'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  capText,
  makePhaseTimer,
  saveProfileDiag,
  sanitizeDiagEntry,
  getDiagRawCapture,
  DIAG_KEY_PREFIX,
  DIAG_MAX_ENTRIES,
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

  it('timings survive diag sanitization (they are not candidate data)', () => {
    const clean = sanitizeDiagEntry({ timestamp: 1, extractedText: 'resume', timings: { pageLoad: 1 } }, false);
    assert.deepEqual(clean.timings, { pageLoad: 1 });
    assert.equal(clean.extractedText, '');
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

describe('saveProfileDiag', () => {
  let storage;
  let originalChrome;

  beforeEach(() => {
    storage = {};
    originalChrome = global.chrome;
    // Minimal chrome.storage.local mock — synchronous-ish (callback fired immediately).
    global.chrome = {
      storage: {
        local: {
          set(payload, cb) {
            Object.assign(storage, payload);
            if (cb) cb();
          },
          get(keys, cb) {
            if (keys === null || keys === undefined) {
              cb(Object.assign({}, storage));
            } else if (Array.isArray(keys)) {
              const out = {};
              for (const k of keys) if (k in storage) out[k] = storage[k];
              cb(out);
            } else {
              const out = {};
              if (keys in storage) out[keys] = storage[keys];
              cb(out);
            }
          },
          remove(keys, cb) {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) delete storage[k];
            if (cb) cb();
          },
        },
      },
      runtime: { lastError: null },
    };
  });

  afterEach(() => {
    global.chrome = originalChrome;
  });

  it('writes entry under lastRunDiag_<timestamp> key', (t, done) => {
    const ts = Date.now();
    saveProfileDiag({ timestamp: ts, profileUrl: 'http://example/profile/1', userInput: 'docker' });
    // Pruning runs through nested callbacks — let microtasks flush.
    setImmediate(() => {
      const key = DIAG_KEY_PREFIX + ts;
      assert.ok(key in storage, 'expected key ' + key);
      assert.strictEqual(storage[key].profileUrl, 'http://example/profile/1');
      done();
    });
  });

  it('prunes to DIAG_MAX_ENTRIES most recent entries', (t, done) => {
    // Pre-populate with DIAG_MAX_ENTRIES + 5 fresh entries (within the 7-day TTL),
    // strictly increasing so the count-prune drops the oldest.
    const base = Date.now() - (DIAG_MAX_ENTRIES + 5) * 1000;
    const oldest = base;
    const secondOldest = base + 1000;
    for (let i = 0; i < DIAG_MAX_ENTRIES + 5; i++) {
      const ts = base + i * 1000;
      storage[DIAG_KEY_PREFIX + ts] = { timestamp: ts };
    }
    // Save one more (newest). Should leave only DIAG_MAX_ENTRIES total.
    const newest = Date.now();
    saveProfileDiag({ timestamp: newest });
    setImmediate(() => {
      setImmediate(() => {
        const remaining = Object.keys(storage).filter(k => k.indexOf(DIAG_KEY_PREFIX) === 0);
        assert.strictEqual(remaining.length, DIAG_MAX_ENTRIES,
          'expected exactly ' + DIAG_MAX_ENTRIES + ' entries after prune, got ' + remaining.length);
        assert.ok(remaining.includes(DIAG_KEY_PREFIX + newest), 'newest must survive prune');
        // We had 25 fresh + 1 new = 26, kept 20 newest → oldest are dropped by count.
        assert.ok(!remaining.includes(DIAG_KEY_PREFIX + oldest));
        assert.ok(!remaining.includes(DIAG_KEY_PREFIX + secondOldest));
        done();
      });
    });
  });

  it('silently no-ops when chrome.storage is undefined', () => {
    global.chrome = undefined;
    // Must not throw.
    assert.doesNotThrow(() => saveProfileDiag({ timestamp: Date.now() }));
  });

  it('prunes diagnostics older than DIAG_MAX_AGE_MS (7-day TTL)', (t, done) => {
    const now = Date.now();
    const fresh = now - 1000;                       // 1s old — keep
    const stale = now - (8 * 24 * 60 * 60 * 1000);  // 8 days old — expire
    storage[DIAG_KEY_PREFIX + fresh] = { timestamp: fresh };
    storage[DIAG_KEY_PREFIX + stale] = { timestamp: stale };
    saveProfileDiag({ timestamp: now });
    setImmediate(() => {
      setImmediate(() => {
        const remaining = Object.keys(storage).filter(k => k.indexOf(DIAG_KEY_PREFIX) === 0);
        assert.ok(remaining.includes(DIAG_KEY_PREFIX + fresh), 'fresh entry must survive');
        assert.ok(remaining.includes(DIAG_KEY_PREFIX + now), 'newest entry must survive');
        assert.ok(!remaining.includes(DIAG_KEY_PREFIX + stale), 'stale (>7d) entry must be purged');
        done();
      });
    });
  });

  it('preserves non-diag keys during prune', (t, done) => {
    storage['keywordTriageLastRun'] = { foo: 'bar' };
    storage['unrelatedSetting'] = 42;
    for (let i = 0; i < DIAG_MAX_ENTRIES + 3; i++) {
      storage[DIAG_KEY_PREFIX + (1000 + i)] = { timestamp: 1000 + i };
    }
    saveProfileDiag({ timestamp: 9999 });
    setImmediate(() => {
      setImmediate(() => {
        assert.strictEqual(storage['keywordTriageLastRun'].foo, 'bar', 'unrelated key must survive');
        assert.strictEqual(storage['unrelatedSetting'], 42);
        done();
      });
    });
  });
});

describe('sanitizeDiagEntry — GDPR raw-text gate (default off)', () => {
  function fullEntry() {
    return {
      timestamp: 1717420800000,
      type: 'keyword',
      profileUrl: 'https://x.smartrecruiters.com/profile/9',
      userInput: 'docker',
      matchedUserKeywords: ['docker'],
      missedUserKeywords: [],
      textSources: { header: 'Jane Doe', resume: 'raw resume text', profile: 'p', screening: 's', fullPage: 'f' },
      extractedText: 'Jane Doe — full resume body with PII',
      textStats: { resumeLen: 16, totalLen: 36 },
      durationMs: 42,
      log: [
        { ok: true, msg: 'Matched 1/1 keywords: docker' },
        { ok: false, msg: 'TEXT_SAMPLE: Jane Doe lives at 12 Acacia Ave and earns...' },
        { ok: true, msg: 'A: 35 LPA' },
      ],
    };
  }

  it('strips raw resume text when rawCapture is false (the default)', () => {
    const out = sanitizeDiagEntry(fullEntry(), false);
    assert.strictEqual(out.extractedText, '', 'extractedText must be blanked');
    assert.strictEqual(out.textSources.resume, '', 'textSources.resume must be blanked');
    assert.strictEqual(out.textSources.header, '', 'textSources.header must be blanked');
    assert.strictEqual(out.rawCaptured, false);
  });

  it('removes TEXT_SAMPLE and salary "A:" lines from the log when off', () => {
    const out = sanitizeDiagEntry(fullEntry(), false);
    const msgs = out.log.map((e) => e.msg);
    assert.ok(!msgs.some((m) => /^TEXT_SAMPLE:/.test(m)), 'TEXT_SAMPLE line must be dropped');
    assert.ok(!msgs.some((m) => /^A:\s/.test(m)), 'raw salary answer line must be dropped');
    assert.ok(msgs.includes('Matched 1/1 keywords: docker'), 'non-PII log lines must survive');
  });

  it('preserves debugging metadata when off', () => {
    const out = sanitizeDiagEntry(fullEntry(), false);
    assert.strictEqual(out.textStats.resumeLen, 16, 'lengths kept for debugging');
    assert.deepStrictEqual(out.matchedUserKeywords, ['docker']);
    assert.strictEqual(out.profileUrl, 'https://x.smartrecruiters.com/profile/9');
    assert.strictEqual(out.durationMs, 42);
  });

  it('keeps raw text intact when rawCapture is true (debug mode)', () => {
    const out = sanitizeDiagEntry(fullEntry(), true);
    assert.strictEqual(out.extractedText, 'Jane Doe — full resume body with PII');
    assert.strictEqual(out.textSources.resume, 'raw resume text');
    assert.strictEqual(out.log.length, 3, 'all log lines retained in debug mode');
  });

  it('saveProfileDiag persists a sanitized entry by default (no rawCapture arg)', (t, done) => {
    const storage = {};
    const originalChrome = global.chrome;
    global.chrome = {
      storage: { local: {
        set(p, cb) { Object.assign(storage, p); if (cb) cb(); },
        get(k, cb) { cb(k == null ? Object.assign({}, storage) : {}); },
        remove(k, cb) { (Array.isArray(k) ? k : [k]).forEach((x) => delete storage[x]); if (cb) cb(); },
      } },
      runtime: { lastError: null },
    };
    const ts = Date.now();
    saveProfileDiag(Object.assign(fullEntry(), { timestamp: ts }));
    setImmediate(() => {
      const key = DIAG_KEY_PREFIX + ts;
      assert.strictEqual(storage[key].extractedText, '', 'persisted diag must not contain raw resume text');
      global.chrome = originalChrome;
      done();
    });
  });
});

describe('getDiagRawCapture defaults to false without chrome.storage', () => {
  it('resolves false when chrome is undefined', async () => {
    const originalChrome = global.chrome;
    global.chrome = undefined;
    assert.strictEqual(await getDiagRawCapture(), false);
    global.chrome = originalChrome;
  });
});

describe('cap constants are sensible', () => {
  it('DIAG_TEXT_CAP is at least 10 KB', () => {
    assert.ok(DIAG_TEXT_CAP >= 10 * 1024);
  });
  it('DIAG_SOURCE_CAP is smaller than DIAG_TEXT_CAP', () => {
    assert.ok(DIAG_SOURCE_CAP < DIAG_TEXT_CAP);
  });
  it('DIAG_MAX_ENTRIES is exactly 20 (per plan)', () => {
    assert.strictEqual(DIAG_MAX_ENTRIES, 20);
  });
});
