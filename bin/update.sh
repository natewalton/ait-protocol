#!/bin/bash
# Update one installer-owned checkout to one immutable GitHub release.
set -euo pipefail

MANAGED="${1:-${AIT_INSTALL_ROOT:-$HOME/.local/share/ait-protocol}}"
API_URL="${AIT_RELEASE_API_URL:-https://api.github.com/repos/natewalton/ait-protocol/releases/latest}"
EXPECTED_ORIGIN="${AIT_UPDATE_EXPECTED_ORIGIN:-https://github.com/natewalton/ait-protocol}"
LOCK="${AIT_UPDATE_LOCK:-${XDG_STATE_HOME:-$HOME/.local/state}/ait-protocol/update.lock}"
LOG_DIR="${AIT_LOG_DIR:-/tmp}"
STATUS_SCRIPT="${AIT_UPDATE_STATUS_SCRIPT:-$MANAGED/bin/status.sh}"
START_SCRIPT="${AIT_UPDATE_START_SCRIPT:-$MANAGED/bin/start-all.sh}"
STOP_SCRIPT="${AIT_UPDATE_STOP_SCRIPT:-$MANAGED/bin/stop-all.sh}"
CLI_LINK="${AIT_UPDATE_CLI_LINK:-${AIT_CLI_LINK:-}}"
EXECUTABLE="${AIT_UPDATE_EXECUTABLE:-}"
RELEASE_PAGE="https://github.com/natewalton/ait-protocol/releases/latest"
PHASE="preflight"
OLD_COMMIT=""
OLD_VERSION=""
TARGET_VERSION=""
TARGET_COMMIT=""
TARGET_TAG=""
TARGET_URL=""
TARGET_DIGEST=""
FETCH_REF=""
LOCK_OWNED=0
CHECKED_OUT=0
CHECKOUT_ATTEMPTED=0
APPVIEW_READY=0
WAS_READY=0
INITIAL_READY=0
STOPPED=0
TMP_DIR=""
DONE=0

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}

