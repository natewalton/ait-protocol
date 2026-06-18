#!/bin/bash
# Wrapper that execs the AppView server (uses dotenv internally).
# Invoked by launchd via ~/Library/LaunchAgents/com.ait.appview.plist.
set -euo pipefail
cd "$(dirname "$0")/../appview"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
for cand in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -z "$NODE_BIN" ] && [ -x "$cand" ]; then NODE_BIN="$cand"; fi
done
exec "${NODE_BIN:?node not found on PATH — set NODE_BIN to your node binary}" --enable-source-maps dist/server.js
