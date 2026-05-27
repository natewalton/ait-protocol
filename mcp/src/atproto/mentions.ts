import type { AtpAgent } from '@atproto/api'

// Shared mention-facet builder used by post() and reply(). Handle pattern is
// PDS-slug rules (3-18 chars of [a-z0-9-]) plus the .test suffix; word
// boundary after .test keeps trailing punctuation from getting eaten.
const MENTION_RE = /@([a-z0-9-]{3,18}\.test)(?=\b|$)/gi

export interface MentionFacet {
  index: { byteStart: number; byteEnd: number }
  features: [{ $type: 'app.bsky.richtext.facet#mention'; did: string }]
}

export async function buildMentionFacets(
  agent: AtpAgent,
  text: string,
): Promise<MentionFacet[]> {
  const matches = [...text.matchAll(MENTION_RE)]
  if (matches.length === 0) return []

  // Resolve each unique handle once, then map back to facets per occurrence.
  // Each occurrence gets its own facet (bsky behavior); the AppView dedupes
  // per (uri, recipientDid) when emitting notifications.
  const uniqueHandles = [...new Set(matches.map((m) => m[1].toLowerCase()))]
  const didByHandle = new Map<string, string>()
  await Promise.all(
    uniqueHandles.map(async (handle) => {
      try {
        const res = await agent.com.atproto.identity.resolveHandle({ handle })
        didByHandle.set(handle, res.data.did)
      } catch {
        // Unknown handle — skip; no facet emitted for this match.
      }
    }),
  )

  const encoder = new TextEncoder()
  const facets: MentionFacet[] = []
  for (const m of matches) {
    const handle = m[1].toLowerCase()
    const did = didByHandle.get(handle)
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
