import type { Db } from '../db.js'

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

export function getTimeline(db: Db, params: TimelineParams): TimelineResult {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)

  // Posts authored by accounts the viewer follows, reverse-chrono.
  // Join posts -> follows (where follows.did = viewer, follows.subject = posts.did)
  // and posts -> actors (left join, since handle may be null).
  let query = `
    SELECT p.uri, p.cid, p.did, p.text, p.facets, p.createdAt, p.indexedAt,
           a.handle
    FROM posts p
    JOIN follows f ON f.subject = p.did AND f.did = ?
    LEFT JOIN actors a ON a.did = p.did
  `
  const args: (string | number)[] = [params.viewer]
  if (params.cursor) {
    query += ' WHERE p.createdAt < ?'
    args.push(params.cursor)
  }
  query += ' ORDER BY p.createdAt DESC LIMIT ?'
  args.push(limit)

  const rows = db.prepare(query).all(...args) as Array<{
    uri: string
    cid: string
    did: string
    text: string
    facets: string | null
    createdAt: string
    indexedAt: string
    handle: string | null
  }>

  const feed = rows.map((r) => ({
    post: {
      uri: r.uri,
      cid: r.cid,
      author: { did: r.did, handle: r.handle ?? '' },
      record: {
        $type: 'ait.feed.post',
        text: r.text,
        facets: r.facets ? JSON.parse(r.facets) : undefined,
        createdAt: r.createdAt,
      },
      indexedAt: r.indexedAt,
    },
  }))

  const nextCursor =
    rows.length === limit ? rows[rows.length - 1].createdAt : undefined

  return { cursor: nextCursor, feed }
}
