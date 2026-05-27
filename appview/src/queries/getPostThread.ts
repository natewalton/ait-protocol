import type { Db } from '../db.js'

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
  createdAt: string
  indexedAt: string
  handle: string | null
}

function rowToView(r: PostRow): ThreadViewPost {
  return {
    post: {
      uri: r.uri,
      cid: r.cid,
      author: { did: r.did, handle: r.handle ?? '' },
      record: {
        $type: 'ait.feed.post',
        text: r.text,
        facets: r.facets ? JSON.parse(r.facets) : undefined,
        reply: r.replyParentUri
          ? {
              root: { uri: r.replyRootUri ?? r.replyParentUri },
              parent: { uri: r.replyParentUri },
            }
          : undefined,
        createdAt: r.createdAt,
      },
      indexedAt: r.indexedAt,
    },
  }
}

// Returns the requested post and every descendant in its thread, organised
// into a nested threadViewPost. v1 limitation: ancestors above the requested
// URI are not walked; if the caller hands us a reply, the parent chain is
// not returned. The spec asks for "given a root URI" — assume that contract.
export function getPostThread(db: Db, params: PostThreadParams): PostThreadResult | null {
  // One SQL query for the root post plus every post whose replyRoot points at it.
  // Self-rooting posts (replyRootUri = own uri) wouldn't happen via the writer,
  // but the `uri = ?` arm guarantees the root itself is included either way.
  const rows = db
    .prepare(
      `SELECT p.uri, p.cid, p.did, p.text, p.facets,
              p.replyRootUri, p.replyParentUri,
              p.createdAt, p.indexedAt,
              a.handle
       FROM posts p
       LEFT JOIN actors a ON a.did = p.did
       WHERE p.uri = ? OR p.replyRootUri = ?`,
    )
    .all(params.uri, params.uri) as PostRow[]

  const root = rows.find((r) => r.uri === params.uri)
  if (!root) return null

  // Build a tree by replyParentUri. Sort siblings by createdAt ASC so
  // threads read top-down.
  const byParent = new Map<string, ThreadViewPost[]>()
  for (const r of rows) {
    if (r.uri === params.uri) continue
    const parent = r.replyParentUri ?? params.uri
    const arr = byParent.get(parent) ?? []
    arr.push(rowToView(r))
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

  return { thread: attach(rowToView(root)) }
}
