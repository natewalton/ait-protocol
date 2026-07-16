import type { IdResolver } from '@atproto/identity'
import type { Db } from '../db.js'
import { decodeSeqCursor, encodeSeqCursor } from './cursor.js'
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
  // Display only. NOT a cursor: it is millisecond-resolution and collides, which
  // is what stranded same-millisecond twins behind a `>` bound. Consumers commit
  // `cursor` instead.
  indexedAt: string
  // The opaque position of this notification in the recipient's stream. A push
  // consumer stores this verbatim and hands it back to registerPushTarget; it
  // must never be parsed or reconstructed from indexedAt/seq.
  cursor: string
}

export interface ListNotificationsResult {
  cursor?: string
  notifications: NotificationView[]
}

interface NotificationRow {
  seq: number
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
  n.seq, n.uri, n.cid, n.recipientDid, n.authorDid, n.reason,
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
    const seq = decodeSeqCursor(params.cursor)
    // An undecodable cursor pages from the top rather than throwing: this used
    // to be a (createdAt, uri) tuple, so a client mid-pagination across the
    // rollout will hand back one of those exactly once.
    if (seq !== null) {
      query += ' AND n.seq < ?'
      args.push(seq)
    }
  }
  query += ' ORDER BY n.seq DESC LIMIT ?'
  args.push(limit)

  const rows = db.prepare(query).all(...args) as NotificationRow[]
  const notifications = await hydrateNotifications(db, idResolver, rows)

  const cursor =
    rows.length === limit
      ? encodeSeqCursor(rows[rows.length - 1].seq)
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

// Notifications for `recipientDid` after `afterSeq`, oldest first. Used by
// registerPushTarget to replay what a consumer missed while detached.
//
// The bound is seq, not a timestamp. It used to be `indexedAt > since`, which
// silently and permanently dropped any notification sharing a millisecond with
// one already delivered: the consumer's cursor sat at that millisecond, and the
// strict `>` excluded its twin from every future replay while listNotifications
// went on returning it. Every same-millisecond collision in the live data was a
// reply+follow pair, which is why the symptom read as "a notification type
// stopped arriving". seq is total, unique, and gap-free-forward, so a bound on
// it cannot tie.
export async function getNotificationsAfterSeq(
  db: Db,
  idResolver: IdResolver,
  recipientDid: string,
  afterSeq: number,
): Promise<NotificationView[]> {
  const rows = db
    .prepare(
      `SELECT ${NOTIF_SELECT_COLS}
       ${NOTIF_FROM_WITH_ACTIVE}
       WHERE n.recipientDid = ?
         AND n.seq > ?
         AND ${ACTIVE_FILTER}
       ORDER BY n.seq ASC`,
    )
    .all(recipientDid, afterSeq) as NotificationRow[]
  return hydrateNotifications(db, idResolver, rows)
}

// Translate a legacy ISO `since` into the seq cursor that reproduces it: the
// predecessor of the first row at-or-after that instant, so replaying
// `seq > result` covers everything with `indexedAt >= since`.
//
// Deliberately inclusive of the boundary millisecond where the old bound was
// exclusive. That re-delivers rows at exactly `since` — a duplicate the consumer
// dedupes by uri — and in exchange recovers the twin the old bound stranded.
// Returns 0 when nothing is at-or-after `since` (replay everything), which is
// also the correct answer for a recipient whose stream starts after it.
export function seqBeforeTimestamp(
  db: Db,
  recipientDid: string,
  since: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(seq), 0) AS seq
       FROM notifications
       WHERE recipientDid = ?
         AND seq < (
           SELECT COALESCE(MIN(seq), (SELECT COALESCE(MAX(seq), 0) + 1 FROM notifications))
           FROM notifications
           WHERE recipientDid = ? AND indexedAt >= ?
         )`,
    )
    .get(recipientDid, recipientDid, since) as { seq: number }
  return row.seq
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
      cursor: encodeSeqCursor(r.seq),
    }
    if (r.reasonSubject) view.reasonSubject = r.reasonSubject
    return view
  })
}
