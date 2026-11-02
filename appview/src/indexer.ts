import type { Db } from './db.js'
import type { Event, Create, Update } from '@atproto/sync'
import type { DidCache, IdResolver } from '@atproto/identity'
import { AtUri } from '@atproto/syntax'
import { notifyInsert } from './pushRegistry.js'

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

// idResolver is threaded through for push hydration: every freshly
// inserted notification fires notifyInsert, which calls
// getNotificationByKey, which needs the resolver to hydrate the author
// handle. idCache is the same instance held inside idResolver — passed
// separately because DidCache is the only typed public surface for
// `clearEntry` (the resolver's internal cache field isn't part of the
// public TS surface).
export async function handleEvent(
  db: Db,
  evt: Event,
  idResolver?: IdResolver,
  idCache?: DidCache,
): Promise<void> {
  if (evt.event === 'create' || evt.event === 'update') {
    if (evt.collection === 'ait.feed.post') {
      indexPost(db, evt, idResolver)
    } else if (evt.collection === 'ait.graph.follow') {
      indexFollow(db, evt, idResolver)
    } else if (evt.collection === 'ait.actor.profile' && evt.rkey === 'self') {
      // Only rkey `self` is meaningful (bsky convention); other rkeys ignored.
      indexProfile(db, evt)
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
      db.transaction(() => removeFollow(db, uri))()
    } else if (evt.collection === 'ait.actor.profile' && evt.rkey === 'self') {
      // Profiles key on the repo DID, not the record URI.
      db.prepare('DELETE FROM profiles WHERE did = ?').run(evt.did)
    }
    return
  }
  if (evt.event === 'account') {
    db.prepare(
      `INSERT INTO actors (did, active, status, indexedAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(did) DO UPDATE SET
         active    = excluded.active,
         status    = excluded.status,
         indexedAt = excluded.indexedAt`,
    ).run(
      evt.did,
      evt.active ? 1 : 0,
      evt.status ?? null,
      new Date().toISOString(),
    )
    return
  }
  if (evt.event === 'identity') {
    // ADR-0038: identity state is not maintained in SQLite — it's resolved
    // lazily via IdResolver. An #identity event is a *signal* that the
    // upstream identity layer's view of this DID has changed, so we drop
    // the cached PLC doc; the next query for this DID resolves fresh.
    await idCache?.clearEntry(evt.did)
    return
  }
}

// Parse the repo-DID out of an at-uri (e.g. at://did:plc:abc/ait.feed.post/tid → did:plc:abc).
function repoDidFromUri(uri: string): string | null {
  try {
    return new AtUri(uri).host
  } catch {
    return null
  }
}

