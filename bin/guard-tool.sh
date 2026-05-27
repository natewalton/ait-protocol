#!/bin/bash
# PreToolUse hook for file-read tools (Read, Edit, Write, NotebookEdit).
#
# Companion to guard-bash.sh — that one catches shell-level bypasses
# (cat / grep / readFileSync / etc.) against the AIT credential files
# and service ports. This one catches the same threat surfaced through
# Claude Code's native file tools, whose tool_input carries a structured
# `file_path` field instead of a shell command.
#
# Wired up in .claude/settings.json under
#   hooks.PreToolUse[matcher=Read|Edit|Write|NotebookEdit].
# Exit code 2 blocks; stderr is shown to the model.
#
# See specs/session-reauth.md (step 9) and ADR-0031.

set -euo pipefail

INPUT="$(cat)"

# Extract tool name + file path. NotebookEdit uses `notebook_path`; the
# rest use `file_path`.
if command -v jq >/dev/null 2>&1; then
  TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"
  PATH_FIELD="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')"
else
  TOOL="$(printf '%s' "$INPUT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1)"
  PATH_FIELD="$(printf '%s' "$INPUT" | sed -n 's/.*"\(file_path\|notebook_path\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/p' | head -1)"
fi

[ -z "$PATH_FIELD" ] && exit 0

block() {
  local reason="$1"
  cat >&2 <<EOF
🛑 Blocked by .claude/hooks/guard-tool.sh

$reason

Tool: $TOOL
Path: $PATH_FIELD

The AIT network is accessible only through MCP tools. Credential
files (ait-mcp/identity-*.json, pds/.env, plc/.env) and admin
secrets are off limits — extracting them is god-mode against
every session's identity, including ones in other Claude
conversations on the same machine.

See specs/session-reauth.md and ADR-0031.
EOF
  exit 2
}

# 1. The persisted MCP identity files.
case "$PATH_FIELD" in
  */ait-mcp/identity-*|*/ait-mcp/identity-*.json)
    block "Read/Edit/Write attempt on \$XDG_DATA_HOME/ait-mcp/identity-*.json (the encrypted persisted MCP-session credentials)."
    ;;
esac

# 2. The credential-bearing .env files for PDS or PLC.
case "$PATH_FIELD" in
  */pds/.env|*/plc/.env|pds/.env|plc/.env)
    block "Read/Edit/Write attempt on pds/.env or plc/.env (contain PDS_ADMIN_PASSWORD, PDS_JWT_SECRET, ADMIN_SECRET, signing keys)."
    ;;
esac

exit 0
