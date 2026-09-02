#!/bin/bash
# Local-only release/update fixture. It never uses the operator's checkout,
# home, services, database, sockets, or sessions.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
ORIGINAL_PATH="$PATH"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ait-update-test.XXXXXX")"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME="AIT update fixture"
export GIT_AUTHOR_EMAIL="ait-update-fixture@example.test"
export GIT_COMMITTER_NAME="AIT update fixture"
export GIT_COMMITTER_EMAIL="ait-update-fixture@example.test"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT INT TERM
PASS_COUNT=0
pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo "ok - $1"; }
fail() { echo "not ok - $1: $2" >&2; exit 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "$3" "missing $2" ;; esac; }
assert_status() { local expected=$1 actual=$2 name=$3; [ "$actual" -eq "$expected" ] || fail "$name" "expected $expected, got $actual"; }
assert_nonzero() { local actual=$1 name=$2; [ "$actual" -ne 0 ] || fail "$name" "expected nonzero status"; }

identity_config="$(git config --show-origin --get-regexp '^user\.(name|email)$' 2>/dev/null || true)"
[ -z "$identity_config" ] || fail "fixture Git identity" "global/system identity unexpectedly present: $identity_config"
pass "fixture-owned Git identity works without global or system config"

if ! bash -n "$REPO/install.sh" "$REPO/ait" "$REPO/bin/install.sh" "$REPO/bin/update.sh" "$REPO/bin/ait-update-test.sh"; then
  fail "syntax" "bash -n failed"
fi
pass "syntax"

help_output="$($REPO/ait update --help)"
assert_contains "$help_output" "immutable" "update help"
assert_contains "$help_output" "fix-forward" "update help"
pass "offline update help"

version_home="$TMP_ROOT/version-home"
mkdir -p "$version_home"
version_output="$(HOME="$version_home" XDG_STATE_HOME="$TMP_ROOT/version-state" PATH="$ORIGINAL_PATH" "$REPO/ait" version)"
assert_contains "$version_output" "AIT 0.1.0" "release version"
assert_contains "$version_output" "development" "unreleased version marker"
pass "offline development version"
offline_wrong_tag="$TMP_ROOT/offline-wrong-tag"
git clone -q "$REPO" "$offline_wrong_tag"
git -C "$offline_wrong_tag" tag v9.9.8 HEAD
printf '9.9.9\n' > "$offline_wrong_tag/VERSION"
offline_wrong_tag_output="$(HOME="$TMP_ROOT/offline-home" PATH="$ORIGINAL_PATH" "$offline_wrong_tag/ait" version 2>&1)" || fail "offline wrong-tag VERSION" "version command failed: $offline_wrong_tag_output"
assert_contains "$offline_wrong_tag_output" "AIT 9.9.9" "offline wrong-tag VERSION"
assert_contains "$offline_wrong_tag_output" "development" "offline wrong-tag VERSION"
pass "offline wrong-tag VERSION reports development without network"

annotated_version="$TMP_ROOT/annotated-version"
git clone -q "$REPO" "$annotated_version"
cp "$REPO/ait" "$annotated_version/ait"
chmod +x "$annotated_version/ait"
git -C "$annotated_version" tag -a -m "annotated release" v0.1.0 HEAD
annotated_ref="$(git -C "$annotated_version" rev-parse refs/tags/v0.1.0)"
git -C "$annotated_version" update-ref -d refs/tags/v0.1.0
git -C "$annotated_version" update-ref refs/ait-release/v0.1.0 "$annotated_ref"
annotated_output="$(HOME="$TMP_ROOT/annotated-home" PATH="$ORIGINAL_PATH" "$annotated_version/ait" version)"
assert_contains "$annotated_output" "AIT 0.1.0" "annotated release ref"
case "$annotated_output" in *development*) fail "annotated release ref" "peeled release ref was treated as development" ;; esac
pass "annotated release ref is peeled to the active commit"

workflow="$REPO/.github/workflows/release.yml"
for required in \
  "immutable-releases" \
  "refs/tags/\$RELEASE_TAG" \
  "X-GitHub-Api-Version: 2026-03-10" \
  "draft_json" \
  "immutable_releases" \
  "IMMUTABLE_RELEASES_CONFIRMED" \
  "admin-capable settings probe" \
  "AIT_UPDATE_FIXTURE_ASSET" \
  "latest-release.response" \
  "http_status" \
  "draft_created" \
  "gh release delete" \
  "test \"\$(git rev-parse HEAD)\" = \"\$(git rev-parse origin/main)\"" \
  "npm --prefix plc ci" \
  "npm --prefix mcp ci" \
  'test "$actual_asset_digest" = "$expected_asset_digest"'; do
  grep -Fq "$required" "$workflow" || fail "release workflow gates" "missing $required"
done
test "$(grep -Fc 'r.immutable !== true' "$workflow")" -eq 2 || fail "release workflow lifecycle" "immutable was required before publication"
grep -Fq 'if (!r.draft || r.prerelease || r.target_commitish !== expectedCommit' "$workflow" || fail "release workflow lifecycle" "draft target/digest gate is missing"
numeric_release_lookup_ok() {
  local candidate=$1
  ! grep -Fq 'releases/tags/$RELEASE_TAG' "$candidate" &&
    test "$(grep -Fc 'releases/$draft_id' "$candidate")" -eq 2 &&
    test "$(grep -Fc 'databaseId' "$candidate")" -eq 2
}
numeric_release_lookup_ok "$workflow" || fail "draft ID lookup regression" "prepare/publish do not both resolve databaseId"
draft_lookup_fixture="$TMP_ROOT/draft-lookup.json"
printf '%s\n' '{"databaseId":381628520,"targetCommitish":"deadbeef","isDraft":true}' > "$draft_lookup_fixture"
publish_jq="$(grep -F 'gh release view "$RELEASE_TAG" --json databaseId,targetCommitish,isDraft' "$workflow" | sed -E "s/.*--jq '([^']+)'.*/\\1/")"
publish_target="$(jq -r "$publish_jq" "$draft_lookup_fixture")" || fail "draft ID lookup regression" "publish jq expression rejects a numeric databaseId"
test "$publish_target" = $'381628520\tdeadbeef\ttrue' || fail "draft ID lookup regression" "publish jq expression produced: $publish_target"
pass "draft prepare and publish resolve the numeric release ID"
grep -Fq 'AIT_PUBLIC_RECOVERY_COMMAND=' "$REPO/install.sh" || fail "transition recovery" "raw-main recovery command is not passed to private installer"
grep -Fq 'checkout -q --detach "$TARGET_COMMIT"' "$REPO/bin/update.sh" || fail "target immutability" "checkout is not bound to the verified commit"
pass "release workflow gates settings, ancestry, locked dependencies, asset replay, and digest"
# The unreplaced source asset must remain the raw-main bootstrap during the
# window in which README still points at raw main. This also executes the
# unchanged #8 bootstrap path against a local Git source.
grep -Fq 'raw.githubusercontent.com/natewalton/ait-protocol/main/install.sh' "$REPO/install.sh" || fail "transition window" "raw-main fallback missing"
grep -Fq '__AIT_RELEASE_TAG__' "$REPO/install.sh" || fail "transition window" "release placeholder missing"
source_home="$TMP_ROOT/source-home"
source_root="$TMP_ROOT/source-root"
source_bin="$TMP_ROOT/source-bin"
mkdir -p "$source_bin"
cat > "$source_bin/brew" <<'EOF'
#!/bin/bash
case "$1" in --prefix) printf '%s\n' "$AIT_BREW_PREFIX" ;; *) exit 0 ;; esac
EOF
cat > "$source_bin/claude" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$source_bin/lsof" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$source_bin/brew" "$source_bin/claude" "$source_bin/lsof"
source_output="$(HOME="$source_home" PATH="$source_bin:$ORIGINAL_PATH" AIT_BREW_PREFIX="$TMP_ROOT/brew" AIT_SKIP_PLATFORM_CHECK=1 AIT_NO_SKILLS=1 AIT_REPO_URL="file://$REPO" AIT_INSTALL_ROOT="$source_root" AIT_CLI_LINK="$TMP_ROOT/source-cli/ait" AIT_INSTALL_STATE_DIR="$TMP_ROOT/source-state" AIT_INSTALL_SKIP_PROVISION=1 "$REPO/install.sh" 2>&1)" || fail "transition window" "unreplaced installer did not run"
assert_contains "$source_output" "Prerequisites: ✓" "transition window"
assert_contains "$source_output" "skills  skipped" "transition window"
pass "unreplaced template transition window"

# Use the frozen candidate itself as one local immutable release descendant and
# start the managed fixture from its exact released parent.
origin="$TMP_ROOT/origin.git"
managed="$TMP_ROOT/managed"
git clone -q --bare "$REPO" "$origin"
git --git-dir="$origin" tag "v0.1.0" "$(git -C "$REPO" rev-parse HEAD)"
release_commit="$(git -C "$REPO" rev-parse HEAD)"
generated_asset="$TMP_ROOT/generated-install.sh"
sed -e "s/__AIT_RELEASE_TAG__/v0.1.0/g" \
    -e "s/__AIT_RELEASE_COMMIT__/$release_commit/g" "$REPO/install.sh" > "$generated_asset"
chmod +x "$generated_asset"
! grep -Fq '__AIT_RELEASE_' "$generated_asset" || fail "generated asset" "placeholder remains"
bash -n "$generated_asset" || fail "generated asset" "syntax failed"
generated_verify="$($generated_asset --verify-only 2>&1)" || fail "generated asset" "verify-only failed: $generated_verify"
assert_contains "$generated_verify" "verified release installer v0.1.0 at $release_commit" "generated asset"
fresh_release="$TMP_ROOT/fresh-release"
fresh_output="$(HOME="$source_home" PATH="$source_bin:$ORIGINAL_PATH" AIT_BREW_PREFIX="$TMP_ROOT/brew" AIT_SKIP_PLATFORM_CHECK=1 AIT_NO_SKILLS=1 AIT_REPO_URL="file://$origin" AIT_INSTALL_ROOT="$fresh_release" AIT_CLI_LINK="$TMP_ROOT/managed-cli/fresh-ait" AIT_INSTALL_STATE_DIR="$TMP_ROOT/fresh-state" AIT_INSTALL_SKIP_PROVISION=1 "$generated_asset" 2>&1)" || fail "generated asset" "fresh install failed: $fresh_output"
[ "$(git -C "$fresh_release" rev-parse HEAD)" = "$release_commit" ] || fail "generated asset" "wrong exact tag checkout"
fresh_version="$($fresh_release/ait version)"
case "$fresh_version" in *development*) fail "generated asset" "tag-only install reports development" ;; esac
pass "generated release asset verifies and installs the exact tag without raw-main"
fresh_rerun="$(HOME="$source_home" PATH="$source_bin:$ORIGINAL_PATH" AIT_BREW_PREFIX="$TMP_ROOT/brew" AIT_SKIP_PLATFORM_CHECK=1 AIT_NO_SKILLS=1 AIT_REPO_URL="file://$origin" AIT_INSTALL_ROOT="$fresh_release" AIT_CLI_LINK="$TMP_ROOT/managed-cli/fresh-ait" AIT_INSTALL_STATE_DIR="$TMP_ROOT/fresh-state" AIT_INSTALL_SKIP_PROVISION=1 "$generated_asset" 2>&1)" || fail "generated asset rerun" "rerun failed: $fresh_rerun"
assert_contains "$fresh_rerun" "Next steps:" "generated asset rerun"
[ "$(git -C "$fresh_release" rev-parse HEAD)" = "$release_commit" ] || fail "generated asset rerun" "rerun moved the checkout"
pass "generated release asset rerun preserves the exact checkout"

