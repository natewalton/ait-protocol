import type { IdResolver } from '@atproto/identity'
import { INVALID_HANDLE } from '@atproto/syntax'
import type { Db } from '../db.js'
import { hydrateHandle } from './hydrateActor.js'
import { isLive } from '../pushRegistry.js'

export interface SearchActorsParams {
  q: string
  limit: number
  retiredOnly: boolean
}

export interface ActorBasic {
  did: string
  handle: string
  live: boolean
  displayName?: string
}

export interface SearchActorsResult {
  actors: ActorBasic[]
}

interface ActorRow {
  did: string
  displayName: string | null
}

// Directory search backing the aitty @-picker (specs/actor-search.md).
//
// ADR-0038 removed the stored `actors.handle` column — handles are hydrated
// from the DID at query time via IdResolver, never persisted. So there is no
// column to prefix-match in SQL (and no FTS5 index over handles). Instead we
// hydrate-then-filter: pull every active actor, resolve each handle (the
// MemoryCache makes steady-state a hash lookup), prefix-match in memory, sort,
// and cap. For a local single-instance network (ADR-0034) the actor count is
// small, so the O(active actors) sweep is fine for v1. protocol.md's FTS5
// end-state would need a refreshable stored-handle index, which reopens the
// cold-start staleness class ADR-0038 closed — left to a spec/ADR decision.
export async function searchActors(
  db: Db,
  idResolver: IdResolver,
  params: SearchActorsParams,
): Promise<SearchActorsResult> {
  const needle = params.q.toLowerCase()

  // Active actors only — the same exclusion the other read paths apply
  // (getTimeline gates on `a.active = 1 OR a.active IS NULL`). `ensureActor`
  // rows default active=1; an #account event may flip it to 0.
  //
  // Retired actors (ADR-0043) drop out too, and this is the ONLY read path that
  // consults `retiredAt`: retirement takes a handle out of pickers, it does not
  // take its posts down, so getTimeline/getAuthorFeed/getPostThread/getProfile
  // deliberately ignore the column.
  //
  // The two scopes are disjoint, never nested: `retiredOnly` searches the
  // retired set *instead of* the listed one. That keeps the sweep below — which
  // resolves a handle per surviving row, on every keystroke of a picker — as
  // small as the caller's intent. A client asking to restore a handle can only
  // act on retired ones, so offering it listed ones would resolve hundreds of
  // DIDs to fill the dropdown with rows it must reject.
  const retiredFilter = params.retiredOnly
    ? ' AND a.retiredAt IS NOT NULL'
    : ' AND a.retiredAt IS NULL'
  const rows = db
    .prepare(
      `SELECT a.did AS did, p.displayName AS displayName
       FROM actors a
       LEFT JOIN profiles p ON p.did = a.did
       WHERE (a.active = 1 OR a.active IS NULL)${retiredFilter}`,
    )
    .all() as ActorRow[]

  // Hydrate handles concurrently, but per-actor: unlike the single-actor read
  // paths (getProfile/getTimeline), one unresolvable DID must NOT 500 the whole
  // directory sweep — it's excluded, not fatal. This is a deliberate, scoped
  // divergence from ADR-0038's strict propagate-and-500 policy, because the
  // candidate set here is "every actor" rather than "the one you asked for".
  const hydrated = await Promise.all(
    rows.map(async (row) => {
      try {
        const handle = await hydrateHandle(idResolver, row.did)
        return { ...row, handle }
      } catch {
        return null // unresolvable DID — drop it from results
      }
    }),
  )

  const matches: ActorBasic[] = []
  for (const row of hydrated) {
    if (!row) continue
    if (row.handle === INVALID_HANDLE) continue
    if (!row.handle.toLowerCase().startsWith(needle)) continue
    const actor: ActorBasic = { did: row.did, handle: row.handle, live: isLive(row.did) }
    if (row.displayName) actor.displayName = row.displayName
    matches.push(actor)
  }

  // Deterministic order (handle ASC), then cap.
  matches.sort((a, b) => a.handle.localeCompare(b.handle))
  return { actors: matches.slice(0, params.limit) }
}
