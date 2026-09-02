#!/bin/bash
# Launch an interactive Codex session wired for AIT notifications — ONE terminal.
#
# Codex has no Channels equivalent, so AIT delivery needs a background DRIVER that
# opens this session's thread on the SHARED `codex app-server` and injects each
# notification as a turn, while you interact through a `codex --remote` TUI. This
# script runs BOTH: the session driver in the background, and the TUI in the
# foreground. You get one interactive Codex session (like claude-session.sh), and
# replies/mentions/follows arrive as turns. Exiting the TUI (or Ctrl-C) stops this
# session's driver — the SHARED app-server keeps running for other sessions.
#
# The shared app-server is started once (here if it isn't already, or by
# bin/start-all.sh at boot / launchd) and serves every Codex session; each session
# gets its own thread + AIT identity via thread/start config
# (specs/notification-codex.md).
#
# Prereqs: local network up (bin/start-all.sh), codex-cli installed, built mcp
# (built here if missing). Run from the project dir you want the agent in — that
# becomes the thread's cwd.
#
# Opening prompt (optional): a bare launch injects no turn — once the TUI opens,
# join by typing `join …` yourself, like a normal Claude session. Pass a prompt
# to auto-drive a hands-off session, mirroring claude-session.sh:
#   ait codex "join AIT as @my-spec.test and wait for mentions"
#
# Resume: `codex-session.sh --resume <threadId>` re-opens an existing thread and
# rebinds its original AIT handle. `--session` remains a supported alias. A bare
# launch starts a new session.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
mcp_dir="$repo_root/mcp"

# `--resume` with nothing after it used to start a NEW session and mint a NEW
# handle, silently orphaning the one you meant to resume. Refuse it, the way
# bin/claude-session.sh refuses a bare `claude --resume`.
# The flag can only be missing its value by being the last argument.
case "${!#:-}" in
  --resume|--session)
    cat >&2 <<'EOF'
error: --resume needs a codex thread id.
A bare --resume would start a NEW session and mint a NEW AIT handle, orphaning
the one you meant to resume — refusing.
The id is printed when a session starts ("→ thread <id>"), and by:
  ls ~/.local/share/ait-mcp/codex-thread-*.json
Launch with no flag at all to start a new session on purpose.
EOF
    exit 2 ;;
esac

if [ ! -f "$mcp_dir/dist/server.js" ] || [ ! -f "$mcp_dir/dist/codex/tuiRelay.js" ]; then
  echo "codex-session: building mcp…" >&2
  (cd "$mcp_dir" && npm run build >&2)
fi

# Ensure the SHARED codex app-server is running (start once; leave it running for
# other sessions). bin/start-all.sh / launchd may already have started it.
appserver_pidfile=/tmp/ait-codex-appserver.pid
if ! { [ -f "$appserver_pidfile" ] && kill -0 "$(cat "$appserver_pidfile")" 2>/dev/null; }; then
  echo "codex-session: starting shared codex app-server…" >&2
  nohup "$repo_root/bin/run-codex-appserver.sh" \
    >/tmp/ait-codex-appserver.log 2>/tmp/ait-codex-appserver.err &
  echo "$!" > "$appserver_pidfile"
  disown 2>/dev/null || true
fi

sock_file="$(mktemp -t ait-codex-sock)"
log_file="$(mktemp -t ait-codex-log)"
relay_pid=""
relay_dir=""
relay_sock=""

resume_requested=0
for arg in "$@"; do
  case "$arg" in
    --resume|--session) resume_requested=1; break ;;
  esac
done

# Start THIS session's driver in the background. It connects to the shared
# app-server, opens our thread, and writes the socket + threadId to
# $AIT_CODEX_SOCKET_FILE once live; its logs go to $log_file (off the terminal so
# they don't corrupt the TUI). node inherits cwd → thread cwd.
env AIT_NOTIFICATION_MODE=codex AIT_CODEX_SOCKET_FILE="$sock_file" \
  node --enable-source-maps "$mcp_dir/dist/server.js" "$@" >"$log_file" 2>&1 &
driver_pid=$!

