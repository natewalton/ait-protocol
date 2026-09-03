#!/bin/bash
# Starts PLC, PDS, and AppView (plus Codex app-server when Codex is installed)
# as nohup+disown background processes from the current shell. They survive
# shell exit (reparented to init) but do NOT auto-restart on crash and do NOT
# survive reboot. Use bin/install-services.sh for that —
# requires granting bash Full Disk Access if the project lives under ~/Desktop.

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="${AIT_LOG_DIR:-/tmp}"
mkdir -p "$LOGS"

# shellcheck source=bin/lib-service-pids.sh
. "$REPO/bin/lib-service-pids.sh"
FAILED=""
STARTING_NAME=""
STARTING_PID=""
STARTING_PIDFILE=""
STARTING_ADOPTED=""

interrupt_start() {
  local live=""
  trap - INT TERM
  if [ -n "$STARTING_NAME" ]; then
    live="$(service_event_pid "$STARTING_NAME")"
    if [ -n "$live" ]; then
      echo "$live" > "$STARTING_PIDFILE"
      echo "Interrupted while waiting for $STARTING_NAME; it is bound with pid $live (pidfile retained at $STARTING_PIDFILE)" >&2
    elif [ "${STARTING_ADOPTED:-0}" = 1 ]; then
      if [ -n "$STARTING_PID" ] && kill -0 "$STARTING_PID" 2>/dev/null; then
        echo "Interrupted while waiting for $STARTING_NAME; adopted pid $STARTING_PID remains running without its socket; no pidfile retained" >&2
      else
        echo "Interrupted while waiting for $STARTING_NAME; adopted pid ${STARTING_PID:-unknown} is no longer running; no pidfile retained" >&2
      fi
      rm -f "$STARTING_PIDFILE"
    else
      rm -f "$STARTING_PIDFILE"
      if [ -n "$STARTING_PID" ] && kill -0 "$STARTING_PID" 2>/dev/null; then
        kill "$STARTING_PID" 2>/dev/null || true
        echo "Interrupted while waiting for $STARTING_NAME; stopped wrapper pid $STARTING_PID" >&2
      else
        echo "Interrupted while waiting for $STARTING_NAME; wrapper pid ${STARTING_PID:-unknown} is no longer running; no pidfile retained" >&2
      fi
    fi
  fi
  exit 130
}
trap interrupt_start INT TERM

codex_socket_ready() {
  local sock="${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}"
  [ -S "$sock" ] || return 1
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket,sys
s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
s.close()' "$sock" >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -zU "$sock" >/dev/null 2>&1
  else
    return 1
  fi
}

service_event_pid() {
  if [ "$1" = codex-appserver ]; then
    codex_socket_ready || return 0
  fi
  running_pid "$1"
}

wait_for_codex() {
  local pid=$1 pidfile=$2 adopted=$3 owner
  STARTING_NAME="codex-appserver"
  STARTING_PID="$pid"
  STARTING_PIDFILE="$pidfile"
  STARTING_ADOPTED="$adopted"
  if [ "$adopted" -eq 1 ]; then
    if [ "$4" = socket ]; then
      echo "codex-appserver already running (pid $pid, adopted — socket owner); waiting for socket"
    else
      echo "codex-appserver already running (pid $pid, adopted — discovered before socket bind); waiting for socket"
    fi
  fi
  while :; do
    if codex_socket_ready; then
      owner="$(running_pid codex-appserver)"
      [ -n "$owner" ] && pid="$owner"
      echo "$pid" > "$pidfile"
      echo "codex-appserver ready (pid $pid)"
      STARTING_NAME=""
      STARTING_PID=""
      STARTING_PIDFILE=""
      STARTING_ADOPTED=""
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "codex-appserver process exited before binding socket; see $LOGS/ait-codex-appserver.err" >&2
      rm -f "$pidfile"
      FAILED="$FAILED codex-appserver"
      STARTING_NAME=""
      STARTING_PID=""
      STARTING_PIDFILE=""
      STARTING_ADOPTED=""
      return 0
    fi
    echo "waiting for codex-appserver socket ${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}; log: $LOGS/ait-codex-appserver.log (errors: $LOGS/ait-codex-appserver.err)"
    sleep 1
  done
}