partial_release="$TMP_ROOT/partial-release"
partial_state="$TMP_ROOT/partial-state"
missing_origin="$TMP_ROOT/missing-origin.git"
set +e
partial_output="$(HOME="$source_home" PATH="$source_bin:$ORIGINAL_PATH" AIT_BREW_PREFIX="$TMP_ROOT/brew" AIT_SKIP_PLATFORM_CHECK=1 AIT_NO_SKILLS=1 AIT_REPO_URL="file://$missing_origin" AIT_INSTALL_ROOT="$partial_release" AIT_CLI_LINK="$TMP_ROOT/managed-cli/partial-ait" AIT_INSTALL_STATE_DIR="$partial_state" AIT_INSTALL_SKIP_PROVISION=1 "$generated_asset" 2>&1)"
partial_status=$?
set -e
assert_status 1 "$partial_status" "fresh partial Git cleanup"
assert_contains "$partial_output" "could not be fetched" "fresh partial Git cleanup"
[ ! -e "$partial_release" ] && [ ! -L "$partial_release" ] || fail "fresh partial Git cleanup" "failed fresh checkout was retained"
partial_retry="$(HOME="$source_home" PATH="$source_bin:$ORIGINAL_PATH" AIT_BREW_PREFIX="$TMP_ROOT/brew" AIT_SKIP_PLATFORM_CHECK=1 AIT_NO_SKILLS=1 AIT_REPO_URL="file://$origin" AIT_INSTALL_ROOT="$partial_release" AIT_CLI_LINK="$TMP_ROOT/managed-cli/partial-ait" AIT_INSTALL_STATE_DIR="$partial_state" AIT_INSTALL_SKIP_PROVISION=1 "$generated_asset" 2>&1)" || fail "fresh partial Git cleanup" "retry failed: $partial_retry"
[ "$(git -C "$partial_release" rev-parse HEAD)" = "$release_commit" ] || fail "fresh partial Git cleanup" "retry did not acquire exact release"
pass "fresh release fetch failure removes partial Git state and permits a clean retry"
truncated_asset="$TMP_ROOT/truncated-install.sh"
head -c 200 "$generated_asset" > "$truncated_asset"
chmod +x "$truncated_asset"
set +e
truncated_status="$($truncated_asset --verify-only >/dev/null 2>&1; echo $?)"
set -e
assert_nonzero "$truncated_status" "truncated asset refusal"
pass "truncated generated asset is refused before installation"
git clone -q "$origin" "$managed"
git -C "$managed" checkout -q --detach 7587d999c2cde133918166c4aeabbbfd8cb349cf
for f in plc/.env pds/.env appview/.env mcp/.env; do mkdir -p "$managed/$(dirname "$f")"; printf '%s\n' "fixture-$f" > "$managed/$f"; done
mkdir -p "$managed/appview/dist" "$managed/mcp/dist" "$managed/appview/data"
printf 'old\n' > "$managed/appview/dist/server.js"
printf 'old\n' > "$managed/mcp/dist/server.js"
printf 'persistent-data-sentinel\n' > "$managed/appview/data/sentinel"
mkdir -p "$source_home/.claude/skills" "$source_home/.agents/skills"
ln -s /foreign/claude "$source_home/.claude/skills/delivery-coordination"
ln -s /foreign/agents "$source_home/.agents/skills/delivery-coordination"
mkdir -p "$TMP_ROOT/managed-cli"
ln -s "$managed/ait" "$TMP_ROOT/managed-cli/ait"

fixture_bin="$TMP_ROOT/fixture-bin"
mkdir -p "$fixture_bin"
cat > "$fixture_bin/npm" <<'EOF'
#!/bin/bash
set -e
if [ -n "${AIT_FIXTURE_PHASE_LOG:-}" ]; then printf 'npm:%s\n' "$*" >> "$AIT_FIXTURE_PHASE_LOG"; fi
action="${@: -1}"
case "${AIT_FIXTURE_NPM_FAIL:-}" in
  dependency|1)
    if [ "$AIT_FIXTURE_NPM_FAIL" = 1 ] || [ "$action" = ci ]; then printf '%s\n' dependency >> "$AIT_FIXTURE_PHASE_LOG"; exit 1; fi
    ;;
  build)
    if [ "$action" = build ]; then printf '%s\n' build >> "$AIT_FIXTURE_PHASE_LOG"; exit 1; fi
    ;;
esac
if [ -n "${AIT_FIXTURE_NPM_GATE:-}" ]; then
  printf '%s\n' waiting > "$AIT_FIXTURE_NPM_GATE"
  trap 'exit 143' INT TERM
  while [ ! -e "${AIT_FIXTURE_NPM_RELEASE:-}" ]; do :; done
fi
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix="$2"; shift 2; continue; fi
  shift
done
if [ -n "${AIT_FIXTURE_PHASE_LOG:-}" ]; then
  case " $* " in *" ci "*) printf '%s\n' dependency >> "$AIT_FIXTURE_PHASE_LOG" ;; *" run build "*) printf '%s\n' build >> "$AIT_FIXTURE_PHASE_LOG" ;; esac
fi
mkdir -p "$prefix/node_modules"
if [ -n "$prefix" ]; then mkdir -p "$prefix/dist"; printf 'built\n' > "$prefix/dist/server.js"; fi
EOF
cat > "$fixture_bin/pgrep" <<'EOF'
#!/bin/bash
if [ "${AIT_FIXTURE_ACTIVE:-0}" = 1 ]; then printf '%s\n' 4242; exit 0; fi
exec /usr/bin/pgrep "$@"
EOF
chmod +x "$fixture_bin/npm"
chmod +x "$fixture_bin/pgrep"
cat > "$fixture_bin/find" <<'EOF'
#!/bin/bash
if [ "${AIT_FIXTURE_LEXICON_FAIL:-0}" = 1 ] && [ "${1:-}" = -L ]; then
  printf '%s\n' lexicon >> "$AIT_FIXTURE_PHASE_LOG"
  printf '%s\n' '/fixture/lexicon-one/package.json' '/fixture/lexicon-two/package.json'
  exit 0
fi
exec /usr/bin/find "$@"
EOF
chmod +x "$fixture_bin/find"
real_node="$(PATH="$ORIGINAL_PATH" command -v node)"
export AIT_FIXTURE_REAL_NODE="$real_node"
cat > "$fixture_bin/node" <<'EOF'
#!/bin/bash
if [ "${AIT_FIXTURE_LEXICON_FAIL:-0}" = 1 ] && [ "${1:-}" = -e ]; then
  case "${@: -1}" in
    *lexicon-one*) printf '%s\n' 1.0.0; exit 0 ;;
    *lexicon-two*) printf '%s\n' 2.0.0; exit 0 ;;
  esac
fi
exec "$AIT_FIXTURE_REAL_NODE" "$@"
EOF
chmod +x "$fixture_bin/node"
cat > "$fixture_bin/git" <<'EOF'
#!/bin/bash
if [ -n "${AIT_FIXTURE_GIT_TRACE:-}" ]; then printf '%s\n' "$*" >> "$AIT_FIXTURE_GIT_TRACE"; fi
case "${AIT_FIXTURE_GIT_FAIL_CHECKOUT:-0}:$*" in
  1:*' checkout '*) exit 1 ;;
esac
case "$*" in
  *' checkout '* )
    if [ -n "${AIT_FIXTURE_GIT_CHECKOUT_GATE:-}" ]; then
      printf '%s\n' waiting > "$AIT_FIXTURE_GIT_CHECKOUT_GATE"
      while [ ! -e "${AIT_FIXTURE_GIT_CHECKOUT_RELEASE:-}" ]; do :; done
    fi
    ;;
esac
exec /usr/bin/git "$@"
EOF
chmod +x "$fixture_bin/git"
status_script="$TMP_ROOT/status.sh"
start_script="$TMP_ROOT/start.sh"
stop_script="$TMP_ROOT/stop.sh"
cat > "$status_script" <<'EOF'
#!/bin/bash
state="${AIT_FIXTURE_SERVICE_STATE:-ready}"
[ -n "${AIT_FIXTURE_SERVICE_STATE_FILE:-}" ] && [ -f "$AIT_FIXTURE_SERVICE_STATE_FILE" ] && state="$(cat "$AIT_FIXTURE_SERVICE_STATE_FILE")"
case "$state" in
  ready) printf '%s\n' 'AIT status:' '  plc              running' '  pds              running' '  appview          running' '  codex-appserver  skipped (not installed)' ;;
  stopped) printf '%s\n' 'AIT status:' '  plc              unreachable' '  pds              unreachable' '  appview          unreachable' '  codex-appserver  skipped (not installed)' ; exit 1 ;;
  *) exit 1 ;;
esac
EOF
cat > "$stop_script" <<'EOF'
#!/bin/bash
if [ "${AIT_FIXTURE_STOP_FAIL:-0}" = 1 ]; then
  printf '%s\n' stop >> "$AIT_FIXTURE_PHASE_LOG"
  exit 1
fi
printf '%s\n' stopped > "$AIT_FIXTURE_STOPPED"
EOF
cat > "$start_script" <<'EOF'
#!/bin/bash
printf '%s\n' started > "$AIT_FIXTURE_STARTED"
printf '%s\n' 'started appview (pid 123)' 'Services: ready'
EOF
chmod +x "$status_script" "$start_script" "$stop_script"
real_curl="$(PATH="$ORIGINAL_PATH" command -v curl)"
cat > "$fixture_bin/curl" <<'EOF'
#!/bin/bash
url="${@: -1}"
if [ -n "${AIT_FIXTURE_API_GATE_URL:-}" ] && [ "$url" = "$AIT_FIXTURE_API_GATE_URL" ]; then
  printf '%s\n' waiting > "$AIT_FIXTURE_API_GATE"
  while [ ! -e "$AIT_FIXTURE_API_RELEASE" ]; do :; done
  cat "$AIT_FIXTURE_API_JSON"
  exit 0
fi
if [ -n "${AIT_FIXTURE_API_RACE_URL:-}" ] && [ "$url" = "$AIT_FIXTURE_API_RACE_URL" ]; then
  cat "$AIT_FIXTURE_API_RACE_JSON"
  /usr/bin/git --git-dir="$AIT_FIXTURE_API_RACE_ORIGIN" tag "$AIT_FIXTURE_API_RACE_TAG" "$AIT_FIXTURE_API_RACE_COMMIT"
  exit 0
fi
if [ -n "${AIT_FIXTURE_RATE_LIMIT_URL:-}" ] && [ "$url" = "$AIT_FIXTURE_RATE_LIMIT_URL" ]; then
  printf '%s\n' '{"message":"API rate limit exceeded"}' >&2
  exit 22
fi
exec "${AIT_FIXTURE_REAL_CURL:-/usr/bin/curl}" "$@"
EOF
chmod +x "$fixture_bin/curl"

asset="$TMP_ROOT/install-asset.sh"
if [ -n "${AIT_UPDATE_FIXTURE_ASSET:-}" ]; then
  cp "$AIT_UPDATE_FIXTURE_ASSET" "$asset"
else
  cp "$generated_asset" "$asset"
fi
asset_hash="$(shasum -a 256 "$asset" | awk '{print $1}')"
api="$TMP_ROOT/release.json"
printf '%s\n' "{\"tag_name\":\"v0.1.0\",\"html_url\":\"https://example.test/releases/v0.1.0\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"assets\":[{\"name\":\"install.sh\",\"browser_download_url\":\"file://$asset\",\"digest\":\"sha256:$asset_hash\"}]}" > "$api"

