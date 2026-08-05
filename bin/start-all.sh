#!/bin/bash
# Starts PLC, PDS, AppView as nohup+disown background processes from the current
# shell. They survive shell exit (reparented to init) but do NOT auto-restart
# on crash and do NOT survive reboot. Use bin/install-services.sh for that —
# requires granting bash Full Disk Access if the project lives under ~/Desktop.

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOGS=/tmp
mkdir -p "$LOGS"

CODEX_SOCK="${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}"
FAILED=""

# The pid holding this service's resource right now, or empty. Asks the resource
# itself — the listening port, or the app-server socket — rather than trusting a
# pidfile. A pidfile can be missing while the service runs: it is written by
# whoever started it, so a service started by launchd, by bin/codex-session.sh,
# or by a shell whose /tmp was cleared has none.
#
# For the port services the pid is only accepted when its working directory is
# inside this repo. Otherwise an unrelated program that happened to take 2583
# would be adopted as "the PDS", and the real one would never start.
ours() {
  local pid=$1 cwd
  [ -n "$pid" ] || return 1
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  case "$cwd" in "$REPO"/*|"$REPO") return 0 ;; *) return 1 ;; esac
}

running_pid() {
  local pid=""
  case "$1" in
    plc)     pid="$(lsof -nP -iTCP:2582 -sTCP:LISTEN -t 2>/dev/null | head -1)" ;;
    pds)     pid="$(lsof -nP -iTCP:2583 -sTCP:LISTEN -t 2>/dev/null | head -1)" ;;
    appview) pid="$(lsof -nP -iTCP:2585 -sTCP:LISTEN -t 2>/dev/null | head -1)" ;;
    codex-appserver)
      # The socket path in the command line is already unique to this host's
      # shared server, so no cwd check is needed (and codex runs from the
      # session's directory, not the repo).
      { pgrep -f "codex app-server --listen unix://$CODEX_SOCK" || true; } | head -1
      return ;;
  esac
  # Always succeeds, printing nothing when there is no instance. A non-zero
  # return here would abort the script at the caller's `live="$(running_pid …)"`
  # assignment under `set -e`, before it could report anything.
  if ours "$pid"; then printf '%s' "$pid"; fi
  return 0
}

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
