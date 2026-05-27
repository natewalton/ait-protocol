import type { Db } from '../db.js'

export interface ListNotificationsParams {
  viewer: string // DID
  limit?: number
  cursor?: string
}

export interface NotificationView {
  uri: string
  cid: string
  author: { did: string; handle: string }
  reason: 'reply' | 'mention' | 'follow'
  reasonSubject?: string
  record: unknown
  isRead: boolean
  indexedAt: string
}

export interface ListNotificationsResult {
  cursor?: string
  notifications: NotificationView[]
}

interface NotificationRow {
  uri: string
  cid: string
  recipient_did: string
  author_did: string
  reason: 'reply' | 'mention' | 'follow'
  reason_subject: string | null
  createdAt: string
  indexedAt: string
  author_handle: string | null
}

interface PostRow {
  uri: string
  text: string
  facets: string | null
  reply_root_uri: string | null
  reply_parent_uri: string | null
  createdAt: string
}

interface FollowRow {
  uri: string
  subject: string
  createdAt: string
}

export function listNotifications(
  db: Db,
  params: ListNotificationsParams,
): ListNotificationsResult {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)

  let query = `
    SELECT n.uri, n.cid, n.recipient_did, n.author_did, n.reason,
           n.reason_subject, n.createdAt, n.indexedAt,
           a.handle AS author_handle
    FROM notifications n
    LEFT JOIN actors a ON a.did = n.author_did
    WHERE n.recipient_did = ?
  `
  const args: (string | number)[] = [params.viewer]
  if (params.cursor) {
    query += ' AND n.createdAt < ?'
    args.push(params.cursor)
  }
  query += ' ORDER BY n.createdAt DESC LIMIT ?'
  args.push(limit)

  const rows = db.prepare(query).all(...args) as NotificationRow[]
  if (rows.length === 0) return { notifications: [] }

  // Hydrate the triggering record. reply/mention point at posts;
  // follow points at follows. Two batched lookups beat N+1.
  const postUris = rows
    .filter((r) => r.reason === 'reply' || r.reason === 'mention')
    .map((r) => r.uri)
  const followUris = rows.filter((r) => r.reason === 'follow').map((r) => r.uri)

  const postsByUri = new Map<string, PostRow>()
  if (postUris.length > 0) {
    const placeholders = postUris.map(() => '?').join(',')
    const postRows = db
      .prepare(
        `SELECT uri, text, facets, reply_root_uri, reply_parent_uri, createdAt
         FROM posts WHERE uri IN (${placeholders})`,
      )
      .all(...postUris) as PostRow[]
    for (const p of postRows) postsByUri.set(p.uri, p)
  }

  const followsByUri = new Map<string, FollowRow>()
  if (followUris.length > 0) {
    const placeholders = followUris.map(() => '?').join(',')
    const followRows = db
      .prepare(
        `SELECT uri, subject, createdAt FROM follows WHERE uri IN (${placeholders})`,
      )
      .all(...followUris) as FollowRow[]
    for (const f of followRows) followsByUri.set(f.uri, f)
  }

  const notifications: NotificationView[] = rows.map((r) => {
    let record: unknown
    if (r.reason === 'follow') {
      const f = followsByUri.get(r.uri)
      record = f
        ? {
            $type: 'ait.graph.follow',
            subject: f.subject,
            createdAt: f.createdAt,
          }
        : null
    } else {
      const p = postsByUri.get(r.uri)
      record = p
        ? {
            $type: 'ait.feed.post',
            text: p.text,
            facets: p.facets ? JSON.parse(p.facets) : undefined,
            reply: p.reply_parent_uri
              ? {
                  root: { uri: p.reply_root_uri ?? p.reply_parent_uri },
                  parent: { uri: p.reply_parent_uri },
                }
              : undefined,
            createdAt: p.createdAt,
          }
        : null
    }

    const view: NotificationView = {
      uri: r.uri,
      cid: r.cid,
      author: { did: r.author_did, handle: r.author_handle ?? '' },
      reason: r.reason,
      record,
      isRead: false, // v1 always false, per spec
      indexedAt: r.indexedAt,
    }
    if (r.reason_subject) view.reasonSubject = r.reason_subject
    return view
  })

  const cursor =
    rows.length === limit ? rows[rows.length - 1].createdAt : undefined

  return { cursor, notifications }
}
