# Peer status from runtime evidence

Status: implementation · 2026-11-09 · one delivery slice

## Why

An operator needs to distinguish saved peer approval, an open direct application connection, an indexing consumer, and session presence. The installed PONG demonstrates one application round trip; status must describe its own observations precisely.

## Proposed work

Derive Linked from an approved peer's open DATA connection with an eligible direct path. Reuse that projection in status, Link results, logs, and retained-approval errors. Pairing CONTROL connections remain usable for pairing but cannot establish application connectivity. Successful Link reports saved approval plus its current runtime snapshot; concurrent Unlink returns approved:false and Unlinked. Keep indexing and presence separate; expose consumer reconnection using the subscription's existing lifecycle hooks. Startup waits through recoverable local reconnection and status displays it. Remove unconditional preparation/decline/failure claims. Clarify the CLI, agent tool descriptions, and current operator guide.

## Files touched

Runtime: peerNetwork.mjs and peerFeed.mjs. Reporting: peerPrepare.mjs, peerCli.mjs, bin/status.sh, mcp/src/server.ts, ait help. Regression scripts and README/two-Mac guide document the same contract.

## Out of scope

No persisted status, active probes, retry supervisor, delivery guarantees, identity migration, release, installed checkout edits, or live service restarts. Presence remains owner-reported registration, not process activity.

## Tests

Temporary native endpoints distinguish CONTROL from DATA and exercise close/unlink. Real CLI fixtures check decline, empty approvals and failed indexing. Feed websocket tests exercise reconnect and terminal state. Existing isolated two-PDS test verifies pairing, signed indexing and round trip. Builds and focused lifecycle/presence/readiness checks complete validation.

## Sequencing or rollout

Implement and validate in an isolated worktree, run systems and independent review, then present the tested change. Installing or releasing is a separate action.

## Rejected

Do not redefine pairing as application connectivity, infer delivery from Linked, or persist a second source of runtime truth. Do not probe peers during preparation or directory search.

## Sources

peerNetwork's three duplicated connection predicates and unconditional Link result; peerPrepare's unconditional final message; peerCli decline; status.sh fallback; peerFeed and Subscription reconnect implementation; temporary CONTROL-only and websocket-disconnect reproductions.

Spec checklist: 1) operator receives factual peer status; 2) consumer is ait status/link and existing profile tools; 3) evidence is temporary runtime/CLI tests plus real two-PDS flow. Questions 4–13: no unresolved finding. Systems check: four independent concepts (approval, direct DATA connectivity, importer lifecycle, registration presence); consolidate four connection claims into one projection rather than introducing a new state registry.
