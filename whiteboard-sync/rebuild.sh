#!/usr/bin/env bash
# Rebuild Excalidraw from the fork and redeploy to /var/www/excalidraw (served by Caddy at whiteboard.supa.company).
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
SRC=$(mktemp -d)
trap 'rm -rf "$SRC"' EXIT
export PATH=~/.local/bin:$PATH
git clone --depth 1 https://github.com/thefranciscook/excalidraw.git "$SRC"
cd "$SRC"
yarn --frozen-lockfile --network-timeout 600000
cp "$HERE/vite.selfhost.config.mts" excalidraw-app/
cd excalidraw-app
NODE_ENV=production VITE_APP_DISABLE_SENTRY=true NODE_OPTIONS=--max-old-space-size=1200 npx vite build --config vite.selfhost.config.mts
rsync -a --delete build/ /var/www/excalidraw/
"$HERE/deploy-extras.sh"
yarn cache clean
echo "Deployed."
