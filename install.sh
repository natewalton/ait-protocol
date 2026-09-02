#!/bin/bash
# Public curl-delivered bootstrap. It is intentionally self-contained because no
# checkout exists yet; after acquisition it delegates to bin/install.sh.
set -euo pipefail

INSTALL_ROOT="${AIT_INSTALL_ROOT:-$HOME/.local/share/ait-protocol}"
REPO_URL="${AIT_REPO_URL:-https://github.com/natewalton/ait-protocol}"
PUBLIC_COMMAND='/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/natewalton/ait-protocol/main/install.sh)"'
STATE_DIR="${AIT_INSTALL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ait-protocol/install-state}"
BREW_PREFIX=""
CLI_LINK=""

missing_prereq() {
  local title="$1" remedy="$2" url="$3"
  echo "  missing: $title"
  echo "    remedy: $remedy"
  echo "    docs: $url"
}

preflight() {
  local failed=0 claude_installed=0 codex_installed=0
  echo "Prerequisites"
  if [ -n "${AIT_NO_SKILLS:-}" ] && [ "${AIT_NO_SKILLS}" != "1" ]; then
    echo "  invalid: AIT_NO_SKILLS must be empty or 1"
    failed=1
  fi
  if [ "$(uname -s 2>/dev/null || true)" != "Darwin" ] && [ "${AIT_SKIP_PLATFORM_CHECK:-0}" != "1" ]; then
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
    BREW_PREFIX="${AIT_BREW_PREFIX:-}"
  else
    BREW_PREFIX="${AIT_BREW_PREFIX:-$(brew --prefix 2>/dev/null || true)}"
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

resolve_path() {
  local source="$1" dir target
  while [ -L "$source" ]; do
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

same_path() {
  [ "$(resolve_path "$1")" = "$(resolve_path "$2")" ]
}

valid_existing_checkout() {
  local remote
  [ -d "$INSTALL_ROOT" ] || return 1
  [ -x "$INSTALL_ROOT/ait" ] || return 1
  [ "$(git -C "$INSTALL_ROOT" rev-parse --show-toplevel 2>/dev/null || true)" = "$(resolve_path "$INSTALL_ROOT")" ] || return 1
  remote="$(git -C "$INSTALL_ROOT" remote get-url origin 2>/dev/null || true)"
  [ "$remote" = "$REPO_URL" ] || [ "$remote" = "$REPO_URL.git" ]
}

check_destination() {
  if [ -e "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ]; then
    if ! valid_existing_checkout; then
      echo "error: destination collision or unexpected checkout: $INSTALL_ROOT" >&2
      echo "  expected: Git checkout of $REPO_URL with executable $INSTALL_ROOT/ait" >&2
      return 1
    fi
  fi
  CLI_LINK="${AIT_CLI_LINK:-$BREW_PREFIX/bin/ait}"
  if [ -e "$CLI_LINK" ] || [ -L "$CLI_LINK" ]; then
    if [ -L "$CLI_LINK" ] && same_path "$CLI_LINK" "$INSTALL_ROOT/ait"; then
      return 0
    fi
    echo "error: CLI link collision at $CLI_LINK; expected a symlink to $INSTALL_ROOT/ait" >&2
    return 1
  fi
}

write_bootstrap_marker() {
  umask 077
  if ! mkdir -p "$STATE_DIR" ||
     ! printf 'fresh bootstrap pending\n' > "$STATE_DIR/bootstrap-pending" ||
     ! chmod 600 "$STATE_DIR/bootstrap-pending"; then
    echo "error: cannot record fresh bootstrap state at $STATE_DIR" >&2
    echo "  recovery: set AIT_INSTALL_STATE_DIR to a writable directory and rerun" >&2
    return 1
  fi
}

main() {
  preflight || exit 1
  check_destination || exit 1

  if [ ! -e "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ]; then
    write_bootstrap_marker || exit 1
    mkdir -p "$(dirname "$INSTALL_ROOT")"
    if ! git clone "$REPO_URL" "$INSTALL_ROOT"; then
      echo "error: unable to clone $REPO_URL into $INSTALL_ROOT" >&2
      exit 1
    fi
  fi

  if ! AIT_SUPPRESS_PREFLIGHT_OUTPUT=1 AIT_SUPPRESS_DETAIL_OUTPUT=1 "$INSTALL_ROOT/bin/install.sh" --machine; then
    echo "error: AIT installation did not complete; recovery: $PUBLIC_COMMAND" >&2
    exit 1
  fi
}

main "$@"
