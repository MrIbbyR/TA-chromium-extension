'use strict';
// keyword-triage-core.js runs on the keyword-*.js modules. In Node they find each
// other through require(); in Chrome through globalThis.__srKw, which only works if
// every loader injects them in dependency order. These tests pin both paths.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// The core and every keyword-*.js module it requires (not expansions or the autorun).
const MODULES = fs.readdirSync(ROOT).filter((f) => /^keyword-.*\.js$/.test(f) &&
  !['keyword-expansions.js', 'keyword-triage-autorun.js'].includes(f));

// Files a module needs loaded first: its require()s, plus the globals it reads.
function prerequisites(file) {
  const src = read(file);
  const deps = [...src.matchAll(/require\("\.\/([\w.-]+\.js)"\)/g)].map((m) => m[1]);
  if (/\bKEYWORD_EXPANSIONS\b|\bresolveKeywordsWithMeta\b/.test(src)) deps.push('keyword-expansions.js');
  if (/__srLocation\b/.test(src)) deps.push('location-infer.js');
  return [...new Set(deps)];
}

function loaders() {
  const manifest = JSON.parse(read('manifest.json'));
  const popup = read('popup.js');
  const e2e = read('tests/e2e/notes-flow.spec.js');
  const popupList = popup.match(/files:\s*\[([^\]]*keyword-triage-core\.js[^\]]*)\]/)[1];
  return {
    'manifest.json': manifest.content_scripts.find((cs) => cs.all_frames).js,
    'popup.js ensureKeywordCore': popupList.match(/"[^"]+"/g).map((s) => s.slice(1, -1)),
    'notes-flow.spec.js': [...e2e.matchAll(/path\.join\(ROOT, "([^"]+)"\)/g)].map((m) => m[1]),
  };
}

describe('keyword modules load in dependency order', () => {
  for (const [name, list] of Object.entries(loaders())) {
    it(name, () => {
      for (const file of MODULES) {
        const at = list.indexOf(file);
        assert.ok(at >= 0, `${name} does not load ${file}`);
        for (const dep of prerequisites(file)) {
          const depAt = list.indexOf(dep);
          assert.ok(depAt >= 0 && depAt < at, `${name}: ${dep} must load before ${file}`);
        }
      }
    });
  }
});

describe('browser path (no require)', () => {
  it('the content scripts load in manifest order and expose the keyword entry points', () => {
    const files = loaders()['manifest.json'];
    const ctx = vm.createContext({ console, setTimeout, clearTimeout });
    ctx.globalThis = ctx;
    ctx.window = ctx;
    for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
    for (const fn of ['__srKeywordTriageRun', '__srKeywordTriageRunMulti', '__srKeywordTriageStartQueue',
                      '__srHarvestProfileUrls', '__srHasSrProfileChrome']) {
      assert.equal(typeof ctx[fn], 'function', fn);
    }
    for (const fn of ['queryDeepSelectorAll', 'findKeywordHits', 'getResumeText',
                      'harvestProfileUrls', 'postKeywordHitsToNotes', 'saveProfileDiag']) {
      assert.equal(typeof ctx.__srKw[fn], 'function', '__srKw.' + fn);
    }
  });

  it('a module loaded before one it needs fails at load, naming the missing file', () => {
    const ctx = vm.createContext({ console });
    ctx.globalThis = ctx;
    for (const f of ['sr-selectors.js', 'keyword-dom.js']) vm.runInContext(read(f), ctx, { filename: f });
    assert.throws(
      () => vm.runInContext(read('keyword-notes.js'), ctx, { filename: 'keyword-notes.js' }),
      /missing: load keyword-extract\.js before keyword-notes\.js/
    );
  });
});
