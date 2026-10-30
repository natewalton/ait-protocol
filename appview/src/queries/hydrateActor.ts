// Display peer names from verified projection, including while Unlinked or
// offline. This is never used to authenticate a JWT or verify a repository.

import type { IdResolver } from '@atproto/identity'
import type { Db } from '../db.js'

export function friendlyHandle(handle: string): string {
  // Only the approved private namespace and its shorthand query placeholder
  // have friendly names. .test is retained solely for pre-upgrade identities.
  const privateName = handle.match(/^([a-z0-9-]+)\.(?:[a-z2-7]{52}\.)?aitproto\.com$/i)
  return privateName?.[1] ?? handle.replace(/\.test$/i, '')
}

export function qualifyActorLabel(label: string, source: string | null, did: string): string {
  // Directory displayName has a 64-grapheme limit. The short machine hint is
  // for people; retain the full DID for an unambiguous identity.
  const suffix = `@${(source ?? 'unknown').slice(0, 8)}#${did}`
  const name = Array.from(friendlyHandle(label)).slice(0, Math.max(0, 64 - suffix.length)).join('')
  return `${name}${suffix}`
}

export async function hydrateHandle(
  idResolver: IdResolver,
  did: string,
  db?: Db,
): Promise<string> {
  const actor = db?.prepare('SELECT source, claimedHandle FROM actors WHERE did = ?').get(did) as
    { source: string | null; claimedHandle: string | null } | undefined
  if (actor?.source && actor.source !== 'local' && actor.claimedHandle) return actor.claimedHandle
  const data = await idResolver.did.resolveAtprotoData(did)
  return data.handle
}

export async function hydrateHandles(
  idResolver: IdResolver,
  dids: readonly string[],
  db?: Db,
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(dids))
  const handles = await Promise.all(
    unique.map((did) => hydrateHandle(idResolver, did, db)),
  )
  return new Map(unique.map((did, i) => [did, handles[i]]))
}
