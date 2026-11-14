# Keep newer peer records when queued history arrives

Status: correction implemented; 34 peer-feed tests and AppView build PASS; explicit systems and independent AIT review GREEN.
Date: 2026-11-14
Base: 3652fc4, isolated peer fixture. No installed changes.

## Why

Peer backfill opens subscribeRepos, projects getRepo snapshots, then applies queued
commits without checking snapshot coverage (peerFeed.mjs:91-115,140-163,182-191).
Two same-key, successive Repo.applyWrites fixtures prove a signed older update
replaces newer snapshot text and an older delete removes a recreated record. Both
advance cursor1. Fix it. Frequency in live traffic is unmeasured; no live damage
is asserted. Evidence: /private/tmp/ait-claude-native-proof/peer-snapshot-order-before.log.

## The proposed work

Keep one in-memory snapshot revision per DID for this source-bound feed. Record
it only after a fully authenticated/validated snapshot projects successfully.
Validate queued commit claims and records before suppressing writes already
covered by that revision; still acknowledge fully validated covered messages.
Bind the envelope commit CID/revision to its authenticated CAR root. The installed
sync parser verifies proof claims but formats events with envelope rev without
binding it (sync/src/firehose/index.ts203-259). Empty selected-op commits must
also authenticate their root. Newer live writes/deletes continue to project.
A fetched older snapshot cannot regress an already admitted snapshot boundary.
No database migration or cross-peer revision cache.

Treat event kinds separately: identity uses current source-bound DID resolution.
Account flags are not ordered by repo revisions: read current paginated source
listRepos metadata, using the existing approved route. A complete source-bound listing that omits the actor represents current deletion,
without deleting retained records or stopping other actors. Network/validation
failure does not establish absence. Existing same-source attribution permits
account-only updates even after deletion removes access to the DID log; new or
replacement source attribution still requires signed endpoint validation. Native
PDS account creation writes repo_root before sequencing the account event
(account-manager.js108-134); deletion removes the account before sequencing
Deleted (server/deleteAccount.js). Do not add a retry loop.

## Files touched

Three: appview/src/peerFeed.mjs, appview/scripts/peer-feed-test.mjs, this spec.

## Out of scope

Main localFeed is owned by the other author. No shared branch writes, release,
installation, feed readiness redesign, new route, identity ownership relaxation,
or change to signature/key/record/source checks. Account handling is an explicit
current-metadata lookup, not a claim that the commit boundary orders account events.

## Tests

Existing real loopback/in-memory signed-repo fixture: held stream R1 before
snapshot R2; stale update and delete/recreate retain R2; newer commits and deletes
apply; covered invalid commit fails without cursor advance; envelope/CAR revision
mismatch fails; source/foreign-DID checks remain. Test old deactivation vs current
active list metadata and complete absence preserving history and continued processing; list failure
cannot become deletion, and another source cannot alter account attribution.
Run node --import tsx --test scripts/peer-feed-test.mjs in appview. Old implementation
must fail new record assertions in a scratch negative control. Preserve cleanup.

## Sequencing or rollout

Source proof reported before runtime changes. Apply spec-design and general-systems
checks, implement, run focused suite, independent Skills review, then coordinator
integrates exact reviewed commit and runs combined gates. No publication implied.

## What was rejected

Envelope rev alone is not authenticated by the installed parser. Skipping before
validation weakens the peer boundary. Persisted revision tables and new supervisors
are unnecessary for the snapshot/queue overlap. A repo watermark for account flags
is invalid because those events carry no repo revision. getRepoStatus would add a
protocol route; existing source-bound listRepos suffices for current known status.

## Sources

peerFeed.mjs reconcile/processMessage/consume; installed @atproto/sync source above;
@atproto/repo/src/sync/consumer.ts129-175 (signed proof root), car.ts readCarWithRoot;
existing source-bound listRepos/getRepo adapters; PDS listRepos.js actor/repo_root
inner join and server/deleteAccount.js lifecycle. The two isolated signed fixture
failures supply the user-visible projection evidence; no live PDS was touched.

Validation receipts (2026-11-14): before-fix runtime source plus new same-key
sequential repository fixtures fails both expected projection assertions; log
peer-snapshot-order-before.log. Fixed suite:34/34, no timeout or cleanup failures,
peer-feed-snapshot-final.log. AppView build passes in isolated checkout. Systems
review finds one new ordering concept, five net conditional sites and no new
catch/retry/timer; read-only parallel review also GREEN. Account absence source
justification was corrected before freeze after inspecting PDS deletion/create
transactions. No live account/repo data was copied.

Independent closeout: @ait-skills-dev GREEN on bef10a0, fresh scratch archive on
Node25.7,34/34 pass. Old peerFeed with new tests fails8 cases; separate mutations
catch root-rev binding, empty-commit authentication and known-source deletion
handling. Account lookup is O(repos) worst case per account event, paging at1000;
accepted at current peer scale with no additional cache or protocol route. Two
non-blocking coverage limits remain: the older-fetched-snapshot guard has no
lagging-source fixture, and changing strict coverage to inclusive re-projection
of an identical revision is not caught. No new runtime changes after review.
