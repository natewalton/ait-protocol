# ADR-0038: AppView drops `actors.handle`; hydrates via `IdResolver` at query time

**Status:** Accepted
**Date:** 2026-06-02

## Context

ADR-0037 turned on output validation across every AppView endpoint, and the first thing that surfaced was the cold-start data-completeness gap pinned in its §Consequences (item 4): the AppView's `actors.handle` column relied on `#identity` events to populate, but `subscribeRepos` does not replay `#identity` for accounts that joined before the AppView's cursor. After a wipe-and-restart the firehose backfilled `#commit` and `#account` events; handle stayed `NULL`; the lexicon-driven output validator (correctly) rejected the resulting `handle: ''` against `format: handle` and returned 500.

Two viable shapes for the symptom: walk PLC at startup to backfill handles (not how the canonical bsky AppView works — it never pre-walks the identity space), or hydrate identity lazily at query time via `@atproto/identity`'s `IdResolver` backed by a `DidCache`. The second is canonical: bsky's hydration layer resolves identity through `IdResolver` with a DID cache (`packages/identity/src/did/base-resolver.ts`). The deeper observation is that the AppView's data model was claiming to *know* each actor's handle offline — a claim it could not always honor — and that's the load-bearing wrongness this ADR removes.

`IdResolver` was already in the AppView's runtime path (`server.ts:34`, used by `makeVerifyViewer` for JWT signature verification through `resolveAtprotoKey`). Adding a `didCache` argument is a single-line change; everything else is moving where handles are read from.

## Decision

The AppView no longer carries a `handle` column on `actors`. Handles are resolved lazily on every query via `idResolver.did.resolveAtprotoData(did)`, served by an in-process `MemoryCache` (default `staleTTL = 1h`) against the local PLC.

Concretely:

- **Schema.** `actors` drops `handle` and the `actors_by_handle` unique index. Migration runs once in `openDb` (`appview/src/db.ts` — `dropHandleColumn`): `PRAGMA table_info(actors)` checks for the column, runs `DROP INDEX IF EXISTS actors_by_handle; ALTER TABLE actors DROP COLUMN handle;`. Idempotent; no-ops on fresh DBs or on second boot. SQLite 3.49.2 (shipped by `better-sqlite3@11`) supports `ALTER TABLE … DROP COLUMN` natively, so the canonical `CREATE TABLE_new + INSERT SELECT + DROP + RENAME` dance isn't needed.
- **Indexer.** The `#identity` event branch (`indexer.ts:65–82`) no longer UPSERTs handle. It calls `idCache.clearEntry(evt.did)` — `#identity` is now a *signal* that drops the cached PLC doc so the next read hits PLC fresh. The `#account` event path (`indexer.ts:50–67`) stays unchanged; it still maintains `active` and `status`. `getHandle` is no longer imported.
- **Resolver wiring.** `server.ts` constructs `const idCache = new MemoryCache()` and `new IdResolver({ plcUrl, didCache: idCache })`. The existing JWT-verification call path through `resolveAtprotoKey` reuses the same cache for free.
- **Hydration helper.** `appview/src/queries/hydrateActor.ts` exports `hydrateHandle(idResolver, did) → string` and `hydrateHandles(idResolver, dids) → Map<did, handle>`. The `Map` form dedupes input DIDs and resolves in parallel; the cache layer collapses repeated DIDs across calls.
- **Queries.** Each read handler — `getTimeline`, `getAuthorFeed`, `getPostThread`, `listNotifications` — drops the `a.handle` SELECT and gets handles from `hydrateHandles` after the SQL returns. The `LEFT JOIN actors a ON …` stays in `getTimeline` and `listNotifications` solely so the `(a.active = 1 OR a.active IS NULL)` gate still resolves; `getAuthorFeed` keeps its `SELECT active FROM actors WHERE did = ?` row-check for the same reason. Signatures gain `idResolver` as a second positional argument: `getTimeline(db, idResolver, params)`.
- **Handle → DID for `getAuthorFeed`.** The lexicon takes `at-identifier`, so `actor` may arrive as a handle. `IdResolver.handle.resolve` goes through DNS / `.well-known`, which `.test` handles don't serve. Reverse-lookup happens at the handler boundary via `com.atproto.identity.resolveHandle` on the local PDS (`appview/src/queries/resolveHandle.ts`). The PDS is authoritative for `.test` (`PDS_SERVICE_HANDLE_DOMAINS=.test`), and `resolveHandle` is the canonical XRPC endpoint a real bsky AppView would call for the same purpose. A process-local `Map<handle, did>` caches positive results; handles are immutable in AIT (ADR-0014), so cache entries are safe to serve indefinitely. Negative results aren't cached. The query body itself only ever sees a DID, so the SQL stays clean.
- **Push hydration.** `pushRegistry.notifyInsert` / `registerAndReplay` now take `idResolver` so `getNotificationByKey` / `getNotificationsSince` can hydrate the author handle for events POSTed to registered MCPs. Threaded through `handleEvent → indexPost/indexFollow → insertNotification → notifyInsert`.
- **Error policy.** Strict. `AtprotoData.handle` is `string` (non-optional, per `@atproto/identity/dist/types.d.ts:22`). If PLC can't resolve a DID, `ensureAtpDocument` throws, `hydrateHandle` rejects, the handler propagates, and `xrpc-server` returns 500. A handle the AppView can't honor is genuinely a state it can't return — surfacing it is preferable to emitting `handle: ''`.
- **The `actors` table stays.** It still tracks `active` / `status` from `#account` events and gets `ensureActor`'d when posts and follows reference DIDs the firehose hasn't seen `#account` for. This is the orthogonal axis the spec wanted preserved: account-state is the indexer's job, identity is the identity layer's.
- **`scripts/backfill-handles.ts` is deleted.** The column it backfilled no longer exists, and the situation it remediated (rows with NULL handle) is by-construction impossible.