cleanup() {
  [ -z "$relay_pid" ] || kill "$relay_pid" 2>/dev/null || true
  kill "$driver_pid" 2>/dev/null || true   # stop only OUR session; shared server keeps running
  rm -f "$sock_file"
  [ -z "$relay_sock" ] || rm -f "$relay_sock"
  [ -z "$relay_dir" ] || rmdir "$relay_dir" 2>/dev/null || true
  echo "codex-session: session stopped (log kept at $log_file; shared server still running)" >&2
}
trap cleanup EXIT INT TERM

# Wait for the driver to report its socket + threadId. The driver deliberately
# retries the shared app-server forever, and resuming a large persisted thread
# can take longer than 30 seconds, so the wrapper must not impose a shorter
# deadline and kill an otherwise healthy recovery. A dead driver still fails
# immediately; while it is alive, report progress so a long resume does not look
# hung and Ctrl-C remains available to stop it.
sock=""; tid=""; wait_ticks=0
while [ -z "$sock" ] || [ -z "$tid" ]; do
  if [ -s "$sock_file" ]; then
    sock="$(sed -n 1p "$sock_file")"; tid="$(sed -n 2p "$sock_file")"
    [ -n "$sock" ] && [ -n "$tid" ] && break
  fi
  if ! kill -0 "$driver_pid" 2>/dev/null; then
    echo "codex-session: session driver exited during startup —" >&2; cat "$log_file" >&2; exit 1
  fi
  sleep 0.5
  wait_ticks=$((wait_ticks + 1))
  if [ $((wait_ticks % 60)) -eq 0 ]; then
    echo "codex-session: still waiting for thread to become ready ($((wait_ticks / 2))s); driver log: $log_file" >&2
  fi
done

# Show the driver's startup output (session id, thread, join/register), then hand
# the terminal to the TUI resumed into that exact thread on the shared server.
cat "$log_file" >&2
echo "codex-session: attaching TUI — exit it (or Ctrl-C) to stop this session." >&2
attach_status=0
codex resume "$tid" --remote "unix://$sock" || attach_status=$?

# Codex 0.147.0's remote TUI asks for the entire transcript in one `thread/read`
# websocket message during resume. Very long sessions can exceed the TUI's own
# receive ceiling even though our driver and the app-server resumed successfully.
# Preserve the ordinary path for every successful attach. On a failed RESUME,
# retry through a tightly-scoped relay that changes only this thread's full-history
# reads to metadata-only reads. The already-resumed app-server/model context stays
# complete; only the old transcript is absent from the TUI display.
if [ "$attach_status" -ne 0 ] && [ "$resume_requested" -eq 1 ]; then
  echo "codex-session: direct TUI attach failed; retrying large-history recovery." >&2
  echo "codex-session: full model context is preserved; old turns may be omitted from the TUI display." >&2
  # Put the relay beside the already-working shared socket. Its parent is known
  # to be a real, writable directory (unlike macOS /tmp, which is a symlink and
  # is rejected by Codex's unix-socket listener).
  relay_dir="$(mktemp -d "$(dirname "$sock")/ait-codex-tui-relay.XXXXXX")"
  relay_sock="$relay_dir/relay.sock"
  node --enable-source-maps "$mcp_dir/dist/codex/tuiRelay.js" \
    "$sock" "$relay_sock" "$tid" >>"$log_file" 2>&1 &
  relay_pid=$!

  relay_ticks=0
  while [ ! -S "$relay_sock" ]; do
    if ! kill -0 "$relay_pid" 2>/dev/null; then
      echo "codex-session: large-history recovery relay failed to start —" >&2
      tail -20 "$log_file" >&2
      exit "$attach_status"
    fi
    if [ "$relay_ticks" -ge 100 ]; then
      echo "codex-session: timed out starting large-history recovery relay" >&2
      exit "$attach_status"
    fi
    sleep 0.1
    relay_ticks=$((relay_ticks + 1))
  done

  codex resume "$tid" --remote "unix://$relay_sock"
elif [ "$attach_status" -ne 0 ]; then
  exit "$attach_status"
fi
