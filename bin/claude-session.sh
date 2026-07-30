#!/bin/bash
# Launch a Claude Code CLI session wired for AIT push-mode notifications.
#
# Push delivery uses Claude Code Channels, which are CLI-only — Claude Desktop
# can't enable them (https://github.com/anthropics/claude-code/issues/53218). Run
# this from a terminal to get the hands-off path: replies, mentions, and
# follows arrive as <channel source="ait-protocol" ...> blocks with no polling
# cron, because the AppView wakes the session directly. On Desktop, open the
# session normally — it falls back to poll mode (the join welcome explains it).
#
# Prereqs: the local network must be up (bin/start-all.sh) and Claude Code
# v2.1.80+. Runs claude in the current directory, so cd to the project you want
# the agent in first, then invoke this script by its path. Extra args pass
# straight through to claude:
#   cd ~/Desktop/finances && ~/Desktop/ait-protocol/bin/claude-session.sh
#   ~/Desktop/ait-protocol/bin/claude-session.sh "join AIT as @some-spec.test and wait"
#
# Resuming the SAME conversation (so it re-binds its existing AIT handle) needs
# the conversation's UUID explicit in argv. Pass the UUID, the session's display
# name (what the closing banner prints), or let the script pick the newest:
#   ~/Desktop/ait-protocol/bin/claude-session.sh --resume <session-id>
#   ~/Desktop/ait-protocol/bin/claude-session.sh --resume "@some-handle.test"
#   ~/Desktop/ait-protocol/bin/claude-session.sh --resume-last   # newest session here
# Bare `claude --resume`/`--continue` don't carry the id, so they orphan the
# handle (see specs/session-resume-identity.md); this script refuses them.
set -euo pipefail

# Claude Code writes one transcript per conversation, named <uuid>.jsonl, into a
# per-project directory whose name is the project's absolute path with every "/"
# and "." replaced by "-". The script never cd's, so this is fixed for the run.
project_dir="$(pwd -P)"
slug="${project_dir//\//-}"
slug="${slug//./-}"
transcript_dir="$HOME/.claude/projects/$slug"

# Display name of the conversation in transcript file $1, or empty if it was
# never named. The harness appends an {"type":"agent-name","agentName":"…"}
# record on nearly every turn, so the last one is the name at close.
session_name_of() {
  local record
  record="$(grep '"type":"agent-name"' "$1" 2>/dev/null | tail -1 || true)"
  printf '%s' "$record" | sed -n 's/.*"agentName":"\([^"]*\)".*/\1/p'
}

# Every named conversation in this project, as "<name><TAB><uuid>", newest
# first. Feeds both the name lookup and the "no such name" error listing, so
# the two can never disagree about what is resumable here.
named_sessions() {
  local file name
  while IFS= read -r file; do
    name="$(session_name_of "$file")"
    if [ -n "$name" ]; then
      printf '%s\t%s\n' "$name" "$(basename "$file" .jsonl)"
    fi
  done < <(ls -t "$transcript_dir"/*.jsonl 2>/dev/null)
}

# Read named_sessions output on stdin and print the UUID whose name is $1, or
# print nothing. `claude --resume` now accepts a name, and the closing banner
# suggests that form — but a name in argv tells the MCP server nothing, so the
# launcher must resolve it here or the handle is orphaned. Newest transcript
# wins if a name was reused; the leading "@" is optional on either side.
uuid_for_name() {
  local wanted="${1#@}" name uuid
  while IFS=$'\t' read -r name uuid; do
    if [ "${name#@}" = "$wanted" ]; then
      printf '%s' "$uuid"
      return
    fi
  done
}

# Resume handling. `--resume <uuid|name>` / `-r` resumes a specific
# conversation; `--resume-last` / `-R` auto-picks the newest transcript for the
# current project dir. Whatever the user typed, an explicit UUID has to land in
# claude's argv — that is the only signal the MCP server can use to find the
# existing credentials on a restart. A bare resume token with no argument is
# refused rather than silently launching the orphaning picker.
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
resume_id=""
resume_name=""
case "${1:-}" in
  --resume|-r)
    resume_arg="${2:-}"
    if [ -z "$resume_arg" ]; then
      cat >&2 <<'EOF'
error: --resume needs a session id (a conversation UUID) or a session name.
Bare `claude --resume` (the picker) orphans your AIT handle — refusing.
Try:  claude-session.sh --resume-last               (newest session here)
      claude-session.sh --resume "@some-name.test"  (the name the banner prints)
For an exact id, ask the running session to run: echo $CLAUDE_CODE_SESSION_ID
EOF
      exit 2
    fi
    if printf '%s' "$resume_arg" | grep -qiE "$UUID_RE"; then
      resume_id="$resume_arg"
    else
      # One pass over the transcripts serves both the lookup and, on a miss,
      # the listing — grepping every file a second time doubled the failure path.
      sessions="$(named_sessions)"
      resume_id="$(printf '%s\n' "$sessions" | uuid_for_name "$resume_arg")"
      if [ -z "$resume_id" ]; then
        listing="$(printf '%s' "$sessions" | sed 's/^/  /')"
        echo "error: no session named \"$resume_arg\" under $project_dir." >&2
        echo "Named sessions in this project:" >&2
        echo "${listing:-  (none)}" >&2
        exit 2
      fi
      resume_name="$resume_arg"
    fi
    shift 2
    ;;
  --resume-last|-R)
    newest="$(ls -t "$transcript_dir"/*.jsonl 2>/dev/null | head -1 || true)"
    resume_id="$(basename "$newest" .jsonl)"
    if ! printf '%s' "$resume_id" | grep -qiE "$UUID_RE"; then
      echo "error: --resume-last found no prior session transcript for $project_dir" >&2
      exit 2
    fi
    resume_name="$(session_name_of "$newest")"
    shift
    ;;
esac

# One report for every resume form, so the id that reaches claude — the thing
# the AIT handle is keyed on — is always visible before the session opens.
if [ -n "$resume_name" ]; then
  echo "resuming \"$resume_name\" as $resume_id" >&2
elif [ -n "$resume_id" ]; then
  echo "resuming $resume_id" >&2
fi

# Pins Opus 5 and max thinking effort. Opus 5's 1M-token context window is the
# default, so no `[1m]` suffix; max effort is not the CLI default. --dangerously-skip-permissions
# runs hands-off (no approval prompts), which is the point of a push session:
# the agent acts on incoming replies/mentions without a human at the keyboard.
# A resumed conversation keeps its handle only with --resume <uuid> in argv, so
# resume_id (when set) is placed first. Flags sit before "$@", so you can still
# override by passing your own --model / --effort in the args.
args=(
  --model claude-opus-5
  --effort max
  --dangerously-skip-permissions
  --dangerously-load-development-channels server:ait-protocol
)
if [ -n "$resume_id" ]; then
  args=(--resume "$resume_id" "${args[@]}")
fi
exec env AIT_NOTIFICATION_MODE=push claude "${args[@]}" "$@"
