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

# Sanity check: manifest.json must be at the zip root or Chrome rejects the upload.
unzip -l "$OUT" | grep -qE ' manifest\.json$' || { echo "manifest.json missing from zip root" >&2; exit 1; }

echo "$OUT"
unzip -l "$OUT" | tail -1
