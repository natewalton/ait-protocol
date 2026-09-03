#!/bin/bash
# Outcome tests for the AIT coordination-skill lifecycle.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
ROOT="$(mktemp -d /tmp/ait-skill-test.XXXXXX)"
ORIGINAL_PATH="$PATH"
trap 'rm -rf "$ROOT"' EXIT INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
contains() { printf '%s\n' "$1" | grep -Fq -- "$2" || fail "expected '$2'"; }
absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "unexpected $1"; }
linked() { [ -e "$1/SKILL.md" ] || fail "missing linked skill $1"; }

mkdir -p "$ROOT/bin"
for tool in git node npm openssl curl; do
  real="$(PATH="$ORIGINAL_PATH" command -v "$tool" 2>/dev/null || true)"
  [ -z "$real" ] || ln -s "$real" "$ROOT/bin/$tool"
done

write_harnesses() {
  rm -f "$ROOT/bin/claude" "$ROOT/bin/codex"
  for harness in "$@"; do
    printf '#!/bin/sh\nexit 0\n' > "$ROOT/bin/$harness"
    chmod +x "$ROOT/bin/$harness"
  done
}

export PATH="$ROOT/bin:/usr/bin:/bin"

help="$("$REPO/ait" help skills)"
contains "$help" 'Usage: ait skills <install|remove|status>'
"$REPO/ait" skills install --help >/dev/null
"$REPO/ait" skills remove --help >/dev/null
"$REPO/ait" skills status --help >/dev/null
set +e
"$REPO/ait" skills install extra >/dev/null 2>&1; rc1=$?
"$REPO/bin/install-skill.sh" --status extra >/dev/null 2>&1; rc2=$?
set -e
[ "$rc1" -eq 2 ] && [ "$rc2" -eq 2 ] || fail 'invalid arguments must exit 2'
pass 'help and invalid arguments'

write_harnesses claude codex
HOME="$ROOT/dual"; export HOME
mkdir -p "$HOME"
before="$(find "$HOME" -print 2>/dev/null | shasum -a 256 | awk '{print $1}')"
status="$("$REPO/ait" skills status)"
contains "$status" 'claude  not installed'
contains "$status" 'codex   not installed'
after="$(find "$HOME" -print 2>/dev/null | shasum -a 256 | awk '{print $1}')"
[ "$before" = "$after" ] || fail 'status wrote to HOME'
"$REPO/ait" skills install >/dev/null
linked "$HOME/.claude/skills/delivery-coordination"
linked "$HOME/.agents/skills/delivery-coordination"
claude_link="$(readlink "$HOME/.claude/skills/delivery-coordination")"
codex_link="$(readlink "$HOME/.agents/skills/delivery-coordination")"
"$REPO/ait" skills install >/dev/null
[ "$(readlink "$HOME/.claude/skills/delivery-coordination")" = "$claude_link" ] || fail 'Claude rerun changed link'
[ "$(readlink "$HOME/.agents/skills/delivery-coordination")" = "$codex_link" ] || fail 'Codex rerun changed link'
pass 'dual install, status, and idempotent rerun'

"$REPO/ait" skills remove >/dev/null
absent "$HOME/.claude/skills/delivery-coordination"
absent "$HOME/.agents/skills/delivery-coordination"
[ -f "$REPO/.agents/skills/delivery-coordination/SKILL.md" ] || fail 'remove deleted source'
pass 'owned remove deletes links only'

write_harnesses claude
HOME="$ROOT/claude-only"; export HOME
single="$("$REPO/ait" skills install)"
contains "$single" 'claude  ready'
contains "$single" 'codex   skipped'
linked "$HOME/.claude/skills/delivery-coordination"
absent "$HOME/.agents"
write_harnesses codex
HOME="$ROOT/codex-only"; export HOME
single="$("$REPO/ait" skills install)"
contains "$single" 'claude  skipped'
contains "$single" 'codex   ready'
linked "$HOME/.agents/skills/delivery-coordination"
absent "$HOME/.claude"
pass 'single-harness targeting'

write_harnesses claude codex
HOME="$ROOT/conflict"; export HOME
mkdir -p "$HOME/.claude/skills/delivery-coordination" "$HOME/.agents/skills"
printf foreign > "$HOME/.claude/skills/delivery-coordination/keep"
ln -s "$ROOT/foreign" "$HOME/.agents/skills/delivery-coordination"
set +e
conflict="$("$REPO/ait" skills install 2>&1)"; rc=$?
set -e
[ "$rc" -eq 1 ] || fail 'foreign conflict succeeded'
contains "$conflict" 'refusing to replace'
contains "$conflict" 'move the existing target aside'
[ "$(cat "$HOME/.claude/skills/delivery-coordination/keep")" = foreign ] || fail 'foreign directory changed'
[ "$(readlink "$HOME/.agents/skills/delivery-coordination")" = "$ROOT/foreign" ] || fail 'foreign link changed'
pass 'present-harness conflicts are preserved'

