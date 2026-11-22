#!/bin/bash
# Private machine/project installer used by the public root bootstrap and CLI.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PUBLIC_COMMAND='/bin/bash -c "$(curl -fsSL https://github.com/natewalton/ait-protocol/releases/latest/download/install.sh)"'
ENV_TARGETS=("$REPO/plc/.env" "$REPO/pds/.env" "$REPO/appview/.env" "$REPO/mcp/.env")
ENV_NAMES=(plc.env pds.env appview.env mcp.env)
CLI_LINK=""
BREW_PREFIX=""
PDS_UPGRADE_LOCK="${XDG_STATE_HOME:-$HOME/.local/state}/ait-protocol/update.lock"
PDS_UPGRADE_LOCK_OWNED=0

# shellcheck source=bin/lib-service-pids.sh
. "$REPO/bin/lib-service-pids.sh"

usage() {
  cat <<'EOF'
Usage:
  bin/install.sh --init [path]   Enable or verify AIT in a project.
  bin/install.sh --launch claude|codex [args...]
  bin/install.sh --drop-database Remove AIT's local plc_directory database.
EOF
}

missing_prereq() {
  local title="$1" remedy="$2" url="$3"
  echo "  missing: $title"
  echo "    remedy: $remedy"
  echo "    docs: $url"
}

preflight() {
  local failed=0 claude_installed=0 codex_installed=0 node_version node_major node_minor
  echo "Prerequisites"
  if [ "$(uname -s 2>/dev/null || true)" != "Darwin" ]; then
    missing_prereq "macOS" "Run AIT on macOS." "https://github.com/natewalton/ait-protocol"
    failed=1
  fi
  if ! command -v git >/dev/null 2>&1; then
    missing_prereq "Git" "brew install git" "https://formulae.brew.sh/formula/git"
    failed=1
  fi
  if ! command -v brew >/dev/null 2>&1; then
    missing_prereq "Homebrew" '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' "https://brew.sh/"
    failed=1
    BREW_PREFIX=""
  else
    BREW_PREFIX="$(brew --prefix 2>/dev/null || true)"
    if [ -z "$BREW_PREFIX" ]; then
      missing_prereq "Homebrew prefix" "brew --prefix" "https://brew.sh/"
      failed=1
    fi
  fi
  node_version="$(node --version 2>/dev/null || true)"
  node_major="$(printf '%s' "$node_version" | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p')"
  node_minor="$(printf '%s' "$node_version" | sed -n 's/^v[0-9][0-9]*\.\([0-9][0-9]*\)\..*/\1/p')"
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 ||
     [ -z "$node_major" ] || [ -z "$node_minor" ] || [ "$node_major" -lt 22 ] ||
     { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 19 ]; }; then
    missing_prereq "Node.js 22.19 or later and npm" "brew install node" "https://formulae.brew.sh/formula/node"
    failed=1
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    missing_prereq "OpenSSL" "brew install openssl" "https://formulae.brew.sh/formula/openssl@3"
    failed=1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    missing_prereq "curl" "brew install curl" "https://formulae.brew.sh/formula/curl"
    failed=1
  fi
  command -v claude >/dev/null 2>&1 && claude_installed=1
  command -v codex >/dev/null 2>&1 && codex_installed=1
  if [ "$claude_installed" -eq 0 ] && [ "$codex_installed" -eq 0 ]; then
    missing_prereq "Claude Code" "curl -fsSL https://claude.ai/install.sh | bash" "https://code.claude.com/docs/en/getting-started"
    missing_prereq "Codex" "curl -fsSL https://chatgpt.com/codex/install.sh | sh" "https://learn.chatgpt.com/docs/codex/cli"
    failed=1
  fi
  if [ "$failed" -ne 0 ]; then
    echo "Prerequisites: FAILED"
    return 1
  fi
  if [ "$claude_installed" -eq 1 ]; then echo "  claude   ready"; else echo "  claude   skipped (not installed)"; fi
  if [ "$codex_installed" -eq 1 ]; then echo "  codex    ready"; else echo "  codex    skipped (not installed)"; fi
  echo "Prerequisites: ✓"
}

check_checkout() {
  local required
  for required in ait bin/install.sh bin/status.sh bin/start-all.sh bin/claude-session.sh bin/codex-session.sh \
    plc/package.json plc/package-lock.json pds/package.json pds/package-lock.json \
    appview/package.json appview/package-lock.json mcp/package.json mcp/package-lock.json; do
    [ -e "$REPO/$required" ] || { echo "error: incomplete AIT checkout, missing $REPO/$required" >&2; return 1; }
  done
  [ -x "$REPO/ait" ] || { echo "error: root ait is not executable: $REPO/ait" >&2; return 1; }
}

same_path() {
  [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]
}

