import type { AtpAgent } from '@atproto/api'
import { resolveActor, UnknownActorError } from '../handles.js'

// Exclude email/URL/package fragments; periods and other punctuation after a
// complete label stay outside the facet. Code is literal, never an address.
const MENTION_RE = /(?<![\p{L}\p{N}_@/.:=?&#%+-])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?![\p{L}\p{N}_@/-]|\.[a-z0-9])/giu

export interface MentionFacet {
  index: { byteStart: number; byteEnd: number }
  features: [{ $type: 'app.bsky.richtext.facet#mention'; did: string }]
}

export async function buildMentionFacets(
  agent: AtpAgent,
  text: string,
): Promise<MentionFacet[]> {
  const code = [...text.matchAll(/(`+)[\s\S]*?\1/g)].map((match) =>
    [match.index!, match.index! + match[0].length],
  )
  const matches = [...text.matchAll(MENTION_RE)].filter((match) =>
    !code.some(([start, end]) => match.index! >= start && match.index! < end),
  )
  if (matches.length === 0) return []

  // Resolve each unique handle once, then map back to facets per occurrence.
  // Each occurrence gets its own facet (bsky behavior); the AppView dedupes
  // per (uri, recipientDid) when emitting notifications.
  const uniqueHandles = [...new Set(matches.map((m) => m[1].toLowerCase()))]
  const didByHandle = new Map<string, string>()
  await Promise.all(
    uniqueHandles.map(async (handle) => {
      try {
        const actor = await resolveActor(agent, handle)
        didByHandle.set(handle, actor.did)
      } catch (error) {
        if (error instanceof UnknownActorError) return
        // A known negative answer is plain text; transport failures and
        // ambiguous names must stop the write, preserving notification intent.
        const code = (error as { error?: string }).error
        if (code === 'HandleNotFound' || code === 'ResolveFailed') return
        throw error
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
