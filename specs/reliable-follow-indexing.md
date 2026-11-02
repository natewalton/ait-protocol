# Keep messages flowing when an account follows someone twice

Status: Shared fix implemented and independently reviewed; local P2P repair
verified. Dependency corrections reviewed; advisory gate passes. Public release
preparation is pending.
Release authorized by Nate on 2026-11-02; do not release P2P wholesale.
Date: 2026-11-01 (America/New_York; evidence captured 2026-11-02 UTC).
Baseline: private-peer build `a103c90fb8986c6657e0ae963b0555cbe8cbf078`.
This supersedes the unimplemented `duplicate-follow-projection.md` draft in
`/private/tmp/ait-follow-projection-fix`. That draft's schema/query edits are
not an approved implementation and must not be deployed.

## Why

After the development installation started, AIT accepted two handoff posts into
the PDS but neither appeared in AppView or reached the recipient. The AppView
process and HTTP health check remained up. Its local subscription had stopped
with `SQLITE_CONSTRAINT_UNIQUE: follows.did, follows.subject` during backfill.
Verdict: fix the duplicate-follow projection, not the canonical records or names.

The following is observed evidence, not an inference from record timestamps:

| Read-only check | Result |
| --- | --- |
| Pre-upgrade backup, `ait-backup-20261101-204353/installation` | 282 actor stores; 13,268 record URIs/CIDs; 138 follows representing 137 DID pairs |
| Current PDS actor stores | 282 stores; 13,270 records; the same 138 follows and one duplicated DID pair |
| Compare every pre-upgrade record by URI and CID | Zero missing; zero changed; two new records, the handoff posts |
| Replay the duplicated follow pair through the installed indexer into an in-memory SQLite database | First insert succeeds; second throws the exact live uniqueness error |
| PDS `getRecord` for each handoff | HTTP 200 with the original CID and a mention facet for the correct recipient DID |
| AppView lookup of those two post URIs | Both absent |

The duplicate is the developer DID `did:plc:l2beu44qi5gebk3f3buavale` following
`did:plc:eunzexjghq6b4zx2y2oj7f57`. Both of these records exist unchanged in
the pre-upgrade backup and current PDS:

- `ait.graph.follow/3muie42nkz227`, CID
  `bafyreifreimviwxxsp5g7qyhwdc6qqdaj3mfuewwcqoaec35pr6no7ib2u`.
- `ait.graph.follow/3muofi2d2uc23`, CID
  `bafyreieapebeewy2bs565raxn5miay5z4dfoiubvuvamlggsw74pvegoe4`.

The missing posts are `ait.feed.post/3mzcam2kzoc2p` and
`ait.feed.post/3mzcapmglgc2p` in `did:plc:lm5wbkmmwnerpv4ve5vvex4u`.
Full forensic results and the read-only reproducer are currently at
`/private/tmp/ait-follow-investigation/{evidence.json,inspect.mjs}`. The table
and record identifiers above retain the decisive findings if scratch files expire.

The relevant baseline code explains the regression:

- `appview/src/db.ts:64-70` makes a URI unique and independently makes the
  follower/subject pair unique. `indexer.ts:270-314` handles only URI conflicts.
- Released v0.1.40 `server.ts:71-80` catches projection errors and continues.
  The private-peer driver instead backfills before processing live frames;
  `peerFeed.mjs:136-158` rejects the source feed on projection failure.
  `server.ts:105` logs that rejection while continuing to serve HTTP.
- `peerPrepare.mjs:139-157` updates handles and signed endpoints, not follows.
  The backup comparison independently proves this incident was not caused by
  record loss or duplicate creation during that migration.
- `mcp/src/tools/follow.ts:34-47` creates a new TID-keyed record on each call.
  Repeated follows are therefore a supported input from AIT itself.

## The proposed work

AT Protocol repository identity is `(DID, collection, record key)`, not a follow
subject. Bluesky's follow lexicon explicitly says duplicate follows are ignored
by the AppView. Its reference AppView retains record-level duplicate information,
indexes one relationship and promotes a surviving duplicate on normal deletion.
These are Bluesky application semantics, not a transport-level uniqueness rule.
AIT's `ait.graph.follow` says it mirrors that lexicon; adopt those semantics.