draft_fixture="$TMP_ROOT/draft-release.json"
published_fixture="$TMP_ROOT/published-release.json"
printf '%s\n' "{\"tag_name\":\"v0.1.0\",\"draft\":true,\"prerelease\":false,\"immutable\":false,\"target_commitish\":\"$release_commit\",\"assets\":[{\"name\":\"install.sh\",\"digest\":\"sha256:$asset_hash\"}]}" > "$draft_fixture"
printf '%s\n' "{\"tag_name\":\"v0.1.0\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"target_commitish\":\"$release_commit\",\"assets\":[{\"name\":\"install.sh\",\"digest\":\"sha256:$asset_hash\"}]}" > "$published_fixture"
node - "$draft_fixture" "$published_fixture" "$release_commit" "$asset_hash" <<'NODE'
const fs = require('fs');
const [draftPath, publishedPath, expectedCommit, expectedDigest] = process.argv.slice(2);
const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
const published = JSON.parse(fs.readFileSync(publishedPath, 'utf8'));
const asset = value => (value.assets || []).find(x => x.name === 'install.sh');
if (!draft.draft || draft.prerelease || draft.target_commitish !== expectedCommit || !asset(draft) || asset(draft).digest !== 'sha256:' + expectedDigest) process.exit(1);
if (draft.immutable !== false || published.draft || published.immutable !== true || published.target_commitish !== expectedCommit || !asset(published) || asset(published).digest !== 'sha256:' + expectedDigest) process.exit(1);
NODE
pass "release lifecycle fixture verifies actual draft and published API responses"

node - "$release_commit" "$asset_hash" <<'NODE'
const [expectedCommit, expectedDigest] = process.argv.slice(2);
const draft = {draft: true, prerelease: false, immutable: false, target_commitish: expectedCommit, assets: [{name: 'install.sh', digest: `sha256:${expectedDigest}`}]};
const published = {...draft, draft: false, immutable: true};
const asset = value => (value.assets || []).find(x => x.name === 'install.sh');
if (!draft.draft || draft.prerelease || draft.target_commitish !== expectedCommit || !asset(draft) || asset(draft).digest !== `sha256:${expectedDigest}`) process.exit(1);
if (draft.immutable !== false || published.draft || published.immutable !== true) process.exit(1);
NODE
pass "mutable draft is gated before publication and immutable only after publication"
pass "release lifecycle fixture distinguishes draft and published immutable states"

before_env="$(shasum -a 256 "$managed"/plc/.env "$managed"/pds/.env "$managed"/appview/.env "$managed"/mcp/.env | shasum -a 256 | awk '{print $1}')"
before_data="$(shasum -a 256 "$managed/appview/data/sentinel" | awk '{print $1}')"
before_links="$(readlink "$source_home/.claude/skills/delivery-coordination")|$(readlink "$source_home/.agents/skills/delivery-coordination")"
update_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_GIT_TRACE="$TMP_ROOT/git-trace" AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/ait" AIT_INSTALL_ROOT="$managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" AIT_UPDATE_START_SCRIPT="$start_script" AIT_UPDATE_STOP_SCRIPT="$stop_script" AIT_FIXTURE_STOPPED="$TMP_ROOT/stopped" AIT_FIXTURE_STARTED="$TMP_ROOT/started" "$REPO/bin/update.sh" "$managed" 2>&1)" || fail "ready update" "update failed: $update_output"
assert_contains "$update_output" "Updated AIT pre-release -> 0.1.0" "ready update"
assert_contains "$update_output" "Release notes: https://example.test/releases/v0.1.0" "ready update"
[ "$(git -C "$managed" rev-parse HEAD)" = "$release_commit" ] || fail "ready update" "wrong target commit"
[ -f "$TMP_ROOT/started" ] && [ -f "$TMP_ROOT/stopped" ] || fail "ready update" "service state was not restored"
after_env="$(shasum -a 256 "$managed"/plc/.env "$managed"/pds/.env "$managed"/appview/.env "$managed"/mcp/.env | shasum -a 256 | awk '{print $1}')"
[ "$before_env" = "$after_env" ] || fail "ready update" "environment bytes changed"
[ "$before_data" = "$(shasum -a 256 "$managed/appview/data/sentinel" | awk '{print $1}')" ] || fail "ready update" "persistent data changed"
[ "$before_links" = "$(readlink "$source_home/.claude/skills/delivery-coordination")|$(readlink "$source_home/.agents/skills/delivery-coordination")" ] || fail "ready update" "skill links changed"
managed_version="$($managed/ait version)"
case "$managed_version" in *development*) fail "ready update" "updated exact release reports development" ;; esac
assert_contains "$(cat "$TMP_ROOT/git-trace" 2>/dev/null || true)" "checkout -q --detach $release_commit" "ready update"
checkout_trace="$(grep -F 'checkout -q --detach' "$TMP_ROOT/git-trace" || true)"
case "$checkout_trace" in *refs/ait-update*) fail "ready update" "checkout used mutable fetch ref" ;; esac
pass "pre-release adoption, exact tag, rebuild, and ready-state restore"

: > "$TMP_ROOT/git-trace"
noop_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_GIT_TRACE="$TMP_ROOT/git-trace" AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/ait" AIT_INSTALL_ROOT="$managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" AIT_UPDATE_START_SCRIPT="$TMP_ROOT/must-not-start" AIT_UPDATE_STOP_SCRIPT="$TMP_ROOT/must-not-stop" "$REPO/bin/update.sh" "$managed" 2>&1)" || fail "up-to-date update" "no-op failed: $noop_output"
assert_contains "$noop_output" "already up to date" "up-to-date update"
[ ! -e "$TMP_ROOT/must-not-start" ] && [ ! -e "$TMP_ROOT/must-not-stop" ] || fail "up-to-date update" "no-op changed services"
case "$(cat "$TMP_ROOT/git-trace" 2>/dev/null || true)" in *\ fetch\ *) fail "up-to-date update" "no-op fetched a tag" ;; esac
pass "up-to-date release is a read-only no-op"

noop_crashed_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_SERVICE_STATE=partial AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/ait" AIT_INSTALL_ROOT="$managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/bin/update.sh" "$managed" 2>&1)" || fail "crashed-service no-op" "no-op probed service state: $noop_crashed_output"
assert_contains "$noop_crashed_output" "already up to date" "crashed-service no-op"
pass "up-to-date no-op succeeds without probing a crashed service"

comment_asset="$TMP_ROOT/comment-install.sh"
printf '# RELEASE_TAG="v0.1.0"\n# RELEASE_COMMIT="%s"\n' "$release_commit" > "$comment_asset"
comment_hash="$(shasum -a 256 "$comment_asset" | awk '{print $1}')"
printf '%s\n' "{\"tag_name\":\"v0.1.0\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"assets\":[{\"name\":\"install.sh\",\"browser_download_url\":\"file://$comment_asset\",\"digest\":\"sha256:$comment_hash\"}]}" > "$api"
set +e
comment_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/ait" AIT_INSTALL_ROOT="$managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/bin/update.sh" "$managed" 2>&1)"
comment_status=$?
set -e
assert_status 1 "$comment_status" "comment-only identity refusal"
assert_contains "$comment_output" "exactly one full SemVer tag assignment" "comment-only identity refusal"
pass "comment-only release identity is rejected"

printf '%s\n' "{\"tag_name\":\"v0.1.0\",\"html_url\":\"https://example.test/releases/v0.1.0\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"assets\":[{\"name\":\"install.sh\",\"browser_download_url\":\"file://$asset\",\"digest\":\"sha256:$asset_hash\"}]}" > "$api"
active_noop_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_ACTIVE=1 AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/ait" AIT_INSTALL_ROOT="$managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/bin/update.sh" "$managed" 2>&1)" || fail "active-session no-op" "no-op refused: $active_noop_output"
assert_contains "$active_noop_output" "already up to date" "active-session no-op"
pass "up-to-date no-op ignores sessions because it performs no mutation"

cli_lock="$TMP_ROOT/cli-lock"
mkdir -p "$cli_lock"
printf '%s\n' "$$" > "$cli_lock/pid"
printf '%s\n' cli > "$cli_lock/state"
set +e
cli_start_output="$(AIT_UPDATE_LOCK="$cli_lock" HOME="$source_home" PATH="$ORIGINAL_PATH" "$REPO/ait" start 2>&1)"
cli_start_status=$?
cli_stop_output="$(AIT_UPDATE_LOCK="$cli_lock" HOME="$source_home" PATH="$ORIGINAL_PATH" "$REPO/ait" stop 2>&1)"
cli_stop_status=$?
set -e
assert_status 1 "$cli_start_status" "start lock refusal"
assert_status 1 "$cli_stop_status" "stop lock refusal"
assert_contains "$cli_start_output" "already running" "start lock refusal"
assert_contains "$cli_stop_output" "already running" "stop lock refusal"
rm -f "$cli_lock/pid" "$cli_lock/state"
rmdir "$cli_lock"
pass "start and stop refuse while an update lock is owned"

cli_noop_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/ait" AIT_INSTALL_ROOT="$managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$managed/ait" update 2>&1)" || fail "public update dispatch" "temp updater failed: $cli_noop_output"
assert_contains "$cli_noop_output" "already up to date" "public update dispatch"
pass "public update dispatch executes its private copy"

prepare_old_fixture() {
  local dir="$1" link="$2"
  git clone -q "$origin" "$dir"
  git -C "$dir" checkout -q --detach 7587d999c2cde133918166c4aeabbbfd8cb349cf
  for f in plc/.env pds/.env appview/.env mcp/.env; do
    mkdir -p "$dir/$(dirname "$f")"
    printf '%s\n' "fixture-$f" > "$dir/$f"
  done
  mkdir -p "$dir/appview/dist" "$dir/mcp/dist" "$dir/appview/data"
  printf 'old\n' > "$dir/appview/dist/server.js"
  printf 'old\n' > "$dir/mcp/dist/server.js"
  printf 'persistent-data-sentinel\n' > "$dir/appview/data/sentinel"
  ln -s "$dir/ait" "$link"
}

before_stop_managed="$TMP_ROOT/before-stop-managed"
prepare_old_fixture "$before_stop_managed" "$TMP_ROOT/managed-cli/before-stop-ait"
set +e
before_stop_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_STOP_FAIL=1 AIT_FIXTURE_PHASE_LOG="$TMP_ROOT/phase-log" AIT_FIXTURE_SERVICE_STATE=ready AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/before-stop-ait" AIT_INSTALL_ROOT="$before_stop_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" AIT_UPDATE_START_SCRIPT="$start_script" AIT_UPDATE_STOP_SCRIPT="$stop_script" AIT_FIXTURE_STARTED="$TMP_ROOT/before-stop-started" "$REPO/bin/update.sh" "$before_stop_managed" 2>&1)"
before_stop_status=$?
set -e
assert_status 1 "$before_stop_status" "stop failure before mutation"
assert_contains "$before_stop_output" "could not stop the ready AIT service set" "stop failure before mutation"
[ "$(git -C "$before_stop_managed" rev-parse HEAD)" = "7587d999c2cde133918166c4aeabbbfd8cb349cf" ] || fail "stop failure before mutation" "checkout changed"
[ ! -e "$TMP_ROOT/before-stop-started" ] || fail "stop failure before mutation" "start ran after stop failure"
pass "failure before service stop leaves the old checkout and service state"

checkout_fail_managed="$TMP_ROOT/checkout-fail-managed"
prepare_old_fixture "$checkout_fail_managed" "$TMP_ROOT/managed-cli/checkout-fail-ait"
checkout_fail_lock="$TMP_ROOT/checkout-fail-lock"
checkout_fail_tmp_parent="$TMP_ROOT/checkout-fail-tmp"
checkout_fail_observed="$TMP_ROOT/checkout-fail-observed"
checkout_fail_start="$TMP_ROOT/checkout-fail-start.sh"
checkout_fail_gate="$TMP_ROOT/checkout-fail-gate"
checkout_fail_release="$TMP_ROOT/checkout-fail-release"
checkout_fail_output_file="$TMP_ROOT/checkout-fail-output"
mkdir -p "$checkout_fail_tmp_parent"
cat > "$checkout_fail_start" <<'EOF'
#!/bin/bash
tmp_dir="$(find "$AIT_CHECKOUT_FAIL_TMP_PARENT" -mindepth 1 -maxdepth 1 -type d -name 'ait-update.*' -print -quit)"
if [ -f "$AIT_CHECKOUT_FAIL_LOCK/pid" ] && [ -f "$AIT_CHECKOUT_FAIL_LOCK/state" ] && [ -n "$tmp_dir" ]; then
  printf '%s\n' lock-held > "$AIT_CHECKOUT_FAIL_OBSERVED"
