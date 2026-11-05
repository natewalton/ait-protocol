#!/bin/bash
# Regression check for the shared Codex app-server's inherited open-file limit.
set -euo pipefail

# The launcher runs this file as its fake Codex binary. Reporting from the
# child proves the resource limit survives the real process boundary.
if [ "${1:-}" = "app-server" ]; then
  printf 'fake-codex-soft-limit=%s\n' "$(ulimit -Sn)"
  exit 0
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}"
TEST_DIR="$(mktemp -d "$TMP_ROOT/ait-codex-limit-test.XXXXXX")"
TEST_DIR="$(cd "$TEST_DIR" && pwd -P)"

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# Every process path, socket and log directory belongs to this fixture.
mkdir -p "$TEST_DIR/bin" "$TEST_DIR/mcp/dist"
cp "$REPO/bin/run-codex-appserver.sh" "$TEST_DIR/bin/run-codex-appserver.sh"
cp "$REPO/bin/lib-service-pids.sh" "$TEST_DIR/bin/lib-service-pids.sh"
touch "$TEST_DIR/mcp/dist/server.js"
launcher="$TEST_DIR/bin/run-codex-appserver.sh"

output="$({
  ulimit -Sn 256
  AIT_CODEX_SHARED_SOCKET="$TEST_DIR/codex.sock" \
    CODEX_BIN="$REPO/bin/run-codex-appserver-test.sh" \
    NODE_BIN=/usr/bin/true \
    "$launcher"
})"

actual="$(printf '%s\n' "$output" | sed -n 's/^fake-codex-soft-limit=//p')"
if [ "$actual" != "8192" ]; then
  echo "run-codex-appserver-test: expected soft limit 8192, got ${actual:-no result}" >&2
  exit 1
fi

# A host that cannot supply the promised capacity must fail before Codex starts.
low_hard_status=0
low_hard_output="$(
  {
    ulimit -Sn 512
    ulimit -Hn 512
    AIT_CODEX_SHARED_SOCKET="$TEST_DIR/low-hard-codex.sock" \
      CODEX_BIN="$REPO/bin/run-codex-appserver-test.sh" \
      NODE_BIN=/usr/bin/true \
      "$launcher"
  } 2>&1
)" || low_hard_status=$?

if [ "$low_hard_status" -eq 0 ] || printf '%s\n' "$low_hard_output" | grep -q '^fake-codex-soft-limit='; then
  echo "run-codex-appserver-test: launcher reached Codex below the required hard limit" >&2
  exit 1
fi

echo "run-codex-appserver-test: passed (soft limit $actual; low hard limit rejected)"

# Real fixture socket/server, never the installed socket. A sleeping inherited
# descriptor holder is deliberately placed first by the discovery shim.
cp "$REPO/bin/stop-codex-appserver.sh" "$TEST_DIR/bin/stop-codex-appserver.sh"
mkdir "$TEST_DIR/shim" "$TEST_DIR/logs"
export AIT_CODEX_SHARED_SOCKET="$TEST_DIR/c.sock" AIT_LOG_DIR="$TEST_DIR/logs"
export AIT_TEST_SERVER_PID="$TEST_DIR/server.pid"
export AIT_TEST_CHILD_PID="$TEST_DIR/child.pid"
cat > "$TEST_DIR/codex" <<'PY'
#!/usr/bin/python3
import os, signal, socket, subprocess, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
path = os.environ['AIT_CODEX_SHARED_SOCKET']
gate = os.environ.get('AIT_TEST_BIND_GATE')
if gate:
    open(os.environ['AIT_TEST_SERVER_PID'] + '.prebind', 'w').write(str(os.getpid()))
    while not os.path.exists(gate): time.sleep(.01)
