# AppView: drop `actors.handle`; hydrate via `IdResolver` at query time

Closes the cold-start handle gap surfaced by ADR-0037 by construction: the AppView stops trying to maintain `actors.handle` in SQLite at all. Handles get resolved lazily at query time via `@atproto/identity`'s `IdResolver` backed by `MemoryCache`. The bug class disappears because the state that can be incomplete is no longer maintained.

Status: spec.

## Goal in one sentence

The AppView's `actors` table no longer carries a `handle` column; every query that needs a handle resolves it through `idResolver.did.resolveAtprotoData(did)`, served by an in-process `MemoryCache` against the local PLC.

## Why "by construction" is the right move here

ADR-0037's "Cold-start data-completeness exposed" note (line 45) was a symptom of an underlying mismatch: the AppView claimed to know each actor's handle offline, but the firehose only carries enough state to make that claim true when the AppView has been continuously consuming events from each actor's first `#identity`. After a cold restart, the firehose replays `#commit`s and `#account`s but not `#identity`s for accounts that joined before the AppView started — so `handle` ends up NULL, and the canonical xrpc-server output validator (correctly) rejects an empty string against `format: handle`.

Two viable shapes for fixing the symptom: (1) walk PLC at startup to backfill handles; (2) lazy PLC lookup on each query with caching. The first is not how the canonical bsky AppView works (it never pre-walks the identity space — wrong scale). The second IS canonical — bsky's hydration layer resolves identity at query time through `IdResolver` with a DID cache. This spec goes one step further and removes `handle` from the actors schema entirely, so the AppView's data model never makes a claim it can't always honor. The indexer's job becomes "know what posts and follows exist"; identity is the identity layer's job, not the indexer's.

Three load-bearing facts verified via tool calls before writing this:

- `IdResolver.did.resolveAtprotoData(did)` returns `AtprotoData = {did, signingKey, handle, pds}` (`@atproto/identity/dist/types.d.ts:19-23`, implementation at `base-resolver.js:95-98`). One call gets the handle.
- `MemoryCache(staleTTL, maxTTL)` is the canonical cache (`memory-cache.js:5-6`); default `staleTTL = HOUR`. The `BaseResolver` auto-writes-through on every successful resolve (`base-resolver.js:85`).
- The AppView already constructs `IdResolver` at `appview/src/server.ts:27` with `plcUrl: PLC_URL`. The instance is currently only used for JWT signature verification (`xrpc/auth.ts:23` calls `idResolver.did.resolveAtprotoKey`). Adding a `didCache` argument is a one-line change; no new module construction.

## What ships

### 1. Schema change

Drop the `handle` column from `actors`. Two viable shapes — `ALTER TABLE actors DROP COLUMN handle` if better-sqlite3's installed version supports it (12.2+); otherwise the canonical SQLite migration: `CREATE TABLE actors_new (...)`, `INSERT INTO actors_new SELECT did, active, status, indexedAt FROM actors`, `DROP TABLE actors`, `RENAME actors_new TO actors`. The build session should verify which path works locally and pick one — they're behaviorally identical.

Migration runs once on first start of the new dist against any existing `data/appview.sqlite`. Idempotent — if `handle` is already gone, the migration no-ops (`PRAGMA table_info(actors)` to check).

### 2. Indexer change

`appview/src/indexer.ts:71-79` currently UPSERTs `handle` from `#identity` events. After this spec:

- The `handle` UPSERT goes away entirely. `#identity` events become a *signal*, not state.
- Use the `#identity` signal to invalidate the IdResolver cache for that DID: `idCache.clearEntry(did)`. That way a handle rotation (rare in AIT — `ADR-0014` makes it actually impossible — but the path stays correct for future identity-rotation cases) drops the stale cache entry without a TTL wait.
- The `#account` event path at `indexer.ts:52-59` stays — it still maintains `active` and `status`.
- `ensureActor` at `indexer.ts:272-275` stays — same insert-or-nothing on `did, indexedAt`.

The `getHandle` import from `@atproto/common-web` (used at `indexer.ts:71`) becomes unused; remove it.

### 3. Resolver wiring