else
  printf '%s\n' lock-missing > "$AIT_CHECKOUT_FAIL_OBSERVED"
  exit 1
fi
printf '%s\n' entered > "$AIT_CHECKOUT_FAIL_GATE"
while [ ! -e "$AIT_CHECKOUT_FAIL_RELEASE" ]; do :; done
printf '%s\n' started > "$AIT_FIXTURE_STARTED"
EOF
chmod +x "$checkout_fail_start"
set +e
HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" TMPDIR="$checkout_fail_tmp_parent" AIT_FIXTURE_GIT_FAIL_CHECKOUT=1 AIT_FIXTURE_SERVICE_STATE=ready AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_LOCK="$checkout_fail_lock" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/checkout-fail-ait" AIT_INSTALL_ROOT="$checkout_fail_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" AIT_UPDATE_START_SCRIPT="$checkout_fail_start" AIT_UPDATE_STOP_SCRIPT="$stop_script" AIT_CHECKOUT_FAIL_LOCK="$checkout_fail_lock" AIT_CHECKOUT_FAIL_TMP_PARENT="$checkout_fail_tmp_parent" AIT_CHECKOUT_FAIL_OBSERVED="$checkout_fail_observed" AIT_CHECKOUT_FAIL_GATE="$checkout_fail_gate" AIT_CHECKOUT_FAIL_RELEASE="$checkout_fail_release" AIT_FIXTURE_STARTED="$TMP_ROOT/checkout-fail-started" AIT_FIXTURE_STOPPED="$TMP_ROOT/checkout-fail-stopped" "$REPO/bin/update.sh" "$checkout_fail_managed" >"$checkout_fail_output_file" 2>&1 &
checkout_fail_pid=$!
while [ ! -e "$checkout_fail_gate" ]; do
  kill -0 "$checkout_fail_pid" 2>/dev/null || { printf '%s\n' "$(cat "$checkout_fail_output_file" 2>/dev/null || true)" >&2; fail "TERM during real recovery" "update exited before recovery began"; }
done
kill -TERM "$checkout_fail_pid"
: > "$checkout_fail_release"
wait "$checkout_fail_pid"
checkout_fail_status=$?
checkout_fail_output="$(cat "$checkout_fail_output_file")"
set -e
assert_status 1 "$checkout_fail_status" "TERM during real recovery"
assert_contains "$checkout_fail_output" "Update checkout failed after stopping services" "TERM during real recovery"
[ -f "$TMP_ROOT/checkout-fail-started" ] || fail "TERM during real recovery" "ready state was not restored"
[ "$(cat "$checkout_fail_observed" 2>/dev/null || true)" = lock-held ] || fail "TERM during real recovery" "real recovery action did not observe the lock"
[ "$(git -C "$checkout_fail_managed" rev-parse HEAD)" = "7587d999c2cde133918166c4aeabbbfd8cb349cf" ] || fail "TERM during real recovery" "old checkout changed"
[ ! -d "$checkout_fail_lock" ] || fail "TERM during real recovery" "update lock was not cleaned"
[ -z "$(find "$checkout_fail_tmp_parent" -mindepth 1 -maxdepth 1 -type d -name 'ait-update.*' -print -quit)" ] || fail "TERM during real recovery" "temporary update directory was not cleaned"
[ -z "$(git -C "$checkout_fail_managed" for-each-ref --format='%(refname)' refs/ait-update/)" ] || fail "TERM during real recovery" "temporary update ref was not cleaned"
pass "TERM during real recovery keeps cleanup after lock-held restore"

race_source="$TMP_ROOT/race-source"
git clone -q "$origin" "$race_source"
git -C "$race_source" checkout -q --detach "$release_commit"
printf '0.1.1\n' > "$race_source/VERSION"
git -C "$race_source" config user.email fixture@example.test
git -C "$race_source" config user.name fixture
git -C "$race_source" add VERSION
git -C "$race_source" commit -q -m "race target"
race_commit="$(git -C "$race_source" rev-parse HEAD)"
git --git-dir="$origin" fetch -q "$race_source" "HEAD:refs/ait-race-target"
git --git-dir="$origin" tag v0.1.1 "$race_commit"
race_asset="$TMP_ROOT/race-install.sh"
sed -e "s/RELEASE_TAG=\"v0.1.0\"/RELEASE_TAG=\"v0.1.1\"/" \
    -e "s/RELEASE_COMMIT=\"$release_commit\"/RELEASE_COMMIT=\"$race_commit\"/" "$generated_asset" > "$race_asset"
chmod +x "$race_asset"
race_hash="$(shasum -a 256 "$race_asset" | awk '{print $1}')"
race_api="$TMP_ROOT/race-release.json"
printf '%s\n' "{\"tag_name\":\"v0.1.1\",\"html_url\":\"https://example.test/releases/v0.1.1\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"assets\":[{\"name\":\"install.sh\",\"browser_download_url\":\"file://$race_asset\",\"digest\":\"sha256:$race_hash\"}]}" > "$race_api"
race_b_source="$TMP_ROOT/race-b-source"
git clone -q "$origin" "$race_b_source"
git -C "$race_b_source" checkout -q --detach "$race_commit"
printf '0.1.2\n' > "$race_b_source/VERSION"
git -C "$race_b_source" config user.email fixture@example.test
git -C "$race_b_source" config user.name fixture
git -C "$race_b_source" add VERSION
git -C "$race_b_source" commit -q -m "race newer target"
race_b_commit="$(git -C "$race_b_source" rev-parse HEAD)"
git --git-dir="$origin" fetch -q "$race_b_source" "HEAD:refs/ait-race-target-b"
race_b_asset="$TMP_ROOT/race-b-install.sh"
sed -e "s/RELEASE_TAG=\"v0.1.0\"/RELEASE_TAG=\"v0.1.2\"/" \
    -e "s/RELEASE_COMMIT=\"$release_commit\"/RELEASE_COMMIT=\"$race_b_commit\"/" "$generated_asset" > "$race_b_asset"
chmod +x "$race_b_asset"
race_b_hash="$(shasum -a 256 "$race_b_asset" | awk '{print $1}')"
race_managed="$TMP_ROOT/race-managed"
prepare_old_fixture "$race_managed" "$TMP_ROOT/managed-cli/race-ait"
race_url="file://$race_api"
if ! git --git-dir="$origin" show-ref --verify --quiet refs/tags/v0.1.1; then fail "target appears after API" "response target A was not published before API response"; fi
if git --git-dir="$origin" show-ref --verify --quiet refs/tags/v0.1.2; then fail "target appears after API" "newer target B existed before API response"; fi
race_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_REAL_CURL="$real_curl" AIT_FIXTURE_API_RACE_URL="$race_url" AIT_FIXTURE_API_RACE_JSON="$race_api" AIT_FIXTURE_API_RACE_ORIGIN="$origin" AIT_FIXTURE_API_RACE_TAG=v0.1.2 AIT_FIXTURE_API_RACE_COMMIT="$race_b_commit" AIT_FIXTURE_SERVICE_STATE=stopped AIT_RELEASE_API_URL="$race_url" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/race-ait" AIT_INSTALL_ROOT="$race_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/bin/update.sh" "$race_managed" 2>&1)" || fail "target appears after API" "update failed: $race_output"
assert_contains "$race_output" "Updated AIT pre-release -> 0.1.1" "target appears after API"
[ "$(git -C "$race_managed" rev-parse HEAD)" = "$race_commit" ] || fail "target appears after API" "wrong target after API response"
git --git-dir="$origin" show-ref --verify --quiet refs/tags/v0.1.2 || fail "target appears after API" "newer target B was not published after API response"
[ "$(git --git-dir="$origin" show v0.1.2:VERSION)" = 0.1.2 ] || fail "target appears after API" "newer target B is invalid"
pass "newer release appearing after the API response is deferred while response target A installs"

set +e
foreign_cli_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/ait" AIT_INSTALL_ROOT="$managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/ait" update 2>&1)"
foreign_cli_status=$?
set -e
assert_status 1 "$foreign_cli_status" "foreign CLI refusal"
assert_contains "$foreign_cli_output" "executing AIT CLI belongs to another checkout" "foreign CLI refusal"
pass "development checkout CLI cannot update the managed checkout"

stopped_managed="$TMP_ROOT/stopped-managed"
git clone -q "$origin" "$stopped_managed"
git -C "$stopped_managed" checkout -q --detach 7587d999c2cde133918166c4aeabbbfd8cb349cf
for f in plc/.env pds/.env appview/.env mcp/.env; do mkdir -p "$stopped_managed/$(dirname "$f")"; printf '%s\n' "stopped-$f" > "$stopped_managed/$f"; done
mkdir -p "$stopped_managed/appview/dist" "$stopped_managed/mcp/dist" "$stopped_managed/appview/data"
printf old > "$stopped_managed/appview/dist/server.js"
printf old > "$stopped_managed/mcp/dist/server.js"
printf 'persistent-data-sentinel\n' > "$stopped_managed/appview/data/sentinel"
ln -s "$stopped_managed/ait" "$TMP_ROOT/managed-cli/stopped-ait"
matrix_root="$stopped_managed"
matrix_cli="$TMP_ROOT/managed-cli/stopped-ait"
MATRIX_TMP_PARENT="$TMP_ROOT/matrix-tmp"
run_matrix() {
  local -a env_args
  mkdir -p "$MATRIX_TMP_PARENT"
  env_args=("HOME=$source_home" "PATH=$fixture_bin:$ORIGINAL_PATH" "TMPDIR=$MATRIX_TMP_PARENT" "AIT_FIXTURE_SERVICE_STATE=${MATRIX_SERVICE_STATE:-stopped}" "AIT_RELEASE_API_URL=${MATRIX_API_URL:-file://$api}" "AIT_UPDATE_EXPECTED_ORIGIN=${MATRIX_ORIGIN:-$origin}" "AIT_UPDATE_CLI_LINK=$matrix_cli" "AIT_INSTALL_ROOT=$matrix_root" "AIT_UPDATE_STATUS_SCRIPT=$status_script")
  [ -z "${MATRIX_LOCK:-}" ] || env_args+=("AIT_UPDATE_LOCK=$MATRIX_LOCK")
  if [ -n "${MATRIX_NPM_FAIL:-}" ] || [ -n "${MATRIX_LEXICON_FAIL:-}" ]; then
    env_args+=("AIT_FIXTURE_PHASE_LOG=$TMP_ROOT/phase-log")
  fi
  [ -z "${MATRIX_NPM_FAIL:-}" ] || env_args+=("AIT_FIXTURE_NPM_FAIL=$MATRIX_NPM_FAIL")
  [ -z "${MATRIX_LEXICON_FAIL:-}" ] || env_args+=("AIT_FIXTURE_LEXICON_FAIL=$MATRIX_LEXICON_FAIL")
  env "${env_args[@]}" "$REPO/bin/update.sh" "$matrix_root"
}
expect_matrix() {
  local name="$1" needle="$2" output rc
  set +e
  output="$(run_matrix 2>&1)"
  rc=$?
  set -e
  assert_status 1 "$rc" "$name"
  assert_contains "$output" "$needle" "$name"
  if [ "${MATRIX_CLEANUP_EXPECTED:-0}" -eq 1 ]; then
    [ ! -d "$MATRIX_LOCK" ] || fail "$name" "update lock was not cleaned"
    [ -z "$(find "$MATRIX_TMP_PARENT" -mindepth 1 -maxdepth 1 -type d -name 'ait-update.*' -print -quit)" ] || fail "$name" "temporary update directory was not cleaned"
    [ -z "$(git -C "$matrix_root" for-each-ref --format='%(refname)' refs/ait-update/)" ] || fail "$name" "temporary update ref was not cleaned"
  fi
  pass "$name"
}

