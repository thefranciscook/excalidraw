#!/usr/bin/env bash
# Adds the board list, per-board sync and service-worker override to the Excalidraw build in /var/www/excalidraw.
set -euo pipefail
cd "$(dirname "$0")"
WEB=/var/www/excalidraw
cp server-sync.js boards.html sw.js "$WEB/"
grep -q 'server-sync.js' "$WEB/index.html" || sed -i 's#<head>#<head><script src="/server-sync.js"></script>#' "$WEB/index.html"
echo "Extras deployed."
