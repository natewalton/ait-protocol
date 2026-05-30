import { z } from 'zod'
import { getIdentity } from '../session.js'
import { appViewCall } from '../atproto/pdsClient.js'

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

  const params: Record<string, unknown> = { actor: target }
  if (limit !== undefined) params.limit = limit
  if (cursor !== undefined) params.cursor = cursor

  const data = await appViewCall<FeedResult>('ait.feed.getAuthorFeed', {
    params,
  })

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