s.bind(path)
s.listen()
s.set_inheritable(True)
child = subprocess.Popen(['/bin/sleep', '120'], close_fds=False)
open(os.environ['AIT_TEST_SERVER_PID'], 'w').write(str(os.getpid()))
open(os.environ['AIT_TEST_CHILD_PID'], 'w').write(str(child.pid))
signal.signal(signal.SIGTERM, signal.SIG_IGN if os.environ.get('AIT_TEST_IGNORE_TERM') else lambda *_: exit(0))
while True: time.sleep(1)
PY
chmod +x "$TEST_DIR/codex"
cat > "$TEST_DIR/shim/lsof" <<'SH'
#!/bin/bash
if [ "${1:-}" = -t ] && [ "${2:-}" = "$AIT_CODEX_SHARED_SOCKET" ]; then
  actual="$(/usr/sbin/lsof -t "$AIT_CODEX_SHARED_SOCKET" 2>/dev/null || true)"
  for file in "$AIT_TEST_CHILD_PID" "$AIT_TEST_SERVER_PID"; do
    [ -f "$file" ] || continue
    pid="$(cat "$file")"
    if grep -qx "$pid" <<< "$actual"; then printf '%s\n' "$pid"; fi
  done
  exit 0
fi
if [[ "$*" = *"-d cwd"* ]]; then exec /usr/sbin/lsof "$@"; fi
for service in plc pds appview; do
  case "$service" in plc) expected=2582 ;; pds) expected=2583 ;; appview) expected=2585 ;; esac
  if [[ "$*" = *"-iTCP:$expected"* ]] && [ -f "$AIT_LOG_DIR/$service.port" ]; then
    exec /usr/sbin/lsof -nP -iTCP:"$(cat "$AIT_LOG_DIR/$service.port")" -sTCP:LISTEN -t
  fi
done
exit 0
SH
chmod +x "$TEST_DIR/shim/lsof"
export CODEX_BIN="$TEST_DIR/codex" NODE_BIN=/usr/bin/true
export PATH="$TEST_DIR/shim:$PATH"
server_pid=""
child_pid=""
http_pids=""
decoy=""
extra_pids=""
cleanup() {
  [ -z "${cleanup_gate:-}" ] || touch "$cleanup_gate"
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  [ -z "$child_pid" ] || kill "$child_pid" 2>/dev/null || true
  [ -z "$server_pid" ] || wait "$server_pid" 2>/dev/null || true
  for pid in $http_pids $extra_pids ${decoy:-}; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  rm -rf "$TEST_DIR"
}
# Include a stale socket left by an exited server and an abandoned startup lock.
/usr/bin/python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$AIT_CODEX_SHARED_SOCKET"
printf '%s\n' 99999999 > "$AIT_CODEX_SHARED_SOCKET.start-lock"
"$launcher" > "$TEST_DIR/first.log" 2>&1 &
first_launcher=$!
"$launcher" > "$TEST_DIR/second.log" 2>&1 &
second_launcher=$!
for _ in {1..100}; do
  [ -s "$AIT_TEST_SERVER_PID" ] && break
  sleep 0.05
done
[ -s "$AIT_TEST_SERVER_PID" ] || { cat "$TEST_DIR/first.log" "$TEST_DIR/second.log"; exit 1; }
server_pid="$(cat "$AIT_TEST_SERVER_PID")"
child_pid="$(cat "$AIT_TEST_CHILD_PID")"
for pid in "$first_launcher" "$second_launcher"; do
  if [ "$pid" != "$(ps -p "$server_pid" -o ppid= | tr -d ' ')" ]; then wait "$pid"; fi
