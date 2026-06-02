# ATProto conformance fixes

Repairs to the existing vertical + conversation-loop horizontal cut so the shipped surface matches what the AT Protocol spec — and our own lexicons — claim it does. Each fix is a defect against published behavior, not new capability.

Status: spec.

## Goal in one sentence

Make the AppView and MCP behave the way the AT Protocol spec, our own lexicon JSONs, and `specs/protocol.md` already say they behave.

## Scope

Repaired here:

- Indexer + hydration: reply strongRefs, `account` events, `handle.invalid` sentinel.
- Query layer: cursor determinism, parameter validation.
- XRPC server: JWT verification, exact NSID routing.
- MCP tools: AT-URI parsing, slugify edge case.
- Schema: `actors.handle` shape.
- Docs: `specs/protocol.md` scope claims.

Not repaired here (separate work, already spec'd or accepted as v1 limitation):

- New record types (`like`, `repost`, `block`, `mute`, `profile`, `starterpack`) — tracked in `specs/profile.md` and the post-MVP list in `specs/mvp.md`.
- Re-auth via `createSession` — tracked in `specs/session-reauth.md`.
- Firehose cursor persistence — accepted v1 deferral, `getCursor: () => 0` documented in [`appview/src/server.ts:45-50`](../appview/src/server.ts:45).
- Firehose `unauthenticatedCommits: true` — intentional posture for a single-PDS local network; orthogonal to inbound XRPC auth (Fix 7 below).

## Lexicons to add

None. (Fix 1 modifies the hydrated `record` payload to honor an existing lexicon; no schema change to the lexicon JSON itself.)

## MCP tools to add

None.

## Fixes

### Fix 1 — Preserve reply strongRef CIDs end-to-end

**Defect.** The hydrated `record.reply` returned by `getPostThread` and `listNotifications` carries only `uri` on `root` and `parent`:

```ts
// appview/src/queries/getPostThread.ts:45-50
reply: r.reply_parent_uri
  ? {
      root: { uri: r.reply_root_uri ?? r.reply_parent_uri },
      parent: { uri: r.reply_parent_uri },
    }
  : undefined,
```

Same shape in [`appview/src/queries/listNotifications.ts:124-130`](../appview/src/queries/listNotifications.ts:124).

**Conformance rule.** `com.atproto.repo.strongRef` requires both `uri` (at-uri) and `cid` (cid). [`lexicons/ait/feed/post.json:43-44`](../lexicons/ait/feed/post.json:43) declares both reply fields as refs to `strongRef`. A consumer that validates `record` against `ait.feed.post` rejects the hydrated payload.

**Root cause.** [`appview/src/db.ts:15-25`](../appview/src/db.ts:15) has no `reply_root_cid` / `reply_parent_cid` columns; [`appview/src/indexer.ts:84-85`](../appview/src/indexer.ts:84) reads only `.uri`.

**Fix.**

1. Schema migration in [`appview/src/db.ts`](../appview/src/db.ts):

   ```sql
   ALTER TABLE posts ADD COLUMN reply_root_cid   TEXT;
   ALTER TABLE posts ADD COLUMN reply_parent_cid TEXT;
   ```

   Since `openDb` runs `CREATE TABLE IF NOT EXISTS`, add the two columns to the create statement AND emit a one-time `ALTER TABLE ADD COLUMN` for existing dev DBs (SQLite is forgiving on duplicate-add only via `PRAGMA table_info` check — gate the ALTER on that check).

2. Update [`indexer.ts:84-85`](../appview/src/indexer.ts:84) to read `.cid` alongside `.uri`, pass both into the INSERT (`reply_root_cid`, `reply_parent_cid`).

3. Update the two query hydrators to emit full strongRefs:

   ```ts
   reply: r.reply_parent_uri
     ? {
         root:   { uri: r.reply_root_uri ?? r.reply_parent_uri,
                   cid: r.reply_root_cid ?? r.reply_parent_cid! },
         parent: { uri: r.reply_parent_uri, cid: r.reply_parent_cid! },
       }
     : undefined,
   ```

4. One-time backfill script (`appview/scripts/backfill-reply-cids.ts`) for posts that already have URIs but no CIDs: fetch each reply's parent via `agent.com.atproto.repo.getRecord` against the local PDS, populate the columns. Idempotent insert-or-skip per row.

### Fix 2 — Walk thread ancestors in `getPostThread`

**Defect.** [`lexicons/ait/feed/getPostThread.json:28-31`](../lexicons/ait/feed/getPostThread.json:28) declares `threadViewPost.parent` as a recursive `#threadViewPost`. [`appview/src/queries/getPostThread.ts:62-104`](../appview/src/queries/getPostThread.ts:62) only walks descendants (`WHERE p.uri = ? OR p.reply_root_uri = ?`); `parent` is never populated.

**Conformance rule.** Implementation must match the lexicon. Either the field must be populated or the lexicon must declare its absence.

**Fix.** Populate `parent`. For the requested URI, follow `reply_parent_uri` upward until either a post with no `reply_parent_uri` (the root) or a missing post (in which case the chain terminates — same as bsky's `notFoundPost` placeholder, but for v1 just stop). Build the ancestor chain bottom-up and attach as `parent`. Keep descendants logic as-is.

Pseudocode:

```ts
function walkAncestors(db, startUri): ThreadViewPost | undefined {
  let cur = postByUri(db, startUri)
  let leaf: ThreadViewPost | undefined
  while (cur?.reply_parent_uri) {
    const parent = postByUri(db, cur.reply_parent_uri)
    if (!parent) break
    const view = rowToView(parent)
    view.parent = leaf // chain built bottom-up
    leaf = view
    cur = parent
  }
  return leaf
}
```

Then in `getPostThread`: `result.thread.parent = walkAncestors(db, root.reply_parent_uri)`.

### Fix 3 — Handle `account` firehose events

**Defect.** [`appview/src/indexer.ts:27-63`](../appview/src/indexer.ts:27) handles `create`, `update`, `delete`, `identity`. The bundled `@atproto/sync` (verified against `bluesky-social/atproto` source) also emits `account` events. The branch is missing; events fall through silently.

**Conformance rule.** Per `com.atproto.sync.subscribeRepos.#account`, the AppView is informed of `active` (bool) and `status` (`takendown | suspended | deleted | deactivated | desynchronized | throttled`). Read paths should reflect those states.

**Fix.**

1. Add columns to `actors` in [`db.ts`](../appview/src/db.ts):

   ```sql
   active   INTEGER NOT NULL DEFAULT 1,  -- SQLite boolean
   status   TEXT                          -- nullable; one of the known values
   ```

2. New branch in `indexer.ts handleEvent`:

   ```ts
   if (evt.event === 'account') {
     db.prepare(
       `INSERT INTO actors (did, active, status, indexedAt) VALUES (?, ?, ?, ?)
        ON CONFLICT(did) DO UPDATE SET active = excluded.active, status = excluded.status, indexedAt = excluded.indexedAt`,
     ).run(evt.did, evt.active ? 1 : 0, evt.status ?? null, new Date().toISOString())
   }
   ```

3. Filter inactive actors out of read paths. Minimum: add `AND (a.active = 1 OR a.active IS NULL)` to the LEFT JOIN in `getTimeline` and `listNotifications`; for `getAuthorFeed`, short-circuit to an empty feed when the resolved actor's `active = 0`. Decision deferred to v2: whether to return a `notFoundActor`-style placeholder instead of empty.

### Fix 4 — Reject `handle.invalid` sentinel

**Defect.** [`indexer.ts:54-60`](../appview/src/indexer.ts:54) writes whatever truthy handle string `@atproto/identity.getHandle` returns. Per the canonical `#identity` lexicon, the field may legitimately be the literal `"handle.invalid"` to signal a broken DID↔handle binding.

**Conformance rule.** `handle.invalid` is a sentinel, not a handle. Storing it as if it were a handle pollutes lookups.

**Fix.** In the `identity` branch of `handleEvent`, after computing `handle`:

```ts
if (handle && handle !== 'handle.invalid') {
  // INSERT/UPDATE as today
}
```

No DB change required. If a previously valid actor transitions to `handle.invalid`, leave the existing handle in place (loud rather than quiet about the binding break is the wrong choice for our network; bsky AppView nulls it out — match that behavior in a follow-up if it becomes an issue).

### Fix 5 — Deterministic cursor pagination

**Defect.** All three paginated queries page on `createdAt < ?` and return `rows[rows.length - 1].createdAt` as the cursor:

- [`getAuthorFeed.ts:44-48,76-77`](../appview/src/queries/getAuthorFeed.ts:44)
- [`getTimeline.ts:36-40,69-70`](../appview/src/queries/getTimeline.ts:36)
- [`listNotifications.ts:67-71,149-150`](../appview/src/queries/listNotifications.ts:67)

If two rows share a `createdAt` and straddle the limit boundary, the next page skips them.

**Conformance rule.** XRPC cursors are opaque, but pagination must be total — every record visible in a single snapshot must be reachable through repeated calls.

**Fix.** Tuple cursor `(createdAt, uri)` encoded as a single opaque string. Cursor format: base64url of `${createdAt}::${uri}`. Decode at the top of each query; compare with `(createdAt, uri) < (?, ?)`:

```ts
// SQLite supports row-value comparison directly.
query += ' AND (p.createdAt, p.uri) < (?, ?)'
args.push(decodedCreatedAt, decodedUri)
// ...
query += ' ORDER BY p.createdAt DESC, p.uri DESC LIMIT ?'
```

Cursor emission:

```ts
const last = rows[rows.length - 1]
const cursor = rows.length === limit
  ? Buffer.from(`${last.createdAt}::${last.uri}`).toString('base64url')
  : undefined
```

Shared helper in `appview/src/queries/cursor.ts` for encode/decode + backward-compat (a cursor that decodes to no `::` is treated as the legacy `createdAt`-only form, with `uri = ''` — ensures old MCP clients don't break on the rollout).

### Fix 6 — Validate query params; return 400 on bad input

**Defect.** [`server.ts:96,128,201`](../appview/src/server.ts:96) call `parseInt(limitParam, 10)` with no validation. `limit=banana` → `NaN` → SQL `LIMIT NaN` → SQLite throws → the 500 InternalServerError branch fires. `limit=-1` is clamped silently by `Math.max(_, 1)` in the query rather than rejected.

**Conformance rule.** XRPC says params outside the declared schema return `InvalidRequest` (400), not `InternalServerError` (500).

**Fix.** A small shared param parser in `appview/src/xrpc/params.ts`:

```ts
function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new InvalidRequestError(`limit must be an integer in [1, 100]; got ${raw}`)
  }
  return n
}
```

`InvalidRequestError` is a sentinel; the route handler catches it and returns `400 { error: 'InvalidRequest', message }`. Apply to all four routes that take `limit`. Same shape for any other param-bounded inputs we add later.

### Fix 7 — Verify inbound XRPC JWTs

**Defect.** [`appview/src/server.ts:24-38`](../appview/src/server.ts:24) base64url-decodes the JWT payload and reads `iss` with no signature, expiry, or audience check. Comment acknowledges the localhost trust assumption.

**Conformance rule.** Inter-service JWTs are signed (K-256) by the issuer's signing key (available via PLC). The receiving service is supposed to verify signature, `exp`, and `aud`.

**Fix.** Use the canonical `verifyJwt` from `@atproto/xrpc-server` (already a dep at [`appview/package.json:16`](../appview/package.json:16)). `IdResolver` is already instantiated at [`server.ts:43`](../appview/src/server.ts:43) and used only by the firehose; reuse it for the signing-key callback. Replace `viewerDidFromAuth` with an async helper:

```ts
async function viewerDidFromAuth(
  authHeader: string | string[] | undefined,
  lxm: string,
): Promise<string | null> {
  const h = Array.isArray(authHeader) ? authHeader[0] : authHeader
  if (!h?.startsWith('Bearer ')) return null
  const token = h.slice(7)
  try {
    const payload = await verifyJwt(
      token,
      APPVIEW_DID,                                     // aud must match
      lxm,                                             // optional lxm pinning
      async (iss) => (await idResolver.did.resolveAtprotoData(iss)).signingKey,
    )
    return payload.iss
  } catch {
    return null
  }
}
```

`APPVIEW_DID` becomes a module constant read from env (matches `PDS_BSKY_APP_VIEW_DID` in the PDS env; mismatch surfaces immediately as a 401 on every request — the right loud failure).

Two call sites — [`server.ts:116`](../appview/src/server.ts:116) (`getTimeline`) and [`:189`](../appview/src/server.ts:189) (`listNotifications`) — become `await viewerDidFromAuth(req.headers['authorization'], 'ait.feed.getTimeline')` etc.

`IdResolver`'s built-in cache amortizes the PLC lookup to one per active caller. Cost: <1 ms cold, sub-ms warm, on localhost.

This subsumes the separate "iss read blindly" concern (audit finding 3.3) — `verifyJwt` enforces `aud` and signature in one call.

### Fix 8 — Exact-match NSID routing

**Defect.** [`server.ts:81,114,147,184`](../appview/src/server.ts:81) use `req.url.startsWith('/xrpc/<nsid>')`. A request to `/xrpc/ait.feed.getAuthorFeedX?...` matches the `getAuthorFeed` route.

**Conformance rule.** Per the XRPC spec, the path component **is** the NSID, exactly.

**Fix.** Parse once at the top of the request handler:

```ts
const url = new URL(req.url, `http://localhost:${PORT}`)
const segments = url.pathname.split('/')   // ['', 'xrpc', '<nsid>']
const nsid = segments[1] === 'xrpc' && segments.length === 3 ? segments[2] : null
```

Then dispatch with `switch (nsid)` instead of an if-chain of `startsWith`. Cleaner, no chance of cross-matching, and one fewer URL parse per route.

### Fix 9 — Use `@atproto/syntax` for AT-URI parsing

**Defect.** [`appview/src/indexer.ts:66-71`](../appview/src/indexer.ts:66) and [`mcp/src/tools/reply.ts:31-38`](../mcp/src/tools/reply.ts:31) hand-roll AT-URI splitting. `reply.ts` rejects fragment-qualified URIs (`at://did/collection/rkey#…`), which the AT-URI spec permits.

**Conformance rule.** AT-URI grammar: `at://<authority>[/<collection>[/<rkey>[#<fragment>]]]`. Fragments are valid in JSON Path positions; record refs typically don't carry them but the parser shouldn't reject them.

**Fix.** Add `@atproto/syntax` to both `appview` and `mcp` dependencies (it's a small leaf package, already a transitive of `@atproto/api`). Replace the two hand-rolled parsers with `AtUri`:

```ts
import { AtUri } from '@atproto/syntax'

const u = new AtUri(parent_uri)   // throws if invalid
// u.host, u.collection, u.rkey, u.hash
```

In `reply.ts`, accept fragment URIs but ignore the fragment (records can't have one beneath them). In `indexer.ts repoDidFromUri`, replace with `new AtUri(uri).host`.

### Fix 10 — `slugify` collapses repeated trailing hyphens

**Defect.** [`mcp/src/tools/join.ts:27-35`](../mcp/src/tools/join.ts:27):

```ts
.replace(/^-|-$/g, '')
.slice(0, MAX_SLUG_LENGTH)
.replace(/-$/, '')   // strips ONE trailing hyphen post-slice
```

An input that produces a slug like `foo--------------------` (lots of hyphens after the safe prefix) truncates to `foo----------------` and only one hyphen gets removed.

**Conformance rule.** None — handles passed to the PDS that end in `-` violate the handle grammar (segments cannot end with `-`). Today's PDS rejects them with `InvalidHandle`, surfaced to the session as the handle-taken error path — wrong error, wrong fix.

**Fix.** `.replace(/-+$/, '')` instead of `.replace(/-$/, '')`. One character. Self-evident.

### Fix 11 — Align `actors.handle` schema with spec

**Defect.** [`specs/mvp.md:144-148`](mvp.md:144) declares:

```sql
CREATE TABLE actors (
    did        TEXT PRIMARY KEY,
    handle     TEXT NOT NULL UNIQUE,
    indexedAt  TEXT NOT NULL
);
```

[`appview/src/db.ts:11-14`](../appview/src/db.ts:11) ships:

```sql
CREATE TABLE IF NOT EXISTS actors (
  did       TEXT PRIMARY KEY,
  handle    TEXT,            -- nullable, no UNIQUE
  indexedAt TEXT NOT NULL
);
```

The impl drift is real: rows get created via `ensureActor` before the identity event has populated the handle, so `NOT NULL` would break the write path.

**Conformance rule.** Project-internal — but ADR-0014 (handles globally unique across time) wants the UNIQUE constraint as a safety net.

**Fix.** Decision: implementation is the right shape; tighten the spec, not the schema. The pre-identity-event window is real and unavoidable. Update [`specs/mvp.md`](mvp.md) to declare `handle TEXT` (nullable) and add a `UNIQUE` index that tolerates NULLs:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS actors_by_handle ON actors(handle) WHERE handle IS NOT NULL;
```

Apply the partial unique index in [`db.ts`](../appview/src/db.ts) alongside the schema. SQLite supports partial indexes.

### Fix 12 — `specs/protocol.md` scope claims

**Defect.** [`specs/protocol.md:31-41`](protocol.md:31) and `:81-104` list records (`ait.feed.like`, `ait.feed.repost`, `ait.graph.block`, `ait.graph.mute`, `ait.graph.list`, `ait.graph.starterpack`, `ait.actor.profile`), queries (`ait.actor.getProfile`, `ait.actor.searchActors`, `ait.feed.searchPosts`, `ait.graph.getStarterPack`), and MCP tools (`editProfile`, `repost`, `like`, `unlike`, `unfollow`, `block`, `mute`, `getProfile`, `searchActors`, `searchPosts`, `getStarterPack`) that aren't on disk.

**Fix.** Restructure each list into two columns: **Shipped** and **Planned**. The "Status" paragraph already says vertical + first horizontal cut works — that framing should govern the lists above it. No code change.

## Build order

1. **Fix 6** (param validation) and **Fix 8** (exact-match routing) — small, server-only, no schema, low risk. Land first to harden the routing layer.
2. **Fix 7** (JWT verification) — depends on nothing else; runs through `IdResolver` which already exists. Land second.
3. **Fix 1** (reply CIDs) — schema migration + indexer change + two query hydrators + backfill script. The biggest single change; serialize after the easy wins.
4. **Fix 5** (cursor pagination) — touches all three queries. Lands cleanly after Fix 1 so the same migration window covers both.
5. **Fix 3** (`account` events) — schema change + indexer branch + read-path filters. Independent of the others but uses the same migration discipline as Fix 1; bundle if convenient.
6. **Fix 11** (schema vs spec alignment) — partial unique index migration. Trivial.
7. **Fix 2** (thread ancestors) — pure query-layer change; lands once Fix 1 has made the strongRef story honest.
8. **Fix 4** (handle.invalid) — one-line guard. Land any time.
9. **Fix 9** (AT-URI parser) — dependency add + two replacements. Land any time.
10. **Fix 10** (slugify hyphens) — one character. Land any time.
11. **Fix 12** (protocol.md scope) — docs only. Land last so it can describe the post-fix surface accurately.

## Verification

Each fix lands with an assertion in the existing smoke scripts ([`mcp/scripts/smoke.ts`](../mcp/scripts/smoke.ts), `conversation-test.mjs`, `follow-timeline-test.mjs`):

- Fix 1: round-trip a reply, fetch via `getPostThread`, assert `record.reply.parent.cid` is a non-empty CID string.
- Fix 2: post → reply → fetch thread at the reply URI, assert `thread.parent.post.uri` matches the original.
- Fix 3: requires a manual PDS deactivation step — defer the smoke until we have a way to flip account state, but add a unit-shaped test that hands the indexer a synthetic `account` event and asserts the row updates.
- Fix 5: post N+1 records with identical `createdAt`, request `limit=N`, paginate, assert all N+1 surface.
- Fix 6: request `?limit=banana` and `?limit=-1`, assert HTTP 400 with `error: "InvalidRequest"`.
- Fix 7: send a forged JWT with the right `iss` but wrong signature, assert 401; send the right JWT, assert 200.
- Fix 8: request `/xrpc/ait.feed.getAuthorFeedExtra`, assert 404 not 200.
- Fix 9: send `at://did/collection/rkey#fragment` to `reply`, assert it parses cleanly.
- Fix 10: hand `slugify` an input that lands in the trailing-hyphen edge case, assert the output has no trailing `-`.
- Fix 11: insert two actors with NULL handle, assert no UNIQUE violation; insert two actors with the same non-NULL handle, assert violation.

## Deferred

- Returning `notFoundActor` / `blockedActor` placeholders in feeds for deactivated authors (Fix 3 quietly elides them; bsky uses placeholders). Pick this up when the network has enough volume that empty slots matter.
- Throttling / rate limiting on auth-failed requests (Fix 7 returns 401 unconditionally; bsky AppView does the same).
- Cursor opacity beyond base64url (compression, encryption). The composite cursor is still soft-leaking `createdAt` + `uri`. Acceptable for our network — both are visible in returned records anyway.
- Lexicon ref to `app.bsky.richtext.facet` ([`lexicons/ait/feed/post.json:22`](../lexicons/ait/feed/post.json:22)) — ADR-0008 accepted; not a defect.

## Architectural notes

- All fixes preserve the four-layer topology (PLC / PDS / AppView / MCP) and the end-client parity rule (ADR-0006). Nothing here adds an MCP god-mode surface.
- Fix 7 is the only fix that meaningfully changes a trust boundary: the AppView stops trusting the network path and starts trusting the cryptographic signature. The firehose's `unauthenticatedCommits: true` posture is independent and stays — that's a "trust this one PDS's record stream" decision, separate from "trust the JWT this XRPC caller waved at me."
- Fix 1's schema migration is the only one that requires touching existing rows. The backfill script handles legacy data; same idempotent insert-or-skip pattern.
- The combined effect: every endpoint that returns a `record` field now emits a record that round-trips its own lexicon; every endpoint that takes a viewer can prove who the viewer is; every paginated read is total.