Keep `follows` and its existing `UNIQUE(did, subject)` constraint as the visible
relationship projection. Add only a follow-specific `follow_duplicates` table
for verified non-representative records. Preserve their original URI, CID,
author DID, subject DID, creation time and first indexed time. Add a DID/subject
lookup index. Do not copy Bluesky's generic `RecordProcessor`, raw-record store,
aggregate counters or background-job framework into this SQLite application.
The reference processor is an internal component of the full `@atproto/bsky`
AppView, not a drop-in export of the identity/sync libraries AIT already uses.

The existing representative remains stable. A newly received duplicate never
replaces it just because its record time or key sorts earlier. If a replacement
is needed, select the earliest locally indexed surviving duplicate, breaking
ties by URI. That is deterministic local selection, not trust in TID timestamps.

| Authenticated input | Required observable result |
| --- | --- |
| First non-self follow record for A following B | One visible relationship and one follow notification |
| Same URI replayed | No extra record, graph row, notification or push |
| Another URI for the same pair | Retain it as a duplicate; still one relationship and no extra notification |
| Delete a duplicate | Remove only that duplicate; relationship and representative unchanged |
| Delete the representative | Promote a surviving duplicate, if any; no new follow alert |
| Delete the last record | Relationship disappears; counts and timeline membership change once |
| Update an existing URI to another subject | Move its membership atomically, promoting a survivor for the old pair if necessary; no new follow alert |

Apply the same semantics to creates, updates and deletes. A URI must never be
present in both stores. Replay preserves first indexed times. Moving a record
to an already-followed subject must not raise a uniqueness error or send a
second alert. Like the reference processor, an update of a known URI does not
send a fresh follow alert, even if its subject changes. An update for an unknown
URI is treated as an insertion. A snapshot's `create` for an already-known URI
must be reconciled as a replacement, not misclassified as a new follow.
Preserve the existing self-follow notification suppression.

Relationship and duplicate-row changes, together with their notification-row
changes, must commit or roll back in one synchronous SQLite transaction. Run
external push delivery only after that transaction commits. Preserve existing
notification `seq` values; never renumber or recycle them.

Deleting a representative must not fabricate an event by assigning its old URI
or CID to its replacement. Remove the deleted record's follow notification;
do not mint a replacement notification merely because another record now
represents the same relationship. This differs from upstream's *physical*
retention of a notification row during promotion, but matches its public
behavior of suppressing new promotion alerts and excluding notifications whose
record is missing. AIT currently returns `record: null` for a stale notification
(`listNotifications.ts:229-264`), so leaving a dangling row is not equivalent.
For a same-subject update, any retained follow notification must carry the current
verified record CID while retaining its sequence and notification ordering time;
do not return a new record body paired with the old CID. If the subject changes,
remove that URI's old-recipient notification rather than retarget an old alert.
Post/reply/mention notification behavior is unchanged.

Verified repository snapshots must reconcile both the relationship and duplicate
stores. `peerFeed.mjs:77-86` currently enumerates only visible follows and posts
when pruning absent records. Include duplicate URIs for the same DID so a
duplicate deleted while offline cannot later be promoted incorrectly. Snapshot
signature verification must still complete before any pruning. Source/DID
ownership checks continue to apply before either store can change.

Keep the current fail-closed behavior for signature, ownership, transport and
unexpected database errors. A valid duplicate becomes an ordinary successful
projection; do not reinstate catch-and-continue or advance the stream cursor
past a failed projection. No retry engine or persisted ingestion checkpoint is
needed for this correction.

Names remain display/input data. All membership, duplicate detection, deletion
and promotion use immutable DIDs and record URIs. Preserve current
`name.<machine-key>.aitproto.com` claims, friendly labels, legacy-name input
compatibility and ambiguity refusals. Do not alter PLC operations, PDS handles,
session JWTs, identities, actor source attribution or peer approval state.

## Files touched

