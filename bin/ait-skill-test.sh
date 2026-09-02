#!/bin/bash
# Isolated lifecycle and fresh-bootstrap tests for the AIT coordination skill.
set -eo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
ORIGINAL_PATH="$PATH"
TMP_ROOT="$(mktemp -d /tmp/ait-skill-test.XXXXXX)"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
assert_file() { [ -e "$1" ] || fail "missing $1"; }
assert_absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "unexpected $1"; }
assert_contains() { printf '%s\n' "$1" | grep -Fq -- "$2" || fail "expected '$2'"; }

mkdir -p "$TMP_ROOT/bin"
for tool in git node npm openssl curl; do
  real="$(PATH="$ORIGINAL_PATH" command -v "$tool" 2>/dev/null || true)"
  [ -n "$real" ] && ln -s "$real" "$TMP_ROOT/bin/$tool"
done
cat > "$TMP_ROOT/bin/brew" <<'EOF'
#!/bin/bash
case "$1" in
  --prefix) echo /tmp/ait-skill-test-homebrew ;;
  list) exit 1 ;;
  services|install) exit 0 ;;
  *) exit 0 ;;
esac
EOF
cat > "$TMP_ROOT/bin/lsof" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$TMP_ROOT/bin/claude" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$TMP_ROOT/bin/codex" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$TMP_ROOT/bin/"*
export PATH="$TMP_ROOT/bin:/usr/bin:/bin"
export AIT_SKIP_PLATFORM_CHECK=1

help="$("$REPO/ait" help skills)"
assert_contains "$help" "Usage: ait skills <install|remove|status>"
assert_contains "$("$REPO/ait" skills --help)" "Targets:"
assert_contains "$("$REPO/ait" skills install --help)" "Conflict:"
assert_contains "$("$REPO/ait" skills remove --help)" "Recovery:"
assert_contains "$("$REPO/ait" skills status --help)" "Exit behavior:"
set +e
("$REPO/ait" skills install extra >/dev/null 2>&1)
skills_extra_status=$?
("$REPO/bin/install-skill.sh" --status extra >/dev/null 2>&1)
installer_extra_status=$?
set -e
[ "$skills_extra_status" -eq 2 ] || fail "ait skills extra argument did not return 2"
[ "$installer_extra_status" -eq 2 ] || fail "installer extra argument did not return 2"
pass "skills help and usage"

bootstrap_optout_home="$TMP_ROOT/bootstrap-optout-home"
HOME="$bootstrap_optout_home"
export HOME
bootstrap_optout_output="$(AIT_NO_SKILLS=1 AIT_SKILLS_BOOTSTRAP=1 "$REPO/bin/install-skill.sh" --bootstrap)"
assert_contains "$bootstrap_optout_output" "skills  skipped (AIT_NO_SKILLS=1)"
assert_absent "$HOME/.claude"
assert_absent "$HOME/.agents"
pass "direct bootstrap opt-out skips links before mutation"

HOME="$TMP_ROOT/dual-home"
export HOME
mkdir -p "$HOME"
before="$(find "$HOME" -print | shasum -a 256 | awk '{print $1}')"
status_before="$("$REPO/ait" skills status)"
assert_contains "$status_before" "claude  not installed"
assert_contains "$status_before" "codex   not installed"
after="$(find "$HOME" -print | shasum -a 256 | awk '{print $1}')"
[ "$before" = "$after" ] || fail "skills status wrote to the home"
install_output="$("$REPO/bin/install-skill.sh" --install)"
assert_contains "$install_output" "Start a new harness session"
assert_file "$HOME/.claude/skills/delivery-coordination/SKILL.md"
assert_file "$HOME/.agents/skills/delivery-coordination/SKILL.md"
assert_contains "$("$REPO/ait" skills status)" "claude  ready"
assert_contains "$("$REPO/ait" skills status)" "codex   ready"
claude_link="$(readlink "$HOME/.claude/skills/delivery-coordination")"
codex_link="$(readlink "$HOME/.agents/skills/delivery-coordination")"
"$REPO/ait" skills install >/dev/null
[ "$(readlink "$HOME/.claude/skills/delivery-coordination")" = "$claude_link" ] || fail "Claude target changed on rerun"
[ "$(readlink "$HOME/.agents/skills/delivery-coordination")" = "$codex_link" ] || fail "Codex target changed on rerun"
pass "dual install, status, and rerun idempotency"

