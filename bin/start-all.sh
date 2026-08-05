#!/bin/bash
# Starts PLC, PDS, AppView as nohup+disown background processes from the current
# shell. They survive shell exit (reparented to init) but do NOT auto-restart
# on crash and do NOT survive reboot. Use bin/install-services.sh for that —
# requires granting bash Full Disk Access if the project lives under ~/Desktop.

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOGS=/tmp
mkdir -p "$LOGS"

# shellcheck source=bin/lib-service-pids.sh
. "$REPO/bin/lib-service-pids.sh"
FAILED=""

# Starting a second copy of a service that is already up is never harmless. A
# port service dies on EADDRINUSE, leaving a pidfile that names a process which
# is already gone. The codex app-server is worse: bin/run-codex-appserver.sh
# stops whatever holds the socket first, so a second start would kill the live
# server and every session MCP child under it. So: look for a real instance, and
# adopt it into the pidfile rather than starting anything.
start_one() {
  local name=$1 wrapper=$2
  local pidfile="$LOGS/ait-$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$pidfile"))"
    return
  fi

  local live
  live="$(running_pid "$name")"
  if [ -n "$live" ]; then
    echo "$live" > "$pidfile"
    echo "$name already running (pid $live, adopted — it had no pidfile)"
    return
  fi

  nohup "$REPO/bin/$wrapper" > "$LOGS/ait-$name.log" 2> "$LOGS/ait-$name.err" &
  local pid=$!
  disown

  # Wait for the service to take its port or socket before claiming success.
  # Writing the pidfile unconditionally is how a crashed start used to leave a
  # pidfile naming a dead process.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    live="$(running_pid "$name")"
    if [ -n "$live" ]; then break; fi
    # Wrapper already exited, so it failed — stop waiting on it.
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 1
  done

  if [ -z "$live" ]; then
    echo "$name FAILED to start — see $LOGS/ait-$name.err" >&2
    rm -f "$pidfile"
    FAILED="$FAILED $name"
    return 0   # keep going: one dead service must not skip the others
  fi
  echo "$live" > "$pidfile"
  echo "started $name (pid $live)"
}

start_one plc     run-plc.sh
start_one pds     run-pds.sh
start_one appview run-appview.sh
start_one codex-appserver run-codex-appserver.sh

echo ""
echo "Health (give it ~3 seconds) — ports 2582 PLC, 2583 PDS, 2585 AppView:"
echo "  curl http://localhost:2582/_health"
echo "  curl http://localhost:2583/xrpc/_health"
echo "  curl http://localhost:2585/xrpc/_health"
echo ""
echo "Logs: tail -f /tmp/ait-{plc,pds,appview,codex-appserver}.{log,err}"
echo "(codex-appserver is the shared codex app-server — a unix socket, no HTTP port;"
echo " needs mcp built: npm --prefix mcp run build. Codex sessions attach via bin/codex-session.sh.)"
echo "Stop: bin/stop-all.sh"

if [ -n "$FAILED" ]; then
  echo ""
  echo "DID NOT START:$FAILED — check /tmp/ait-<name>.err" >&2
  exit 1
fi
