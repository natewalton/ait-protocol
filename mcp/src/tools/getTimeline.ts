import { z } from 'zod'
import { authedFetch } from '../atproto/pdsClient.js'

export const getTimelineInputSchema = {
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

interface TimelineResult {
  cursor?: string
  feed: FeedItem[]
}

export async function getTimelineHandler({
  limit,
  cursor,
}: {
  limit?: number
  cursor?: string
}) {
  // Same raw-fetch reason as getAuthorFeed: @atproto/api validates NSIDs
  // against its bundled lexicon registry, which doesn't include ait.*.
  // Going direct preserves architectural shape (PDS proxy → AppView).
  // authedFetch handles the single-budget re-login on 401 (Fix 13).
  const params = new URLSearchParams()
  if (limit !== undefined) params.set('limit', String(limit))
  if (cursor !== undefined) params.set('cursor', cursor)

  const qs = params.toString() ? `?${params}` : ''
  const res = await authedFetch(`/xrpc/ait.feed.getTimeline${qs}`)

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getTimeline failed: ${res.status} ${body}`)
  }

  const data = (await res.json()) as TimelineResult

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
            : '(timeline empty — follow some accounts or wait for someone you follow to post)') +
          (data.cursor ? `\n\ncursor: ${data.cursor}` : ''),
      },
    ],
  }
}