function indexPost(db: Db, evt: Create | Update, idResolver?: IdResolver) {
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
  const replyRootCid = record.reply?.root?.cid ?? null
  const replyParentCid = record.reply?.parent?.cid ?? null

  db.prepare(
    `INSERT INTO posts
       (uri, cid, did, text, facets,
        replyRootUri, replyParentUri, replyRootCid, replyParentCid,
        createdAt, indexedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       cid            = excluded.cid,
       text           = excluded.text,
       facets         = excluded.facets,
       replyRootUri   = excluded.replyRootUri,
       replyParentUri = excluded.replyParentUri,
       replyRootCid   = excluded.replyRootCid,
       replyParentCid = excluded.replyParentCid,
       createdAt      = excluded.createdAt`,
  ).run(
    uri,
    cid,
    evt.did,
    record.text ?? '',
    record.facets ? JSON.stringify(record.facets) : null,
    replyRootUri,
    replyParentUri,
    replyRootCid,
    replyParentCid,
    record.createdAt ?? now,
    now,
  )

  ensureActor(db, evt.did, now)

  // Reply notification: the parent's author hears about it (unless it's a self-reply).
  if (replyParentUri) {
    const parentAuthor = repoDidFromUri(replyParentUri)
    if (parentAuthor && parentAuthor !== evt.did) {
      insertNotification(db, idResolver, {
        uri,
        cid,
        recipientDid: parentAuthor,
        authorDid: evt.did,
        reason: 'reply',
        reasonSubject: replyParentUri,
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
      insertNotification(db, idResolver, {
        uri,
        cid,
        recipientDid: recipient,
        authorDid: evt.did,
        reason: 'mention',
        reasonSubject: uri,
        createdAt: record.createdAt ?? now,
        indexedAt: now,
      })
    }
  }
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

function insertNotification(
  db: Db,
  idResolver: IdResolver | undefined,
  n: NotificationRow,
) {
  // PK is (uri, recipientDid) — N mentioned recipients on one post produce
  // N rows. A single post that both replies-to and mentions the same
  // person collapses to one row (first write wins), which matches bsky
  // and avoids double-pinging.
  const info = db
    .prepare(
      `INSERT INTO notifications (uri, cid, recipientDid, authorDid, reason, reasonSubject, createdAt, indexedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri, recipientDid) DO NOTHING`,
    )
    .run(
      n.uri,
      n.cid,
      n.recipientDid,
      n.authorDid,
      n.reason,
      n.reasonSubject,
      n.createdAt,
      n.indexedAt,
    )
  // Push to a registered MCP only when this insert actually added a row.
  // The ON CONFLICT DO NOTHING path means we already pushed this event
  // earlier (or it collapsed with a reply+mention twin); double-pushing
  // would surface a duplicate <channel> block to the model.
  if (info.changes > 0 && idResolver) {
    notifyInsert(db, idResolver, n.recipientDid, n.uri)
  }
  return info.changes > 0
}

function removeFollow(db: Db, uri: string) {
  const previous = db.prepare('SELECT did, subject FROM follows WHERE uri = ?').get(uri) as
    { did: string; subject: string } | undefined
  db.prepare('DELETE FROM follows WHERE uri = ?').run(uri)
  db.prepare('DELETE FROM follow_duplicates WHERE uri = ?').run(uri)
  db.prepare("DELETE FROM notifications WHERE uri = ? AND reason = 'follow'").run(uri)
  if (!previous) return
  const survivor = db.prepare(`SELECT uri, did, subject, createdAt, indexedAt FROM follow_duplicates
    WHERE did = ? AND subject = ? ORDER BY indexedAt, uri LIMIT 1`).get(previous.did, previous.subject) as
    { uri: string; did: string; subject: string; createdAt: string; indexedAt: string } | undefined
  if (!survivor) return
  db.prepare('DELETE FROM follow_duplicates WHERE uri = ?').run(survivor.uri)
  db.prepare('INSERT INTO follows (uri,did,subject,createdAt,indexedAt) VALUES (?,?,?,?,?)')
    .run(survivor.uri, survivor.did, survivor.subject, survivor.createdAt, survivor.indexedAt)
}

function indexFollow(db: Db, evt: Create | Update, idResolver?: IdResolver) {
  const record = evt.record as { subject?: string; createdAt?: string }
  if (!record.subject) return // malformed; skip
  const now = new Date().toISOString()
  const uri = evt.uri.toString()
  const cid = evt.cid.toString()

  const subject = record.subject
  const added = db.transaction(() => {
    const primary = db.prepare('SELECT subject, indexedAt FROM follows WHERE uri = ?').get(uri) as
      { subject: string; indexedAt: string } | undefined
    const duplicate = db.prepare('SELECT subject, indexedAt FROM follow_duplicates WHERE uri = ?').get(uri) as
      { subject: string; indexedAt: string } | undefined
    const previous = primary ?? duplicate
    if (previous?.subject === subject) {
      if (primary) {
        db.prepare('UPDATE follows SET createdAt = ? WHERE uri = ?').run(record.createdAt ?? now, uri)
        db.prepare("UPDATE notifications SET cid = ? WHERE uri = ? AND reason = 'follow'").run(cid, uri)
      } else {
        db.prepare('UPDATE follow_duplicates SET cid = ?, createdAt = ? WHERE uri = ?')
          .run(cid, record.createdAt ?? now, uri)
      }
      return false
    }
    if (previous) removeFollow(db, uri)
    const exists = db.prepare('SELECT 1 FROM follows WHERE did = ? AND subject = ?').get(evt.did, subject)
    if (exists) {
      db.prepare('INSERT INTO follow_duplicates (uri,cid,did,subject,createdAt,indexedAt) VALUES (?,?,?,?,?,?)')
        .run(uri, cid, evt.did, subject, record.createdAt ?? now, previous?.indexedAt ?? now)
      return false
    }
    db.prepare('INSERT INTO follows (uri,did,subject,createdAt,indexedAt) VALUES (?,?,?,?,?)')
      .run(uri, evt.did, subject, record.createdAt ?? now, previous?.indexedAt ?? now)
    ensureActor(db, evt.did, now)
    ensureActor(db, subject, now)
    if (previous || subject === evt.did) return false
    // Write inside the transaction, but do not dispatch a push before commit.
    return insertNotification(db, undefined, {
      uri,
      cid,
      recipientDid: subject,
      authorDid: evt.did,
      reason: 'follow',
      reasonSubject: null,
      createdAt: record.createdAt ?? now,
      indexedAt: now,
    })
  })()
  if (added && idResolver) notifyInsert(db, idResolver, subject, uri)
}

function indexProfile(db: Db, evt: Create | Update) {
  const record = evt.record as {
    displayName?: string
    description?: string
    avatar?: unknown
    createdAt?: string
  }
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO profiles (did, displayName, description, avatarCid, indexedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(did) DO UPDATE SET
       displayName = excluded.displayName,
       description = excluded.description,
       avatarCid   = excluded.avatarCid,
       indexedAt   = excluded.indexedAt`,
  ).run(
    evt.did,
    record.displayName ?? null,
    record.description ?? null,
    avatarCid(record.avatar),
    now,
  )

  ensureActor(db, evt.did, now)
}

// The firehose decodes records via @atproto/repo's cborToLexRecord, which
// turns blob values into BlobRef instances whose `.ref` is a CID — so the CID
// string is `avatar.ref.toString()`. We duck-type rather than `instanceof
// BlobRef`: that BlobRef is minted inside @atproto/sync's decoder (now the
// @atproto/lex-* / @atproto/repo family), a different package than anything
// this module would import, so a prototype check across that boundary can't be
// relied on. The `{ $link }` branch covers the plain ipld/JSON shape
// defensively, though firehose records always arrive as BlobRef.
function avatarCid(avatar: unknown): string | null {
  if (avatar == null || typeof avatar !== 'object') return null
  const ref = (avatar as { ref?: unknown }).ref
  if (ref == null) return null
  if (typeof ref === 'string') return ref
  if (typeof ref === 'object') {
    const link = (ref as { $link?: unknown }).$link
    if (typeof link === 'string') return link
    const cidStr = (ref as { toString(): string }).toString()
    if (cidStr && cidStr !== '[object Object]') return cidStr
  }
  return null
}

function ensureActor(db: Db, did: string, now: string) {
  db.prepare(
    `INSERT INTO actors (did, indexedAt) VALUES (?, ?) ON CONFLICT(did) DO NOTHING`,
  ).run(did, now)
}
