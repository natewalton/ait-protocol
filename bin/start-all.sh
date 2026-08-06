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

# Report health rather than printing commands for the reader to run. The three
# HTTP services answer a health endpoint; the codex app-server has no port, so
# it is probed by connecting to its unix socket — the same thing a session does.
probe_http() {
  if curl -fsS --max-time 3 "$1" >/dev/null 2>&1; then echo ok; else echo UNREACHABLE; fi
}

PROBE_UNIX_SOCKET='import socket,sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(2)
s.connect(sys.argv[1])
s.close()'

probe_socket() {
  if [ ! -S "$1" ]; then echo "NO SOCKET"; return; fi
  # No python3 means no connect test, but the socket file is there and
  # start_one already confirmed a server holds it — don't cry UNREACHABLE.
  if ! command -v python3 >/dev/null 2>&1; then echo "socket present"; return; fi
  if python3 -c "$PROBE_UNIX_SOCKET" "$1" 2>/dev/null; then echo ok; else echo UNREACHABLE; fi
}

echo ""
echo "Health:"
printf '  %-16s %s\n' plc             "$(probe_http http://localhost:2582/_health)"
printf '  %-16s %s\n' pds             "$(probe_http http://localhost:2583/xrpc/_health)"
printf '  %-16s %s\n' appview         "$(probe_http http://localhost:2585/xrpc/_health)"
printf '  %-16s %s\n' codex-appserver "$(probe_socket "$CODEX_SOCK")"
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