dependency_fail_managed="$TMP_ROOT/dependency-fail-managed"
prepare_old_fixture "$dependency_fail_managed" "$TMP_ROOT/managed-cli/dependency-fail-ait"
matrix_root="$dependency_fail_managed"
matrix_cli="$TMP_ROOT/managed-cli/dependency-fail-ait"
MATRIX_LOCK="$TMP_ROOT/dependency-fail.lock"
MATRIX_NPM_FAIL=1
MATRIX_CLEANUP_EXPECTED=1
expect_matrix "dependency-install failure after checkout" "failed phase: rebuild"
assert_contains "$(cat "$TMP_ROOT/phase-log" 2>/dev/null || true)" "dependency" "dependency-install failure after checkout"
unset MATRIX_NPM_FAIL MATRIX_LOCK MATRIX_CLEANUP_EXPECTED

build_fail_managed="$TMP_ROOT/build-fail-managed"
prepare_old_fixture "$build_fail_managed" "$TMP_ROOT/managed-cli/build-fail-ait"
matrix_root="$build_fail_managed"
matrix_cli="$TMP_ROOT/managed-cli/build-fail-ait"
MATRIX_LOCK="$TMP_ROOT/build-fail.lock"
MATRIX_NPM_FAIL=build
MATRIX_CLEANUP_EXPECTED=1
expect_matrix "stopped-state build failure cleans lock, temp, and ref" "failed phase: rebuild"
assert_contains "$(cat "$TMP_ROOT/phase-log" 2>/dev/null || true)" "build" "stopped-state build failure cleans lock, temp, and ref"
unset MATRIX_NPM_FAIL MATRIX_LOCK MATRIX_CLEANUP_EXPECTED

lexicon_fail_managed="$TMP_ROOT/lexicon-fail-managed"
prepare_old_fixture "$lexicon_fail_managed" "$TMP_ROOT/managed-cli/lexicon-fail-ait"
matrix_root="$lexicon_fail_managed"
matrix_cli="$TMP_ROOT/managed-cli/lexicon-fail-ait"
MATRIX_LOCK="$TMP_ROOT/lexicon-fail.lock"
MATRIX_LEXICON_FAIL=1
MATRIX_CLEANUP_EXPECTED=1
expect_matrix "lexicon failure after build" "failed phase: rebuild"
assert_contains "$(cat "$TMP_ROOT/phase-log" 2>/dev/null || true)" "lexicon" "lexicon failure after build"
unset MATRIX_LEXICON_FAIL MATRIX_LOCK MATRIX_CLEANUP_EXPECTED

signal_managed="$TMP_ROOT/signal-managed"
prepare_old_fixture "$signal_managed" "$TMP_ROOT/managed-cli/signal-ait"
signal_gate="$TMP_ROOT/signal-gate"
signal_release="$TMP_ROOT/signal-release"
signal_output_file="$TMP_ROOT/signal-output"
signal_lock="$TMP_ROOT/signal-lock"
signal_api_url="file://$api"
set +e
HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_NPM_GATE="$signal_gate" AIT_FIXTURE_NPM_RELEASE="$signal_release" AIT_FIXTURE_SERVICE_STATE=stopped AIT_RELEASE_API_URL="$signal_api_url" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_LOCK="$signal_lock" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/signal-ait" AIT_INSTALL_ROOT="$signal_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" AIT_FIXTURE_NPM_FAIL=0 "$REPO/bin/update.sh" "$signal_managed" >"$signal_output_file" 2>&1 &
signal_pid=$!
while [ ! -e "$signal_gate" ]; do
  kill -0 "$signal_pid" 2>/dev/null || { printf '%s\n' "$(cat "$signal_output_file" 2>/dev/null || true)" >&2; fail "TERM during rebuild" "update exited before the event gate"; }
done
signal_command="$(ps -p "$signal_pid" -o command= 2>/dev/null || true)"
case "$signal_command" in *"$REPO/bin/update.sh"*) ;; *) fail "TERM during rebuild" "background PID is not the isolated updater: $signal_command" ;; esac
kill -TERM "$signal_pid"
: > "$signal_release"
wait "$signal_pid"
signal_status=$?
set -e
assert_nonzero "$signal_status" "TERM during rebuild"
signal_output="$(cat "$signal_output_file")"
assert_contains "$signal_output" "failed phase: rebuild" "TERM during rebuild"
assert_contains "$signal_output" "RECOVERY REQUIRED" "TERM during rebuild"
case "$signal_output" in *"Do not reset"*) fail "TERM during rebuild" "printed post-AppView recovery" ;; esac
assert_contains "$signal_output" "reset --hard" "TERM during rebuild"
[ "$(git -C "$signal_managed" rev-parse HEAD)" = "$release_commit" ] || fail "TERM during rebuild" "target checkout was not retained"
[ ! -d "$signal_lock" ] || fail "TERM during rebuild" "update lock was not cleaned"
[ -z "$(git -C "$signal_managed" for-each-ref --format='%(refname)' refs/ait-update/)" ] || fail "TERM during rebuild" "temporary update ref was not cleaned"
pass "updater-directed TERM during rebuild leaves deterministic pre-AppView recovery, stopped services, and no lock/ref"

checkout_signal_managed="$TMP_ROOT/checkout-signal-managed"
prepare_old_fixture "$checkout_signal_managed" "$TMP_ROOT/managed-cli/checkout-signal-ait"
checkout_signal_gate="$TMP_ROOT/checkout-signal-gate"
checkout_signal_release="$TMP_ROOT/checkout-signal-release"
checkout_signal_output_file="$TMP_ROOT/checkout-signal-output"
checkout_signal_lock="$TMP_ROOT/checkout-signal-lock"
checkout_signal_start="$TMP_ROOT/checkout-signal-start.sh"
checkout_signal_tmp_parent="$TMP_ROOT/checkout-signal-tmp"
mkdir -p "$checkout_signal_tmp_parent"
cat > "$checkout_signal_start" <<'EOF'
#!/bin/bash
printf '%s\n' started > "$AIT_FIXTURE_STARTED"
EOF
chmod +x "$checkout_signal_start"
set +e
HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" TMPDIR="$checkout_signal_tmp_parent" AIT_FIXTURE_GIT_CHECKOUT_GATE="$checkout_signal_gate" AIT_FIXTURE_GIT_CHECKOUT_RELEASE="$checkout_signal_release" AIT_FIXTURE_SERVICE_STATE=stopped AIT_RELEASE_API_URL="$signal_api_url" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_LOCK="$checkout_signal_lock" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/checkout-signal-ait" AIT_INSTALL_ROOT="$checkout_signal_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" AIT_UPDATE_START_SCRIPT="$checkout_signal_start" AIT_UPDATE_STOP_SCRIPT="$stop_script" AIT_FIXTURE_STARTED="$TMP_ROOT/checkout-signal-started" AIT_FIXTURE_STOPPED="$TMP_ROOT/checkout-signal-stopped" "$REPO/bin/update.sh" "$checkout_signal_managed" >"$checkout_signal_output_file" 2>&1 &
checkout_signal_pid=$!
while [ ! -e "$checkout_signal_gate" ]; do
  kill -0 "$checkout_signal_pid" 2>/dev/null || { printf '%s\n' "$(cat "$checkout_signal_output_file" 2>/dev/null || true)" >&2; fail "TERM during checkout" "update exited before the checkout event gate"; }
done
kill -TERM "$checkout_signal_pid"
: > "$checkout_signal_release"
wait "$checkout_signal_pid"
checkout_signal_status=$?
set -e
assert_nonzero "$checkout_signal_status" "TERM during checkout"
checkout_signal_output="$(cat "$checkout_signal_output_file")"
assert_contains "$checkout_signal_output" "RECOVERY REQUIRED" "TERM during checkout"
assert_contains "$checkout_signal_output" "reset --hard" "TERM during checkout"
case "$checkout_signal_output" in *"Do not reset"*) fail "TERM during checkout" "printed post-AppView recovery" ;; esac
[ "$(git -C "$checkout_signal_managed" rev-parse HEAD)" = "$release_commit" ] || fail "TERM during checkout" "target checkout was not retained"
[ ! -e "$TMP_ROOT/checkout-signal-started" ] || fail "TERM during checkout" "old-ready restore ran on changed target"
[ ! -d "$checkout_signal_lock" ] || fail "TERM during checkout" "update lock was not cleaned"
[ -z "$(find "$checkout_signal_tmp_parent" -mindepth 1 -maxdepth 1 -type d -name 'ait-update.*' -print -quit)" ] || fail "TERM during checkout" "temporary update directory was not cleaned"
[ -z "$(git -C "$checkout_signal_managed" for-each-ref --format='%(refname)' refs/ait-update/)" ] || fail "TERM during checkout" "temporary update ref was not cleaned"
pass "checkout-child TERM reconciles the changed target and emits pre-AppView reset recovery"

stop_signal_managed="$TMP_ROOT/stop-signal-managed"
prepare_old_fixture "$stop_signal_managed" "$TMP_ROOT/managed-cli/stop-signal-ait"
stop_signal_gate="$TMP_ROOT/stop-signal-gate"
stop_signal_release="$TMP_ROOT/stop-signal-release"
stop_signal_state="$TMP_ROOT/stop-signal-state"
stop_signal_output_file="$TMP_ROOT/stop-signal-output"
stop_signal_lock="$TMP_ROOT/stop-signal-lock"
stop_signal_observed="$TMP_ROOT/stop-signal-observed"
stop_signal_tmp_parent="$TMP_ROOT/stop-signal-tmp"
stop_signal_start="$TMP_ROOT/stop-signal-start.sh"
stop_signal_stop="$TMP_ROOT/stop-signal-stop.sh"
mkdir -p "$stop_signal_tmp_parent"
cat > "$stop_signal_start" <<'EOF'
#!/bin/bash
tmp_dir="$(find "$AIT_STOP_SIGNAL_TMP_PARENT" -mindepth 1 -maxdepth 1 -type d -name 'ait-update.*' -print -quit)"
if [ -f "$AIT_STOP_SIGNAL_LOCK/pid" ] && [ -f "$AIT_STOP_SIGNAL_LOCK/state" ] && [ -n "$tmp_dir" ]; then
  printf '%s\n' lock-held > "$AIT_STOP_SIGNAL_OBSERVED"
else
  printf '%s\n' lock-missing > "$AIT_STOP_SIGNAL_OBSERVED"
  exit 1
fi
printf '%s\n' started > "$AIT_FIXTURE_STARTED"
EOF
cat > "$stop_signal_stop" <<'EOF'
#!/bin/bash
printf '%s\n' stopped > "$AIT_STOP_SIGNAL_STATE"
printf '%s\n' waiting > "$AIT_STOP_SIGNAL_GATE"
while [ ! -e "$AIT_STOP_SIGNAL_RELEASE" ]; do :; done
printf '%s\n' stopped > "$AIT_FIXTURE_STOPPED"
EOF
chmod +x "$stop_signal_start" "$stop_signal_stop"
set +e
HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" TMPDIR="$stop_signal_tmp_parent" AIT_FIXTURE_SERVICE_STATE=ready AIT_FIXTURE_SERVICE_STATE_FILE="$stop_signal_state" AIT_RELEASE_API_URL="$signal_api_url" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_LOCK="$stop_signal_lock" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/stop-signal-ait" AIT_INSTALL_ROOT="$stop_signal_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" AIT_UPDATE_START_SCRIPT="$stop_signal_start" AIT_UPDATE_STOP_SCRIPT="$stop_signal_stop" AIT_STOP_SIGNAL_STATE="$stop_signal_state" AIT_STOP_SIGNAL_GATE="$stop_signal_gate" AIT_STOP_SIGNAL_RELEASE="$stop_signal_release" AIT_STOP_SIGNAL_LOCK="$stop_signal_lock" AIT_STOP_SIGNAL_TMP_PARENT="$stop_signal_tmp_parent" AIT_STOP_SIGNAL_OBSERVED="$stop_signal_observed" AIT_FIXTURE_STARTED="$TMP_ROOT/stop-signal-started" AIT_FIXTURE_STOPPED="$TMP_ROOT/stop-signal-stopped" "$REPO/bin/update.sh" "$stop_signal_managed" >"$stop_signal_output_file" 2>&1 &
stop_signal_pid=$!
while [ ! -e "$stop_signal_gate" ]; do
  kill -0 "$stop_signal_pid" 2>/dev/null || { printf '%s\n' "$(cat "$stop_signal_output_file" 2>/dev/null || true)" >&2; fail "TERM during stop" "update exited before the stopped-state event gate"; }
