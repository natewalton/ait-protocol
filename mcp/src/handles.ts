import type { AtpAgent } from '@atproto/api'
import { ensureValidDid } from '@atproto/syntax'

// Convenience labels never replace canonical handles in identities or records.
export function displayHandle(handle: string): string {
  return handle.match(/^([a-z0-9-]+)\.(?:test|[a-z2-7]{52}\.aitproto\.com)$/i)?.[1] ?? handle
}

export function normalizeActor(actor: string): string {
  const value = actor.trim().replace(/^@/, '')
  return value.startsWith('did:') ? value : value.toLowerCase()
}

export class UnknownActorError extends Error {}

export async function resolveActor(
  agent: AtpAgent,
  reference: string,
  retiredOnly = false,
): Promise<{ did: string; handle: string }> {
  const actor = normalizeActor(reference)
  if (actor.startsWith('did:')) {
    ensureValidDid(actor)
    return { did: actor, handle: actor }
  }
  if (actor.includes('.')) {
    // Private peers resolve only through the local verified projection. A PDS
    // or public resolver must not turn a peer label into a different identity.
    const { resolveActorDid } = await import('./atproto/actorLookup.js')
    const did = await resolveActorDid(actor)
    if (!did) throw new UnknownActorError(`No AIT actor matches @${actor}.`)
    return { did, handle: actor }
  }
  let result
  try {
    // Display-only consumers (including the selector) need no lexicon files.
    const { appviewProxyHeaders } = await import('./atproto/aitClient.js')
    result = await agent.call('ait.actor.searchActors', {
      q: `${actor}.`, limit: 2, retiredOnly,
    }, undefined, { headers: appviewProxyHeaders() })
  } catch (error) {
    // Preserve XRPC status/error so the enclosing authenticated client can
    // perform its ordinary expired-token recovery before reporting failure.
    if (error instanceof Error) error.message = `Could not look up @${actor}; no action was taken. ${error.message}`
    throw error
  }
  const { actors } = result.data as { actors: { did: string; handle: string }[] }
  // Keep every candidate before checking its label: a second result always
  // proves ambiguity, including a custom-domain handle that displays in full.
  if (actors.length > 1) {
    throw new Error(`@${actor} is ambiguous; matches include (use a full handle or DID):\n` +
      actors.map((entry) => `@${entry.handle} (${entry.did})`).join('\n'))
  }
  const match = actors[0]
  if (!match || displayHandle(match.handle).toLowerCase() !== actor) {
    throw new UnknownActorError(`No AIT actor matches @${actor}. Use a full handle or DID.`)
  }
  ensureValidDid(match.did)
  return match
}
