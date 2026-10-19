#!/usr/bin/env bash
# Build the distributable extension zip: dist/niq-ta-helper-v<version>.zip
# Ships only runtime files — tests, docs, dev config and unused assets are excluded.
# Used by CI; run locally with: ./scripts/package.sh
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/niq-ta-helper-v${VERSION}.zip"

rm -rf dist && mkdir -p dist
zip -qr "$OUT" . \
  -x '.git/*' '.github/*' '.claude/*' '.gitignore' '*.DS_Store' \
     'tests/*' 'scripts/*' 'dist/*' '*.md' '*.zip' 'NIQ logo.png'

# Swap in the shipped manifest: no dev-only keys (the dev-reload shortcut).
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
node scripts/ship-manifest.js > "$STAGE/manifest.json"
(cd "$STAGE" && zip -q "$OLDPWD/$OUT" manifest.json)

# Sanity check: manifest.json must be at the zip root or Chrome rejects the upload.
# grep without -q reads all input: -q exits on the first match, and under pipefail the
# SIGPIPE that kills unzip would fail the check even though the manifest is there.
unzip -Z1 "$OUT" | grep -x 'manifest.json' >/dev/null || { echo "manifest.json missing from zip root" >&2; exit 1; }

echo "$OUT"
unzip -l "$OUT" | tail -1