done
kill -TERM "$stop_signal_pid"
: > "$stop_signal_release"
wait "$stop_signal_pid"
stop_signal_status=$?
set -e
assert_nonzero "$stop_signal_status" "TERM during stop"
stop_signal_output="$(cat "$stop_signal_output_file")"
assert_contains "$stop_signal_output" "Update checkout failed after stopping services" "TERM during stop"
assert_contains "$(cat "$stop_signal_observed" 2>/dev/null || true)" "lock-held" "TERM during stop"
[ "$(git -C "$stop_signal_managed" rev-parse HEAD)" = "7587d999c2cde133918166c4aeabbbfd8cb349cf" ] || fail "TERM during stop" "old checkout changed"
[ -f "$TMP_ROOT/stop-signal-started" ] || fail "TERM during stop" "real old-ready restore did not run"
[ ! -d "$stop_signal_lock" ] || fail "TERM during stop" "update lock was not cleaned"
[ -z "$(find "$stop_signal_tmp_parent" -mindepth 1 -maxdepth 1 -type d -name 'ait-update.*' -print -quit)" ] || fail "TERM during stop" "temporary update directory was not cleaned"
[ -z "$(git -C "$stop_signal_managed" for-each-ref --format='%(refname)' refs/ait-update/)" ] || fail "TERM during stop" "temporary update ref was not cleaned"
pass "stop-child TERM snapshots stopped services, restores old ready state under lock, and cleans lock/tmp/ref"

signal_pre_managed="$TMP_ROOT/signal-pre-managed"
prepare_old_fixture "$signal_pre_managed" "$TMP_ROOT/managed-cli/signal-pre-ait"
signal_pre_gate="$TMP_ROOT/signal-pre-gate"
signal_pre_release="$TMP_ROOT/signal-pre-release"
signal_pre_output_file="$TMP_ROOT/signal-pre-output"
signal_pre_lock="$TMP_ROOT/signal-pre-lock"
signal_pre_observed="$TMP_ROOT/signal-pre-observed"
signal_pre_tmp_parent="$TMP_ROOT/signal-pre-tmp"
signal_pre_start="$TMP_ROOT/signal-pre-start.sh"
signal_pre_stop="$TMP_ROOT/signal-pre-stop.sh"
signal_pre_stop_count="$TMP_ROOT/signal-pre-stop-count"
mkdir -p "$signal_pre_tmp_parent"
cat > "$signal_pre_start" <<'EOF'
#!/bin/bash
printf '%s\n' 'started appview (pid 123)'
printf '%s\n' waiting > "$AIT_SIGNAL_PRE_GATE"
while [ ! -e "$AIT_SIGNAL_PRE_RELEASE" ]; do :; done
printf '%s\n' started > "$AIT_FIXTURE_STARTED"
printf '%s\n' 'Services: ready'
EOF
cat > "$signal_pre_stop" <<'EOF'
#!/bin/bash
count=0
[ -f "$AIT_SIGNAL_PRE_STOP_COUNT" ] && count="$(cat "$AIT_SIGNAL_PRE_STOP_COUNT")"
count=$((count + 1))
printf '%s\n' "$count" > "$AIT_SIGNAL_PRE_STOP_COUNT"
if [ "$count" -ge 2 ]; then
  tmp_dir="$(find "$AIT_SIGNAL_PRE_TMP_PARENT" -mindepth 1 -maxdepth 1 -type d -name 'ait-update.*' -print -quit)"
  if [ -f "$AIT_SIGNAL_PRE_LOCK/pid" ] && [ -f "$AIT_SIGNAL_PRE_LOCK/state" ] && [ -n "$tmp_dir" ]; then
    printf '%s\n%s\n' lock-held "$tmp_dir" > "$AIT_SIGNAL_PRE_OBSERVED"
  else
    printf '%s\n' lock-missing > "$AIT_SIGNAL_PRE_OBSERVED"
    exit 1
  fi
fi
printf '%s\n' stopped > "$AIT_FIXTURE_STOPPED"
EOF
chmod +x "$signal_pre_start" "$signal_pre_stop"
set +e
HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" TMPDIR="$signal_pre_tmp_parent" AIT_FIXTURE_SERVICE_STATE=ready AIT_RELEASE_API_URL="$signal_api_url" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_LOCK="$signal_pre_lock" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/signal-pre-ait" AIT_INSTALL_ROOT="$signal_pre_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" AIT_UPDATE_START_SCRIPT="$signal_pre_start" AIT_UPDATE_STOP_SCRIPT="$signal_pre_stop" AIT_FIXTURE_STOPPED="$TMP_ROOT/signal-pre-stopped" AIT_FIXTURE_STARTED="$TMP_ROOT/signal-pre-started" AIT_SIGNAL_PRE_LOCK="$signal_pre_lock" AIT_SIGNAL_PRE_TMP_PARENT="$signal_pre_tmp_parent" AIT_SIGNAL_PRE_OBSERVED="$signal_pre_observed" AIT_SIGNAL_PRE_STOP_COUNT="$signal_pre_stop_count" AIT_SIGNAL_PRE_GATE="$signal_pre_gate" AIT_SIGNAL_PRE_RELEASE="$signal_pre_release" "$REPO/bin/update.sh" "$signal_pre_managed" >"$signal_pre_output_file" 2>&1 &
signal_pre_pid=$!
while [ ! -e "$signal_pre_gate" ]; do
  kill -0 "$signal_pre_pid" 2>/dev/null || { printf '%s\n' "$(cat "$signal_pre_output_file" 2>/dev/null || true)" >&2; fail "TERM during recovery" "update exited before the recovery event gate"; }
done
kill -TERM "$signal_pre_pid"
: > "$signal_pre_release"
wait "$signal_pre_pid"
signal_pre_status=$?
set -e
assert_nonzero "$signal_pre_status" "TERM during recovery"
signal_pre_output="$(cat "$signal_pre_output_file")"
assert_contains "$signal_pre_output" "RECOVERY REQUIRED" "TERM during recovery"
assert_contains "$signal_pre_output" "Do not reset; persisted data may have advanced" "TERM during recovery"
assert_contains "$(sed -n '1p' "$signal_pre_observed" 2>/dev/null || true)" "lock-held" "TERM during recovery"
[ -f "$TMP_ROOT/signal-pre-stopped" ] || fail "TERM during recovery" "real service recovery action did not run"
[ ! -d "$signal_pre_lock" ] || fail "TERM during recovery" "update lock was not cleaned"
[ -z "$(find "$signal_pre_tmp_parent" -mindepth 1 -maxdepth 1 -type d -name 'ait-update.*' -print -quit)" ] || fail "TERM during recovery" "temporary update directory was not cleaned"
[ -z "$(git -C "$signal_pre_managed" for-each-ref --format='%(refname)' refs/ait-update/)" ] || fail "TERM during recovery" "temporary update ref was not cleaned"
[ "$(git -C "$signal_pre_managed" rev-parse HEAD)" = "$release_commit" ] || fail "TERM during recovery" "target checkout was not retained"
pass "updater-directed TERM during AppView start keeps lock through fix-forward recovery and cleans lock/tmp/ref"

status_signal_managed="$TMP_ROOT/status-signal-managed"
prepare_old_fixture "$status_signal_managed" "$TMP_ROOT/managed-cli/status-signal-ait"
status_signal_gate="$TMP_ROOT/status-signal-gate"
status_signal_release="$TMP_ROOT/status-signal-release"
status_signal_output_file="$TMP_ROOT/status-signal-output"
status_signal_lock="$TMP_ROOT/status-signal-lock"
status_signal_tmp_parent="$TMP_ROOT/status-signal-tmp"
status_signal_status="$TMP_ROOT/status-signal-status.sh"
status_signal_count="$TMP_ROOT/status-signal-count"
mkdir -p "$status_signal_tmp_parent"
cat > "$status_signal_status" <<'EOF'
#!/bin/bash
count=0
[ -f "$AIT_STATUS_SIGNAL_COUNT" ] && count="$(cat "$AIT_STATUS_SIGNAL_COUNT")"
count=$((count + 1))
printf '%s\n' "$count" > "$AIT_STATUS_SIGNAL_COUNT"
if [ "$count" -eq 3 ]; then
  printf '%s\n' waiting > "$AIT_STATUS_SIGNAL_GATE"
  while [ ! -e "$AIT_STATUS_SIGNAL_RELEASE" ]; do :; done
fi
printf '%s\n' 'AIT status:' '  plc              running' '  pds              running' '  appview          running' '  codex-appserver  skipped (not installed)'
EOF
chmod +x "$status_signal_status"
set +e
HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" TMPDIR="$status_signal_tmp_parent" AIT_FIXTURE_SERVICE_STATE=ready AIT_RELEASE_API_URL="$signal_api_url" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_LOCK="$status_signal_lock" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/status-signal-ait" AIT_INSTALL_ROOT="$status_signal_managed" AIT_UPDATE_STATUS_SCRIPT="$status_signal_status" AIT_UPDATE_START_SCRIPT="$start_script" AIT_UPDATE_STOP_SCRIPT="$stop_script" AIT_STATUS_SIGNAL_COUNT="$status_signal_count" AIT_STATUS_SIGNAL_GATE="$status_signal_gate" AIT_STATUS_SIGNAL_RELEASE="$status_signal_release" AIT_FIXTURE_STOPPED="$TMP_ROOT/status-signal-stopped" AIT_FIXTURE_STARTED="$TMP_ROOT/status-signal-started" "$REPO/bin/update.sh" "$status_signal_managed" >"$status_signal_output_file" 2>&1 &
status_signal_pid=$!
while [ ! -e "$status_signal_gate" ]; do
  kill -0 "$status_signal_pid" 2>/dev/null || { printf '%s\n' "$(cat "$status_signal_output_file" 2>/dev/null || true)" >&2; fail "TERM during status" "update exited before the status event gate"; }
done
kill -TERM "$status_signal_pid"
: > "$status_signal_release"
wait "$status_signal_pid"
status_signal_exit=$?
set -e
assert_nonzero "$status_signal_exit" "TERM during status"
status_signal_output="$(cat "$status_signal_output_file")"
assert_contains "$status_signal_output" "RECOVERY REQUIRED" "TERM during status"
assert_contains "$status_signal_output" "Do not reset; persisted data may have advanced" "TERM during status"
[ "$(git -C "$status_signal_managed" rev-parse HEAD)" = "$release_commit" ] || fail "TERM during status" "target checkout was not retained"
[ -f "$TMP_ROOT/status-signal-stopped" ] || fail "TERM during status" "partially restored services were not stopped"
[ ! -d "$status_signal_lock" ] || fail "TERM during status" "update lock was not cleaned"
[ -z "$(find "$status_signal_tmp_parent" -mindepth 1 -maxdepth 1 -type d -name 'ait-update.*' -print -quit)" ] || fail "TERM during status" "temporary update directory was not cleaned"
[ -z "$(git -C "$status_signal_managed" for-each-ref --format='%(refname)' refs/ait-update/)" ] || fail "TERM during status" "temporary update ref was not cleaned"
pass "status-child TERM retains the target and emits post-AppView fix-forward recovery"

