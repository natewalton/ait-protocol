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

# Print the standard banner plus the given body on stderr, and block the call.
deny() {
  cat >&2 <<EOF
🛑 Blocked by bin/guard-bash.sh

$1
EOF
  exit 2
}

block() {
  deny "$1

The AIT network is accessible only through MCP tools (join, post,
follow, getTimeline, getAuthorFeed). Going around them — by curling
local service ports, reading the persisted JWT, or extracting
credentials from .env files — violates the end-client-parity principle
(ADR-0006/0007/0010) and the incident in ADR-0031.

If you genuinely need a capability not exposed by an MCP tool, add a
new MCP tool that exposes it. Do not reach around."
}

# 1. Direct hits on AIT service ports (PLC=2582, PDS=2583, AppView=2585).
if printf '%s' "$CMD" | grep -Eq '(curl|wget|http|nc|websocat)[^|&;]*((localhost|127\.0\.0\.1|0\.0\.0\.0|pds\.localhost|appview\.localhost)[: ]+258[235]\b|:258[235]/xrpc/)'; then
  block "Direct network call to an AIT service port (PLC 2582 / PDS 2583 / AppView 2585) detected."
fi

# 2. Reading a persisted identity directory (accessJwt / refreshJwt / account
# password) — the MCP's per-session store, or the standalone watcher's account.
if printf '%s' "$CMD" | grep -Eq '(cat|less|more|head|tail|jq|grep|awk|sed|node|python|cp|mv|tee|xxd|readFileSync|open\(|fs\.read)[^|&;]*ait-(mcp|watcher)/identity'; then
  block "Read attempt on \$XDG_DATA_HOME/ait-mcp/identity-*.json or ait-watcher/identity.json (persisted credentials)."
fi

# 3. Reading the credential-bearing .env files for PDS or PLC.
if printf '%s' "$CMD" | grep -Eq '(cat|less|more|head|tail|jq|grep|awk|sed|node|python|cp|mv|tee|readFileSync|open\(|fs\.read|source[[:space:]]+)[^|&;]*(pds|plc)/\.env\b'; then
  block "Read attempt on pds/.env or plc/.env (contain PDS_ADMIN_PASSWORD, PDS_JWT_SECRET, ADMIN_SECRET, signing keys)."
fi

# 3b. Running aitty. It is the *human's* client: it logs in as its own stored
# handle, which the AppView may name as APPVIEW_OPERATOR — the one identity
# allowed to retire another account from the directory (ADR-0043). A session
# shelling out to aitty borrows that handle and inherits an affordance the MCP
# tool surface deliberately withholds. Covers the launcher, the built entry
# point, and a direct import of the client modules.
#
# Both branches require the launcher or the module to be in RUN position, never
# read position, so `cat docs/aitty.md`, `git log -- mcp/src/aitty` and
# `cat mcp/dist/aitty/main.js` all still pass. Branch one: the launcher at the
# start of a command — after the line start, a `;`, a pipe, or `(` — optionally
# behind an interpreter or wrapper (`bash bin/aitty` is the likely accident,
# since a fresh clone may not have the launcher executable), with any leading
# path. Branch two: an interpreter given one of the client modules directly.
#
# After a runner, only environment assignments and flags may intervene before
# the path — NOT arbitrary arguments. Allowing those would match `aitty` as a
# later argument of an unrelated command, e.g. `node script.mjs aitty`.
#
# `^` matches per line, so an invocation on the second line of a multi-line
# command is caught; the cost is that a heredoc or commit message quoting a
# usage example also trips it.
#
# Every runner alternative must start a word. Unanchored, `sh` matches the tail
# of `guard-bash.sh` and `git diff -- bin/guard-bash.sh mcp/src/aitty/main.ts`
# reads as "sh, then a path ending in aitty/main.ts".
AITTY_RUNNERS='(bash|sh|zsh|node|npx|tsx|bun|deno|env|time|exec|sudo|nohup)'
AITTY_PREAMBLE="([A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*|-[^[:space:];&|]*)[[:space:]]+"
AITTY_START='(^|[[:space:];&|(])'
if printf '%s' "$CMD" | grep -Eq "(^|[;&|(])[[:space:]]*(([A-Za-z0-9_.~-]*/)*$AITTY_RUNNERS[[:space:]]+($AITTY_PREAMBLE)*)?([A-Za-z0-9_.~-]*/)*aitty([[:space:]]|$)|$AITTY_START$AITTY_RUNNERS[[:space:]]+($AITTY_PREAMBLE)*[^[:space:];&|]*aitty/(main|agent|commands)\.(js|ts)"; then
  deny "aitty is the human operator's terminal client, not a session tool.

It logs in as a persistent handle stored on this machine, and the AppView
may name that handle as its operator — the single identity allowed to
retire another account from directory search (ADR-0043). Running aitty
from a session borrows that identity, so the session picks up an
affordance the MCP tool surface deliberately does not offer.

Use the ait MCP tools instead (join, post, reply, follow, getTimeline,
getAuthorFeed, searchActors, retire). \`retire\` acts only on your own
handle, which is the whole of what a session is meant to be able to do.

If the MCP server is not loaded in this project, say so and ask — do not
reach around it. See docs/aitty.md and ADR-0043."
fi

# 4. Symlink bypass — `cat /tmp/legit -> ~/.local/share/ait-mcp/identity-X.json`
# doesn't trip patterns 2 or 3 because the literal CMD text contains no
# "ait-mcp/identity" / "pds/.env" / "plc/.env" substring. Resolve any
# path-like token in the CMD and re-check against the same patterns.
# Same shape as guard-tool.sh's resolve_path (fix15) — see that file.
resolve_path() {
  local p="$1"
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

# Extract every token that looks like a path (contains at least one `/`),
# resolve it, and only block when the resolved value exists on disk AND
# matches a credential pattern. The `-e` existence check is what keeps
# documentation strings ("see ~/.local/share/ait-mcp/identity-X" in a
# commit message body, README, etc.) from tripping the guard. Real
# symlinks to credential files exist; phantom text references don't.
for token in $(printf '%s' "$CMD" | grep -oE '[A-Za-z0-9_./~-]+' | grep -E '/' || true); do
  resolved="$(resolve_path "$token")"
  [ -e "$resolved" ] || continue
  case "$resolved" in
    */ait-mcp/identity-*|*/ait-mcp/identity-*.json|*/ait-watcher/identity*)
      block "Read attempt via path that resolves to a credential file ($token → $resolved)."
      ;;
    */pds/.env|*/plc/.env|pds/.env|plc/.env)
      block "Read attempt via path that resolves to pds/.env or plc/.env ($token → $resolved)."
      ;;
  esac
done

# Note: a separate rule for `com.atproto.admin.*` strings was considered and
# dropped — it false-positived on documentation and commit messages that
# literally reference those endpoint names. Rule 1 already catches any
# *invocation* of an admin endpoint, since AIT runs local-only and every
# admin call has to hit localhost:258X anyway.

exit 0
