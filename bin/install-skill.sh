#!/bin/bash
# Manage the AIT delivery-coordination skill for supported user-level harnesses.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
SRC="$REPO/.agents/skills/delivery-coordination"
CLAUDE_TARGET="$HOME/.claude/skills/delivery-coordination"
CODEX_TARGET="$HOME/.agents/skills/delivery-coordination"

usage() {
  cat <<'EOF'
Usage:
  bin/install-skill.sh --install     Install or verify owned links.
  bin/install-skill.sh --remove     Remove only owned links.
  bin/install-skill.sh --status     Show read-only target state.
EOF
}

present() { command -v "$1" >/dev/null 2>&1; }
owned() { [ -L "$1" ] && [ "$(readlink "$1")" = "$SRC" ]; }

state() {
  local harness="$1" target="$2"
  if owned "$target"; then
    present "$harness" && printf ready || printf 'ready (harness not installed)'
  elif [ -e "$target" ] || [ -L "$target" ]; then
    present "$harness" && printf 'conflict (%s)' "$(readlink "$target" 2>/dev/null || printf 'target exists')" || printf 'conflict (target exists; harness not installed)'
  elif present "$harness"; then
    printf 'not installed'
  else
    printf 'skipped (harness not installed)'
  fi
}

rows() {
  printf '  claude  %s\n' "$(state claude "$CLAUDE_TARGET")"
  printf '  codex   %s\n' "$(state codex "$CODEX_TARGET")"
}

require_harness() {
  present claude || present codex || {
    echo '  missing: Claude Code' >&2
    echo '    remedy: curl -fsSL https://claude.ai/install.sh | bash' >&2
    echo '    docs: https://code.claude.com/docs/en/getting-started' >&2
    echo '  missing: Codex' >&2
    echo '    remedy: curl -fsSL https://chatgpt.com/codex/install.sh | sh' >&2
    echo '    docs: https://learn.chatgpt.com/docs/codex/cli' >&2
    return 1
  }
}

check_install() {
  local harness target
  [ -f "$SRC/SKILL.md" ] || { echo "error: missing skill source: $SRC/SKILL.md" >&2; return 1; }
  require_harness || return 1
  for harness in claude codex; do
    [ "$harness" = claude ] && target="$CLAUDE_TARGET" || target="$CODEX_TARGET"
    present "$harness" || continue
    if ! owned "$target" && { [ -e "$target" ] || [ -L "$target" ]; }; then
      echo "error: refusing to replace $target: $(state "$harness" "$target")" >&2
      echo '  recovery: move the existing target aside and run ait skills install' >&2
      echo '  recovery: rerun the machine bootstrap with AIT_NO_SKILLS=1 to preserve it' >&2
      return 1
    fi
  done
}

install_links() {
  local harness target
  check_install || return 1
  for harness in claude codex; do
    [ "$harness" = claude ] && target="$CLAUDE_TARGET" || target="$CODEX_TARGET"
    present "$harness" || continue
    owned "$target" && continue
    mkdir -p "$(dirname "$target")" || return 1
    ln -s "$SRC" "$target" || { echo "error: target appeared or could not be linked: $target" >&2; return 1; }
    owned "$target" || { echo "error: installed link verification failed: $target" >&2; return 1; }
  done
}

remove_links() {
  local target
  for target in "$CLAUDE_TARGET" "$CODEX_TARGET"; do
    if owned "$target"; then
      rm "$target" || { echo "error: unable to remove managed target: $target" >&2; return 1; }
    elif [ -e "$target" ] || [ -L "$target" ]; then
      echo "  preserved: $target (not owned by this checkout)" >&2
    fi
  done
}

install_operation() {
  local bootstrap="${1:-0}"
  install_links
  if [ "$bootstrap" = 1 ]; then
    names=''
    present claude && names=claude
    present codex && { [ -n "$names" ] && names="$names, codex" || names=codex; }
    echo "  skills  ready ($names)"
  else
    rows
    echo 'Start a new harness session for a guaranteed result.'
  fi
}

case "${1:-}" in
  --install) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; install_operation ;;
  --remove) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; remove_links; rows; echo 'Start a new harness session for a guaranteed result.' ;;
  --status) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; rows ;;
  --bootstrap) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; install_operation 1 ;;
  *) usage >&2; exit 2 ;;
esac
