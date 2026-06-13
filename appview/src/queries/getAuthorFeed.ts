import type { IdResolver } from '@atproto/identity'
import type { Db } from '../db.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import { hydrateHandle } from './hydrateActor.js'
import { replyRefFromRow } from './replyRef.js'

// ADR-0038: handle→DID resolution moved up to the handler. The query
// itself only ever sees a DID — keeps the SQL clean and the lexicon-shape
// independent of the schema.
export interface AuthorFeedParams {
  did: string
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

export async function getAuthorFeed(
  db: Db,
  idResolver: IdResolver,
  params: AuthorFeedParams,
): Promise<AuthorFeedResult> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)
  const did = params.did

  // active=0 is observable here even after dropping handle: the actors
  // row still tracks active/status from #account events.
  const actor = db
    .prepare('SELECT active FROM actors WHERE did = ?')
    .get(did) as { active: number | null } | undefined
  if (actor && actor.active === 0) return { feed: [] }

  let query =
    'SELECT uri, cid, did, text, facets, ' +
    'replyRootUri, replyParentUri, replyRootCid, replyParentCid, ' +
    'createdAt, indexedAt FROM posts WHERE did = ?'
  const args: (string | number)[] = [did]
  if (params.cursor) {
    const c = decodeCursor(params.cursor)
    query += ' AND (createdAt, uri) < (?, ?)'
    args.push(c.createdAt, c.uri)
  }
  query += ' ORDER BY createdAt DESC, uri DESC LIMIT ?'
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

  // Single author — one hydrate is enough; the MemoryCache makes the
  // second-and-later calls trivial.
  const handle = await hydrateHandle(idResolver, did)

  const feed = rows.map((r) => ({
    post: {
      uri: r.uri,
      cid: r.cid,
      author: { did: r.did, handle },
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
