import type { IdResolver } from '@atproto/identity'
import type { Db } from '../db.js'
import { hydrateHandles } from './hydrateActor.js'
import { replyRefFromRow } from './replyRef.js'

export interface PostThreadParams {
  uri: string
}

export interface ThreadViewPost {
  post: {
    uri: string
    cid: string
    author: { did: string; handle: string }
    record: unknown
    indexedAt: string
  }
  parent?: ThreadViewPost
  replies?: ThreadViewPost[]
}

export interface PostThreadResult {
  thread: ThreadViewPost
}

interface PostRow {
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
}

// ADR-0038: handles come from a `Map<did, handle>` built by hydrateActors
// after the SQL fetches all the rows. Keeps the row→view shape identical.
function rowToView(r: PostRow, handleByDid: Map<string, string>): ThreadViewPost {
  return {
    post: {
      uri: r.uri,
      cid: r.cid,
      author: { did: r.did, handle: handleByDid.get(r.did) ?? '' },
      record: {
        $type: 'ait.feed.post',
        text: r.text,
        facets: r.facets ? JSON.parse(r.facets) : undefined,
        reply: replyRefFromRow(r),
        createdAt: r.createdAt,
      },
      indexedAt: r.indexedAt,
    },
  }
}

const POST_SELECT = `
  SELECT p.uri, p.cid, p.did, p.text, p.facets,
         p.replyRootUri, p.replyParentUri,
         p.replyRootCid, p.replyParentCid,
         p.createdAt, p.indexedAt
  FROM posts p
`

function postByUri(db: Db, uri: string): PostRow | undefined {
  return db.prepare(`${POST_SELECT} WHERE p.uri = ?`).get(uri) as
    | PostRow
    | undefined
}

// Walk from `startUri` upward via replyParentUri, collecting the ancestor
// rows. Terminates at the root post (no replyParentUri), a missing
// parent, or a cycle. Returns the rows themselves so the caller can
// merge them into the single hydration pass.
function walkAncestorRows(db: Db, startUri: string | null): PostRow[] {
  if (!startUri) return []
  const chain: PostRow[] = []
  const visited = new Set<string>()
  let curUri: string | null = startUri
  while (curUri && !visited.has(curUri)) {
    visited.add(curUri)
    const row = postByUri(db, curUri)
    if (!row) break
    chain.push(row)
    curUri = row.replyParentUri
  }
  return chain
}

// Returns the requested post, its ancestor chain via `parent`, and every
// descendant via `replies`.
export async function getPostThread(
  db: Db,
  idResolver: IdResolver,
  params: PostThreadParams,
): Promise<PostThreadResult | null> {
  // One SQL query for the root post plus every post whose replyRoot points at it.
  const rows = db
    .prepare(`${POST_SELECT} WHERE p.uri = ? OR p.replyRootUri = ?`)
    .all(params.uri, params.uri) as PostRow[]

  const root = rows.find((r) => r.uri === params.uri)
  if (!root) return null

  const ancestorRows = walkAncestorRows(db, root.replyParentUri)

  const handleByDid = await hydrateHandles(
    idResolver,
    [...rows, ...ancestorRows].map((r) => r.did),
  )

  // Build a tree by replyParentUri. Sort siblings by createdAt ASC so
  // threads read top-down.
  const byParent = new Map<string, ThreadViewPost[]>()
  for (const r of rows) {
    if (r.uri === params.uri) continue
    const parent = r.replyParentUri ?? params.uri
    const arr = byParent.get(parent) ?? []
    arr.push(rowToView(r, handleByDid))
    byParent.set(parent, arr)
  }
  const sortByCreated = (a: ThreadViewPost, b: ThreadViewPost) => {
    const ra = a.post.record as { createdAt?: string }
    const rb = b.post.record as { createdAt?: string }
    return (ra.createdAt ?? '').localeCompare(rb.createdAt ?? '')
  }
  for (const list of byParent.values()) list.sort(sortByCreated)

  function attach(node: ThreadViewPost): ThreadViewPost {
    const children = byParent.get(node.post.uri)
    if (children) node.replies = children.map(attach)
    return node
  }

  const thread = attach(rowToView(root, handleByDid))

  // Rebuild ancestor chain bottom-up from already-hydrated rows.
  let parentView: ThreadViewPost | undefined = undefined
  for (let i = ancestorRows.length - 1; i >= 0; i--) {
    const view = rowToView(ancestorRows[i], handleByDid)
    view.parent = parentView
    parentView = view
  }
  thread.parent = parentView

  return { thread }
}