matrix_root="$stopped_managed"
matrix_cli="$TMP_ROOT/managed-cli/stopped-ait"
MATRIX_SERVICE_STATE=stopped
MATRIX_API_URL="file://$TMP_ROOT/missing-release.json"
expect_matrix "network/API failure refusal" "could not read the latest release"
MATRIX_API_URL="fixture://rate-limit"
RATE_LIMIT_URL="$MATRIX_API_URL"
set +e
rate_limit_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_RATE_LIMIT_URL="$RATE_LIMIT_URL" AIT_FIXTURE_SERVICE_STATE=stopped AIT_RELEASE_API_URL="$RATE_LIMIT_URL" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$matrix_cli" AIT_INSTALL_ROOT="$matrix_root" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/bin/update.sh" "$matrix_root" 2>&1)"
rate_limit_status=$?
set -e
assert_status 1 "$rate_limit_status" "rate-limit refusal"
assert_contains "$rate_limit_output" "could not read the latest release" "rate-limit refusal"
pass "rate-limit response uses the named network recovery"
printf '%s\n' not-json > "$TMP_ROOT/invalid-release.json"
MATRIX_API_URL="file://$TMP_ROOT/invalid-release.json"
expect_matrix "invalid JSON refusal" "immutable full SemVer"
printf '%s\n' "{\"tag_name\":\"v0.1.0\",\"draft\":true,\"prerelease\":false,\"immutable\":true,\"assets\":[]}" > "$TMP_ROOT/draft-release.json"
MATRIX_API_URL="file://$TMP_ROOT/draft-release.json"
expect_matrix "draft release refusal" "immutable full SemVer"
printf '%s\n' "{\"tag_name\":\"v0.1.0\",\"draft\":false,\"prerelease\":true,\"immutable\":true,\"assets\":[]}" > "$TMP_ROOT/prerelease-release.json"
MATRIX_API_URL="file://$TMP_ROOT/prerelease-release.json"
expect_matrix "prerelease refusal" "immutable full SemVer"
printf '%s\n' "{\"tag_name\":\"release-0.1\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"assets\":[]}" > "$TMP_ROOT/malformed-release.json"
MATRIX_API_URL="file://$TMP_ROOT/malformed-release.json"
expect_matrix "malformed version refusal" "immutable full SemVer"
missing_asset="$TMP_ROOT/missing-install.sh"
printf '#!/bin/bash\nRELEASE_TAG="v9.9.9"\nRELEASE_COMMIT="%s"\n' "$release_commit" > "$missing_asset"
missing_hash="$(shasum -a 256 "$missing_asset" | awk '{print $1}')"
printf '%s\n' "{\"tag_name\":\"v9.9.9\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"assets\":[{\"name\":\"install.sh\",\"browser_download_url\":\"file://$missing_asset\",\"digest\":\"sha256:$missing_hash\"}]}" > "$TMP_ROOT/missing-tag.json"
MATRIX_API_URL="file://$TMP_ROOT/missing-tag.json"
expect_matrix "missing tag refusal" "could not be fetched"

git --git-dir="$origin" tag v0.1.3 "$release_commit"
mismatch_asset="$TMP_ROOT/mismatch-install.sh"
printf '#!/bin/bash\nRELEASE_TAG="v0.1.3"\nRELEASE_COMMIT="%s"\n' "$release_commit" > "$mismatch_asset"
mismatch_hash="$(shasum -a 256 "$mismatch_asset" | awk '{print $1}')"
printf '%s\n' "{\"tag_name\":\"v0.1.3\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"assets\":[{\"name\":\"install.sh\",\"browser_download_url\":\"file://$mismatch_asset\",\"digest\":\"sha256:$mismatch_hash\"}]}" > "$TMP_ROOT/mismatch-release.json"
MATRIX_API_URL="file://$TMP_ROOT/mismatch-release.json"
expect_matrix "tag/version mismatch refusal" "release tag/version mismatch"

bad_version_source="$TMP_ROOT/bad-version-source"
git clone -q "$origin" "$bad_version_source"
git -C "$bad_version_source" checkout -q --detach 7587d999c2cde133918166c4aeabbbfd8cb349cf
printf 'not-a-semver\n' > "$bad_version_source/VERSION"
git -C "$bad_version_source" config user.email fixture@example.test
git -C "$bad_version_source" config user.name fixture
git -C "$bad_version_source" add VERSION
git -C "$bad_version_source" commit -q -m "malformed installed version"
bad_version_commit="$(git -C "$bad_version_source" rev-parse HEAD)"
git --git-dir="$origin" fetch -q "$bad_version_source" "HEAD:refs/ait-bad-installed"
bad_target_source="$TMP_ROOT/bad-target-source"
git clone -q "$origin" "$bad_target_source"
git -C "$bad_target_source" checkout -q --detach "$bad_version_commit"
printf '0.1.4\n' > "$bad_target_source/VERSION"
git -C "$bad_target_source" config user.email fixture@example.test
git -C "$bad_target_source" config user.name fixture
git -C "$bad_target_source" add VERSION
git -C "$bad_target_source" commit -q -m "malformed version target"
bad_target_commit="$(git -C "$bad_target_source" rev-parse HEAD)"
git --git-dir="$origin" fetch -q "$bad_target_source" "HEAD:refs/tags/v0.1.4"
bad_version_asset="$TMP_ROOT/bad-version-install.sh"
sed -e "s/RELEASE_TAG=\"v0.1.0\"/RELEASE_TAG=\"v0.1.4\"/" \
    -e "s/RELEASE_COMMIT=\"$release_commit\"/RELEASE_COMMIT=\"$bad_target_commit\"/" "$generated_asset" > "$bad_version_asset"
chmod +x "$bad_version_asset"
bad_version_hash="$(shasum -a 256 "$bad_version_asset" | awk '{print $1}')"
printf '%s\n' "{\"tag_name\":\"v0.1.4\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"assets\":[{\"name\":\"install.sh\",\"browser_download_url\":\"file://$bad_version_asset\",\"digest\":\"sha256:$bad_version_hash\"}]}" > "$TMP_ROOT/bad-version-release.json"
bad_version_managed="$TMP_ROOT/bad-version-managed"
prepare_old_fixture "$bad_version_managed" "$TMP_ROOT/managed-cli/bad-version-ait"
git -C "$bad_version_managed" checkout -q --detach "$bad_version_commit"
matrix_root="$bad_version_managed"
matrix_cli="$TMP_ROOT/managed-cli/bad-version-ait"
MATRIX_API_URL="file://$TMP_ROOT/bad-version-release.json"
expect_matrix "malformed installed VERSION refusal" "not newer"

div_source="$TMP_ROOT/divergent-source"
git init -q "$div_source"
git -C "$div_source" config user.email fixture@example.test
git -C "$div_source" config user.name fixture
printf '9.9.9\n' > "$div_source/VERSION"
git -C "$div_source" add VERSION
git -C "$div_source" commit -q -m divergent
div_commit="$(git -C "$div_source" rev-parse HEAD)"
git --git-dir="$origin" fetch -q "$div_source" "HEAD:refs/tags/v9.9.9"
div_asset="$TMP_ROOT/divergent-install.sh"
printf '#!/bin/bash\nRELEASE_TAG="v9.9.9"\nRELEASE_COMMIT="%s"\n' "$div_commit" > "$div_asset"
div_hash="$(shasum -a 256 "$div_asset" | awk '{print $1}')"
printf '%s\n' "{\"tag_name\":\"v9.9.9\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"assets\":[{\"name\":\"install.sh\",\"browser_download_url\":\"file://$div_asset\",\"digest\":\"sha256:$div_hash\"}]}" > "$TMP_ROOT/divergent-release.json"
MATRIX_API_URL="file://$TMP_ROOT/divergent-release.json"
expect_matrix "divergent target refusal" "diverges"

downgrade_source="$TMP_ROOT/downgrade-source"
git clone -q "$origin" "$downgrade_source"
git -C "$downgrade_source" checkout -q --detach "$release_commit"
printf '0.0.9\n' > "$downgrade_source/VERSION"
git -C "$downgrade_source" add VERSION
git -C "$downgrade_source" config user.email fixture@example.test
git -C "$downgrade_source" config user.name fixture
git -C "$downgrade_source" commit -q -m downgrade
downgrade_commit="$(git -C "$downgrade_source" rev-parse HEAD)"
git --git-dir="$origin" fetch -q "$downgrade_source" "HEAD:refs/tags/v0.0.9"
downgrade_asset="$TMP_ROOT/downgrade-install.sh"
printf '#!/bin/bash\nRELEASE_TAG="v0.0.9"\nRELEASE_COMMIT="%s"\n' "$downgrade_commit" > "$downgrade_asset"
downgrade_hash="$(shasum -a 256 "$downgrade_asset" | awk '{print $1}')"
printf '%s\n' "{\"tag_name\":\"v0.0.9\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"assets\":[{\"name\":\"install.sh\",\"browser_download_url\":\"file://$downgrade_asset\",\"digest\":\"sha256:$downgrade_hash\"}]}" > "$TMP_ROOT/downgrade-release.json"
matrix_root="$managed"
matrix_cli="$TMP_ROOT/managed-cli/ait"
MATRIX_SERVICE_STATE=ready
MATRIX_API_URL="file://$TMP_ROOT/downgrade-release.json"
expect_matrix "downgrade refusal" "not newer"
matrix_root="$stopped_managed"
matrix_cli="$TMP_ROOT/managed-cli/stopped-ait"
MATRIX_SERVICE_STATE=stopped
MATRIX_API_URL="file://$api"

matrix_root="$TMP_ROOT/no-such-managed"
expect_matrix "wrong managed path refusal" "managed checkout not found"
matrix_root="$stopped_managed"
foreign_matrix_cli="$TMP_ROOT/managed-cli/foreign-ait"
ln -s /foreign/ait "$foreign_matrix_cli"
matrix_cli="$foreign_matrix_cli"
expect_matrix "foreign CLI link refusal" "belongs to another checkout"
matrix_cli="$TMP_ROOT/managed-cli/stopped-ait"
MATRIX_ORIGIN="$TMP_ROOT/not-the-origin.git"
expect_matrix "wrong origin refusal" "not owned by the AIT release updater"
unset MATRIX_ORIGIN
MATRIX_SERVICE_STATE=partial
expect_matrix "partial service refusal" "unable to determine service state"
MATRIX_SERVICE_STATE=stopped
MATRIX_LOCK="$TMP_ROOT/live-lock"
mkdir -p "$MATRIX_LOCK"
printf '%s\n' "$$" > "$MATRIX_LOCK/pid"
printf '%s\n' live > "$MATRIX_LOCK/state"
expect_matrix "live update owner refusal" "another AIT update is running"
rm -f "$MATRIX_LOCK/pid" "$MATRIX_LOCK/state"
rmdir "$MATRIX_LOCK"
unset MATRIX_LOCK

printf '%s\n' "$release_commit" > "$stopped_managed/.git/CHERRY_PICK_HEAD"
set +e
git_operation_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_SERVICE_STATE=stopped AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/stopped-ait" AIT_INSTALL_ROOT="$stopped_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/bin/update.sh" "$stopped_managed" 2>&1)"
git_operation_status=$?
set -e
assert_status 1 "$git_operation_status" "Git operation refusal"
assert_contains "$git_operation_output" "CHERRY_PICK_HEAD" "Git operation refusal"
rm -f "$stopped_managed/.git/CHERRY_PICK_HEAD"
pass "all supported Git-operation markers fail closed"

set +e
active_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_ACTIVE=1 AIT_FIXTURE_SERVICE_STATE=stopped AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/stopped-ait" AIT_INSTALL_ROOT="$stopped_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/bin/update.sh" "$stopped_managed" 2>&1)"
active_status=$?
set -e
assert_status 1 "$active_status" "active-session update refusal"
assert_contains "$active_output" "active AIT session" "active-session update refusal"
[ "$(git -C "$stopped_managed" rev-parse HEAD)" = "7587d999c2cde133918166c4aeabbbfd8cb349cf" ] || fail "active-session update refusal" "checkout changed"
pass "active-session update is refused before mutation"

stale_lock="$TMP_ROOT/stale-lock"
mkdir -p "$stale_lock"
printf '%s\n' 999999 > "$stale_lock/pid"
printf '%s\n' stale > "$stale_lock/state"
set +e
stale_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_SERVICE_STATE=stopped AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_LOCK="$stale_lock" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/stopped-ait" AIT_INSTALL_ROOT="$stopped_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/bin/update.sh" "$stopped_managed" 2>&1)"
stale_status=$?
set -e
assert_status 1 "$stale_status" "stale-lock refusal"
assert_contains "$stale_output" "rm -f '$stale_lock/pid' '$stale_lock/state' && rmdir '$stale_lock'" "stale-lock refusal"
pass "stale lock fails closed with exact recovery"