rm_output="$("$REPO/ait" skills remove)"
assert_contains "$rm_output" "Start a new harness session"
assert_absent "$HOME/.claude/skills/delivery-coordination"
assert_absent "$HOME/.agents/skills/delivery-coordination"
pass "owned remove preserves the source and removes only links"

rm "$TMP_ROOT/bin/codex"
HOME="$TMP_ROOT/claude-only-home"
export HOME
claude_only="$("$REPO/bin/install-skill.sh" --install)"
assert_contains "$claude_only" "claude  ready"
assert_contains "$claude_only" "codex   skipped"
assert_file "$HOME/.claude/skills/delivery-coordination/SKILL.md"
assert_absent "$HOME/.agents"
rm "$TMP_ROOT/bin/claude"
cat > "$TMP_ROOT/bin/codex" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$TMP_ROOT/bin/codex"
HOME="$TMP_ROOT/codex-only-home"
export HOME
codex_only="$("$REPO/bin/install-skill.sh" --install)"
assert_contains "$codex_only" "claude  skipped"
assert_contains "$codex_only" "codex   ready"
assert_file "$HOME/.agents/skills/delivery-coordination/SKILL.md"
assert_absent "$HOME/.claude"
pass "Claude-only and Codex-only targeting"

cat > "$TMP_ROOT/bin/claude" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$TMP_ROOT/bin/claude"
HOME="$TMP_ROOT/conflict-home"
export HOME
mkdir -p "$HOME/.claude/skills/delivery-coordination" "$HOME/.agents/skills"
printf foreign > "$HOME/.claude/skills/delivery-coordination/foreign.txt"
ln -s "$TMP_ROOT/other-checkout" "$HOME/.agents/skills/delivery-coordination"
set +e
conflict_output="$("$REPO/bin/install-skill.sh" --install 2>&1)"
conflict_status=$?
set -e
[ "$conflict_status" -ne 0 ] || fail "foreign targets were accepted"
assert_contains "$conflict_output" "refusing to replace"
assert_file "$HOME/.claude/skills/delivery-coordination/foreign.txt"
[ "$(readlink "$HOME/.agents/skills/delivery-coordination")" = "$TMP_ROOT/other-checkout" ] || fail "foreign link changed"
pass "foreign directory and symlink conflicts are preserved"

rm "$TMP_ROOT/bin/codex"
HOME="$TMP_ROOT/codex-absent-conflict-home"
export HOME
mkdir -p "$HOME/.agents/skills/delivery-coordination"
printf codex-foreign > "$HOME/.agents/skills/delivery-coordination/foreign.txt"
claude_absent_conflict="$("$REPO/bin/install-skill.sh" --install)"
assert_contains "$claude_absent_conflict" "claude  ready"
assert_file "$HOME/.claude/skills/delivery-coordination/SKILL.md"
assert_file "$HOME/.agents/skills/delivery-coordination/foreign.txt"
pass "absent-harness conflicts do not block present-harness install"

cat > "$TMP_ROOT/bin/codex" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$TMP_ROOT/bin/codex"

