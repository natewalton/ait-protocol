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

# Prints the pid holding this service's resource, or nothing. ALWAYS returns 0:
# a non-zero return would abort the caller at its `pid="$(running_pid …)"`
# assignment under `set -e`, before it could report anything.
running_pid() {
  local pid=""
  case "$1" in
    plc)     pid="$(lsof -nP -iTCP:2582 -sTCP:LISTEN -t 2>/dev/null | head -1)" ;;
    pds)     pid="$(lsof -nP -iTCP:2583 -sTCP:LISTEN -t 2>/dev/null | head -1)" ;;
    appview) pid="$(lsof -nP -iTCP:2585 -sTCP:LISTEN -t 2>/dev/null | head -1)" ;;
    codex-appserver)
      # The socket path in the command line is already unique to this host's
      # shared server, so no cwd check is needed (and codex runs from the
      # session's directory, not the repo).
      { pgrep -f "codex app-server --listen unix://$CODEX_SOCK" || true; } | head -1
      return 0 ;;
  esac
  if ours "$pid"; then printf '%s' "$pid"; fi
  return 0
}
