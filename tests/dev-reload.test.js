'use strict';
// Dev-reload shortcut: the manifest command reloads the extension, then the fresh
// service worker refreshes every SmartRecruiters tab (a reload doesn't re-inject content
// scripts into open tabs). Shipped zips must not carry the shortcut.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBrowser } = require('./helpers/background-harness');
const { shipManifest } = require('../scripts/ship-manifest.js');
const manifest = require('../manifest.json');

const SR = 'https://www.smartrecruiters.com/app/people/profile/c1';
const SR_JOBS = 'https://jobs.smartrecruiters.com/app/jobs/123';
const OTHER = 'https://example.com/';
const reloaded = (b) => b.events.filter((e) => e[0] === 'tab-reload').map((e) => e[1]);

describe('dev-reload shortcut', () => {
  it('reloads the extension, then refreshes only SmartRecruiters tabs', async () => {
    const b = createBrowser();
    const sr1 = b.openUserTab(SR), sr2 = b.openUserTab(SR_JOBS), other = b.openUserTab(OTHER);
    b.fireCommand('dev-reload');
    await b.advance(1000);
    assert.equal(b.events.filter((e) => e[0] === 'ext-reload').length, 1);
    assert.deepEqual(reloaded(b).sort(), [sr1, sr2].sort());
    assert.ok(!reloaded(b).includes(other));
    assert.equal(b.store.local.srDevReloadPending, undefined, 'flag cleared after use');
  });

  it('ignores other commands', async () => {
    const b = createBrowser();
    b.openUserTab(SR);
    b.fireCommand('something-else');
    await b.advance(1000);
    assert.equal(b.events.filter((e) => e[0] === 'ext-reload').length, 0);
    assert.deepEqual(reloaded(b), []);
  });

  it('a stale flag (reload never happened) does not refresh tabs on a later wake-up', async () => {
    const b = createBrowser({ initialLocal: { srDevReloadPending: 1 } });
    b.openUserTab(SR);
    b.killSW();
    b.bootSW();
    await b.advance(1000);
    assert.deepEqual(reloaded(b), []);
    assert.equal(b.store.local.srDevReloadPending, undefined);
  });
});

describe('dev-reload: not shipped', () => {
  it('manifest.json declares the dev-reload command', () => {
    assert.ok(manifest.commands && manifest.commands['dev-reload']);
  });
  it('the shipped manifest drops "commands" and keeps everything else', () => {
    const shipped = shipManifest(manifest);
    assert.equal(shipped.commands, undefined);
    const { commands, ...rest } = manifest;
    assert.deepEqual(shipped, rest);
  });
});
