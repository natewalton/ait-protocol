#!/bin/bash
# Isolated behavioral checks for `ait uninstall`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ait-uninstall-test.XXXXXX")"
TEST_ROOT="$(cd -P "$TEST_ROOT" && pwd)"
SHIMS="$TEST_ROOT/shims"
PG_PREFIX="$TEST_ROOT/postgresql"
PASS=0

cleanup() {
  chmod -R u+w "$TEST_ROOT" 2>/dev/null || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

fail() { echo "not ok: $*" >&2; exit 1; }
pass() { PASS=$((PASS + 1)); echo "ok $PASS - $*"; }
contains() { printf '%s' "$1" | grep -Fq "$2" || fail "$3: missing '$2'"; }
absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "$2: still present: $1"; }
present() { [ -e "$1" ] || [ -L "$1" ] || fail "$2: missing: $1"; }

mkdir -p "$SHIMS" "$PG_PREFIX/bin"
for command_name in lsof pgrep; do
  printf '#!/bin/bash\nexit 1\n' > "$SHIMS/$command_name"
  chmod +x "$SHIMS/$command_name"
done
printf '#!/bin/bash\nexit 0\n' > "$SHIMS/launchctl"
cat > "$SHIMS/brew" <<'EOF'
#!/bin/bash
if [ "$*" = "--prefix postgresql@17" ]; then printf '%s\n' "$AIT_TEST_PG_PREFIX"
elif [ "$*" = "--prefix" ]; then printf '%s\n' "$AIT_TEST_BREW_PREFIX"
else exit 2; fi
EOF
cat > "$SHIMS/ps" <<'EOF'
#!/bin/bash
if [ -n "${AIT_TEST_PS_OUTPUT:-}" ]; then printf '%s\n' "$AIT_TEST_PS_OUTPUT"; else exec /bin/ps "$@"; fi
EOF
cat > "$SHIMS/rm" <<'EOF'
#!/bin/bash
for arg in "$@"; do
  if [ -n "${AIT_TEST_RM_FAIL_ON:-}" ] && [ "$arg" = "$AIT_TEST_RM_FAIL_ON" ]; then exit 1; fi
done
exec /bin/rm "$@"
EOF
cat > "$PG_PREFIX/bin/dropdb" <<'EOF'
#!/bin/bash
[ "$*" = "--if-exists plc_directory" ] || exit 2
rm -f "$AIT_TEST_DB"
EOF
chmod +x "$SHIMS/launchctl" "$SHIMS/brew" "$SHIMS/ps" "$SHIMS/rm" "$PG_PREFIX/bin/dropdb"
TEST_PATH="$SHIMS:/usr/bin:/bin:/usr/sbin:/sbin"

