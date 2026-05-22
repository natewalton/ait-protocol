#!/bin/bash
# Stops the three AIT services started by bin/start-all.sh.
set -euo pipefail
LOGS=/tmp
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
