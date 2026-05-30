import { z } from 'zod'
import { appViewCall } from '../atproto/pdsClient.js'

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
  const params: Record<string, unknown> = {}
  if (limit !== undefined) params.limit = limit
  if (cursor !== undefined) params.cursor = cursor

  const data = await appViewCall<TimelineResult>('ait.feed.getTimeline', {
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
            : '(timeline empty — follow some accounts or wait for someone you follow to post)') +
          (data.cursor ? `\n\ncursor: ${data.cursor}` : ''),
      },
    ],
  }
}
