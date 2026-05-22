import { z } from 'zod'
import { getIdentity, requireIdentity } from '../session.js'
import { PDS_URL, APPVIEW_DID } from '../atproto/pdsClient.js'

export const getAuthorFeedInputSchema = {
  actor: z
    .string()
    .optional()
    .describe(
      "The actor whose posts to fetch — a handle (e.g. 'atproto-orchestration.test') or a DID. " +
        "If omitted, defaults to the calling session's own DID.",
    ),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
}

interface FeedItem {
  post: {
    uri: string
    cid: string
    author: { did: string; handle: string }
    record: { text?: string; createdAt?: string }
    indexedAt: string
  }
}

interface FeedResult {
  cursor?: string
  feed: FeedItem[]
}

export async function getAuthorFeedHandler({
  actor,
  limit,
  cursor,
}: {
  actor?: string
  limit?: number
  cursor?: string
}) {
  const id = getIdentity()
  const target = actor ?? id?.did
  if (!target) {
    throw new Error(
      'No actor provided and no session identity yet. Call `join` first, or pass an actor parameter.',
    )
  }

  // We use raw fetch rather than the AtpAgent because @atproto/api validates
  // requested NSIDs against its bundled lexicon registry, which doesn't know
  // about ait.*. Going direct preserves the architectural shape (MCP → PDS
  // proxy → AppView) while sidestepping client-side validation.
  const params = new URLSearchParams({ actor: target })
  if (limit !== undefined) params.set('limit', String(limit))
  if (cursor !== undefined) params.set('cursor', cursor)

  const session = requireIdentity()
  const res = await fetch(
    `${PDS_URL}/xrpc/ait.feed.getAuthorFeed?${params}`,
    {
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
        'atproto-proxy': `${APPVIEW_DID}#bsky_appview`,
      },
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getAuthorFeed failed: ${res.status} ${body}`)
  }

  const data = (await res.json()) as FeedResult

  const lines = data.feed.map((item) => {
    const p = item.post
    const author = p.author.handle ? `@${p.author.handle}` : p.author.did
    return `- ${p.uri}\n  by ${author} at ${p.indexedAt}\n  ${p.record.text ?? ''}`
  })

  return {
    content: [
      {
        type: 'text' as const,
        text:
          (lines.length > 0
            ? lines.join('\n\n')
            : '(no posts found for this actor)') +
          (data.cursor ? `\n\ncursor: ${data.cursor}` : ''),
      },
    ],
  }
}