write_harnesses claude
HOME="$ROOT/absent-harness-conflict"; export HOME
mkdir -p "$HOME/.agents/skills/delivery-coordination"
printf keep > "$HOME/.agents/skills/delivery-coordination/foreign"
"$REPO/ait" skills install >/dev/null
linked "$HOME/.claude/skills/delivery-coordination"
[ "$(cat "$HOME/.agents/skills/delivery-coordination/foreign")" = keep ] || fail 'absent harness target changed'
pass 'absent-harness target does not block or change'

write_harnesses claude codex
HOME="$ROOT/cycle"; export HOME
mkdir -p "$HOME/.claude/skills"
ln -s delivery-coordination "$HOME/.claude/skills/delivery-coordination"
cycle="$("$REPO/ait" skills status)"
contains "$cycle" conflict
set +e
"$REPO/ait" skills install >/dev/null 2>&1; rc=$?
set -e
[ "$rc" -eq 1 ] || fail 'self-link conflict succeeded'
pass 'cycle-safe resolution returns a conflict'

HOME="$ROOT/foreign-remove"; export HOME
mkdir -p "$HOME/.claude/skills" "$HOME/.agents/skills/delivery-coordination"
printf keep > "$HOME/.claude/skills/delivery-coordination"
printf keep > "$HOME/.agents/skills/delivery-coordination/keep"
preserved="$("$REPO/ait" skills remove 2>&1)"
contains "$preserved" preserved
[ "$(cat "$HOME/.claude/skills/delivery-coordination")" = keep ] || fail 'foreign file removed'
[ "$(cat "$HOME/.agents/skills/delivery-coordination/keep")" = keep ] || fail 'foreign directory removed'
pass 'remove preserves foreign targets'

write_harnesses
HOME="$ROOT/no-harness"; export HOME
set +e
missing="$("$REPO/ait" skills install 2>&1)"; rc=$?
set -e
[ "$rc" -eq 1 ] || fail 'no-harness install succeeded'
contains "$missing" 'remedy: curl -fsSL https://claude.ai/install.sh | bash'
contains "$missing" 'remedy: curl -fsSL https://chatgpt.com/codex/install.sh | sh'
absent "$HOME/.claude"
absent "$HOME/.agents"
pass 'no-harness install refuses before writes'

write_harnesses claude codex
HOME="$ROOT/bootstrap"; export HOME
boot="$("$REPO/bin/install-skill.sh" --bootstrap)"
contains "$boot" 'skills  ready (claude, codex)'
linked "$HOME/.claude/skills/delivery-coordination"
linked "$HOME/.agents/skills/delivery-coordination"
"$REPO/ait" skills remove >/dev/null
"$REPO/bin/install-skill.sh" --bootstrap >/dev/null
linked "$HOME/.claude/skills/delivery-coordination"
AIT_NO_SKILLS=1 "$REPO/bin/install-skill.sh" --bootstrap >/dev/null
linked "$HOME/.claude/skills/delivery-coordination"
pass 'every bootstrap applies the default unless that invocation opts out'

HOME="$ROOT/bootstrap-optout"; export HOME
skip="$(AIT_NO_SKILLS=1 "$REPO/bin/install-skill.sh" --bootstrap)"
contains "$skip" 'skills  skipped (AIT_NO_SKILLS=1)'
absent "$HOME/.claude"
absent "$HOME/.agents"
pass 'bootstrap opt-out creates nothing'

missing_repo="$ROOT/missing-source"
mkdir -p "$missing_repo/bin"
cp "$REPO/bin/install-skill.sh" "$missing_repo/bin/"
chmod +x "$missing_repo/bin/install-skill.sh"
missing_repo="$(cd "$missing_repo" && pwd -P)"
HOME="$ROOT/missing-source-home"; export HOME
mkdir -p "$HOME/.claude/skills"
ln -s "$missing_repo/.agents/skills/delivery-coordination" "$HOME/.claude/skills/delivery-coordination"
contains "$("$missing_repo/bin/install-skill.sh" --status)" ready
"$missing_repo/bin/install-skill.sh" --remove >/dev/null
absent "$HOME/.claude/skills/delivery-coordination"
set +e
"$missing_repo/bin/install-skill.sh" --install >/dev/null 2>&1; rc=$?
set -e
[ "$rc" -eq 1 ] || fail 'missing source install succeeded'
pass 'status and removal work after source loss; install refuses'

echo 'AIT skill test suite passed'
