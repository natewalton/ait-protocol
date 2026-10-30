import type { AtpAgent } from '@atproto/api'
import { isValidHandle } from '@atproto/syntax'
import { resolveActorDid } from './actorLookup.js'

// Friendly labels, legacy handles, and explicit @{did:...} selection. Keep
// punctuation outside facets and avoid matching inside email addresses.
const MENTION_RE = /(?<![\p{L}\p{N}_@])@(\{did:[^{}\s]+\}|[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?![\p{L}\p{N}_-]|\.[a-z0-9-])/giu

export interface MentionFacet {
  index: { byteStart: number; byteEnd: number }
  features: [{ $type: 'app.bsky.richtext.facet#mention'; did: string }]
}

export async function buildMentionFacets(
  _agent: AtpAgent, // Retained for existing MCP and aitty callers.
  text: string,
): Promise<MentionFacet[]> {
  const matches = [...text.matchAll(MENTION_RE)]
  if (matches.length === 0) return []

  // Resolve each unique actor once, then map back to facets per occurrence.
  // Each occurrence gets its own facet (bsky behavior); the AppView dedupes
  // per (uri, recipientDid) when emitting notifications.
  const actors = matches.map((m) => m[1].startsWith('{')
    ? m[1].slice(1, -1)
    : m[1].includes('.') ? m[1] : m[1].toLowerCase())
  // Invalid ordinary @tokens remain literal text. Explicit DID selections
  // always go through validation; their failures must not be silently skipped.
  const uniqueActors = [...new Set(actors.filter((actor, i) =>
    matches[i][1].startsWith('{') ||
    isValidHandle(actor.includes('.') ? actor : `${actor}.aitproto.com`),
  ))]
  const didByActor = new Map<string, string>()
  await Promise.all(
    uniqueActors.map(async (actor) => {
      const did = await resolveActorDid(actor)
      if (did) didByActor.set(actor, did)
    }),
  )

  const encoder = new TextEncoder()
  const facets: MentionFacet[] = []
  for (const [i, m] of matches.entries()) {
    const did = didByActor.get(actors[i])
    if (!did) continue
    const charStart = m.index ?? 0
    const charEnd = charStart + m[0].length
    const byteStart = encoder.encode(text.slice(0, charStart)).length
    const byteEnd = encoder.encode(text.slice(0, charEnd)).length
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#mention', did }],
    })
  }
  return facets
}
