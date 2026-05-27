import type { Db } from './db.js'
import type { Event, Create, Update } from '@atproto/sync'

// Mention facet feature shape — the post may carry either ait.richtext.facet#mention
// (forward-looking) or app.bsky.richtext.facet#mention (the type we currently
// mirror per ADR-0008). Both name the target via `did`.
const MENTION_TYPES = new Set([
  'ait.richtext.facet#mention',
  'app.bsky.richtext.facet#mention',
])

interface ReplyRef {
  root?: { uri?: string; cid?: string }
  parent?: { uri?: string; cid?: string }
}

interface FacetFeature {
  $type?: string
  did?: string
}

interface Facet {
  features?: FacetFeature[]
}

export function handleEvent(db: Db, evt: Event) {
  if (evt.event === 'create' || evt.event === 'update') {
    if (evt.collection === 'ait.feed.post') {
      indexPost(db, evt)
    } else if (evt.collection === 'ait.graph.follow') {
      indexFollow(db, evt)
    }
    return
  }
  if (evt.event === 'delete') {
    if (evt.collection === 'ait.feed.post') {
      const uri = evt.uri.toString()
      db.prepare('DELETE FROM posts WHERE uri = ?').run(uri)
      db.prepare('DELETE FROM notifications WHERE uri = ?').run(uri)
    } else if (evt.collection === 'ait.graph.follow') {
      const uri = evt.uri.toString()
      db.prepare('DELETE FROM follows WHERE uri = ?').run(uri)
      db.prepare('DELETE FROM notifications WHERE uri = ?').run(uri)
    }
    return
  }
  if (evt.event === 'identity') {
    if (evt.handle) {
      db.prepare(
        `INSERT INTO actors (did, handle, indexedAt) VALUES (?, ?, ?)
         ON CONFLICT(did) DO UPDATE SET handle = excluded.handle, indexedAt = excluded.indexedAt`,
      ).run(evt.did, evt.handle, new Date().toISOString())
    }
    return
  }
}

// Parse the repo-DID out of an at-uri (e.g. at://did:plc:abc/ait.feed.post/tid → did:plc:abc).
function repoDidFromUri(uri: string): string | null {
  if (!uri.startsWith('at://')) return null
  const rest = uri.slice('at://'.length)
  const slash = rest.indexOf('/')
  return slash === -1 ? rest : rest.slice(0, slash)
}

function indexPost(db: Db, evt: Create | Update) {
  const record = evt.record as {
    text?: string
    facets?: Facet[]
    reply?: ReplyRef
    createdAt?: string
  }
  const now = new Date().toISOString()
  const uri = evt.uri.toString()
  const cid = evt.cid.toString()

  const replyRootUri = record.reply?.root?.uri ?? null
  const replyParentUri = record.reply?.parent?.uri ?? null

  db.prepare(
    `INSERT INTO posts (uri, cid, did, text, facets, reply_root_uri, reply_parent_uri, createdAt, indexedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       cid              = excluded.cid,
       text             = excluded.text,
       facets           = excluded.facets,
       reply_root_uri   = excluded.reply_root_uri,
       reply_parent_uri = excluded.reply_parent_uri,
       createdAt        = excluded.createdAt`,
  ).run(
    uri,
    cid,
    evt.did,
    record.text ?? '',
    record.facets ? JSON.stringify(record.facets) : null,
    replyRootUri,
    replyParentUri,
    record.createdAt ?? now,
    now,
  )

  ensureActor(db, evt.did, now)

  // Reply notification: the parent's author hears about it (unless it's a self-reply).
  if (replyParentUri) {
    const parentAuthor = repoDidFromUri(replyParentUri)
    if (parentAuthor && parentAuthor !== evt.did) {
      insertNotification(db, {
        uri,
        cid,
        recipient_did: parentAuthor,
        author_did: evt.did,
        reason: 'reply',
        reason_subject: replyParentUri,
        createdAt: record.createdAt ?? now,
        indexedAt: now,
      })
    }
  }

  // Mention notifications: one per unique mentioned DID, skipping self-mentions.
  if (record.facets) {
    const mentioned = new Set<string>()
    for (const facet of record.facets) {
      if (!facet?.features) continue
      for (const feature of facet.features) {
        if (
          feature.$type &&
          MENTION_TYPES.has(feature.$type) &&
          feature.did &&
          feature.did !== evt.did
        ) {
          mentioned.add(feature.did)
        }
      }
    }
    for (const recipient of mentioned) {
      insertNotification(db, {
        uri,
        cid,
        recipient_did: recipient,
        author_did: evt.did,
        reason: 'mention',
        reason_subject: uri,
        createdAt: record.createdAt ?? now,
        indexedAt: now,
      })
    }
  }
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
}

function insertNotification(db: Db, n: NotificationRow) {
  // PK is (uri, recipient_did) — N mentioned recipients on one post produce
  // N rows. A single post that both replies-to and mentions the same
  // person collapses to one row (first write wins), which matches bsky
  // and avoids double-pinging.
  db.prepare(
    `INSERT INTO notifications (uri, cid, recipient_did, author_did, reason, reason_subject, createdAt, indexedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri, recipient_did) DO NOTHING`,
  ).run(
    n.uri,
    n.cid,
    n.recipient_did,
    n.author_did,
    n.reason,
    n.reason_subject,
    n.createdAt,
    n.indexedAt,
  )
}

function indexFollow(db: Db, evt: Create | Update) {
  const record = evt.record as { subject?: string; createdAt?: string }
  if (!record.subject) return // malformed; skip
  const now = new Date().toISOString()
  const uri = evt.uri.toString()
  const cid = evt.cid.toString()

  db.prepare(
    `INSERT INTO follows (uri, did, subject, createdAt, indexedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       subject = excluded.subject,
       createdAt = excluded.createdAt`,
  ).run(
    uri,
    evt.did,
    record.subject,
    record.createdAt ?? now,
    now,
  )

  ensureActor(db, evt.did, now)
  ensureActor(db, record.subject, now)

  // Follow notification: the followee hears about it. Self-follow is
  // already rejected by the follow tool, but guard here too in case a
  // record sneaks in via a different write path.
  if (record.subject !== evt.did) {
    insertNotification(db, {
      uri,
      cid,
      recipient_did: record.subject,
      author_did: evt.did,
      reason: 'follow',
      reason_subject: null,
      createdAt: record.createdAt ?? now,
      indexedAt: now,
    })
  }
}

function ensureActor(db: Db, did: string, now: string) {
  db.prepare(
    `INSERT INTO actors (did, indexedAt) VALUES (?, ?) ON CONFLICT(did) DO NOTHING`,
  ).run(did, now)
}