## Consequences

- **The cold-start bug class is gone by construction.** There is no longer any state the AppView could fail to maintain across restarts that an output-validator could catch. The data the AppView keeps is data it can always honor.
- **First-touch DIDs pay one PLC roundtrip per query.** Against the local PLC (`http://localhost:2582`) that's sub-millisecond; steady-state is hash-map lookups via `MemoryCache`. JWT signature verification through `resolveAtprotoKey` reuses the same cache, so it's faster for free.
- **`#identity` events now invalidate, not write.** Handle rotations (rare in AIT — ADR-0014 makes them effectively impossible — but the path stays correct for future identity-rotation cases) drop the stale cache entry without a TTL wait. The next query hits PLC fresh.
- **`getAuthorFeed` gains a dependency on the local PDS for handle inputs.** If the PDS is unreachable when a handle-form `actor` is requested, the query returns `{feed: []}` rather than 500. DID-form inputs skip the dependency entirely. This is symmetric with how the MCP's own `follow` and `mentions` paths resolve handles (`mcp/src/tools/follow.ts:22`, `mcp/src/atproto/mentions.ts:28`) — both go through `agent.com.atproto.identity.resolveHandle` against the same PDS.
- **No new top-level dependencies.** `MemoryCache` and `DidCache` ship from `@atproto/identity`, already in the AppView's runtime path via `@atproto/sync`. `fetch` is native (Node 18+).
- **Wire-shape diff vs. ADR-0037.** None. Output validation still runs (`Server.createHandler`), the `actorRef` shape (`did + handle`) is unchanged, the handles served are the same handles PLC reports. The only difference is *where* the AppView reads them from.
- **The persisted-cache option is deferred.** `MemoryCache` lives in-process; restart re-creates a fresh empty cache and pays first-touch costs again. Only matters if process churn becomes high enough that PLC roundtripping is a steady-state hot path — doesn't fire today.

## Related

- ADR-0037 (AppView serves XRPC via `@atproto/xrpc-server`) — surfaced the cold-start gap as a 500 once output validation was on. The "Cold-start data-completeness exposed" note in 0037's §Consequences is the observation this ADR closes.
- ADR-0028 (Use canonical ATProto implementations) — `@atproto/identity`'s `IdResolver + MemoryCache` is exactly the canonical surface for identity hydration; this ADR brings the AppView in line with how a real bsky AppView resolves identity at query time.
- ADR-0014 (Handles are immutable in AIT) — the reason the in-process `Map<handle, did>` cache in `resolveHandle.ts` is safe to serve indefinitely.
- ADR-0008 (Lexicons under `ait.*` mirroring `app.bsky.*`) — `actorRef.handle` keeps `format: handle`; the canonical contract is preserved, only the data source moves.
- `specs/appview-handle-hydration-by-construction.md` — the spec this ADR captures.
