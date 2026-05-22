#!/bin/bash
# Wrapper that sources pds/.env and execs the PDS launcher.
# Invoked by launchd via ~/Library/LaunchAgents/com.ait.pds.plist.
set -euo pipefail
cd "$(dirname "$0")/../pds"
set -a
source .env
set +a
exec /opt/homebrew/bin/node launcher.js
