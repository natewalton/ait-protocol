#!/bin/bash
# Manage the AIT delivery-coordination skill for supported user-level harnesses.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
SKILL="delivery-coordination"
SRC="$REPO/.agents/skills/$SKILL"
CLAUDE_TARGET="$HOME/.claude/skills/$SKILL"
CODEX_TARGET="$HOME/.agents/skills/$SKILL"
OPERATION=""
COMPLETED=""

usage() {
  cat <<'EOF'
Usage:
  bin/install-skill.sh [--install]  Install or verify owned links.
  bin/install-skill.sh --remove     Remove only owned links.
  bin/install-skill.sh --status     Show read-only target state.
  bin/install-skill.sh --help       Show this help.
EOF
}

resolve_path() {
  local source="$1" dir target depth=0 seen=""
  while [ -L "$source" ] && [ "$depth" -lt 40 ]; do
    case "|$seen|" in
      *"|$source|"*) printf '%s' "$source"; return ;;
    esac
    seen="$seen|$source"
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    target="$(readlink "$source")"
    case "$target" in
      /*) source="$target" ;;
      *) source="$dir/$target" ;;
    esac
    depth=$((depth + 1))
  done
  [ ! -L "$source" ] || { printf '%s' "$source"; return; }
  if [ -e "$source" ]; then
    cd -P "$(dirname "$source")" && printf '%s/%s' "$(pwd)" "$(basename "$source")"
  else
    printf '%s' "$source"
  fi
}

source_ready() {
  [ -f "$SRC/SKILL.md" ]
}

source_required() {
  source_ready || { echo "error: missing skill source: $SRC/SKILL.md" >&2; return 1; }
}

harness_present() {
  command -v "$1" >/dev/null 2>&1
}

managed_link() {
  local dst="$1"
  [ -L "$dst" ] && [ "$(resolve_path "$dst")" = "$SRC" ]
}

target_state() {
  local harness="$1" dst="$2" resolved
  if managed_link "$dst"; then
    if harness_present "$harness"; then
      printf 'ready'
    else
      printf 'ready (harness not installed)'
    fi
  elif [ -e "$dst" ] || [ -L "$dst" ]; then
    resolved="$(resolve_path "$dst")"
    if harness_present "$harness"; then
      printf 'conflict (%s)' "$resolved"
    else
      printf 'conflict (target exists; harness not installed)'
    fi
  elif harness_present "$harness"; then
    printf 'not installed'
  else
    printf 'skipped (harness not installed)'
  fi
}

print_rows() {
  printf '  claude  %s\n' "$(target_state claude "$CLAUDE_TARGET")"
  printf '  codex   %s\n' "$(target_state codex "$CODEX_TARGET")"
}

missing_harnesses() {
  local found=0
  harness_present claude && found=1
  harness_present codex && found=1
  if [ "$found" -eq 0 ]; then
    echo "  missing: Claude Code" >&2
    echo "    remedy: curl -fsSL https://claude.ai/install.sh | bash" >&2
    echo "    docs: https://code.claude.com/docs/en/getting-started" >&2
    echo "  missing: Codex" >&2
    echo "    remedy: curl -fsSL https://chatgpt.com/codex/install.sh | sh" >&2
    echo "    docs: https://learn.chatgpt.com/docs/codex/cli" >&2
    return 1
  fi
}

conflicts_present() {
  local state conflict=0
  if harness_present claude; then
    state="$(target_state claude "$CLAUDE_TARGET")"
    case "$state" in
      conflict\ *)
        echo "error: refusing to replace $CLAUDE_TARGET: $state" >&2
        echo "  recovery: move the existing target aside and rerun" >&2
        echo "  recovery: rerun with AIT_NO_SKILLS=1 to preserve it" >&2
        conflict=1
        ;;
    esac
  fi
  if harness_present codex; then
    state="$(target_state codex "$CODEX_TARGET")"
    case "$state" in
      conflict\ *)
        echo "error: refusing to replace $CODEX_TARGET: $state" >&2
        echo "  recovery: move the existing target aside and rerun" >&2
        echo "  recovery: rerun with AIT_NO_SKILLS=1 to preserve it" >&2
        conflict=1
        ;;
    esac
  fi
  [ "$conflict" -eq 0 ]
}

install_preflight() {
  source_required || return 1
  missing_harnesses || return 1
  conflicts_present || return 1
}

progress() {
  echo "  completed: $COMPLETED" >&2
  if [ "$OPERATION" = "remove" ]; then
    echo "  remaining managed links:" >&2
    managed_link "$CLAUDE_TARGET" && echo "    $CLAUDE_TARGET" >&2
    managed_link "$CODEX_TARGET" && echo "    $CODEX_TARGET" >&2
  else
    echo "  missing:" >&2
    [ "$(target_state claude "$CLAUDE_TARGET")" = "not installed" ] && echo "    $CLAUDE_TARGET" >&2
    [ "$(target_state codex "$CODEX_TARGET")" = "not installed" ] && echo "    $CODEX_TARGET" >&2
  fi
  echo "  recovery: ait skills $OPERATION" >&2
}

interrupted() {
  trap - INT TERM
  echo "error: skill $OPERATION interrupted" >&2
  progress
  exit 130
}

install_one() {
  local harness="$1" dst="$2" state
  harness_present "$harness" || return 0
  state="$(target_state "$harness" "$dst")"
  if [ "$state" = "ready" ]; then
    COMPLETED="$COMPLETED $dst"
    return 0
  fi
  if ! mkdir -p "$(dirname "$dst")"; then
    echo "error: unable to create skill target parent: $(dirname "$dst")" >&2
    progress
    return 1
  fi
  if [ -e "$dst" ] || [ -L "$dst" ] || ! ln -s "$SRC" "$dst"; then
    echo "error: target appeared or could not be linked: $dst" >&2
    progress
    return 1
  fi
  managed_link "$dst" || { echo "error: installed link verification failed: $dst" >&2; progress; return 1; }
  COMPLETED="$COMPLETED $dst"
}

install_links() {
  OPERATION=install
  COMPLETED=""
  trap interrupted INT TERM
  install_one claude "$CLAUDE_TARGET" || { trap - INT TERM; return 1; }
  install_one codex "$CODEX_TARGET" || { trap - INT TERM; return 1; }
  trap - INT TERM
}

remove_one() {
  local dst="$1" resolved
  if [ -L "$dst" ]; then
    resolved="$(resolve_path "$dst")"
    if [ "$resolved" = "$SRC" ]; then
      if [ ! -L "$dst" ] || [ "$(resolve_path "$dst")" != "$SRC" ]; then
        echo "error: managed target changed before removal: $dst" >&2
        progress
        return 1
      fi
      if ! rm "$dst"; then
        echo "error: unable to remove managed target: $dst" >&2
        progress
        return 1
      fi
      COMPLETED="$COMPLETED $dst"
    else
      echo "  preserved: $dst (not owned by this checkout)" >&2
    fi
  elif [ -e "$dst" ] || [ -L "$dst" ]; then
    echo "  preserved: $dst (not owned by this checkout)" >&2
  fi
}

remove_links() {
  OPERATION=remove
  COMPLETED=""
  trap interrupted INT TERM
  remove_one "$CLAUDE_TARGET" || { trap - INT TERM; return 1; }
  remove_one "$CODEX_TARGET" || { trap - INT TERM; return 1; }
  trap - INT TERM
}

bootstrap_row() {
  local names=""
  if harness_present claude; then names=claude; fi
  if harness_present codex; then
    if [ -n "$names" ]; then names="$names, codex"; else names=codex; fi
  fi
  echo "  skills  ready ($names)"
}

install_operation() {
  if [ "$AIT_SKILLS_BOOTSTRAP" = "1" ] && [ "$AIT_NO_SKILLS" = "1" ]; then
    source_required || return 1
    missing_harnesses || return 1
    echo "  skills  skipped (AIT_NO_SKILLS=1)"
    return 0
  fi
  install_preflight || return 1
  install_links || return 1
  if [ "$AIT_SKILLS_BOOTSTRAP" = "1" ]; then
    if [ "$AIT_NO_SKILLS" = "1" ]; then
      echo "skills   skipped (AIT_NO_SKILLS=1)"
    else
      bootstrap_row
    fi
  else
    print_rows
    echo "Start a new harness session for a guaranteed result."
  fi
}

remove_operation() {
  remove_links || return 1
  print_rows
  echo "Start a new harness session for a guaranteed result."
}

status_operation() {
  print_rows
}

[ -n "${AIT_NO_SKILLS:-}" ] || AIT_NO_SKILLS=0
[ -n "${AIT_SKILLS_BOOTSTRAP:-}" ] || AIT_SKILLS_BOOTSTRAP=0
if [ "$#" -eq 0 ]; then
  install_operation
  exit $?
fi
case "$1" in
  --install|install) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; install_operation ;;
  --remove|remove) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; remove_operation ;;
  --status|status) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; status_operation ;;
  --check) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; install_preflight ;;
  --bootstrap) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; AIT_SKILLS_BOOTSTRAP=1; install_operation ;;
  --help|-h) [ "$#" -eq 1 ] || { usage >&2; exit 2; }; usage ;;
  *) usage >&2; exit 2 ;;
esac
