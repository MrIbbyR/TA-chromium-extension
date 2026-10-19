#!/usr/bin/env node
// The manifest that goes into the distributable zip: manifest.json minus dev-only keys
// ("commands" holds the dev-reload shortcut). Used by package.sh; prints to stdout.
'use strict';

const DEV_ONLY_KEYS = ['commands'];

function shipManifest(manifest) {
  const out = { ...manifest };
  for (const k of DEV_ONLY_KEYS) delete out[k];
  return out;
}

if (require.main === module) {
  const manifest = require('../manifest.json');
  process.stdout.write(JSON.stringify(shipManifest(manifest), null, 2) + '\n');
}

module.exports = { shipManifest, DEV_ONLY_KEYS };
