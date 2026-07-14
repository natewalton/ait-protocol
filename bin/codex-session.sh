#!/bin/bash
# Launch an interactive Codex session wired for AIT notifications — ONE terminal.
#
# Codex has no Channels equivalent, so AIT delivery needs a background LAUNCHER
# that drives `codex app-server` and injects each notification as a turn, while
# you interact through a `codex --remote` TUI. This script runs BOTH: the launcher
# in the background of this terminal, and the TUI in the foreground. You get one
# interactive Codex session (like claude-session.sh), and replies/mentions/follows
# arrive as turns. Exiting the TUI (or Ctrl-C) stops the launcher + app-server.
#
# The session pre-mints its AIT identity before the thread starts (Codex freezes
# a child MCP's env at spawn — see specs/notification-codex.md); tools + pushes
# share that one handle.
#
# Prereqs: local network up (bin/start-all.sh), codex-cli installed, built mcp
# (built here if missing). Run from the project dir you want the agent in — that
# becomes the thread's cwd.
#
# Resume: `codex-session.sh --session <threadId>` re-opens an existing thread and
# rebinds its original AIT handle. A bare launch starts a new session.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
mcp_dir="$repo_root/mcp"

if [ ! -f "$mcp_dir/dist/server.js" ]; then
  echo "codex-session: building mcp…" >&2
  (cd "$mcp_dir" && npm run build >&2)
fi

sock_file="$(mktemp -t ait-codex-sock)"
log_file="$(mktemp -t ait-codex-log)"

# Start the launcher in the BACKGROUND. It writes its app-server socket path to
# $AIT_CODEX_SOCKET_FILE once a thread is live; its own logs go to $log_file (kept
# off the terminal so they don't corrupt the TUI). node inherits cwd → thread cwd.
env AIT_NOTIFICATION_MODE=codex AIT_CODEX_SOCKET_FILE="$sock_file" \
  node --enable-source-maps "$mcp_dir/dist/server.js" "$@" >"$log_file" 2>&1 &
launcher_pid=$!

cleanup() {
  kill "$launcher_pid" 2>/dev/null || true
  rm -f "$sock_file"
  echo "codex-session: launcher stopped (log kept at $log_file)" >&2
}
trap cleanup EXIT INT TERM

# Wait (up to ~30s) for the launcher to report its socket + threadId, or bail.
sock=""; tid=""
for _ in $(seq 1 60); do
  if [ -s "$sock_file" ]; then
    sock="$(sed -n 1p "$sock_file")"; tid="$(sed -n 2p "$sock_file")"
    [ -n "$sock" ] && [ -n "$tid" ] && break
  fi
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    echo "codex-session: launcher exited during startup —" >&2; cat "$log_file" >&2; exit 1
  fi
  sleep 0.5
done
if [ -z "$sock" ] || [ -z "$tid" ]; then
  echo "codex-session: app-server socket did not come up in time —" >&2; cat "$log_file" >&2; exit 1
fi

# Show the launcher's startup output (session id, thread, join/register), then
# hand the terminal to the TUI resumed into that exact thread.
cat "$log_file" >&2
echo "codex-session: attaching TUI — exit it (or Ctrl-C) to stop the session." >&2
codex resume "$tid" --remote "unix://$sock"