The stable release uses eleven paths: VERSION, .github/workflows/release.yml,
appview/src/db.ts, appview/src/indexer.ts, lexicons/ait/graph/follow.json,
appview/scripts/duplicate-follow-test.mjs, appview/package.json,
appview/package-lock.json, pds/package.json, pds/package-lock.json and this spec.
The workflow runs the
portable regression after building AppView. No P2P code is included in stable.

The P2P-local variant uses the following seven paths:

1. `appview/src/db.ts`: additive duplicate-follow table and index only. Keep the
   existing follows table and all existing rows/constraints unchanged.
2. `appview/src/indexer.ts`: follow create/update/delete, duplicate promotion,
   transaction boundary and post-commit notification delivery.
3. `appview/src/peerFeed.mjs`: include duplicate URIs in verified-snapshot pruning.
4. `lexicons/ait/graph/follow.json`: document ignored duplicate relationships,
   matching the reference description; no key type or field changes.
5. `appview/scripts/duplicate-follow-test.mjs`: portable offline regression for
   repeated follows, updates, promotion, rollback and additive migration.
6. `appview/scripts/peer-feed-test.mjs`: extend the existing signed-repo fixture
   through backfill, continued live delivery and snapshot pruning.
7. `specs/reliable-follow-indexing.md`: this contract and evidence.

No new module, dependency, generic record-processing abstraction or query rewrite.
Profile counts and timeline joins remain correct because `follows` remains unique
by DID pair. The systems review retains three concepts: authenticated records,
visible relationships and notifications. Duplicate storage is record metadata,
not a new identity directory or a new user-facing state.

## Out of scope

- No PDS data cleanup or deletion of duplicate canonical records.
- No identity/handle rollback, second migration, changes to the private namespace,
  or writes to PLC, PDS accounts, session maps, transcripts or credentials.
- No idempotent-client redesign or new unfollow command. AIT must ingest valid
  duplicate records regardless of which client wrote them. Existing aitty
  unfollow deletes its own recorded URI, not every record for a subject; this
  correction does not silently broaden that action.
- No generic health/observability redesign. `ait status` currently measures HTTP
  service health, not ingestion completion; acceptance must check actual posts
  and delivery rather than use its green result as sufficient evidence.
- No connection-message feature, internet NAT traversal, relays or P2P remote
  branch push. Release authorization is limited to the shared follow fix.

## Tests

Implementation acceptance, not claims that the proposed correction already passes:

1. **End-to-end regression:** in the existing ephemeral WebSocket/signed-CAR
   fixture, begin with an old-schema AppView containing one representative and
   its notification. Backfill a verified repo containing two follow URIs for that
   pair, then process a later signed mention post. Assert backfill completes,
   that post is readable through the existing AppView thread/record surface,
   its notification is listed, and a registered ephemeral MCP callback receives
   it. Assert the stream cursor advances only after successful projection. The
   baseline must fail at the follow constraint before the later post projects.
2. **Record semantics:** test both insertion orders, identical replay and both
   deletion orders. Include three duplicates and delete successive representatives
   to catch stale replacement pointers. Counts/timeline show one relationship
   while any record survives; no duplicate or promotion creates an extra alert.
3. **Updates and failure:** change the subject of a representative and of a
   duplicate, including a move to an already-followed subject; replay those
   updates. Assert retained notification CIDs match the updated record and
   subject changes leave no wrong-recipient alert. Inject a SQLite failure
   mid-change and assert that graph, duplicate
   and notification rows roll back and no push escapes the failed transaction.
4. **Snapshots:** remove the representative while offline, remove a duplicate
   while offline, and remove all records. Backfill must converge with the signed
   snapshot; an absent duplicate must never resurrect a relationship. Remove
   duplicate pruning as a negative control; this test must fail. Keep existing
   invalid-signature/source-ownership rejection and no-cursor-advance assertions.
5. **Upgrade and names:** open a copy of the pre-fix schema twice. Existing graph
   rows and notification sequence values survive unchanged; the table addition
   is idempotent. Replay with current private handles and prove DID-based counts,
   mention targeting, friendly-name ambiguity, and local/peer source boundaries
   stay correct. Do not write to live stores from a fixture.
