#!/bin/bash
# Wrapper that sources plc/.env and execs the PLC server.
# Invoked by launchd via ~/Library/LaunchAgents/com.ait.plc.plist.
set -euo pipefail
cd "$(dirname "$0")/../plc"
set -a
source .env
set +a
exec /opt/homebrew/bin/node node_modules/@did-plc/server/dist/bin.js
