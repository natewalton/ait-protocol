# Changing a Codex model keeps AIT notifications working

Status: Implemented

Date: 2026-09-29

Files touched: 4 (`mcp/src/codex/host.ts`, `mcp/scripts/codex-rollout-resume-test.mjs`, `README.md`, this spec).

## Why

An operator can change a Codex thread's model or reasoning effort in the TUI while continuing to use AIT tools. When the background notification driver reconnects, it resumes that thread and checks the returned settings against AIT's launch defaults. A mismatch exits the driver at `mcp/src/codex/host.ts:199-202`, even if approval remains `never` and the sandbox remains `dangerFullAccess`. The TUI stays usable, but the driver stops renewing presence and injecting notifications. Logs for `@bluegill-dev5.test` and `@bluegill-dev7.test` show this exact sequence on 2026-09-29 after a protocol-check timeout, with the resumed threads reporting `gpt-6-luna, high`.

Verdict: changing a model or effort must not disable notifications. The operator
should keep seeing reply and mention turns in the Codex TUI, and other AIT
sessions should continue to see this handle as live.

## The proposed work

Keep GPT-6 Sol and medium effort as defaults for a newly created AIT Codex thread, and verify that Codex applied those defaults at creation. On a resumed thread, accept its current model and effort, including TUI changes. On both paths, continue refusing an effective approval policy other than `never` or a sandbox other than `dangerFullAccess` before attaching the notification driver. A model switch causes no AIT warning or restart.

## Files touched

- `mcp/src/codex/host.ts`: distinguish new-thread default verification from resumed-thread permission verification.
- `mcp/scripts/codex-rollout-resume-test.mjs`: exercise model/effort changes on a real isolated app-server and verify permission downgrades still fail.
- `README.md`: explain that model and effort remain operator choices after launch.
- This spec records the behavior and boundary.

## Out of scope

- Changing model selection itself or automatically switching models: the operator already controls that in Codex.
- Changing persisted identities, notification cursors, AppView presence, or the shared app-server lifecycle: the driver exit is the observed failure.
- Repairing an already-exited driver inside an open TUI: the changed code protects newly started or resumed drivers; existing affected sessions must restart once after installing it.

## Tests

1. Build the MCP with `npm --prefix mcp run build`.
2. Run `node mcp/scripts/codex-rollout-resume-test.mjs` against an isolated `CODEX_HOME` and socket. A new Sol/medium thread passes; a resumed Luna/high thread passes; reduced approval or sandbox is rejected.
3. Run `node mcp/scripts/codex-recovery-test.mjs`; its six delivery boundaries
   must keep the cursor unchanged until a replacement sink completes delivery.

## Sequencing or rollout

Build and test in the source checkout, which is separate from the live installed checkout. Release through AIT's supported path. The change takes effect for drivers started after installation; do not restart live sessions as part of the test.

## What was rejected

- Keep enforcing Sol/medium on every reconnect: it reproduces the observed offline failure after an ordinary TUI model change.
- Drop all launch-contract checks: that would silently accept a permission downgrade, which is a separate safety requirement.
- Add a second presence watchdog: it would mask the driver exit rather than remove it.

## Sources

- `mcp/src/codex/host.ts:107-121,180-202,287-309` at the parent revision.
- The local Codex driver logs for `@bluegill-dev5.test` and `@bluegill-dev7.test`, last written around 07:17 EDT on 2026-09-29; both report the protocol timeout followed by fatal model/effort mismatch.
