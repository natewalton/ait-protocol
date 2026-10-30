// Offline fixture: cd appview && node --import tsx scripts/peer-projection-test.mjs
// This starts at the authenticated sync event boundary. Transport/signature
// verification and the HTTP handler are integration responsibilities of main.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import https from 'node:https'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createOp } from '@did-plc/lib'
import { base32 } from 'multiformats/bases/base32'
import { AtUri, ensureValidHandle } from '@atproto/syntax'
import { BlobRef, Lexicons, jsonToLex, lexToIpld, lexToJson } from '@atproto/lexicon'
import { cborEncode } from '@atproto/lex-cbor'
import { cborToLexRecord, cidForRecord } from '@atproto/repo'
import { openDb } from '../src/db.ts'
import { handleEvent } from '../src/indexer.ts'
import { getRecord } from '../src/queries/getRecord.ts'
import { resolveActorToDid } from '../src/queries/resolveHandle.ts'
import { friendlyHandle, hydrateHandle, hydrateHandles, qualifyActorLabel } from '../src/queries/hydrateActor.ts'
import { searchActors } from '../src/queries/searchActors.ts'
import { AIT_LEXICONS } from '../src/aitLexicons.ts'
import { createPeerClient } from '../src/peerClient.mjs'
import { loadState } from '../src/peerState.mjs'
import { getAuthorFeed } from '../src/queries/getAuthorFeed.ts'
import { getProfile } from '../src/queries/getProfile.ts'
import { getTimeline } from '../src/queries/getTimeline.ts'
import { getPostThread } from '../src/queries/getPostThread.ts'
import { listNotifications } from '../src/queries/listNotifications.ts'
import { registerAndReplay, _clear } from '../src/pushRegistry.ts'

const lexicons = new Lexicons([...AIT_LEXICONS])

const A = 'did:plc:alice'
const B = 'did:plc:alicepeer'
const C = 'did:plc:alicesamepeer'
const MACHINE_A = 'a'.repeat(52)
const PEER_SOURCE = 'ab'.repeat(32) // Attribution need not equal the wire base32 namespace.
const MACHINE_B = base32.baseEncode(Buffer.from(PEER_SOURCE, 'hex'))
const canonical = (name, machine = MACHINE_A) => `${name}.${machine}.aitproto.com`
const HANDLE_A = canonical('alice')
const HANDLE_B = canonical('alice', MACHINE_B)
const T = '2026-10-30T12:00:00.000Z'
const collection = 'ait.feed.post'
const docs = new Map()
function setHandle(did, handle) {
  docs.set(did, { id: did, alsoKnownAs: [`at://${handle}`] })
}
setHandle(A, HANDLE_A)
setHandle(B, HANDLE_B)
setHandle(C, 'alice.test') // Existing pre-upgrade claim, never a new join.
const resolver = {
  did: {
    resolve: async (did) => docs.get(did) ?? null,
    resolveAtprotoData: async (did) => {
      const doc = docs.get(did)
      if (!doc) throw new Error(`unresolvable: ${did}`)
      return { did, handle: doc.alsoKnownAs[0].slice(5), signingKey: '', pds: '' }
    },
  },
}

async function postEvent(did, record, event = 'create', rkey = 'post1') {
  // Decode through the same repo utility used by sync, including CID/blob/bytes.
  const decoded = cborToLexRecord(cborEncode(record))
  const cid = await cidForRecord(decoded)
  return { event, did, collection, rkey, uri: AtUri.make(did, collection, rkey),
    record: decoded, cid, seq: 1, time: T }
}
const params = { repo: A, collection, rkey: 'post1' }
const search = (db, q = 'alice', retiredOnly = false, limit = 25) =>
  searchActors(db, resolver, { q, retiredOnly, limit })

test('private aitproto.com handles never enter either public DNS or HTTPS resolution', async () => {
  const db = openDb(':memory:')
  const client = createPeerClient({ hostname: `${MACHINE_A}.localhost`, entryPort: 1,
    ca: '', isApproved: () => true, db, source: PEER_SOURCE })
  let publicCalls = 0
  client.resolver.handle.resolveDns = async () => { publicCalls++; return A }
  client.resolver.handle.resolveHttp = async () => { publicCalls++; return A }
  try {
    assert.equal(await client.resolver.handle.resolve(HANDLE_A), undefined)
    assert.equal(publicCalls, 0)
  } finally { await client.close(); db.close() }
})

