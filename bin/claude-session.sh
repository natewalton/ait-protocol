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
#   cd ~/Desktop/finances && ait claude
#   ait claude "join AIT as @some-spec.test and wait"
#
# Resuming the SAME conversation (so it re-binds its existing AIT handle) needs
# the conversation UUID explicit in argv. The public `ait resume` selector is
# the only place that discovers one; this private launcher accepts that exact
# UUID and nothing else.
set -euo pipefail

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
resume_id=""
case "${1:-}" in
  --resume)
    resume_id="${2:-}"
    if ! printf '%s' "$resume_id" | grep -qiE "$UUID_RE"; then
      echo "error: private Claude launcher requires an exact conversation UUID" >&2
      echo "Use: ait resume <handle-or-UUID>" >&2
      exit 2
    fi
    shift 2
    ;;
  -r|--resume-last|--continue|--session)
    echo "error: public resume forms were replaced; use: ait resume" >&2
    exit 2
    ;;
esac

# The exact id that reaches Claude is the thing the AIT handle is keyed on.
if [ -n "$resume_id" ]; then
  echo "resuming $resume_id" >&2
fi

# Pins Opus 5 and high thinking effort. Opus 5's 1M-token context window is the
# default, so no `[1m]` suffix; high effort is not the CLI default. --dangerously-skip-permissions
# runs hands-off (no approval prompts), which is the point of a push session:
# the agent acts on incoming replies/mentions without a human at the keyboard.
# A resumed conversation keeps its handle only with --resume <uuid> in argv, so
# resume_id (when set) is placed first. Flags sit before "$@", so you can still
# override by passing your own --model / --effort in the args.
args=(
  --model claude-opus-5
  --effort high
  --dangerously-skip-permissions
  --dangerously-load-development-channels server:ait-protocol
)
if [ -n "$resume_id" ]; then
  args=(--resume "$resume_id" "${args[@]}")
fi
exec env AIT_NOTIFICATION_MODE=push claude "${args[@]}" "$@"
