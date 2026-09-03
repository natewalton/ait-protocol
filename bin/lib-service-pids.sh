# Shared by bin/start-all.sh and bin/stop-all.sh. Sourced, never run directly.
#
# Finds a running AIT service by the resource it holds — its listening port, or
# the codex app-server's unix socket — instead of trusting a pidfile. A pidfile
# is written by whoever started the service, so one started by launchd, by
# bin/codex-session.sh, or by a shell whose /tmp was later cleared has none. Both
# scripts used to read "no pidfile" as "not running": start-all then launched a
# duplicate, and stop-all walked away leaving the process alive.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_SOCK="${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}"

# True when this pid is working inside the repo. Without it, any program that
# happened to hold 2583 would answer to "the PDS" — and stop-all would kill it.
ours() {
  local pid=$1 cwd
  [ -n "$pid" ] || return 1
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  case "$cwd" in "$repo_root"/*|"$repo_root") return 0 ;; *) return 1 ;; esac
}

service_pid() {
  case "$1" in
    plc)     lsof -nP -iTCP:2582 -sTCP:LISTEN -t 2>/dev/null | head -1 ;;
    pds)     lsof -nP -iTCP:2583 -sTCP:LISTEN -t 2>/dev/null | head -1 ;;
    appview) lsof -nP -iTCP:2585 -sTCP:LISTEN -t 2>/dev/null | head -1 ;;
    codex-appserver)
      if [ -S "$CODEX_SOCK" ]; then
        lsof -t "$CODEX_SOCK" 2>/dev/null | head -1
      else
        # Before the socket binds, retain the existing command-line discovery
        # policy so start-all can adopt the process and wait for its event.
        { pgrep -f "codex app-server --listen unix://$CODEX_SOCK" || true; } | head -1
      fi
      ;;
    *) return 1 ;;
  esac
}

# Prints the pid holding this service's resource, or nothing. ALWAYS returns 0:
# a non-zero return would abort the caller at its `pid="$(running_pid …)"`
# assignment under `set -e`, before it could report anything.
running_pid() {
  local pid=""
  pid="$(service_pid "$1" || true)"
  if [ "$1" = codex-appserver ]; then
    printf '%s' "$pid"
    return 0
  fi
  if ours "$pid"; then printf '%s' "$pid"; fi
  return 0
}

service_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}
