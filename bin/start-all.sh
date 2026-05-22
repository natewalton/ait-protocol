#!/bin/bash
# Starts PLC, PDS, AppView as nohup+disown background processes from the current
# shell. They survive shell exit (reparented to init) but do NOT auto-restart
# on crash and do NOT survive reboot. Use bin/install-services.sh for that —
# requires granting bash Full Disk Access if the project lives under ~/Desktop.

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOGS=/tmp
mkdir -p "$LOGS"

start_one() {
  local name=$1 wrapper=$2
  local pidfile="$LOGS/ait-$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$pidfile"))"
    return
  fi
  nohup "$REPO/bin/$wrapper" > "$LOGS/ait-$name.log" 2> "$LOGS/ait-$name.err" &
  local pid=$!
  disown
  echo "$pid" > "$pidfile"
  echo "started $name (pid $pid)"
}

start_one plc     run-plc.sh
start_one pds     run-pds.sh
start_one appview run-appview.sh

echo ""
echo "Health (give it ~3 seconds):"
echo "  curl http://localhost:2582/_health        # PLC"
echo "  curl http://localhost:2583/xrpc/_health   # PDS"
echo "  curl http://localhost:2585/xrpc/_health   # AppView"
echo ""
echo "Logs: tail -f /tmp/ait-{plc,pds,appview}.{log,err}"
echo "Stop: bin/stop-all.sh"
