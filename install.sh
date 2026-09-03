#!/bin/bash
# Public curl-delivered bootstrap. It is intentionally self-contained because no
# checkout exists yet; after acquisition it delegates to bin/install.sh.
set -euo pipefail

INSTALL_ROOT="${AIT_INSTALL_ROOT:-$HOME/.local/share/ait-protocol}"
REPO_URL="${AIT_REPO_URL:-https://github.com/natewalton/ait-protocol}"
# These placeholders are replaced in the attached release asset by the release
# workflow. Keeping the source runnable is useful for local fixture tests and
# development, but a published asset always takes the exact-tag path below.
RELEASE_TAG="__AIT_RELEASE_TAG__"
RELEASE_COMMIT="__AIT_RELEASE_COMMIT__"
SOURCE_TAG='__AIT_RELEASE''_TAG__'
SOURCE_COMMIT='__AIT_RELEASE''_COMMIT__'
if [ "$RELEASE_TAG" = "$SOURCE_TAG" ]; then
  PUBLIC_COMMAND='/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/natewalton/ait-protocol/main/install.sh)"'
else
  PUBLIC_COMMAND='/bin/bash -c "$(curl -fsSL https://github.com/natewalton/ait-protocol/releases/latest/download/install.sh)"'
fi
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
  [ "$remote" = "$REPO_URL" ] || [ "$remote" = "$REPO_URL.git" ] || return 1
  if [ "$RELEASE_TAG" != "$SOURCE_TAG" ]; then
    [ "$(git -C "$INSTALL_ROOT" rev-parse HEAD 2>/dev/null || true)" = "$RELEASE_COMMIT" ] || return 1
  fi
}

check_destination() {
  if [ -e "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ]; then
    if ! valid_existing_checkout; then
      echo "error: destination collision or unexpected checkout: $INSTALL_ROOT" >&2
      echo "  expected: Git checkout of $REPO_URL with executable $INSTALL_ROOT/ait" >&2
    if [ "$RELEASE_TAG" != "$SOURCE_TAG" ]; then
        echo "  recovery: run ait update in the existing managed checkout, or remove it only after preserving its state" >&2
      fi
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

main() {
  if [ "${1:-}" = "--verify-only" ]; then
    [ "$RELEASE_TAG" != "$SOURCE_TAG" ] || { echo "error: unreplaced release installer template" >&2; return 1; }
    [ "$RELEASE_COMMIT" != "$SOURCE_COMMIT" ] || { echo "error: unreplaced release installer template" >&2; return 1; }
    printf 'verified release installer %s at %s\n' "$RELEASE_TAG" "$RELEASE_COMMIT"
    return 0
  fi
  preflight || exit 1
  check_destination || exit 1

  if [ ! -e "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ]; then
    mkdir -p "$(dirname "$INSTALL_ROOT")"
    if [ "$RELEASE_TAG" = "$SOURCE_TAG" ]; then
      git clone "$REPO_URL" "$INSTALL_ROOT" || {
        echo "error: unable to clone $REPO_URL into $INSTALL_ROOT" >&2
        exit 1
      }
    else
      git init -q "$INSTALL_ROOT"
      git -C "$INSTALL_ROOT" remote add origin "$REPO_URL"
      ref="refs/ait-release/$RELEASE_TAG"
      if ! git -C "$INSTALL_ROOT" fetch -q --no-tags origin "refs/tags/$RELEASE_TAG:$ref"; then
        echo "error: release tag $RELEASE_TAG could not be fetched from $REPO_URL" >&2
        rm -rf "$INSTALL_ROOT"
        exit 1
      fi
      fetched="$(git -C "$INSTALL_ROOT" rev-parse "$ref^{commit}")" || {
        echo "error: release tag $RELEASE_TAG could not be resolved after fetch" >&2
        rm -rf "$INSTALL_ROOT"
        exit 1
      }
      if [ "$fetched" != "$RELEASE_COMMIT" ]; then
        echo "error: release tag $RELEASE_TAG resolved to $fetched, expected $RELEASE_COMMIT" >&2
        rm -rf "$INSTALL_ROOT"
        exit 1
      fi
      if ! git -C "$INSTALL_ROOT" checkout -q --detach "$ref"; then
        echo "error: release tag $RELEASE_TAG could not be checked out" >&2
        rm -rf "$INSTALL_ROOT"
        exit 1
      fi
    fi
  fi

  if ! AIT_SUPPRESS_PREFLIGHT_OUTPUT=1 AIT_SUPPRESS_DETAIL_OUTPUT=1 AIT_PUBLIC_RECOVERY_COMMAND="$PUBLIC_COMMAND" "$INSTALL_ROOT/bin/install.sh" --machine; then
    echo "error: AIT installation did not complete; recovery: $PUBLIC_COMMAND" >&2
    exit 1
  fi
}

main "$@"
