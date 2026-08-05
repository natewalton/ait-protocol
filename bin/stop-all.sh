#!/bin/bash
# Stops the four AIT services started by bin/start-all.sh.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOGS=/tmp

# The codex app-server first, and by socket rather than pidfile: more than one
# can be running (see bin/stop-codex-appserver.sh), and the pidfile names only
# the most recent. This also reaps the MCP children it spawned.
"$REPO/bin/stop-codex-appserver.sh"

for name in plc pds appview; do
  pidfile="$LOGS/ait-$name.pid"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "stopped $name (pid $pid)"
    fi
    rm -f "$pidfile"
  else
    echo "$name not running (no pidfile)"
  fi
done
