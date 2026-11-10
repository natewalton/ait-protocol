// cd appview && node --import tsx scripts/peer-feed-test.mjs
// Only temporary in-memory repos/SQLite and an ephemeral loopback WebSocket.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Agent } from 'node:http'
import { createServer } from 'node:net'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { Secp256k1Keypair } from '@atproto/crypto'
import { MemoryBlockstore, Repo, concatBytesAsync, getFullRepo } from '@atproto/repo'
import { AtUri } from '@atproto/syntax'
import { MessageFrame, Subscription } from '@atproto/xrpc-server'
import { createVerifiedFeed } from '../src/peerFeed.mjs'
import { openDb } from '../src/db.ts'
import { getRecord } from '../src/queries/getRecord.ts'

const METHOD = 'com.atproto.sync.subscribeRepos'
const POST = 'ait.feed.post'
const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const FOREIGN = 'did:plc:cccccccccccccccccccccccc'
const TIME = '2026-10-30T12:00:00.000Z'
const SOURCE = 'peer-machine'
const post = (rkey, text) => ({ action: 'create', collection: POST, rkey,
  record: { $type: POST, text, createdAt: TIME, langs: ['en'] } })
const account = (did, seq) => ({ $type: `${METHOD}#account`, did, seq, time: TIME, active: true })
const invalid = () => ({ ...account(A, 100), active: 'invalid boolean' })

async function signed(did, writes = [], key) {
  const signer = key ?? await Secp256k1Keypair.create()
  const storage = new MemoryBlockstore()
  const repo = await Repo.create(storage, did, signer, writes)
  return { repo, signer, car: await concatBytesAsync(getFullRepo(storage, repo.cid)) }
}
const listing = value => ({ did: value.repo.did, head: value.repo.cid.toString(), rev: value.repo.commit.rev, active: true })
async function commit(value, seq) {
  const ops = []
  for await (const entry of value.repo.walkRecords()) {
    ops.push({ action: 'create', path: `${entry.collection}/${entry.rkey}`, cid: entry.cid })
  }
  return { $type: `${METHOD}#commit`, seq, repo: value.repo.did, time: TIME,
    rebase: false, tooBig: false, commit: value.repo.cid, rev: value.repo.commit.rev,
    since: null, blocks: value.car, ops, blobs: [] }
}

async function fixture(t, { repos = [], pages, messages, getRepo, getJson, source = SOURCE, isApprovedSource }) {
  const db = openDb(':memory:')
  const errors = [], requests = [], resolutions = []
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const connected = Promise.withResolvers()
  server.on('connection', (socket, request) => {
    requests.push(new URL(request.url, 'http://127.0.0.1'))
    connected.resolve()
    for (const message of messages) socket.send(MessageFrame.fromLexValue(message, METHOD).toBytes())
  })
  const idResolver = {
    did: {
      async resolve(did, refresh) {
        resolutions.push({ did, refresh })
        assert(repos.some(value => value.repo.did === did), `DID endpoint is outside source: ${did}`)
        return { id: did, alsoKnownAs: [`at://actor.${'a'.repeat(52)}.aitproto.com`] }
      },
      async resolveAtprotoKey(did) {
        const value = repos.find(value => value.repo.did === did)
        assert(value, 'unknown signing key')
        return value.signer.did()
      },
    },
    handle: { resolve: async () => undefined }, // Private names never consult DNS.
  }
  const feed = createVerifiedFeed({ db, idResolver, source, isApprovedSource,
    service: `ws://127.0.0.1:${server.address().port}`,
    async getJson(path, signal) {
      await connected.promise // Confirms the WebSocket opened before enumeration.
      if (getJson) return getJson(path, signal)
      const url = new URL(path, 'http://fixture')
      assert.equal(url.pathname, '/xrpc/com.atproto.sync.listRepos')
      assert.equal(url.searchParams.get('limit'), '1000')
      const page = url.searchParams.get('cursor') ?? ''
      return pages ? pages[page] : { repos: [] }
    },
    getRepo: getRepo ?? (async did => repos.find(value => value.repo.did === did).car),
    onError: error => errors.push(error),
  })
  t.after(async () => {
    await feed.destroy().catch(() => {}) // The failure is asserted from start below.
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
    db.close()
  })
  return { db, feed, errors, requests, resolutions }
}