check_cli_link() {
  CLI_LINK="$BREW_PREFIX/bin/ait"
  [ -n "$CLI_LINK" ] || { echo "error: cannot determine Homebrew bin directory" >&2; return 1; }
  if [ -e "$CLI_LINK" ] || [ -L "$CLI_LINK" ]; then
    if [ -L "$CLI_LINK" ] && same_path "$CLI_LINK" "$REPO/ait"; then
      return 0
    fi
    echo "error: CLI link collision at $CLI_LINK; expected a symlink to $REPO/ait" >&2
    return 1
  fi
}

check_process_boundary() {
  local name pid cwd command running=0
  for name in plc pds appview; do
    pid="$(service_pid "$name" || true)"
    if [ -n "$pid" ]; then
      running=1
      cwd="$(service_cwd "$pid")"
      case "$cwd" in
        "$REPO"|"$REPO"/*) ;;
        *) echo "error: conflicting $name process pid $pid from ${cwd:-unknown directory}" >&2; return 1 ;;
      esac
    fi
  done
  if command -v codex >/dev/null 2>&1; then
    pid="$(service_pid codex-appserver || true)"
    if [ -n "$pid" ]; then
      if service_owns_pid codex-appserver "$pid"; then
        running=1
      else
        echo "error: conflicting codex-appserver process pid $pid" >&2
        echo "  recovery: stop the owning checkout's bin/stop-all.sh, then rerun the AIT installer" >&2
        return 1
      fi
    fi
  fi
  printf '%s' "$running"
}

dependencies_ready() {
  [ -d "$REPO/plc/node_modules" ] &&
  [ -d "$REPO/pds/node_modules" ] &&
  [ -d "$REPO/appview/node_modules" ] &&
  [ -d "$REPO/mcp/node_modules" ] &&
  [ -f "$REPO/appview/dist/server.js" ] &&
  [ -f "$REPO/mcp/dist/server.js" ] &&
  ! find "$REPO/appview/src" "$REPO/appview/package.json" \
    "$REPO/appview/package-lock.json" -type f -newer "$REPO/appview/dist/server.js" \
    -print -quit 2>/dev/null | grep -q . &&
  ! find "$REPO/mcp/src" "$REPO/mcp/package.json" \
    "$REPO/mcp/package-lock.json" -type f -newer "$REPO/mcp/dist/server.js" \
    -print -quit 2>/dev/null | grep -q .
}

write_env_file() {
  local file="$1" name="$2"
  case "$name" in
    plc.env)
      cat > "$file" <<EOF
DATABASE_URL=postgres://$(whoami)@localhost:5432/plc_directory
PORT=2582
ADMIN_SECRET=$(openssl rand -hex 32)
EOF
      ;;
    pds.env)
      cat > "$file" <<EOF
PDS_HOSTNAME=pds.localhost
PDS_DID_PLC_URL=http://localhost:2582
PDS_BSKY_APP_VIEW_URL=http://127.0.0.1:2585
PDS_BSKY_APP_VIEW_DID=did:plc:aitappview000000000001
PDS_DISABLE_SSRF_PROTECTION=true
PDS_JWT_SECRET=$(openssl rand -hex 32)
PDS_ADMIN_PASSWORD=$(openssl rand -hex 32)
PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=$(openssl rand -hex 32)
PDS_DATA_DIRECTORY=.pds/
PDS_BLOBSTORE_DISK_LOCATION=.pds/blobs
PDS_INVITE_REQUIRED=false
PDS_EMAIL_SMTP_URL=
PDS_CRAWLERS=
PDS_SERVICE_HANDLE_DOMAINS=.test
EOF
      ;;
    appview.env) cp "$REPO/appview/.env.example" "$file" ;;
    mcp.env) cp "$REPO/mcp/.env.example" "$file" ;;
  esac
  chmod 600 "$file"
}

repair_environment_modes() {
  local target
  for target in "${ENV_TARGETS[@]}"; do
    if ! chmod 600 "$target"; then
      echo "error: could not set private mode on existing environment file: $target" >&2
      return 1
    fi
  done
}

environment_files() {
  local present=0 target tmp
  local -a created=()
  for target in "${ENV_TARGETS[@]}"; do [ -e "$target" ] && present=$((present + 1)); done
  if [ "$present" -eq 4 ]; then
    repair_environment_modes || return 1
    echo "Environment: ✓ existing four-file set preserved"
    return 0
  fi
  if [ "$present" -gt 0 ]; then
    echo "error: partial environment set; it was not changed" >&2
    echo "  present: $(for target in "${ENV_TARGETS[@]}"; do [ -e "$target" ] && printf '%s ' "$target"; done)" >&2
    echo "  missing: $(for target in "${ENV_TARGETS[@]}"; do [ -e "$target" ] || printf '%s ' "$target"; done)" >&2
    echo "  recovery: restore the missing established files and rerun; for a known interrupted first install, delete the four generated files and rerun" >&2
    return 1
  fi
  umask 077
  remove_created() {
    [ "${#created[@]}" -eq 0 ] || rm -f "${created[@]}"
    [ -z "${tmp:-}" ] || rm -f "$tmp"
  }
  for i in 0 1 2 3; do
    target="${ENV_TARGETS[$i]}"
    tmp="$target.ait-install-tmp.$$"
    if ! write_env_file "$tmp" "${ENV_NAMES[$i]}"; then
      remove_created
      return 1
    fi
    if ! mv -n "$tmp" "$target" 2>/dev/null || [ -e "$tmp" ]; then
      remove_created
      echo "error: environment target appeared during publication: $target" >&2
      return 1
    fi
    created+=("$target")
    tmp=""
  done
  echo "Environment: ✓ four files published"
}

postgres_client() {
  local client="$1" pg_prefix candidate
  pg_prefix="$(brew --prefix postgresql@17 2>/dev/null || true)"
  candidate="$pg_prefix/bin/$client"
  if [ -n "$pg_prefix" ] && [ -x "$candidate" ]; then
    printf '%s' "$candidate"
    return 0
  fi
  command -v "$client" 2>/dev/null
}

install_database() {
  local psql_path createdb_path
  if ! brew list --versions postgresql@17 >/dev/null 2>&1; then
    brew install postgresql@17
  fi
  brew services start postgresql@17
  if ! psql_path="$(postgres_client psql)"; then
    echo "error: PostgreSQL client psql is not available after starting postgresql@17" >&2
    return 1
  fi
  if ! createdb_path="$(postgres_client createdb)"; then
    echo "error: PostgreSQL client createdb is not available" >&2
    return 1
  fi
  while ! "$psql_path" -d postgres -Atqc "SELECT 1" >/dev/null 2>&1; do
    echo "waiting for PostgreSQL on local socket; log: Homebrew postgresql@17 service"
    sleep 1
  done
  if ! "$psql_path" -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='plc_directory'" 2>/dev/null | grep -q '^1$'; then
    "$createdb_path" plc_directory
  fi
}

drop_database() {
  local dropdb_path
  if ! dropdb_path="$(postgres_client dropdb)"; then
    echo "error: PostgreSQL client dropdb is not available" >&2
    return 1
  fi
  "$dropdb_path" --if-exists plc_directory
}

release_pds_upgrade_lock() {
  if [ "$PDS_UPGRADE_LOCK_OWNED" -eq 1 ]; then
    [ "$(sed -n '1p' "$PDS_UPGRADE_LOCK/pid" 2>/dev/null || true)" != "$$" ] || rm -f "$PDS_UPGRADE_LOCK/pid"
    rmdir "$PDS_UPGRADE_LOCK" 2>/dev/null || true
    PDS_UPGRADE_LOCK_OWNED=0
  fi
}

acquire_pds_upgrade_lock() {
  local pid
  mkdir -p "$(dirname "$PDS_UPGRADE_LOCK")" || { echo "error: could not create AIT state directory" >&2; return 1; }
  if mkdir "$PDS_UPGRADE_LOCK" 2>/dev/null; then
    if ! printf '%s\n' "$$" > "$PDS_UPGRADE_LOCK/pid"; then
      rmdir "$PDS_UPGRADE_LOCK" 2>/dev/null || true
      echo "error: could not record the PDS upgrade lock" >&2
      return 1
    fi
    PDS_UPGRADE_LOCK_OWNED=1
    return 0
  fi
  pid="$(sed -n '1p' "$PDS_UPGRADE_LOCK/pid" 2>/dev/null || true)"
  if [ "$pid" = "$PPID" ] && kill -0 "$pid" 2>/dev/null; then return 0; fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "error: another AIT update is running (pid $pid)" >&2
  else
    echo "error: stale AIT update lock at $PDS_UPGRADE_LOCK; remove it after confirming no update is running" >&2
  fi
  return 1
}

pds_storage_paths() {
  local state_root="$1" backup="$2" stage="$3"
  (
    cd "$REPO/pds"
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
    node - "$PWD" "$REPO/pds/.env" "${PDS_DATA_DIRECTORY:-}" \
      "${PDS_BLOBSTORE_DISK_LOCATION:-}" "${PDS_BLOBSTORE_DISK_TMP_LOCATION:-}" \
      "$state_root" "$backup" "$stage" \
      "${PDS_ACCOUNT_DB_LOCATION:-}" "${PDS_SEQUENCER_DB_LOCATION:-}" \
      "${PDS_DID_CACHE_DB_LOCATION:-}" "${PDS_ACTOR_STORE_DIRECTORY:-}" \
      "${PDS_BLOBSTORE_S3_BUCKET:-}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [base, envFile, dataValue, blobValue, blobTempValue, stateValue, backupValue, stageValue,
  account, sequencer, didCache, actors, s3] = process.argv.slice(2);
const values = process.argv.slice(2);
if (values.some(value => /[\r\n\t\0]/.test(value))) {
  console.error('error: configured PDS paths may not contain control characters');
  process.exit(1);
}
if (!dataValue) {
  console.error('error: PDS_DATA_DIRECTORY must be set for the PDS 0.5 upgrade');
  process.exit(1);
}
if (!blobValue && !s3) {
  console.error('error: PDS_BLOBSTORE_DISK_LOCATION must be set for the PDS 0.5 upgrade');
  process.exit(1);
}
if (s3) { console.error('error: automatic PDS 0.5 rollback copy does not support an S3 blobstore'); process.exit(1); }
const absoluteRaw = value => path.isAbsolute(value) ? value : `${base}/${value}`;
const physical = value => {
  let existing = absoluteRaw(value);
  const tail = [];
  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(existing);
    if (parent === existing) throw Error(`cannot resolve ${value}`);
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...tail);
};
const effective = value => physical(path.resolve(base, value));
const namedPhysical = (name, value) => {
  try { return physical(value); }
  catch (err) {
    console.error(`error: could not resolve ${name}: ${absoluteRaw(value)}`);
    process.exit(1);
  }
};
const unambiguous = (name, value) => {
  const raw = namedPhysical(name, value);
  let normalized;
  try { normalized = effective(value); }
  catch (err) {
    console.error(`error: could not resolve ${name}: ${absoluteRaw(value)}`);
    process.exit(1);
  }
  if (raw !== normalized) {
    console.error(`error: ${name} resolves differently before and after PDS path normalization; remove the symlink/.. ambiguity`);
    process.exit(1);
  }
  return normalized;
};
const within = (candidate, root) => candidate === root || candidate.startsWith(root + path.sep);
const data = unambiguous('PDS_DATA_DIRECTORY', dataValue);
const blobs = unambiguous('PDS_BLOBSTORE_DISK_LOCATION', blobValue);
const hasPayload = (name, value) => {
  let stat;
  try { stat = fs.statSync(value); }
  catch (err) { if (err?.code === 'ENOENT') return false; throw err; }
  if (!stat.isDirectory()) {
    console.error(`error: ${name} is not a directory: ${value}`); process.exit(1);
  }
  let directory;
  try { directory = fs.opendirSync(value); }
  catch (err) {
    console.error(`error: could not inspect configured PDS storage: ${value}`);
    process.exit(1);
  }
  try { return directory.readSync() !== null; }
  finally { directory.closeSync(); }
};
for (const [name, value] of Object.entries({ PDS_ACCOUNT_DB_LOCATION: account, PDS_SEQUENCER_DB_LOCATION: sequencer, PDS_DID_CACHE_DB_LOCATION: didCache, PDS_ACTOR_STORE_DIRECTORY: actors })) {
  if (!value) continue;
  const resolved = unambiguous(name, value);
  if (!within(resolved, data)) {
    console.error(`error: ${name} resolves outside PDS_DATA_DIRECTORY; refusing an incomplete rollback copy`);
    process.exit(1);
  }
}
if (blobTempValue) {
  const temp = unambiguous('PDS_BLOBSTORE_DISK_TMP_LOCATION', blobTempValue);
  if (!within(temp, blobs)) {
    console.error('error: PDS_BLOBSTORE_DISK_TMP_LOCATION resolves outside PDS_BLOBSTORE_DISK_LOCATION; refusing an incomplete rollback copy');
    process.exit(1);
  }
}
const env = fs.realpathSync.native(envFile);
const state = namedPhysical('PDS rollback root', stateValue);
const backup = namedPhysical('PDS rollback copy', backupValue);
const stage = namedPhysical('PDS rollback staging', stageValue);
const accountDb = account ? unambiguous('PDS_ACCOUNT_DB_LOCATION', account) : namedPhysical('PDS account database', path.resolve(base, path.join(dataValue, 'account.sqlite')));
const external = !within(blobs, data);
const payload = hasPayload('PDS_DATA_DIRECTORY', data) || (external && hasPayload('PDS_BLOBSTORE_DISK_LOCATION', blobs));
process.stdout.write([data, blobs, env, state, backup, stage, external ? 1 : 0, payload ? 1 : 0, accountDb].join('\t'));
NODE
  )
}

pds_processes_stopped() {
  local listeners pid cmd cwd
  listeners="$(service_pids pds || true)"
  [ -z "$listeners" ] || { echo "error: PDS port 2583 is held by pid(s) $listeners; stop AIT before rebuilding" >&2; return 1; }
  for pid in $(pgrep -f 'run-pds\.sh|launcher\.js' 2>/dev/null || true); do
    [ "$pid" = "$$" ] && continue
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    cwd="$(service_cwd "$pid")"
    case "$cwd:$cmd" in
      */pds:*run-pds.sh*|*/pds:*node*launcher.js*)
        echo "error: PDS process pid $pid is still active before listener bind (${cwd:-unknown directory})" >&2
        return 1
        ;;
    esac
  done
}

