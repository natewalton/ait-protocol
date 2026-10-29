import assert from 'node:assert/strict'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createOp, updatePdsOp, validateOperationLog } from '@did-plc/lib'
import { Repo, MemoryBlockstore, WriteOpAction, getFullRepo, concatBytesAsync, verifyRepoCar } from '@atproto/repo'
import { Firehose, MemoryRunner } from '@atproto/sync'
import { MessageFrame } from '@atproto/xrpc-server'
import { WebSocketServer, WebSocket } from 'ws'
import { EndpointId } from '@number0/iroh'
import { base32 } from 'multiformats/bases/base32'
import { createPeerClient } from './peer-client.mjs'
import { start } from './iroh-tcp-tunnel.mjs'

// Read-only reference consumer functions. Never import server.js or any .env.
// Their only state below is a new owned SQLite DB; registry has no host sessions.
import { openDb } from '/Users/nwalton/.local/share/ait-protocol/appview/dist/db.js'
import { handleEvent } from '/Users/nwalton/.local/share/ait-protocol/appview/dist/indexer.js'
import { getPostThread } from '/Users/nwalton/.local/share/ait-protocol/appview/dist/queries/getPostThread.js'
import { listNotifications } from '/Users/nwalton/.local/share/ait-protocol/appview/dist/queries/listNotifications.js'

