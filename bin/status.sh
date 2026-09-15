#!/bin/bash
# Read-only health and harness status for the shared AIT installation.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

check_core=0
if [ "${1:-}" = "--check-core" ]; then
  check_core=1
elif [ "$#" -ne 0 ]; then
  echo "status: invalid arguments" >&2
  exit 2
fi

probe_http() {
  local url=$1 body
  body="$(curl -fsS --max-time 3 "$url" 2>/dev/null)" || return 1
  case "$body" in
    \{*\}|\[*\]) return 0 ;;
    *) return 1 ;;
  esac
}

probe_codex() {
  local sock=$1
  [ -S "$sock" ] || return 1
  [ -f "$REPO/mcp/dist/codex/probe.js" ] || return 2
  command -v node >/dev/null 2>&1 || return 2
  node "$REPO/mcp/dist/codex/probe.js" "$sock" 3000 >/dev/null 2>&1
}

codex_cleanup_status() {
  local version major minor
  version="$(codex --version 2>/dev/null | sed -n 's/^codex-cli \([0-9][0-9.]*\).*$/\1/p')"
  major="${version%%.*}"
  minor="${version#*.}"; minor="${minor%%.*}"
  if [ -n "$version" ] && [ "$major" -eq "$major" ] 2>/dev/null &&
     [ "$minor" -eq "$minor" ] 2>/dev/null &&
     { [ "$major" -gt 0 ] || [ "$minor" -ge 154 ]; }; then
    printf 'Codex %s; exited-session cleanup immediate' "$version"
  else
    printf 'Codex %s; immediate cleanup requires Codex 0.154+' "${version:-unknown}"
  fi
}

core_status=0
declare -a names=(plc pds appview)
declare -a urls=(http://localhost:2582/_health http://localhost:2583/xrpc/_health http://localhost:2585/xrpc/_health)
if [ "$check_core" -eq 1 ]; then
  for i in 0 1 2; do
    if ! probe_http "${urls[$i]}"; then core_status=1; fi
  done
  exit "$core_status"
fi

echo "AIT status:"
for i in 0 1 2; do
  state=unreachable
  if probe_http "${urls[$i]}"; then state=running; else core_status=1; fi
  printf '  %-16s %s\n' "${names[$i]}" "$state"
done

if command -v codex >/dev/null 2>&1; then
  sock="${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}"
  state=unreachable
  if [ -S "$sock" ]; then
    if probe_codex "$sock"; then
      state=running
    else
      probe_status=$?
      if [ "$probe_status" -eq 1 ]; then
        state=protocol-unhealthy
      else
        state="skipped (health probe unavailable; run: npm --prefix '$REPO/mcp' ci && npm --prefix '$REPO/mcp' run build)"
      fi
      core_status=1
    fi
  fi
  printf '  %-16s %s (%s)\n' codex-appserver "$state" "$(codex_cleanup_status)"
else
  printf '  %-16s %s\n' codex-appserver 'skipped (not installed)'
fi
exit "$core_status"