copy_pds_directory() {
  local source="$1" destination="$2" links
  mkdir -p "$destination" || { echo "error: could not create PDS rollback directory: $destination" >&2; return 1; }
  [ ! -e "$source" ] || {
    [ -d "$source" ] || { echo "error: PDS backup source is not a directory: $source" >&2; return 1; }
    links="$(find "$source" -type l -print -quit)" || { echo "error: could not inspect PDS backup source: $source" >&2; return 1; }
    [ -z "$links" ] || { echo "error: PDS backup source contains a symlink: $source" >&2; return 1; }
    cp -pR "$source/." "$destination/" || { echo "error: could not copy PDS backup source: $source" >&2; return 1; }
  }
}

pds_backup_matches() {
  local backup="$1" data="$2" blobs="$3" external="$4"
  [ -f "$backup/COMPLETE" ] && [ -f "$backup/pds.env" ] && [ -d "$backup/data" ] || return 1
  cmp -s "$REPO/pds/.env" "$backup/pds.env" || return 1
  if [ -d "$data" ]; then
    diff -qr "$data" "$backup/data" >/dev/null 2>&1 || return 1
  else
    [ -z "$(find "$backup/data" -mindepth 1 -print -quit)" ] || return 1
  fi
  if [ "$external" -eq 1 ]; then
    [ -d "$backup/external-blobs" ] || return 1
    if [ -d "$blobs" ]; then
      diff -qr "$blobs" "$backup/external-blobs" >/dev/null 2>&1 || return 1
    else
      [ -z "$(find "$backup/external-blobs" -mindepth 1 -print -quit)" ] || return 1
    fi
  else
    [ ! -e "$backup/external-blobs" ] || return 1
  fi
}

