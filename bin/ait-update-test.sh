#!/bin/bash
# Outcome tests for immutable release-backed updates.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
ROOT="$(mktemp -d /tmp/ait-update-test.XXXXXX)"
ORIGINAL_PATH="$PATH"
trap 'rm -rf "$ROOT"' EXIT INT TERM
PASS=0
pass() { PASS=$((PASS + 1)); echo "ok - $*"; }
fail() { echo "not ok - $*" >&2; exit 1; }
contains() { printf '%s\n' "$1" | grep -Fq -- "$2" || fail "expected '$2'"; }
refuses() {
  local name="$1" needle="$2"; shift 2
  set +e; output="$("$@" 2>&1)"; rc=$?; set -e
  [ "$rc" -ne 0 ] || fail "$name succeeded"
  contains "$output" "$needle"
  pass "$name"
}

mkdir -p "$ROOT/bin" "$ROOT/home" "$ROOT/state" "$ROOT/tmp"
for tool in git node sed awk grep shasum sha256sum; do
  real="$(PATH="$ORIGINAL_PATH" command -v "$tool" 2>/dev/null || true)"
  [ -z "$real" ] || ln -s "$real" "$ROOT/bin/$tool"
done
cat > "$ROOT/bin/curl" <<'EOF'
#!/bin/sh
for arg in "$@"; do case "$arg" in file://*) exec /usr/bin/curl -fsSL "$arg" ;; esac; done
exit 1
EOF
cat > "$ROOT/bin/pgrep" <<'EOF'
#!/bin/sh
[ "${AIT_TEST_ACTIVE:-0}" = 1 ] && echo 4242
exit 0
EOF
chmod +x "$ROOT/bin/curl" "$ROOT/bin/pgrep"
mkdir -p "$ROOT/cli/bin"
cat > "$ROOT/bin/brew" <<EOF
#!/bin/sh
if [ "\${1:-}" = --prefix ]; then printf '%s\n' "$ROOT/cli"; else exit 0; fi
EOF
chmod +x "$ROOT/bin/brew"
PATH="$ROOT/bin:/usr/bin:/bin"; export PATH

source_repo="$ROOT/source"
origin="$ROOT/origin.git"
managed="$ROOT/managed"
mkdir -p "$source_repo/bin" "$source_repo/appview/dist" "$source_repo/mcp/dist"
cp "$REPO/ait" "$source_repo/ait"
cp "$REPO/bin/update.sh" "$source_repo/bin/update.sh"
cat > "$source_repo/bin/install.sh" <<'EOF'
#!/bin/sh
[ "$1" = --rebuild-only ] || exit 2
[ "${AIT_TEST_FAIL_REBUILD:-0}" = 0 ] || exit 1
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
mkdir -p "$repo/appview/dist" "$repo/mcp/dist"
printf built > "$repo/appview/dist/server.js"
printf built > "$repo/mcp/dist/server.js"
echo 'Rebuild: complete'
EOF
chmod +x "$source_repo/ait" "$source_repo/bin/"*
sed -i '' "s#https://github.com/natewalton/ait-protocol#$origin#g" "$source_repo/bin/update.sh"
cat > "$source_repo/bin/status.sh" <<EOF
#!/bin/sh
echo 'AIT status:'
case "\${AIT_TEST_STATE:-stopped}" in
  ready) value=running; rc=0 ;;
  stopped) value=unreachable; rc=1 ;;
  *) echo '  plc unknown'; exit 1 ;;
esac
printf '  plc %s\\n  pds %s\\n  appview %s\\n  codex-appserver %s\\n' "\$value" "\$value" "\$value" "\$value"
exit "\$rc"
EOF
cat > "$source_repo/bin/start-all.sh" <<EOF
#!/bin/sh
echo start >> "$ROOT/calls"
[ "\${AIT_TEST_FAIL_START:-0}" = 0 ]
EOF
cat > "$source_repo/bin/stop-all.sh" <<EOF
#!/bin/sh
echo stop >> "$ROOT/calls"
[ "\${AIT_TEST_FAIL_STOP:-0}" = 0 ]
EOF
chmod +x "$source_repo/bin/status.sh" "$source_repo/bin/start-all.sh" "$source_repo/bin/stop-all.sh"
cat > "$source_repo/.gitignore" <<'EOF'
*.env
appview/data/
appview/dist/
mcp/dist/
EOF
printf '0.1.1\n' > "$source_repo/VERSION"
git -C "$source_repo" init -q
git -C "$source_repo" config user.email fixture@example.test
git -C "$source_repo" config user.name fixture
git -C "$source_repo" add -A
git -C "$source_repo" commit -qm base
base="$(git -C "$source_repo" rev-parse HEAD)"
git clone -q --bare "$source_repo" "$origin"
printf '0.1.2\n' > "$source_repo/VERSION"
git -C "$source_repo" add VERSION bin/update.sh
git -C "$source_repo" commit -qm target
target="$(git -C "$source_repo" rev-parse HEAD)"
git -C "$source_repo" tag v0.1.2
git -C "$source_repo" push -q "$origin" HEAD:main refs/tags/v0.1.2