rm -rf "$HOME/.claude/skills/delivery-coordination"
printf foreign-file > "$HOME/.claude/skills/delivery-coordination"
file_conflict_before="$(cat "$HOME/.claude/skills/delivery-coordination")"
set +e
file_conflict_output="$("$REPO/bin/install-skill.sh" --install 2>&1)"
file_conflict_status=$?
set -e
[ "$file_conflict_status" -ne 0 ] || fail "foreign file target was accepted"
assert_contains "$file_conflict_output" "refusing to replace"
[ "$(cat "$HOME/.claude/skills/delivery-coordination")" = "$file_conflict_before" ] || fail "foreign file changed"
pass "foreign file conflict is preserved"

rm -f "$HOME/.claude/skills/delivery-coordination"
ln -s delivery-coordination "$HOME/.claude/skills/delivery-coordination"
cycle_output_file="$TMP_ROOT/cycle-status.out"
"$REPO/ait" skills status >"$cycle_output_file" 2>&1 &
cycle_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if ! kill -0 "$cycle_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
if kill -0 "$cycle_pid" 2>/dev/null; then
  kill -KILL "$cycle_pid" 2>/dev/null || true
  wait "$cycle_pid" 2>/dev/null || true
  fail "cycle-safe status did not return"
fi
wait "$cycle_pid"
cycle_output="$(sed -n '1,20p' "$cycle_output_file")"
assert_contains "$cycle_output" "conflict"
pass "cycle-safe target resolution returns a conflict"

rm -f "$HOME/.claude/skills/delivery-coordination"
ln -s "$TMP_ROOT/missing-source" "$HOME/.claude/skills/delivery-coordination"
set +e
broken_output="$("$REPO/ait" skills install 2>&1)"
broken_status=$?
set -e
[ "$broken_status" -ne 0 ] || fail "broken target was accepted"
assert_contains "$broken_output" "refusing to replace"
assert_contains "$("$REPO/ait" skills status)" "conflict"
pass "broken links are conflicts and status is read-only"

foreign_remove_home="$TMP_ROOT/foreign-remove-home"
HOME="$foreign_remove_home"
export HOME
mkdir -p "$HOME/.claude/skills" "$HOME/.agents/skills"
printf keep-me > "$HOME/.claude/skills/delivery-coordination"
ln -s "$TMP_ROOT/other-checkout" "$HOME/.agents/skills/delivery-coordination"
foreign_remove_output="$("$REPO/ait" skills remove 2>&1)"
assert_contains "$foreign_remove_output" "preserved"
assert_file "$HOME/.claude/skills/delivery-coordination"
[ "$(readlink "$HOME/.agents/skills/delivery-coordination")" = "$TMP_ROOT/other-checkout" ] || fail "foreign remove changed link"
pass "remove preserves foreign targets"

rm -f "$TMP_ROOT/bin/claude" "$TMP_ROOT/bin/codex"
HOME="$TMP_ROOT/no-harness-home"
export HOME
set +e
missing_output="$("$REPO/bin/install-skill.sh" --install 2>&1)"
missing_status=$?
set -e
[ "$missing_status" -ne 0 ] || fail "no-harness install unexpectedly succeeded"
assert_contains "$missing_output" "remedy: curl -fsSL https://claude.ai/install.sh | bash"
assert_contains "$missing_output" "remedy: curl -fsSL https://chatgpt.com/codex/install.sh | sh"
assert_absent "$HOME/.claude"
assert_absent "$HOME/.agents"
pass "no-harness install fails with both remedies before writes"

cat > "$TMP_ROOT/bin/claude" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$TMP_ROOT/bin/codex" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$TMP_ROOT/bin/claude" "$TMP_ROOT/bin/codex"