done
kill -0 "$server_pid"
kill -0 "$child_pid"
echo 99999999 > "$AIT_LOG_DIR/ait-codex-appserver.pid"
"$launcher" > "$TEST_DIR/adopt.log"
kill -0 "$server_pid"
. "$TEST_DIR/bin/lib-service-pids.sh"
[ "$(running_pid codex-appserver)" = "$server_pid" ]
[ "$(service_pid codex-appserver)" = "$server_pid" ]
# A different checkout sharing this HOME must refuse rather than adopt/kill it.
foreign="$TEST_DIR/foreign"
mkdir -p "$foreign/bin" "$foreign/mcp/dist"
cp "$launcher" "$foreign/bin/run-codex-appserver.sh"
cp "$TEST_DIR/bin/lib-service-pids.sh" "$foreign/bin/lib-service-pids.sh"
cp "$TEST_DIR/bin/stop-codex-appserver.sh" "$foreign/bin/stop-codex-appserver.sh"
touch "$foreign/mcp/dist/server.js"
if "$foreign/bin/run-codex-appserver.sh" > "$TEST_DIR/foreign.log" 2>&1; then exit 1; fi
if "$foreign/bin/stop-codex-appserver.sh" >> "$TEST_DIR/foreign.log" 2>&1; then exit 1; fi
kill -0 "$server_pid"
"$TEST_DIR/bin/stop-codex-appserver.sh"
wait "$server_pid" 2>/dev/null || true
[ ! -e "$AIT_LOG_DIR/ait-codex-appserver.pid" ]
[ ! -e "$AIT_CODEX_SHARED_SOCKET" ]
rm -f "$AIT_TEST_SERVER_PID" "$AIT_TEST_CHILD_PID"
server_pid=""; child_pid=""
AIT_TEST_IGNORE_TERM=1 "$launcher" > "$TEST_DIR/restart.log" 2>&1 &
wrapper_pid=$!
for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID" ] && break; sleep 0.05; done
[ -s "$AIT_TEST_SERVER_PID" ]
server_pid="$(cat "$AIT_TEST_SERVER_PID")"
child_pid="$(cat "$AIT_TEST_CHILD_PID")"
"$TEST_DIR/bin/stop-codex-appserver.sh"
wait "$server_pid" 2>/dev/null || true
wait "$wrapper_pid" 2>/dev/null || true
server_pid=""; child_pid=""
rm -f "$AIT_TEST_SERVER_PID" "$AIT_TEST_CHILD_PID"
"$TEST_DIR/bin/stop-codex-appserver.sh"
echo 'run-codex-appserver-test: concurrent/adopt/foreign/inherited-fd/log-dir/start-stop-start passed'

# HTTP stop ignores a live, unrelated process recorded in every PID cache.
cp "$REPO/bin/stop-all.sh" "$TEST_DIR/bin/stop-all.sh"
cp "$REPO/bin/start-all.sh" "$TEST_DIR/bin/start-all.sh"
cat > "$TEST_DIR/bin/status.sh" <<'SH'
#!/bin/bash
echo 'AIT status:'
echo '  plc running'
echo '  pds running'
echo '  appview running'
echo '  codex-appserver running'
SH
chmod +x "$TEST_DIR/bin/status.sh"
node_bin="$(command -v node)"
http_pids=""
for service in plc pds appview; do
  mkdir -p "$TEST_DIR/$service/dist"
  cat > "$TEST_DIR/$service/launcher.js" <<'JS'
const net = require('node:net'), fs = require('node:fs')
const server = net.createServer().listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.AIT_TEST_HTTP_PORT_FILE, String(server.address().port))
})
JS
  cp "$TEST_DIR/$service/launcher.js" "$TEST_DIR/$service/dist/server.js"
  entry=launcher.js
  [ "$service" != appview ] || entry=dist/server.js
  (cd "$TEST_DIR/$service" && AIT_TEST_HTTP_PORT_FILE="$AIT_LOG_DIR/$service.port" exec "$node_bin" "$entry") &
  pid=$!
  http_pids="$http_pids $pid"
  for _ in {1..100}; do [ -f "$AIT_LOG_DIR/$service.port" ] && break; sleep 0.05; done
