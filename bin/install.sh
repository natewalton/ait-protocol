#!/bin/bash
# Private machine/project installer used by the public root bootstrap and CLI.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PUBLIC_COMMAND='/bin/bash -c "$(curl -fsSL https://github.com/natewalton/ait-protocol/releases/latest/download/install.sh)"'
ENV_TARGETS=("$REPO/plc/.env" "$REPO/pds/.env" "$REPO/appview/.env" "$REPO/mcp/.env")
ENV_NAMES=(plc.env pds.env appview.env mcp.env)
CLI_LINK=""
BREW_PREFIX=""

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
  local failed=0 claude_installed=0 codex_installed=0
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
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    missing_prereq "Node.js and npm" "brew install node" "https://formulae.brew.sh/formula/node"
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

service_pid() {
  case "$1" in
    plc) lsof -nP -iTCP:2582 -sTCP:LISTEN -t 2>/dev/null | head -1 ;;
    pds) lsof -nP -iTCP:2583 -sTCP:LISTEN -t 2>/dev/null | head -1 ;;
    appview) lsof -nP -iTCP:2585 -sTCP:LISTEN -t 2>/dev/null | head -1 ;;
    codex-appserver) pgrep -f "codex app-server --listen unix://${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}" 2>/dev/null | head -1 ;;
    *) return 1 ;;
  esac
}

service_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
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
      command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      case "$command" in
        *"$REPO/mcp/dist/server.js"*) running=1 ;;
        *)
          echo "error: conflicting codex-appserver process pid $pid from ${command:-unknown command}" >&2
          echo "  recovery: stop the owning checkout's bin/stop-all.sh, then rerun the AIT installer" >&2
          return 1
          ;;
      esac
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

environment_files() {
  local present=0 target tmp
  local -a created=()
  for target in "${ENV_TARGETS[@]}"; do [ -e "$target" ] && present=$((present + 1)); done
  if [ "$present" -eq 4 ]; then
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

install_dependencies() {
  npm --prefix "$REPO/plc" ci || return 1
  npm --prefix "$REPO/pds" ci || return 1
  npm --prefix "$REPO/appview" ci || return 1
  npm --prefix "$REPO/mcp" ci || return 1
  npm --prefix "$REPO/appview" run build || return 1
  npm --prefix "$REPO/mcp" run build || return 1
  "$REPO/bin/check-single-lexicon.sh" || return 1
}

rebuild_only() {
  local target
  check_checkout || return 1
  for target in "${ENV_TARGETS[@]}"; do
    [ -f "$target" ] || { echo "error: required environment file is missing: $target" >&2; return 1; }
  done
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
  local project="$1"
  [ -f "$project/.mcp.json" ] || { echo missing; return; }
  node - "$project/.mcp.json" "$REPO/mcp/dist/server.js" <<'NODE'
const fs = require('fs');
const [file, expected] = process.argv.slice(2);
try {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = data?.mcpServers?.['ait-protocol'];
  if (!entry) console.log('missing');
  else if (entry.command === 'node' &&
           JSON.stringify(entry.args) === JSON.stringify(['--enable-source-maps', expected])) console.log('exact');
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
      exact) ;;
      missing)
        if ! (cd "$project" && claude mcp add --scope project ait-protocol -- node --enable-source-maps "$REPO/mcp/dist/server.js"); then
          echo "error: Claude native project configuration failed" >&2
          return 1
        fi
        [ "$(config_state "$project")" = exact ] || { echo "error: Claude project entry after add is not exact" >&2; return 1; }
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
    [ "$(config_state "$PWD")" = exact ] || { echo "error: run ait init in this project first" >&2; return 1; }
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