missing_source_repo="$TMP_ROOT/missing-source-repo"
mkdir -p "$missing_source_repo/bin"
cp "$REPO/bin/install-skill.sh" "$missing_source_repo/bin/install-skill.sh"
chmod +x "$missing_source_repo/bin/install-skill.sh"
HOME="$TMP_ROOT/missing-source-home"
export HOME
missing_source_path="$(cd "$missing_source_repo" && pwd -P)"
mkdir -p "$HOME/.claude/skills" "$HOME/.agents/skills"
ln -s "$missing_source_path/.agents/skills/delivery-coordination" "$HOME/.claude/skills/delivery-coordination"
ln -s "$missing_source_path/.agents/skills/delivery-coordination" "$HOME/.agents/skills/delivery-coordination"
set +e
missing_source_output="$("$missing_source_repo/bin/install-skill.sh" --install 2>&1)"
missing_source_status=$?
set -e
[ "$missing_source_status" -eq 1 ] || fail "missing source unexpectedly succeeded"
assert_contains "$missing_source_output" "missing skill source"
assert_contains "$("$missing_source_repo/bin/install-skill.sh" --status)" "ready"
"$missing_source_repo/bin/install-skill.sh" --remove >/dev/null
assert_absent "$HOME/.claude/skills/delivery-coordination"
assert_absent "$HOME/.agents/skills/delivery-coordination"
pass "missing skill source fails before writes"

partial_home="$TMP_ROOT/partial-home"
HOME="$partial_home"
export HOME
mkdir -p "$HOME/.agents"
printf blocked > "$HOME/.agents/skills"
set +e
partial_output="$("$REPO/bin/install-skill.sh" --install 2>&1)"
partial_status=$?
set -e
[ "$partial_status" -ne 0 ] || fail "partial skill install unexpectedly succeeded"
if [ ! -e "$HOME/.claude/skills/delivery-coordination/SKILL.md" ]; then
  fail "partial install output: $partial_output"
fi
assert_contains "$partial_output" "missing:"
rm -f "$HOME/.agents/skills"
mkdir -p "$HOME/.agents/skills"
resume_output="$("$REPO/bin/install-skill.sh" --install)"
assert_file "$HOME/.agents/skills/delivery-coordination/SKILL.md"
assert_contains "$resume_output" "Start a new harness session"
pass "partial skill install reports progress and resumes idempotently"

partial_remove_home="$TMP_ROOT/partial-remove-home"
HOME="$partial_remove_home"
export HOME
"$REPO/bin/install-skill.sh" --install >/dev/null
rm_shim_dir="$TMP_ROOT/rm-shim"
rm_count="$TMP_ROOT/rm-count"
mkdir -p "$rm_shim_dir"
cat > "$rm_shim_dir/rm" <<'EOF'
#!/bin/bash
count=0
[ -f "$AIT_RM_COUNT" ] && count="$(sed -n '1p' "$AIT_RM_COUNT")"
count=$((count + 1))
echo "$count" > "$AIT_RM_COUNT"
[ "$count" -eq 2 ] && exit 1
exec /bin/rm "$@"
EOF
chmod +x "$rm_shim_dir/rm"
set +e
partial_remove_output="$(PATH="$rm_shim_dir:$TMP_ROOT/bin:/usr/bin:/bin" AIT_RM_COUNT="$rm_count" "$REPO/bin/install-skill.sh" --remove 2>&1)"
partial_remove_status=$?
set -e
[ "$partial_remove_status" -ne 0 ] || fail "partial skill remove unexpectedly succeeded"
assert_absent "$HOME/.claude/skills/delivery-coordination"
assert_file "$HOME/.agents/skills/delivery-coordination/SKILL.md"
assert_contains "$partial_remove_output" "remaining managed links"
"$REPO/bin/install-skill.sh" --remove >/dev/null
assert_absent "$HOME/.agents/skills/delivery-coordination"
pass "partial skill remove reports remaining ownership and resumes"

readonly_home="$TMP_ROOT/readonly-home"
HOME="$readonly_home"
export HOME
mkdir -p "$HOME/.claude/skills"
chmod 500 "$HOME/.claude/skills"
set +e
readonly_output="$("$REPO/bin/install-skill.sh" --install 2>&1)"
readonly_status=$?
set -e
chmod 700 "$HOME/.claude/skills"
[ "$readonly_status" -ne 0 ] || fail "read-only skill parent unexpectedly succeeded"
assert_contains "$readonly_output" "could not be linked"
assert_absent "$HOME/.claude/skills/delivery-coordination"
pass "read-only skill parent fails without writes"

