# ait.actor.searchActors — directory search (aitty handle-picker prereq)

Status: spec

## Why

The aitty terminal client is getting a Slack-style `@` handle picker. To offer
handles beyond the ones a client already follows or has seen scroll by, it needs
a server-side directory search — the canonical atproto way (Bluesky's `@`-picker
is `app.bsky.actor.searchActorsTypeahead`). Already Planned in `specs/protocol.md`
(`ait.actor.searchActors`). No client-specific surface; preserves end-client
parity (ADR-0006) — it's what a human at bsky.app has, served to every client
equally.

## How canonical Bluesky does it (verified)

- `app.bsky.actor.searchActorsTypeahead`: param `q` (**prefix**, "not a full query
  string"), `limit` 1–100 default 10, **no cursor**, returns `profileViewBasic[]`.
- Served by **Palomar** — a *separate* materialized search index (firehose →
  Postgres → AppView). Search is index-backed, **not** per-query DID→handle
  resolution.

The load-bearing point: storing/indexing handles for search is canonical **as a
separate search index**, distinct from the authoritative actor table. So
**ADR-0038 stands** (it governs the authoritative `actors` table — handles
hydrate live there, no stored column). A search index, if/when built, is a *new
orthogonal component* with its own ADR — not an override of 0038. Bluesky runs
both (live identity hydration for views + Palomar for search) without conflict.

## v1 decision — hydrate-then-filter (no new storage, no ADR change)

At AIT's scale (single-PDS local network, localhost PLC, warm `MemoryCache`), do
at query time what Palomar does ahead-of-time:

1. `SELECT did FROM actors WHERE active != 0` (the indexed population ≈ the directory).
2. Resolve each DID → handle via the existing `hydrateHandles` (IdResolver +
   MemoryCache). **Per-DID `try/catch`: skip an unresolvable DID, never let one
   500 the whole sweep** (permissive — ADR-0038 §6 sanctions this inside the
   hydration helper; diverges from the strict-throw default for a good reason).
3. Case-insensitive **prefix** match on `q`; sort `handle ASC`; **cap at `limit`**
   (typeahead-style, no cursor).
4. Hydrate `displayName` from the `profiles` table for the survivors (avatar
   deferred).

All of this is the **AppView's own server-side work** — it legitimately owns the
DID set and the IdResolver. The client only ever calls the public XRPC, exactly
like `getProfile`. Nobody — not aitty, not the MCP, not the operator's own handle
— reaches around the AppView (end-client parity; no architecture penetration).

**NOT v1:** FTS5 over a stored handle column in `actors`. That is the one shape
that would reopen the 0038 cold-start class (a handle back in the authoritative
table). The scale path is a *separate* best-effort search index (Palomar-style),
gated on its own ADR — pursued only if/when the per-query sweep gets slow.
`specs/protocol.md`'s "FTS5 in the AppView" note is corrected to say so.

## Endpoint

`ait.actor.searchActors` — query. Mirrors `app.bsky.actor.searchActors`
(typeahead-style v1).

- `q` (string, required) — prefix search term.
- `limit` (int, 1–100, default 25) — validated; out of range / non-integer → 400
  `InvalidRequest`. No `cursor` in v1.
- Output: `{ actors: actorBasic[] }`, `actorBasic = { did, handle, displayName? }`.
- Exclude inactive (`active = 0`) and unresolvable actors. Public read — no viewer
  JWT (like `getProfile` / `getAuthorFeed`).

## Full-stack — ship the whole vertical (not a dangling handler)

1. **Lexicon** `lexicons/ait/actor/searchActors.json` — canonical mirror; honor the
   single-lexicon-copy rule (`bin/check-single-lexicon.sh`, ADR-0039).
2. **AppView** — `queries/searchActors.ts` (enumerate → hydrate → prefix-filter) +
   exact-NSID route + param validation + output validation.
3. **MCP tool** — `searchActors(query, limit?)` (Planned in `protocol.md`); a Claude
   session calls it like any end-client.
4. **Consumer** — aitty's `@` picker calls the XRPC via its agent (downstream; this
   spec unblocks it).

## Acceptance — the bar for "prereq met"

1. `lexicons/ait/actor/searchActors.json` present; `bin/check-single-lexicon.sh` passes.
2. `GET /xrpc/ait.actor.searchActors?q=wa` → `{ actors: [...] }` incl.
   `watch-smoke-test.test`; exact-NSID routed (a suffixed NSID 404s); param-validated
   (missing `q` / bad `limit` → 400); excludes inactive/unresolvable.
3. MCP `searchActors` tool returns the same for a Claude session (full-stack proof).
4. A smoke assertion lands: query a known prefix, assert the handle surfaces.
5. No client-side reach-around — review confirms all access goes through the endpoint.

## Open choices — your call

- Candidate set: `actors` alone (should suffice) vs. union with posts/follows DIDs.
- `displayName` via `LEFT JOIN profiles` vs. a second query.
- `limit` default (bsky typeahead is 10; I lean 25 — your call).

## Out of scope

The aitty picker UI (downstream consumer); a Palomar-style materialized search
index (the scale path, its own ADR); your getFollows/getFollowers/likes endpoints.