pds_backup_complete() {
  local backup="$1" target="$2" external="$3"
  [ -f "$backup/COMPLETE" ] && [ -f "$backup/pds.env" ] && [ -d "$backup/data" ] && [ -f "$backup/RESTORE.txt" ] || return 1
  grep -Fqx 'installed=0.4.226' "$backup/RESTORE.txt" || return 1
  grep -Fqx "target=$target" "$backup/RESTORE.txt" || return 1
  if [ "$external" -eq 1 ]; then [ -d "$backup/external-blobs" ]; else [ ! -e "$backup/external-blobs" ]; fi
}

pds_account_migrated_05() {
  local account_db="$1"
  [ -f "$account_db" ] || return 1
  node --no-warnings - "$account_db" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(process.argv[2], { readOnly: true });
  const migration = db.prepare("SELECT 1 AS present FROM kysely_migration WHERE name = '008'").get();
  const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'account_email_auth_factor'").get();
  process.exit(migration?.present === 1 && table?.present === 1 ? 0 : 1);
} catch (err) {
  console.error(`error: could not inspect PDS account migration state: ${err.message}`);
  process.exit(2);
} finally { db?.close(); }
NODE
}

pds_backup_paths_disjoint() {
  local source destination
  for destination in "$1" "$2" "$3"; do
    for source in "$4" "$5" "$6"; do
      case "$destination/" in "$source/"*)
        echo "error: PDS rollback destination overlaps configured source: $destination" >&2
        return 1
        ;;
      esac
      case "$source/" in "$destination/"*)
        echo "error: configured PDS source overlaps rollback destination: $source" >&2
        return 1
        ;;
      esac
    done
  done
}