race_home="$TMP_ROOT/race-home"
HOME="$race_home"
export HOME
race_bin="$TMP_ROOT/race-bin"
mkdir -p "$race_bin"
cat > "$race_bin/ln" <<'EOF'
#!/bin/bash
printf race > "$AIT_RACE_TARGET"
exec /bin/ln "$@"
EOF
chmod +x "$race_bin/ln"
set +e
race_output="$(PATH="$race_bin:$TMP_ROOT/bin:/usr/bin:/bin" AIT_RACE_TARGET="$HOME/.claude/skills/delivery-coordination" "$REPO/bin/install-skill.sh" --install 2>&1)"
race_status=$?
set -e
[ "$race_status" -ne 0 ] || fail "target creation race unexpectedly succeeded"
assert_contains "$race_output" "target appeared"
assert_file "$HOME/.claude/skills/delivery-coordination"
[ "$(cat "$HOME/.claude/skills/delivery-coordination")" = race ] || fail "race target changed"
pass "target creation race preserves the non-owned target"

signal_home="$TMP_ROOT/signal-home"
HOME="$signal_home"
export HOME
signal_bin="$TMP_ROOT/signal-bin"
signal_flag="$TMP_ROOT/signal-flag"
mkdir -p "$signal_bin"
cat > "$signal_bin/mkdir" <<'EOF'
#!/bin/bash
if [ ! -e "$AIT_SIGNAL_FLAG" ]; then
  : > "$AIT_SIGNAL_FLAG"
  kill -TERM "$PPID"
fi
exec /bin/mkdir "$@"
EOF
chmod +x "$signal_bin/mkdir"
set +e
signal_output="$(PATH="$signal_bin:$TMP_ROOT/bin:/usr/bin:/bin" AIT_SIGNAL_FLAG="$signal_flag" "$REPO/bin/install-skill.sh" --install 2>&1)"
signal_status=$?
set -e
[ "$signal_status" -eq 130 ] || fail "skill interrupt returned $signal_status"
assert_contains "$signal_output" "skill install interrupted"
assert_contains "$signal_output" "recovery: ait skills install"
pass "skill signal interruption reports truthful recovery"

cat > "$TMP_ROOT/bin/claude" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$TMP_ROOT/bin/codex" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$TMP_ROOT/bin/claude" "$TMP_ROOT/bin/codex"
public_source="$TMP_ROOT/public-source"
mkdir -p "$public_source"
tar -C "$REPO" --exclude .git -cf - . | tar -C "$public_source" -xf -
git -C "$public_source" init -q
git -C "$public_source" config user.email ait-test@example.invalid
git -C "$public_source" config user.name ait-test
git -C "$public_source" add -A
git -C "$public_source" commit -qm snapshot

marker_state_file="$TMP_ROOT/marker-state-file"
printf occupied > "$marker_state_file"
marker_failure_root="$TMP_ROOT/marker-failure-root"
set +e
marker_failure_output="$(HOME="$TMP_ROOT/marker-failure-home" AIT_REPO_URL="file://$public_source" AIT_INSTALL_ROOT="$marker_failure_root" AIT_INSTALL_STATE_DIR="$marker_state_file" AIT_CLI_LINK="$TMP_ROOT/marker-failure-bin/ait" AIT_INSTALL_SKIP_PROVISION=1 "$REPO/install.sh" 2>&1)"
marker_failure_status=$?
set -e
[ "$marker_failure_status" -ne 0 ] || fail "unwritable marker state unexpectedly succeeded"
assert_contains "$marker_failure_output" "set AIT_INSTALL_STATE_DIR"
assert_absent "$marker_failure_root"
pass "marker failure reports a named pre-clone recovery"