const failed = async feed => {
  const error = await feed.start().then(() => undefined, error => error)
  assert(error instanceof Error, 'fixture must terminate on its injected error')
  return error
}
async function waitFor(check) {
  const deadline = Date.now() + 2000
  while (!check()) {
    assert(Date.now() < deadline, 'fixture state did not change')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
function legacyPost(db, did, rkey, text = 'stale') {
  db.prepare('INSERT INTO posts (uri,cid,did,text,createdAt,indexedAt) VALUES (?,?,?,?,?,?)')
    .run(AtUri.make(did, POST, rkey).toString(), 'legacy-cid', did, text, TIME, TIME)
}

test('snapshot repairs retained-away/legacy records, paginates, prunes only its DID, and labels empty actors', { timeout: 5000 }, async t => {
  const repoA = await signed(A, [post('kept', 'complete history')])
  const repoB = await signed(B)
  const f = await fixture(t, { repos: [repoA, repoB], messages: [account(A, 1), invalid()],
    pages: { '': { repos: [listing(repoA)], cursor: 'page2' }, page2: { repos: [listing(repoB)] } } })
  legacyPost(f.db, A, 'kept', 'partial history')
  legacyPost(f.db, A, 'deleted')
  legacyPost(f.db, FOREIGN, 'foreign', 'preserve foreign data')
  f.db.prepare('INSERT INTO follows (uri,did,subject,createdAt,indexedAt) VALUES (?,?,?,?,?)')
    .run(AtUri.make(A, 'ait.graph.follow', 'gone').toString(), A, B, TIME, TIME)
  f.db.prepare('INSERT INTO profiles (did,displayName,indexedAt) VALUES (?,?,?)').run(A, 'gone', TIME)
  const error = await failed(f.feed)
  assert.equal(f.errors[0], error)
  assert.match(error.message, /active|boolean/)
  assert.equal(f.feed.getCursor(), 1)
  assert.equal(f.requests[0].searchParams.get('cursor'), '0')
  const result = await getRecord(f.db, { repo: A, collection: POST, rkey: 'kept' })
  assert.equal(result.value.text, 'complete history')
  assert.equal(result.cid, (await repoA.repo.data.get(`${POST}/kept`)).toString())
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE did = ?').get(A).n, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM follows WHERE did = ?').get(A).n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE did = ?').get(A).n, 0)
  assert.equal(f.db.prepare('SELECT text FROM posts WHERE did = ?').get(FOREIGN).text, 'preserve foreign data')
  assert.deepEqual(f.db.prepare('SELECT active, source, label FROM actors WHERE did = ?').get(B),
    { active: 1, source: SOURCE, label: 'actor' })
})

test('SQLite projection failure keeps prior cursor and stops later operations/messages', { timeout: 5000 }, async t => {
  const value = await signed(A, [post('one', 'fail'), post('two', 'must not write')])
  const next = await signed(B)
  const f = await fixture(t, { repos: [value, next], messages: [account(A, 1), await commit(value, 2), account(B, 3)] })
  f.db.exec(`CREATE TRIGGER reject_post BEFORE INSERT ON posts
    WHEN NEW.text = 'fail' BEGIN SELECT RAISE(ABORT, 'fixture SQLite projection failure'); END`)
  const error = await failed(f.feed)
  assert.match(error.message, /fixture SQLite projection failure/)
  assert.equal(f.errors[0], error)
  assert.equal(f.feed.getCursor(), 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0)
  assert.equal(f.db.prepare('SELECT did FROM actors WHERE did = ?').get(B), undefined)
})

test('foreign account metadata cannot change an existing source or active state', { timeout: 5000 }, async t => {
  const foreign = await signed(FOREIGN)
  const next = await signed(B)
  const f = await fixture(t, { repos: [foreign, next],
    messages: [{ ...account(FOREIGN, 1), active: false, status: 'deactivated' }, account(B, 2)] })
  f.db.prepare('INSERT INTO actors (did,source,active,indexedAt) VALUES (?,?,1,?)').run(FOREIGN, 'local', TIME)
  const error = await failed(f.feed)
  assert.match(error.message, /cannot overwrite/)
  assert.equal(f.resolutions[0].did, FOREIGN)
  assert.deepEqual(f.db.prepare('SELECT source,active FROM actors WHERE did = ?').get(FOREIGN), { source: 'local', active: 1 })
  assert.equal(f.db.prepare('SELECT did FROM actors WHERE did = ?').get(B), undefined)
  assert.equal(f.feed.getCursor(), 0)
})

test('an omitted/unverified commit operation aborts instead of acknowledging an empty parse', { timeout: 5000 }, async t => {
  const value = await signed(A, [post('real', 'signed')])
  const event = await commit(value, 2)
  event.ops[0].path = `${POST}/not-in-signed-tree`
  const f = await fixture(t, { repos: [value], messages: [account(A, 1), event, account(A, 3)] })
  const error = await failed(f.feed)
  assert.match(error.message, /Incomplete authenticated commit/)
  assert.equal(f.feed.getCursor(), 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0)
})

test('freshly approved replacement key refreshes old attribution only after Unlink', { timeout: 5000 }, async t => {
  const value = await signed(A)
  for (const stillApproved of [true, false]) {
    await t.test(`old key approved=${stillApproved}`, async sub => {
      const f = await fixture(sub, { repos: [value], messages: [account(A, 1), invalid()],
        isApprovedSource: previous => { assert.equal(previous, 'old-machine'); return stillApproved } })
      f.db.prepare('INSERT INTO actors (did,source,label,claimedHandle,indexedAt) VALUES (?,?,?,?,?)')
        .run(A, 'old-machine', 'old', `old.${'b'.repeat(52)}.aitproto.com`, TIME)
      const error = await failed(f.feed)
      if (stillApproved) {
        assert.match(error.message, /cannot overwrite/)
        assert.equal(f.db.prepare('SELECT source FROM actors WHERE did=?').get(A).source, 'old-machine')
      } else {
        assert.match(error.message, /active|boolean/)
        assert.deepEqual(f.db.prepare('SELECT source,label,claimedHandle FROM actors WHERE did=?').get(A),
          { source: SOURCE, label: 'actor', claimedHandle: `actor.${'a'.repeat(52)}.aitproto.com` })
        assert.equal(f.feed.getCursor(), 1)
      }
    })
  }
})

test('ordinary commits, forced identity refresh, and authenticated deletes project sequentially', { timeout: 5000 }, async t => {
  const value = await signed(A, [post('gone', 'live signed create')])
  const empty = await signed(A, [], value.signer)
  const deletion = { ...await commit(empty, 3), ops: [{ action: 'delete', path: `${POST}/gone`, cid: null }] }
  const f = await fixture(t, { repos: [value], messages: [await commit(value, 1),
    { $type: `${METHOD}#identity`, seq: 2, did: A, time: TIME,
      handle: `forged.${'b'.repeat(52)}.aitproto.com` }, deletion, invalid()] })
  await failed(f.feed)
  assert.equal(f.feed.getCursor(), 3)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0)
  assert.equal(f.db.prepare('SELECT claimedHandle FROM actors WHERE did = ?').get(A).claimedHandle,
    `actor.${'a'.repeat(52)}.aitproto.com`)
  assert(f.resolutions.some(call => call.did === A && call.refresh === true))
})

