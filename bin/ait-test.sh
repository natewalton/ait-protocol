#!/bin/bash
# Local, isolated regression suite for the public AIT CLI and installer.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REAL_CURL="$(command -v curl)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ait-test.XXXXXX")"
cleanup_fixture_processes() {
  local pid_file pid
  set +e
  if [ -n "${start_pid:-}" ]; then kill "$start_pid" 2>/dev/null || true; fi
  if [ -n "${http_pid:-}" ]; then
    kill "$http_pid" 2>/dev/null || true
    wait "$http_pid" 2>/dev/null || true
  fi
  for pid_file in "$TMP_ROOT"/start-wrapper-pids/* "$TMP_ROOT"/*wrapper-pids/*; do
    [ -f "$pid_file" ] || continue
    pid="$(sed -n '1p' "$pid_file")"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP_ROOT"
}
trap cleanup_fixture_processes EXIT
trap 'cleanup_fixture_processes; exit 130' INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
assert_file() { [ -e "$1" ] || fail "missing $1"; }
assert_absent() { [ ! -e "$1" ] || fail "unexpected file $1"; }
assert_contains() { grep -Fq -- "$2" <<< "$1" || fail "expected '$2'"; }
assert_not_contains() { if grep -Fq -- "$2" <<< "$1"; then fail "unexpected '$2'"; fi; }
assert_same() { [ "$1" = "$2" ] || fail "expected '$1', got '$2'"; }
process_alive() {
  local state
  state="$(ps -p "$1" -o stat= 2>/dev/null | tr -d ' ')"
  case "$state" in ''|Z*) return 1 ;; *) return 0 ;; esac
}

for f in install.sh ait bin/ait-test.sh bin/install.sh bin/status.sh bin/start-all.sh bin/claude-session.sh bin/codex-session.sh bin/run-plc.sh; do
  bash -n "$REPO/$f" || fail "syntax: $f"
done
pass "shell syntax"

assert_mode_600() {
  local mode
  mode="$(stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1")"
  [ "$mode" = 600 ] || fail "expected mode 600 for $1, got $mode"
}

launcher_fixture="$TMP_ROOT/launcher-host"
mkdir -p "$launcher_fixture/plc/node_modules/@did-plc/server" \
  "$launcher_fixture/pds/node_modules/@atproto/pds" "$launcher_fixture/results"
cp "$REPO/plc/launcher.js" "$launcher_fixture/plc/launcher.js"
cp "$REPO/pds/launcher.js" "$launcher_fixture/pds/launcher.js"
cat > "$launcher_fixture/plc/node_modules/@did-plc/server/index.js" <<'EOF'
const fs = require('fs')
const result = process.env.AIT_LISTEN_RESULT
const app = { listen(port, host) { fs.writeFileSync(result, JSON.stringify({ port, host })); return {} } }
module.exports = {
  Database: { mock() { return {} } },
  PlcServer: { create({ port }) { return { app, start: async () => app.listen(port), destroy: async () => {} } } },
}
EOF
cat > "$launcher_fixture/pds/node_modules/@atproto/pds/index.js" <<'EOF'
const fs = require('fs')
const result = process.env.AIT_LISTEN_RESULT
const app = { listen(port, host) { fs.writeFileSync(result, JSON.stringify({ port, host })); return {} } }
module.exports = {
  PDS: { async create(cfg) { return { app, start: async () => app.listen(cfg.service.port), destroy: async () => {} } } },
  envToCfg() { return { service: { port: 2583 } } },
  envToSecrets() { return {} },
  readEnv() { return {} },
  httpLogger: { info() {} },
}
EOF
printf '%s\n' '{"version":"0.4.226"}' > "$launcher_fixture/pds/node_modules/@atproto/pds/package.json"
AIT_LISTEN_RESULT="$launcher_fixture/results/plc.json" node "$launcher_fixture/plc/launcher.js"
assert_contains "$(cat "$launcher_fixture/results/plc.json")" '"host":"127.0.0.1"'
AIT_LISTEN_RESULT="$launcher_fixture/results/pds.json" node "$launcher_fixture/pds/launcher.js"
assert_contains "$(cat "$launcher_fixture/results/pds.json")" '"host":"127.0.0.1"'
assert_contains "$(sed -n '/xrpc\.router\.listen(PORT/ p' "$REPO/appview/src/server.ts")" "127.0.0.1"
pass "PLC, PDS, and AppView listener hosts are loopback"

help="$("$REPO/ait" --help)"
assert_contains "$help" "init [path]"
assert_contains "$help" "Manual update sequence"
assert_contains "$help" "ait stop"
assert_contains "$help" "git pull --ff-only"
assert_contains "$help" "npm --prefix mcp run build"
assert_contains "$help" "npm --prefix appview run build"
assert_contains "$help" "bin/start-all.sh"
assert_not_contains "$help" 'git -C "$HOME/.local/share/ait-protocol" pull --ff-only'
assert_same "$help" "$("$REPO/ait")"
assert_same "$help" "$("$REPO/ait" help)"
for topic in init start stop status claude codex resume skills help version update uninstall; do
  page="$("$REPO/ait" help "$topic")"
  assert_contains "$page" "Usage:"
  assert_contains "$page" "Prerequisites:"
  assert_contains "$page" "Changes:"
  assert_contains "$page" "Recovery:"
done
assert_contains "$("$REPO/ait" version --help)" "Usage: ait version"
assert_same "$("$REPO/ait" help help)" "$("$REPO/ait" help --help)"
version="$("$REPO/ait" version)"
current_version="$(tr -d '[:space:]' < "$REPO/VERSION")"
current_commit="$(git -C "$REPO" rev-parse HEAD)"
assert_contains "$version" "AIT $current_version (${current_commit:0:16})"
if [ "$(git -C "$REPO" rev-parse "refs/ait-release/v$current_version^{commit}" 2>/dev/null || true)" = "$current_commit" ] ||
   [ -n "$(git -C "$REPO" tag --points-at HEAD "v$current_version" 2>/dev/null)" ]; then
  assert_not_contains "$version" development
else
  assert_contains "$version" development
fi
pass "help, version, and bare CLI help"

for form in \
  'claude --resume 11111111-1111-4111-8111-111111111111' \
  'claude -r 11111111-1111-4111-8111-111111111111' \
  'claude --resume-last' \
  'codex --resume 22222222-2222-4222-8222-222222222222' \
  'codex --session 22222222-2222-4222-8222-222222222222'; do
  set +e
  migration_output="$($REPO/ait $form 2>&1)"
  migration_status=$?
  set -e
  [ "$migration_status" -eq 2 ] || fail "former resume form was not rejected: $form"
  assert_contains "$migration_output" "ait resume"
done
pass "former public resume forms migrate before launcher"

space_dir="$TMP_ROOT/path with spaces"
mkdir -p "$space_dir/bin"
ln -s "$REPO/ait" "$space_dir/bin/ait"
assert_same "$help" "$("$space_dir/bin/ait" --help)"
pass "symlink-aware root discovery"

set +e
invalid="$("$REPO/ait" no-such-command 2>&1)"
invalid_status=$?
set -e
[ "$invalid_status" -eq 2 ] || fail "unknown command exit"
assert_contains "$invalid" "Run: ait help"
pass "invalid command exit"

make_fixture() {
  local dir="$1" shim="$1/shim" f
  mkdir -p "$dir/bin" "$dir/plc" "$dir/pds" "$dir/appview" "$dir/mcp" "$shim" "$dir/home"
  cp "$REPO/ait" "$dir/ait"
  cp "$REPO/bin/install.sh" "$dir/bin/install.sh"
  cp "$REPO/bin/install-skill.sh" "$dir/bin/install-skill.sh"
  cp "$REPO/bin/status.sh" "$dir/bin/status.sh"
  cp "$REPO/bin/start-all.sh" "$dir/bin/start-all.sh"
  cp "$REPO/bin/lib-service-pids.sh" "$dir/bin/lib-service-pids.sh"
  cp "$REPO/bin/claude-session.sh" "$dir/bin/claude-session.sh"
  cp "$REPO/bin/codex-session.sh" "$dir/bin/codex-session.sh"
  cp "$REPO/bin/check-single-lexicon.sh" "$dir/bin/check-single-lexicon.sh"
  chmod +x "$dir/ait" "$dir/bin/"*.sh
  cat > "$dir/bin/status.sh" <<'EOF'
#!/bin/sh
echo 'AIT status:'
printf '  plc running\n  pds running\n  appview running\n  codex-appserver skipped (not installed)\n'
EOF
  cat > "$dir/bin/start-all.sh" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$dir/bin/status.sh" "$dir/bin/start-all.sh"
  mkdir -p "$dir/.agents/skills/delivery-coordination"
  cp "$REPO/.agents/skills/delivery-coordination/SKILL.md" "$dir/.agents/skills/delivery-coordination/SKILL.md"
  for f in plc/package.json plc/package-lock.json pds/package.json pds/package-lock.json appview/package.json appview/package-lock.json mcp/package.json mcp/package-lock.json; do
    : > "$dir/$f"
  done
  cp "$REPO/appview/.env.example" "$dir/appview/.env.example"
  cp "$REPO/mcp/.env.example" "$dir/mcp/.env.example"
  mkdir -p "$dir/pg/bin"
  printf '#!/bin/sh\nexit 0\n' > "$dir/pg/bin/psql"
  printf '#!/bin/sh\nexit 0\n' > "$dir/pg/bin/createdb"
  chmod +x "$dir/pg/bin/psql" "$dir/pg/bin/createdb"
  cat > "$shim/brew" <<EOF
#!/bin/bash
case "\$1" in
  --prefix)
    if [ "\$2" = postgresql@17 ]; then echo "$dir/pg"; else echo "\$HOME/.homebrew"; fi ;;
  list) exit 0 ;;
  services) exit 0 ;;
  install) exit 0 ;;
  *) exit 0 ;;
esac
EOF
  cat > "$shim/npm" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$shim/npm"
  cat > "$shim/claude" <<'EOF'
#!/bin/bash
if [ "$1" = mcp ] && [ "$2" = get ]; then
  exit 0
fi
exit 0
EOF
  cat > "$shim/lsof" <<'EOF'
#!/bin/bash
exit 0
EOF
  cat > "$shim/pgrep" <<'EOF'
#!/bin/bash
exit 0
EOF
  for f in git node npm openssl curl; do
    if [ ! -e "$shim/$f" ] && command -v "$f" >/dev/null 2>&1; then
      ln -s "$(command -v "$f")" "$shim/$f"
    fi
  done
  chmod +x "$shim/brew" "$shim/claude" "$shim/lsof" "$shim/pgrep"
}

fixture="$TMP_ROOT/fixture"
make_fixture "$fixture"
PATH="$fixture/shim:/usr/bin:/bin"
export PATH HOME="$TMP_ROOT/home"
machine_output="$("$fixture/bin/install.sh")"
assert_contains "$machine_output" "Prerequisites: ✓"
assert_contains "$machine_output" "codex    skipped (not installed)"
assert_contains "$machine_output" "Environment: ✓"
assert_file "$fixture/plc/.env"
assert_file "$fixture/pds/.env"
assert_file "$fixture/appview/.env"
assert_file "$fixture/mcp/.env"
[ ! -e "$TMP_ROOT/install-state" ] || fail "installer created persisted environment state"
[ -L "$HOME/.homebrew/bin/ait" ] || fail "CLI link not created"
pass "isolated machine install and optional harness row"

prereq_failure="$TMP_ROOT/prereq-failure"
make_fixture "$prereq_failure"
rm -f "$prereq_failure/shim/brew"
export PATH="$prereq_failure/shim:/usr/bin:/bin"
set +e
prereq_failure_output="$("$prereq_failure/bin/install.sh" 2>&1)"
prereq_failure_status=$?
set -e
[ "$prereq_failure_status" -ne 0 ] || fail "suppressed prerequisite failure unexpectedly succeeded"
assert_contains "$prereq_failure_output" "missing: Homebrew"
assert_contains "$prereq_failure_output" "Prerequisites: FAILED"
pass "suppressed preflight failure retains diagnosis"

node_floor="$TMP_ROOT/node-floor"
make_fixture "$node_floor"
rm -f "$node_floor/shim/node"
cat > "$node_floor/shim/node" <<'EOF'
#!/bin/sh
if [ "$1" = --version ]; then echo v18.20.0; else exit 0; fi
EOF
chmod +x "$node_floor/shim/node"
export PATH="$node_floor/shim:/usr/bin:/bin" HOME="$node_floor/home"
set +e
node_floor_output="$("$node_floor/bin/install.sh" 2>&1)"
node_floor_status=$?
set -e
[ "$node_floor_status" -ne 0 ] || fail "old Node.js unexpectedly accepted"
assert_contains "$node_floor_output" "Node.js 20 or later"
pass "Node.js 20 floor is enforced"

export PATH="$fixture/shim:/usr/bin:/bin"
bare_update_output="$("$fixture/bin/install.sh")"
assert_contains "$bare_update_output" "AIT files:"
pass "bare private installer update command performs a machine install"

codex_only="$TMP_ROOT/codex-only"
make_fixture "$codex_only"
rm -f "$codex_only/shim/claude"
cat > "$codex_only/shim/codex" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$codex_only/shim/codex"
export PATH="$codex_only/shim:/usr/bin:/bin"
export HOME="$codex_only/home"
codex_only_output="$("$codex_only/bin/install.sh")"
assert_not_contains "$codex_only_output" "missing: Claude Code"
assert_contains "$codex_only_output" "claude   skipped (not installed)"
assert_contains "$codex_only_output" "codex    ready"
pass "Codex-only machine preflight and plain Claude skip"

export PATH="$fixture/shim:/usr/bin:/bin"
export HOME="$fixture/home"
before="$(shasum -a 256 "$fixture/plc/.env" | awk '{print $1}')"
chmod 644 "$fixture"/{plc,pds,appview,mcp}/.env
rerun_output="$("$fixture/bin/install.sh")"
after="$(shasum -a 256 "$fixture/plc/.env" | awk '{print $1}')"
assert_same "$before" "$after"
assert_contains "$rerun_output" "existing four-file set preserved"
for env_file in "$fixture"/{plc,pds,appview,mcp}/.env; do assert_mode_600 "$env_file"; done
pass "safe machine rerun preserves env bytes"

chmod 644 "$fixture"/{plc,pds,appview,mcp}/.env
rebuild_output="$("$fixture/bin/install.sh" --rebuild-only)"
assert_contains "$rebuild_output" "Rebuild: complete"
for env_file in "$fixture"/{plc,pds,appview,mcp}/.env; do assert_mode_600 "$env_file"; done
pass "rebuild repairs existing env modes before dependencies"

chmod_failure="$TMP_ROOT/chmod-failure"
make_fixture "$chmod_failure"
chmod_failure="$(cd "$chmod_failure" && pwd -P)"
export PATH="$chmod_failure/shim:/usr/bin:/bin" HOME="$chmod_failure/home"
"$chmod_failure/bin/install.sh" >/dev/null
cat > "$chmod_failure/shim/chmod" <<EOF
#!/bin/bash
if [ "\$1" = 600 ] && [ "\$2" = "$chmod_failure/plc/.env" ]; then exit 1; fi
exec /bin/chmod "\$@"
EOF
chmod +x "$chmod_failure/shim/chmod"
export PATH="$chmod_failure/shim:/usr/bin:/bin" HOME="$chmod_failure/home"
set +e
chmod_failure_output="$("$chmod_failure/bin/install.sh" --rebuild-only 2>&1)"
chmod_failure_status=$?
set -e
[ "$chmod_failure_status" -ne 0 ] || fail "chmod failure unexpectedly succeeded"
assert_contains "$chmod_failure_output" "could not set private mode on existing environment file:"
assert_contains "$chmod_failure_output" "/plc/.env"
pass "rebuild names an env file when chmod fails"

boundary="$TMP_ROOT/process-boundary"
make_fixture "$boundary"
boundary="$(cd "$boundary" && pwd -P)"
mkdir -p "$boundary"/{plc,pds,appview,mcp}/node_modules "$boundary/appview/dist" "$boundary/mcp/dist"
: > "$boundary/appview/dist/server.js"
: > "$boundary/mcp/dist/server.js"
cat > "$boundary/shim/lsof" <<'EOF'
#!/bin/bash
case "$*" in
  *'-d cwd'*) printf 'p4242\nn%s\n' "$AIT_TEST_SERVICE_CWD" ;;
  *) echo 4242 ;;
esac
EOF
cat > "$boundary/bin/status.sh" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$boundary/shim/lsof" "$boundary/bin/status.sh"
export HOME="$boundary/home" PATH="$boundary/shim:/usr/bin:/bin"
same_boundary="$(AIT_TEST_SERVICE_CWD="$boundary" "$boundary/bin/install.sh")"
assert_contains "$same_boundary" "existing dependencies and builds verified"
set +e
foreign_boundary="$(AIT_TEST_SERVICE_CWD="$TMP_ROOT/foreign-checkout" "$boundary/bin/install.sh" 2>&1)"
foreign_boundary_status=$?
set -e
[ "$foreign_boundary_status" -ne 0 ] || fail "foreign service cwd unexpectedly accepted"
assert_contains "$foreign_boundary" "conflicting plc process pid 4242"
pass "service ownership accepts this checkout and refuses a foreign cwd"

partial="$TMP_ROOT/partial"
make_fixture "$partial"
export HOME="$partial/home"
export PATH="$partial/shim:/usr/bin:/bin"
printf 'operator-owned\n' > "$partial/plc/.env"
set +e
partial_output="$("$partial/bin/install.sh" 2>&1)"
partial_status=$?
set -e
[ "$partial_status" -ne 0 ] || fail "partial environment unexpectedly succeeded"
assert_contains "$partial_output" "partial environment set"
assert_contains "$partial_output" "restore the missing established files"
assert_absent "$partial/pds/.env"
pass "unproven partial environment fails unchanged"

status_fixture="$TMP_ROOT/status"
make_fixture "$status_fixture"
export HOME="$status_fixture/home"
rm -f "$status_fixture/shim/curl"
cat > "$status_fixture/shim/curl" <<'EOF'
#!/bin/bash
echo '{}'
EOF
chmod +x "$status_fixture/shim/curl"
cat > "$status_fixture/shim/codex" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$status_fixture/shim/codex"
export PATH="$status_fixture/shim:/usr/bin:/bin"
status_output="$("$status_fixture/bin/status.sh")"
assert_contains "$status_output" "plc"
assert_contains "$status_output" "codex-appserver"
pass "status table and Codex optional probe"

mkdir -p "$status_fixture/mcp/dist" "$status_fixture/project dir"
: > "$status_fixture/mcp/dist/server.js"
rm -f "$status_fixture/shim/claude"
export AIT_FAKE_MCP_ROOT="$(cd "$status_fixture" && pwd -P)"
cat > "$status_fixture/shim/claude" <<EOF
#!/bin/bash
if [ "\$1" = mcp ] && [ "\$2" = get ]; then exit 0; fi
if [ "\$1" = mcp ] && [ "\$2" = add ]; then
  repo="$AIT_FAKE_MCP_ROOT"
  printf '{"mcpServers":{"ait-protocol":{"command":"node","args":["--enable-source-maps","%s/mcp/dist/server.js"]}}}\n' "\$repo" > .mcp.json
  exit 0
fi
exit 0
EOF
chmod +x "$status_fixture/shim/claude"
dual_output="$("$status_fixture/bin/install.sh")"
assert_contains "$dual_output" "claude   ready"
assert_contains "$dual_output" "codex    ready"
pass "dual-harness machine matrix"

set +e
init_output="$("$status_fixture/ait" init "$status_fixture/project dir" 2>&1)"
init_status=$?
set -e
[ "$init_status" -eq 0 ] || fail "$init_output"
assert_contains "$init_output" "Project: ✓ AIT enabled"
assert_file "$status_fixture/project dir/.mcp.json"
pass "explicit project init preserves the native boundary"

conflict_project="$TMP_ROOT/conflict-project"
mkdir -p "$conflict_project"
printf '{"mcpServers":{"ait-protocol":{"command":"wrong","args":["unchanged"]}}}\n' > "$conflict_project/.mcp.json"
conflict_hash_before="$(shasum -a 256 "$conflict_project/.mcp.json" | awk '{print $1}')"
set +e
conflict_output="$("$status_fixture/ait" init "$conflict_project" 2>&1)"
conflict_status=$?
set -e
[ "$conflict_status" -ne 0 ] || fail "conflicting Claude entry unexpectedly succeeded"
assert_contains "$conflict_output" "conflicting ait-protocol"
assert_contains "$conflict_output" '"args":["unchanged"]'
assert_same "$conflict_hash_before" "$(shasum -a 256 "$conflict_project/.mcp.json" | awk '{print $1}')"
pass "conflicting Claude entry remains unchanged"

git_project="$TMP_ROOT/git-project"
mkdir -p "$git_project/src"
git_project="$(cd "$git_project" && pwd -P)"
git init -q "$git_project"
set +e
git_init_output="$(cd "$git_project/src" && AIT_FAKE_MCP_ROOT="$status_fixture" "$status_fixture/ait" init 2>&1)"
git_init_status=$?
set -e
[ "$git_init_status" -eq 0 ] || fail "$git_init_output"
assert_contains "$git_init_output" "Project: $git_project"
assert_file "$git_project/.mcp.json"
pass "nested Git init selects the worktree root"

plain_project="$TMP_ROOT/plain-project"
mkdir -p "$plain_project/child"
plain_project="$(cd "$plain_project" && pwd -P)"
set +e
plain_output="$(cd "$plain_project/child" && AIT_FAKE_MCP_ROOT="$status_fixture" "$status_fixture/ait" init 2>&1)"
plain_status=$?
set -e
[ "$plain_status" -eq 0 ] || fail "$plain_output"
assert_contains "$plain_output" "Project: $plain_project/child"
assert_file "$plain_project/child/.mcp.json"
pass "non-Git init uses the current directory without a marker walk"

git init -q "$HOME"
home_child="$HOME/child"
mkdir -p "$home_child"
set +e
home_git_output="$(cd "$home_child" && "$status_fixture/ait" init 2>&1)"
home_git_status=$?
set -e
[ "$home_git_status" -ne 0 ] || fail "Git HOME was incorrectly selected as a project"
assert_contains "$home_git_output" 'Run: ait init'
assert_absent "$HOME/.mcp.json"
pass "Git HOME root is rejected before writes"

uninitialized="$TMP_ROOT/uninitialized-project"
mkdir -p "$uninitialized"
set +e
uninitialized_output="$(cd "$uninitialized" && "$status_fixture/ait" claude 2>&1)"
uninitialized_status=$?
set -e
[ "$uninitialized_status" -ne 0 ] || fail "Claude launched without a project entry"
assert_contains "$uninitialized_output" "run ait init"
pass "Claude launch rejects user-scope-only configuration"

cat > "$status_fixture/bin/codex-session.sh" <<'EOF'
#!/bin/bash
printf '%s\n' "$PWD" "$@" > "$AIT_CAPTURE"
exit 7
EOF
chmod +x "$status_fixture/bin/codex-session.sh"
codex_capture="$TMP_ROOT/codex-capture"
set +e
(cd "$git_project/src" && AIT_CAPTURE="$codex_capture" "$status_fixture/ait" codex "hello world" second)
codex_exit=$?
set -e
[ "$codex_exit" -eq 7 ] || fail "Codex launcher exit status was not preserved"
assert_same "$(sed -n '1p' "$codex_capture")" "$(cd "$git_project/src" && pwd)"
assert_same "$(sed -n '2p' "$codex_capture")" "hello world"
assert_same "$(sed -n '3p' "$codex_capture")" "second"
pass "Codex launcher cwd, arguments, and exit status"

cat > "$status_fixture/bin/claude-session.sh" <<'EOF'
#!/bin/bash
printf '%s\n' "$PWD" "$@" > "$AIT_CAPTURE"
exit 7
EOF
chmod +x "$status_fixture/bin/claude-session.sh"
capture="$TMP_ROOT/claude-capture"
set +e
(cd "$status_fixture/project dir" && AIT_CAPTURE="$capture" "$status_fixture/ait" claude "hello world" second)
launch_exit=$?
set -e
[ "$launch_exit" -eq 7 ] || fail "Claude launcher exit status was not preserved"
assert_same "$(sed -n '1p' "$capture")" "$(cd "$status_fixture/project dir" && pwd)"
assert_same "$(sed -n '2p' "$capture")" "hello world"
assert_same "$(sed -n '3p' "$capture")" "second"
pass "Claude launcher cwd, arguments, and exit status"

start_fixture="$TMP_ROOT/start"
make_fixture "$start_fixture"
cp "$REPO/bin/start-all.sh" "$start_fixture/bin/start-all.sh"
chmod +x "$start_fixture/bin/start-all.sh"
start_state="$TMP_ROOT/start-state"
start_logs="$TMP_ROOT/start-logs"
mkdir -p "$start_state" "$start_logs"
rm -f "$start_fixture/shim/codex"
cat > "$start_fixture/shim/curl" <<'EOF'
#!/bin/bash
echo '{}'
EOF
cat > "$start_fixture/shim/lsof" <<'EOF'
#!/bin/bash
case "$*" in
  *-iTCP:2582*) name=plc ;;
  *-iTCP:2583*) name=pds ;;
  *-iTCP:2585*) name=appview ;;
  *) name= ;;
esac
if [ -n "$name" ]; then
  [ -f "$AIT_START_STATE/$name" ] && cat "$AIT_START_STATE/$name"
elif [[ "$*" = *"-d cwd"* ]]; then
  echo "n$AIT_START_REPO"
fi
EOF
for wrapper in plc pds appview; do
  cat > "$start_fixture/bin/run-$wrapper.sh" <<EOF
#!/bin/bash
printf '%s' "\$\$" > "\$AIT_START_WRAPPER_PID_DIR/$wrapper"
if [ "\${AIT_START_MODE:-delayed}" = exit ]; then
  exit 1
fi
if [ "\${AIT_START_MODE:-delayed}" = delayed ]; then
  sleep 1
  printf '%s' "\$\$" > "\$AIT_START_STATE/$wrapper"
fi
trap 'rm -f "\$AIT_START_STATE/$wrapper"; exit 0' INT TERM
while :; do sleep 1; done
EOF
  chmod +x "$start_fixture/bin/run-$wrapper.sh"
done
chmod +x "$start_fixture/shim/curl" "$start_fixture/shim/lsof"
export PATH="$start_fixture/shim:/usr/bin:/bin"
export AIT_START_STATE="$start_state"
export AIT_START_WRAPPER_PID_DIR="$TMP_ROOT/start-wrapper-pids"
export AIT_START_REPO="$(cd "$start_fixture" && pwd)"
export AIT_LOG_DIR="$start_logs"
mkdir -p "$AIT_START_WRAPPER_PID_DIR"

export AIT_START_MODE=delayed
start_output="$("$start_fixture/bin/start-all.sh" 2>&1)"
assert_contains "$start_output" "waiting for plc TCP port 2582"
assert_contains "$start_output" "log: $start_logs/ait-plc.log"
for wrapper in plc pds appview; do
  pid="$(cat "$AIT_START_STATE/$wrapper")"
  kill "$pid" 2>/dev/null || true
  rm -f "$start_logs/ait-$wrapper.pid" "$AIT_START_STATE/$wrapper"
done
pass "delayed readiness reports listener progress and succeeds on resource events"

export AIT_START_MODE=exit
set +e
exit_output="$("$start_fixture/bin/start-all.sh" 2>&1)"
exit_status=$?
set -e
[ "$exit_status" -ne 0 ] || fail "wrapper exit unexpectedly succeeded"
assert_contains "$exit_output" "wrapper exited before binding"
for wrapper in plc pds appview; do
  assert_absent "$start_logs/ait-$wrapper.pid"
done
pass "wrapper exit is a failure event without a false pidfile"

export AIT_START_MODE=pending
interrupt_output="$TMP_ROOT/start-interrupt.out"
rm -f "$start_logs/ait-plc.pid" "$AIT_START_WRAPPER_PID_DIR/plc"
set +e
"$start_fixture/bin/start-all.sh" >"$interrupt_output" 2>&1 &
start_pid=$!
set -e
while ! grep -Fq "waiting for plc TCP port 2582" "$interrupt_output"; do
  kill -0 "$start_pid" 2>/dev/null || fail "start-all exited before interrupt test"
  sleep 0.1
done
kill -TERM "$start_pid"
set +e
wait "$start_pid"
interrupt_status=$?
set -e
[ "$interrupt_status" -eq 130 ] || fail "start-all interrupt exit was not 130"
interrupt_text="$(sed -n '1,$p' "$interrupt_output")"
assert_contains "$interrupt_text" "stopped wrapper pid"
assert_absent "$start_logs/ait-plc.pid"
wrapper_pid="$(cat "$AIT_START_WRAPPER_PID_DIR/plc")"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  process_alive "$wrapper_pid" || break
  sleep 0.1
done
if process_alive "$wrapper_pid"; then
  kill -KILL "$wrapper_pid" 2>/dev/null || true
  fail "interrupted wrapper still running"
fi
pass "interrupt stops an unbound wrapper and leaves no pidfile"

http_root="$TMP_ROOT/http"
http_port_file="$TMP_ROOT/http-port"
http_marker="$TMP_ROOT/http-marker"
mkdir -p "$http_root"
cat > "$http_root/install.sh" <<'EOF'
#!/bin/bash
read -r input
[ "$input" = caller-sentinel ] || exit 9
printf executed > "$AIT_HTTP_BOOTSTRAP_MARKER"
EOF
python3 - "$http_root" "$http_port_file" <<'PY' &
import http.server
import socketserver
import sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=sys.argv[1], **kwargs)

with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
    with open(sys.argv[2], "w") as port_file:
        port_file.write(str(server.server_address[1]))
    server.serve_forever()
PY
http_pid=$!
while [ ! -s "$http_port_file" ]; do sleep 0.1; done
http_port="$(sed -n '1p' "$http_port_file")"
export AIT_HTTP_BOOTSTRAP_MARKER="$http_marker"
printf 'caller-sentinel\n' | /bin/bash -c "$("$REAL_CURL" -fsSL "http://127.0.0.1:$http_port/install.sh")"
assert_file "$http_marker"
assert_same "$(sed -n '1p' "$http_marker")" executed
kill "$http_pid" 2>/dev/null || true
pass "local HTTP command-substitution bootstrap preserves caller stdin"

codex_start_fixture="$TMP_ROOT/codex-start"
make_fixture "$codex_start_fixture"
cp "$REPO/bin/start-all.sh" "$codex_start_fixture/bin/start-all.sh"
cp "$REPO/bin/status.sh" "$codex_start_fixture/bin/status.sh"
chmod +x "$codex_start_fixture/bin/status.sh"
chmod +x "$codex_start_fixture/bin/start-all.sh"
codex_start_state="$TMP_ROOT/codex-start-state"
codex_start_logs="$TMP_ROOT/codex-start-logs"
codex_start_wrapper_pids="$TMP_ROOT/codex-start-wrapper-pids"
mkdir -p "$codex_start_state" "$codex_start_logs" "$codex_start_wrapper_pids"
cat > "$codex_start_fixture/shim/curl" <<'EOF'
#!/bin/bash
echo '{}'
EOF
cat > "$codex_start_fixture/shim/lsof" <<'EOF'
#!/bin/bash
case "$*" in
  *-iTCP:2582*) name=plc ;;
  *-iTCP:2583*) name=pds ;;
  *-iTCP:2585*) name=appview ;;
  *) name= ;;
esac
if [ -n "$name" ]; then
  [ -f "$AIT_START_STATE/$name" ] && cat "$AIT_START_STATE/$name"
elif [[ "$*" = *"-d cwd"* ]]; then
  echo "n$AIT_START_REPO"
elif [[ "$*" = *"$AIT_CODEX_SHARED_SOCKET"* ]] && [ -n "${AIT_CODEX_OWNER_PID:-}" ]; then
  echo "$AIT_CODEX_OWNER_PID"
elif [[ "$*" = *"$AIT_CODEX_SHARED_SOCKET"* ]] && [ -f "$AIT_START_WRAPPER_PID_DIR/codex-socket-owner" ]; then
  cat "$AIT_START_WRAPPER_PID_DIR/codex-socket-owner"
fi
EOF
cat > "$codex_start_fixture/shim/pgrep" <<'EOF'
#!/bin/bash
case "$*" in
  *codex*)
    if [ -n "${AIT_CODEX_PIDS:-}" ]; then
      for pid in $AIT_CODEX_PIDS; do echo "$pid"; done
    elif [ -f "$AIT_START_WRAPPER_PID_DIR/codex-appserver" ]; then
      cat "$AIT_START_WRAPPER_PID_DIR/codex-appserver"
    fi
    ;;
esac
EOF
for wrapper in plc pds appview; do
  cp "$start_fixture/bin/run-$wrapper.sh" "$codex_start_fixture/bin/run-$wrapper.sh"
done
cat > "$codex_start_fixture/bin/run-codex-appserver.sh" <<'EOF'
#!/bin/bash
printf '%s' "$$" > "$AIT_START_WRAPPER_PID_DIR/codex-appserver"
printf '%s\n' "$$" >> "$AIT_START_WRAPPER_PID_DIR/codex-launches"
if [ "${AIT_START_MODE:-delayed}" = delayed ]; then sleep "${AIT_START_DELAY:-1}"; fi
python3 - "$AIT_CODEX_SHARED_SOCKET" <<'PY' &
import socket
import sys

path = sys.argv[1]
try:
    import os
    os.unlink(path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(path)
server.listen(8)
while True:
    client, _ = server.accept()
    client.close()
PY
server_pid=$!
printf '%s' "$server_pid" > "$AIT_START_WRAPPER_PID_DIR/codex-socket-owner"
trap 'kill "$server_pid" 2>/dev/null || true; rm -f "$AIT_CODEX_SHARED_SOCKET"; exit 0' INT TERM
while :; do sleep 1; done
EOF
cat > "$codex_start_fixture/shim/codex" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$codex_start_fixture/shim/"* "$codex_start_fixture/bin/run-codex-appserver.sh"
export PATH="$codex_start_fixture/shim:/usr/bin:/bin"
export AIT_START_STATE="$codex_start_state"
export AIT_START_WRAPPER_PID_DIR="$codex_start_wrapper_pids"
export AIT_START_REPO="$(cd "$codex_start_fixture" && pwd)"
export AIT_CODEX_SHARED_SOCKET="$codex_start_state/codex.sock"
export AIT_LOG_DIR="$codex_start_logs"
export AIT_START_MODE=delayed
test_codex_pid=""
test_decoy_pid=""
codex_cleanup() {
  if [ -n "$test_decoy_pid" ]; then
    kill "$test_decoy_pid" 2>/dev/null || true
    wait "$test_decoy_pid" 2>/dev/null || true
  fi
  if [ -n "$test_codex_pid" ]; then
    kill "$test_codex_pid" 2>/dev/null || true
    wait "$test_codex_pid" 2>/dev/null || true
  fi
  for wrapper in plc pds appview; do
    kill "$(cat "$codex_start_wrapper_pids/$wrapper" 2>/dev/null)" 2>/dev/null || true
  done
  rm -f "$codex_start_state"/* "$codex_start_wrapper_pids"/* "$codex_start_logs"/* "$AIT_CODEX_SHARED_SOCKET"
  test_codex_pid=""
  test_decoy_pid=""
}
start_codex_fixture() {
  export AIT_START_DELAY="$1"
  "$codex_start_fixture/bin/run-codex-appserver.sh" >/dev/null 2>&1 &
  test_codex_pid=$!
  while [ ! -s "$codex_start_wrapper_pids/codex-appserver" ]; do sleep 0.1; done
}

start_codex_fixture 20
printf '%s' "$test_codex_pid" > "$codex_start_logs/ait-codex-appserver.pid"
python3 -c 'import signal; signal.pause()' &
test_decoy_pid=$!
export AIT_CODEX_PIDS="$test_decoy_pid $test_codex_pid"
pidfile_output="$("$codex_start_fixture/bin/start-all.sh" 2>&1)"
assert_contains "$pidfile_output" "codex-appserver already running (pid $test_decoy_pid, adopted — discovered before socket bind); waiting for socket"
assert_contains "$pidfile_output" "waiting for codex-appserver socket"
socket_owner_pid="$(cat "$codex_start_wrapper_pids/codex-socket-owner")"
assert_contains "$pidfile_output" "codex-appserver ready (pid $socket_owner_pid)"
assert_same "$(cat "$codex_start_logs/ait-codex-appserver.pid")" "$socket_owner_pid"
assert_same "$(wc -l < "$codex_start_wrapper_pids/codex-launches" | tr -d ' ')" 1
export AIT_CODEX_PIDS='111 222' AIT_CODEX_OWNER_PID=222
assert_same "$(pgrep -f 'codex app-server --listen unix://ignored')" $'111\n222'
owner_probe="$(bash -c '. "$AIT_START_REPO/bin/lib-service-pids.sh"; running_pid codex-appserver')"
assert_same "$owner_probe" 222
unset AIT_CODEX_PIDS AIT_CODEX_OWNER_PID
codex_cleanup
pass "Codex socket owner wins over pgrep and pidfile without a second wrapper"

start_codex_fixture 20
rm -f "$codex_start_logs/ait-codex-appserver.pid"
discovered_output="$("$codex_start_fixture/bin/start-all.sh" 2>&1)"
assert_contains "$discovered_output" "codex-appserver already running (pid $test_codex_pid, adopted — discovered before socket bind); waiting for socket"
socket_owner_pid="$(cat "$codex_start_wrapper_pids/codex-socket-owner")"
assert_contains "$discovered_output" "codex-appserver ready (pid $socket_owner_pid)"
assert_same "$(cat "$codex_start_logs/ait-codex-appserver.pid")" "$socket_owner_pid"
assert_same "$(wc -l < "$codex_start_wrapper_pids/codex-launches" | tr -d ' ')" 1
codex_cleanup
pass "Codex discovered-process adoption waits for socket without a second wrapper"

false &
exited_codex_pid=$!
wait "$exited_codex_pid" 2>/dev/null || true
printf '%s' "$exited_codex_pid" > "$codex_start_wrapper_pids/codex-appserver"
set +e
exit_output="$("$codex_start_fixture/bin/start-all.sh" 2>&1)"
exit_status=$?
set -e
[ "$exit_status" -ne 0 ] || fail "adopted Codex exit unexpectedly succeeded"
assert_contains "$exit_output" "codex-appserver process exited before binding socket"
assert_absent "$codex_start_logs/ait-codex-appserver.pid"
assert_absent "$codex_start_wrapper_pids/codex-launches"
codex_cleanup
pass "adopted Codex process exit fails without a pidfile"

export AIT_START_DELAY=1
codex_start_output="$("$codex_start_fixture/bin/start-all.sh" 2>&1)"
assert_contains "$codex_start_output" "waiting for codex-appserver socket"
assert_contains "$codex_start_output" "codex-appserver  running"
codex_start_pid="$(cat "$codex_start_wrapper_pids/codex-appserver")"
kill "$codex_start_pid" 2>/dev/null || true
for wrapper in plc pds appview; do
  kill "$(cat "$codex_start_wrapper_pids/$wrapper" 2>/dev/null)" 2>/dev/null || true
done
rm -f "$codex_start_state"/plc "$codex_start_state"/pds "$codex_start_state"/appview
rm -f "$codex_start_wrapper_pids"/plc "$codex_start_wrapper_pids"/pds "$codex_start_wrapper_pids"/appview "$codex_start_wrapper_pids"/codex-appserver
pass "Codex start waits for the socket event and status treats it as informational"

public_asset="$TMP_ROOT/public-install.sh"
sed -e 's/__AIT_RELEASE_TAG__/v0.1.2/g' \
    -e "s/__AIT_RELEASE_COMMIT__/$(git -C "$REPO" rev-parse HEAD)/g" \
    "$REPO/install.sh" > "$public_asset"
chmod +x "$public_asset"
public_output="$(HOME="$TMP_ROOT/public-home" "$public_asset" --verify-only)"
assert_contains "$public_output" 'verified release installer v0.1.2'
set +e
source_output="$(HOME="$TMP_ROOT/public-home" "$REPO/install.sh" 2>&1)"; source_status=$?
set -e
[ "$source_status" -ne 0 ] || fail 'unbound source installer unexpectedly ran'
assert_contains "$source_output" 'published immutable install.sh asset'
pass "public bootstrap requires and verifies a bound release asset"

echo "AIT test suite passed"