done
/bin/sleep 120 &
decoy=$!
for service in plc pds appview; do echo "$decoy" > "$AIT_LOG_DIR/ait-$service.pid"; done
"$foreign/bin/run-codex-appserver.sh" > "$TEST_DIR/foreign-start.log" 2>&1 &
foreign_wrapper=$!
extra_pids="$extra_pids $foreign_wrapper"
for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID" ] && break; sleep 0.05; done
server_pid="$(cat "$AIT_TEST_SERVER_PID")"
child_pid="$(cat "$AIT_TEST_CHILD_PID")"
if "$TEST_DIR/bin/start-all.sh" > "$TEST_DIR/start-conflict.log" 2>&1; then exit 1; fi
grep -q 'AIT status:' "$TEST_DIR/start-conflict.log"
grep -q 'DID NOT START: codex-appserver' "$TEST_DIR/start-conflict.log"
kill -0 "$server_pid"
for service in plc pds appview; do echo "$decoy" > "$AIT_LOG_DIR/ait-$service.pid"; done
if "$TEST_DIR/bin/stop-all.sh"; then exit 1; fi
kill -0 "$server_pid"
kill -0 "$decoy"
for pid in $http_pids; do wait "$pid" 2>/dev/null || true; done
for service in plc pds appview; do [ ! -f "$AIT_LOG_DIR/ait-$service.pid" ]; done
kill "$decoy"
wait "$decoy" 2>/dev/null || true
decoy=""; http_pids=""
"$foreign/bin/stop-codex-appserver.sh"
wait "$foreign_wrapper" 2>/dev/null || true
server_pid=""; child_pid=""
rm -f "$AIT_TEST_SERVER_PID" "$AIT_TEST_CHILD_PID"
echo 'run-codex-appserver-test: foreign Codex conflicts preserve HTTP start/stop, summary and decoy safety'

# Reproduce two previously orphaned own servers on one socket. One invocation
# must discover both, including the one no longer reachable through the path.
"$TEST_DIR/codex" app-server --listen "unix://$AIT_CODEX_SHARED_SOCKET" \
  -c "mcp_servers.ait.args=[\"$TEST_DIR/mcp/dist/server.js\"]" &
orphan=$!
extra_pids="$extra_pids $orphan"
for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID" ] && break; sleep 0.05; done
orphan_child="$(cat "$AIT_TEST_CHILD_PID")"
extra_pids="$extra_pids $orphan_child"
rm -f "$AIT_CODEX_SHARED_SOCKET" "$AIT_TEST_SERVER_PID" "$AIT_TEST_CHILD_PID"
"$TEST_DIR/codex" app-server --listen "unix://$AIT_CODEX_SHARED_SOCKET" \
  -c "mcp_servers.ait.args=[\"$TEST_DIR/mcp/dist/server.js\"]" &
server_pid=$!
for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID" ] && break; sleep 0.05; done
child_pid="$(cat "$AIT_TEST_CHILD_PID")"
"$TEST_DIR/bin/stop-codex-appserver.sh"
wait "$orphan" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
if kill -0 "$orphan" 2>/dev/null || kill -0 "$server_pid" 2>/dev/null; then exit 1; fi
kill "$orphan_child" 2>/dev/null || true
server_pid=""; child_pid=""
rm -f "$AIT_TEST_SERVER_PID" "$AIT_TEST_CHILD_PID"
echo 'run-codex-appserver-test: one stop removes every owned orphan on the exact socket'

# Signals target only owned fixture processes. The blocked bind is an event
# gate, not a timing assumption about how fast the server starts.
for signal in TERM HUP KILL INT; do
  gate="$TEST_DIR/bind-$signal"
  if [ "$signal" = INT ]; then
    # Background bash jobs inherit ignored SIGINT. Reset it explicitly before
    # exec so this case exercises the wrapper's actual INT trap.
    AIT_TEST_BIND_GATE="$gate" /usr/bin/python3 - "$launcher" "$TEST_DIR/int-wrapper.pid" "$TEST_DIR/int-status" <<'PY' > "$TEST_DIR/signal-INT.log" 2>&1 &
