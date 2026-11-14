# Report when local indexing has caught up

Status: design GREEN; stale replay and transient-I/O review corrections under validation.
Date: 2026-11-14

## Why

Main server.ts:63-84 starts localFeed without waiting and :96-100 always returns
HTTP200. A fresh or restarted main can report healthy before its retained PDS
history is projected, and its indexer callback catches projection errors (:68-76).
Fix the reporting and startup barrier; do not change retained-history policy.

The installed pinned PDS subscribeRepos handler emits OutdatedCursor for seq0
when its first event is older than the configured backfill window (default one
day). An owned runtime invocation of that native handler with a 48h event and
24h window returned OutdatedCursor. This was a handler/sequencer-stub proof, not
a live-service probe. A revision barrier must report that gap, not promise full
history or silently succeed.

## The proposed work

Keep one bootstrap mechanism in main localFeed: open the bounded subscription,
then read standard paginated listRepos and listRecords for the three AIT
collections from the configured local PDS. Upsert only through the existing
indexer; never sweep absent rows. Bootstrap calls handleEvent(db,event) without
its optional resolver, so historical records retain durable notification rows
without notifyInsert pushes. Live stream calls keep the resolver/cache. This
uses the existing local unauthenticated trust, not new peer or CAR verification.

Do not interleave snapshot and stream projection. Retain the first queued read
and let the existing bounded WebSocket stream apply backpressure during bootstrap;
then process events serially in sequence order. No unbounded event queue is added.
Newer updates/deletes queued during bootstrap apply afterward and win. For each
active DID, keep ONE reconciliation entry with its snapshot revision and any
later target. Compare listRepos revision with getRepoStatus after the snapshot:
an unchanged revision proves coverage; a changed revision remains in one target
map until a complete commit at that revision or newer is projected.

Every queued commit is fully bounded/validated before filtering. Its envelope
CID/DID/rev must match the parsed CAR root, using existing sync/common primitives
without adding signature requirements to main. Covered commits at or below the
snapshot revision advance the cursor but perform no writes. This prevents stale
updates and old deletes overwriting recreated current records. Covered deletes
do not sweep retained rows absent from the snapshot; newer live deletes still
apply. This is explicit preservation, not a new cache-cleanup policy.

Account events have no commit revision. They read the current local PDS
getRepoStatus before updating active/status; an exact authoritative RepoNotFound
makes that account inactive/deleted without deleting records or stopping siblings.
Identity events retain main's cache invalidation/current PLC resolution; their old
handle strings are never assigned to projection identity.

Bootstrap on initial startup and on a later OutdatedCursor using that same
mechanism. Running requires bootstrap completion and target-map coverage. Feed
status is starting/running/failed/stopped; validation/projection
errors latch failed health and are not cleared by an unrelated valid message.
Network, HTTP5xx, bounded-I/O timeout and native ConsumerTooSlow return to
Starting and retry through the existing reconnect path; no new supervisor/loop.
A failed attempt closes its connection before retry, so missed in-flight work is
covered by the next bootstrap. Existing malformed-input rejection continues. Propagate the server's
currently swallowed indexer errors into this status owner. Quiet caught-up feeds
stay healthy; no clock declares catch-up.

Health exposes200 running or503 starting/degraded. Reuse peer health parsing and
startup waits for new/adopted AppViews. Process exit, absent/foreign mandatory owners,
reported failed indexing or interruption ends the wait. Individual metadata I/O
is bounded; no startup timeout pretends to prove progress. Existing query data
stays readable, with no new name-resolution policy.

Read only the configured PDS origin and standard listRepos/listRecords/getRepoStatus
paths, rejecting redirects. Bound bytes and JSON depth/nodes before decoding;
validate standard XRPC outputs, record schemas, scoped URIs/CIDs and advancing
pagination. Reuse current input depth/node budgets; no new dependencies/pins. Metadata pages
are bounded to512KiB. Record reads use one record per page and8MiB JSON, chosen
before stress runs to cover the existing1MB CBOR record envelope plus JSON escaping
without materializing a100MiB page. Larger replies fail clearly before decoding.
Bootstrap has a cost on every initial start; measure bytes/time for a realistic
owned store before accepting the change.

