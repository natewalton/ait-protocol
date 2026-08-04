// Directory retirement (ADR-0043). Retiring an actor writes a timestamp to
// `actors.retiredAt`; searchActors is the only read path that consults it, so a
// retired handle disappears from @-pickers while every post, thread, profile,
// follow, and notification it produced stays exactly as readable as before.
//
// This is AppView-local state, not protocol state: nothing is written to the
// actor's repo and nothing is asked of the PDS, so the account stays active and
// the handle stays bound (ADR-0014). Another AppView indexing the same firehose
// would list the actor normally.

import type { Db } from '../db.js'

export interface SetRetiredParams {
  did: string
  retired: boolean
  now: string
}

export interface SetRetiredResult {
  subject: string
  retiredAt: string | null
}

// Returns null when the AppView has never indexed this DID. Retiring an actor
// with no `actors` row would be a no-op anyway — searchActors sweeps that table,
// so an unindexed DID is already absent from the directory — and silently
// inserting a row for it would put a handle into the actor table that no post,
// follow, or profile ever put there.
//
// Retiring an already-retired actor keeps the original timestamp rather than
// refreshing it, so "retired since" stays truthful across repeat calls.
export function setRetired(
  db: Db,
  params: SetRetiredParams,
): SetRetiredResult | null {
  const existing = db
    .prepare('SELECT retiredAt FROM actors WHERE did = ?')
    .get(params.did) as { retiredAt: string | null } | undefined
  if (!existing) return null

  const retiredAt = params.retired ? (existing.retiredAt ?? params.now) : null
  db.prepare('UPDATE actors SET retiredAt = ? WHERE did = ?').run(
    retiredAt,
    params.did,
  )
  return { subject: params.did, retiredAt }
}