`appview/src/server.ts:27` becomes:

```ts
const idCache = new MemoryCache()  // default staleTTL = 1hr per memory-cache.js
const idResolver = new IdResolver({ plcUrl: PLC_URL, didCache: idCache })
const verifyViewer = makeVerifyViewer(idResolver, APPVIEW_DID!)
```

The cache is passed via `didCache` (constructor option per `id-resolver.js:25`, threaded through to `BaseResolver(opts.didCache)` per `base-resolver.js`). The existing JWT-verification call path through `idResolver.did.resolveAtprotoKey` automatically benefits from the cache — it pulls from the same `DidResolver` instance.

Export `idCache` from `server.ts` so the indexer can call `idCache.clearEntry(did)` on `#identity`.

### 4. Hydration helper

New module `appview/src/queries/hydrateActor.ts`:

```ts
import type { IdResolver } from '@atproto/identity'

export interface ActorRef {
  did: string
  handle: string
}

export async function hydrateActor(
  idResolver: IdResolver,
  did: string,
): Promise<ActorRef> {
  const data = await idResolver.did.resolveAtprotoData(did)
  return { did, handle: data.handle }
}

export async function hydrateActors(
  idResolver: IdResolver,
  dids: readonly string[],
): Promise<Map<string, ActorRef>> {
  const unique = Array.from(new Set(dids))
  const refs = await Promise.all(
    unique.map((did) => hydrateActor(idResolver, did)),
  )
  return new Map(refs.map((r) => [r.did, r]))
}
```

`hydrateActors` batches by `Promise.all`; the cache layer collapses redundant lookups within a single call automatically (each unique DID hits PLC at most once, subsequent calls for the same DID get the cached doc).

### 5. Query migration

Each of the four read queries drops the `LEFT JOIN actors a ON a.did = p.did` clause (and equivalents for notifications) and the SELECT of `a.handle`. After the SQL returns the post/follow rows, the handler collects every DID, calls `hydrateActors(idResolver, dids)`, and maps over the SQL result to build `author: { did, handle: hydrated.get(did)?.handle ?? '' }` — but with `hydrateActors` returning a Map of refs, every DID that got past `resolveAtprotoData` will be present.

Concrete touch points (verified via grep):
- `appview/src/queries/getTimeline.ts:31` (SELECT `a.handle`), `:34` (JOIN actors), `:61` (`handle: r.handle ?? ''`).
- `appview/src/queries/getAuthorFeed.ts:70` (uses `actor?.handle`; the `actor` lookup also changes shape).
- `appview/src/queries/getPostThread.ts:43, :72, :74` (similar JOIN + hydration).
- `appview/src/queries/listNotifications.ts:64, :66, :104, :106, :131, :133` (multiple JOINs across the union of three notification subqueries).

The handler bodies become "SQL fetches the DIDs and post fields; hydration fetches the handles" — two phases instead of one JOIN, but the second phase has the cache in front of it so steady-state per-query latency is dominated by the SQL.

`idResolver` needs to be threadable into each query. Either thread it as an argument from the handler down (clean, more types to write) or attach it to the `Db` wrapper (one fewer arg, slightly less explicit). Either works; build session picks.

### 6. Empty/null handling

`AtprotoData.handle` is typed as `string` (non-optional, per `types.d.ts:22`). If PLC can't resolve the DID, `ensureAtpDocument(doc)` throws — the hydration call rejects, the handler propagates, `xrpc-server` returns 500. That's the right behavior: an actor we can't resolve via PLC is genuinely a state we can't honor; surfacing it is preferable to silently emitting `handle: ''`.

If a build session wants to be more permissive (e.g., to omit unresolvable actors from feeds rather than fail the whole call), the right place is *inside* the hydration helper — catch the resolve error per-DID and either return a sentinel or filter the row out. That's an enhancement, not a requirement; default to throwing per the canonical shape.

### 7. Cache lifetime

`MemoryCache` lives in the AppView process. Wiping `data/appview.sqlite` doesn't touch the cache. AppView restart re-creates a fresh empty cache; the first query for each DID pays one PLC roundtrip. Against the local PLC (`http://localhost:2582`) that's sub-millisecond — verified by the existing `_health` curl pattern. Trade-off documented in the ADR.

