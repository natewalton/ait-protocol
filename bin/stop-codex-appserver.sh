#!/bin/bash
# Stops every shared codex app-server bound to this host's AIT socket, and the
# processes it spawned.
#
# Why this exists as its own script: bin/stop-all.sh only knows the pid it wrote
# to /tmp/ait-codex-appserver.pid, and bin/run-codex-appserver.sh used to `rm -f`
# the socket before binding. Between them, a running app-server could have the
# socket unlinked out from under it and keep going — unreachable, unlogged, but
# still holding live MCP children with their own AIT identities, still on the
# network. Three such servers accumulated on this host over three weeks, one of
# them still holding an MCP child five days after its socket was taken away.
#
# Selection is by the FULL socket path in the command line, which is unique to
# this host's shared server. Never match on `node … dist/server.js`: every
# session's ait MCP child shares that command line, including the one belonging
# to the session running this script.
#
# Usage: bin/stop-codex-appserver.sh [socket-path]
set -euo pipefail

DEFAULT_SOCK="${AIT_CODEX_SHARED_SOCKET:-$HOME/.ait/codex-shared.sock}"
SOCK="${1:-$DEFAULT_SOCK}"
PIDFILE=/tmp/ait-codex-appserver.pid
TERM_WAIT_SECS=5

# `pgrep -f` excludes itself, and the pattern carries the socket path, so a
# per-session socket (bin/codex-session.sh mints its own) cannot match.
servers=$(pgrep -f "codex app-server --listen unix://$SOCK" || true)

if [ -z "$servers" ]; then
  echo "codex app-server: none running on $SOCK"
else
  # Collect children BEFORE killing the parents: once a parent dies its children
  # are reparented to init and `pgrep -P` can no longer find them.
  # `|| true` inside the substitution, not after it: pipefail makes the pipeline
  # return pgrep's status, and pgrep exits 1 when a server has no children at
  # all — which under `set -e` killed this script before it killed anything.
  children=""
  for pid in $servers; do
    children="$children $( { pgrep -P "$pid" || true; } | tr '\n' ' ')"
  done

  for pid in $servers; do
    kill "$pid" 2>/dev/null && echo "stopping codex app-server (pid $pid)"
  done

  # Give them the chance to close threads and flush rollouts before forcing it.
  for _ in $(seq "$TERM_WAIT_SECS"); do
    still=$(pgrep -f "codex app-server --listen unix://$SOCK" || true)
    [ -z "$still" ] && break
    sleep 1
  done
  for pid in $(pgrep -f "codex app-server --listen unix://$SOCK" || true); do
    kill -9 "$pid" 2>/dev/null && echo "force-killed codex app-server (pid $pid)"
  done

  # Then the children it spawned — the ait MCP servers and code-mode hosts that
  # otherwise survive their parent and stay logged in to the network.
  for pid in $children; do
    kill -0 "$pid" 2>/dev/null || continue
    kill "$pid" 2>/dev/null && echo "  stopping its child (pid $pid)"
  done
  sleep 1
  for pid in $children; do
    kill -0 "$pid" 2>/dev/null || continue
    kill -9 "$pid" 2>/dev/null && echo "  force-killed its child (pid $pid)"
  done
fi

rm -f "$SOCK"

# The pidfile goes only when it names a process that is actually gone, and only
# for the shared socket. Two callers depend on that restraint:
#   - a wind-down of some other socket must not clear the shared server's file;
#   - bin/codex-session.sh backgrounds bin/run-codex-appserver.sh and writes the
#     new pid AFTERWARDS, so by the time this runs (from inside that wrapper,
#     before it execs) the file may already name the incoming server. Deleting
#     it there would make the next session think nothing was running and start
#     yet another.
if [ "$SOCK" = "$DEFAULT_SOCK" ] && [ -f "$PIDFILE" ]; then
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    rm -f "$PIDFILE"
  fi
fi
exit 0
