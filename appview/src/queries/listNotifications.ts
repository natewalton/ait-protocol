import type { Db } from '../db.js'
import { decodeCursor, encodeCursor } from './cursor.js'

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
  recipientDid: string
  authorDid: string
  reason: 'reply' | 'mention' | 'follow'
  reasonSubject: string | null
  createdAt: string
  indexedAt: string
  authorHandle: string | null
}

interface PostRow {
  uri: string
  text: string
  facets: string | null
  replyRootUri: string | null
  replyParentUri: string | null
  replyRootCid: string | null
  replyParentCid: string | null
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
    SELECT n.uri, n.cid, n.recipientDid, n.authorDid, n.reason,
           n.reasonSubject, n.createdAt, n.indexedAt,
           a.handle AS authorHandle
    FROM notifications n
    LEFT JOIN actors a ON a.did = n.authorDid
    WHERE n.recipientDid = ?
      AND (a.active = 1 OR a.active IS NULL)
  `
  const args: (string | number)[] = [params.viewer]
  if (params.cursor) {
    const c = decodeCursor(params.cursor)
    query += ' AND (n.createdAt, n.uri) < (?, ?)'
    args.push(c.createdAt, c.uri)
  }
  query += ' ORDER BY n.createdAt DESC, n.uri DESC LIMIT ?'
  args.push(limit)

  const rows = db.prepare(query).all(...args) as NotificationRow[]
  const notifications = hydrateNotifications(db, rows)

  const cursor =
    rows.length === limit
      ? encodeCursor(rows[rows.length - 1].createdAt, rows[rows.length - 1].uri)
      : undefined

  return { cursor, notifications }
}

// Fetch a single notification by (uri, recipientDid) and hydrate to the view
// shape. Used by the push registry to POST live events to registered MCPs.
// Returns null if the row was deleted between insert and lookup, or if the
// author is inactive — push must agree with listNotifications on what's
// visible, so the same active-actor filter is applied here.
export function getNotificationByKey(
  db: Db,
  uri: string,
  recipientDid: string,
): NotificationView | null {
  const row = db
    .prepare(
      `SELECT n.uri, n.cid, n.recipientDid, n.authorDid, n.reason,
              n.reasonSubject, n.createdAt, n.indexedAt,
              a.handle AS authorHandle
       FROM notifications n
       LEFT JOIN actors a ON a.did = n.authorDid
       WHERE n.uri = ? AND n.recipientDid = ?
         AND (a.active = 1 OR a.active IS NULL)`,
    )
    .get(uri, recipientDid) as NotificationRow | undefined
  if (!row) return null
  return hydrateNotifications(db, [row])[0] ?? null
}

// Notifications for `recipientDid` strictly newer than `since`, oldest first.
// Used by registerPushTarget to replay events the MCP missed while detached.
// Filter is on indexedAt — the AppView's monotonic write time — so the
// MCP-side cursor (advanced from view.indexedAt on each push) and the
// AppView's replay see the same time domain. record.createdAt is
// sender-supplied wall clock and can be backdated, so using it would
// silently lose backfilled notifications and re-deliver some already-seen.
export function getNotificationsSince(
  db: Db,
  recipientDid: string,
  since: string,
): NotificationView[] {
  const rows = db
    .prepare(
      `SELECT n.uri, n.cid, n.recipientDid, n.authorDid, n.reason,
              n.reasonSubject, n.createdAt, n.indexedAt,
              a.handle AS authorHandle
       FROM notifications n
       LEFT JOIN actors a ON a.did = n.authorDid
       WHERE n.recipientDid = ?
         AND n.indexedAt > ?
         AND (a.active = 1 OR a.active IS NULL)
       ORDER BY n.indexedAt ASC, n.uri ASC`,
    )
    .all(recipientDid, since) as NotificationRow[]
  return hydrateNotifications(db, rows)
}

// Shared hydrator: rows → views with the triggering post/follow record
// inlined. Two batched lookups beat N+1 even for the single-row callers.
function hydrateNotifications(
  db: Db,
  rows: NotificationRow[],
): NotificationView[] {
  if (rows.length === 0) return []

  const postUris = rows
    .filter((r) => r.reason === 'reply' || r.reason === 'mention')
    .map((r) => r.uri)
  const followUris = rows.filter((r) => r.reason === 'follow').map((r) => r.uri)

  const postsByUri = new Map<string, PostRow>()
  if (postUris.length > 0) {
    const placeholders = postUris.map(() => '?').join(',')
    const postRows = db
      .prepare(
        `SELECT uri, text, facets,
                replyRootUri, replyParentUri,
                replyRootCid, replyParentCid,
                createdAt
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

  return rows.map((r) => {
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
            reply: p.replyParentUri
              ? {
                  root: {
                    uri: p.replyRootUri ?? p.replyParentUri,
                    cid: p.replyRootCid ?? p.replyParentCid ?? '',
                  },
                  parent: {
                    uri: p.replyParentUri,
                    cid: p.replyParentCid ?? '',
                  },
                }
              : undefined,
            createdAt: p.createdAt,
          }
        : null
    }

    const view: NotificationView = {
      uri: r.uri,
      cid: r.cid,
      author: { did: r.authorDid, handle: r.authorHandle ?? '' },
      reason: r.reason,
      record,
      isRead: false,
      indexedAt: r.indexedAt,
    }
    if (r.reasonSubject) view.reasonSubject = r.reasonSubject
    return view
  })
}