A mention created during bootstrap can appear in both snapshot and stream. Its
row is retained, and the existing next push-registration replay delivers it; an
immediate notifyInsert may be suppressed by deduplication. This is a delivery
delay, not a deleted notification. Test and document that boundary, including
restart with old records and no repeated notifyInsert pushes.

## Files touched

Thirteen total files: eleven authored here, plus two integration-owned workflows.
Authored files: appview/src/localFeed.mjs (barrier/status), appview/src/inputBounds.mjs
(JSON preflight), appview/src/server.ts (propagated errors and HTTP view),
appview/scripts/startup-readiness-test.mjs (compiled-consumer fixture),
bin/lib-service-pids.sh (health interpretation), bin/start-all.sh (readiness wait),
bin/status.sh (state display), bin/ait-test.sh (CLI fixtures),
bin/security-input-test.mjs (local listRepos fixture and expected degraded health),
docs/developing-alongside-installed-ait.md (operator/testing boundary), this spec.
Integration owns .github/workflows/security.yml and .github/workflows/release.yml
to run the actual variant readiness fixture in their existing jobs. No schema,
transport, dependency, version or installed-tree changes.

## Out of scope

Sweeping/deleting retained rows, changing record retention,
new peer trust or namespaces, persistent cursors, automatic recovery of a corrupted
projection, and changes to required security-group selection. Existing local-feed
security inputs must still run against the actual main consumer. A bootstrap failure is visible; successful current-record bootstrap recovers
ordinary older installations without deleting retained history.

## Tests

Build AppView. Run actual compiled server against owned loopback HTTP/WebSocket
PDS fixtures: held bootstrap stays starting; realistic older-than-window startup
and restart recover via current records; failed bootstrap/projector degrades;
quiet-ready stays healthy. Verify snapshot-overlapping update/delete ordering,
changed-revision barrier, pages, metadata abort/oversize/depth and owned cleanup.
Retained stale rows stay unchanged. Old mention rows produce no bootstrap pushes;
a new overlapping mention remains durable and is delivered through registration
replay. Measured owned fixture:6000 posts,4544922 response bytes,2371ms bootstrap plus
retained replay on this Mac. This is a loopback synthetic store, not a live timing
guarantee. JSON ordinary metadata512KiB and single-record pages8MiB; existing
CBOR record/depth/node bounds remain unchanged.

Run bin/ait-test.sh: both adopted/new service starts wait on the same body-based
health; terminal failure returns nonzero. Run the existing local-feed security
group against this consumer and keep its malformed-input/cursor/memory tests intact. The existing HTTP-liveness
assertion changes from200 to503 after deliberately invalid input, asserting the
server remains available while honestly reporting failed indexing. The fake PDS
returns an empty listRepos so its positive phase reaches real running state.

## Sequencing or rollout

Approve this spec/systems model before building in the separate worktree.
Independent code/systems review before integration. Main retains localFeed;
peer retains its verified snapshot consumer and existing readiness implementation.
The integration owner owns all shared writes. No publication or install here.

## What was rejected

Socket-open readiness: no historical catch-up proof. Fixed startup timeout:
measures elapsed time rather than data progress. Rev-only barrier fromseq0: breaks ordinary older installs after PDS replay
retention. Persistent cursors: upgrades still need a bootstrap; use one mechanism.
Sweeping: broader retention policy not authorized here. Ignoring OutdatedCursor
without bootstrap: reports readiness with a known gap.
Copying peer source/schema/transport: no need for local revision tracking.

## Sources

Main6e5b555 localFeed.mjs, server.ts:63-100; pinned @atproto/pds
api/com/atproto/sync/subscribeRepos.js:15-29 and config/config.js:152;
account-manager/account-manager.js:108-134 writes the initial repo root in the
account transaction (the later createAccount update is not its first write). Native handler
proof /private/tmp/ait-shared-readiness-evidence/retention-proof.mjs.

Spec check: today start may claim health during replay/errors; the smallest usable
fix bootstraps current records with the existing indexer and preserves event order; users see
starting/degraded or a caught-up core in start/status. Questions4-13: empty for
this reporting slice. It repairs ordinary replay gaps through current records, preserving retained rows.