prepare_pds_upgrade() {
  local installed target paths data blobs env_source external=1 state_root backup stage payload=0 account_db migration_state
  local state_value backup_value stage_value
  target="$(node -p "require(process.argv[1]).dependencies['@atproto/pds']" "$REPO/pds/package.json" 2>/dev/null)" || {
    echo "error: could not read the target PDS version" >&2
    return 1
  }
  installed="$(node -p "require(process.argv[1]).version" "$REPO/pds/node_modules/@atproto/pds/package.json" 2>/dev/null || true)"
  case "$target" in 0.5.*) ;; *) return 0 ;; esac
  case "$installed" in 0.5.*) return 0 ;; esac
  state_value="$REPO/pds/data"
  backup_value="$state_value/pds-0.4.226-before-$target"
  stage_value="$backup_value.tmp"
  paths="$(pds_storage_paths "$state_value" "$backup_value" "$stage_value")" || return 1
  IFS=$'\t' read -r data blobs env_source state_root backup stage external payload account_db <<< "$paths"
  pds_backup_paths_disjoint "$state_root" "$backup" "$stage" "$data" "$blobs" "$env_source" || return 1

  acquire_pds_upgrade_lock || return 1
  pds_processes_stopped || return 1

  migration_state=1
  if pds_account_migrated_05 "$account_db"; then migration_state=0; else migration_state=$?; fi
  [ "$migration_state" -ne 2 ] || return 1
  if [ "$migration_state" -eq 0 ]; then
    if pds_backup_complete "$backup" "$target" "$external"; then
      echo "PDS rollback copy: $backup (pre-migration copy preserved; current data is already on PDS 0.5)"
    else
      echo "warning: PDS migration 008 is already applied but its pre-migration rollback copy is unavailable; continuing the 0.5 fix-forward rebuild" >&2
    fi
    return 0
  fi
  case "$installed" in
    0.4.226) [ "$payload" -eq 1 ] || return 0 ;;
    *)
      [ "$payload" -eq 0 ] && return 0
      if [ -e "$backup" ] && pds_backup_matches "$backup" "$data" "$blobs" "$external"; then
        echo "PDS rollback copy: $backup (existing verified copy)"
        return 0
      fi
      echo "error: cannot prove the installed PDS version for existing configured data; refusing the 0.5 rebuild" >&2
      return 1
      ;;
  esac
  mkdir -p "$state_value" || { echo "error: could not create PDS rollback root: $state_value" >&2; return 1; }
  paths="$(pds_storage_paths "$state_value" "$backup_value" "$stage_value")" || return 1
  IFS=$'\t' read -r data blobs env_source state_root backup stage external payload account_db <<< "$paths"
  pds_backup_paths_disjoint "$state_root" "$backup" "$stage" "$data" "$blobs" "$env_source" || return 1
  chmod 700 "$state_root" || { echo "error: could not make PDS rollback root private: $state_root" >&2; return 1; }
  if [ -e "$backup" ]; then
    if pds_backup_matches "$backup" "$data" "$blobs" "$external"; then
      echo "PDS rollback copy: $backup (existing verified copy)"
      return 0
    fi
    echo "error: existing PDS rollback copy differs from the configured data: $backup" >&2
    echo "  preserve or move that copy before retrying; it was not changed" >&2
    return 1
  fi

  echo "Saving PDS rollback copy before upgrade..."
  rm -rf "$stage" || { echo "error: could not clear incomplete PDS rollback staging: $stage" >&2; return 1; }
  mkdir -p "$stage" || { echo "error: could not create PDS rollback staging: $stage" >&2; return 1; }
  chmod 700 "$stage" || { echo "error: could not make PDS rollback staging private: $stage" >&2; return 1; }
  cp -p "$env_source" "$stage/pds.env" || { echo "error: could not copy PDS environment" >&2; return 1; }
  chmod 600 "$stage/pds.env" || { echo "error: could not make copied PDS environment private" >&2; return 1; }
  copy_pds_directory "$data" "$stage/data" || { rm -rf "$stage" || echo "warning: incomplete PDS rollback staging remains at $stage" >&2; return 1; }
  if [ "$external" -eq 1 ]; then
    copy_pds_directory "$blobs" "$stage/external-blobs" || { rm -rf "$stage" || echo "warning: incomplete PDS rollback staging remains at $stage" >&2; return 1; }
  fi
  if ! {
    printf 'installed=%s\ntarget=%s\ndata=%s\nblobs=%s\nexternal_blobs=%s\n' "$installed" "$target" "$data" "$blobs" "$external"
    printf '\nRestore only with the old release while AIT is stopped.\n'
    printf 'This copy restores PDS only, not PLC or other service state.\n'
    printf 'Restoring it discards writes made after the 0.5 PDS first starts and may disagree with later PLC history; prefer fix-forward after writes.\n'
    printf 'ait uninstall removes this rollback copy with the managed checkout.\n'
  } > "$stage/RESTORE.txt"; then
    echo "error: could not write PDS rollback instructions" >&2
    return 1
  fi
  chmod 600 "$stage/RESTORE.txt" || { echo "error: could not make PDS rollback instructions private" >&2; return 1; }
  touch "$stage/COMPLETE" || { echo "error: could not complete PDS rollback staging" >&2; return 1; }
  chmod 600 "$stage/COMPLETE" || { echo "error: could not make PDS rollback marker private" >&2; return 1; }
  pds_backup_matches "$stage" "$data" "$blobs" "$external" || {
    echo "error: PDS rollback copy did not match its quiescent source" >&2
    rm -rf "$stage" || echo "warning: incomplete PDS rollback staging remains at $stage" >&2
    return 1
  }
  mv "$stage" "$backup" || { echo "error: could not publish PDS rollback copy: $backup" >&2; return 1; }
  echo "PDS rollback copy: $backup"
  echo "After the 0.5 PDS starts, do not run old code against migrated data; restore this untouched copy with the old release or fix forward."
}

