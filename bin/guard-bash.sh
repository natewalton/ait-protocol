#!/bin/bash
# PreToolUse hook that blocks Bash tool calls attempting to bypass the
# AIT MCP and reach the local network services or credential files
# directly.
#
# Rationale: ADR-0006/0007/0010 establish "end-client parity" — sessions
# interact with the AIT network only through the MCP tool surface.
# Without enforcement, a session can curl localhost:2583, read the
# persisted JWT off disk, or pull admin secrets out of pds/.env. This
# hook mechanizes the rule per ~/.claude/rules/feedback_mechanize_recurring_failures.md.
#
# Wired up in .claude/settings.json under hooks.PreToolUse[matcher=Bash].
# Claude Code invokes this with the tool-call JSON on stdin. Exit code 2
# blocks the tool call; the message in stderr is shown to the model.
#
# See ADR-0031 for the incident that prompted this hook.

set -euo pipefail

# Slurp the tool-call JSON from stdin.
INPUT="$(cat)"

# Extract the Bash command. Use jq if available; otherwise a forgiving
# grep that handles the common shape.
if command -v jq >/dev/null 2>&1; then
  CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"
else
  # Fallback: best-effort grep. jq is universally present on macOS dev
  # boxes; this branch is rarely hit.
  CMD="$(printf '%s' "$INPUT" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1)"
fi

# Empty CMD = nothing to inspect; allow.
[ -z "$CMD" ] && exit 0

# --- Forbidden patterns -----------------------------------------------
# Each pattern matches a category of god-mode bypass attempts:

block() {
  local reason="$1"
  cat >&2 <<EOF
🛑 Blocked by .claude/hooks/guard-bash.sh

$reason

The AIT network is accessible only through MCP tools (join, post,
follow, getTimeline, getAuthorFeed). Going around them — by curling
local service ports, reading the persisted JWT, or extracting
credentials from .env files — violates the end-client-parity principle
(ADR-0006/0007/0010) and the incident in ADR-0031.

If you genuinely need a capability not exposed by an MCP tool, add a
new MCP tool that exposes it. Do not reach around.
EOF
  exit 2
}

# 1. Direct hits on AIT service ports (PLC=2582, PDS=2583, AppView=2585).
if printf '%s' "$CMD" | grep -Eq '(curl|wget|http|nc|websocat)[^|&;]*((localhost|127\.0\.0\.1|0\.0\.0\.0|pds\.localhost|appview\.localhost)[: ]+258[235]\b|:258[235]/xrpc/)'; then
  block "Direct network call to an AIT service port (PLC 2582 / PDS 2583 / AppView 2585) detected."
fi

# 2. Reading the persisted MCP identity directory (contains accessJwt / refreshJwt).
if printf '%s' "$CMD" | grep -Eq '(cat|less|more|head|tail|jq|grep|awk|sed|node|python|cp|mv|tee|xxd|readFileSync|open\(|fs\.read)[^|&;]*ait-mcp/identity'; then
  block "Read attempt on \$XDG_DATA_HOME/ait-mcp/identity-*.json (the persisted MCP-session credentials)."
fi

# 3. Reading the credential-bearing .env files for PDS or PLC.
if printf '%s' "$CMD" | grep -Eq '(cat|less|more|head|tail|jq|grep|awk|sed|node|python|cp|mv|tee|readFileSync|open\(|fs\.read|source[[:space:]]+)[^|&;]*(pds|plc)/\.env\b'; then
  block "Read attempt on pds/.env or plc/.env (contain PDS_ADMIN_PASSWORD, PDS_JWT_SECRET, ADMIN_SECRET, signing keys)."
fi

# Note: a separate rule for `com.atproto.admin.*` strings was considered and
# dropped — it false-positived on documentation and commit messages that
# literally reference those endpoint names. Rule 1 already catches any
# *invocation* of an admin endpoint, since AIT runs local-only and every
# admin call has to hit localhost:258X anyway.

exit 0