make_fixture() {
  local name="$1"
  FX_HOME="$TEST_ROOT/$name/home"
  FX_REPO="$FX_HOME/.local/share/ait-protocol"
  FX_DATA="$FX_HOME/data"
  FX_STATE="$FX_HOME/state"
  FX_LOGS="$FX_HOME/logs"
  FX_RUNTIME="$FX_HOME/runtime"
  FX_CLI="$FX_HOME/homebrew/bin/ait"
  FX_PROJECT="$FX_HOME/project"
  FX_DB="$FX_HOME/postgres/plc_directory"
  FX_OTHER_DB="$FX_HOME/postgres/unrelated_database"
  mkdir -p "$FX_HOME" "$(dirname "$FX_REPO")"
  git clone -q "$ROOT" "$FX_REPO"
  git -C "$FX_REPO" remote set-url origin https://github.com/natewalton/ait-protocol
  cp "$ROOT/ait" "$FX_REPO/ait"
  cp "$ROOT/VERSION" "$FX_REPO/VERSION"
  cp "$ROOT/bin/install.sh" "$FX_REPO/bin/install.sh"
  cp "$ROOT/bin/uninstall.sh" "$FX_REPO/bin/uninstall.sh"
  chmod +x "$FX_REPO/ait" "$FX_REPO/bin/install.sh" "$FX_REPO/bin/uninstall.sh"
  cat > "$FX_REPO/bin/stop-all.sh" <<'EOF'
#!/bin/bash
if [ -n "${AIT_TEST_STOP_RECORD:-}" ]; then printf '%s\n' "$AIT_TEST_PROCESS_STATE" > "$AIT_TEST_STOP_RECORD"; fi
EOF
  chmod +x "$FX_REPO/bin/stop-all.sh"
  git -C "$FX_REPO" update-ref "refs/ait-release/v$(tr -d '[:space:]' < "$FX_REPO/VERSION")" HEAD
  mkdir -p "$FX_HOME/homebrew/bin" "$FX_HOME/.claude/skills" "$FX_HOME/.agents/skills" \
    "$FX_DATA/ait-mcp" "$FX_DATA/ait-watcher" "$FX_STATE/ait-protocol" \
    "$FX_HOME/.ait" "$FX_LOGS" "$FX_RUNTIME" "$FX_PROJECT" "$(dirname "$FX_DB")" \
    "$FX_HOME/Library/LaunchAgents"
  FX_REPO_REAL="$(cd "$FX_REPO" && pwd -P)"
  ln -s "$FX_REPO_REAL/ait" "$FX_CLI"
  ln -s "$FX_REPO/.agents/skills/delivery-coordination" "$FX_HOME/.claude/skills/delivery-coordination"
  ln -s "$FX_REPO/.agents/skills/delivery-coordination" "$FX_HOME/.agents/skills/delivery-coordination"
  touch "$FX_DATA/ait-mcp/identity.json" "$FX_DATA/ait-watcher/identity.json" \
    "$FX_STATE/ait-protocol/stale" "$FX_HOME/.ait/codex-shared.sock" \
    "$FX_LOGS/ait-plc.log" "$FX_LOGS/ait-pds.pid" "$FX_RUNTIME/ait-codex-sock.test" \
    "$FX_RUNTIME/ait-codex-log.test" "$FX_DB" "$FX_OTHER_DB"
  printf '{"mcpServers":{"ait-protocol":{}}}\n' > "$FX_PROJECT/.mcp.json"
  touch "$FX_HOME/Library/LaunchAgents/com.ait.plc.plist" \
    "$FX_HOME/Library/LaunchAgents/com.ait.codex-appserver.plist" \
    "$FX_HOME/Library/LaunchAgents/foreign.plist"
}

run_uninstall() {
  local input="$1"
  shift
  set +e
  OUTPUT="$(printf '%b' "$input" | env PATH="$TEST_PATH" HOME="$FX_HOME" \
    TMPDIR="$FX_RUNTIME" \
    XDG_DATA_HOME="$FX_DATA" XDG_STATE_HOME="$FX_STATE" \
    AIT_LOG_DIR="$FX_LOGS" AIT_TEST_DB="$FX_DB" AIT_TEST_PG_PREFIX="$PG_PREFIX" \
    AIT_TEST_BREW_PREFIX="$FX_HOME/homebrew" "$@" "$FX_REPO/ait" uninstall 2>&1)"
  STATUS=$?
  set -e
}

help_output="$($ROOT/ait uninstall --help)"
contains "$help_output" 'Usage: ait uninstall' "uninstall help"
contains "$($ROOT/ait help uninstall)" 'no backup' "help topic"
set +e
invalid_output="$($ROOT/ait uninstall extra 2>&1)"; invalid_status=$?
set -e
[ "$invalid_status" -eq 2 ] || fail "invalid arguments exited $invalid_status"
contains "$invalid_output" 'Run: ait help' "invalid arguments"
pass "help and invalid arguments"

make_fixture cancel
run_uninstall 'not this\n'
[ "$STATUS" -eq 0 ] || fail "wrong confirmation exited $STATUS: $OUTPUT"
contains "$OUTPUT" 'nothing changed' "wrong confirmation"
present "$FX_REPO" "wrong confirmation"
run_uninstall ''
[ "$STATUS" -eq 0 ] || fail "EOF cancellation exited $STATUS"
present "$FX_CLI" "EOF cancellation"
pass "wrong input and EOF cancel before mutation"