# Starting a second copy of a service that is already up is never harmless. A
# port service dies on EADDRINUSE, leaving a pidfile that names a process which
# is already gone. The codex app-server is worse: bin/run-codex-appserver.sh
# stops whatever holds the socket first, so a second start would kill the live
# server and every session MCP child under it. So: look for a real instance, and
# adopt it into the pidfile rather than starting anything.
start_one() {
  local name=$1 wrapper=$2
  local pidfile="$LOGS/ait-$name.pid" observable live
  if [ "$name" != codex-appserver ] && [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$pidfile"))"
    return
  fi

  live="$(running_pid "$name")"
  if [ -n "$live" ]; then
    echo "$live" > "$pidfile"
    if [ "$name" = codex-appserver ]; then
      if [ -S "${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}" ]; then
        wait_for_codex "$live" "$pidfile" 1 socket
      else
        wait_for_codex "$live" "$pidfile" 1 prebind
      fi
      return
    fi
    echo "$name already running (pid $live, adopted — it had no pidfile)"
    return
  fi

  nohup "$REPO/bin/$wrapper" > "$LOGS/ait-$name.log" 2> "$LOGS/ait-$name.err" &
  local pid=$!
  STARTING_NAME="$name"
  STARTING_PID="$pid"
  STARTING_PIDFILE="$pidfile"
  STARTING_ADOPTED=0
  disown

  if [ "$name" = codex-appserver ]; then
    wait_for_codex "$pid" "$pidfile" 0 launched
    return
  fi

  # Wait for the service's process/resource event before claiming success. The
  # sleep is only a progress cadence; there is no elapsed-time failure verdict.
  while :; do
    live="$(service_event_pid "$name")"
    if [ -n "$live" ]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name wrapper exited before binding its listener/socket; see $LOGS/ait-$name.err" >&2
      rm -f "$pidfile"
      FAILED="$FAILED $name"
      STARTING_NAME=""
      STARTING_PID=""
      STARTING_PIDFILE=""
      return 0
    fi
    case "$name" in
      plc) observable="TCP port 2582" ;;
      pds) observable="TCP port 2583" ;;
      appview) observable="TCP port 2585" ;;
      codex-appserver) observable="socket ${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}" ;;
    esac
    echo "waiting for $name $observable; log: $LOGS/ait-$name.log (errors: $LOGS/ait-$name.err)"
    sleep 1
  done

  echo "$live" > "$pidfile"
  echo "started $name (pid $live)"
  STARTING_NAME=""
  STARTING_PID=""
  STARTING_PIDFILE=""
}

start_one plc     run-plc.sh
start_one pds     run-pds.sh
start_one appview run-appview.sh
if command -v codex >/dev/null 2>&1; then
  start_one codex-appserver run-codex-appserver.sh
else
  echo "codex-appserver skipped (not installed)"
fi

# Keep one read-only health implementation for the supervisor and public CLI.
echo ""
status=0
if "$REPO/bin/status.sh"; then
  status=0
else
  status=$?
fi
echo ""
echo "Logs: tail -f $LOGS/ait-{plc,pds,appview,codex-appserver}.{log,err}"
echo "(codex-appserver is the shared codex app-server — a unix socket, no HTTP port;"
echo " needs mcp built: npm --prefix mcp run build. Codex sessions attach via bin/codex-session.sh.)"
echo "Stop: bin/stop-all.sh"

if [ -n "$FAILED" ]; then
  echo ""
  echo "DID NOT START:$FAILED — check $LOGS/ait-<name>.err" >&2
  exit 1
fi
exit "$status"
