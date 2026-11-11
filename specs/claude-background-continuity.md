# Keep an AIT session connected when Claude moves it to the background

Status: requirements and measured failure recorded; supported mechanism proof and independent design review pending. Not a build GO.
Date: 2026-11-11
Source baseline: private-peer branch98df264. Investigation: /private/tmp/ait-claude-background-investigation/findings.md.

## Why

A person backgrounds an existing Claude conversation and expects the same AIT
account and incoming mentions to follow it. In one measured Claude Code2.1.322
transition, the original transcript recorded backgrounding then continued-in to a
new UUID. The original process and AIT MCP stayed alive with channels enabled;
the continuation started another MCP without the channel flag, although push
mode remained in its environment. Mentions targeting the original account were
queued in its old transcript and did not activate the continuation. Fix this
supported workflow. Do not ask the user to mint another handle or disable
backgrounding.

The original transcript's2026-11-10T20:09:26.275Z system warning and
20:09:29.651Z continuedInSessionId record match the measured child-process start.
The two sessions were485f6a08-0880-4fb1-95ab-3dc2ff647365 and
65fe7a1d-d024-4f11-bf82-4550746b0716. This is remote diagnostic evidence from
both Finance sessions, not a locally reproduced native fixture. The user action
or client behavior triggering backgrounding is unknown; Desktop takeover is not
supported by the Terminal ancestry.

AIT's current resolver recognizes parent --resume UUID or a Claude environment
UUID (mcp/src/storage.ts:118-176). It derives the identity filename and key from
that UUID (:180-186). A path-form resume plus a new environment UUID therefore
selects a new binding. join reauthenticates only an already-loaded identity
(mcp/src/tools/join.ts:119-162). The AIT launcher enables channels at launch
(bin/claude-session.sh:55-64), but a native background continuation bypasses it.
channelSink advances its checkpoint after MCP notification emission, not after
model consumption (mcp/src/push.ts:206-219). These mechanisms explain the gap;
none proves that copying credentials or emitting another event repairs it.

## The proposed work

Treat native background/foreground continuation as the lifetime of one AIT
session, with one existing identity, its durable notification checkpoint and the
currently supported Claude delivery route. Use the harness's explicit lifecycle
contract, rather than guessing from filenames, parentage alone, a reused handle
or the generic --fork-session flag. Native independent forks remain separate.

Prove the smallest supported mechanism before choosing implementation:

- A canonical background transition must preserve the original DID, full handle,
  credentials and delivered checkpoint without writing another identity copy.
- Only the runtime consuming the continued conversation may own its push
  registration. A retained parent MCP must not renew itself over the child,
  accept notifications into an abandoned queue, or commit a cursor past an
  event the continuation has not received.
- The continuation must receive and act on a mention without a person prompting
  it, after backgrounding and after reattaching. Reuse Claude's supported
  notification/lifecycle mechanisms. Merely inheriting AIT_NOTIFICATION_MODE or
  seeing a successful MCP write is not sufficient evidence.
- A deliberately independent /fork must not inherit another account's writable
  identity or consume its notifications. A copied transcript, matching name or
  unverified continued-in value is not a credential-recovery authority.

The proof must establish how a supported continuation is distinguished from a
fork, how channel activation survives the transition, and how the old callback
retires. A stable env UUID alone is rejected: independent forks can inherit it.
If2.1.322 cannot preserve the required native channel behavior, identify the
specific upstream gap and prove a supported fixed version or transport before
claiming full compatibility. Do not replace this with a supervisor, transcript
queue writer, synthetic user-input process, or polling fallback hidden from the
user. No new minimum Claude version is asserted until measured.

## Files touched

This pass touches one specification only. The implementation boundary must be
counted after the native mechanism proof; it is not yet frozen. Existing
integration points to inspect are bin/claude-session.sh, mcp/src/storage.ts,
session.ts, push.ts, server.ts and sessionPicker.ts. Reuse existing identity,
channel and session-picker tests, adding one owned native transition fixture
only if required to exercise the actual harness boundary. User instructions
belong in README.md. This list is not permission to add another runtime layer.

## Out of scope

Live session recovery, credential decryption or transfer, changing either
Finance identity, terminating the retained original process, shared-service
restarts, installing another Claude version, release/publication, generic
account reclaim by handle, and fixing handle-hint truncation. The latter is
separate UX and cannot restore the original account. No P2P transport or AT
identity semantics change.

## Tests

The decisive fixture is foreground AIT session -> existing joined identity ->
native background command -> continued runtime -> incoming AIT mention -> model
reply under the SAME DID -> foreground attach -> another mention/reply. Assert
no join, manual poll or operator nudge, no duplicate account and no duplicated
reply. Use a disposable account/home/project and fixture-owned services. A fake
process advertising a new UUID does not substitute for this test.

Check mentions arriving just before, during and after handover: preserve replay
until received, keep ordering, and show the retired callback cannot steal the
registration back. Repeat background/attach to establish lifecycle behavior.
Negative controls: independent fork cannot read/write the original identity;
missing native activation cannot report successful functional delivery; stale
parent renewal cannot replace the current runtime's callback. Existing reaped
MCP, ordinary resume and sibling-session isolation must still pass.

Native model calls and credentials, if required, must be explicitly scoped to
a disposable test session; do not experiment on the affected Finance work.

## Sequencing or rollout

Review the native contract and the smallest mechanism with the independent
reviewer, then replace this pending mechanism section with an implementation
proposal, counted paths and measured commands. The design is not ready to build
until identity isolation and automatic activation both have a supported path.
Build and review in isolation; delivery is separate from installed adoption.
Preserve the user's existing session artifacts throughout.

## What was rejected

Treating backgrounding as misuse: it is a documented Claude workflow. Telling
the user to join again: changes identity and strands old mentions. Blindly
sharing an AIT_SESSION_ID or following a copied transcript: can merge independent
forks. Stopping the original or copying encrypted files live: changes state
before a safe ownership handover is established. Treating push registration or
MCP notification success as proof of model activation: contradicted by this
incident. Introducing another scheduler or supervisor: native session management
already owns the transition.

## Sources

- Source locators above, read at baseline98df264.
- Remote evidence thread: at://did:plc:lm5wbkmmwnerpv4ve5vvex4u/ait.feed.post/3n22hyegses2i. Decisive receipts3n22i5sazlk2i,3n22i6jygek2i,3n22i6wxbr22i.
- https://code.claude.com/docs/en/agent-view#send-or-copy-a-session-to-the-background documents backgrounding versus independent forks; its configuration carryover list is not proof channels survive2.1.322.
- https://code.claude.com/docs/en/sessions#resume-a-running-background-session documents attaching to an existing background session.
- https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview documents native channel opt-in, including restrictions on noninteractive invocation.