const root = mkdtempSync(path.join(tmpdir(), 'ait-private-peer-integration-'))
process.umask(0o077)
const sources = [], clients = [], feeds = [], databases = []
const checks = [], requests = []
process.stdout.write(''); process.stderr.write('')
const baselineResources = process.getActiveResourcesInfo()
const time = '2026-01-01T00:00:00.000Z'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function check(name, fn) {
  const detail = await fn()
  checks.push({ name, passed: true, ...detail })
  console.log(`PASS ${checks.length}: ${name}`)
}
function within(promise, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`fixture timeout: ${label}`)), 15000)
  })]).finally(() => clearTimeout(timer))
}
function hostnameFor(id) {
  // The binding's runtime string is hex despite its declaration's base32
  // comment. Encode the actual 32-byte public key using upstream base32.
  const bytes = Uint8Array.from(EndpointId.fromString(id).toBytes())
  assert.equal(bytes.length, 32)
  const label = base32.encode(bytes).slice(1)
  assert.match(label, /^[a-z2-7]{52}$/)
  return `${label}.localhost`
}
function certificate(label, hostname) {
  const file = name => path.join(root, `${label}-${name}`)
  writeFileSync(file('ca.cnf'), `[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=${label} fixture CA\n[ca]\nbasicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:${hostname}\n`)
  writeFileSync(file('leaf.ext'), `basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname}\n`)
  const openssl = (...args) => execFileSync('/usr/bin/openssl', args, { stdio: 'ignore' })
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', file('ca.key'), '-out', file('ca.pem'), '-config', file('ca.cnf'))
  openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${label} fixture`, '-keyout', file('leaf.key'), '-out', file('leaf.csr'))
  openssl('x509', '-req', '-in', file('leaf.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-set_serial', '2', '-days', '1', '-extfile', file('leaf.ext'), '-out', file('leaf.pem'))
  return { ca: readFileSync(file('ca.pem')), key: readFileSync(file('leaf.key')), cert: readFileSync(file('leaf.pem')) }
}
async function source(label) {
  const s = { label, actors: new Map(), hostname: undefined, ca: undefined,
    sockets: new Set(), ws: new WebSocketServer({ noServer: true }) }
  sources.push(s)
  s.server = https.createServer({}, (req, res) => {
    requests.push({ source: label, host: req.headers.host, method: req.method, path: req.url })
    if (req.method !== 'GET' || req.headers.host !== s.hostname) { res.writeHead(403); return res.end() }
    const url = new URL(req.url, `https://${s.hostname}`)
    const did = decodeURIComponent(url.pathname.slice(1, -4))
    if (url.pathname.endsWith('/log') && s.actors.has(did)) {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify(s.actors.get(did).log))
    }
    if (url.pathname === '/xrpc/com.atproto.sync.getRepo') {
      const actor = s.actors.get(url.searchParams.get('did'))
      if (actor) { res.setHeader('content-type', 'application/vnd.ipld.car'); return res.end(actor.car) }
    }
    res.writeHead(404); res.end()
  })
  s.server.on('connection', socket => { s.sockets.add(socket); socket.once('close', () => s.sockets.delete(socket)) })
  s.server.on('tlsClientError', () => {})
  s.server.on('upgrade', (req, socket, head) => {
    requests.push({ source: label, host: req.headers.host, method: 'UPGRADE', path: req.url })
    if (req.headers.host !== s.hostname || !req.url.startsWith('/xrpc/com.atproto.sync.subscribeRepos?')) return socket.destroy()
    s.ws.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {})
      for (const actor of s.actors.values()) {
        ws.send(new MessageFrame({ seq: 1, did: actor.did, time }, { type: '#identity' }).toBytes())
        ws.send(new MessageFrame({ seq: 2, did: actor.did, active: true, time }, { type: '#account' }).toBytes())
        ws.send(new MessageFrame(actor.event, { type: '#commit' }).toBytes())
      }
    })
  })
  s.server.listen(0, '127.0.0.1'); await once(s.server, 'listening')
  s.tunnel = await start(s.server.address().port, { inheritSandbox: true })
  s.hostname = hostnameFor(s.tunnel.serverId)
  const cert = certificate(label, s.hostname)
  s.ca = cert.ca
  s.server.setSecureContext({ key: cert.key, cert: cert.cert })
  s.origin = `https://${s.hostname}`
  return s
}
async function actor(source, label, writes) {
  const signer = await Secp256k1Keypair.create()
  const rotation = await Secp256k1Keypair.create()
  const { did, op } = await createOp({ signer: rotation, rotationKeys: [rotation.did()],
    signingKey: signer.did(), handle: `${label}.test`, pds: 'http://pds.localhost' })
  const store = new MemoryBlockstore()
  const repo = await Repo.create(store, did, signer, writes)
  const car = Buffer.from(await concatBytesAsync(getFullRepo(store, repo.cid)))
  const change = await updatePdsOp(op, rotation, source.origin)
  const data = await validateOperationLog(did, [op, change])
  assert.equal(data.did, did)
  const ops = []
  for await (const record of repo.walkRecords()) ops.push({ action: 'create', path: `${record.collection}/${record.rkey}`, cid: record.cid })
  const value = { did, signer, repo, store, car, log: [op, change],
    event: { seq: 3, rebase: false, tooBig: false, repo: did, commit: repo.cid,
      rev: repo.commit.rev, since: null, blocks: car, ops, blobs: [], time } }
  source.actors.set(did, value)
  return value
}
function client(source, link, ca = source.ca) {
  const value = createPeerClient({ hostname: source.hostname,
    entryPort: source.tunnel.entryPort, ca, isApproved: () => link.approved })
  clients.push(value); return value
}
async function consume(source, peer, db, count) {
  const events = [], errors = []
  let complete, reject
  const completed = new Promise((resolve, fail) => { complete = resolve; reject = fail })
  const runner = new MemoryRunner({ startCursor: 0 })
  const feed = new Firehose({ service: peer.origin.replace('https:', 'wss:'),
    agent: peer.wsAgent, idResolver: peer.resolver, runner,
    handleEvent: async event => {
      await handleEvent(db, event, peer.resolver)
      events.push(event)
      if (events.filter(e => e.event === 'create').length === count) complete()
    }, onError: error => { errors.push(String(error)); reject(error) } })
  const running = feed.start()
  const record = { feed, running }; feeds.push(record)
  await within(completed, `verified ${source.label} records`)
  await runner.processAll()
  assert.deepEqual(errors, [])
  return { events, runner, record }
}

