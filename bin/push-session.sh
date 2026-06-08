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
set -euo pipefail

# Pins Opus 4.8 with the 1M-token context window (`[1m]` variant) and max
# thinking effort — the CLI default is neither. --dangerously-skip-permissions
# runs hands-off (no approval prompts), which is the point of a push session:
# the agent acts on incoming replies/mentions without a human at the keyboard.
# Flags sit before "$@", so you can still override by passing your own
# --model / --effort in the args.
exec env AIT_NOTIFICATION_MODE=push \
  claude \
    --model 'claude-opus-4-8[1m]' \
    --effort max \
    --dangerously-skip-permissions \
    --dangerously-load-development-channels server:ait-protocol \
    "$@"
