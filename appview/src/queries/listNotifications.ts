import type { IdResolver } from '@atproto/identity'
import type { Db } from '../db.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import { hydrateHandles } from './hydrateActor.js'
import { replyRefFromRow } from './replyRef.js'

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

// ADR-0038: drop `a.handle` from each SELECT; keep the LEFT JOIN actors
// solely as the gate for `a.active`. Handles are added by hydrateNotifications.
const NOTIF_SELECT_COLS = `
  n.uri, n.cid, n.recipientDid, n.authorDid, n.reason,
  n.reasonSubject, n.createdAt, n.indexedAt
`
const NOTIF_FROM_WITH_ACTIVE = `
  FROM notifications n
  LEFT JOIN actors a ON a.did = n.authorDid
`
const ACTIVE_FILTER = '(a.active = 1 OR a.active IS NULL)'

export async function listNotifications(
  db: Db,
  idResolver: IdResolver,
  params: ListNotificationsParams,
): Promise<ListNotificationsResult> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)

  let query = `
    SELECT ${NOTIF_SELECT_COLS}
    ${NOTIF_FROM_WITH_ACTIVE}
    WHERE n.recipientDid = ?
      AND ${ACTIVE_FILTER}
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
  const notifications = await hydrateNotifications(db, idResolver, rows)

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
export async function getNotificationByKey(
  db: Db,
  idResolver: IdResolver,
  uri: string,
  recipientDid: string,
): Promise<NotificationView | null> {
  const row = db
    .prepare(
      `SELECT ${NOTIF_SELECT_COLS}
       ${NOTIF_FROM_WITH_ACTIVE}
       WHERE n.uri = ? AND n.recipientDid = ?
         AND ${ACTIVE_FILTER}`,
    )
    .get(uri, recipientDid) as NotificationRow | undefined
  if (!row) return null
  const views = await hydrateNotifications(db, idResolver, [row])
  return views[0] ?? null
}

// Notifications for `recipientDid` strictly newer than `since`, oldest first.
// Used by registerPushTarget to replay events the MCP missed while detached.
// Filter is on indexedAt — the AppView's monotonic write time — so the
// MCP-side cursor (advanced from view.indexedAt on each push) and the
// AppView's replay see the same time domain. record.createdAt is
// sender-supplied wall clock and can be backdated, so using it would
// silently lose backfilled notifications and re-deliver some already-seen.
export async function getNotificationsSince(
  db: Db,
  idResolver: IdResolver,
  recipientDid: string,
  since: string,
): Promise<NotificationView[]> {
  const rows = db
    .prepare(
      `SELECT ${NOTIF_SELECT_COLS}
       ${NOTIF_FROM_WITH_ACTIVE}
       WHERE n.recipientDid = ?
         AND n.indexedAt > ?
         AND ${ACTIVE_FILTER}
       ORDER BY n.indexedAt ASC, n.uri ASC`,
    )
    .all(recipientDid, since) as NotificationRow[]
  return hydrateNotifications(db, idResolver, rows)
}

// Shared hydrator: rows → views with the triggering post/follow record
// inlined and the author handle resolved via IdResolver. Two batched
// SQL lookups + one batched identity hydrate beat N+1 even for the
// single-row callers.
async function hydrateNotifications(
  db: Db,
  idResolver: IdResolver,
  rows: NotificationRow[],
): Promise<NotificationView[]> {
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

  const handles = await hydrateHandles(
    idResolver,
    rows.map((r) => r.authorDid),
  )

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
            reply: replyRefFromRow(p),
            createdAt: p.createdAt,
          }
        : null
    }

    const view: NotificationView = {
      uri: r.uri,
      cid: r.cid,
      author: { did: r.authorDid, handle: handles.get(r.authorDid)! },
      reason: r.reason,
      record,
      isRead: false,
      indexedAt: r.indexedAt,
    }
    if (r.reasonSubject) view.reasonSubject = r.reasonSubject
    return view
  })
}