make_fixture signal
set +e
signal_output="$(env PATH="$TEST_PATH" HOME="$FX_HOME" XDG_DATA_HOME="$FX_DATA" \
  TMPDIR="$FX_RUNTIME" XDG_STATE_HOME="$FX_STATE" AIT_LOG_DIR="$FX_LOGS" AIT_TEST_DB="$FX_DB" \
  AIT_TEST_PG_PREFIX="$PG_PREFIX" AIT_TEST_BREW_PREFIX="$FX_HOME/homebrew" python3 - "$FX_REPO/ait" <<'PY'
import os, signal, subprocess, sys
p = subprocess.Popen([sys.argv[1], 'uninstall'], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
lines = []
for line in p.stdout:
    lines.append(line)
    if 'Type exactly: uninstall AIT' in line:
        p.send_signal(signal.SIGTERM)
        break
lines.extend(p.stdout.readlines())
rc = p.wait()
sys.stdout.write(''.join(lines))
sys.exit(0 if rc == 130 else 1)
PY
)"; signal_status=$?
set -e
[ "$signal_status" -eq 0 ] || fail "confirmation interrupt did not exit 130: $signal_output"
contains "$signal_output" 'nothing changed' "confirmation interrupt"
present "$FX_REPO" "confirmation interrupt"
pass "interrupt cancels at the confirmation event"

make_fixture development
git -C "$FX_REPO" update-ref -d "refs/ait-release/v$(tr -d '[:space:]' < "$FX_REPO/VERSION")"
run_uninstall 'uninstall AIT\n'
[ "$STATUS" -eq 1 ] || fail "development checkout exited $STATUS"
contains "$OUTPUT" 'development or package-managed' "development checkout"
present "$FX_REPO" "development checkout"

make_fixture foreign_cli
/bin/rm "$FX_CLI"
ln -s "$FX_HOME/foreign-ait" "$FX_CLI"
run_uninstall 'uninstall AIT\n'
[ "$STATUS" -eq 1 ] || fail "foreign CLI exited $STATUS"
contains "$OUTPUT" 'installer-owned AIT CLI link was not found' "foreign CLI"
present "$FX_CLI" "foreign CLI"
pass "release and CLI ownership fail closed"

make_fixture session
run_uninstall 'uninstall AIT\n' "AIT_TEST_PS_OUTPUT=123 node $FX_REPO/mcp/dist/server.js"
[ "$STATUS" -eq 1 ] || fail "active session exited $STATUS"
contains "$OUTPUT" 'active AIT harness session' "active session"
present "$FX_REPO" "active session"

make_fixture live_lock
mkdir -p "$FX_STATE/ait-protocol/update.lock"
printf '%s\n' "$$" > "$FX_STATE/ait-protocol/update.lock/pid"
run_uninstall 'uninstall AIT\n'
[ "$STATUS" -eq 1 ] || fail "live lock exited $STATUS"
contains "$OUTPUT" 'AIT update is active' "live lock"
present "$FX_REPO" "live lock"
pass "active sessions and lifecycle operations block before mutation"