## Verification

1. **Existing smoke tests pass.** `mcp/scripts/conversation-test.mjs` and `mcp/scripts/persistence-test.mjs` should both still pass with no modification. The lexicon-level output validation now sees handles coming from `IdResolver` instead of from `actors.handle`, but the shape is identical (still `format: handle`).

2. **Cold-start scenario.** New test (or expanded conversation-test): wipe `data/appview.sqlite`, restart the AppView, run `getTimeline` for a viewer. Pre-spec: emits `handle: ''` (old server) or `500` (new server). Post-spec: emits the correct handle from `IdResolver` cache miss → PLC lookup.

3. **Cache invalidation on `#identity`.** Adversarial: bind a fresh `#identity` event in a unit-ish test (build session decides shape — could be a synthetic event handed to `handleEvent`), assert `idCache.checkCache(did)` returns null afterwards.

4. **Schema migration idempotence.** Boot against a fresh `data/appview.sqlite` (no `handle` column to drop) and confirm migration no-ops. Boot against an existing one (with `handle`) and confirm migration runs once. Boot again and confirm migration no-ops the second time.

## Out of scope

- `actors.active` and `actors.status` — still maintained from `#account` events. They're orthogonal: account-state is the indexer's job; identity is the identity layer's. This spec doesn't touch them.
- Profile records (`displayName`, `avatar`, `bio`) — those are repo records (`ait.actor.profile`), not identity. When profile editing lands (`specs/profile.md`), it's a separate spec.
- Replacing the local `MemoryCache` with a persisted cache (e.g., SQLite-backed) — only matters if the AppView's process churn becomes high and PLC roundtrips on cache miss become a bottleneck. Doesn't fire today.
- Refactoring the existing JWT-verification path through `resolveAtprotoKey` — it already uses the same `idResolver`; the cache addition makes it faster for free, no other change needed.

## Open questions for the build session

These need a decision during the build, not pre-decided here:

1. **Schema migration shape:** which path (`ALTER TABLE ... DROP COLUMN` if better-sqlite3 supports it, vs the CREATE+SELECT+RENAME canonical pattern)? Verify locally and pick the simpler.
2. **`idResolver` plumbing:** thread as an argument vs attach to the `Db` wrapper vs construct a context object that carries both? Style call, pick whichever matches the AppView's existing shape.
3. **`MemoryCache` TTL:** the default `staleTTL = HOUR` is fine for production; for the cold-start smoke test, a long stale window means the test can't easily assert "second call doesn't roundtrip." Either expose a shorter TTL via an env var, or accept that the staleness test reads through cached data (which is the canonical behavior anyway).
4. **Hydration error policy:** strict (throw → 500) or permissive (filter unresolvable actors from feeds)? Spec defaults to strict; build session can choose otherwise if there's a concrete UX reason in AIT's tooling.

## Pre-impl gates

1. **Read ADR-0037 §"Cold-start data-completeness exposed"** (`decisions/0037-appview-uses-canonical-xrpc-server.md`). The problem framing this spec resolves.
2. **Read `appview/src/server.ts:27` and `appview/src/xrpc/auth.ts:9-30`.** See where `IdResolver` is constructed today and how it's already consumed for JWT verification. The cache wiring sits at the construction site.
3. **Read `appview/node_modules/@atproto/identity/dist/did/base-resolver.js:69-110`** — `resolve`, `resolveAtprotoData`, `resolveAtprotoKey`, cache-write-through. Build session confirms the API surface this spec verifies against.
4. **Read all four query files** (`appview/src/queries/{getTimeline,getAuthorFeed,getPostThread,listNotifications}.ts`). The handle-JOIN deletions touch each.

## After the build

ADR-0038. Frame as: state the AppView could not always honor was removed from the schema; the bug class (incomplete handle state at cold start) is gone by construction. Reference ADR-0028 ("use canonical implementations"): the identity layer is canonical and exists for exactly this purpose; the AppView wasn't using it for hydration before, now it is. Cross-reference ADR-0037's cold-start note as the precipitating observation.
