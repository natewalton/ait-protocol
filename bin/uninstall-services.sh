#!/bin/bash
# Stops + removes the three AIT launchd agents from ~/Library/LaunchAgents.
set -euo pipefail
TARGET="$HOME/Library/LaunchAgents"
for svc in plc pds appview; do
  dst="$TARGET/com.ait.$svc.plist"
  if [ -f "$dst" ]; then
    launchctl unload "$dst" 2>/dev/null || true
    rm -f "$dst"
    echo "removed com.ait.$svc"
  fi
done