test('sync and tooBig reconcile verified snapshots, including removals', { timeout: 5000 }, async t => {
  const initial = await signed(A, [post('old', 'removed')])
  const synced = await signed(A, [post('new', 'sync snapshot')], initial.signer)
  const latest = await signed(A, [post('new', 'tooBig snapshot')], initial.signer)
  const tooBig = { ...await commit(latest, 3), tooBig: true, blocks: new Uint8Array(), ops: [] }
  let reads = 0
  const f = await fixture(t, { repos: [initial], pages: { '': { repos: [listing(initial)] } },
    messages: [account(A, 1), { $type: `${METHOD}#sync`, did: A, seq: 2,
      time: TIME, rev: synced.repo.commit.rev, blocks: synced.car }, tooBig, invalid()],
    getRepo: async () => [initial.car, synced.car, latest.car][reads++] })
  await failed(f.feed)
  assert.equal(reads, 3)
  assert.equal(f.feed.getCursor(), 3)
  assert.equal(await getRecord(f.db, { repo: A, collection: POST, rkey: 'old' }), null)
  assert.equal((await getRecord(f.db, { repo: A, collection: POST, rkey: 'new' })).value.text, 'tooBig snapshot')
})

test('invalid signed snapshot cannot prune or alter the projection', { timeout: 5000 }, async t => {
  const own = await signed(A)
  const wrongDid = await signed(B)
  const f = await fixture(t, { repos: [own], pages: { '': { repos: [listing(own)] } },
    messages: [account(A, 1)], getRepo: async () => wrongDid.car })
  legacyPost(f.db, A, 'keep', 'must survive verification failure')
  const error = await failed(f.feed)
  assert.match(error.message, /Invalid repo did/)
  assert.equal(f.db.prepare('SELECT text FROM posts WHERE did = ?').get(A).text, 'must survive verification failure')
  assert.equal(f.db.prepare('SELECT did FROM actors WHERE did = ?').get(A), undefined)
  assert.equal(f.feed.getCursor(), 0)
})

