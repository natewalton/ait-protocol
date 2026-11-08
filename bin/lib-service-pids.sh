# Shared service discovery, process verification and explicit Codex shutdown.
# Resource ownership is authoritative; PID files are disposable caches.
# Sourced by lifecycle scripts, never run directly.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CODEX_SOCK="${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}"

service_pids() {
  case "$1" in
    plc)     lsof -nP -iTCP:2582 -sTCP:LISTEN -t 2>/dev/null ;;
    pds)     lsof -nP -iTCP:2583 -sTCP:LISTEN -t 2>/dev/null ;;
    appview) lsof -nP -iTCP:2585 -sTCP:LISTEN -t 2>/dev/null ;;
    codex-appserver)
      if [ -S "$CODEX_SOCK" ]; then
        # Codex publishes an advertised alias to its protected physical socket.
        # lsof does not follow that alias on macOS.
        lsof -t "$(/bin/realpath "$CODEX_SOCK" 2>/dev/null)" 2>/dev/null
      else
        # Before the socket binds, retain the existing command-line discovery
        # policy so start-all can adopt the process and wait for its event.
        local pid cmd
        for pid in $(pgrep -f "codex app-server --listen unix://$CODEX_SOCK" || true); do
          cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
          if codex_server_command "$cmd"; then printf '%s\n' "$pid"; fi
        done
      fi
      ;;
    *) return 1 ;;
  esac
}

# Installer callers consume one PID and perform their own conflict reporting.
service_pid() {
  local name=$1 pid candidates cmd
  candidates="$(service_pids "$name" || true)"
  for pid in $candidates; do
    if [ "$name" != codex-appserver ]; then printf '%s' "$pid"; return 0; fi
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if codex_server_command "$cmd"; then printf '%s' "$pid"; return 0; fi
  done
  # Preserve conflict visibility for a foreign non-server occupying the socket.
  printf '%s\n' "$candidates" | head -1
}

codex_server_command() {
  case " $1 " in
    *"/codex app-server --listen unix://$CODEX_SOCK "*|*" codex app-server --listen unix://$CODEX_SOCK "*) return 0 ;;
  esac
  return 1
}

# Call synchronously before a new launch, never as a proxy for an incumbent's
# version. Native Codex owns exclusive bind, stale recovery and endpoint cleanup.
require_codex_native_lifecycle() {
  local binary="${1:-${CODEX_BIN:-codex}}" version major minor
  version="$("$binary" --version 2>/dev/null | sed -n 's/^codex-cli \([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*$/\1/p' || true)"
  major="${version%%.*}"
  minor="${version#*.}"; minor="${minor%%.*}"
  if [ -n "$version" ] && { [ "$major" -gt 0 ] || { [ "$major" -eq 0 ] && [ "$minor" -ge 166 ]; }; }; then return 0; fi
  echo "Codex 0.166.0 or newer is required to start AIT's shared server (found ${version:-unknown}). Update Codex, then run ait start." >&2
  return 1
}

# Verify process identity independently of the disposable PID cache.
service_owns_pid() {
  local name=$1 pid=$2 cmd cwd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [ "$name" = codex-appserver ]; then
    codex_server_command "$cmd" || return 1
    case " $cmd " in
      *" mcp_servers.ait.args=[\"$repo_root/mcp/dist/server.js\"] "*) return 0 ;;
    esac
    return 1
  fi
  cwd="$(service_cwd "$pid")"
  [ "$cwd" = "$repo_root/$name" ] || return 1
  case "$name:$cmd" in
    plc:*node*launcher.js|pds:*node*launcher.js|appview:*node*dist/server.js) return 0 ;;
  esac
  return 1
}

# Empty means absent; status 2 means occupied by a foreign process. Inspect every
# socket holder: inherited descriptors can put a child before its server.
running_pid() {
  local name=$1 pid candidates
  candidates="$(service_pids "$name" || true)"
  for pid in $candidates; do
    if service_owns_pid "$name" "$pid"; then printf '%s' "$pid"; return 0; fi
  done
  if [ -n "$candidates" ]; then
    echo "error: $name resource owned by another process; refusing to adopt or stop it" >&2
    return 2
  fi
  return 0
}

service_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

# Shared graceful shutdown for explicit stop and launcher signal forwarding.
owned_codex_pids() {
  local pid candidates
  candidates="$( { service_pids codex-appserver || true; pgrep -f "codex app-server --listen unix://$CODEX_SOCK" || true; } | sort -u)"
  for pid in $candidates; do
    if service_owns_pid codex-appserver "$pid"; then printf '%s\n' "$pid"; fi
  done
}

codex_shutdown_target() {
  service_owns_pid codex-appserver "$1" && return 0
  # The launcher also owns its unreaped direct child, which can be an npm shim
  # rather than the native socket owner. This PID comes from $!, never a cache.
  [ "$1" = "${2:-}" ] && [ "$(ps -p "$1" -o ppid= 2>/dev/null | tr -d ' ')" = "$$" ]
}

stop_codex_pids() {
  local servers="$1 ${2:-}" direct_child="${2:-}" pid still i
  [ -n "$servers" ] || return 0
  for pid in $servers; do
    codex_shutdown_target "$pid" "$direct_child" || continue
    kill "$pid" 2>/dev/null && echo "stopping codex app-server (pid $pid)"
  done
  for i in 1 2 3 4 5; do
    still=""
    for pid in $servers; do codex_shutdown_target "$pid" "$direct_child" && still="$pid" || true; done
    [ -n "$still" ] || break
    sleep 1
  done
  for pid in $servers; do
    codex_shutdown_target "$pid" "$direct_child" || continue
    kill -9 "$pid" 2>/dev/null && echo "force-killed codex app-server (pid $pid)"
  done
  # Native shutdown closes its MCP stdio; AIT's MCP exits on stdin EOF.
  # Never retain descendant PIDs and signal them after their parent is gone.
}
