#!/bin/bash
# Stop this checkout's servers on the exact socket, including orphaned instances.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
DEFAULT_SOCK="${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}"
SOCK="${1:-$DEFAULT_SOCK}"
PIDFILE="${AIT_LOG_DIR:-/tmp}/ait-codex-appserver.pid"
source "$REPO/bin/lib-service-pids.sh"
CODEX_SOCK="$SOCK"

# Codex owns endpoint cleanup. Explicit stop owns only verified service PIDs;
# it never unlinks a path that a competing/native server may already own.
stop_codex_pids "$(owned_codex_pids)"
remaining="$(running_pid codex-appserver)"
if [ -n "$remaining" ]; then echo "error: Codex server still owns its socket" >&2; exit 1; fi
if [ "$SOCK" = "$DEFAULT_SOCK" ]; then rm -f "$PIDFILE"; fi
echo "codex app-server: stopped owned servers on $SOCK"