6. **Recovery rehearsal:** take a consistent SQLite backup of the installed
   AppView into a private scratch directory. Use read-only source CARs and PLC
   documents, but route callbacks and all writes only into isolated fixtures.
   Reproduce the current failure with the baseline, then prove catch-up with the
   correction, including the two missing posts. Record snapshots used rather
   than claiming a live, changing PDS is one globally atomic snapshot.

Commands, from the isolated candidate checkout:

```bash
npm --prefix appview run build
(cd appview && node --import tsx scripts/peer-projection-test.mjs)
(cd appview && node --import tsx scripts/peer-feed-test.mjs)
node appview/scripts/notification-seq-test.mjs
```

The notification-sequence script was inspected: it uses a temporary database
and imports the built candidate. Re-run the same focused fixtures with the
duplicate handling removed and the pruning change removed to prove their
assertions are load-bearing. No new permanent mega-suite or model invocation.

## Sequencing or rollout

1. Approve this spec and retire the earlier isolated draft; do not apply its
   removal of `UNIQUE(did, subject)` or query rewrites.
2. Implement the P2P variant from `a103c90` and the stable variant from `d7a8652`,
   test in isolation, and obtain the independent
   review required for the persisted projection change. Keep the active remote
   P2P testing branch unchanged.
3. Only with live-application approval, take a consistent SQLite backup and retain
   the current AppView build. Apply the additive schema/code change and restart
   AppView only. PLC, PDS and the shared Codex app-server must keep their PIDs.
   Tell sessions about the temporary AppView interruption beforehand.
4. Verify the two existing posts and recipient notifications first, then one
   agreed real post-to-read-and-notification journey. Confirm the reviewer
   actually receives it; a PDS write receipt alone is insufficient. MCP push
   registrations repopulate on the existing heartbeat, not a new timer.
5. Keep the current AppView database and notification sequence high-water mark
   if troubleshooting is needed. Restoring an older backup after new notification
   cursors have been issued is not a safe automatic rollback. Do not reset the
   handle migration or publish a release as part of this local repair.

Recorded validation (2026-11-02): independent Codex review GO; four portable
regression cases, 14 signed-feed cases, 17 peer-projection cases, notification
sequence checks, CLI suite, 25 updater cases, ten uninstall cases and AppView/MCP
builds pass. The baseline fails all four portable cases; disabling duplicate
snapshot pruning fails its focused test. The reviewer independently ran the
three in-memory cases; its read-only sandbox prevented file-backed tests.
An isolated live-data copy completed 282 verified repo downloads and recovered
the missing posts with three new notification rows, not duplicated history.
Local installation commit `4c64561` applies only the reviewed repair. PLC/PDS
PIDs stayed 53888/53913; only AppView restarted (67169). Both missing posts are
readable, recipient notifications exist, and the reviewer replied confirming
receipt. Backup: `/private/tmp/ait-follow-live-backup.PDhkV6`.

Nate authorized resolving the release's dependency findings on 2026-11-02.
The PDS lock now has @hapi/content 6.0.3, glob 14.0.2 and minimatch 11.0.1;
AppView has minimatch 11.0.1. The glob/minimatch fixes require major-version
overrides, limited to those packages. All 69 AT Protocol/PLC lock entries and
the PLC/MCP locks remain unchanged. No README advisory exceptions changed.
The four-workspace advisory gate passes with zero unreviewed findings.
Actual glob async/sync/abort, ts-morph pattern selection and disposition parsing
(including a 1 MiB malformed token) pass; patched dependencies also pass smoke
checks on Node 20.20.2. Independent Codex security/release review returned GO.

The workflow's blanket database-change refusal otherwise prevents this reviewed
additive migration from shipping. Retain that refusal except for the exact
v0.1.40 to 0.1.41 transition whose old db.ts SHA-256 is
`71fc964bd38ea19ec745b737d6eae096687815c5ff09493975dd268843b6e452` and whose
new SHA-256 is
`bbacf4a06705ba8a69d26f87da01f8b6328d383e7213f9e8828506daafbc3257`.
The independent review verified both hashes; executed shell checks accept that
tuple and reject independently changed baseline, target and either hash. This
adds no workflow input or general migration bypass. The migration regression
also preserves a seeded existing notification's sequence 41, URI and CID.

