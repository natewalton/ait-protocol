# Keep AIT Codex launches current and unrestricted

Status: Implemented

Date: 2026-09-23

Codex behavior: 10 files (`README.md`, `bin/run-codex-appserver.sh`, `bin/run-codex-appserver-test.sh`, `bin/ait-test.sh`,
`mcp/src/codex/host.ts`, `mcp/src/codex/appServerTypes.ts`,
`mcp/src/codex/appServerClient.ts`,
`mcp/scripts/codex-rollout-resume-test.mjs`,
`mcp/scripts/codex-recovery-test.mjs`, and this spec)

Development safety documentation: `AGENTS.md` and
`docs/developing-alongside-installed-ait.md`.

## Why

An AIT Codex session should show GPT-6 Sol with medium reasoning and full access
in the Codex TUI. The launcher instead pins GPT-5.6 Sol at
`bin/run-codex-appserver.sh:51-55`. The driver requests `never` approval and
`danger-full-access` at `mcp/src/codex/host.ts:108-121`, but the mirrored response
at `mcp/src/codex/appServerTypes.ts:53-65` previously omitted the effective
settings, so AIT could not detect a constrained-config downgrade.

AIT also starts v2 turns but handles only the legacy `execCommandApproval` and
`applyPatchApproval` requests at `mcp/src/codex/appServerClient.ts:442-458`.
Codex 0.155.1 and 0.156.1 send v2 command and file approvals as
`item/commandExecution/requestApproval` and
`item/fileChange/requestApproval`. An unexpected approval would therefore get
an unmodeled-method error instead of AIT's deliberate refusal.

The crude change is to update only the app-server model flag. That is
insufficient because an already-running server does not reread its launcher
command. Making the settings explicit on every thread start and resume reaches
the user-visible TUI without requiring AIT to restart active sessions.

Isolated protocol probes against both releases showed that each accepts the
GPT-6 Sol model identifier, medium reasoning, `approvalPolicy: never`, and
`sandbox: danger-full-access`. The existing rollout and MCP-readiness path also
passes against both releases. The thread, turn, history, and readiness methods
AIT uses did not drift between the releases. These probes make no model turn:
0.155.1 does not list GPT-6 Sol in its TUI model catalog, so this does not
establish model execution on that older binary. The installed 0.156.1 binary
does list it.

Verdict: update the launch contract and verify its effective response. Do not
build a Codex version manager or restart active sessions.

## The proposed work

Make GPT-6 Sol with medium reasoning explicit both on the shared app-server and
on each new or resumed AIT thread. Keep the existing full-permission request.
Before exposing a thread to the TUI, require Codex's response to report the
expected model, reasoning effort, approval policy, and sandbox. A mismatch
prints `Codex did not apply the AIT launch contract (...)` in the terminal and
refuses to attach. Handle both current v2 approval names with the same
fail-closed behavior as the legacy names.

## Files touched

- `bin/run-codex-appserver.sh` changes the shared default to GPT-6 Sol.
- `README.md` states the model, reasoning, and permission contract operators get.
- `mcp/src/codex/host.ts` sends and checks the complete thread contract.
- `mcp/src/codex/appServerTypes.ts` mirrors the response fields AIT checks.
- `mcp/src/codex/appServerClient.ts` recognizes current v2 approval requests.
- `mcp/scripts/codex-rollout-resume-test.mjs` exercises the contract on the real binary.
- `mcp/scripts/codex-recovery-test.mjs` exercises the current approval responses.
- `bin/ait-test.sh` checks the shared launcher default.
- `bin/run-codex-appserver-test.sh` keeps its launcher fixture away from the installed instance's PID file.
- This spec records the audit and boundary.

## Out of scope

- Managing or automatically restarting the shared app-server after a Codex CLI
  upgrade. Restarting remains the normal way to replace its in-memory binary;
  it is not protocol drift and would disconnect active sessions.
- Supporting arbitrary older Codex releases. This audit covers 0.155.1 and
  0.156.1, the last two installed/public release lines requested.
- Changing notification, transcript, identity, or resume storage.

## Tests

1. Build the MCP.
2. Run `mcp/scripts/codex-rollout-resume-test.mjs` against Codex 0.155.1 and
   0.156.1. Both must report the expected effective launch contract and pass the
   existing rollout/readiness checks.
3. Run `mcp/scripts/codex-recovery-test.mjs` and verify the current v2 command
   and file approval requests receive `decline` while additional-permission
   requests fail closed.
4. Run `bin/ait-test.sh` and `bin/run-codex-appserver-test.sh`.
5. Run shell syntax checks on the changed shell files.

## Sequencing or rollout

Ship through the normal AIT release path. Existing sessions keep their current
in-memory settings. Newly launched or resumed sessions use and verify the new
contract without requiring the shared server to restart.

## What was rejected

- Trust only the app-server command line: rejected because a long-lived server
  can predate the installed launcher.
- Pass flags only to the remote TUI: rejected because current Codex deliberately
  restores the server thread's saved permissions on remote resume.
- Add version-specific branches: rejected because both audited releases accept
  the same supported protocol fields.

## Sources

- OpenAI Codex tags `rust-v0.155.1` and `rust-v0.156.1`, generated app-server
  TypeScript bindings and TUI remote-resume source. The current v2 request names
  are declared at `codex-rs/app-server-protocol/src/protocol/common.rs:1754-1788`
  in both tags.
- `bin/run-codex-appserver.sh`, `mcp/src/codex/host.ts`, and
  `mcp/src/codex/appServerTypes.ts` at repository parent `333e6e9`.
- Official OpenAI reasoning documentation: GPT-6 Sol defaults to and supports
  medium reasoning effort.
