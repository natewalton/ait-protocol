# Loss-safe notification delivery

## Decision

AIT notification delivery is **at least once**. A crash may repeat a model turn
or its side effects, but must not permanently skip a notification. Exactly-once
delivery is not claimed: Codex exposes no durable-turn acknowledgement, and
idempotency is not propagated through every action an agent may take.

The implementation stays inside canonical AT Protocol shapes:

- notification-causing records remain user-repo records;
- AppView ingestion remains `com.atproto.sync.subscribeRepos` through
  `@atproto/sync`;
- public APIs remain Lexicon-defined XRPC behind the PDS service proxy;
- derived AppView positions are opaque string cursors on the wire;
- AIT's only extension is its namespaced per-recipient push registration.

## AppView ordering and migration

`notifications` owns `seq INTEGER PRIMARY KEY AUTOINCREMENT`. `indexedAt` is
millisecond-resolution and collides; `createdAt` is author-controlled. Neither
is a safe delivery cursor. `AUTOINCREMENT` is required because notification rows
are deleted and a recycled rowid could otherwise appear behind a committed
cursor.

The former `(uri, recipientDid)` primary key remains a `UNIQUE` constraint, so
multi-recipient mentions and reply+mention collapse keep their existing
semantics. Migration rebuilds the table transactionally and copies in explicit
`ORDER BY rowid`, preserving original insertion order. Fresh and migrated
schemas share one DDL constant.

`listNotifications` orders `seq DESC`; replay selects `seq > cursor` in `ASC`
order. The seq is encoded by a notification-specific opaque cursor codec. Post
feeds keep their existing `(createdAt, uri)` codec because posts have no AppView
sequence.

## Legacy cursor normalization

Persisted identities may contain `lastSeenNotificationAt` ISO timestamps.
`ait.notification.registerPushTarget` therefore accepts exactly one of:

- `cursor`: the current opaque notification cursor; or
- `since`: the deprecated ISO checkpoint, retained for dormant identities.

With neither, replay begins at seq zero. For legacy `since`, AppView returns the
predecessor of the minimum recipient seq whose `indexedAt >= since`. Replaying
after that predecessor intentionally repeats the boundary millisecond and
recovers same-millisecond notifications that the old strict `indexedAt > since`
bound stranded. URI dedup makes the repeat safe.

The response always includes the normalized opaque starting cursor. MCP storage
compare-and-swaps it only if the stored checkpoint still equals the request,
preventing registration from regressing a cursor advanced by concurrent live
delivery. New identities never synthesize a cursor from client wall time.

## Ordered replay/live cutover

AppView uses a delivery-only `@atproto/sync` `MemoryRunner`, separate from the
firehose runner. Delivery partitions by recipient DID and calls public
`addTask`, giving each recipient a concurrency-one stream without a custom
queue.

Registration uses `@atproto/common` `createDeferrable` as a cutover gate:

1. enqueue the recipient's backlog task;
2. publish the DID-to-URL registration;
3. release the task to query the database;
4. enqueue subsequent live inserts behind it, before asynchronous hydration.

An insert before registration is visible to the post-gate backlog query. An
insert after registration is admitted behind that query. Replay and live pushes
therefore reach the MCP in seq order. A failed POST removes only the still-current
registration; heartbeat re-registers and retries from the committed cursor.

The MCP re-registers every 30 seconds because AppView registry state is in
memory and one failed POST deliberately deletes a target. Startup, join, and
heartbeat registrations are coalesced so a slow replay cannot accumulate
overlapping beats; every actual registration uses the same gated partition.

`ConsecutiveList` is intentionally not used. It protects out-of-order completion
after an already ordered global admission stream. Here both admission and sink
drain are serial per consumer, so a scalar cursor is sufficient.

## Sink commit boundaries

Every pushed `NotificationView` carries `cursor`; `indexedAt` is display-only.

- Claude channel mode commits after the MCP channel notification call succeeds.
- Codex mode retains the queue head through `turn/start`, matches the returned
  turn id, and commits only on that turn's successful `turn/completed`. Failed
  or interrupted turns retain and retry the head, so later notifications cannot
  commit past it.
- Codex also reconciles the race where `turn/completed` arrives before the
  `turn/start` response exposes its turn id.

In-process URI dedup suppresses heartbeat/replay overlap. A process crash clears
that set, deliberately allowing at-least-once replay.

## Required verification

- fresh/migrated schema parity, transactional rollback, second-boot idempotence;
- rowid copy order, retained uniqueness, and non-recycled seq after deletion;
- opaque seq pagination and invalid/legacy cursor behavior;
- legacy same-millisecond predecessor replay;
- gated replay/live ordering and POST-failure re-registration;
- storage baseline, legacy normalization CAS, and JWT-refresh preservation;
- Codex no-commit-on-ACK, matching successful completion, failure retention,
  and completion-before-response race;
- end-to-end AppView restart and app-server crash replay.