no_harness_bin="$TMP_ROOT/no-harness-bin"
mkdir -p "$no_harness_bin"
for tool in git node npm openssl curl brew; do
  ln -s "$TMP_ROOT/bin/$tool" "$no_harness_bin/$tool"
done
no_harness_root="$TMP_ROOT/no-harness-bootstrap-root"
set +e
no_harness_bootstrap_output="$(HOME="$TMP_ROOT/no-harness-bootstrap-home" PATH="$no_harness_bin:/usr/bin:/bin" AIT_SKIP_PLATFORM_CHECK=1 AIT_NO_SKILLS=1 AIT_REPO_URL="file://$public_source" AIT_INSTALL_ROOT="$no_harness_root" AIT_CLI_LINK="$TMP_ROOT/no-harness-bin/ait" "$REPO/install.sh" 2>&1)"
no_harness_bootstrap_status=$?
set -e
[ "$no_harness_bootstrap_status" -ne 0 ] || fail "opt-out waived the harness prerequisite"
if ! printf '%s\n' "$no_harness_bootstrap_output" | grep -Fq "missing: Claude Code"; then
  fail "no-harness bootstrap output: $no_harness_bootstrap_output"
fi
assert_contains "$no_harness_bootstrap_output" "Prerequisites: FAILED"
assert_absent "$no_harness_root"
pass "fresh opt-out still requires a supported harness"

public_home="$TMP_ROOT/public-home"
public_root="$TMP_ROOT/public-root"
public_output="$(
  HOME="$public_home" \
  AIT_REPO_URL="file://$public_source" \
  AIT_INSTALL_ROOT="$public_root" \
  AIT_CLI_LINK="$TMP_ROOT/public-bin/ait" \
  AIT_INSTALL_STATE_DIR="$TMP_ROOT/public-state" \
  AIT_INSTALL_SKIP_PROVISION=1 \
  "$REPO/install.sh"
)"
assert_contains "$public_output" "skills  ready (claude, codex)"
assert_file "$public_home/.claude/skills/delivery-coordination/SKILL.md"
assert_file "$public_home/.agents/skills/delivery-coordination/SKILL.md"
printf '\nrebuild-visible\n' >> "$public_root/.agents/skills/delivery-coordination/SKILL.md"
assert_contains "$(cat "$public_home/.claude/skills/delivery-coordination/SKILL.md")" "rebuild-visible"
claude_public_link="$(readlink "$public_home/.claude/skills/delivery-coordination")"
public_rerun="$(
  HOME="$public_home" \
  AIT_REPO_URL="file://$public_source" \
  AIT_INSTALL_ROOT="$public_root" \
  AIT_CLI_LINK="$TMP_ROOT/public-bin/ait" \
  AIT_INSTALL_STATE_DIR="$TMP_ROOT/public-state" \
  AIT_INSTALL_SKIP_PROVISION=1 \
  "$REPO/install.sh"
)"
[ "$(readlink "$public_home/.claude/skills/delivery-coordination")" = "$claude_public_link" ] || fail "bootstrap rerun changed skill link"
if echo "$public_rerun" | grep -Fq "Skills:"; then
  fail "nonfresh bootstrap rerun reported skills"
fi
pass "fresh public bootstrap defaults on and rerun is skill-silent"

legacy_home="$TMP_ROOT/legacy-no-links-home"
legacy_output="$(HOME="$legacy_home" AIT_CLI_LINK="$TMP_ROOT/legacy-bin/ait" AIT_INSTALL_STATE_DIR="$TMP_ROOT/legacy-state" AIT_INSTALL_SKIP_PROVISION=1 "$public_root/bin/install.sh" --machine)"
if echo "$legacy_output" | grep -Fq "Skills:"; then
  fail "legacy nonfresh install reported skills"
fi
assert_absent "$legacy_home/.claude"
assert_absent "$legacy_home/.agents"
pass "legacy nonfresh rerun with no links remains skill-silent"

