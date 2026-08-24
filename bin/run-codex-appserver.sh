#!/bin/bash
# Wrapper that execs the SHARED codex app-server for AIT codex mode.
#
# ONE app-server serves every Codex session on the host: each session opens its
# own thread + AIT identity via thread/start config (specs/notification-codex.md).
# This server only registers the ait tool-MCP's command/args; per-session identity
# is supplied per-thread by each session process (mcp/src/codex/host.ts).
#
# Invoked by launchd via ~/Library/LaunchAgents/com.ait.codex-appserver.plist, or
# backgrounded by bin/start-all.sh. The socket path is derived from $HOME so the
# server and every session process agree on it regardless of launcher (see
# mcp/src/codex/paths.ts); AIT_CODEX_SHARED_SOCKET overrides it.
set -euo pipefail

# launchd defaults to a 256-descriptor soft limit. The shared app-server owns
# every session's MCP children, so raise its inherited capacity before exec.
ulimit -Sn 8192

REPO="$(cd "$(dirname "$0")/.." && pwd)"

sock="${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}"
mkdir -p "$(dirname "$sock")"
# Wind down any server still on this socket before taking it. Unlinking the
# socket alone (what this used to do) leaves that server running with the socket
# pulled out from under it: unreachable, but still holding MCP children that are
# logged in to the network. The helper also removes the socket file, which is
# what makes bind succeed.
"$REPO/bin/stop-codex-appserver.sh" "$sock"

AIT_SERVER="$REPO/mcp/dist/server.js"
if [ ! -f "$AIT_SERVER" ]; then
  echo "run-codex-appserver: $AIT_SERVER missing — run 'npm --prefix \"$REPO/mcp\" run build'" >&2
  exit 1
fi

# Resolve absolute binaries: under launchd PATH is minimal, and codex spawns the
# ait tool-MCP via `command=node`, so node must resolve too.
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
for cand in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  [ -z "$CODEX_BIN" ] && [ -x "$cand/codex" ] && CODEX_BIN="$cand/codex"
  [ -z "$NODE_BIN" ] && [ -x "$cand/node" ] && NODE_BIN="$cand/node"
done
: "${CODEX_BIN:?codex not found — set CODEX_BIN or add it to PATH}"
: "${NODE_BIN:?node not found — set NODE_BIN or add it to PATH}"

# Don't leak the operator's own AIT_* vars into the server (and thence child
# MCPs); each thread's ait tool-MCP gets AIT_SESSION_ID via thread/start config.
unset AIT_SESSION_ID AIT_NOTIFICATION_MODE

exec "$CODEX_BIN" app-server --listen "unix://$sock" \
  -c "mcp_servers.ait.command=$NODE_BIN" \
  -c "mcp_servers.ait.args=[\"$AIT_SERVER\"]"
