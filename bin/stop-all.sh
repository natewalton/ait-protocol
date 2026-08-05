#!/bin/bash
# Stops the four AIT services started by bin/start-all.sh.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOGS=/tmp

# The codex app-server first, and by socket rather than pidfile: more than one
# can be running (see bin/stop-codex-appserver.sh), and the pidfile names only
# the most recent. This also reaps the MCP children it spawned.
"$REPO/bin/stop-codex-appserver.sh"

# shellcheck source=bin/lib-service-pids.sh
. "$REPO/bin/lib-service-pids.sh"

for name in plc pds appview; do
  pidfile="$LOGS/ait-$name.pid"
  pid=""
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    pid="$(cat "$pidfile")"
  else
    # No usable pidfile. Ask the port instead of assuming nothing is running —
    # assuming was how orphaned services survived a "successful" stop-all, still
    # holding their ports and still on the network.
    pid="$(running_pid "$name")"
    if [ -n "$pid" ]; then
      echo "$name has no pidfile; found it on its port (pid $pid)"
    fi
  fi

  if [ -z "$pid" ]; then
    echo "$name not running"
    rm -f "$pidfile"
    continue
  fi

  kill "$pid" 2>/dev/null || true
  # Wait for the port to come free, then force it. A service that keeps its port
  # after a "stop" is the failure this whole path exists to prevent.
  for _ in 1 2 3 4 5; do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    echo "force-killed $name (pid $pid)"
  else
    echo "stopped $name (pid $pid)"
  fi
  rm -f "$pidfile"
done
