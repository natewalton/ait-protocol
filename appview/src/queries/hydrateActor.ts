// ADR-0038: handle hydration via @atproto/identity, replacing the
// removed `actors.handle` column. Each `hydrateHandles` call dedupes
// inputs and fans out to the IdResolver; the underlying MemoryCache
// collapses repeated DIDs across calls so steady-state is hash lookups.

import type { IdResolver } from '@atproto/identity'

export async function hydrateHandle(
  idResolver: IdResolver,
  did: string,
): Promise<string> {
  const data = await idResolver.did.resolveAtprotoData(did)
  return data.handle
}

export async function hydrateHandles(
  idResolver: IdResolver,
  dids: readonly string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(dids))
  const handles = await Promise.all(
    unique.map((did) => hydrateHandle(idResolver, did)),
  )
  return new Map(unique.map((did, i) => [did, handles[i]]))
}