test('destroy cancels the official iterator and settles start without reporting an error', { timeout: 5000 }, async t => {
  const value = await signed(A)
  const f = await fixture(t, { repos: [value], messages: [account(A, 1)] })
  const observed = Promise.withResolvers()
  f.db.function('observed_account', () => { observed.resolve(); return 0 })
  f.db.exec('CREATE TRIGGER observe_account AFTER UPDATE OF active ON actors BEGIN SELECT observed_account(); END')
  const running = f.feed.start()
  await observed.promise
  await f.feed.destroy()
  await running
  assert.equal(f.feed.getCursor(), 1)
  assert.deepEqual(f.errors, [])
  assert.deepEqual(f.feed.getStatus(), { state: 'stopped' })
})

test('readiness waits for backfill and stays running when the ready stream is quiet', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture(t, { messages: [], getJson: async () => {
    entered.resolve()
    await release.promise
    return { repos: [] }
  } })
  assert.deepEqual(f.feed.getStatus(), { state: 'starting' })
  const running = f.feed.start()
  await entered.promise
  assert.deepEqual(f.feed.getStatus(), { state: 'starting' })
  release.resolve()
  await waitFor(() => f.feed.getStatus().state === 'running')
  assert.deepEqual(f.feed.getStatus(), { state: 'running' })
  const copy = f.feed.getStatus()
  copy.state = 'failed'
  assert.deepEqual(f.feed.getStatus(), { state: 'running' }, 'callers cannot mutate owner status')
  await f.feed.destroy()
  await running
  assert.deepEqual(f.feed.getStatus(), { state: 'stopped' })
  assert.deepEqual(f.errors, [])
})

test('terminal backfill error remains visible and start cannot restart a dead consumer', { timeout: 5000 }, async t => {
  const cause = Error('fixture listRepos unavailable')
  let reads = 0
  const f = await fixture(t, { messages: [], getJson: async () => { reads++; throw cause } })
  const running = f.feed.start()
  assert.equal(await running.catch(error => error), cause)
  assert.deepEqual(f.feed.getStatus(), { state: 'failed', error: cause.message })
  assert.equal(f.feed.start(), running)
  assert.equal(reads, 1)
  assert.deepEqual(f.errors, [cause])
  await f.feed.destroy().catch(() => {})
  assert.deepEqual(f.feed.getStatus(), { state: 'failed', error: cause.message })
})

test('destroy before start cannot create a new subscription', async t => {
  const f = await fixture(t, { messages: [] })
  await f.feed.destroy()
  await f.feed.start()
  assert.deepEqual(f.feed.getStatus(), { state: 'stopped' })
  assert.equal(f.requests.length, 0)
})

