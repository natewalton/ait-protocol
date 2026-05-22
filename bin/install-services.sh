#!/bin/bash
# Installs the three AIT launchd agents (PLC, PDS, AppView) into ~/Library/LaunchAgents
# and starts them. Idempotent — re-running unloads + reloads.
#
# IMPORTANT: macOS TCC blocks launchd from executing scripts under
# ~/Desktop, ~/Documents, ~/Downloads, etc. without Full Disk Access.
# If the project lives under one of those, either:
#   1. System Settings -> Privacy & Security -> Full Disk Access -> add /bin/bash
#   2. Or move the project to ~/code/ or similar unprotected location
#   3. Or use bin/start-all.sh instead (no auto-restart, no boot survival)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$HOME/Library/LaunchAgents"
mkdir -p "$TARGET"

for svc in plc pds appview; do
  label="com.ait.$svc"
  src="$REPO/services/$label.plist"
  dst="$TARGET/$label.plist"

  if [ ! -f "$src" ]; then
    echo "missing source plist: $src" >&2
    exit 1
  fi

  # Unload any previous version first (ignore errors if it wasn't loaded).
  launchctl unload "$dst" 2>/dev/null || true

  cp "$src" "$dst"
  launchctl load -w "$dst"
  echo "installed $label (-> $dst)"
done

echo ""
echo "Tail logs with:"
echo "  tail -f /tmp/ait-{plc,pds,appview}.log /tmp/ait-{plc,pds,appview}.err"
echo ""
echo "Stop everything with:"
echo "  bin/uninstall-services.sh"
