# Sourced, never run directly.
#
# Who is running one checkout's MCP server.
#
# A harness session runs that file, so its own program is node, and the program
# rather than the whole line decides. Matching the path anywhere on a command
# line counted the codex app-server as a session, because it names that path
# inside its own -c arguments; it also counted this classifier's own awk and the
# shell that invoked it, both of which carry the path.
#
# A Claude Code spare is claude started with bg-spare as its first argument: a
# prewarmed process holding an MCP child that no session is using. Nobody can
# exit a spare, so telling someone to close their sessions is a dead end; it is
# reported apart from real sessions instead. The marker is read from that one
# argument, not from anywhere in the row, so a session whose prompt text says
# bg-spare is not mistaken for one. An unrecognized parent reads as a session,
# which refuses rather than proceeds.
#
# Prints one line per holder: "session <pid>" or "spare <parent pid>".
mcp_holders() {
  local repo="$1"
  ps -ax -o pid=,ppid=,command= | awk -v needle="$repo/mcp/dist/server.js" '
    { parent[$1] = $2; prog[$1] = $3; first_arg[$1] = $4 }
    $3 ~ /(^|\/)node$/ && index($0, needle) { holder[$1] = 1 }
    END {
      for (pid in holder) {
        par = parent[pid]
        if (prog[par] ~ /(^|\/)claude$/ && first_arg[par] == "bg-spare") print "spare", par
        else print "session", pid
      }
    }
  '
}

# " 4242 4300" — leading space, so a message can read "…checkout:$(...)".
mcp_session_pids() { printf '%s\n' "$1" | awk '$1 == "session" { printf " %s", $2 }'; }

# "11571 11999" — plain, for a kill command.
mcp_spare_pids() {
  printf '%s\n' "$1" | awk '$1 == "spare" { print $2 }' | sort -u | tr '\n' ' ' | sed 's/ *$//'
}