collision_home="$TMP_ROOT/collision-home"
collision_root="$TMP_ROOT/collision-root"
collision_target="$collision_home/.claude/skills/delivery-coordination"
mkdir -p "$collision_target"
printf foreign > "$collision_target/owned-by-operator"
set +e
collision_output="$(HOME="$collision_home" AIT_REPO_URL="file://$public_source" AIT_INSTALL_ROOT="$collision_root" AIT_CLI_LINK="$TMP_ROOT/collision-bin/ait" AIT_INSTALL_STATE_DIR="$TMP_ROOT/collision-state" AIT_INSTALL_SKIP_PROVISION=1 "$REPO/install.sh" 2>&1)"
collision_status=$?
set -e
[ "$collision_status" -ne 0 ] || fail "fresh bootstrap collision unexpectedly succeeded"
if ! printf '%s\n' "$collision_output" | grep -Fq "move the existing target aside"; then
  fail "collision output: $collision_output"
fi
assert_contains "$collision_output" "AIT_NO_SKILLS=1"
assert_file "$collision_root/bin/install-skill.sh"
assert_file "$TMP_ROOT/collision-state/bootstrap-pending"
mv "$collision_target" "$collision_target.moved"
move_aside_output="$(HOME="$collision_home" AIT_REPO_URL="file://$public_source" AIT_INSTALL_ROOT="$collision_root" AIT_CLI_LINK="$TMP_ROOT/collision-bin/ait" AIT_INSTALL_STATE_DIR="$TMP_ROOT/collision-state" AIT_INSTALL_SKIP_PROVISION=1 "$REPO/install.sh")"
assert_contains "$move_aside_output" "skills  ready (claude, codex)"
assert_file "$collision_home/.claude/skills/delivery-coordination/SKILL.md"
assert_file "$collision_target.moved/owned-by-operator"
assert_absent "$TMP_ROOT/collision-state/bootstrap-pending"
pass "bootstrap collision move-aside recovery installs owned links"

optout_collision_home="$TMP_ROOT/optout-collision-home"
optout_collision_root="$TMP_ROOT/optout-collision-root"
optout_collision_target="$optout_collision_home/.claude/skills/delivery-coordination"
mkdir -p "$optout_collision_target"
printf foreign > "$optout_collision_target/owned-by-operator"
set +e
optout_collision_output="$(HOME="$optout_collision_home" AIT_REPO_URL="file://$public_source" AIT_INSTALL_ROOT="$optout_collision_root" AIT_CLI_LINK="$TMP_ROOT/optout-collision-bin/ait" AIT_INSTALL_STATE_DIR="$TMP_ROOT/optout-collision-state" AIT_INSTALL_SKIP_PROVISION=1 "$REPO/install.sh" 2>&1)"
optout_collision_status=$?
set -e
[ "$optout_collision_status" -ne 0 ] || fail "second bootstrap collision unexpectedly succeeded"
assert_contains "$optout_collision_output" "AIT_NO_SKILLS=1"
set +e
collision_resume_output="$(HOME="$optout_collision_home" AIT_NO_SKILLS=1 AIT_REPO_URL="file://$public_source" AIT_INSTALL_ROOT="$optout_collision_root" AIT_CLI_LINK="$TMP_ROOT/optout-collision-bin/ait" AIT_INSTALL_STATE_DIR="$TMP_ROOT/optout-collision-state" AIT_INSTALL_SKIP_PROVISION=1 "$REPO/install.sh" 2>&1)"
collision_resume_status=$?
set -e
[ "$collision_resume_status" -eq 0 ] || fail "opt-out collision recovery failed"
assert_contains "$collision_resume_output" "skills  skipped (AIT_NO_SKILLS=1)"
assert_absent "$TMP_ROOT/optout-collision-state/bootstrap-pending"
assert_file "$optout_collision_target/owned-by-operator"
pass "bootstrap collision opt-out recovery preserves the foreign target"