import signal, subprocess, sys
p = subprocess.Popen([sys.argv[1]], preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL))
open(sys.argv[2], 'w').write(str(p.pid))
open(sys.argv[3], 'w').write(str(p.wait()))
PY
    int_harness=$!
    extra_pids="$extra_pids $int_harness"
    for _ in {1..100}; do [ -s "$TEST_DIR/int-wrapper.pid" ] && break; sleep 0.05; done
    wrapper="$(cat "$TEST_DIR/int-wrapper.pid")"
  else
    AIT_TEST_BIND_GATE="$gate" "$launcher" > "$TEST_DIR/signal-$signal.log" 2>&1 &
    wrapper=$!
  fi
  extra_pids="$extra_pids $wrapper"
  for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID.prebind" ] && break; sleep 0.05; done
  prebind="$(cat "$AIT_TEST_SERVER_PID.prebind")"
  extra_pids="$extra_pids $prebind"
  # The foreign checkout cannot break or replace a live startup's kernel lock.
  if "$foreign/bin/run-codex-appserver.sh" > "$TEST_DIR/foreign-prebind.log" 2>&1; then exit 1; fi
  kill -0 "$prebind"
  lock_status=0
  /usr/bin/lockf -s -k -t 0 "$AIT_CODEX_SHARED_SOCKET.start-lock" /usr/bin/true || lock_status=$?
  [ "$lock_status" = 75 ]
  kill -"$signal" "$wrapper"
  wait "$wrapper" 2>/dev/null || true
  if [ "$signal" = INT ]; then
    wait "$int_harness"
    [ "$(cat "$TEST_DIR/int-status")" = 130 ]
  fi
  if [ "$signal" = KILL ]; then
    # The orphan server holds no lock; next launch adopts its actual PID.
    "$launcher" > "$TEST_DIR/post-kill.log"
    kill -0 "$prebind"
    touch "$gate"
    for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID" ] && break; sleep 0.05; done
    child_pid="$(cat "$AIT_TEST_CHILD_PID")"
    "$TEST_DIR/bin/stop-codex-appserver.sh"
    child_pid=""
  else
    if kill -0 "$prebind" 2>/dev/null; then exit 1; fi
    /usr/bin/lockf -s -k -t 0 "$AIT_CODEX_SHARED_SOCKET.start-lock" /usr/bin/true
  fi
  rm -f "$AIT_TEST_SERVER_PID.prebind" "$AIT_TEST_SERVER_PID" "$AIT_TEST_CHILD_PID"
done
echo 'run-codex-appserver-test: prebind TERM/HUP/KILL/INT and foreign startup preserve ownership and recovery'

# Prefix collisions are distinct resources/entrypoints, not our service.
suffix="$AIT_CODEX_SHARED_SOCKET.x"
AIT_CODEX_SHARED_SOCKET="$suffix" "$TEST_DIR/codex" app-server --listen "unix://$suffix" \
  -c "mcp_servers.ait.args=[\"$TEST_DIR/mcp/dist/server.js\"]" &
server_pid=$!
for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID" ] && break; sleep 0.05; done
child_pid="$(cat "$AIT_TEST_CHILD_PID")"
[ -z "$(running_pid codex-appserver)" ]
"$TEST_DIR/bin/stop-codex-appserver.sh"
kill -0 "$server_pid"
"$TEST_DIR/bin/stop-codex-appserver.sh" "$suffix"
wait "$server_pid" 2>/dev/null || true
server_pid=""; child_pid=""
rm -f "$AIT_TEST_SERVER_PID" "$AIT_TEST_CHILD_PID"
"$TEST_DIR/codex" app-server --listen "unix://$AIT_CODEX_SHARED_SOCKET" \
  -c "mcp_servers.ait.args=[\"$TEST_DIR/mcp/dist/server.js.old\"]" &