cleanup() {
  [ -z "$FETCH_REF" ] || git -C "$MANAGED" update-ref -d "$FETCH_REF" >/dev/null 2>&1 || true
  if [ "$LOCK_OWNED" -eq 1 ]; then
    rm -f "$LOCK/pid" "$LOCK/state" 2>/dev/null || true
    rmdir "$LOCK" 2>/dev/null || true
  fi
  [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"
}

recovery() {
  if [ "$STOPPED" -eq 1 ] && [ "$CHECKED_OUT" -eq 0 ] && [ "$WAS_READY" -eq 1 ]; then
    echo "Update checkout failed after stopping services; restoring the previous ready state." >&2
    if ! "$START_SCRIPT" >/dev/null 2>&1; then
      echo "  recovery: the previous service state could not be restored automatically; run ait start" >&2
    fi
    return 0
  fi
  [ "$CHECKED_OUT" -eq 1 ] || return 0
  echo "RECOVERY REQUIRED" >&2
  echo "  old: ${OLD_VERSION:-pre-release} $OLD_COMMIT" >&2
  echo "  target: $TARGET_VERSION $TARGET_COMMIT" >&2
  echo "  failed phase: $PHASE" >&2
  echo "  logs: $LOG_DIR/ait-{plc,pds,appview,codex-appserver}.{log,err}" >&2
  if [ "$APPVIEW_READY" -eq 1 ]; then
    echo "  recovery: stopping the partially restored service set" >&2
    if ! "$STOP_SCRIPT" >/dev/null 2>&1; then
      echo "  recovery: could not stop the partially restored service set; run ait stop before repairs" >&2
    fi
    echo "  Do not reset; persisted data may have advanced." >&2
    echo "  recovery: preserve the logs and fix forward with a higher patch release." >&2
  else
    echo "  recovery: reset to the old checkout only after verifying AppView never started:" >&2
    echo "    git -C '$MANAGED' reset --hard '$OLD_COMMIT'" >&2
    echo "    '$MANAGED/bin/install.sh' --rebuild-only" >&2
    [ "$WAS_READY" -eq 1 ] && echo "    ait start" >&2
  fi
}

reconcile_state() {
  local current dirty start_log status_output running
  if [ "$CHECKOUT_ATTEMPTED" -eq 1 ] && [ "$CHECKED_OUT" -eq 0 ] && [ -n "$TARGET_COMMIT" ]; then
    current="$(git -C "$MANAGED" rev-parse HEAD 2>/dev/null || true)"
    dirty="$(git -C "$MANAGED" status --porcelain 2>/dev/null || true)"
    if [ "$current" != "$OLD_COMMIT" ] || [ -n "$dirty" ]; then CHECKED_OUT=1; fi
  fi
  if [ "$LOCK_OWNED" -eq 1 ] && [ "$PHASE" = "service stop" ] && [ "$INITIAL_READY" -eq 1 ] && [ "$STOPPED" -eq 0 ]; then
    status_output="$("$STATUS_SCRIPT" 2>&1 || true)"
    running="$(printf '%s\n' "$status_output" | awk '$1=="plc"||$1=="pds"||$1=="appview" {if ($2=="running") n++} END {print n+0}')"
    [ "$running" -eq 3 ] || STOPPED=1
  fi
  if [ "$APPVIEW_READY" -eq 0 ] && [ -n "$TMP_DIR" ]; then
    start_log="$TMP_DIR/start.log"
    if [ -f "$start_log" ] && grep -Eq 'started appview|appview (started|already running)|Services: ready' "$start_log"; then
      APPVIEW_READY=1
    fi
  fi
}

on_exit() {
  local rc=$?
  trap - EXIT
  trap ':' INT TERM
  reconcile_state
  if [ "$rc" -ne 0 ] && [ "$DONE" -eq 0 ]; then recovery || true; fi
  cleanup
  exit "$rc"
}
on_signal() {
  trap - EXIT
  trap ':' INT TERM
  reconcile_state
  if [ "$DONE" -eq 0 ]; then recovery || true; fi
  cleanup
  exit 143
}
trap on_exit EXIT
trap on_signal INT TERM

fail() { echo "error: $*" >&2; exit 1; }

parse_release() {
  local json="$1"
  node - "$json" <<'NODE'
const fs = require('fs');
let release;
try { release = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch (e) { process.exit(2); }
const tag = release.tag_name || '';
const stable = /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag);
if (!stable || release.draft !== false || release.prerelease !== false || release.immutable !== true) process.exit(3);
const asset = (release.assets || []).find(a => a.name === 'install.sh');
if (!asset || !/^sha256:[0-9a-f]{64}$/.test(asset.digest || '') || !asset.browser_download_url) process.exit(4);
process.stdout.write([tag, tag.slice(1), asset.browser_download_url, asset.digest.slice(7), release.html_url || ''].join('\t'));
NODE
}

resolve_path() {
  local source="$1" dir target depth=0
  local -a seen=()
  while [ -L "$source" ]; do
    depth=$((depth + 1))
    [ "$depth" -le 40 ] || return 1
    for target in "${seen[@]-}"; do [ "$target" = "$source" ] && return 1; done
    seen+=("$source")
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    target="$(readlink "$source")"
    case "$target" in
      /*) source="$target" ;;
      *) source="$dir/$target" ;;
    esac
  done
  if [ -e "$source" ]; then
    cd -P "$(dirname "$source")" && printf '%s/%s' "$(pwd)" "$(basename "$source")"
  else
    printf '%s' "$source"
  fi
}

check_git_state() {
  local marker git_dir
  git_dir="$(git -C "$MANAGED" rev-parse --git-dir)" || fail "unable to inspect Git state"
  case "$git_dir" in /*) ;; *) git_dir="$MANAGED/$git_dir" ;; esac
  for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
    [ ! -e "$git_dir/$marker" ] || fail "a Git operation is in progress ($marker)"
  done
  [ ! -d "$git_dir/rebase-merge" ] || fail "a Git operation is in progress (rebase)"
  [ ! -d "$git_dir/rebase-apply" ] || fail "a Git operation is in progress (rebase)"
  [ ! -d "$git_dir/sequencer" ] || fail "a Git operation is in progress (sequencer)"
}

check_cli_ownership() {
  local candidate resolved executable_resolved found=0
  if [ -n "$CLI_LINK" ]; then
    candidate="$CLI_LINK"
    found=1
  else
    for candidate in "$HOME/.local/bin/ait" /opt/homebrew/bin/ait /usr/local/bin/ait; do
      if [ -e "$candidate" ] || [ -L "$candidate" ]; then found=1; break; fi
    done
  fi
  [ "$found" -eq 1 ] || fail "managed CLI link was not found; run the AIT installer before updating"
  [ -L "$candidate" ] || fail "CLI target is not an installer-owned symlink: $candidate"
  resolved="$(resolve_path "$candidate")" || fail "CLI link is cyclic or unresolved: $candidate"
  [ "$resolved" = "$MANAGED/ait" ] || fail "CLI link $candidate belongs to another checkout ($resolved)"
  if [ -n "$EXECUTABLE" ]; then
    executable_resolved="$(resolve_path "$EXECUTABLE")" || fail "executing AIT CLI is cyclic or unresolved: $EXECUTABLE"
    [ "$executable_resolved" = "$MANAGED/ait" ] || fail "executing AIT CLI belongs to another checkout ($executable_resolved)"
  fi
}

verify_target() {
  local target_version_file resolved
  resolved="$(git -C "$MANAGED" rev-parse "$FETCH_REF^{commit}")" || fail "release tag did not resolve to one commit"
  [ "$resolved" = "$TARGET_COMMIT" ] || fail "verified release ref moved from $TARGET_COMMIT to $resolved"
  target_version_file="$(git -C "$MANAGED" show "$FETCH_REF:VERSION" 2>/dev/null || true)"
  [ "$(printf '%s' "$target_version_file" | tr -d '[:space:]')" = "$TARGET_VERSION" ] || fail "release tag/version mismatch"
  git -C "$MANAGED" merge-base --is-ancestor "$OLD_COMMIT" "$TARGET_COMMIT" || fail "release $TARGET_TAG diverges from the installed checkout"
}

verify_asset_identity() {
  local tag_count commit_count embedded_tag embedded_commit
  tag_count="$(grep -Ec '^RELEASE_TAG="v[0-9]+\.[0-9]+\.[0-9]+"$' "$1" || true)"
  commit_count="$(grep -Ec '^RELEASE_COMMIT="[0-9a-f]{40}"$' "$1" || true)"
  [ "$tag_count" -eq 1 ] || fail "release installer must bind exactly one full SemVer tag assignment"
  [ "$commit_count" -eq 1 ] || fail "release installer must bind exactly one full commit assignment"
  embedded_tag="$(sed -n 's/^RELEASE_TAG="\([^"]*\)"$/\1/p' "$1")"
  embedded_commit="$(sed -n 's/^RELEASE_COMMIT="\([^"]*\)"$/\1/p' "$1")"
  [ "$embedded_tag" = "$TARGET_TAG" ] || fail "release installer binds $embedded_tag, expected $TARGET_TAG"
  TARGET_COMMIT="$embedded_commit"
}

service_state() {
  local output rc core_running core_down codex_line
  output="$("$STATUS_SCRIPT" 2>&1)" || rc=$?
  rc="${rc:-0}"
  core_running="$(printf '%s\n' "$output" | awk '$1=="plc"||$1=="pds"||$1=="appview" {if ($2=="running") n++} END {print n+0}')"
  core_down="$(printf '%s\n' "$output" | awk '$1=="plc"||$1=="pds"||$1=="appview" {if ($2=="unreachable") n++} END {print n+0}')"
  codex_line="$(printf '%s\n' "$output" | awk '$1=="codex-appserver" {print $2}')"
  if [ "$core_running" -eq 3 ] && { [ -z "$codex_line" ] || [ "$codex_line" = running ] || [ "$codex_line" = skipped ]; }; then
    WAS_READY=1
    return 0
  fi
  if [ "$core_down" -eq 3 ] && { [ -z "$codex_line" ] || [ "$codex_line" = unreachable ] || [ "$codex_line" = skipped ]; }; then
    WAS_READY=0
    return 0
  fi
  [ "$rc" -eq 0 ] && fail "service set is partial or has an unknown status"
  if [ "$core_running" -gt 0 ] || [ "$core_down" -gt 0 ]; then fail "service set is partial or unhealthy; run ait stop"; fi
  fail "unable to determine service state"
}

snapshot() {
  local target
  for target in "$MANAGED/plc/.env" "$MANAGED/pds/.env" "$MANAGED/appview/.env" "$MANAGED/mcp/.env"; do
    [ -f "$target" ] || fail "required environment file is missing: $target"
    printf 'env\t%s\t%s\n' "$target" "$(sha256 "$target")"
  done
  for target in "$HOME/.claude/skills/delivery-coordination" "$HOME/.agents/skills/delivery-coordination"; do
    if [ -L "$target" ]; then printf 'skill\t%s\t%s\n' "$target" "$(readlink "$target")"; fi
  done
}

acquire_lock() {
  local pid=""
  mkdir -p "$(dirname "$LOCK")"
  if ! mkdir "$LOCK" 2>/dev/null; then
    pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      fail "another AIT update is running (pid $pid)"
    fi
    echo "error: stale AIT update lock at $LOCK (pid ${pid:-unknown})" >&2
    echo "  recovery: rm -f '$LOCK/pid' '$LOCK/state' && rmdir '$LOCK', then rerun ait update" >&2
    exit 1
  fi
  LOCK_OWNED=1
  printf '%s\n' "$$" > "$LOCK/pid"
  printf '%s\n' "$OLD_COMMIT" > "$LOCK/state"
}

check_sessions() {
  local sessions
  sessions="$(pgrep -f "$MANAGED/mcp/dist/server.js" 2>/dev/null || true)"
  [ -z "$sessions" ] || fail "active AIT session process(es) use this checkout: $sessions; exit every harness session and retry"
}

main() {
  local api_file release_fields asset_file asset_hash
  [ -d "$MANAGED/.git" ] || fail "managed checkout not found: $MANAGED"
  MANAGED="$(cd -P "$MANAGED" && pwd)"
  [ "$(git -C "$MANAGED" remote get-url origin 2>/dev/null || true)" = "$EXPECTED_ORIGIN" ] ||
    [ "$(git -C "$MANAGED" remote get-url origin 2>/dev/null || true)" = "$EXPECTED_ORIGIN.git" ] ||
    fail "managed checkout is not owned by the AIT release updater"
  [ "$(git -C "$MANAGED" rev-parse --show-toplevel)" = "$MANAGED" ] || fail "managed checkout path is not canonical: $MANAGED"
  check_cli_ownership
  [ -z "$(git -C "$MANAGED" status --porcelain)" ] || fail "managed checkout is dirty; commit or discard changes before updating"
  check_git_state
  OLD_COMMIT="$(git -C "$MANAGED" rev-parse HEAD)"
  OLD_VERSION=""
  [ -f "$MANAGED/VERSION" ] && OLD_VERSION="$(tr -d '[:space:]' < "$MANAGED/VERSION")"
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ait-update.XXXXXX")"
  api_file="$TMP_DIR/release.json"
  PHASE="release lookup"
  curl -fsSL -H 'X-GitHub-Api-Version: 2026-03-10' "$API_URL" > "$api_file" || fail "could not read the latest release; see $RELEASE_PAGE and retry"
  release_fields="$(parse_release "$api_file")" || fail "latest release is not one immutable full SemVer release with a verified installer asset"
  IFS=$'\t' read -r TARGET_TAG TARGET_VERSION TARGET_URL TARGET_DIGEST RELEASE_PAGE <<< "$release_fields"
  asset_file="$TMP_DIR/install.sh"
  PHASE="release asset verification"
  curl -fsSL "$TARGET_URL" > "$asset_file" || fail "could not download the release installer asset; see $RELEASE_PAGE and retry"
  asset_hash="$(sha256 "$asset_file")"
  [ "$asset_hash" = "$TARGET_DIGEST" ] || fail "release installer digest mismatch: expected $TARGET_DIGEST, got $asset_hash"
  verify_asset_identity "$asset_file"

  if [ "$TARGET_COMMIT" = "$OLD_COMMIT" ]; then
    echo "AIT is already up to date at $TARGET_TAG ($TARGET_COMMIT)"
    DONE=1
    exit 0
  fi
  service_state
  INITIAL_READY="$WAS_READY"
  FETCH_REF="refs/ait-update/${BASHPID:-$$}"
  PHASE="exact tag fetch"
  git -C "$MANAGED" fetch -q --no-tags origin "refs/tags/$TARGET_TAG:$FETCH_REF" || fail "release tag $TARGET_TAG could not be fetched from the verified origin"
  verify_target
  if [ -n "$OLD_VERSION" ]; then
    if [ "$OLD_VERSION" = "$TARGET_VERSION" ]; then fail "release $TARGET_TAG changes the commit without increasing VERSION"; fi
    node - "$OLD_VERSION" "$TARGET_VERSION" <<'NODE' || fail "release $TARGET_TAG is not newer than installed version"
function v(s) { const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/); return m && [+m[1],+m[2],+m[3],m[4]||'']; }
const a=v(process.argv[2]), b=v(process.argv[3]);
if (!a || !b || (b[0]<a[0] || b[0]===a[0] && (b[1]<a[1] || b[1]===a[1] && b[2]<=a[2]))) process.exit(1);
NODE
  fi

  PHASE="locked preflight"
  acquire_lock
  [ -z "$(git -C "$MANAGED" status --porcelain)" ] || fail "managed checkout became dirty before update"
  [ "$(git -C "$MANAGED" rev-parse HEAD)" = "$OLD_COMMIT" ] || fail "installed checkout changed before update"
  check_git_state
  verify_target
  check_sessions
  service_state
  [ "$WAS_READY" -eq "$INITIAL_READY" ] || fail "service state changed before the update lock was acquired"
  snapshot > "$TMP_DIR/before-state"
  PHASE="service stop"
  if [ "$WAS_READY" -eq 1 ]; then
    "$STOP_SCRIPT" > "$TMP_DIR/stop.log" 2>&1 || fail "could not stop the ready AIT service set"
    STOPPED=1
  fi
  PHASE="checkout"
  CHECKOUT_ATTEMPTED=1
  git -C "$MANAGED" checkout -q --detach "$TARGET_COMMIT" || fail "could not check out verified release $TARGET_TAG"
  CHECKED_OUT=1
  PHASE="rebuild"
  "$MANAGED/bin/install.sh" --rebuild-only || fail "target rebuild failed"
  if [ "$WAS_READY" -eq 1 ]; then
    PHASE="service restore"
    start_log="$TMP_DIR/start.log"
    if ! "$START_SCRIPT" > "$start_log" 2>&1; then
      restore_output="$(cat "$start_log")"
      grep -Eq 'started appview|appview (started|already running)|Services: ready' "$start_log" && APPVIEW_READY=1
      printf '%s\n' "$restore_output" >&2
      fail "updated services did not become ready"
    fi
    restore_output="$(cat "$start_log")"
    printf '%s\n' "$restore_output"
    APPVIEW_READY=1
    service_state
  fi
  PHASE="state verification"
  snapshot > "$TMP_DIR/after-state"
  cmp -s "$TMP_DIR/before-state" "$TMP_DIR/after-state" || fail "environment or skill-link state changed during update"
  [ "$(git -C "$MANAGED" rev-parse HEAD)" = "$TARGET_COMMIT" ] || fail "target checkout moved unexpectedly"
  [ "$(tr -d '[:space:]' < "$MANAGED/VERSION")" = "$TARGET_VERSION" ] || fail "target VERSION is not active"
  [ -f "$MANAGED/appview/dist/server.js" ] && [ -f "$MANAGED/mcp/dist/server.js" ] || fail "target build outputs are missing"
  git -C "$MANAGED" update-ref "refs/ait-release/$TARGET_TAG" "$TARGET_COMMIT" || fail "could not record the verified release identity"
  echo "Check      ${OLD_VERSION:-pre-release} -> $TARGET_VERSION"
  echo "Download   verified immutable release $TARGET_TAG"
  echo "Rebuild    complete"
  [ "$WAS_READY" -eq 1 ] && echo "Services   ready" || echo "Services   stopped"
  echo "Updated AIT ${OLD_VERSION:-pre-release} -> $TARGET_VERSION"
  echo "Release notes: $RELEASE_PAGE"
  DONE=1
}

main "$@"
