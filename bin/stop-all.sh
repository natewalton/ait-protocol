#!/bin/bash
# Stops the four AIT services started by bin/start-all.sh.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
LOGS="${AIT_LOG_DIR:-/tmp}"
failed=0

# The codex app-server first, and by socket rather than pidfile: more than one
# can be running (see bin/stop-codex-appserver.sh), and the pidfile names only
# the most recent. This also reaps the MCP children it spawned.
"$REPO/bin/stop-codex-appserver.sh" || failed=1

# shellcheck source=bin/lib-service-pids.sh
. "$REPO/bin/lib-service-pids.sh"

for name in plc pds appview; do
  pidfile="$LOGS/ait-$name.pid"
  if ! pid="$(running_pid "$name")"; then failed=1; continue; fi

  if [ -z "$pid" ]; then
    echo "$name not running"
    rm -f "$pidfile"
    continue
  fi

  service_owns_pid "$name" "$pid" || { echo "error: $name owner changed before stop" >&2; failed=1; continue; }
  kill "$pid" 2>/dev/null || true
  # Allow graceful process exit, then reverify identity before escalation.
  for _ in 1 2 3 4 5; do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    service_owns_pid "$name" "$pid" || { echo "error: $name owner changed before escalation" >&2; failed=1; continue; }
    kill -9 "$pid" 2>/dev/null || true
    echo "force-killed $name (pid $pid)"
  else
    echo "stopped $name (pid $pid)"
  fi
  rm -f "$pidfile"
done
exit "$failed"
