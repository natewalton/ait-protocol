#!/bin/bash
# Stop this checkout's servers on the exact socket, including orphaned instances.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
DEFAULT_SOCK="${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}"
SOCK="${1:-$DEFAULT_SOCK}"
PIDFILE="${AIT_LOG_DIR:-/tmp}/ait-codex-appserver.pid"
source "$REPO/bin/lib-service-pids.sh"
CODEX_SOCK="$SOCK"

# A pre-bind startup holds the lock. Stop its verified server first so its wrapper
# can finish and release it. Taking the lock first would deadlock recovery.
stop_codex_pids "$(owned_codex_pids)"
mkdir -p "$(dirname "$SOCK")"
exec 9>>"$SOCK.start-lock"
while :; do
  lock_status=0
  /usr/bin/lockf -s -t 0 9 || lock_status=$?
  [ "$lock_status" -ne 0 ] || break
  [ "$lock_status" -eq 75 ] || exit "$lock_status"
  # An opener is not necessarily the lock holder. Recheck service ownership;
  # preserve a foreign startup and stop any own server that appeared meanwhile.
  remaining="$(running_pid codex-appserver)"
  stop_codex_pids "$(owned_codex_pids)"
  sleep 0.1
done
# A start could win the lock after the first scan. Cleanup and another scan are
# serialized with socket replacement, so no new owner's socket is unlinked.
stop_codex_pids "$(owned_codex_pids)"
remaining="$(running_pid codex-appserver)"
if [ -n "$remaining" ]; then echo "error: Codex server still owns its socket" >&2; exit 1; fi
rm -f "$SOCK"
if [ "$SOCK" = "$DEFAULT_SOCK" ]; then rm -f "$PIDFILE"; fi
echo "codex app-server: stopped owned servers on $SOCK"