test('an authentic PLC log cannot claim hosting through a different approved machine', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ait-peer-binding-'))
  const machine = loadState(directory), signer = await Secp256k1Keypair.create()
  const { did, op } = await createOp({ signer, rotationKeys: [signer.did()],
    signingKey: signer.did(), handle: canonical('foreign'), pds: `https://${MACHINE_B}.localhost` })
  const server = https.createServer({ key: machine.key, cert: machine.cert }, (req, res) => {
    assert.equal(req.url, `/${did}/log`)
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([op]))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const db = openDb(':memory:')
  const client = createPeerClient({ hostname: machine.hostname, ca: machine.ca,
    entryPort: server.address().port, db, source: machine.id, isApproved: () => true })
  try { await assert.rejects(client.resolver.did.resolve(did), /identity belongs to another peer/) }
  finally {
    await client.close(); server.closeAllConnections()
    await new Promise(resolve => server.close(resolve)); db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('peer projection preserves records and resolves labels without network fallback', async (t) => {
  const db = openDb(':memory:')
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network forbidden in projection fixture') }
  t.after(() => { globalThis.fetch = oldFetch; db.close() })
  const blobCid = await cidForRecord({ image: 'fixture' })
  const record = {
    $type: collection, text: 'complete post', createdAt: T, langs: ['en'],
    facets: [{ index: { byteStart: 0, byteEnd: 8 }, features: [
      { $type: 'ait.richtext.facet#mention', did: B },
    ] }],
    reply: { root: { uri: `at://${B}/${collection}/root`, cid: blobCid.toString() },
      parent: { uri: `at://${B}/${collection}/parent`, cid: blobCid.toString() } },
    embed: { $type: 'app.bsky.embed.images', images: [{ alt: 'fixture',
      image: { $type: 'blob', ref: blobCid, mimeType: 'image/png', size: 7 } }] },
    extra: { link: blobCid, bytes: new Uint8Array([0, 128, 255]), nested: ['keep', { zero: 0 }] },
  }
  const evt = await postEvent(A, record)

  await t.test('create returns full standard JSON with original URI and CID', async () => {
    await handleEvent(db, evt, resolver)
    const result = await getRecord(db, params)
    assert.deepEqual(result, { uri: evt.uri.toString(), cid: evt.cid.toString(), value: lexToJson(record) })
    assert.equal((await cidForRecord(lexToIpld(jsonToLex(result.value)))).toString(), result.cid)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 1)
    assert.deepEqual(db.prepare('SELECT source, label, claimedHandle FROM actors WHERE did = ?').get(A),
      { source: 'local', label: 'alice', claimedHandle: HANDLE_A })
    assert.equal(await resolveActorToDid(db, '@ALICE.test'), A)
    assert.equal(await resolveActorToDid(db, 'alice.aitproto.com'), A)
    assert.equal(await resolveActorToDid(db, HANDLE_A.toUpperCase()), A)
    assert.equal(await resolveActorToDid(db, HANDLE_B), null)
    assert.equal(await resolveActorToDid(db, 'alice.example.com'), null)
    assert.deepEqual(await getRecord(db, { ...params, repo: 'alice' }), result)
    assert.equal(await getRecord(db, { ...params, cid: blobCid.toString() }), null)
    assert.equal(await getRecord(db, { ...params, collection: 'ait.actor.profile' }), null)
    assert.equal(await resolveActorToDid(db, 'missing.test'), null)
  })

  await t.test('legacy BlobRef also converts to standard JSON', async () => {
    const legacy = { $type: collection, text: 'legacy decoder', createdAt: T,
      embed: new BlobRef(blobCid, 'image/png', 7) }
    const legacyEvt = { ...evt, uri: AtUri.make(A, collection, 'legacy-blob'), rkey: 'legacy-blob',
      record: legacy, cid: await cidForRecord(lexToIpld(legacy)) }
    await handleEvent(db, legacyEvt, resolver)
    assert.deepEqual((await getRecord(db, { ...params, rkey: 'legacy-blob' })).value, lexToJson(legacy))
  })

  await t.test('update replaces full record and old CID stops matching', async () => {
    const next = await postEvent(A, { ...record, text: 'updated', extra: { replaced: true } }, 'update')
    await handleEvent(db, next, resolver)
    assert.equal(await getRecord(db, { ...params, cid: evt.cid.toString() }), null)
    const result = await getRecord(db, { ...params, cid: next.cid.toString() })
    assert.deepEqual(result.value, lexToJson(next.record))
    assert.equal(result.uri, evt.uri.toString())
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 1)
  })

  await t.test('canonical handles resolve exactly while shorthand collisions require a DID', async () => {
    await handleEvent(db, await postEvent(B, { $type: collection, text: 'peer', createdAt: T }), resolver, undefined, PEER_SOURCE)
    await handleEvent(db, await postEvent(C, { $type: collection, text: 'historical same source', createdAt: T }), resolver, undefined, PEER_SOURCE)
    await assert.rejects(resolveActorToDid(db, 'alice'), { error: 'AmbiguousHandle' })
    await assert.rejects(resolveActorToDid(db, 'alice.test'), { error: 'AmbiguousHandle' })
    await assert.rejects(resolveActorToDid(db, 'alice.aitproto.com'), { error: 'AmbiguousHandle' })
    await assert.rejects(getRecord(db, { ...params, repo: 'alice' }), { error: 'AmbiguousHandle' })
    assert.equal(await resolveActorToDid(db, 'alice@laptop'), null)
    assert.equal(await resolveActorToDid(db, A), A)
    assert.equal(await resolveActorToDid(db, HANDLE_A), A)
    assert.equal(await resolveActorToDid(db, HANDLE_B), B)
    assert.equal(await resolveActorToDid(db, canonical('alice', 'c'.repeat(52))), null)
    const { actors } = await search(db)
    assert.doesNotThrow(() => lexicons.assertValidXrpcOutput('ait.actor.searchActors', { actors }))
    assert.equal(actors.length, 3)
    for (const actor of actors) {
      const source = actor.did === A ? 'local' : PEER_SOURCE
      assert.equal(actor.handle, docs.get(actor.did).alsoKnownAs[0].slice(5))
      assert.doesNotThrow(() => ensureValidHandle(actor.handle))
      assert.equal(actor.displayName, qualifyActorLabel('alice', source, actor.did))
      assert.equal((await getRecord(db, { ...params, repo: actor.did === C ? C : actor.handle })).uri,
        AtUri.make(actor.did, collection, 'post1').toString())
    }
    assert.match((await search(db, 'alice', false, 1)).actors[0].displayName, /#did:/)
    assert.deepEqual((await search(db, HANDLE_A)).actors.map((actor) => actor.did), [A])
    assert.equal((await search(db, 'alice.aitproto.com')).actors.length, 3)
    const longLabel = qualifyActorLabel('n'.repeat(63), PEER_SOURCE, 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa')
    assert.ok(longLabel.length <= 64)
    assert.ok(longLabel.endsWith('#did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'))
    assert.doesNotThrow(() => lexicons.assertValidXrpcOutput('ait.actor.searchActors', {
      actors: [{ did: A, handle: HANDLE_A, displayName: longLabel, live: false }],
    }))
  })

  await t.test('duplicate exact claims are ambiguous rather than selected by source or order', async () => {
    setHandle(C, HANDLE_B)
    await handleEvent(db, { event: 'identity', did: C, didDocument: docs.get(C), seq: 2, time: T },
      resolver, undefined, PEER_SOURCE)
    await assert.rejects(resolveActorToDid(db, HANDLE_B), { error: 'AmbiguousHandle' })
    assert.equal(await resolveActorToDid(db, HANDLE_A), A)
    setHandle(C, 'alice.test')
    await handleEvent(db, { event: 'identity', did: C, didDocument: docs.get(C), seq: 3, time: T },
      resolver, undefined, PEER_SOURCE)
    assert.equal(await resolveActorToDid(db, HANDLE_B), B)
  })

  await t.test('a peer cannot address an actor through another machine namespace', async () => {
    setHandle(C, canonical('spoofed', MACHINE_A))
    await handleEvent(db, { event: 'identity', did: C, didDocument: docs.get(C), seq: 3, time: T },
      resolver, undefined, PEER_SOURCE)
    assert.equal(await resolveActorToDid(db, canonical('spoofed', MACHINE_A)), null)
    setHandle(C, 'alice.test')
    await handleEvent(db, { event: 'identity', did: C, didDocument: docs.get(C), seq: 4, time: T },
      resolver, undefined, PEER_SOURCE)
  })

  await t.test('retirement/inactivity cannot conceal a collision', async () => {
    db.prepare('UPDATE actors SET retiredAt = ? WHERE did = ?').run(T, B)
    db.prepare('UPDATE actors SET active = 0 WHERE did = ?').run(C)
    assert.equal((await search(db)).actors.length, 1)
    assert.equal((await search(db)).actors[0].handle, HANDLE_A)
    assert.match((await search(db)).actors[0].displayName, /@local#did:/)
    assert.equal((await search(db, 'alice', true)).actors[0].did, B)
    await assert.rejects(resolveActorToDid(db, 'alice'), { error: 'AmbiguousHandle' })
  })

  await t.test('verified identity document supersedes wire handle and stale projection', async () => {
    setHandle(B, canonical('renamed', MACHINE_B))
    await handleEvent(db, { event: 'identity', did: B, handle: canonical('forged', MACHINE_B),
      didDocument: docs.get(B), seq: 2, time: T },
      { did: { resolve: async () => { throw new Error('event document must be used') } } },
      undefined, PEER_SOURCE)
    assert.equal(await resolveActorToDid(db, 'renamed'), B)
    assert.equal(await resolveActorToDid(db, 'forged'), null)
    assert.equal(db.prepare('SELECT label FROM actors WHERE did = ?').get(B).label, 'renamed')
    assert.equal(await resolveActorToDid(db, HANDLE_B), null)
    assert.equal(await resolveActorToDid(db, canonical('renamed', MACHINE_B)), B)
    await assert.rejects(handleEvent(db, { event: 'identity', did: B,
      didDocument: docs.get(A), seq: 3, time: T }, resolver, undefined, PEER_SOURCE), /mismatch/)
    assert.equal(await resolveActorToDid(db, 'renamed'), B)
  })

  await t.test('identity without document clears cache and resolves from its source', async () => {
    const calls = []
    setHandle(C, canonical('other', MACHINE_B))
    await handleEvent(db, { event: 'identity', did: C, handle: canonical('forged', MACHINE_B), seq: 4, time: T },
      { did: { resolve: async (did) => { calls.push('resolve'); return docs.get(did) } } },
      { clearEntry: async (did) => { assert.equal(did, C); calls.push('clear') } }, PEER_SOURCE)
    assert.deepEqual(calls, ['clear', 'resolve'])
    assert.equal(await resolveActorToDid(db, 'other'), C)
    assert.equal(await resolveActorToDid(db, 'alice'), A)
    assert.equal((await search(db)).actors[0].handle, HANDLE_A)
    assert.equal((await search(db)).actors[0].displayName, 'alice')
  })

  await t.test('hydration preserves wire handles; friendly labels recognize only approved namespaces', async () => {
    assert.equal(await hydrateHandle(resolver, A), HANDLE_A)
    assert.deepEqual(await hydrateHandles(resolver, [A, A, B]),
      new Map([[A, HANDLE_A], [B, canonical('renamed', MACHINE_B)]]))
    assert.equal(friendlyHandle(HANDLE_A), 'alice')
    assert.equal(friendlyHandle('alice.aitproto.com'), 'alice')
    assert.equal(friendlyHandle('historical.test'), 'historical')
    assert.equal(friendlyHandle('alice.example.com'), 'alice.example.com')
    assert.equal(friendlyHandle(canonical('alice', 'a'.repeat(51))), canonical('alice', 'a'.repeat(51)))
    assert.equal(friendlyHandle(canonical('alice', '0'.repeat(52))), canonical('alice', '0'.repeat(52)))
    assert.equal(await hydrateHandle({ did: { resolveAtprotoData: async () => ({ handle: 'historical.test' }) } }, A), 'historical.test')
    assert.equal(await hydrateHandle({ did: { resolveAtprotoData: async () => ({ handle: 'a.test.example' }) } }, A), 'a.test.example')
    await assert.rejects(hydrateHandle({ did: {} }, A), /resolveAtprotoData/)
    await assert.rejects(hydrateHandle(resolver, 'did:plc:missing'), /unresolvable/)
    await assert.rejects(handleEvent(db, { event: 'identity', did: 'did:plc:missing', seq: 5, time: T }, resolver), /not found/)
  })

  await t.test('follow target is not attributed to the follower source', async () => {
    const subject = 'did:plc:subject'
    await handleEvent(db, { ...evt, did: B, collection: 'ait.graph.follow',
      uri: AtUri.make(B, 'ait.graph.follow', 'follow1'), record: { subject, createdAt: T } },
      resolver, undefined, PEER_SOURCE)
    assert.deepEqual(db.prepare('SELECT source, label, claimedHandle FROM actors WHERE did = ?').get(subject),
      { source: null, label: null, claimedHandle: null })
  })

  await t.test('delete removes record even when DID resolution is unavailable', async () => {
    await handleEvent(db, { ...evt, event: 'delete' },
      { did: { resolve: async () => { throw new Error('deleted DID unavailable') } } })
    assert.equal(await getRecord(db, params), null)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE uri = ?').get(evt.uri.toString()).n, 0)
    assert.equal(await getRecord(db, { ...params, rkey: 'missing' }), null)
  })
})

test('offline/unlinked peer projections serve every read surface and notification replay without identity fallback', async () => {
  const db = openDb(':memory:'), oldFetch = globalThis.fetch
  setHandle(B, HANDLE_B)
  const peer = await postEvent(B, { $type: collection, text: 'retained peer post', createdAt: T,
    facets: [{ index: { byteStart: 0, byteEnd: 8 }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: A }] }] })
  await handleEvent(db, peer, resolver, undefined, PEER_SOURCE)
  await handleEvent(db, { ...peer, did: A, collection: 'ait.graph.follow',
    uri: AtUri.make(A, 'ait.graph.follow', 'follow'), record: { subject: B, createdAt: T } }, resolver)
  const unreachable = { did: { resolveAtprotoData: async () => { throw Error('peer is Unlinked or offline') } } }
  try {
    assert.equal((await getAuthorFeed(db, unreachable, { did: B })).feed[0].post.author.handle, HANDLE_B)
    assert.equal((await getProfile(db, unreachable, { did: B, pdsUrl: 'http://127.0.0.1:1' })).handle, HANDLE_B)
    assert.equal((await getTimeline(db, unreachable, { viewer: A })).feed[0].post.author.handle, HANDLE_B)
    assert.equal((await getPostThread(db, unreachable, { uri: peer.uri.toString() })).thread.post.author.handle, HANDLE_B)
    assert.equal((await listNotifications(db, unreachable, { viewer: A })).notifications[0].author.handle, HANDLE_B)
    const delivered = []
    globalThis.fetch = async (_, init) => { delivered.push(JSON.parse(init.body)); return new Response('ok') }
    await registerAndReplay(db, unreachable, A, 'http://127.0.0.1:1/push', 0)
    assert.equal(delivered[0].author.handle, HANDLE_B)
    // The resolver itself still fails: projected labels are display data only.
    await assert.rejects(unreachable.did.resolveAtprotoData(B), /Unlinked or offline/)
    await assert.rejects(hydrateHandle(unreachable, A, db), /Unlinked or offline/)
  } finally { globalThis.fetch = oldFetch; _clear(); db.close() }
})

test('legacy projection migration preserves partial rows without fabricating complete records', async (t) => {
  const tmp = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.peer-projection-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const filename = join(tmp, 'legacy.sqlite')
  const raw = new Database(filename)
  raw.exec(`CREATE TABLE actors (did TEXT PRIMARY KEY, indexedAt TEXT NOT NULL);
    CREATE TABLE posts (uri TEXT PRIMARY KEY, cid TEXT NOT NULL, did TEXT NOT NULL,
      text TEXT NOT NULL, facets TEXT, replyRootUri TEXT, replyParentUri TEXT,
      createdAt TEXT NOT NULL, indexedAt TEXT NOT NULL);`)
  raw.prepare('INSERT INTO actors VALUES (?, ?)').run(A, T)
  raw.prepare('INSERT INTO posts VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)')
    .run(AtUri.make(A, collection, 'post1').toString(), 'legacy-cid', A, 'keep this text', T, T)
  raw.close()
  let db = openDb(filename)
  try {
    assert.equal(db.prepare('SELECT text FROM posts').get().text, 'keep this text')
    assert.equal(await getRecord(db, params), null)
    assert.equal(await resolveActorToDid(db, 'alice'), null)
    assert.equal(db.prepare('SELECT claimedHandle FROM actors').get().claimedHandle, null)
    await handleEvent(db, await postEvent(A, { $type: collection, text: 'complete replay', createdAt: T }), resolver)
    assert.equal((await getRecord(db, params)).value.text, 'complete replay')
    db.close()
    db = openDb(filename)
    assert.equal(await resolveActorToDid(db, 'alice.test'), A)
    assert.equal(await resolveActorToDid(db, HANDLE_A), A)
    assert.equal(db.prepare('SELECT claimedHandle FROM actors').get().claimedHandle, HANDLE_A)
    assert.equal((await getRecord(db, params)).value.text, 'complete replay')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 1)
  } finally { db.close() }
})
