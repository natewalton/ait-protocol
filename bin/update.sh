#!/bin/bash
# Update one installer-owned checkout to one immutable GitHub release.
set -euo pipefail

MANAGED="${1:-${AIT_INSTALL_ROOT:-$HOME/.local/share/ait-protocol}}"
API_URL="${AIT_RELEASE_API_URL:-https://api.github.com/repos/natewalton/ait-protocol/releases/latest}"
EXPECTED_ORIGIN="${AIT_UPDATE_EXPECTED_ORIGIN:-https://github.com/natewalton/ait-protocol}"
LOCK="${AIT_UPDATE_LOCK:-${XDG_STATE_HOME:-$HOME/.local/state}/ait-protocol/update.lock}"
STATUS_SCRIPT="${AIT_UPDATE_STATUS_SCRIPT:-$MANAGED/bin/status.sh}"
START_SCRIPT="${AIT_UPDATE_START_SCRIPT:-$MANAGED/bin/start-all.sh}"
STOP_SCRIPT="${AIT_UPDATE_STOP_SCRIPT:-$MANAGED/bin/stop-all.sh}"
CLI_LINK="${AIT_UPDATE_CLI_LINK:-${AIT_CLI_LINK:-}}"
EXECUTABLE="${AIT_UPDATE_EXECUTABLE:-}"
RELEASE_PAGE='https://github.com/natewalton/ait-protocol/releases/latest'
OLD_COMMIT=''; OLD_VERSION=''; TARGET_COMMIT=''; TARGET_VERSION=''; TARGET_TAG=''
WAS_READY=0; RECOVERY=''; LOCK_OWNED=0; TMP_DIR=''

fail() { echo "error: $*" >&2; exit 1; }
sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }

finish() {
  local rc="$1"
  trap - EXIT INT TERM
  if [ "$rc" -ne 0 ] && [ -n "$RECOVERY" ]; then
    echo 'RECOVERY REQUIRED' >&2
    echo "  old: ${OLD_VERSION:-pre-release} $OLD_COMMIT" >&2
    echo "  target: $TARGET_VERSION $TARGET_COMMIT" >&2
    if [ "$RECOVERY" = forward ]; then
      echo '  Do not reset; persisted data may have advanced.' >&2
      echo '  recovery: preserve the logs and fix forward with a higher patch release.' >&2
    else
      echo '  recovery: restore the old release and rebuild:' >&2
      echo "    git -C '$MANAGED' checkout --detach '$OLD_COMMIT'" >&2
      echo "    '$MANAGED/bin/install.sh' --rebuild-only" >&2
      [ "$WAS_READY" -eq 0 ] || echo '    ait start' >&2
    fi
  fi
  if [ "$LOCK_OWNED" -eq 1 ]; then
    rm -f "$LOCK/pid" "$LOCK/state" 2>/dev/null || true
    rmdir "$LOCK" 2>/dev/null || true
  fi
  [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"
  exit "$rc"
}
trap 'finish $?' EXIT
trap 'finish 143' INT TERM

parse_release() {
  node - "$1" "$RELEASE_PAGE" <<'NODE'
const fs = require('fs');
const [file, fallback] = process.argv.slice(2);
let r; try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { process.exit(2); }
if (!/^v\d+\.\d+\.\d+$/.test(r.tag_name || '') || r.draft !== false || r.prerelease !== false || r.immutable !== true) process.exit(3);
const a = (r.assets || []).find(x => x.name === 'install.sh');
if (!a || !/^sha256:[0-9a-f]{64}$/.test(a.digest || '') || !a.browser_download_url) process.exit(4);
process.stdout.write([r.tag_name, r.tag_name.slice(1), a.browser_download_url, a.digest.slice(7), r.html_url || fallback].join('\t'));
NODE
}

resolve_path() {
  local path="$1" dir next depth=0 seen='|'
  while [ -L "$path" ]; do
    [ "$depth" -lt 40 ] || return 1
    case "$seen" in *"|$path|"*) return 1 ;; esac
    seen="$seen$path|"; dir="$(cd -P "$(dirname "$path")" && pwd)"; next="$(readlink "$path")"
    case "$next" in /*) path="$next" ;; *) path="$dir/$next" ;; esac
    depth=$((depth + 1))
  done
  if [ -e "$path" ]; then printf '%s/%s' "$(cd -P "$(dirname "$path")" && pwd)" "$(basename "$path")"; else printf '%s' "$path"; fi
}

check_git_state() {
  local git_dir marker
  git_dir="$(git -C "$MANAGED" rev-parse --git-dir)" || fail 'unable to inspect Git state'
  case "$git_dir" in /*) ;; *) git_dir="$MANAGED/$git_dir" ;; esac
  for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG rebase-merge rebase-apply sequencer; do
    [ ! -e "$git_dir/$marker" ] || fail "a Git operation is in progress ($marker)"
  done
}

check_cli() {
  local candidate resolved found=0
  if [ -n "$CLI_LINK" ]; then candidate="$CLI_LINK"; found=1; else
    for candidate in "$HOME/.local/bin/ait" /opt/homebrew/bin/ait /usr/local/bin/ait; do
      if [ -e "$candidate" ] || [ -L "$candidate" ]; then found=1; break; fi
    done
  fi
  [ "$found" -eq 1 ] || fail 'managed CLI link was not found; run the AIT installer before updating'
  [ -L "$candidate" ] || fail "CLI target is not an installer-owned symlink: $candidate"
  resolved="$(resolve_path "$candidate")" || fail "CLI link is cyclic or unresolved: $candidate"
  [ "$resolved" = "$MANAGED/ait" ] || fail "CLI link $candidate belongs to another checkout ($resolved)"
  if [ -n "$EXECUTABLE" ]; then
    resolved="$(resolve_path "$EXECUTABLE")" || fail "executing AIT CLI is cyclic or unresolved: $EXECUTABLE"
    [ "$resolved" = "$MANAGED/ait" ] || fail "executing AIT CLI belongs to another checkout ($resolved)"
  fi
}

service_state() {
  local output running down codex
  output="$("$STATUS_SCRIPT" 2>&1 || true)"
  running="$(printf '%s\n' "$output" | awk '$1=="plc"||$1=="pds"||$1=="appview" {if ($2=="running") n++} END {print n+0}')"
  down="$(printf '%s\n' "$output" | awk '$1=="plc"||$1=="pds"||$1=="appview" {if ($2=="unreachable") n++} END {print n+0}')"
  codex="$(printf '%s\n' "$output" | awk '$1=="codex-appserver" {print $2}')"
  if [ "$running" -eq 3 ] && { [ -z "$codex" ] || [ "$codex" = running ] || [ "$codex" = skipped ]; }; then WAS_READY=1; return; fi
  if [ "$down" -eq 3 ] && { [ -z "$codex" ] || [ "$codex" = unreachable ] || [ "$codex" = skipped ]; }; then WAS_READY=0; return; fi
  fail 'service set is partial or has an unknown status; run ait stop'
}

acquire_lock() {
  local pid=''
  mkdir -p "$(dirname "$LOCK")"
  if ! mkdir "$LOCK" 2>/dev/null; then
    pid="$(sed -n '1p' "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then fail "another AIT update is running (pid $pid)"; fi
    fail "stale AIT update lock at $LOCK; remove it after confirming no update is running"
  fi
  LOCK_OWNED=1; printf '%s\n' "$$" > "$LOCK/pid"; printf '%s\n' "$OLD_COMMIT" > "$LOCK/state"
}

check_sessions() {
  local pids
  pids="$(pgrep -f "$MANAGED/mcp/dist/server.js" 2>/dev/null || true)"
  [ -z "$pids" ] || fail "active AIT session process(es) use this checkout: $pids; exit every harness session and retry"
}

verify_asset() {
  local tag commit
  tag="$(sed -n 's/^RELEASE_TAG="\([^"]*\)"$/\1/p' "$1")"
  commit="$(sed -n 's/^RELEASE_COMMIT="\([0-9a-f]\{40\}\)"$/\1/p' "$1")"
  [ "$(grep -Ec '^RELEASE_TAG="v[0-9]+\.[0-9]+\.[0-9]+"$' "$1" || true)" -eq 1 ] || fail 'release installer must bind exactly one full SemVer tag assignment'
  [ "$(grep -Ec '^RELEASE_COMMIT="[0-9a-f]{40}"$' "$1" || true)" -eq 1 ] || fail 'release installer must bind exactly one full commit assignment'
  [ "$tag" = "$TARGET_TAG" ] || fail "release installer binds $tag, expected $TARGET_TAG"
  TARGET_COMMIT="$commit"
}

verify_release() {
  local resolved version
  resolved="$(git -C "$MANAGED" rev-parse 'FETCH_HEAD^{commit}')" || fail 'release tag did not resolve to one commit'
  [ "$resolved" = "$TARGET_COMMIT" ] || fail "release tag resolved to $resolved, expected $TARGET_COMMIT"
  version="$(git -C "$MANAGED" show FETCH_HEAD:VERSION 2>/dev/null | tr -d '[:space:]')"
  [ "$version" = "$TARGET_VERSION" ] || fail 'release tag/version mismatch'
  git -C "$MANAGED" merge-base --is-ancestor "$OLD_COMMIT" "$TARGET_COMMIT" || fail "release $TARGET_TAG diverges from the installed checkout"
  node - "$OLD_VERSION" "$TARGET_VERSION" <<'NODE' || fail "release $TARGET_TAG is not newer than installed version"
const p=s=>(s||'').match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
const [a,b]=[p(process.argv[2]),p(process.argv[3])];
if (!b || (a && (b[0]<a[0] || b[0]===a[0] && (b[1]<a[1] || b[1]===a[1] && b[2]<=a[2])))) process.exit(1);
NODE
}

update() {
  local api asset fields url digest
  [ -d "$MANAGED/.git" ] || fail "managed checkout not found: $MANAGED"
  MANAGED="$(cd -P "$MANAGED" && pwd)"
  case "$(git -C "$MANAGED" remote get-url origin 2>/dev/null || true)" in "$EXPECTED_ORIGIN"|"$EXPECTED_ORIGIN.git") ;; *) fail 'managed checkout is not owned by the AIT release updater' ;; esac
  [ "$(git -C "$MANAGED" rev-parse --show-toplevel)" = "$MANAGED" ] || fail 'managed checkout path is not canonical'
  check_cli
  [ -z "$(git -C "$MANAGED" status --porcelain)" ] || fail 'managed checkout is dirty; commit or discard changes before updating'
  check_git_state
  OLD_COMMIT="$(git -C "$MANAGED" rev-parse HEAD)"; OLD_VERSION="$(tr -d '[:space:]' < "$MANAGED/VERSION" 2>/dev/null || true)"
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ait-update.XXXXXX")"; api="$TMP_DIR/release.json"; asset="$TMP_DIR/install.sh"
  curl -fsSL -H 'X-GitHub-Api-Version: 2026-03-10' "$API_URL" > "$api" || fail "could not read the latest release; see $RELEASE_PAGE"
  fields="$(parse_release "$api")" || fail 'latest release is not one immutable full SemVer release with a verified installer asset'
  IFS=$'\t' read -r TARGET_TAG TARGET_VERSION url digest RELEASE_PAGE <<< "$fields"
  curl -fsSL "$url" > "$asset" || fail "could not download the release installer asset; see $RELEASE_PAGE"
  [ "$(sha256 "$asset")" = "$digest" ] || fail 'release installer digest mismatch'
  verify_asset "$asset"
  if [ "$TARGET_COMMIT" = "$OLD_COMMIT" ]; then echo "AIT is already up to date at $TARGET_TAG ($TARGET_COMMIT)"; return; fi
  git -C "$MANAGED" fetch -q --no-tags origin "refs/tags/$TARGET_TAG" || fail "release tag $TARGET_TAG could not be fetched"
  verify_release
  acquire_lock
  [ -z "$(git -C "$MANAGED" status --porcelain)" ] && [ "$(git -C "$MANAGED" rev-parse HEAD)" = "$OLD_COMMIT" ] || fail 'installed checkout changed before update'
  check_git_state; check_sessions; service_state
  RECOVERY=reset
  [ "$WAS_READY" -eq 0 ] || "$STOP_SCRIPT" || fail 'could not stop the ready AIT service set'
  git -C "$MANAGED" checkout -q --detach "$TARGET_COMMIT" || fail "could not check out verified release $TARGET_TAG"
  git -C "$MANAGED" update-ref "refs/ait-release/$TARGET_TAG" "$TARGET_COMMIT" || fail 'could not record the verified release identity'
  "$MANAGED/bin/install.sh" --rebuild-only || fail 'target rebuild failed'
  if [ "$WAS_READY" -eq 1 ]; then
    RECOVERY=forward
    "$START_SCRIPT" || fail 'updated services did not become ready'
    service_state; [ "$WAS_READY" -eq 1 ] || fail 'updated services did not become ready'
  fi
  [ "$(git -C "$MANAGED" rev-parse HEAD)" = "$TARGET_COMMIT" ] || fail 'target checkout moved unexpectedly'
  [ "$(tr -d '[:space:]' < "$MANAGED/VERSION")" = "$TARGET_VERSION" ] || fail 'target VERSION is not active'
  [ -f "$MANAGED/appview/dist/server.js" ] && [ -f "$MANAGED/mcp/dist/server.js" ] || fail 'target build outputs are missing'
  RECOVERY=''
  echo "Updated AIT ${OLD_VERSION:-pre-release} -> $TARGET_VERSION"
  echo "Release notes: $RELEASE_PAGE"
}

update
