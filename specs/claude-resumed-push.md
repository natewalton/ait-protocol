# Restore push after resuming a previously continued conversation

Status: bounded code/systems review GREEN; isolated consumer and native proofs pass. Reported former-child activity still needs confirmation.
Date: 2026-11-19

## Why

An operator-observed original Claude UUID is running again, but its September
continued-in record makes isClaudeRuntimeCurrent return false. tryRegister exits
before registering, so tools work while automatic mentions remain unavailable.
Current claudeSession.ts:90-122 reads historical edges, and :233-241 treats any
edge as permanent runtime retirement. Fix this eligibility error.

## The proposed work

Keep historical continuation edges unchanged for account inheritance. Separate
that history from the lifetime of the Claude process that owns this MCP. A
valid native continuation timestamp strictly earlier than a verified Claude
parent's process-start second does not retire that newer process. A continuation
within or after that second retires it. Reconnecting MCP under an older Claude
parent must remain retired; unrelated transcript appends cannot reactivate it.

Retain the record target and timestamp together in the existing incremental
transcript cache. Read the parent process start once, using ps with English/UTC
output and an explicit parser, only after the existing parent command identifies
Claude. Unknown parent, failed measurement, missing/invalid/non-UTC native
timestamp retain conservative retirement. No arbitrary timing allowance.

The resumed user keeps the same AIT identity and receives backlog through the
existing 30-second registration/replay path. No identity copy or account change.

## Files touched

Three files: mcp/src/claudeSession.ts (eligibility and transcript metadata),
mcp/scripts/claude-background-test.mjs (real compiled MCP plus isolated process
metadata fixtures), and this spec. No transport, dependency or schema changes.

## Out of scope

Cross-Mac peer import failure is a separate investigation. Native background
channel activation, concurrent original and continued runtimes sharing an identity (including different UUIDs), missing native
timestamps, and same-second resume disambiguation are not solved here. This fix does not arbitrate two simultaneously active owners of the same DID; the reported case requires the former worker to be inactive. No live
restart, migration, installation or release is implied.

## Tests

Reproduce an old timestamped continued-in marker making a newly resumed parent
ineligible. Prove the corrected compiled MCP registers, emits a channel event and
commits under the same identity. Keep old-parent and MCP-reconnect retirement;
new handover during a write cannot commit. Test same-second, unknown/invalid
parent, missing/malformed timestamp, later unrelated lines, incremental append
and file replacement. Existing identity-chain, fork/conflict, push/channel and
picker tests remain passing. Removing the timestamp lifetime distinction must
fail the historical-resume case.

## Sequencing or rollout

Isolated worktree only. Systems and independent review before integration.
Both stable and peer share this Claude boundary; preserve variant differences.
Existing running MCPs need supported reload after a reviewed release; do not
modify or restart them during this investigation.

## What was rejected

Any later transcript line: bookkeeping does not prove an active runtime.
Unconditional --resume override: the retired original can retain that argv.
MCP birth time: a reconnect under the old Claude must not reclaim delivery.
Tool-call registration: the current eligibility predicate would still refuse.

## Sources

Installed claudeSession.ts:90-122,167-241; push.ts:145-178 and server.ts:257-262.
Native 2.1.326 continued-in ISO timestamp observed in the prior isolated
compatibility fixture result.json; current parent ps shows comm/command claude.
Independent design review requires verified parent identity, deterministic
second-precision parsing, conservative unknowns and unchanged historical lineage.

## Validation result

Build, full compiled background consumer, channel sink, push-mode and picker
PASS. Reverting runtime eligibility to permanent retirement fails the new
resumed-original case. Independent code/systems review accepts the bounded fix.
An owned real Claude 2.1.328 + actual AIT MCP probe passed native backgrounding,
stopped child, then original-UUID resume with a later verified Claude parent
and eligibility=true. Local model API stub, scratch HOME/config; no account
credentials or live AIT data were used. The initial sandboxed native probes
could not measure the parent through ps and remained conservatively retired;
the explicit parent-measurement proof ran outside that test sandbox. Native
authenticated channel-to-model delivery remains unproved. No installation or
service restart occurred. Evidence /private/tmp/ait-claude-resume-native-evidence.
The current predicate explains present registration refusal; its Nov17 install
postdates the reported last push, so the original silence is not fully explained.