let failure
try {
  const [a, b] = await Promise.all([source('A'), source('B')])
  const link = { approved: true }
  const readA = client(a, link), readB = client(b, link)
  const alice = await actor(a, 'alice', [{ action: WriteOpAction.Create,
    collection: 'ait.feed.post', rkey: 'root', record: { $type: 'ait.feed.post', text: 'private root', createdAt: time } }])
  const rootRecord = alice.event.ops[0]
  const rootRef = { uri: `at://${alice.did}/ait.feed.post/root`, cid: rootRecord.cid.toString() }
  const bob = await actor(b, 'bob', [{ action: WriteOpAction.Create,
    collection: 'ait.feed.post', rkey: 'reply', record: { $type: 'ait.feed.post', text: 'private reply',
      createdAt: time, reply: { root: rootRef, parent: rootRef } } }])
  await check('Existing did:plc actor endpoint changes preserve the same signed repository bytes', async () => {
    for (const [source, actor, peer] of [[a, alice, readA], [b, bob, readB]]) {
      const data = await peer.resolver.did.resolveAtprotoData(actor.did)
      assert.equal(data.pds, source.origin)
      const response = await peer.get(`/xrpc/com.atproto.sync.getRepo?did=${actor.did}`)
      assert.equal(response.status, 200)
      const received = Buffer.from(await response.arrayBuffer())
      assert.equal(digest(received), digest(actor.car))
      await verifyRepoCar(received, actor.did, data.signingKey)
    }
  })
  const db = openDb(path.join(root, 'projection.sqlite')); databases.push(db)
  await check('Official authenticated Firehose consumes both independent sources over private WSS/Iroh', async () => {
    await consume(a, readA, db, 1)
    await consume(b, readB, db, 1)
    for (const actor of [alice, bob]) {
      const row = db.prepare('SELECT did,cid FROM posts WHERE did=?').get(actor.did)
      assert.equal(row.did, actor.did)
      assert.equal(row.cid, actor.event.ops[0].cid.toString())
    }
  })
  // The query's known-DID source context is already known in this fixture.
  // This is not a production directory, persisted registry or fan-out design.
  const queryResolver = { did: { resolveAtprotoData: did =>
    (did === alice.did ? readA : readB).resolver.did.resolveAtprotoData(did) } }
  await check('Unchanged AIT indexer and queries retain original author, root and parent references', async () => {
    const thread = await getPostThread(db, queryResolver, { uri: rootRef.uri })
    assert.equal(thread.thread.post.uri, rootRef.uri)
    assert.equal(thread.thread.replies[0].post.author.did, bob.did)
    const notes = await listNotifications(db, queryResolver, { viewer: alice.did })
    assert.ok(notes.notifications.some(note => note.reason === 'reply' && note.author.did === bob.did))
  })
  await check('Unapproved routes and destination overrides fail before access', async () => {
    await assert.rejects(() => readA.get('/xrpc/com.atproto.server.createSession'), /not allowed/)
    await assert.rejects(() => readA.get('https://unapproved.invalid/'), /unapproved destination/)
  })
  await check('Wrong peer CA refuses HTTPS and WSS without disabling TLS verification', async () => {
    const wrong = client(a, link, b.ca)
    await assert.rejects(() => wrong.resolver.did.resolve(alice.did))
    const ws = new WebSocket(`${wrong.origin.replace('https:', 'wss:')}/xrpc/com.atproto.sync.subscribeRepos?cursor=0`, { agent: wrong.wsAgent })
    const closed = new Promise(resolve => ws.once('close', resolve))
    const error = once(ws, 'error'); ws.on('error', () => {})
    const [err] = await within(error, 'wrong CA WSS rejection')
    assert.match(err.message, /certificate|issuer|self.signed/i)
    await within(closed, 'wrong CA WSS closes')
  })
  await check('An authentic actor copied to another source is rejected by source-hosting policy', async () => {
    b.actors.set(alice.did, alice)
    await assert.rejects(() => readB.resolver.did.resolve(alice.did, true), /another peer/)
    b.actors.delete(alice.did)
  })
  await check('A peer cannot authorize its own signing key for another actor DID', async () => {
    b.actors.set(alice.did, { ...bob, log: bob.log })
    await assert.rejects(() => readB.resolver.did.resolve(alice.did, true), /genesis|hash/i)
    b.actors.delete(alice.did)
  })
  await check('Unlink ends active subscriptions and refuses fresh access; relink replay is idempotent', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM notifications').get().n
    for (const record of feeds.splice(0)) { await record.feed.destroy(); await record.running }
    link.approved = false
    await assert.rejects(() => readA.resolver.did.resolve(alice.did, true), /not approved/)
    await assert.rejects(() => readA.get(`/xrpc/com.atproto.sync.getRepo?did=${alice.did}`), /not approved/)
    link.approved = true
    await consume(a, readA, db, 1); await consume(b, readB, db, 1)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, 2)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n, before)
  })
} catch (error) { failure = error; console.error(error) }
finally {
  const cleanup = async (label, operation) => {
    console.log(`cleanup: ${label}`)
    try { await operation() }
    catch (error) { failure ??= error; console.error(`cleanup failed: ${label}`, error) }
  }
  for (const record of feeds) await cleanup('subscription', async () => { await record.feed.destroy(); await record.running })
  for (const peer of clients) await cleanup('HTTP/WSS client', () => peer.close())
  for (const s of sources) {
    for (const ws of s.ws.clients) ws.terminate()
    if (s.tunnel) {
      await cleanup(`drain ${s.label}`, async () => {
        s.drained = await s.tunnel.transportEvidence({ waitForIdle: true })
        assert.equal(s.drained.activeConnections, 0)
        assert.equal(s.drained.activeSockets, 0)
        assert.ok(s.drained.streams.every(stream => !['open', 'shutdown'].includes(stream.status)))
        for (const c of s.drained.streams.filter(stream => stream.side === 'client' && stream.status === 'finished')) {
          assert.ok(s.drained.streams.some(peer => peer.side === 'server' && peer.status === 'finished' &&
            peer.irohToSocketSha256 === c.socketToIrohSha256 && peer.socketToIrohSha256 === c.irohToSocketSha256),
          'a normally finished stream must match bytes in both directions')
        }
      })
      await cleanup(`tunnel ${s.label}`, async () => { s.closed = await s.tunnel.close() })
    }
    for (const socket of s.sockets) socket.destroy()
    await cleanup(`WSS server ${s.label}`, () => new Promise(resolve => s.ws.close(resolve)))
    await cleanup(`HTTPS server ${s.label}`, () => new Promise(resolve => s.server.close(resolve)))
  }
  for (const db of databases) db.close()
}
for (const s of sources) {
  if (!s.closed?.workerExited || s.closed.activeConnections || s.closed.activeSockets ||
      !s.closed.nativeClosed?.every(Boolean)) failure ??= Error(`incomplete cleanup: ${s.label}`)
}
// beforeExit observes actual event-loop quiescence. A close callback can still
// report a closing TCPServerWrap until the close phase finishes. Do not poll
// for a clean snapshot; the fixed-count parent detects any run that hangs.
process.once('beforeExit', () => {
  const exitResources = process.getActiveResourcesInfo()
  const counts = values => values.reduce((out, value) => (out[value] = (out[value] ?? 0) + 1, out), {})
  const baselineCounts = counts(baselineResources), exitCounts = counts(exitResources)
  try {
    for (const [type, count] of Object.entries(exitCounts)) {
      assert.ok(count <= (baselineCounts[type] ?? 0), `owned resource remains: ${type} ${count}; baseline=${JSON.stringify(baselineCounts)}`)
    }
  } catch (error) { failure ??= error; console.error(error) }
  const result = { passed: checks.length, checks, requests, root,
    resourceCheck: { baseline: baselineResources, atExit: exitResources },
    transport: sources.map(s => ({ source: s.label, ...s.closed, drainedBeforeClose: s.drained })),
    limits: 'Loopback integration with synthetic signed repos/PLC logs and real upstream clients plus read-only AIT indexer/query modules. Not full PDS/PLC services, CLI update/link UI, harness notification delivery, VM/two-host or public release acceptance.' }
  writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: checks.length, root }))
  if (failure) process.exitCode = 1
})
