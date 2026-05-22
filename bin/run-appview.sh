#!/bin/bash
# Wrapper that execs the AppView server (uses dotenv internally).
# Invoked by launchd via ~/Library/LaunchAgents/com.ait.appview.plist.
set -euo pipefail
cd "$(dirname "$0")/../appview"
exec /opt/homebrew/bin/node --enable-source-maps dist/server.js
