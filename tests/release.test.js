'use strict';
// Release gate: catches the packaging mistakes unit tests can't see —
// an un-bumped/invalid version, a CHANGELOG out of sync, or a renamed file
// that manifest.json / popup still reference (which only fails at load time in Chrome).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

function assertFilesExist(files, source) {
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${source} references missing file: ${f}`);
  }
}

describe('release: version', () => {
  it('manifest version is valid for Chrome (1–4 dot-separated ints, each 0–65535, no leading zeros)', () => {
    const parts = manifest.version.split('.');
    assert.ok(parts.length >= 1 && parts.length <= 4, `bad version: ${manifest.version}`);
    for (const p of parts) {
      assert.match(p, /^(0|[1-9]\d*)$/, `bad version part "${p}" in ${manifest.version}`);
      assert.ok(Number(p) <= 65535, `version part ${p} exceeds 65535`);
    }
  });

  it('CHANGELOG top entry matches manifest version', () => {
    const m = read('CHANGELOG.md').match(/^## \[(\d+(?:\.\d+){0,3})\]/m);
    assert.ok(m, 'CHANGELOG.md has no "## [x.y.z]" entry');
    assert.equal(m[1], manifest.version,
      `CHANGELOG top entry is ${m[1]} but manifest.json is ${manifest.version} — bump both together`);
  });
});

describe('release: referenced files exist', () => {
  it('manifest.json', () => {
    const files = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      ...Object.values(manifest.icons || {}),
      ...Object.values((manifest.action && manifest.action.default_icon) || {}),
      ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
    ];
    assertFilesExist(files, 'manifest.json');
  });

  it('popup.html <script src>', () => {
    const srcs = [...read('popup.html').matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.length > 0);
    assertFilesExist(srcs, 'popup.html');
  });

  it('chrome.scripting.executeScript({ files }) in popup.js and background.js', () => {
    for (const src of ['popup.js', 'background.js']) {
      const files = [...read(src).matchAll(/files:\s*\[([^\]]*)\]/g)]
        .flatMap((m) => [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]));
      assertFilesExist(files, src);
    }
  });
});