install_dependencies() (
  trap 'release_pds_upgrade_lock' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  prepare_pds_upgrade || return 1
  npm --prefix "$REPO/plc" ci || return 1
  npm --prefix "$REPO/pds" ci || return 1
  npm --prefix "$REPO/appview" ci || return 1
  npm --prefix "$REPO/mcp" ci || return 1
  npm --prefix "$REPO/appview" run build || return 1
  npm --prefix "$REPO/mcp" run build || return 1
  "$REPO/bin/check-single-lexicon.sh" || return 1
)

rebuild_only() {
  local target
  check_checkout || return 1
  for target in "${ENV_TARGETS[@]}"; do
    [ -f "$target" ] || { echo "error: required environment file is missing: $target" >&2; return 1; }
  done
  repair_environment_modes || return 1
  install_dependencies || {
    echo "error: rebuild failed; services were not started" >&2
    return 1
  }
  echo "Rebuild: complete"
}

start_and_verify() {
  "$REPO/bin/start-all.sh"
  "$REPO/bin/status.sh"
}

machine_install() {
  local running
  preflight || return 1
  check_checkout || return 1
  check_cli_link || return 1
  running="$(check_process_boundary)" || return 1
  if [ "$running" = "1" ]; then
    if ! "$REPO/bin/status.sh" >/dev/null 2>&1 || ! dependencies_ready; then
      echo "error: a partial, unhealthy, or incomplete AIT service set is already running; recover with ait stop" >&2
      return 1
    fi
  fi
  if [ "${AIT_NO_SKILLS:-0}" = "1" ]; then
    echo "  skills  skipped (AIT_NO_SKILLS=1)"
  else
    "$REPO/bin/install-skill.sh" --bootstrap || {
      echo "Skills: FAILED; AIT services and CLI are unchanged; rerun after resolving the skill target" >&2
      return 1
    }
  fi
  # The valid command link is established after all read-only preflight checks
  # but before provisioning. If a later install step fails, it remains a
  # usable pointer to this exact checkout for the documented rerun.
  if [ ! -e "$CLI_LINK" ] && [ ! -L "$CLI_LINK" ]; then
    mkdir -p "$(dirname "$CLI_LINK")"
    ln -s "$REPO/ait" "$CLI_LINK"
  fi
  if [ "$running" = "1" ]; then
    echo "AIT files: ✓ existing dependencies and builds verified"
  else
    environment_files || return 1
    install_database
    install_dependencies
    echo "AIT files: ✓ dependencies and builds ready"
  fi
  start_and_verify || { echo "Services: FAILED; recovery: $PUBLIC_COMMAND" >&2; return 1; }
  echo "Services: ✓ healthy"
  echo "CLI: ✓ $CLI_LINK -> $REPO/ait"
  echo "Harnesses:"
  if command -v claude >/dev/null 2>&1; then echo "  claude   ready"; else echo "  claude   skipped (not installed)"; fi
  if command -v codex >/dev/null 2>&1; then echo "  codex    ready"; else echo "  codex    skipped (not installed)"; fi
  echo "Next steps:"
  echo "  cd /path/to/your/project"
  echo "  ait init"
  echo "  ait help"
}

