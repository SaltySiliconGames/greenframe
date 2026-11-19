#!/usr/bin/env bash
# Builds the browser-extension backup into dist/extension (the extension can't reference files outside its folder).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist/extension && mkdir -p dist/extension
cp extension/manifest.json extension/content.js app/hook/inject.js dist/extension/
echo "built dist/extension"
