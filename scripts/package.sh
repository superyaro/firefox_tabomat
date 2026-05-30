#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' manifest.json | head -n 1)
PACKAGE="dist/url-to-window-router-${VERSION}.xpi"

mkdir -p dist
rm -f "$PACKAGE"

zip -r "$PACKAGE" \
  manifest.json \
  background.js \
  settings.js \
  options.html \
  options.js \
  options.css \
  icons \
  LICENSE \
  README.md >/dev/null

echo "$PACKAGE"
