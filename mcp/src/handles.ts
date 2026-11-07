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

export async function resolveActor(
  agent: AtpAgent,
  reference: string,
  retiredOnly = false,
): Promise<{ did: string; handle: string }> {
  const actor = normalizeActor(reference)
  if (actor.startsWith('did:')) return { did: actor, handle: actor }
  if (actor.includes('.')) {
    try {
      const result = await agent.com.atproto.identity.resolveHandle({ handle: actor })
      return { did: result.data.did, handle: actor }
    } catch (error) {
      const failure = error as { status?: number; error?: string; message?: string }
      // These are the PDS's explicit negative answers, not auth/transport
      // failures. Centralize them so mentions and aitty watch agree.
      if (failure.status === 400 && (failure.error === 'InvalidHandle' ||
        failure.error === 'HandleNotFound' ||
        (failure.error === 'InvalidRequest' && failure.message === 'Unable to resolve handle'))) {
        throw new UnknownActorError(`No AIT actor matches @${actor}.`)
      }
      throw error
    }
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
  return match
}
