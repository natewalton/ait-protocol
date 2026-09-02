#!/bin/bash
# Read-only health and harness status for the shared AIT installation.
set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: bin/status.sh [--check-core]
  --check-core  probe only PLC, PDS, and AppView; print nothing on success.
Status is read-only. It never starts, stops, writes, or repairs services.
EOF
  exit 0
fi
check_core=0
if [ "${1:-}" = "--check-core" ]; then
  check_core=1
elif [ "$#" -ne 0 ]; then
  echo "status: invalid arguments" >&2
  exit 2
fi

probe_http() {
  local url=$1 body
  body="$(curl -fsS --max-time "${AIT_STATUS_CURL_MAX_TIME:-3}" "$url" 2>/dev/null)" || return 1
  case "$body" in
    \{*\}|\[*\]) return 0 ;;
    *) return 1 ;;
  esac
}

probe_socket() {
  local sock=$1
  [ -S "$sock" ] || return 1
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket,sys
s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(2)
s.connect(sys.argv[1])
s.close()' "$sock" >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -zU "$sock" >/dev/null 2>&1
  else
    return 1
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
  if probe_socket "$sock"; then state=running; fi
  printf '  %-16s %s\n' codex-appserver "$state"
else
  printf '  %-16s %s\n' codex-appserver 'skipped (not installed)'
fi
exit "$core_status"