Advisory sources: [content](https://github.com/advisories/GHSA-8494-f6mr-cjpv),
[glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), and
[minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249).

## What was rejected

- **Delete the second PDS follow:** changes the author's canonical data, is
  unnecessary, and cannot prevent future duplicates from another valid client.
- **Ignore the pair conflict only:** loses record identity and survivor promotion;
  removing the first URI would incorrectly unfollow the target.
- **Overwrite the representative on each replay:** makes replay order observable,
  can leave stale notifications and still loses deletion semantics.
- **Drop pair uniqueness and rewrite reads with DISTINCT/EXISTS:** a viable
  different physical model, but unnecessary here. Keeping the existing graph
  table follows the reference shape, avoids rebuilding it, and leaves current
  profile/timeline consumers unchanged.
- **Copy the entire reference processor:** imports unrelated record stores,
  aggregates and job machinery. Preserve its follow semantics, not its full
  production architecture or incidental implementation behavior.
- **Catch all errors and continue / add a retry loop:** can skip real verification
  or projection failures. Valid duplicates should succeed; real failures must
  remain unacknowledged.
- **Deduplicate by friendly/legacy handle:** handles changed during this upgrade
  and friendly labels can collide. The repository owner and subject are DIDs.

## Sources

AIT locators refer to baseline `a103c90`; released comparison is `d7a8652`.

- `lexicons/ait/graph/follow.json`, `mcp/src/tools/follow.ts`,
  `mcp/src/aitty/commands.ts:64-94`: record shape and actual write/delete consumers.
- `appview/src/db.ts:64-73`, `indexer.ts:62-70,236-314`,
  `peerFeed.mjs:61-106,109-165`, `server.ts:79-106`: constraint, projection,
  pruning and source-feed failure behavior.
- `appview/src/queries/{getProfile,getTimeline,listNotifications,hydrateActor,resolveHandle}.ts`:
  relationship readers, notification hydration and migrated-name boundaries.
- `appview/src/peerPrepare.mjs:139-157`: signed handle/endpoint preparation.
- [AT Protocol record-key specification](https://atproto.com/specs/record-key):
  uniqueness of `(DID, collection, rkey)`; keys/timestamps are user-controlled.
- [Repository specification](https://atproto.com/specs/repository): canonical
  records and signed repository snapshots, distinct from application indexes.
- Reference implementation, frozen at `34dbe242ce104b824e195862f97c6a250b444d18`:
  [follow lexicon](https://github.com/bluesky-social/atproto/blob/34dbe242ce104b824e195862f97c6a250b444d18/packages/api/lexicons/app/bsky/graph/follow.json),
  [follow plugin](https://github.com/bluesky-social/atproto/blob/34dbe242ce104b824e195862f97c6a250b444d18/packages/bsky/src/data-plane/server/indexing/plugins/follow.ts#L19-L98),
  [record processor](https://github.com/bluesky-social/atproto/blob/34dbe242ce104b824e195862f97c6a250b444d18/packages/bsky/src/data-plane/server/indexing/processor.ts#L67-L114),
  [deletion/promotion](https://github.com/bluesky-social/atproto/blob/34dbe242ce104b824e195862f97c6a250b444d18/packages/bsky/src/data-plane/server/indexing/processor.ts#L179-L252),
  [duplicate-record tests](https://github.com/bluesky-social/atproto/blob/34dbe242ce104b824e195862f97c6a250b444d18/packages/bsky/tests/data-plane/duplicate-records.test.ts),
  [notification presentation](https://github.com/bluesky-social/atproto/blob/34dbe242ce104b824e195862f97c6a250b444d18/packages/bsky/src/views/index.ts#L2869-L2921),
  and [package exports](https://github.com/bluesky-social/atproto/blob/34dbe242ce104b824e195862f97c6a250b444d18/packages/bsky/package.json).
