# Resume a session with its selected model

Status: Implemented

Date: 2026-09-29

Files touched: 7 (`bin/claude-session.sh`, `mcp/src/codex/host.ts`, `bin/ait-test.sh`, `mcp/scripts/codex-rollout-resume-test.mjs`, `README.md`, `VERSION`, this spec).

## Why

AIT's launch defaults should apply when starting a session, not when returning to one. The Claude launcher currently sends `--model claude-opus-5-5 --effort high` with `--resume` (`bin/claude-session.sh:50-63`). The Codex driver currently sends Sol/medium settings with `thread/resume` (`mcp/src/codex/host.ts:108-121,181,274-281`). Both can override a model the operator selected in the resumed conversation; the operator has observed this in the Codex TUI after restarting `@bluegill-dev5.test` and `@bluegill-dev7.test`. Fix this so the model shown in a resumed Claude or Codex TUI is the conversation's last selection without changing AIT's new-session defaults.

## The proposed work

Send default model and effort only when creating a new Claude conversation or Codex thread. On resume, omit model and effort overrides so the harness can restore its own settings. Claude Code may apply its separate effort-setting rules; AIT does not promise to persist a session-only effort choice. Continue sending AIT's permission, channel, and per-session identity settings. Do not add model storage or a new CLI flag.

## Files touched

- `bin/claude-session.sh`: omit model and effort flags for an exact UUID resume.
- `mcp/src/codex/host.ts`: omit model and reasoning-effort overrides from thread resume, retaining them on thread start.
- `bin/ait-test.sh`: check Claude new and resumed launcher arguments.
- `mcp/scripts/codex-rollout-resume-test.mjs`: check an isolated real Codex app-server restores a thread created with a different model and effort.
- `README.md`: describe the new-session default and resume behavior.
- `VERSION`: identify the patch release carrying the change.
- This spec: record the scope and acceptance.

## Out of scope

- Migrating saved conversations or storing model choices in AIT: the harness already owns them.
- Changing permission or sandbox requirements: they apply on both new and resumed sessions.
- Restarting any live session to test the change: isolated launchers and app-server suffice.

## Tests

Run `bash bin/ait-test.sh`, `npm --prefix mcp run build`, and `node mcp/scripts/codex-rollout-resume-test.mjs`. The Claude test must show defaults only on a new launch; the Codex test must show the resumed model and effort come from the saved thread even when the isolated server has Sol/medium defaults, with the permission contract intact.

## Sequencing or rollout

Build and test in the source checkout, separate from the installed live checkout. Release through the supported workflow. Existing sessions adopt this behavior when restarted against the updated installation.

## What was rejected

- Add an AIT model cache: it duplicates harness state and can drift.
- Keep sending defaults on resume and merely accept a different response: it can still request a model switch on the next turn.

## Sources

- `bin/claude-session.sh:50-63`, `mcp/src/codex/host.ts:108-121,181,274-281` at the parent revision.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): a resume request with a different model can apply a model-switch instruction on the next turn.
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference): `--model` selects the current session model; `--effort` overrides its current effort.