resolve_project() {
  local explicit="${1:-}" dir home
  home="$(cd -P "$HOME" && pwd)"
  if [ -n "$explicit" ]; then
    [ -d "$explicit" ] || { echo "error: project directory does not exist: $explicit" >&2; return 1; }
    dir="$(cd -P "$explicit" && pwd)"
    if [ "$dir" = "$home" ] || [ "$dir" = / ]; then
      echo "error: no project boundary found at $dir" >&2
      echo "Run: ait init \"$explicit\"" >&2
      return 1
    fi
    printf '%s' "$dir"
    return
  fi
  if dir="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)"; then
    dir="$(cd -P "$dir" && pwd)"
    if [ "$dir" = "$home" ] || [ "$dir" = "/" ]; then
      echo "error: no project boundary found at $dir" >&2
      echo "Run: ait init \"$PWD\"" >&2
      return 1
    fi
    printf '%s' "$dir"
    return
  fi
  dir="$(pwd -P)"
  if [ "$dir" = "$home" ] || [ "$dir" = "/" ]; then
    echo "error: no project boundary found at $dir" >&2
    echo "Run: ait init \"$PWD\"" >&2
    return 1
  fi
  printf '%s' "$dir"
}

config_state() {
  local project="$1" project_common repo_common legacy_allowed=0
  [ -f "$project/.mcp.json" ] || { echo missing; return; }
  if project_common="$(git -C "$project" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" &&
     repo_common="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" &&
     [ "$project_common" = "$repo_common" ]; then
    legacy_allowed=1
  fi
  node - "$project/.mcp.json" "$REPO/mcp/dist/server.js" "$legacy_allowed" "$REPO" <<'NODE'
const fs = require('fs');
const [file, expected, legacyAllowed, repo] = process.argv.slice(2);
try {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = data?.mcpServers?.['ait-protocol'];
  const legacy = `\${CLAUDE_PROJECT_DIR:-${repo}}/mcp/dist/server.js`;
  if (!entry) console.log('missing');
  else if (entry.command === 'node' &&
           Array.isArray(entry.args) &&
           entry.args.length === 2 &&
           entry.args[0] === '--enable-source-maps' &&
           (entry.args[1] === expected ||
            (legacyAllowed === '1' && entry.args[1] === legacy))) console.log('ready');
  else console.log('conflict');
} catch (error) {
  console.log('conflict');
}
NODE
}