server_pid=$!
for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID" ] && break; sleep 0.05; done
child_pid="$(cat "$AIT_TEST_CHILD_PID")"
if running_pid codex-appserver > /dev/null 2>&1; then exit 1; fi
if "$TEST_DIR/bin/stop-codex-appserver.sh" > "$TEST_DIR/suffix-entry.log" 2>&1; then exit 1; fi
kill -0 "$server_pid"
kill "$server_pid" "$child_pid"
wait "$server_pid" 2>/dev/null || true
server_pid=""; child_pid=""
rm -f "$AIT_CODEX_SHARED_SOCKET" "$AIT_TEST_SERVER_PID" "$AIT_TEST_CHILD_PID"
echo 'run-codex-appserver-test: socket and MCP entrypoint suffixes cannot authorize adoption or stop'

AIT_TEST_IGNORE_TERM=1 "$launcher" > "$TEST_DIR/wrapper-term.log" 2>&1 &
wrapper=$!
extra_pids="$extra_pids $wrapper"
for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID" ] && break; sleep 0.05; done
server_pid="$(cat "$AIT_TEST_SERVER_PID")"
child_pid="$(cat "$AIT_TEST_CHILD_PID")"
kill -TERM "$wrapper"
status=0
wait "$wrapper" || status=$?
[ "$status" = 143 ]
if kill -0 "$server_pid" 2>/dev/null || kill -0 "$child_pid" 2>/dev/null; then exit 1; fi
server_pid=""; child_pid=""
/usr/bin/lockf -s -k -t 0 "$AIT_CODEX_SHARED_SOCKET.start-lock" /usr/bin/true
rm -f "$AIT_TEST_SERVER_PID" "$AIT_TEST_CHILD_PID"
echo 'run-codex-appserver-test: wrapper TERM escalates and reaps a stubborn server and children'

# Pause stop exactly at its final socket unlink while its kernel lock is held.
# Starting in this interval must wait, then bind a socket that stop cannot remove.
cat > "$TEST_DIR/shim/rm" <<'SH'
#!/bin/bash
if [ -n "${AIT_TEST_STOP_CLEANUP_GATE:-}" ] && [ "${1:-}" = -f ] && [ "${2:-}" = "$AIT_CODEX_SHARED_SOCKET" ]; then
  touch "$AIT_TEST_STOP_CLEANUP_GATE.arrived"
  while [ ! -e "$AIT_TEST_STOP_CLEANUP_GATE" ]; do sleep 0.01; done
fi
exec /bin/rm "$@"
SH
chmod +x "$TEST_DIR/shim/rm"
rm -f "$AIT_CODEX_SHARED_SOCKET"
/usr/bin/python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$AIT_CODEX_SHARED_SOCKET"
cleanup_gate="$TEST_DIR/stop-cleanup"
AIT_TEST_STOP_CLEANUP_GATE="$cleanup_gate" "$TEST_DIR/bin/stop-codex-appserver.sh" > "$TEST_DIR/stop-race.log" 2>&1 &
stopper=$!
extra_pids="$extra_pids $stopper"
for _ in {1..100}; do [ -f "$cleanup_gate.arrived" ] && break; sleep 0.05; done
[ -f "$cleanup_gate.arrived" ]
lock_status=0
/usr/bin/lockf -s -k -t 0 "$AIT_CODEX_SHARED_SOCKET.start-lock" /usr/bin/true || lock_status=$?
[ "$lock_status" = 75 ]
"$launcher" > "$TEST_DIR/start-race.log" 2>&1 &
race_wrapper=$!
extra_pids="$extra_pids $race_wrapper"
for _ in {1..100}; do grep -q 'startup in progress' "$TEST_DIR/start-race.log" && break; sleep 0.05; done
grep -q 'startup in progress' "$TEST_DIR/start-race.log"
[ ! -f "$AIT_TEST_SERVER_PID" ]
touch "$cleanup_gate"
wait "$stopper"
for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID" ] && break; sleep 0.05; done
server_pid="$(cat "$AIT_TEST_SERVER_PID")"
child_pid="$(cat "$AIT_TEST_CHILD_PID")"
[ -S "$AIT_CODEX_SHARED_SOCKET" ]
[ "$(running_pid codex-appserver)" = "$server_pid" ]
kill -0 "$server_pid"
"$launcher" > "$TEST_DIR/race-adopt.log"
[ "$(running_pid codex-appserver)" = "$server_pid" ]
"$TEST_DIR/bin/stop-codex-appserver.sh"
wait "$race_wrapper" 2>/dev/null || true
server_pid=""; child_pid=""
echo 'run-codex-appserver-test: start waits through final stop cleanup and retains its bound socket'

