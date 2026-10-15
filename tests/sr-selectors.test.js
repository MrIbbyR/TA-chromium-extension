'use strict';
// sr-selectors.js holds every SmartRecruiters selector, so an SR UI change is a
// one-file fix. These tests keep it that way: no SR selector literal in a query call
// elsewhere, and the registry loaded before every file that reads it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SR, SEL, ID } = require('../sr-selectors.js');

const ROOT = path.join(__dirname, '..');
const SOURCE_FILES = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith('.js') && f !== 'sr-selectors.js')
  .sort();

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readCode(file) {
  return stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

// A DOM query whose first argument is a string literal naming an SR id, SR/SPL
// web component, SR test hook or the DataDome challenge.
const SR_LITERAL_QUERY =
  /\b(querySelector(?:All)?|queryDeepSelectorAll|closest|matches|getElementById|findElementByIdDeep)\s*\([^)]*?["'`][^"'`]*(#?st-[A-Za-z]|\bspl-|\bsr-[a-z]|\bapp-[a-z]|data-test|captcha|ddChallenge|textLayer)/;

describe('sr-selectors.js registry', () => {
  it('every entry has a selector and a description', () => {
    for (const [name, entry] of Object.entries(SEL)) {
      const sels = Array.isArray(entry.sel) ? entry.sel : [entry.sel];
      assert.ok(sels.length && sels.every((s) => typeof s === 'string' && s.trim()), `${name}: empty selector`);
      assert.ok(entry.desc, `${name}: missing desc`);
      assert.equal(SR.sel[name], entry.sel, `${name}: SR.sel out of sync with the table`);
    }
  });

  it('id-based selectors match the id table', () => {
    for (const key of ['candidateView', 'jobDetailsPage', 'moveForward', 'screening']) {
      assert.equal(SEL[key].sel, '#' + ID[key]);
    }
    assert.equal(SEL.notesSection.sel[0], '#' + ID.notes);
    assert.equal(SEL.applicantNameHeader.sel, '#' + ID.applicantName);
  });
});

describe('no SmartRecruiters selectors outside sr-selectors.js', () => {
  for (const file of SOURCE_FILES) {
    it(file, () => {
      const lines = readCode(file).split('\n');
      const hits = lines
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => SR_LITERAL_QUERY.test(l))
        .map(([n, l]) => `${file}:${n}: ${l.trim()}`);
      assert.deepEqual(hits, [], 'Move these selectors into sr-selectors.js:\n' + hits.join('\n'));
    });
  }
});

describe('sr-selectors.js loads before its readers', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  it('is the first content script on SR pages', () => {
    const allFrames = manifest.content_scripts.find((cs) => cs.all_frames);
    assert.equal(allFrames.js[0], 'sr-selectors.js');
  });

  it('is injected with each core by the popup', () => {
    const popup = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
    const lists = [...popup.matchAll(/files:\s*\[([^\]]*-core\.js[^\]]*)\]/g)].map((m) => m[1]);
    assert.ok(lists.length >= 2, 'expected the salary and keyword core injections');
    for (const list of lists) {
      const files = list.match(/"[^"]+"/g).map((s) => s.slice(1, -1));
      const core = files.findIndex((f) => f.endsWith('-core.js'));
      const sel = files.indexOf('sr-selectors.js');
      assert.ok(sel >= 0 && sel < core, `sr-selectors.js must precede the core in [${files.join(', ')}]`);
    }
  });

  it('loads before popup.js in popup.html', () => {
    const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
    const sel = html.indexOf('src="sr-selectors.js"');
    assert.ok(sel >= 0 && sel < html.indexOf('src="popup.js"'));
  });

  it('is imported by the service worker', () => {
    assert.match(readCode('background.js'), /importScripts\(\s*["']sr-selectors\.js["']\s*\)/);
  });
});