make_fixture success
/bin/rm "$FX_HOME/.agents/skills/delivery-coordination"
mkdir -p "$FX_HOME/.agents/skills/delivery-coordination"
touch "$FX_HOME/.agents/skills/delivery-coordination/foreign"
mkdir -p "$FX_STATE/ait-protocol/update.lock"
printf '999999\n' > "$FX_STATE/ait-protocol/update.lock/pid"
run_uninstall 'uninstall AIT\n'
[ "$STATUS" -eq 0 ] || fail "confirmed uninstall exited $STATUS: $OUTPUT"
contains "$OUTPUT" 'AIT has been uninstalled' "confirmed uninstall output: $OUTPUT"
contains "$OUTPUT" 'database plc_directory was deleted' "database deletion notice"
contains "$OUTPUT" 'Project .mcp.json entries and shared prerequisites were preserved' "preservation notice"
contains "$OUTPUT" 'releases/latest/download/install.sh' "reinstall command"
absent "$FX_REPO" "confirmed uninstall"
absent "$FX_CLI" "confirmed uninstall"
absent "$FX_DATA/ait-mcp" "confirmed uninstall"
absent "$FX_DATA/ait-watcher" "confirmed uninstall"
absent "$FX_STATE/ait-protocol" "confirmed uninstall"
absent "$FX_HOME/.ait" "confirmed uninstall"
absent "$FX_LOGS/ait-plc.log" "confirmed uninstall"
absent "$FX_RUNTIME/ait-codex-sock.test" "confirmed uninstall"
absent "$FX_HOME/.claude/skills/delivery-coordination" "owned skill"
present "$FX_HOME/.agents/skills/delivery-coordination/foreign" "foreign skill"
absent "$FX_HOME/Library/LaunchAgents/com.ait.plc.plist" "owned launchd"
present "$FX_HOME/Library/LaunchAgents/foreign.plist" "foreign launchd"
present "$FX_PROJECT/.mcp.json" "project config"
absent "$FX_DB" "AIT PostgreSQL database"
present "$FX_OTHER_DB" "unrelated PostgreSQL database"
present "$SHIMS/ps" "shared prerequisite"
pass "confirmation removes fixed AIT targets and preserves external and foreign state"

for process_state in stopped partial running; do
  make_fixture "process-$process_state"
  record="$FX_HOME/stopped-state"
  run_uninstall 'uninstall AIT\n' "AIT_TEST_PROCESS_STATE=$process_state" "AIT_TEST_STOP_RECORD=$record"
  [ "$STATUS" -eq 0 ] || fail "$process_state process state exited $STATUS"
  [ "$(cat "$record")" = "$process_state" ] || fail "$process_state did not use the shared stop path"
done
pass "stopped, partial, and running services use one cleanup path"

make_fixture early_failure
cat > "$FX_REPO/bin/stop-all.sh" <<'EOF'
#!/bin/bash
exit 1
EOF
chmod +x "$FX_REPO/bin/stop-all.sh"
run_uninstall 'uninstall AIT\n'
[ "$STATUS" -eq 1 ] || fail "early child failure exited $STATUS"
contains "$OUTPUT" 'failed while stopping AIT processes' "early child failure"
contains "$OUTPUT" "  $FX_REPO" "remaining checkout"
contains "$OUTPUT" 'recovery: ait uninstall' "same-command recovery"
present "$FX_REPO" "early child failure"
present "$FX_CLI" "early child failure"
pass "pre-CLI failure reports residue and same-command recovery"

make_fixture late_failure
run_uninstall 'uninstall AIT\n' "AIT_TEST_RM_FAIL_ON=$FX_DATA/ait-mcp"
[ "$STATUS" -eq 1 ] || fail "late child failure exited $STATUS"
contains "$OUTPUT" 'failed while removing AIT MCP identities' "late child failure"
contains "$OUTPUT" 'releases/latest/download/install.sh' "public recovery"
absent "$FX_CLI" "late child failure"
present "$FX_DATA/ait-mcp" "late child failure"
present "$FX_REPO" "late child failure"
pass "post-CLI failure reports residue and public recovery"

grep -Fq '"$REPO/bin/uninstall-services.sh"' "$ROOT/bin/uninstall.sh" || fail "launchd remover is not composed"
grep -Fq '"$REPO/bin/stop-all.sh"' "$ROOT/bin/uninstall.sh" || fail "service remover is not composed"
grep -Fq '"$REPO/bin/install-skill.sh" --remove' "$ROOT/bin/uninstall.sh" || fail "skill remover is not composed"
grep -Fq '"$REPO/bin/install.sh" --drop-database' "$ROOT/bin/uninstall.sh" || fail "AIT database remover is not composed"
! grep -Eq 'psql|createdb|dropdb|status\.sh|mktemp' "$ROOT/bin/uninstall.sh" || fail "uninstall gained database-probe, service-state, or temp-copy machinery"
pass "source stays on the four-concept cleanup model"

echo "$PASS uninstall cases passed"
