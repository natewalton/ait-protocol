#!/bin/bash
# Launch a Codex session wired for AIT notifications (AIT_NOTIFICATION_MODE=codex).
#
# Codex has no Channels equivalent, so this does NOT launch `codex` directly. It
# launches the ait MCP server in `codex` mode — the LAUNCHER — which spawns and
# drives `codex app-server` as a sidecar and injects each AIT notification into
# the running thread as a turn/start. The launcher prints a
#   codex --remote unix://…
# line; run that in another terminal to attach a live TUI to the session.
#
# The session pre-mints its AIT identity before the thread starts (Codex freezes
# a child MCP's env at spawn, so the handle can't be bound afterward — see
# specs/notification-codex.md). Tools and pushes share that one handle.
#
# Prereqs: the local network up (bin/start-all.sh), codex-cli installed, and a
# built mcp (this script builds it if dist is missing). Run it from the project
# directory you want the Codex agent working in — that becomes the thread's cwd.
#
# v1 slice: new session only. Resume (codex-session.sh --session <threadId> to
# re-bind the same AIT handle via the {threadId→UUID} map) is coming; extra args
# pass through for it.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
mcp_dir="$repo_root/mcp"

if [ ! -f "$mcp_dir/dist/server.js" ]; then
  echo "codex-session: building mcp…" >&2
  (cd "$mcp_dir" && npm run build >&2)
fi

# node inherits the current directory, so the launcher's process.cwd() — and thus
# the Codex thread's cwd — is wherever you invoked this from. AIT_NOTIFICATION_MODE
# =codex selects the launcher role in server.ts's main().
exec env AIT_NOTIFICATION_MODE=codex node --enable-source-maps "$mcp_dir/dist/server.js" "$@"
