'use strict';
// tsc only checks the files listed in tests/typecheck/tsconfig.json, so a file that
// gains // @ts-check but isn't listed would silently go unchecked (and the reverse:
// a listed file without the comment isn't checked either, since checkJs is off).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TSCONFIG = path.join(ROOT, 'tests', 'typecheck', 'tsconfig.json');

const listed = JSON.parse(fs.readFileSync(TSCONFIG, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  .files.filter((f) => f.endsWith('.js'))
  .map((f) => path.basename(f));

const checked = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.js') && /^\s*\/\/ @ts-check\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));

describe('type-check coverage', () => {
  it('every // @ts-check file is listed in tests/typecheck/tsconfig.json', () => {
    assert.deepEqual(checked.filter((f) => !listed.includes(f)), []);
  });

  it('every listed file starts with // @ts-check', () => {
    assert.deepEqual(listed.filter((f) => !checked.includes(f)), []);
  });
});