asset="$ROOT/install.sh"
write_asset() {
cat > "$asset" <<EOF
#!/bin/sh
RELEASE_TAG="v0.1.2"
RELEASE_COMMIT="$target"
EOF
asset_hash="$(shasum -a 256 "$asset" | awk '{print $1}')"
}
write_asset
api="$ROOT/release.json"
write_api() {
  printf '%s\n' "{\"tag_name\":\"${1:-v0.1.2}\",\"html_url\":\"https://example.test/v0.1.2\",\"draft\":false,\"prerelease\":false,\"immutable\":${2:-true},\"assets\":[{\"name\":\"install.sh\",\"browser_download_url\":\"file://$asset\",\"digest\":\"sha256:${3:-$asset_hash}\"}]}" > "$api"
}
write_api

git clone -q "$origin" "$managed"
git -C "$managed" checkout -q --detach "$base"
mkdir -p "$ROOT/cli" "$ROOT/home/.claude/skills" "$ROOT/home/.agents/skills"
managed_real="$(cd "$managed" && pwd -P)"
ln -s "$managed_real/ait" "$ROOT/cli/bin/ait"
ln -s "$managed/skill-source" "$ROOT/home/.claude/skills/delivery-coordination"
ln -s "$managed/skill-source" "$ROOT/home/.agents/skills/delivery-coordination"

status="$ROOT/status"
start="$ROOT/start"
stop="$ROOT/stop"
cat > "$status" <<'EOF'
#!/bin/sh
echo 'AIT status:'
case "${AIT_TEST_STATE:-stopped}" in
  ready) value=running; rc=0 ;;
  stopped) value=unreachable; rc=1 ;;
  *) echo '  plc unknown'; exit 1 ;;
esac
printf '  plc %s\n  pds %s\n  appview %s\n  codex-appserver %s\n' "$value" "$value" "$value" "$value"
exit "$rc"
EOF
cat > "$start" <<'EOF'
#!/bin/sh
echo start >> "$AIT_TEST_CALLS"
[ "${AIT_TEST_FAIL_START:-0}" = 0 ]
EOF
cat > "$stop" <<'EOF'
#!/bin/sh
echo stop >> "$AIT_TEST_CALLS"
[ "${AIT_TEST_FAIL_STOP:-0}" = 0 ]
EOF
chmod +x "$status" "$start" "$stop"

reset_managed() {
  git -C "$managed" reset -q --hard "$base"
  git -C "$managed" clean -qfdx
  mkdir -p "$managed/plc" "$managed/pds" "$managed/appview" "$managed/mcp" "$managed/appview/data" "$managed/appview/dist" "$managed/mcp/dist"
  for f in plc/.env pds/.env appview/.env mcp/.env; do printf 'keep-%s\n' "$f" > "$managed/$f"; done
  printf data > "$managed/appview/data/sentinel"
  printf old > "$managed/appview/dist/server.js"
  printf old > "$managed/mcp/dist/server.js"
  git -C "$managed" update-ref -d refs/ait-release/v0.1.2 2>/dev/null || true
  rm -rf "$ROOT/state/ait-protocol/update.lock" "$ROOT/tmp"/ait-update.* "$ROOT/calls"
  write_asset
  write_api
}

run_update() {
  env HOME="$ROOT/home" TMPDIR="$ROOT/tmp" XDG_STATE_HOME="$ROOT/state" \
    AIT_RELEASE_API_URL="file://$api" AIT_TEST_CALLS="$ROOT/calls" "$@" "$managed/bin/update.sh"
}

bash -n "$REPO/bin/update.sh" "$REPO/ait"
contains "$("$REPO/ait" help update)" 'Usage: ait update'
ruby -e 'require "yaml"; YAML.load_file(ARGV[0])' "$REPO/.github/workflows/release.yml"
pass 'syntax, help, and release workflow parse'

reset_managed
before="$(shasum -a 256 "$managed"/{plc,pds,appview,mcp}/.env "$managed/appview/data/sentinel" | shasum -a 256 | awk '{print $1}')"
out="$(run_update AIT_TEST_STATE=stopped)" || fail "stopped update: $out"
contains "$out" 'Updated AIT 0.1.1 -> 0.1.2'
[ "$(git -C "$managed" rev-parse HEAD)" = "$target" ] || fail 'wrong update target'
[ "$(git -C "$managed" rev-parse 'refs/ait-release/v0.1.2^{commit}')" = "$target" ] || fail 'release ref missing'
[ ! -e "$ROOT/calls" ] || fail 'stopped update called service scripts'
[ "$before" = "$(shasum -a 256 "$managed"/{plc,pds,appview,mcp}/.env "$managed/appview/data/sentinel" | shasum -a 256 | awk '{print $1}')" ] || fail 'update changed state bytes'
  [ ! -d "$ROOT/state/ait-protocol/update.lock" ] && [ -z "$(find "$ROOT/tmp" -name 'ait-update.*' -print -quit)" ] || fail 'update cleanup leaked'
