import type { IdResolver } from '@atproto/identity'
import { INVALID_HANDLE } from '@atproto/syntax'
import type { Db } from '../db.js'
import { friendlyHandle, hydrateHandle, qualifyActorLabel } from './hydrateActor.js'
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
  source: string | null
  label: string | null
  active: number | null
  retiredAt: string | null
  displayName: string | null
}

// Directory search backing the aitty @-picker (specs/actor-search.md).
//
// Hydrate through the aggregate DID resolver. Source and label in actors are
// event attribution, not an identity authority or a permanent handle cache.
export async function searchActors(
  db: Db,
  idResolver: IdResolver,
  params: SearchActorsParams,
): Promise<SearchActorsResult> {
  const input = params.q.replace(/^@/, '').toLowerCase()
  const needle = /^[a-z0-9-]+\.[a-z2-7]{52}\.aitproto\.com$/.test(input)
    ? input
    : friendlyHandle(input)

  // Active actors only — the same exclusion the other read paths apply
  // (getTimeline gates on `a.active = 1 OR a.active IS NULL`). `ensureActor`
  // rows default active=1; an #account event may flip it to 0.
  //
  // Retired actors (ADR-0043) drop out too, and this is the ONLY read path that
  // consults `retiredAt`: retirement takes a handle out of pickers, it does not
  // take its posts down, so getTimeline/getAuthorFeed/getPostThread/getProfile
  // deliberately ignore the column.
  //
  // Count collisions across both scopes before returning the selected one.
  const rows = db
    .prepare(
      `SELECT a.did, a.source, a.label, a.active, a.retiredAt, p.displayName
       FROM actors a
       LEFT JOIN profiles p ON p.did = a.did`,
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
      } catch (err) {
        console.error(`searchActors: ${row.did}: ${err instanceof Error ? err.message : err}`)
        return null // unresolvable DID — drop it from results
      }
    }),
  )

  // Count before filtering/capping. An inactive, retired, or unresolvable
  // collision must not make a bare label appear safe to address.
  const owners = new Map<string, Set<string>>()
  for (const row of [...rows, ...hydrated.flatMap((row) =>
    row ? [{ did: row.did, label: row.handle }] : [],
  )]) {
    const label = row.label
    if (!label || label === INVALID_HANDLE) continue
    const key = friendlyHandle(label).toLowerCase()
    if (!owners.has(key)) owners.set(key, new Set())
    owners.get(key)!.add(row.did)
  }
  const matches: ActorBasic[] = []
  for (const row of hydrated) {
    if (!row) continue
    if (row.active !== 1 && row.active !== null) continue
    if (params.retiredOnly !== (row.retiredAt !== null)) continue
    if (row.handle === INVALID_HANDLE) continue
    const label = friendlyHandle(row.handle)
    if (!label.toLowerCase().startsWith(needle) && !row.handle.toLowerCase().startsWith(needle)) continue
    const actor: ActorBasic = { did: row.did, handle: row.handle, live: isLive(row.did) }
    const qualified = qualifyActorLabel(label, row.source, row.did)
    actor.displayName = owners.get(label.toLowerCase())!.size > 1
      ? qualified
      : row.displayName || label
    matches.push(actor)
  }

  // Deterministic order (handle ASC), then cap.
  matches.sort((a, b) => a.handle.localeCompare(b.handle))
  return { actors: matches.slice(0, params.limit) }
}
