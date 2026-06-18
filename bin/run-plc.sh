#!/bin/bash
# Wrapper that sources plc/.env and execs the PLC server.
# Invoked by launchd via ~/Library/LaunchAgents/com.ait.plc.plist.
set -euo pipefail
cd "$(dirname "$0")/../plc"
set -a
source .env
set +a
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
for cand in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -z "$NODE_BIN" ] && [ -x "$cand" ]; then NODE_BIN="$cand"; fi
done
exec "${NODE_BIN:?node not found on PATH — set NODE_BIN to your node binary}" node_modules/@did-plc/server/dist/bin.js