pass 'stopped update preserves state and records exact release'

reset_managed
run_update AIT_TEST_STATE=ready >/dev/null
[ "$(cat "$ROOT/calls")" = $'stop\nstart' ] || fail 'ready update did not stop and start once'
pass 'ready update restores ready state'

: > "$ROOT/calls"
noop="$(run_update AIT_TEST_STATE=partial AIT_TEST_ACTIVE=1)" || fail 'no-op failed'
contains "$noop" 'already up to date'
[ ! -s "$ROOT/calls" ] || fail 'no-op called services'
pass 'no-op performs no lifecycle or session checks'

reset_managed
write_api v0.1.2 false
refuses 'mutable release refusal' immutable run_update AIT_TEST_STATE=stopped
write_api v0.1.2 true "$(printf bad | shasum -a 256 | awk '{print $1}')"
refuses 'digest refusal' 'digest mismatch' run_update AIT_TEST_STATE=stopped
write_api
pass 'release metadata and digest fail closed'

div="$ROOT/divergent"
git init -q "$div"; git -C "$div" config user.email fixture@example.test; git -C "$div" config user.name fixture
printf '9.9.9\n' > "$div/VERSION"; git -C "$div" add VERSION; git -C "$div" commit -qm divergent
div_commit="$(git -C "$div" rev-parse HEAD)"; git --git-dir="$origin" fetch -q "$div" HEAD:refs/tags/v9.9.9
cat > "$asset" <<EOF
RELEASE_TAG="v9.9.9"
RELEASE_COMMIT="$div_commit"
EOF
asset_hash="$(shasum -a 256 "$asset" | awk '{print $1}')"; write_api v9.9.9 true "$asset_hash"
refuses 'divergent release refusal' diverges run_update AIT_TEST_STATE=stopped
pass 'descendant-only update is enforced'

reset_managed
git -C "$managed" remote set-url origin "$ROOT/foreign-origin.git"
refuses 'foreign origin refusal' 'not owned by the AIT release updater' run_update AIT_TEST_STATE=stopped
[ "$(git -C "$managed" rev-parse HEAD)" = "$base" ] || fail 'foreign origin changed checkout'
git -C "$managed" remote set-url origin "$origin"
pass 'foreign origin is refused unchanged'

reset_managed
printf dirty > "$managed/dirty"
refuses 'dirty checkout refusal' dirty run_update AIT_TEST_STATE=stopped
rm "$managed/dirty"
refuses 'active session refusal' 'active AIT session' run_update AIT_TEST_STATE=stopped AIT_TEST_ACTIVE=1
mkdir -p "$ROOT/state/ait-protocol/update.lock"; echo $$ > "$ROOT/state/ait-protocol/update.lock/pid"
refuses 'live lock refusal' 'another AIT update' run_update AIT_TEST_STATE=stopped
rm -rf "$ROOT/state/ait-protocol/update.lock"
refuses 'partial service refusal' 'partial or has an unknown status' run_update AIT_TEST_STATE=partial
pass 'ownership, session, lock, and service boundaries refuse before checkout'

reset_managed
set +e; recovery="$(run_update AIT_TEST_STATE=stopped AIT_TEST_FAIL_REBUILD=1 2>&1)"; rc=$?; set -e
[ "$rc" -eq 1 ] || fail 'rebuild failure succeeded'
contains "$recovery" 'checkout --detach'
case "$recovery" in *'Do not reset'*) fail 'pre-start recovery forbids safe restore' ;; esac
[ ! -d "$ROOT/state/ait-protocol/update.lock" ] || fail 'rebuild failure leaked lock'
pass 'pre-start failure prints manual old-release recovery and cleans up'

reset_managed
set +e; recovery="$(run_update AIT_TEST_STATE=ready AIT_TEST_FAIL_START=1 2>&1)"; rc=$?; set -e
[ "$rc" -eq 1 ] || fail 'start failure succeeded'
contains "$recovery" 'Do not reset; persisted data may have advanced.'
case "$recovery" in *'checkout --detach'*) fail 'post-start recovery suggested reset' ;; esac
[ ! -d "$ROOT/state/ait-protocol/update.lock" ] || fail 'start failure leaked lock'
pass 'post-start failure requires fix-forward and cleans up'

reset_managed
public="$(env HOME="$ROOT/home" TMPDIR="$ROOT/tmp" XDG_STATE_HOME="$ROOT/state" AIT_RELEASE_API_URL="file://$api" AIT_TEST_CALLS="$ROOT/calls" AIT_TEST_STATE=stopped "$managed/ait" update)" || fail 'public dispatch failed'
contains "$public" 'Updated AIT 0.1.1 -> 0.1.2'
pass 'public CLI dispatch uses the installed updater'

echo "AIT update test suite passed ($PASS cases)"