recovery_managed="$TMP_ROOT/recovery-managed"
git clone -q "$origin" "$recovery_managed"
git -C "$recovery_managed" checkout -q --detach 7587d999c2cde133918166c4aeabbbfd8cb349cf
for f in plc/.env pds/.env appview/.env mcp/.env; do mkdir -p "$recovery_managed/$(dirname "$f")"; printf '%s\n' "recovery-$f" > "$recovery_managed/$f"; done
mkdir -p "$recovery_managed/appview/data"
printf '%s\n' persistent-data-sentinel > "$recovery_managed/appview/data/sentinel"
mkdir -p "$recovery_managed/appview/dist" "$recovery_managed/mcp/dist"
printf old > "$recovery_managed/appview/dist/server.js"
printf old > "$recovery_managed/mcp/dist/server.js"
ln -s "$recovery_managed/ait" "$TMP_ROOT/managed-cli/recovery-ait"
recovery_env_before="$(shasum -a 256 "$recovery_managed"/plc/.env "$recovery_managed"/pds/.env "$recovery_managed"/appview/.env "$recovery_managed"/mcp/.env | shasum -a 256 | awk '{print $1}')"
recovery_data_before="$(shasum -a 256 "$recovery_managed/appview/data/sentinel" | awk '{print $1}')"
recovery_managed_real="$(cd -P "$recovery_managed" && pwd)"
recovery_start="$TMP_ROOT/recovery-start.sh"
cat > "$recovery_start" <<'EOF'
#!/bin/bash
printf '%s\n' attempted > "$AIT_FIXTURE_RECOVERY_START"
exit 1
EOF
chmod +x "$recovery_start"
set +e
recovery_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_SERVICE_STATE=ready AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/recovery-ait" AIT_INSTALL_ROOT="$recovery_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" AIT_UPDATE_START_SCRIPT="$recovery_start" AIT_UPDATE_STOP_SCRIPT="$stop_script" AIT_FIXTURE_STOPPED="$TMP_ROOT/recovery-stopped" AIT_FIXTURE_RECOVERY_START="$TMP_ROOT/recovery-start-attempted" "$REPO/bin/update.sh" "$recovery_managed" 2>&1)"
recovery_status=$?
set -e
assert_status 1 "$recovery_status" "pre-AppView recovery"
assert_contains "$recovery_output" "RECOVERY REQUIRED" "pre-AppView recovery"
assert_contains "$recovery_output" "git -C '$recovery_managed_real' reset --hard '7587d999c2cde133918166c4aeabbbfd8cb349cf'" "pre-AppView recovery"
case "$recovery_output" in *Do\ not\ reset*) fail "pre-AppView recovery" "printed post-AppView recovery" ;; esac
[ -f "$TMP_ROOT/recovery-stopped" ] || fail "pre-AppView recovery" "ready services were not stopped"
[ -f "$TMP_ROOT/recovery-start-attempted" ] || fail "pre-AppView recovery" "service restore was not attempted"
[ "$recovery_env_before" = "$(shasum -a 256 "$recovery_managed"/plc/.env "$recovery_managed"/pds/.env "$recovery_managed"/appview/.env "$recovery_managed"/mcp/.env | shasum -a 256 | awk '{print $1}')" ] || fail "pre-AppView recovery" "environment bytes changed"
[ "$recovery_data_before" = "$(shasum -a 256 "$recovery_managed/appview/data/sentinel" | awk '{print $1}')" ] || fail "pre-AppView recovery" "persistent data changed"
[ "$(git -C "$recovery_managed" rev-parse HEAD)" = "$release_commit" ] || fail "pre-AppView recovery" "target checkout was not retained for recovery"
pass "pre-AppView failure preserves data and emits reset recovery"

git -C "$recovery_managed" reset --hard 7587d999c2cde133918166c4aeabbbfd8cb349cf >/dev/null
git -C "$recovery_managed" checkout -q "$release_commit" -- bin/install.sh
replay_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" "$recovery_managed/bin/install.sh" --rebuild-only 2>&1)" || fail "recovery replay" "printed recovery did not rebuild: $replay_output"
assert_contains "$replay_output" "Rebuild: complete" "recovery replay"
git -C "$recovery_managed" reset --hard 7587d999c2cde133918166c4aeabbbfd8cb349cf >/dev/null
[ "$(git -C "$recovery_managed" rev-parse HEAD)" = "7587d999c2cde133918166c4aeabbbfd8cb349cf" ] || fail "recovery replay" "old revision was not restored"
[ "$recovery_data_before" = "$(shasum -a 256 "$recovery_managed/appview/data/sentinel" | awk '{print $1}')" ] || fail "recovery replay" "persistent data changed"
pass "printed pre-AppView recovery replays to the old build with data intact"

post_managed="$TMP_ROOT/post-managed"
git clone -q "$origin" "$post_managed"
git -C "$post_managed" checkout -q --detach 7587d999c2cde133918166c4aeabbbfd8cb349cf
for f in plc/.env pds/.env appview/.env mcp/.env; do mkdir -p "$post_managed/$(dirname "$f")"; printf '%s\n' "post-$f" > "$post_managed/$f"; done
mkdir -p "$post_managed/appview/data" "$post_managed/appview/dist" "$post_managed/mcp/dist"
printf '%s\n' post-appview-sentinel > "$post_managed/appview/data/sentinel"
printf old > "$post_managed/appview/dist/server.js"
printf old > "$post_managed/mcp/dist/server.js"
ln -s "$post_managed/ait" "$TMP_ROOT/managed-cli/post-ait"
post_data_before="$(shasum -a 256 "$post_managed/appview/data/sentinel" | awk '{print $1}')"
post_start="$TMP_ROOT/post-start.sh"
cat > "$post_start" <<'EOF'
#!/bin/bash
printf '%s\n' 'started appview (pid 456)' 'later health failed'
exit 1
EOF
chmod +x "$post_start"
set +e
post_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_SERVICE_STATE=ready AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/post-ait" AIT_INSTALL_ROOT="$post_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" AIT_UPDATE_START_SCRIPT="$post_start" AIT_UPDATE_STOP_SCRIPT="$stop_script" AIT_FIXTURE_STOPPED="$TMP_ROOT/post-stopped" "$REPO/bin/update.sh" "$post_managed" 2>&1)"
post_status=$?
set -e
assert_status 1 "$post_status" "post-AppView recovery"
assert_contains "$post_output" "Do not reset; persisted data may have advanced" "post-AppView recovery"
assert_contains "$post_output" "stopping the partially restored service set" "post-AppView recovery"
case "$post_output" in *reset\ --hard*) fail "post-AppView recovery" "printed reset recovery" ;; esac
[ -f "$TMP_ROOT/post-stopped" ] || fail "post-AppView recovery" "partially restored services were not stopped"
[ "$post_data_before" = "$(shasum -a 256 "$post_managed/appview/data/sentinel" | awk '{print $1}')" ] || fail "post-AppView recovery" "persistent data changed"
[ "$(git -C "$post_managed" rev-parse HEAD)" = "$release_commit" ] || fail "post-AppView recovery" "target checkout was not retained"
pass "post-AppView failure stops services and emits fix-forward recovery"

stopped_env_before="$(shasum -a 256 "$stopped_managed"/plc/.env "$stopped_managed"/pds/.env "$stopped_managed"/appview/.env "$stopped_managed"/mcp/.env | shasum -a 256 | awk '{print $1}')"
stopped_links_before="$(readlink "$source_home/.claude/skills/delivery-coordination")|$(readlink "$source_home/.agents/skills/delivery-coordination")"
stopped_data_before="$(shasum -a 256 "$stopped_managed/appview/data/sentinel" | awk '{print $1}')"
stopped_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_SERVICE_STATE=stopped AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/stopped-ait" AIT_INSTALL_ROOT="$stopped_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" AIT_UPDATE_START_SCRIPT="$TMP_ROOT/must-not-start" AIT_UPDATE_STOP_SCRIPT="$TMP_ROOT/must-not-stop" "$REPO/bin/update.sh" "$stopped_managed" 2>&1)" || fail "stopped update" "update failed: $stopped_output"
assert_contains "$stopped_output" "Services   stopped" "stopped update"
[ ! -e "$TMP_ROOT/must-not-start" ] || fail "stopped update" "start script was called"
[ "$(git -C "$stopped_managed" rev-parse HEAD)" = "$release_commit" ] || fail "stopped update" "wrong stopped target commit"
stopped_env_after="$(shasum -a 256 "$stopped_managed"/plc/.env "$stopped_managed"/pds/.env "$stopped_managed"/appview/.env "$stopped_managed"/mcp/.env | shasum -a 256 | awk '{print $1}')"
[ "$stopped_env_before" = "$stopped_env_after" ] || fail "stopped update" "environment bytes changed"
[ "$stopped_links_before" = "$(readlink "$source_home/.claude/skills/delivery-coordination")|$(readlink "$source_home/.agents/skills/delivery-coordination")" ] || fail "stopped update" "skill links changed"
[ "$stopped_data_before" = "$(shasum -a 256 "$stopped_managed/appview/data/sentinel" | awk '{print $1}')" ] || fail "stopped update" "persistent data changed"
pass "stopped-state update preserves env, skill links, data, and the stopped verdict"

dirty_file="$managed/fixture-dirty"
printf dirty > "$dirty_file"
set +e
dirty_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/ait" AIT_INSTALL_ROOT="$managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/bin/update.sh" "$managed" 2>&1)"
dirty_status=$?
set -e
assert_status 1 "$dirty_status" "dirty checkout refusal"
assert_contains "$dirty_output" "dirty" "dirty checkout refusal"
rm -f "$dirty_file"
pass "dirty checkout refusal"

digest_before="$(git -C "$stopped_managed" rev-parse HEAD)"
asset_hash_bad="$(printf bad | shasum -a 256 | awk '{print $1}')"
printf '%s\n' "{\"tag_name\":\"v0.1.0\",\"draft\":false,\"prerelease\":false,\"immutable\":true,\"assets\":[{\"name\":\"install.sh\",\"browser_download_url\":\"file://$asset\",\"digest\":\"sha256:$asset_hash_bad\"}]}" > "$api"
set +e
digest_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_FIXTURE_SERVICE_STATE=stopped AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/stopped-ait" AIT_INSTALL_ROOT="$stopped_managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/bin/update.sh" "$stopped_managed" 2>&1)"
digest_status=$?
set -e
assert_status 1 "$digest_status" "asset digest refusal"
assert_contains "$digest_output" "digest mismatch" "asset digest refusal"
[ "$(git -C "$stopped_managed" rev-parse HEAD)" = "$digest_before" ] || fail "asset digest refusal" "checkout changed"
pass "installer digest refusal without mutation"

printf '%s\n' "{\"tag_name\":\"v0.1.0\",\"draft\":false,\"prerelease\":false,\"immutable\":false,\"assets\":[]}" > "$api"
set +e
bad_output="$(HOME="$source_home" PATH="$fixture_bin:$ORIGINAL_PATH" AIT_RELEASE_API_URL="file://$api" AIT_UPDATE_EXPECTED_ORIGIN="$origin" AIT_UPDATE_CLI_LINK="$TMP_ROOT/managed-cli/ait" AIT_INSTALL_ROOT="$managed" AIT_UPDATE_STATUS_SCRIPT="$status_script" "$REPO/bin/update.sh" "$managed" 2>&1)"
bad_status=$?
set -e
assert_status 1 "$bad_status" "mutable release refusal"
assert_contains "$bad_output" "immutable" "mutable release refusal"
pass "mutable release refusal without mutation"

echo "AIT update test suite passed ($PASS_COUNT named cases)"
