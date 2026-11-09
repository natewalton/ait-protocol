# Show what Codex is loading and avoid returning unused history

Status: implementation approved for isolated build; independent code review pending.
Date: 2026-11-09

## Why

An operator waited 96 minutes for a legacy Codex session before cancelling. Its
201-byte driver log stopped at an independent identity message, leaving no record
of which startup request was pending. The underlying native stall is unresolved.
Fix the avoidable history transfer and missing progress, not an inferred native cause.

The driver awaits resume without excluding returned turns (host.ts:179), although
it consumes the returned thread id and launch settings rather than turns. It pins
new threads to legacy history (host.ts:203-208). The launcher reports a generic
wait unless the last log line is exactly the MCP readiness line
(bin/codex-session.sh:162-167), so unrelated identity output can hide the stage.

Owned native 0.166/0.167 fixtures proved paginated start, name persistence, resume
and TUI attach without inference. Omitting name persistence failed with no rollout
found on both versions. A 64MiB synthetic legacy fixture on 0.167 returned about
33.5MB in 1.3s on warm full resume, versus 1.7KB in 3ms with excludeTurns. This
measures avoidable transfer; it does not explain the reported 96-minute stall.

## The proposed work

Request metadata-only resume on every driver connection. Create new threads with
paginated history and retain name persistence before publishing readiness. Existing
legacy sessions remain resumable and keep their large-history TUI relay.

Before each asynchronous startup operation, log its stage: connecting, resuming a
named thread id, creating a thread, persisting its name, or checking MCP readiness.
The launcher's existing 30-second report uses the latest stage line even when an
identity message follows it. This reports waiting, not evidence of active progress.
No resume deadline, retry policy, shared-server restart or transcript rewrite is added.

## Files touched

Eight files: mcp/src/codex/host.ts (native requests and stage lines),
mcp/src/codex/appServerTypes.ts (native optional resume field),
bin/codex-session.sh (display stage), mcp/scripts/codex-recovery-test.mjs
(request and held-stage assertions), mcp/scripts/codex-rollout-resume-test.mjs
(real paginated driver contract), bin/ait-test.sh (launcher display), README.md
(operator behavior), and this spec. Three runtime files span driver/RPC and shell;
the systems check reuses native history modes and the existing reporting loop.

## Out of scope

The cause of the 96-minute native restore; migration or refusal of existing legacy
sessions; removing the legacy relay; remote presence reporting; changing deadlines,
notification delivery, shared-server management or the Codex 0.166.0 minimum.

## Tests

Build MCP; run codex-recovery-test.mjs and bin/ait-test.sh. Hold a production-driver
resume past the initialize deadline, assert excludeTurns and its stage before the
reply, then release it and assert readiness. Assert launcher progress survives
interleaved identity output. Run codex-rollout-resume-test.mjs with real 0.166 and
0.167: production start/resume keeps the same paginated thread; existing legacy
cases still pass. The already-run real PTY fixture proves zero-turn attach for
both versions. All fixtures use owned homes/endpoints and make no model turn.

## Sequencing or rollout

Build only in an isolated checkout. Obtain independent code/systems review before
integration. The installed stack and user histories remain untouched by this work.
New sessions become paginated after adoption; old histories keep their format.

## What was rejected

A blanket resume timeout/retry: disconnect does not cancel a started native
restore, so another attempt can queue behind it. Dropping name persistence: both
native binaries failed resume without it. Automatic migration and removal of the
legacy relay: rewrites require explicit consent and old histories still need
support. A GiB synthetic test alongside live sessions: unnecessary memory pressure.

## Sources

Source locators above refer to a72983c. Native schemas generated from 0.166/0.167
expose excludeTurns and historyMode. Official 0.167 source:
app-server/src/connection_rpc_gate.rs:31-45 (started work survives disconnect),
app-server/src/thread_processor.rs:4764-4788 (warm history read condition).
Owned evidence: /private/tmp/ait-resume-stall-investigation/large-legacy-results.json,
paginated-attach-166.json and paginated-attach-167.json.

Spec check: today the user receives a generic wait; the smallest fix is native
metadata requests plus existing stage reporting; users see the stage in ait resume
and new threads use native paginated history. Questions 4-13 found no outstanding
defect. No new lifecycle state or reporting timer is introduced.
