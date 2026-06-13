import type { IdResolver } from '@atproto/identity'
import type { Db } from '../db.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import { hydrateHandles } from './hydrateActor.js'
import { replyRefFromRow } from './replyRef.js'

export interface TimelineParams {
  viewer: string // DID
  limit?: number
  cursor?: string
}

export interface TimelineResult {
  cursor?: string
  feed: Array<{
    post: {
      uri: string
      cid: string
      author: { did: string; handle: string }
      record: unknown
      indexedAt: string
    }
  }>
}

export async function getTimeline(
  db: Db,
  idResolver: IdResolver,
  params: TimelineParams,
): Promise<TimelineResult> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)

  // ADR-0038: the LEFT JOIN actors stays in place to gate on `a.active`,
  // but `a.handle` is gone — handles come from hydrateActors below.
  let query = `
    SELECT p.uri, p.cid, p.did, p.text, p.facets,
           p.replyRootUri, p.replyParentUri, p.replyRootCid, p.replyParentCid,
           p.createdAt, p.indexedAt
    FROM posts p
    JOIN follows f ON f.subject = p.did AND f.did = ?
    LEFT JOIN actors a ON a.did = p.did
    WHERE (a.active = 1 OR a.active IS NULL)
  `
  const args: (string | number)[] = [params.viewer]
  if (params.cursor) {
    const c = decodeCursor(params.cursor)
    query += ' AND (p.createdAt, p.uri) < (?, ?)'
    args.push(c.createdAt, c.uri)
  }
  query += ' ORDER BY p.createdAt DESC, p.uri DESC LIMIT ?'
  args.push(limit)

  const rows = db.prepare(query).all(...args) as Array<{
    uri: string
    cid: string
    did: string
    text: string
    facets: string | null
    replyRootUri: string | null
    replyParentUri: string | null
    replyRootCid: string | null
    replyParentCid: string | null
    createdAt: string
    indexedAt: string
  }>

  const handles = await hydrateHandles(
    idResolver,
    rows.map((r) => r.did),
  )

  const feed = rows.map((r) => ({
    post: {
      uri: r.uri,
      cid: r.cid,
      author: { did: r.did, handle: handles.get(r.did)! },
      record: {
        $type: 'ait.feed.post',
        text: r.text,
        facets: r.facets ? JSON.parse(r.facets) : undefined,
        reply: replyRefFromRow(r),
        createdAt: r.createdAt,
      },
      indexedAt: r.indexedAt,
    },
  }))

  const nextCursor =
    rows.length === limit
      ? encodeCursor(rows[rows.length - 1].createdAt, rows[rows.length - 1].uri)
      : undefined

  return { cursor: nextCursor, feed }
}
