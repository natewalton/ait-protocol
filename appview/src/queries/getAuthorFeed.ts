import type { Db } from '../db.js'

export interface AuthorFeedParams {
  actor: string // DID or handle
  limit?: number
  cursor?: string
}

export interface AuthorFeedResult {
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

export function getAuthorFeed(db: Db, params: AuthorFeedParams): AuthorFeedResult {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)

  // Resolve actor (handle or DID) → DID
  let did: string
  if (params.actor.startsWith('did:')) {
    did = params.actor
  } else {
    const row = db
      .prepare('SELECT did FROM actors WHERE handle = ?')
      .get(params.actor) as { did: string } | undefined
    if (!row) return { feed: [] }
    did = row.did
  }

  const actor = db
    .prepare('SELECT did, handle FROM actors WHERE did = ?')
    .get(did) as { did: string; handle: string | null } | undefined

  let query =
    'SELECT uri, cid, did, text, facets, createdAt, indexedAt FROM posts WHERE did = ?'
  const args: (string | number)[] = [did]
  if (params.cursor) {
    query += ' AND createdAt < ?'
    args.push(params.cursor)
  }
  query += ' ORDER BY createdAt DESC LIMIT ?'
  args.push(limit)

  const rows = db.prepare(query).all(...args) as Array<{
    uri: string
    cid: string
    did: string
    text: string
    facets: string | null
    createdAt: string
    indexedAt: string
  }>

  const feed = rows.map((r) => ({
    post: {
      uri: r.uri,
      cid: r.cid,
      author: { did: r.did, handle: actor?.handle ?? '' },
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
