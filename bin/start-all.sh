#!/bin/bash
# Starts PLC, PDS, and AppView (plus Codex app-server when Codex is installed)
# as nohup+disown background processes from the current shell. They survive
# shell exit (reparented to init) but do NOT auto-restart on crash and do NOT
# survive reboot. Use bin/install-services.sh for that —
# requires granting bash Full Disk Access if the project lives under ~/Desktop.

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
LOGS="${AIT_LOG_DIR:-/tmp}"
mkdir -p "$LOGS"

# shellcheck source=bin/lib-service-pids.sh
. "$REPO/bin/lib-service-pids.sh"
check_managed_ports || exit 1
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

CODEX_START_GRACE_SECONDS="${AIT_TEST_CODEX_START_GRACE_SECONDS:-5}"

codex_protocol_ready() {
  local sock="${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}"
  [ -S "$sock" ] || return 1
  [ -f "$REPO/mcp/dist/codex/probe.js" ] || return 2
  command -v node >/dev/null 2>&1 || return 2
  node -e 'import(process.argv[1]).catch(() => { process.exitCode = 2 })' \
    "$REPO/mcp/dist/codex/probe.js" "$sock" 1000 >/dev/null 2>&1
}

service_event_pid() {
  if [ "$1" = codex-appserver ]; then
    [ -S "${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}" ] || return 0
  fi
  running_pid "$1"
}

wait_for_appview() {
  local pid=$1 adopted=$2 pidfile="$LOGS/ait-appview.pid" owner health
  STARTING_NAME=appview
  STARTING_PID="$pid"
  STARTING_PIDFILE="$pidfile"
  STARTING_ADOPTED="$adopted"
  while :; do
    owner="$(running_pid appview)" || return 1
    [ -z "$owner" ] || pid="$owner"
    STARTING_PID="$pid"
    health="$(appview_health)"
    if [ "$health" = running ]; then
      # A health response is not ownership evidence. Recheck the listener.
      owner="$(running_pid appview)" || return 1
      if [ -n "$owner" ]; then
        echo "$owner" > "$pidfile"
        echo "appview ready (pid $owner; local indexing running)"
        break
      fi
    elif [ "$health" != starting ] && [ "$health" != reconnecting ] && [ "$health" != unreachable ]; then
      echo "appview $health; inspect $LOGS/ait-appview.err before restarting" >&2
      FAILED="$FAILED appview"
      break
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "appview exited before local indexing became ready; see $LOGS/ait-appview.err" >&2
      rm -f "$pidfile"
      FAILED="$FAILED appview"
      break
    fi
    if ! curl -fsS --max-time 3 http://localhost:2582/_health >/dev/null 2>&1 ||
       ! curl -fsS --max-time 3 http://localhost:2583/xrpc/_health >/dev/null 2>&1; then
      echo "appview cannot become ready: mandatory PLC or PDS is unhealthy; inspect ait status" >&2
      FAILED="$FAILED appview"
      break
    fi
    echo "waiting for appview local indexing ($health); log: $LOGS/ait-appview.log (errors: $LOGS/ait-appview.err)"
    sleep 1
  done
  STARTING_NAME=""
  STARTING_PID=""
  STARTING_PIDFILE=""
  STARTING_ADOPTED=""
}

wait_for_codex() {
  local pid=$1 pidfile=$2 adopted=$3 owner probe_status started_at=$SECONDS
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
    # A concurrent launcher may have won and our wrapper may already have exited.
    # Follow the verified service, not the lifetime of the losing wrapper.
    owner="$(running_pid codex-appserver)" || return 1
    [ -z "$owner" ] || pid="$owner"
    probe_status=0
    codex_protocol_ready || probe_status=$?
    if [ "$probe_status" -eq 0 ]; then
      owner="$(running_pid codex-appserver)" || return 1
      [ -n "$owner" ] && pid="$owner"
      echo "$pid" > "$pidfile"
      echo "codex-appserver ready (pid $pid)"
      STARTING_NAME=""
      STARTING_PID=""
      STARTING_PIDFILE=""
      STARTING_ADOPTED=""
      return 0
    fi
    if [ "$probe_status" -ge 2 ]; then
      echo "codex-appserver health probe unavailable; run: npm --prefix '$REPO/mcp' ci && npm --prefix '$REPO/mcp' run build" >&2
      FAILED="$FAILED codex-appserver"
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
    if [ $((SECONDS - started_at)) -ge "$CODEX_START_GRACE_SECONDS" ]; then
      if [ -S "${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}" ]; then
        echo "codex-appserver protocol-unhealthy after ${CODEX_START_GRACE_SECONDS}s; run: ait stop; ait update; ait start" >&2
      else
        echo "codex-appserver did not bind its socket within ${CODEX_START_GRACE_SECONDS}s; see $LOGS/ait-codex-appserver.err" >&2
      fi
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

# Discover before starting; PID caches never authorize a duplicate launch.
# The Codex launcher also protects its socket independently of this caller.
start_one() {
  local name=$1 wrapper=$2
  local pidfile="$LOGS/ait-$name.pid" observable live
  live="$(running_pid "$name")" || return 1
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
    echo "$name already running (pid $live, adopted existing service)"
    if [ "$name" = appview ]; then wait_for_appview "$live" 1; fi
    return
  fi

  if [ "$name" = codex-appserver ]; then require_codex_native_lifecycle || return 1; fi
  rm -f "$pidfile"
  # Codex installs its own HUP/INT handlers; nohup alone cannot isolate it
  # from the launching terminal's process group.
  if [ "$name" = codex-appserver ]; then
    nohup /usr/bin/perl -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' "$REPO/bin/$wrapper" >> "$LOGS/ait-$name.log" 2>> "$LOGS/ait-$name.err" &
  else
    nohup "$REPO/bin/$wrapper" > "$LOGS/ait-$name.log" 2> "$LOGS/ait-$name.err" &
  fi
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
    live="$(service_event_pid "$name")" || return 1
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
  if [ "$name" = appview ]; then wait_for_appview "$live" 0; fi
  STARTING_NAME=""
  STARTING_PID=""
  STARTING_PIDFILE=""
}

start_one plc     run-plc.sh || FAILED="$FAILED plc"
start_one pds     run-pds.sh || FAILED="$FAILED pds"
start_one appview run-appview.sh || FAILED="$FAILED appview"
if command -v codex >/dev/null 2>&1; then
  start_one codex-appserver run-codex-appserver.sh || FAILED="$FAILED codex-appserver"
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
