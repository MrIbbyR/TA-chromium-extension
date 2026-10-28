'use strict';
// GDPR guardrail tests — these assert the data-minimization invariants documented
// in CLAUDE.md ("GDPR Data Handling"). They scan the shipped source files so a
// regression (e.g. re-adding on-disk run history, or seeding queue state into
// page-origin sessionStorage) fails CI instead of relying on a human reading the docs.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Shipped top-level source files (readdirSync is non-recursive, so tests/ and
// node_modules/ are excluded automatically).
const SOURCE_FILES = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith('.js'))
  .sort();

// Remove block and line comments so commentary like "// was sessionStorage.removeItem"
// doesn't trip the bans. The negative check on ':' keeps URLs like https:// intact.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readCode(file) {
  return stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

describe('GDPR: no persistent on-disk candidate data', () => {
  it('run-history.js is not present in the repo', () => {
    assert.ok(
      !fs.existsSync(path.join(ROOT, 'run-history.js')),
      'run-history.js was reintroduced — it persisted run records to IndexedDB. ' +
        'Keep run history in chrome.storage.session (in-memory) instead.'
    );
  });

  it('no source file uses IndexedDB', () => {
    for (const file of SOURCE_FILES) {
      assert.ok(
        !/indexedDB/i.test(readCode(file)),
        `${file} references IndexedDB — no persistent on-disk run/candidate storage allowed.`
      );
    }
  });

  it('no source file references run history', () => {
    for (const file of SOURCE_FILES) {
      assert.ok(
        !/run[-_]?history/i.test(readCode(file)),
        `${file} references run history — the persistent run-history module was removed for GDPR.`
      );
    }
  });
});

describe('GDPR: nothing about a candidate is kept after a run', () => {
  // Every key the extension may write to chrome.storage.local. None holds candidate
  // data: settings, a run counter, the Stop flag, the parallel-run config (keywords),
  // and the last run's totals (background.js; its shape is checked in
  // background-queue.test.js). Add a key here only if it can never identify a candidate.
  const ALLOWED_LOCAL_KEYS = new Set([
    'usageCount', 'salaryTriageMax', 'salaryTriageMin', 'offerSheetName', 'srAbortAll',
    'kwTriageKeywords', 'kwTriageMode', 'kwTriageBooleanQuery', 'srParallelWorkerConfig',
    'DEV_RELOAD_FLAG', 'keywordTriageLastRun', 'salaryTriageLastRun',
  ]);

  // The keys of the object literal passed to each chrome.storage.local.set(...).
  function localSetKeys(code, file) {
    const out = [];
    const re = /storage\.local\s*\.set\(\s*/g;
    let m;
    while ((m = re.exec(code))) {
      const rest = code.slice(m.index + m[0].length);
      assert.ok(rest.startsWith('{'), `${file}: chrome.storage.local.set() must take an object literal, so its keys can be checked`);
      const body = rest.slice(1, rest.indexOf('}'));
      const keyRe = /(?:^|,)\s*(?:\[([^\]]+)\]|(\w+))\s*:/g;
      let k;
      while ((k = keyRe.exec(body))) {
        if (k[2]) out.push(k[2]);
        else for (const q of k[1].matchAll(/"(\w+)"|'(\w+)'|\b([A-Z_]{3,})\b/g)) out.push(q[1] || q[2] || q[3]);
      }
    }
    return out;
  }

  it('chrome.storage.local is written only with allowed, non-candidate keys', () => {
    const seen = new Set();
    for (const file of SOURCE_FILES) {
      // Raw source: stripComments() can swallow code after a "/*" inside a string.
      for (const key of localSetKeys(fs.readFileSync(path.join(ROOT, file), 'utf8'), file)) {
        seen.add(key);
        assert.ok(ALLOWED_LOCAL_KEYS.has(key), `${file} writes "${key}" to chrome.storage.local — not on the allow-list`);
      }
    }
    // Known writes, so a regex that stops matching fails here instead of passing silently.
    for (const key of ['keywordTriageLastRun', 'salaryTriageLastRun', 'kwTriageKeywords', 'usageCount']) {
      assert.ok(seen.has(key), `expected to find the write of "${key}"`);
    }
  });

  it('no per-profile diagnostics or raw-text switch is read or written', () => {
    for (const file of SOURCE_FILES) {
      // Raw source minus comment lines (see the allow-list test for why not readCode).
      const code = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      for (const name of ['saveProfileDiag', 'getDiagRawCapture', 'sanitizeDiagEntry']) {
        assert.ok(!code.includes(name), `${file} references ${name} — diagnostics must not be stored`);
      }
      // The only mention allowed is the purge of what older versions saved.
      for (const m of code.matchAll(/srDiagRawCapture|lastRunDiag_/g)) {
        const line = code.slice(code.lastIndexOf('\n', m.index) + 1, code.indexOf('\n', m.index));
        assert.match(line, /startsWith|indexOf\(\s*"lastRunDiag_"\s*\)\s*===\s*0|===\s*"srDiagRawCapture"/,
          `${file}: ${m[0]} outside the purge of old data: ${line.trim()}`);
      }
    }
  });

  it('the scan builds diagnostics only when asked (Diagnose this profile)', () => {
    const core = readCode('keyword-triage-core.js');
    const builds = core.match(/\bdiag\s*=\s*\(\{/g) || [];
    const gated = core.match(/if \(config\.diagnose\) diag = \(\{/g) || [];
    assert.ok(builds.length > 0 && builds.length === gated.length, 'every diagnostics entry must be gated on config.diagnose');
    assert.ok(!/chrome\.storage/.test(core), 'keyword-triage-core.js must not touch chrome.storage');
  });

  it('salary answers and amounts never go in a log', () => {
    const code = readCode('salary-triage-core.js');
    assert.ok(!/msg:\s*"A: "/.test(code), 'the screening answer must not be logged');
    assert.ok(!/Parsed amount/.test(code), 'the parsed salary must not be logged');
  });
});

describe('GDPR: queue state stays in extension-isolated session storage', () => {
  it('no source file uses raw page-origin sessionStorage', () => {
    for (const file of SOURCE_FILES) {
      assert.ok(
        !/\bsessionStorage\b/.test(readCode(file)),
        `${file} uses raw sessionStorage — queue state must go through chrome.storage.session ` +
          'via the __srSession* shim (extension-isolated, not readable by the SmartRecruiters page).'
      );
    }
  });

  it('storage-session-shim.js defines the __srSession* globals', () => {
    const shim = readCode('storage-session-shim.js');
    for (const fn of ['__srSessionGet', '__srSessionSet', '__srSessionRemove']) {
      assert.ok(shim.includes(fn), `storage-session-shim.js is missing ${fn}`);
    }
  });

  it('background widens session-storage access so content scripts can use it', () => {
    const bg = readCode('background.js');
    assert.ok(
      bg.includes('setAccessLevel') && /TRUSTED_AND_UNTRUSTED_CONTEXTS/.test(bg),
      'background.js must call chrome.storage.session.setAccessLevel(' +
        '{ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }) — without it the *-autorun.js ' +
        'content scripts cannot read the queue and runs silently never resume.'
    );
  });
});
