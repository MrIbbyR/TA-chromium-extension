'use strict';
// Preflight before a parallel run: warn (the recruiter can still start) when the list
// tab looks logged out or bot-checked, a run is already going, or the last run was
// stopped by the circuit breaker a short while ago.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { preflightWarnings } = require('../run-preflight.js');

const NOW = 1_790_000_000_000;
const MIN = 60 * 1000;
const ok = { pageUrl: 'https://www.smartrecruiters.com/app/jobs/123/applicants', loginFormVisible: false, botCheckVisible: false, runInProgress: false, lastRun: null, now: NOW };

describe('preflightWarnings', () => {
  it('no warnings when everything looks fine', () => {
    assert.deepEqual(preflightWarnings(ok), []);
  });

  it('bot check visible', () => {
    const w = preflightWarnings({ ...ok, botCheckVisible: true });
    assert.equal(w.length, 1);
    assert.match(w[0], /bot check/i);
  });

  it('login form visible', () => {
    const w = preflightWarnings({ ...ok, loginFormVisible: true });
    assert.equal(w.length, 1);
    assert.match(w[0], /logged out/i);
  });

  it('login URL', () => {
    for (const pageUrl of ['https://www.smartrecruiters.com/account/sign-in', 'https://login.smartrecruiters.com/', 'https://www.smartrecruiters.com/sso/saml']) {
      assert.match(preflightWarnings({ ...ok, pageUrl }).join(' '), /logged out/i, pageUrl);
    }
  });

  it('a run already in progress', () => {
    assert.match(preflightWarnings({ ...ok, runInProgress: true }).join(' '), /already in progress/i);
  });

  it('last run stopped early a few minutes ago, with the reason', () => {
    const lastRun = { finishedAt: NOW - 5 * MIN, stoppedReason: 'controls_timeout' };
    const w = preflightWarnings({ ...ok, lastRun }).join(' ');
    assert.match(w, /stopped early/i);
    assert.match(w, /never finished loading/i);
  });

  it('an old breaker trip, or a normally finished run, is not a warning', () => {
    assert.deepEqual(preflightWarnings({ ...ok, lastRun: { finishedAt: NOW - 45 * MIN, stoppedReason: 'timeout' } }), []);
    assert.deepEqual(preflightWarnings({ ...ok, lastRun: { finishedAt: NOW - 1 * MIN } }), []);
  });

  it('several problems → several warnings', () => {
    assert.equal(preflightWarnings({ ...ok, botCheckVisible: true, runInProgress: true }).length, 2);
  });
});
