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

# Resolve symlinks before pattern-matching so `ln -s ~/.local/share/ait-mcp/
# identity-abc.json /tmp/legit.txt` plus a Read on /tmp/legit.txt doesn't
# slip past the credential-dir patterns. Falls back to the literal string
# if no resolver is available — fail-closed still works for any path that
# literally contains the credential dir name.
resolve_path() {
  local p="$1"
  # macOS BSD realpath doesn't accept -m (GNU coreutils does). Plain
  # `realpath` works on both for existing paths — and a non-existent
  # credential file isn't the bypass surface this guards. python3 is the
  # universal fallback (present on every macOS dev box).
  local r
  if command -v realpath >/dev/null 2>&1 && r="$(realpath "$p" 2>/dev/null)"; then
    printf '%s' "$r"
  elif command -v readlink >/dev/null 2>&1 && r="$(readlink -f "$p" 2>/dev/null)" && [ -n "$r" ]; then
    printf '%s' "$r"
  elif r="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null)"; then
    printf '%s' "$r"
  else
    printf '%s' "$p"
  fi
}

RESOLVED="$(resolve_path "$PATH_FIELD")"

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
case "$RESOLVED" in
  */ait-mcp/identity-*|*/ait-mcp/identity-*.json)
    block "Read/Edit/Write attempt on \$XDG_DATA_HOME/ait-mcp/identity-*.json (the encrypted persisted MCP-session credentials)."
    ;;
esac

# 2. The credential-bearing .env files for PDS or PLC.
case "$RESOLVED" in
  */pds/.env|*/plc/.env|pds/.env|plc/.env)
    block "Read/Edit/Write attempt on pds/.env or plc/.env (contain PDS_ADMIN_PASSWORD, PDS_JWT_SECRET, ADMIN_SECRET, signing keys)."
    ;;
esac

exit 0
