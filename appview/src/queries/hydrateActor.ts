// Resolve identity through the supplied standard resolver. For private peers
// the caller supplies the aggregate source resolver; failures must propagate.

import type { IdResolver } from '@atproto/identity'

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
