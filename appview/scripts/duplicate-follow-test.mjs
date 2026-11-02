// Offline regression: no PDS, services, credentials or model calls.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { AtUri } from '@atproto/syntax'
import { cidForRecord } from '@atproto/repo'
import { openDb } from '../dist/db.js'
import { handleEvent } from '../dist/indexer.js'
import { getProfile } from '../dist/queries/getProfile.js'
import { getTimeline } from '../dist/queries/getTimeline.js'

const A = 'did:plc:alice', B = 'did:plc:bob', C = 'did:plc:carol'
const T = '2026-11-02T00:00:00.000Z'
const resolver = { did: {
  resolve: async did => ({ id: did, alsoKnownAs: [`at://${did.slice(8)}.${'a'.repeat(52)}.aitproto.com`] }),
  resolveAtprotoData: async did => ({ did, handle: `${did.slice(8)}.${'a'.repeat(52)}.aitproto.com` }),
} }
async function event(key, subject = B, kind = 'create', createdAt = T) {
  const record = { $type: 'ait.graph.follow', subject, createdAt }
  return { event: kind, did: A, collection: record.$type, rkey: key,
    uri: AtUri.make(A, record.$type, key), cid: await cidForRecord(record), record }
}
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n

for (const order of [['one', 'two', 'three'], ['three', 'two', 'one']]) {
  test(`duplicates, replay, sequential promotion: ${order.join(',')}`, async () => {
    const db = openDb(':memory:')
    try {
      const events = await Promise.all(order.map(key => event(key)))
      for (const value of [...events, ...events]) await handleEvent(db, value, resolver)
      assert.equal(count(db, 'follows'), 1)
      assert.equal(count(db, 'follow_duplicates'), 2)
      assert.equal(count(db, 'notifications'), 1)
      assert.equal((await getProfile(db, resolver, { did: A, pdsUrl: 'http://127.0.0.1:1' })).followsCount, 1)
      assert.equal((await getProfile(db, resolver, { did: B, pdsUrl: 'http://127.0.0.1:1' })).followersCount, 1)
      const record = { $type: 'ait.feed.post', text: 'one timeline entry', createdAt: T }
      await handleEvent(db, { event: 'create', did: B, collection: record.$type,
        uri: AtUri.make(B, record.$type, 'post'), cid: await cidForRecord(record), record }, resolver)
      assert.equal((await getTimeline(db, resolver, { viewer: A })).feed.length, 1)
      for (let i = 0; i < events.length; i++) {
        // Delete the current representative, then prove surviving records remain effective.
        const uri = db.prepare('SELECT uri FROM follows').get().uri
        await handleEvent(db, { ...events[0], event: 'delete', uri: new AtUri(uri) }, resolver)
        assert.equal(count(db, 'follows'), i < 2 ? 1 : 0)
        assert.equal(count(db, 'notifications'), 0, 'promotion must not notify')
      }
      assert.equal(count(db, 'follow_duplicates'), 0)
    } finally { db.close() }
  })
}

test('delete duplicate, update CID/subject, and rollback failed moves', async () => {
  const db = openDb(':memory:')
  try {
    const one = await event('one'), two = await event('two')
    await handleEvent(db, one, resolver); await handleEvent(db, two, resolver)
    await handleEvent(db, { ...two, event: 'delete' }, resolver)
    assert.equal(count(db, 'follows'), 1); assert.equal(count(db, 'notifications'), 1)
    const seq = db.prepare('SELECT seq FROM notifications').get().seq
    const updated = await event('one', B, 'update', '2026-11-02T01:00:00.000Z')
    await handleEvent(db, updated, resolver)
    assert.deepEqual(db.prepare('SELECT seq,cid FROM notifications').get(), { seq, cid: updated.cid.toString() })
    await handleEvent(db, two, resolver)
    await handleEvent(db, await event('three', C), resolver)
    const before = ['follows', 'follow_duplicates', 'notifications'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY uri`).all())
    db.exec("CREATE TRIGGER reject_duplicate BEFORE INSERT ON follow_duplicates BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
    await assert.rejects(handleEvent(db, await event('one', C, 'update'), resolver), /injected failure/)
    assert.deepEqual(['follows', 'follow_duplicates', 'notifications'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY uri`).all()), before)
    db.exec('DROP TRIGGER reject_duplicate')
    await handleEvent(db, await event('one', C, 'update'), resolver)
    assert.equal(count(db, 'follows'), 2)
    assert.equal(count(db, 'notifications'), 1)
    assert.equal(db.prepare('SELECT subject FROM follows WHERE uri=?').get(two.uri.toString()).subject, B)
    // Moving a duplicate to a new subject is an update, not a fresh notification.
    await handleEvent(db, await event('one', 'did:plc:dave', 'update'), resolver)
    assert.equal(count(db, 'follows'), 3)
    assert.equal(count(db, 'notifications'), 1)
    await handleEvent(db, await event('self', A), resolver)
    assert.equal(count(db, 'notifications'), 1)
  } finally { db.close() }
})

test('additive migration preserves existing follow and notification sequence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ait-duplicate-follow-')), file = join(root, 'view.sqlite')
  let db
  try {
    db = new Database(file)
    db.exec(`CREATE TABLE follows(uri TEXT PRIMARY KEY,did TEXT NOT NULL,subject TEXT NOT NULL,
      createdAt TEXT NOT NULL,indexedAt TEXT NOT NULL,UNIQUE(did,subject))`)
    db.prepare('INSERT INTO follows VALUES (?,?,?,?,?)').run('legacy', A, B, T, T)
    db.exec(`CREATE TABLE notifications (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, uri TEXT NOT NULL, cid TEXT NOT NULL,
      recipientDid TEXT NOT NULL, authorDid TEXT NOT NULL, reason TEXT NOT NULL,
      reasonSubject TEXT, createdAt TEXT NOT NULL, indexedAt TEXT NOT NULL,
      UNIQUE(uri,recipientDid))`)
    db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,?,?,?)')
      .run(41, 'legacy', 'original-cid', B, A, 'follow', null, T, T)
    db.close(); db = openDb(file)
    const original = db.prepare('SELECT * FROM follows').all()
    await handleEvent(db, await event('extra'), resolver)
    assert.equal(count(db, 'notifications'), 1)
    assert.deepEqual(db.prepare('SELECT seq,uri,cid FROM notifications').get(),
      { seq: 41, uri: 'legacy', cid: 'original-cid' })
    db.close(); db = openDb(file)
    assert.deepEqual(db.prepare('SELECT * FROM follows').all(), original)
    assert.equal(count(db, 'follow_duplicates'), 1)
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }) }
})
