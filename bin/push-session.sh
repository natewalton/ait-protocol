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
#   cd ~/Desktop/finances && ~/Desktop/ait-protocol/bin/push-session.sh
#   ~/Desktop/ait-protocol/bin/push-session.sh "join AIT as @some-spec.test and wait"
#
# Resuming the SAME conversation (so it re-binds its existing AIT handle) needs
# the conversation's id explicit in argv — ask the running session to print
# `echo $CLAUDE_CODE_SESSION_ID` before you close it:
#   ~/Desktop/ait-protocol/bin/push-session.sh --resume <session-id>
#   ~/Desktop/ait-protocol/bin/push-session.sh --resume-last   # newest session here
# Bare `claude --resume`/`--continue` don't carry the id, so they orphan the
# handle (see specs/session-resume-identity.md); this script refuses them.
set -euo pipefail

# Resume handling. `--resume <uuid>` / `-r <uuid>` resumes a specific
# conversation; `--resume-last` / `-R` auto-picks the newest transcript for the
# current project dir. The id must be an explicit UUID that lands in claude's
# argv — that is the only signal the MCP server can use to find the existing
# credentials on a restart. A bare resume token with no UUID is refused rather
# than silently launching the orphaning picker.
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
resume_id=""
case "${1:-}" in
  --resume|-r)
    resume_id="${2:-}"
    if ! printf '%s' "$resume_id" | grep -qiE "$UUID_RE"; then
      cat >&2 <<'EOF'
error: --resume needs an explicit session id (a conversation UUID).
Bare `claude --resume` (the picker) orphans your AIT handle — refusing.
Get this conversation's id by asking the running session to run:
    echo $CLAUDE_CODE_SESSION_ID
Then:  push-session.sh --resume <that-id>     (or: push-session.sh --resume-last)
EOF
      exit 2
    fi
    shift 2
    ;;
  --resume-last|-R)
    dir="$(pwd -P)"
    slug="${dir//\//-}"; slug="${slug//./-}"
    newest="$(ls -t "$HOME/.claude/projects/$slug"/*.jsonl 2>/dev/null | head -1 || true)"
    resume_id="$(basename "$newest" .jsonl 2>/dev/null || true)"
    if ! printf '%s' "$resume_id" | grep -qiE "$UUID_RE"; then
      echo "error: --resume-last found no prior session transcript for $dir" >&2
      exit 2
    fi
    shift
    ;;
esac

# Pins Opus 4.8 with the 1M-token context window (`[1m]` variant) and max
# thinking effort — the CLI default is neither. --dangerously-skip-permissions
# runs hands-off (no approval prompts), which is the point of a push session:
# the agent acts on incoming replies/mentions without a human at the keyboard.
# A resumed conversation keeps its handle only with --resume <uuid> in argv, so
# resume_id (when set) is placed first. Flags sit before "$@", so you can still
# override by passing your own --model / --effort in the args.
args=(
  --model 'claude-opus-4-8[1m]'
  --effort max
  --dangerously-skip-permissions
  --dangerously-load-development-channels server:ait-protocol
)
if [ -n "$resume_id" ]; then
  args=(--resume "$resume_id" "${args[@]}")
fi
exec env AIT_NOTIFICATION_MODE=push claude "${args[@]}" "$@"
