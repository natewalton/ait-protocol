# Restore automatic mentions after resuming Claude

Status: implementation and systems review GREEN; awaiting independent AIT review.
Date: 2026-11-19

## Why

The reported original UUID resumed after a historical continued-in record, but
claudeSession.ts treated that edge as permanent retirement. Tools worked while
tryRegister skipped automatic mentions. The initial timestamp-only candidate
0633392 is NOT releasable: native Claude permits the original and continued
worker to coexist; the compiled consumer measured both renewing the same DID.
Fix delivery ownership, not just the historical-record exception.

## The proposed work

Keep native continuation records for identity inheritance. Use the owning Claude
process's verified birth time to distinguish historical edges from a handover
in its current lifetime. MCP reconnect time never grants ownership.

Before registering, publish one immutable local delivery claim for the DID in
the existing ait-mcp data directory. Exclusive publication of a complete checkpoint document is atomic; no mutable
ownership lock is introduced. Its activation epoch is the later
of verified parent birth and the matching native inbound handover timestamp.
That native event orders a background handover within one process-birth second.
A reconnect reuses the claim for the same parent PID, birth and runtime UUID.

Every registration and channel/cursor gate reads the greatest published claim.
Only that owner may deliver. Distinct owners tied at the greatest epoch fail
closed; a later activation can supersede the tie. Retain claims: deleting an old
maximum could revive an earlier worker. No process-death fallback or new timer.
Unjoined sessions keep waiting for identity; joined push runtimes with unknown
parent evidence or malformed/inaccessible claims cannot claim delivery. Existing
tool results explain unavailable automatic mentions and preserve polling.

A newer original resume fences its still-running continued worker. The older
worker cannot win by reconnecting MCP, renewing heartbeat, or surviving a newer
owner's crash. Identity credentials keep their existing file; no account is copied or rebound.
Each activation owns an atomic checkpoint payload under its immutable claim name.
A successor inherits the previous winner’s checkpoint; stale workers can rewrite
only their own claim. Credential refresh cannot roll back delivered progress.
Once claims exist, their checkpoint is authoritative, including an explicit empty
checkpoint that replays the durable backlog rather than trusting stale credentials. AppView restart does not
erase local ownership evidence.

Registration is eventually convergent, not an atomic remote fence: an old HTTP
registration can already be in flight when a new claim appears. Its sink must
reject delivery and cannot commit a late response. Existing AppView matching-URL
cleanup and the winning owner's next 30-second heartbeat restore delivery from
the durable backlog. No loss and no manual worker shutdown are required.

## Files touched

Eleven files: mcp/src/claudeSession.ts (native context),
mcp/src/claudeDelivery.ts (delivery ownership and checkpoint persistence),
mcp/src/storage.ts (checkpoint authority independent of credential writes),
mcp/src/push.ts (claim before registration), mcp/src/server.ts (unavailable-push
warning), mcp/scripts/claude-background-test.mjs (existing lifecycle regressions),
mcp/scripts/channel-sink-test.mjs (awaited-write fencing),
mcp/scripts/claude-delivery-owner-test.mjs (adversarial real consumer journey),
.github/workflows/security.yml and .github/workflows/release.yml (required gate),
and this spec. No server protocol, schema, dependency or AppView runtime changes.

## Out of scope

The separate cross-Mac oversized historical-record import failure is not fixed.
Native background Channel activation is not added; poll-only workers remain poll.
Claims coordinate upgraded runtimes sharing the same local AIT data directory;
old in-memory MCPs and deliberately separate storage namespaces do not gain the
new protocol retroactively. Missing process metadata and indistinguishable exact
activation ties remain visibly unavailable rather than guessing an owner.
No automatic installation, session restart or historical data rewrite.

## Tests

Build AppView and MCP. Preserve all existing background, channel, push and picker
fixtures. Reverting permanent retirement fails the historical-resume case.
Verify original A to continued B within one birth second, then newer original A2
while B remains live. Old-parent MCP reconnect cannot regain delivery; current
parent reconnect reuses its token. Test both publication orders, exact ties,
malformed/unreadable state, latest-owner crash and AppView restart.

Use compiled real MCPs and the actual AppView registry/SQLite notification query
for held old registration released after the winner registers. Prove only the
winner emits and commits the queued URI after heartbeat replay. Keep ownership
checks before and after awaited channel writes; old late completion cannot commit.
Also pause an actual credential rewrite before rename, deliver and persist a
notification, then release that stale rename. The next registration must retain
the delivered cursor. Negative controls must detect missing ownership fencing
and reverting delivery checkpoint authority to the credentials file.

Native evidence already shows real Claude 2.1.328 permits simultaneous original
and continued runtimes, and that parent birth can be measured on the supported
native launch. Local model stub/scratch config only. Test-only sandbox blocks ps,
so that run conservatively refused; native parent proof ran outside that sandbox.
Native authenticated Channels-to-model delivery is not claimed by offline tests.

## Sequencing or rollout

Iterate systems review to GREEN, then request the actual AIT skills-dev session's
independent review, as Nate instructed. Only after both gates pass integrate into
main and peer through required checks and publish via prepare, inspected draft,
then publish and anonymous readback. Keep peer numbering continuous. Supported
update/reload gives running MCPs the change; no live update is authorized here.

## What was rejected

Any later transcript line and unconditional --resume: neither establishes one
current owner. MCP birth: reconnect under an older Claude must not steal delivery.
Timestamp-only eligibility: confirmed competing callbacks. Tool-call registration
or faster heartbeat: amplifies contention. Mutable local ownership with a
home-grown lock: adds crash recovery. AppView owner/schema changes: unnecessary
for local delivery eligibility and would not work against an older installed
AppView. Automatic claim deletion: risks reviving a superseded process.

## Sources

claudeSession.ts historical edge reader/identity resolver; push.ts tryRegister
and channelSink; AppView pushRegistry.ts registerAndReplay and matching-URL drop.
Measured initial blocker: /private/tmp/ait-claude-overlap-systems.log (5/4 renewals)
and /private/tmp/ait-claude-resume-native-evidence/active-child-review.log.
