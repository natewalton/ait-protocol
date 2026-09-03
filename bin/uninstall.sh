#!/bin/bash
# Permanently remove one installer-owned AIT machine installation.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALL_ROOT="$HOME/.local/share/ait-protocol"
EXPECTED_ORIGIN="https://github.com/natewalton/ait-protocol"
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}"
UPDATE_LOCK="$STATE_ROOT/ait-protocol/update.lock"
LOG_ROOT="${AIT_LOG_DIR:-/tmp}"
RUNTIME_TMP="${TMPDIR:-/tmp}"
PUBLIC_INSTALL='/bin/bash -c "$(curl -fsSL https://github.com/natewalton/ait-protocol/releases/latest/download/install.sh)"'
CLI_LINK="$(brew --prefix 2>/dev/null || true)/bin/ait"

fail() {
  echo "error: $*" >&2
  exit 1
}

find_owned_cli() {
  [ -n "${CLI_LINK%/bin/ait}" ] || return 1
  [ -L "$CLI_LINK" ] || return 1
  [ "$(readlink "$CLI_LINK")" = "$REPO/ait" ]
}

preflight() {
  local head origin release_commit sessions version lock_pid=""
  case "$REPO" in ""|/|"$HOME") fail "refusing unsafe managed checkout path: $REPO" ;; esac
  [ -d "$INSTALL_ROOT" ] || fail "managed checkout not found: $INSTALL_ROOT"
  [ "$(cd -P "$INSTALL_ROOT" && pwd)" = "$REPO" ] ||
    fail "this is not the managed checkout at $INSTALL_ROOT"
  origin="$(git -C "$REPO" remote get-url origin 2>/dev/null || true)"
  [ "$origin" = "$EXPECTED_ORIGIN" ] || [ "$origin" = "$EXPECTED_ORIGIN.git" ] ||
    fail "checkout origin is not installer-owned: ${origin:-missing}"
  version="$(tr -d '[:space:]' < "$REPO/VERSION" 2>/dev/null || true)"
  head="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
  release_commit="$(git -C "$REPO" rev-parse "refs/ait-release/v$version^{commit}" 2>/dev/null || true)"
  [ -n "$version" ] && [ -n "$head" ] && [ "$release_commit" = "$head" ] ||
    fail "development or package-managed checkouts are not removed by ait uninstall"
  find_owned_cli || fail "installer-owned AIT CLI link was not found"
  for required in bin/uninstall-services.sh bin/stop-all.sh bin/install-skill.sh; do
    [ -x "$REPO/$required" ] || fail "required cleanup script is missing: $REPO/$required"
  done
  if [ -e "$UPDATE_LOCK" ]; then
    lock_pid="$(sed -n '1p' "$UPDATE_LOCK/pid" 2>/dev/null || true)"
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      fail "AIT update is active (pid $lock_pid); let it finish, then retry"
    fi
  fi
  sessions="$(ps -ax -o pid=,command= | awk -v needle="$REPO/mcp/dist/server.js" 'index($0, needle) && $2 ~ /(^|\/)node$/ {print $1}')"
  [ -z "$sessions" ] || fail "active AIT harness session process(es): $sessions; exit them and retry"
}

confirm() {
  local answer=""
  trap 'echo; echo "Uninstall cancelled; nothing changed."; exit 130' INT TERM
  cat <<EOF
WARNING: this permanently deletes the AIT installation at:
  $REPO

It also deletes AIT identities, state, sockets, PID files, logs, the owned CLI
and skill links, and the four com.ait.* launchd agents. This includes generated
.env secrets and checkout-local PDS/AppView data. No backup is created.

It deletes the local PostgreSQL database plc_directory. It leaves project
.mcp.json entries and shared prerequisites such as Claude, Codex, Node,
PostgreSQL, Homebrew, and Git. In each initialized project, remove the preserved entry with:
  claude mcp remove ait-protocol --scope project

Type exactly: uninstall AIT
EOF
  if ! IFS= read -r answer || [ "$answer" != "uninstall AIT" ]; then
    trap - INT TERM
    echo "Uninstall cancelled; nothing changed."
    return 1
  fi
  trap - INT TERM
  return 0
}

remaining() {
  local target
  echo "Remaining AIT targets:" >&2
  for target in "$CLI_LINK" "$HOME/.claude/skills/delivery-coordination" \
    "$HOME/.agents/skills/delivery-coordination" "$DATA_ROOT/ait-mcp" \
    "$DATA_ROOT/ait-watcher" "$STATE_ROOT/ait-protocol" "$HOME/.ait" "$REPO"; do
    if [ -e "$target" ] || [ -L "$target" ]; then echo "  $target" >&2; fi
  done
  for target in "$HOME/Library/LaunchAgents"/com.ait.{plc,pds,appview,codex-appserver}.plist \
    "$LOG_ROOT"/ait-{plc,pds,appview,codex-appserver}.{pid,log,err} \
    "$RUNTIME_TMP"/ait-codex-sock.* "$RUNTIME_TMP"/ait-codex-log.* \
    "$RUNTIME_TMP"/ait-codex-tui-relay.*; do
    if [ -e "$target" ] || [ -L "$target" ]; then echo "  $target" >&2; fi
  done
}

step() {
  local label="$1"
  shift
  if ! "$@"; then
    echo "error: uninstall failed while $label" >&2
    remaining
    if [ -L "$CLI_LINK" ]; then
      echo "  recovery: ait uninstall" >&2
    else
      echo "  recovery: $PUBLIC_INSTALL" >&2
    fi
    exit 1
  fi
}

remove_runtime_files() {
  local target
  for target in "$LOG_ROOT"/ait-{plc,pds,appview,codex-appserver}.{pid,log,err} \
    "$RUNTIME_TMP"/ait-codex-sock.* "$RUNTIME_TMP"/ait-codex-log.* \
    "$RUNTIME_TMP"/ait-codex-tui-relay.*; do
    if [ -e "$target" ] || [ -L "$target" ]; then rm -rf "$target" || return 1; fi
  done
}

uninstall() {
  preflight
  confirm || return 0

  step "removing AIT launchd agents" "$REPO/bin/uninstall-services.sh"
  step "stopping AIT processes" "$REPO/bin/stop-all.sh"
  step "deleting the PostgreSQL database plc_directory" "$REPO/bin/install.sh" --drop-database
  step "removing owned skill links" "$REPO/bin/install-skill.sh" --remove
  step "removing the AIT CLI link" rm "$CLI_LINK"
  step "removing AIT MCP identities" rm -rf "$DATA_ROOT/ait-mcp"
  step "removing the AIT terminal identity" rm -rf "$DATA_ROOT/ait-watcher"
  step "removing AIT state" rm -rf "$STATE_ROOT/ait-protocol"
  step "removing AIT sockets" rm -rf "$HOME/.ait"
  step "removing AIT PID files and logs" remove_runtime_files
  step "removing the managed checkout" rm -rf "$REPO"

  echo "AIT has been uninstalled."
  echo "The PostgreSQL database plc_directory was deleted."
  echo "Project .mcp.json entries and shared prerequisites were preserved."
  echo "Project cleanup: claude mcp remove ait-protocol --scope project"
  echo "Reinstall: $PUBLIC_INSTALL"
}

uninstall
