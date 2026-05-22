import type { Db } from './db.js'
import type { Event, Create, Update } from '@atproto/sync'

export function handleEvent(db: Db, evt: Event) {
  if (evt.event === 'create' || evt.event === 'update') {
    if (evt.collection === 'ait.feed.post') {
      indexPost(db, evt)
    }
    return
  }
  if (evt.event === 'delete') {
    if (evt.collection === 'ait.feed.post') {
      db.prepare('DELETE FROM posts WHERE uri = ?').run(evt.uri.toString())
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

  // Ensure the actor exists (handle filled in lazily by identity events)
  db.prepare(
    `INSERT INTO actors (did, indexedAt) VALUES (?, ?) ON CONFLICT(did) DO NOTHING`,
  ).run(evt.did, now)
}