optout_home="$TMP_ROOT/optout-home"
optout_root="$TMP_ROOT/optout-root"
optout_output="$(
  HOME="$optout_home" \
  AIT_NO_SKILLS=1 \
  AIT_REPO_URL="file://$public_source" \
  AIT_INSTALL_ROOT="$optout_root" \
  AIT_CLI_LINK="$TMP_ROOT/optout-bin/ait" \
  AIT_INSTALL_STATE_DIR="$TMP_ROOT/optout-state" \
  AIT_INSTALL_SKIP_PROVISION=1 \
  "$REPO/install.sh"
)"
assert_contains "$optout_output" "skills  skipped (AIT_NO_SKILLS=1)"
assert_absent "$optout_home/.claude"
assert_absent "$optout_home/.agents"
pass "fresh opt-out creates no skill targets"

invalid_root="$TMP_ROOT/invalid-root"
set +e
invalid_output="$(HOME="$TMP_ROOT/invalid-home" AIT_NO_SKILLS=2 AIT_REPO_URL="file://$public_source" AIT_INSTALL_ROOT="$invalid_root" "$REPO/install.sh" 2>&1)"
invalid_status=$?
set -e
[ "$invalid_status" -ne 0 ] || fail "invalid AIT_NO_SKILLS succeeded"
assert_contains "$invalid_output" "AIT_NO_SKILLS must be empty or 1"
assert_absent "$invalid_root"
pass "invalid opt-out fails before checkout writes"

HOME="$TMP_ROOT/init-home"
export HOME
mkdir -p "$HOME"
mkdir -p "$public_root/mcp/dist"
: > "$public_root/mcp/dist/server.js"
cat > "$public_root/bin/status.sh" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$public_root/bin/status.sh"
mkdir -p "$TMP_ROOT/project"
public_repo_path="$(cd "$public_root" && pwd -P)"
printf '{"mcpServers":{"ait-protocol":{"command":"node","args":["--enable-source-maps","%s/mcp/dist/server.js"]}}}\n' "$public_repo_path" > "$TMP_ROOT/project/.mcp.json"
mkdir -p "$HOME/.claude/skills" "$HOME/.agents/skills"
ln -s "$public_repo_path/.agents/skills/delivery-coordination" "$HOME/.claude/skills/delivery-coordination"
ln -s "$public_repo_path/.agents/skills/delivery-coordination" "$HOME/.agents/skills/delivery-coordination"
skill_snapshot() {
  local target
  for target in "$HOME/.claude/skills/delivery-coordination" "$HOME/.agents/skills/delivery-coordination"; do
    if [ -L "$target" ]; then
      echo "$target -> $(readlink "$target")"
    elif [ -e "$target" ]; then
      shasum -a 256 "$target"
    else
      echo "$target missing"
    fi
  done | shasum -a 256 | awk '{print $1}'
}
before_init="$(skill_snapshot)"
set +e
init_output="$(AIT_NO_SKILLS=1 "$public_root/ait" init "$TMP_ROOT/project" 2>&1)"
init_status=$?
set -e
[ "$init_status" -eq 0 ] || fail "ait init failed: $init_output"
after_init="$(skill_snapshot)"
[ "$before_init" = "$after_init" ] || fail "ait init touched machine skill targets with opt-out"
set +e
invalid_init_output="$(AIT_NO_SKILLS=bogus "$public_root/ait" init "$TMP_ROOT/project" 2>&1)"
invalid_init_status=$?
set -e
[ "$invalid_init_status" -eq 0 ] || fail "ait init read the bootstrap-only opt-out: $invalid_init_output"
[ "$after_init" = "$(skill_snapshot)" ] || fail "ait init changed skill targets with invalid opt-out"
pass "ait init remains skill-neutral"

echo "AIT skill test suite passed"