test('destroy aborts an in-flight backfill read without reporting terminal failure', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers()
  const f = await fixture(t, { messages: [], getJson: async (_path, signal) => {
    entered.resolve()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const running = f.feed.start()
  await entered.promise
  await f.feed.destroy()
  await running
  assert.deepEqual(f.feed.getStatus(), { state: 'stopped' })
  assert.deepEqual(f.errors, [])
})

test('unexpected normal iterator completion is a terminal failure', async t => {
  const iterator = Subscription.prototype[Symbol.asyncIterator]
  Subscription.prototype[Symbol.asyncIterator] = async function * () {}
  t.after(() => { Subscription.prototype[Symbol.asyncIterator] = iterator })
  const db = openDb(':memory:'), errors = []
  t.after(() => db.close())
  const feed = createVerifiedFeed({ db, idResolver: {}, service: 'ws://127.0.0.1:9',
    getJson: async () => ({ repos: [] }), getRepo: async () => { throw Error('unexpected repository read') },
    onError: error => errors.push(error),
  })
  const error = await failed(feed)
  assert.equal(error.message, 'subscription ended unexpectedly')
  assert.deepEqual(feed.getStatus(), { state: 'failed', error: error.message })
  assert.deepEqual(errors, [error])
  await feed.destroy().catch(() => {})
})

test('an initially sleeping peer resumes signed backfill and live delivery using native reconnect', { timeout: 10000 }, async t => {
  // Reserve then close an ephemeral port so the first real connection fails.
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const refused = Promise.withResolvers()
  class ObservedAgent extends Agent {
    createConnection(options, callback) {
      const socket = super.createConnection(options, callback)
      socket.once('error', refused.resolve)
      return socket
    }
  }
  const agent = new ObservedAgent()
  const db = openDb(':memory:')
  const history = await signed(A, [post('history', 'signed history')])
  const live = await signed(A, [post('history', 'signed history'), post('live', 'signed live')], history.signer)
  const historyWritten = Promise.withResolvers(), liveWritten = Promise.withResolvers()
  db.function('observe_post', rkey => {
    if (rkey.endsWith('/history')) historyWritten.resolve()
    if (rkey.endsWith('/live')) liveWritten.resolve()
    return 0
  })
  db.exec('CREATE TRIGGER observe_posts AFTER INSERT ON posts BEGIN SELECT observe_post(NEW.uri); END')
  const errors = [], requests = []
  let reads = 0, server
  const feed = createVerifiedFeed({ db, source: SOURCE, agent, service: `ws://127.0.0.1:${port}`,
    idResolver: { did: {
      resolve: async did => ({ id: did, alsoKnownAs: [`at://actor.${'a'.repeat(52)}.aitproto.com`] }),
      resolveAtprotoKey: async () => history.signer.did(),
    } },
    async getJson() { reads++; return { repos: [listing(history)] } },
    getRepo: async () => history.car,
    onError: error => errors.push(error),
  })
  t.after(async () => {
    await feed.destroy().catch(() => {})
    agent.destroy()
    if (server) {
      for (const socket of server.clients) socket.terminate()
      await new Promise(resolve => server.close(resolve))
    }
    db.close()
  })
  const running = feed.start()
  void running.catch(() => {})
  assert.equal((await refused.promise).code, 'ECONNREFUSED')
  assert.equal(reads, 0, 'sleeping peer must not trigger a failing eager HTTP backfill')
  assert.equal(feed.getCursor(), 0)
  assert.deepEqual(feed.getStatus(), { state: 'starting' })
  assert.deepEqual(errors, [])

  server = new WebSocketServer({ port, host: '127.0.0.1' })
  const connected = once(server, 'connection')
  server.on('connection', (_socket, request) => requests.push(new URL(request.url, 'http://fixture')))
  await once(server, 'listening')
  const [socket] = await connected // Upstream performs its own reconnect/backoff.
  await historyWritten.promise // No frames were sent: open alone must allow backfill.
  assert.equal((await getRecord(db, { repo: A, collection: POST, rkey: 'history' })).value.text, 'signed history')
  assert.equal(requests[0].searchParams.get('cursor'), '0')
  assert.equal(feed.getCursor(), 0, 'snapshot completion cannot acknowledge a stream sequence')
  socket.send(MessageFrame.fromLexValue(await commit(live, 1), METHOD).toBytes())
  await liveWritten.promise
  const closed = once(socket, 'close')
  socket.send(MessageFrame.fromLexValue(invalid(), METHOD).toBytes())
  const error = await running.then(() => undefined, error => error)
  await closed
  assert.match(error.message, /active|boolean/)
  assert.equal(errors[0], error, 'validation failure stays terminal after recovery')
  assert.equal(errors.length, 1)
  assert.deepEqual(feed.getStatus(), { state: 'failed', error: error.message })
  assert.equal(feed.getCursor(), 1)
  assert.equal((await getRecord(db, { repo: A, collection: POST, rkey: 'live' })).value.text, 'signed live')
  assert.equal(reads, 1)
})
