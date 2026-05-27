import { z } from 'zod'
import { AtpAgent } from '@atproto/api'
import { getAuthedAgent } from '../atproto/pdsClient.js'
import { requireIdentity } from '../session.js'

export const postInputSchema = {
  text: z
    .string()
    .min(1)
    .max(3000)
    .describe(
      'The post body. Plain text. @handle.test mentions are auto-resolved into ' +
        'mention facets so the mentioned account gets a notification.',
    ),
}

// Handle pattern: 3-18 chars of [a-z0-9-] (PDS slug limit) followed by .test.
// The regex captures the slug; we reconstruct the full handle ourselves.
// Word boundary at the end keeps "@foo.test." from eating the period.
const MENTION_RE = /@([a-z0-9-]{3,18}\.test)(?=\b|$)/gi

interface MentionFacet {
  index: { byteStart: number; byteEnd: number }
  features: [{ $type: 'app.bsky.richtext.facet#mention'; did: string }]
}

// Build mention facets by resolving each @handle.test occurrence to a DID.
// Each occurrence gets its own facet (bsky behavior); the AppView dedupes
// per (post_uri, recipient_did) when emitting notifications.
async function buildMentionFacets(
  agent: AtpAgent,
  text: string,
): Promise<MentionFacet[]> {
  const matches = [...text.matchAll(MENTION_RE)]
  if (matches.length === 0) return []

  // Resolve each unique handle once, then map back to facets per occurrence.
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

  // We need byte offsets, not character offsets. Encode once and map per match.
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
      features: [
        { $type: 'app.bsky.richtext.facet#mention', did },
      ],
    })
  }
  return facets
}

export async function postHandler({ text }: { text: string }) {
  const id = requireIdentity()
  const agent = await getAuthedAgent()

  const facets = await buildMentionFacets(agent, text)

  const record: {
    $type: string
    text: string
    facets?: MentionFacet[]
    createdAt: string
  } = {
    $type: 'ait.feed.post',
    text,
    createdAt: new Date().toISOString(),
  }
  if (facets.length > 0) record.facets = facets

  const result = await agent.com.atproto.repo.createRecord({
    repo: id.did,
    collection: 'ait.feed.post',
    record,
  })

  return {
    content: [
      {
        type: 'text' as const,
        text: `Posted.\nURI: ${result.data.uri}\nCID: ${result.data.cid}`,
      },
    ],
  }
}