config_value() {
  local project="$1"
  node - "$project/.mcp.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
try {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(JSON.stringify(data?.mcpServers?.['ait-protocol'] ?? null));
} catch (error) {
  console.log('invalid JSON');
}
NODE
}

init_project() {
  local project="$1" state
  preflight || return 1
  [ -f "$REPO/mcp/dist/server.js" ] || { echo "error: built MCP missing; run the private machine installer" >&2; return 1; }
  "$REPO/bin/status.sh" --check-core >/dev/null 2>&1 || { echo "error: AIT core is not healthy; run: ait start" >&2; return 1; }

  echo "Project: $project"
  if command -v codex >/dev/null 2>&1; then
    [ -x "$REPO/bin/codex-session.sh" ] || { echo "error: Codex launcher is not executable" >&2; return 1; }
    echo "  codex    ready (no project file required)"
  else
    echo "  codex    skipped (not installed)"
  fi

  if command -v claude >/dev/null 2>&1; then
    state="$(config_state "$project")"
    case "$state" in
      ready) ;;
      missing)
        if ! (cd "$project" && claude mcp add --scope project ait-protocol -- node --enable-source-maps "$REPO/mcp/dist/server.js"); then
          echo "error: Claude native project configuration failed" >&2
          return 1
        fi
        [ "$(config_state "$project")" = ready ] || { echo "error: Claude project entry after add is not ready" >&2; return 1; }
        ;;
      conflict)
        echo "error: conflicting ait-protocol entry in $project/.mcp.json" >&2
        echo "  expected: node --enable-source-maps $REPO/mcp/dist/server.js" >&2
        echo "  actual: $(config_value "$project")" >&2
        echo "  recovery: claude mcp remove ait-protocol -s project, then rerun ait init" >&2
        return 1
        ;;
    esac
    if ! (cd "$project" && claude mcp get ait-protocol >/dev/null 2>&1); then
      echo "error: Claude cannot read the configured ait-protocol entry" >&2
      return 1
    fi
    echo "  claude   ready"
  else
    echo "  claude   skipped (not installed)"
  fi
  echo "Project: ✓ AIT enabled"
  echo "Next steps:"
  if command -v claude >/dev/null 2>&1; then echo "  ait claude"; fi
  if command -v codex >/dev/null 2>&1; then echo "  ait codex"; fi
}

launch_harness() {
  local kind="$1"; shift
  case "$kind" in
    claude)
      command -v claude >/dev/null 2>&1 || { echo "error: Claude Code is not installed; remedy: curl -fsSL https://claude.ai/install.sh | bash" >&2; return 1; }
      ;;
    codex)
      command -v codex >/dev/null 2>&1 || { echo "error: Codex is not installed; remedy: curl -fsSL https://chatgpt.com/codex/install.sh | sh" >&2; return 1; }
      ;;
    *) echo "error: unknown harness: $kind" >&2; return 2 ;;
  esac
  "$REPO/bin/status.sh" --check-core >/dev/null 2>&1 || { echo "error: AIT core is not healthy; run: ait start" >&2; return 1; }
  [ -f "$REPO/mcp/dist/server.js" ] || { echo "error: built MCP missing; run: ait start" >&2; return 1; }
  if [ "$kind" = "claude" ]; then
    [ "$(config_state "$PWD")" = ready ] || { echo "error: run ait init in this project first" >&2; return 1; }
  fi
  exec "$REPO/bin/$kind-session.sh" "$@"
}

case "${1:-}" in
  --rebuild-only)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    rebuild_only
    ;;
  --init)
    [ "$#" -le 2 ] || { usage >&2; exit 2; }
    project="$(resolve_project "${2:-}")" || exit 1
    init_project "$project"
    ;;
  --launch)
    [ "$#" -ge 2 ] || { usage >&2; exit 2; }
    launch_harness "$2" "${@:3}"
    ;;
  --drop-database)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    drop_database
    ;;
  "")
    machine_install
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
