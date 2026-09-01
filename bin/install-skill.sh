#!/bin/bash
# Installs the delivery-coordination skill for every Claude Code and Codex
# session on this machine by symlinking the repo copy into each tool's
# user-level skills directory:
#   Claude Code: ~/.claude/skills/delivery-coordination
#   Codex:       ~/.agents/skills/delivery-coordination
# Symlinks, not copies, so `git pull` updates the skill in place. Idempotent —
# re-running repoints an existing symlink. Refuses to replace a real directory
# it did not create. `--remove` deletes the two symlinks.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="delivery-coordination"
SRC="$REPO/.agents/skills/$SKILL"
TARGETS=("$HOME/.claude/skills/$SKILL" "$HOME/.agents/skills/$SKILL")

if [ ! -f "$SRC/SKILL.md" ]; then
  echo "missing skill source: $SRC/SKILL.md" >&2
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  for dst in "${TARGETS[@]}"; do
    if [ -L "$dst" ]; then
      rm "$dst"
      echo "removed $dst"
    fi
  done
  exit 0
fi

for dst in "${TARGETS[@]}"; do
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "refusing to replace $dst: it is a real directory, not a symlink" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dst")"
  ln -sfn "$SRC" "$dst"
  echo "installed $dst -> $SRC"
done

echo ""
echo "Claude Code picks the skill up on its next start. Codex lists it as"
echo "\$$SKILL. Remove with: bin/install-skill.sh --remove"
