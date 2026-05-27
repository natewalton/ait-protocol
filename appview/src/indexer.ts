import type { Db } from './db.js'
import type { Event, Create, Update } from '@atproto/sync'
import { getHandle } from '@atproto/identity'

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
      db.prepare('DELETE FROM posts WHERE uri = ?').run(evt.uri.toString())
    } else if (evt.collection === 'ait.graph.follow') {
      db.prepare('DELETE FROM follows WHERE uri = ?').run(evt.uri.toString())
    }
    return
  }
  if (evt.event === 'identity') {
    // We run @atproto/sync with `unauthenticatedHandles: true` because
    // verifyHandle requires DNS / .well-known resolution that doesn't exist
    // for our .test handles — so parseIdentity always returns evt.handle =
    // undefined. The handle is still in evt.didDocument (PLC has the binding
    // via alsoKnownAs); pull it from there via the canonical helper.
    const handle = evt.handle ?? (evt.didDocument ? getHandle(evt.didDocument) : undefined)
    if (handle) {
      db.prepare(
        `INSERT INTO actors (did, handle, indexedAt) VALUES (?, ?, ?)
         ON CONFLICT(did) DO UPDATE SET handle = excluded.handle, indexedAt = excluded.indexedAt`,
      ).run(evt.did, handle, new Date().toISOString())
    }
    return
  }
}

function indexPost(db: Db, evt: Create | Update) {
  const record = evt.record as {
    text?: string
    facets?: unknown
    createdAt?: string
  }
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO posts (uri, cid, did, text, facets, createdAt, indexedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       cid = excluded.cid,
       text = excluded.text,
       facets = excluded.facets,
       createdAt = excluded.createdAt`,
  ).run(
    evt.uri.toString(),
    evt.cid.toString(),
    evt.did,
    record.text ?? '',
    record.facets ? JSON.stringify(record.facets) : null,
    record.createdAt ?? now,
    now,
  )

  ensureActor(db, evt.did, now)
}

function indexFollow(db: Db, evt: Create | Update) {
  const record = evt.record as { subject?: string; createdAt?: string }
  if (!record.subject) return // malformed; skip
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO follows (uri, did, subject, createdAt, indexedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       subject = excluded.subject,
       createdAt = excluded.createdAt`,
  ).run(
    evt.uri.toString(),
    evt.did,
    record.subject,
    record.createdAt ?? now,
    now,
  )

  ensureActor(db, evt.did, now)
  ensureActor(db, record.subject, now)
}

function ensureActor(db: Db, did: string, now: string) {
  db.prepare(
    `INSERT INTO actors (did, indexedAt) VALUES (?, ?) ON CONFLICT(did) DO NOTHING`,
  ).run(did, now)
}
