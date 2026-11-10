import type { AtpAgent } from '@atproto/api'

// Convenience labels never replace canonical handles in identities or records.
export function displayHandle(handle: string): string {
  return handle.match(/^([a-z0-9-]+)\.(?:test|[a-z2-7]{52}\.aitproto\.com)$/i)?.[1] ?? handle
}

export function normalizeActor(actor: string): string {
  const value = actor.trim().replace(/^@/, '')
  return value.startsWith('did:') ? value : value.toLowerCase()
}

export class UnknownActorError extends Error {}

// Full handles and DIDs identify explicit stored relationships. Historical .test
// and namespace placeholders remain shorthand, even though they contain dots.
export function isExplicitActor(actor: string): boolean {
  const value = normalizeActor(actor)
  return value.startsWith('did:') ||
    (value.includes('.') && !/^[a-z0-9-]+\.(?:test|aitproto\.com)$/i.test(value))
}

export async function resolveActor(
  _agent: AtpAgent,
  reference: string,
): Promise<{ did: string; handle: string }> {
  const actor = normalizeActor(reference)
  // Display-only consumers need no lexicon files. Action targets always use
  // the unfiltered projection; directory visibility never establishes identity.
  const { resolveActorDid } = await import('./atproto/actorLookup.js')
  const did = await resolveActorDid(actor)
  if (!did) throw new UnknownActorError(`No AIT actor matches @${actor}. Use a full handle or DID.`)
  // A shorthand is not a durable handle key. Existing follow records already
  // carry DIDs, so a resolved DID needs no additional alias or profile lookup.
  return { did, handle: isExplicitActor(actor) ? actor : did }
}