# Opposite direction: stop meets a startup that still owns the pre-bind lock.
# It terminates that verified startup and completes in the same invocation.
rm -f "$AIT_TEST_SERVER_PID" "$AIT_TEST_CHILD_PID" "$AIT_TEST_SERVER_PID.prebind"
gate="$TEST_DIR/stop-prebind"
AIT_TEST_BIND_GATE="$gate" "$launcher" > "$TEST_DIR/start-held.log" 2>&1 &
wrapper=$!
extra_pids="$extra_pids $wrapper"
for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID.prebind" ] && break; sleep 0.05; done
prebind="$(cat "$AIT_TEST_SERVER_PID.prebind")"
extra_pids="$extra_pids $prebind"
"$TEST_DIR/bin/stop-codex-appserver.sh"
wait "$wrapper" 2>/dev/null || true
if kill -0 "$prebind" 2>/dev/null; then exit 1; fi
/usr/bin/lockf -s -k -t 0 "$AIT_CODEX_SHARED_SOCKET.start-lock" /usr/bin/true
rm -f "$AIT_TEST_SERVER_PID.prebind"
echo 'run-codex-appserver-test: stop completes against an own prebind startup without foreign-lock errors'

# npm-installed Codex has a JS shim child and a native grandchild socket owner.
cat > "$TEST_DIR/npm-codex" <<'JS'
#!/usr/bin/env node
const { spawn } = require('node:child_process')
const child = spawn(process.env.AIT_TEST_NATIVE_CODEX, process.argv.slice(2), { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
JS
chmod +x "$TEST_DIR/npm-codex"
CODEX_BIN="$TEST_DIR/npm-codex" AIT_TEST_NATIVE_CODEX="$TEST_DIR/codex" \
  "$launcher" > "$TEST_DIR/npm-shim.log" 2>&1 &
wrapper=$!
extra_pids="$extra_pids $wrapper"
for _ in {1..100}; do [ -s "$AIT_TEST_SERVER_PID" ] && break; sleep 0.05; done
server_pid="$(cat "$AIT_TEST_SERVER_PID")"
child_pid="$(cat "$AIT_TEST_CHILD_PID")"
shim_pid="$(ps -p "$server_pid" -o ppid= | tr -d ' ')"
[ "$shim_pid" != "$wrapper" ]
# Wait for the lock-release event, not an assumed native startup duration.
released=0
for _ in {1..100}; do
  if /usr/bin/lockf -s -k -t 0 "$AIT_CODEX_SHARED_SOCKET.start-lock" /usr/bin/true; then released=1; break; fi
  sleep 0.05
done
[ "$released" = 1 ]
[ "$(running_pid codex-appserver)" = "$server_pid" ]
kill -TERM "$wrapper"
status=0
wait "$wrapper" || status=$?
[ "$status" = 143 ]
if kill -0 "$server_pid" 2>/dev/null || kill -0 "$shim_pid" 2>/dev/null || kill -0 "$child_pid" 2>/dev/null; then exit 1; fi
server_pid=""; child_pid=""
rm -f "$AIT_TEST_SERVER_PID" "$AIT_TEST_CHILD_PID"
echo 'run-codex-appserver-test: npm shim releases bind lock and shutdown reaps shim/native server/children'
