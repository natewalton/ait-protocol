#!/usr/bin/env node
// Trusted harness; candidate modules execute only in disposable bounded children.
// Budgets are fixed before adversarial measurements. Never tune them from results.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'

export const BUDGETS = Object.freeze({
  version: 1, concurrent: 4, invalidElements: 64, representativeRecords: 32,
  requestMs: 2000, childMs: 45000, oldSpaceMiB: 256, rssMiB: 768,
  ordinaryResponseBytes: 512 * 1024, repoResponseBytes: 100 * 1024 * 1024,
  websocketBytes: 100 * 1024 * 1024, stdioBytes: 10 * 1024 * 1024,
  plcJsonBytes: 100 * 1024, pdsJsonBytes: 150 * 1024, pdsWriteBytes: 1_000_000,
  // At most 32 normal records, four overlapping invalid requests, and existing
  // 100MiB repository/frame support. RSS includes all processes in child group.
  retainedGrowthMiB: 32, rounds: 3,
  denseCarRoots: 1_048_576,
})
const self = fileURLToPath(import.meta.url)
const args = process.argv.slice(2)
const value = key => args[args.indexOf(key) + 1]
const candidate = path.resolve(args.includes('--candidate') ? value('--candidate') : path.join(path.dirname(self), '..'))
const req = workspace => createRequire(path.join(candidate, workspace, 'package.json'))
const load = async (workspace, name) => import(pathToFileURL(req(workspace).resolve(name)))
const source = name => import(pathToFileURL(path.join(candidate, name)))
const checks = [], metrics = []
const check = (condition, message) => assert(condition, message)
async function measured(name, fn, ms = BUDGETS.requestMs) {
  const start = performance.now()
  const result = await fn()
  const elapsedMs = performance.now() - start
  metrics.push({ name, elapsedMs: Math.round(elapsedMs), rssMiB: Math.round(process.memoryUsage().rss / 1048576) })
  check(elapsedMs <= ms, `${name}: ${elapsedMs.toFixed(0)}ms exceeds ${ms}ms`)
  return result
}
async function retainedSample(name, reader = async () => {
  check(typeof global.gc === 'function', 'retained-memory fixture requires test-only --expose-gc')
  global.gc(); await new Promise(resolve => setImmediate(resolve)); global.gc()
  return process.memoryUsage()
}) {
  await new Promise(resolve => setImmediate(resolve))
  const memory = await reader()
  // external includes ArrayBuffer storage; adding arrayBuffers would count it
  // twice. RSS remains independently bounded by the process-group watchdog.
  const retainedBytes = memory.heapUsed + memory.external
  metrics.push({ name, retainedBytes, heapUsedBytes: memory.heapUsed, externalBytes: memory.external, rssMiB: Math.round(memory.rss / 1048576) })
  if (memory.maxRssMiB !== undefined) metrics.at(-1).actualServerMaxRssMiB = memory.maxRssMiB
  return retainedBytes
}
async function assertRetained(name, baseline, reader) {
  const current = await retainedSample(name, reader)
  const growthBytes = current - baseline
  metrics.at(-1).retainedGrowthBytes = growthBytes
  metrics.at(-1).retainedGrowthLimitBytes = BUDGETS.retainedGrowthMiB * 1048576
  check(growthBytes <= BUDGETS.retainedGrowthMiB * 1048576,
    `${name}: retained growth ${(growthBytes / 1048576).toFixed(2)}MiB exceeds ${BUDGETS.retainedGrowthMiB}MiB`)
}
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  check(![2582, 2583, 2585].includes(server.address().port), 'fixture selected installed-service port')
  return server.address().port
}
async function close(server) {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
async function request(port, route, body, { gzip = false, chunked = false, method = 'POST', headers = {} } = {}) {
  let data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {}))
  if (method === 'GET') data = Buffer.alloc(0)
  if (gzip) data = gzipSync(data)
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: route, method,
      headers: { 'content-type': 'application/json', ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        ...(!chunked ? { 'content-length': data.length } : {}), ...headers } }, response => {
      const chunks = []; let size = 0
      response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) response.destroy(Error('fixture response exceeded 2MiB')); else chunks.push(chunk) })
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
      response.on('error', reject)
    })
    request.setTimeout(BUDGETS.requestMs, () => request.destroy(Error('HTTP fixture timeout')))
    request.on('error', reject)
    if (chunked) for (let i = 0; i < data.length; i += 4096) request.write(data.subarray(i, i + 4096))
    else request.write(data)
    request.end()
  })
}
async function makePlc() {
  const { Database } = req('plc')('@did-plc/server')
  const { createPlcServer } = req('plc')(path.join(candidate, 'plc/launcher.js'))
  const db = Database.mock(), plc = createPlcServer({ db, port: 0 })
  const server = await plc.start(), port = server.address().port
  check(server.address().address === '127.0.0.1', 'PLC launcher did not bind loopback')
  return { plc, db, server, port }
}
async function plcTest() {
  const f = await makePlc()
  const { Secp256k1Keypair } = await load('appview', '@atproto/crypto')
  const { createOp } = req('plc')('@did-plc/lib')
  const signer = await Secp256k1Keypair.create()
  const { did, op } = await createOp({ signer, rotationKeys: [signer.did()], signingKey: signer.did(), handle: 'fixture.test', pds: 'https://fixture.test' })
  try {
    check((await measured('plc-valid-signed-create', () => request(f.port, `/${did}`, op))).status === 200, 'valid PLC creation failed')
    check((await request(f.port, `/${did}/log`, undefined, { method: 'GET' })).status === 200, 'created PLC log missing')
    const count = () => Object.values(f.db.contents).reduce((n, ops) => n + ops.length, 0)
    const before = count(), invalid = { ...op, rotationKeys: Array(BUDGETS.invalidElements).fill(0) }
    check((await request(f.port, `/${did}`, invalid)).status === 400, 'PLC warmup admitted invalid operation')
    const retained = await retainedSample('plc-retained-after-warmup')
    for (let round = 0; round < BUDGETS.rounds; round++) {
      await measured(`plc-invalid-concurrent-${round}`, async () => {
        const responses = await Promise.all(Array.from({ length: BUDGETS.concurrent }, () => request(f.port, `/${did}`, invalid, { chunked: true })))
        check(responses.every(r => r.status === 400), 'invalid PLC operation was admitted')
      })
      await assertRetained(`plc-retained-round-${round}`, retained)
    }
    for (const mode of [{}, { chunked: true }, { gzip: true, chunked: true }]) {
      const large = JSON.stringify({ ...op, rotationKeys: Array(BUDGETS.plcJsonBytes / 2).fill(0) })
      const response = await measured(`plc-decoded-limit-${JSON.stringify(mode)}`, () => request(f.port, `/${did}`, large, mode))
      check(response.status === 413, `PLC decoded byte limit failed: ${response.status} ${response.body}`)
    }
    check(count() === before, 'invalid PLC requests changed operation store')
    check((await measured('plc-subsequent-health', () => request(f.port, '/_health', undefined, { method: 'GET' }))).status === 200, 'PLC failed subsequent health')
    await assertRetained('plc-retained-after-byte-limits-and-health', retained)
  } finally { await close(f.server) }
}
async function databaseTest() {
  const { Database } = req('plc')('@did-plc/server')
  // The constructor creates a lazy pool. Never execute a PG query or connect.
  const pg = Database.postgres({ url: 'postgres://fixture:fixture@127.0.0.1:1/fixture' })
  try {
    const compiler = pg.db.getExecutor().adapter
    const query = pg.db.selectFrom('fixture').select('value').where('value', '=', "quote'\\").compile()
    check(query.sql.includes('$1'), 'bundled PLC compiler is not parameterized PostgreSQL')
    check(query.parameters[0] === "quote'\\", 'PLC changed bound literal')
    check(compiler.constructor.name.toLowerCase().includes('postgres'), 'PLC actual adapter is not Postgres')
    checks.push({ id: 'plc-postgres', compiler: compiler.constructor.name, sql: query.sql })
  } finally { await pg.close() }
  const { Database: PdsDb } = await load('pds', '@atproto/pds')
  const db = PdsDb.sqlite(path.join(process.env.HOME, 'dialect.sqlite'))
  try {
    await db.db.schema.createTable('fixture').addColumn('value', 'text').execute()
    await db.db.insertInto('fixture').values({ value: "quote'\\" }).execute()
    check((await db.db.selectFrom('fixture').selectAll().executeTakeFirst()).value === "quote'\\", 'PDS SQLite literal changed')
    const adapter = db.db.getExecutor().adapter
    check(adapter.constructor.name.toLowerCase().includes('sqlite'), 'PDS actual adapter is not SQLite')
    checks.push({ id: 'pds-sqlite', compiler: adapter.constructor.name })
  } finally { await db.db.destroy() }
}
async function pdsTest() {
  const plc = await makePlc()
  const { PDS, envToCfg, envToSecrets } = await load('pds', '@atproto/pds')
  const data = path.join(process.env.HOME, 'pds'); fs.mkdirSync(data)
  const values = { port: 0, hostname: 'pds.localhost', serviceDid: 'did:web:pds.localhost',
    dataDirectory: data, blobstoreDiskLocation: path.join(data, 'blobs'),
    didPlcUrl: `http://127.0.0.1:${plc.port}`, inviteRequired: false, rateLimitsEnabled: false,
    jwtSecret: randomBytes(32).toString('hex'), adminPassword: randomBytes(32).toString('hex'),
    plcRotationKeyK256PrivateKeyHex: randomBytes(32).toString('hex'), serviceHandleDomains: ['.test'],
    disableSsrfProtection: true, crawlers: [] }
  const pds = await PDS.create(envToCfg(values), envToSecrets(values))
  const diagnostics = []
  for (const [object, method] of [[pds.ctx.plcClient, 'sendOperation'], [pds.ctx.idResolver.did, 'resolve']]) {
    const original = object[method].bind(object)
    object[method] = async (...args) => { try { return await original(...args) } catch (error) { diagnostics.push(`${method}: ${error.message}`); throw error } }
  }
  const pdsListen = pds.app.listen.bind(pds.app)
  pds.app.listen = (port, ...rest) => pdsListen(port, '127.0.0.1', ...rest)
  const server = await pds.start(), port = server.address().port
  check(![2582, 2583, 2585].includes(port), 'PDS selected live service port')
  try {
    const accountResponse = await measured('pds-valid-account', () => request(port, '/xrpc/com.atproto.server.createAccount', {
      handle: 'resource-fixture.test', email: 'fixture@example.test', password: 'fixture-password-123456',
    }))
    check(accountResponse.status === 200, 'PDS account failed: ' + accountResponse.body + ' ' + diagnostics.join('; '))
    const account = JSON.parse(accountResponse.body), headers = { authorization: `Bearer ${account.accessJwt}` }
    const route = '/xrpc/com.atproto.repo.createRecord'
    const valid = { repo: account.did, collection: 'app.bsky.feed.post', record: {
      $type: 'app.bsky.feed.post', text: 'representative fixture', createdAt: '2026-11-10T12:00:00.000Z' } }
    check((await measured('pds-valid-record', () => request(port, route, valid, { headers }))).status === 200, 'PDS valid record rejected')
    const listing = async () => {
      const response = await request(port, `/xrpc/com.atproto.repo.listRecords?repo=${account.did}&collection=app.bsky.feed.post`, undefined, { method: 'GET', headers })
      check(response.status === 200, `PDS listing failed: ${response.status} ${response.body}`)
      return JSON.parse(response.body).records
    }
    const before = (await listing()).length
    const invalid = { ...valid, record: { ...valid.record, text: Array(BUDGETS.invalidElements).fill(0) } }
    check((await request(port, route, invalid, { headers })).status === 400, 'PDS warmup admitted invalid record')
    const retained = await retainedSample('pds-retained-after-warmup')
    for (let round = 0; round < BUDGETS.rounds; round++) {
      await measured(`pds-invalid-concurrent-${round}`, async () => {
        const responses = await Promise.all(Array.from({ length: BUDGETS.concurrent }, () => request(port, route, invalid, { headers, chunked: true })))
        check(responses.every(r => r.status === 400), 'PDS malformed record admitted')
      })
      await assertRetained(`pds-retained-round-${round}`, retained)
    }
    for (const mode of [{}, { chunked: true }, { gzip: true, chunked: true }]) {
      const oversized = JSON.stringify({ ...valid, padding: 'x'.repeat(BUDGETS.pdsWriteBytes) })
      check((await measured(`pds-write-decoded-limit-${JSON.stringify(mode)}`, () => request(port, route, oversized, { headers, ...mode }))).status === 413,
        'PDS record-write decoded limit failed')
      const defaultOversized = JSON.stringify({ identifier: 'fixture.test', password: 'x', padding: 'x'.repeat(BUDGETS.pdsJsonBytes) })
      check((await measured(`pds-default-decoded-limit-${JSON.stringify(mode)}`, () => request(port, '/xrpc/com.atproto.server.createSession', defaultOversized, mode))).status === 413,
        'PDS default decoded limit failed')
    }
    check((await measured('pds-subsequent-record-read', listing)).length === before, 'invalid PDS writes changed repository')
    check((await request(port, '/xrpc/_health', undefined, { method: 'GET' })).status === 200, 'PDS subsequent health failed')
    await assertRetained('pds-retained-after-byte-limits-and-health', retained)
  } finally {
    await pds.ctx.didCache.destroy(); await pds.destroy()
    await pds.ctx.didCache.db.db.destroy(); await pds.ctx.sequencer.db.db.destroy()
    await close(plc.server)
  }
}
async function until(checker) {
  const deadline = Date.now() + BUDGETS.requestMs
  while (!checker()) {
    check(Date.now() < deadline, 'fixture did not reach expected state within request budget')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
async function byteBoundaryTest(validCar) {
  const { assertRepoCarBounds, assertFrameBounds } = await source('appview/src/inputBounds.mjs')
  const varint = req('appview')('varint')
  // One 100MiB backing buffer is reused for these positive structural fixtures
  // and their one-byte-over-limit views. No oversized object decoding or network
  // delivery occurs here. The real signed 32-record snapshot is tested separately.
  const buffer = Buffer.alloc(BUDGETS.repoResponseBytes + 1)
  buffer.set(validCar)
  let offset = validCar.length
  const block = Buffer.alloc(1_000_000)
  while (BUDGETS.repoResponseBytes - offset >= 45) {
    const size = Math.min(block.length, BUDGETS.repoResponseBytes - offset - 39)
    block[0] = 0x5a; block.writeUInt32BE(size - 5, 1)
    const payload = block.subarray(0, size)
    const cid = Buffer.concat([Buffer.from([1, 0x71, 0x12, 0x20]), createHash('sha256').update(payload).digest()])
    const length = Buffer.from(varint.encode(cid.length + size))
    buffer.set(length, offset); offset += length.length
    buffer.set(cid, offset); offset += cid.length
    buffer.set(payload, offset); offset += payload.length
  }
  check(offset <= BUDGETS.repoResponseBytes && offset >= BUDGETS.repoResponseBytes - 45, 'near-limit CAR fixture did not reach declared byte envelope')
  await measured('peer-near-100MiB-car-structural-preflight', async () => check(assertRepoCarBounds(buffer.subarray(0, offset)).length === offset, 'bounded near-limit CAR failed'))
  assert.throws(() => assertRepoCarBounds(buffer), error => error.code === 'AIT_PEER_INPUT_LIMIT' && error.message.includes('encoded bytes exceed'))
  checks.push({ id: 'car-byte-envelope', nearLimitBytes: offset, rejectedBytes: buffer.length,
    coverage: 'structural preflight only; appended valid-CID opaque blocks; signed 32-record snapshot verified separately' })
  // Header {op:1}, then body {data:<opaque bytes>}. Strings/bytes remain opaque
  // in the preflight; this does not claim a 100MiB application message is valid.
  const prefix = Buffer.from([0xa1, 0x62, 0x6f, 0x70, 1, 0xa1, 0x64, 0x64, 0x61, 0x74, 0x61, 0x5a, 0, 0, 0, 0])
  prefix.writeUInt32BE(BUDGETS.websocketBytes - prefix.length, prefix.length - 4)
  buffer.set(prefix)
  await measured('peer-near-100MiB-frame-structural-preflight', async () => check(assertFrameBounds(buffer.subarray(0, BUDGETS.websocketBytes)).length === BUDGETS.websocketBytes, 'bounded near-limit frame failed'))
  assert.throws(() => assertFrameBounds(buffer), error => error.code === 'AIT_PEER_INPUT_LIMIT' && error.message.includes('encoded bytes exceed'))
  checks.push({ id: 'frame-byte-envelope', nearLimitBytes: BUDGETS.websocketBytes, rejectedBytes: buffer.length,
    coverage: 'two-value CBOR structural preflight only; real supported frame/backfill paths tested separately' })
}
async function peerTest(kind) {
  const { createPeerClient } = await source('appview/src/peerClient.mjs')
  const { loadState } = await source('appview/src/peerState.mjs')
  const { openDb } = await source('appview/src/db.ts')
  const { Secp256k1Keypair } = await load('appview', '@atproto/crypto')
  const { createOp } = req('appview')('@did-plc/lib')
  const repoModule = await load('appview', '@atproto/repo')
  const { Repo, MemoryBlockstore, getFullRepo, concatBytesAsync, BlockMap, blocksToCarFile, signCommit } = repoModule
  const { encode } = await load('appview', '@atproto/lex-cbor')
  const { WebSocketServer } = req('appview')('ws')
  const { MessageFrame } = await load('appview', '@atproto/xrpc-server')
  const method = 'com.atproto.sync.subscribeRepos', time = '2026-11-10T12:00:00.000Z'
  const machine = loadState(path.join(process.env.HOME, 'machine'))
  const signer = await Secp256k1Keypair.create()
  const { did, op } = await createOp({ signer, rotationKeys: [signer.did()], signingKey: signer.did(),
    handle: `fixture.${machine.hostname.slice(0, 52)}.aitproto.com`, pds: `https://${machine.hostname}` })
  const store = new MemoryBlockstore()
  const repo = await Repo.create(store, did, signer, Array.from({ length: BUDGETS.representativeRecords }, (_, i) => ({
    action: 'create', collection: 'ait.feed.post', rkey: `post${i}`, record: {
      $type: 'ait.feed.post', text: 'representative fixture ' + i, createdAt: time } })))
  const validCar = await concatBytesAsync(getFullRepo(store, repo.cid))
  const list = { repos: [{ did, head: repo.cid.toString(), rev: repo.commit.rev, active: true }] }
  let mode = 'valid', compressed = false, car = validCar, profile = { did, live: true }
  const server = https.createServer({ key: machine.key, cert: machine.cert }, (request, response) => {
    let body
    if (request.url === `/${did}/log`) {
      if (mode === 'bad-log') body = JSON.stringify([{ ...op, rotationKeys: Array(BUDGETS.invalidElements).fill(0) }])
      else if (mode === 'dense-log') body = JSON.stringify([{ ...op, rotationKeys: Array(Math.floor((BUDGETS.ordinaryResponseBytes - 4096) / 2)).fill(0) }])
      else if (mode === 'large-log') body = JSON.stringify([{ ...op, padding: 'x'.repeat(BUDGETS.ordinaryResponseBytes) }])
      else body = JSON.stringify([op])
    } else if (request.url.startsWith('/xrpc/ait.actor.getProfile')) body = JSON.stringify(profile)
    else if (request.url.startsWith('/xrpc/com.atproto.sync.listRepos')) body = JSON.stringify(list)
    else if (request.url.startsWith('/xrpc/com.atproto.sync.getRepo')) body = car
    else { response.writeHead(404); response.end(); return }
    let bytes = Buffer.from(body)
    if (compressed) { bytes = gzipSync(bytes); response.setHeader('content-encoding', 'gzip') }
    response.setHeader('content-type', Buffer.isBuffer(body) || body instanceof Uint8Array ? 'application/vnd.ipld.car' : 'application/json')
    // Deliberately chunked: no Content-Length shortcut can establish the bound.
    for (let i = 0; i < bytes.length; i += 4096) response.write(bytes.subarray(i, i + 4096))
    response.end()
  })
  const ws = new WebSocketServer({ server })
  const sockets = new Set()
  ws.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  const port = await listen(server)
  const instances = []
  const client = () => {
    const db = openDb(':memory:')
    const peer = createPeerClient({ hostname: machine.hostname, entryPort: port, ca: machine.ca,
      db, source: machine.id, isApproved: () => true })
    instances.push({ peer, db }); return { peer, db }
  }
  const rows = db => ['actors', 'posts', 'follows', 'profiles'].reduce((sum, table) => sum + db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0)
  const release = async f => {
    await f.peer.close(); f.db.close()
    instances.splice(instances.indexOf(f), 1)
    await new Promise(resolve => setImmediate(resolve))
  }
  try {
    const good = client()
    await measured('peer-valid-signed-log', async () => check((await good.peer.resolver.did.resolve(did)).id === did, 'valid peer DID failed'))
    check(await good.peer.getPresence(did) === true, 'valid peer presence failed')
    good.peer.start()
    await measured('peer-valid-32-record-snapshot', () => until(() => good.db.prepare('SELECT count(*) AS n FROM posts').get().n === BUDGETS.representativeRecords))
    await good.peer.close()
    if (kind === 'log') {
      const f = client()
      mode = 'bad-log'
      await assert.rejects(f.peer.resolver.did.resolve(did, true))
      const retained = await retainedSample('peer-log-retained-after-warmup')
      for (mode of ['bad-log', 'large-log', 'dense-log']) {
        for (compressed of [false, true]) {
          await measured(`peer-${mode}-compressed-${compressed}`, async () => {
            const responses = await Promise.allSettled(Array.from({ length: BUDGETS.concurrent }, () => f.peer.resolver.did.resolve(did, true)))
            check(responses.every(r => r.status === 'rejected'), `${mode} admitted a DID`)
          })
          check(rows(f.db) === 0, 'invalid peer log changed identity/projection database')
          await assertRetained(`peer-log-retained-${mode}-compressed-${compressed}`, retained)
        }
      }
      mode = 'valid'; compressed = false
      check((await measured('peer-subsequent-valid-log', () => f.peer.resolver.did.resolve(did, true))).id === did, 'peer resolver did not recover')
      profile = { did, live: true, padding: 'x'.repeat(BUDGETS.ordinaryResponseBytes) }
      await assert.rejects(measured('peer-profile-overlimit', () => f.peer.getPresence(did)))
      profile = { did, live: true }
      check(await f.peer.getPresence(did), 'peer presence did not recover')
      await assertRetained('peer-log-retained-after-profile-recovery', retained)
    } else if (kind === 'car') {
      const badHeader = encode({ version: 1, roots: Array(BUDGETS.invalidElements).fill(0) })
      const varint = req('appview')('varint')
      const malformed = Buffer.concat([Buffer.from(varint.encode(badHeader.length)), badHeader])
      const blocks = new BlockMap()
      const badMst = await blocks.add({ l: null, e: Array(BUDGETS.invalidElements).fill({ p: 'invalid', k: 0, v: 0, t: 0 }) })
      const commit = await signCommit({ ...repo.commit, data: badMst, sig: undefined }, signer)
      const root = await blocks.add(commit)
      const malformedMst = await blocksToCarFile(root, blocks)
      const warmup = client(); car = malformed; warmup.peer.start()
      await until(() => warmup.peer.getStatus().state === 'failed'); await release(warmup)
      const retained = await retainedSample('peer-car-retained-after-warmup')
      for (const [name, bytes] of [['car-header', malformed], ['signed-malformed-mst', malformedMst]]) {
        car = bytes
        const f = client(); f.peer.start()
        await measured(`peer-${name}`, () => until(() => f.peer.getStatus().state === 'failed'))
        check(rows(f.db) === 0, `${name} changed identity/projection database`)
        await release(f)
        await assertRetained(`peer-car-retained-${name}`, retained)
      }
      // A one-MiB header is far below the supported 100MiB repository ceiling.
      // Encode directly so fixture construction cannot generate a million JS
      // objects; only the actual consumer gets the dense malformed collection.
      const empty = Buffer.from(encode({ version: 1, roots: [] }))
      const roots = empty.indexOf(Buffer.from('roots')) + 5
      check(empty[roots] === 0x80, 'unexpected canonical CAR-header encoding')
      const length = Buffer.alloc(5); length[0] = 0x9a; length.writeUInt32BE(BUDGETS.denseCarRoots, 1)
      const denseHeader = Buffer.concat([empty.subarray(0, roots), length, Buffer.alloc(BUDGETS.denseCarRoots), empty.subarray(roots + 1)])
      car = Buffer.concat([Buffer.from(varint.encode(denseHeader.length)), denseHeader])
      console.log(JSON.stringify({ probe: 'peer-dense-car-header', members: BUDGETS.denseCarRoots, inputBytes: car.length }))
      const dense = client(); dense.peer.start()
      await measured('peer-dense-car-header', () => until(() => dense.peer.getStatus().state === 'failed'))
      check(rows(dense.db) === 0, 'dense CAR header changed identity/projection database')
      await release(dense)
      await assertRetained('peer-car-retained-dense-header', retained)
      car = validCar
      const again = client(); again.peer.start()
      await measured('peer-subsequent-valid-car', () => until(() => again.db.prepare('SELECT count(*) AS n FROM posts').get().n === BUDGETS.representativeRecords))
      await byteBoundaryTest(validCar)
      await assertRetained('peer-car-retained-after-byte-boundary-cleanup', retained)
    } else if (kind === 'ws') {
      const f = client(); f.peer.start()
      await until(() => f.db.prepare('SELECT count(*) AS n FROM posts').get().n === BUDGETS.representativeRecords)
      const before = rows(f.db)
      const invalid = { $type: `${method}#account`, did, seq: 1, time, active: Array(BUDGETS.invalidElements).fill(0) }
      for (const socket of sockets) socket.send(MessageFrame.fromLexValue(invalid, method).toBytes())
      await measured('peer-invalid-ws-warmup', () => until(() => f.peer.getStatus().state === 'failed'))
      check(rows(f.db) === before, 'invalid websocket changed projection')
      await release(f)
      const retained = await retainedSample('peer-ws-retained-after-warmup-cleanup')
      for (let round = 0; round < BUDGETS.rounds; round++) {
        const current = client(); current.peer.start()
        await until(() => current.db.prepare('SELECT count(*) AS n FROM posts').get().n === BUDGETS.representativeRecords)
        const admitted = rows(current.db)
        for (const socket of sockets) socket.send(MessageFrame.fromLexValue(invalid, method).toBytes())
        await measured(`peer-invalid-ws-message-${round}`, () => until(() => current.peer.getStatus().state === 'failed'))
        check(rows(current.db) === admitted, 'invalid websocket changed projection')
        await release(current)
        await assertRetained(`peer-ws-retained-round-${round}`, retained)
      }
      const again = client(); again.peer.start()
      await measured('peer-subsequent-valid-ws-session', () => until(() => again.db.prepare('SELECT count(*) AS n FROM posts').get().n === BUDGETS.representativeRecords))
      await assertRetained('peer-ws-retained-after-valid-session-recovery', retained)
    }
  } finally {
    for (const f of instances) { await f.peer.close().catch(() => {}); f.db.close() }
    for (const socket of sockets) socket.terminate()
    await new Promise(resolve => ws.close(resolve)); await close(server)
  }
}
async function mcpTest(oversized = true) {

  // Observe the actual SDK error without changing framing or close behavior.
  // require.resolve selects SDK's CommonJS export, but the deployed server is
  // ESM. Resolve in the candidate package's ESM context to observe its class.
  const stdioURL = execFileSync(process.execPath, ['--input-type=module', '-e',
    'console.log(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))'], {
    cwd: path.join(candidate, 'mcp'), encoding: 'utf8', timeout: BUDGETS.requestMs,
  }).trim()
  const observer = path.join(process.env.HOME, 'observe-stdio.mjs')
  fs.writeFileSync(observer, `import {StdioServerTransport} from ${JSON.stringify(stdioURL)};
const original=StdioServerTransport.prototype.start;
StdioServerTransport.prototype.start=function(...args){const onerror=this.onerror;this.onerror=error=>{console.error('SECURITY_FRAME_ERROR:'+error.message);onerror?.(error)};return original.apply(this,args)};
process.on('message',async message=>{if(message?.type!=='security-memory')return;global.gc();await new Promise(resolve=>setImmediate(resolve));global.gc();process.send({type:'security-memory',id:message.id,memory:{...process.memoryUsage(),maxRssMiB:process.resourceUsage().maxRSS/1024}})});`)
  // The harness's tsx loader may already have written its own cache into the
  // isolated TMPDIR/HOME. Compare actual server activity to that fixture baseline.
  const homeBeforeMcp = fs.readdirSync(process.env.HOME).sort()
  const server = spawn(process.execPath, ['--max-old-space-size=128', '--expose-gc', '--import', observer,
    path.join(candidate, 'mcp/dist/server.js')], { cwd: process.env.HOME, env: { ...process.env,
    AIT_NOTIFICATION_MODE: 'poll' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  const memoryPending = new Map(); let memoryId = 0
  server.on('message', message => {
    if (message?.type === 'security-memory') memoryPending.get(message.id)?.(message.memory)
  })
  const actualServerMemory = () => new Promise((resolve, reject) => {
    const id = ++memoryId
    const timer = setTimeout(() => { memoryPending.delete(id); reject(Error('actual MCP memory observation timeout')) }, BUDGETS.requestMs)
    memoryPending.set(id, memory => { clearTimeout(timer); memoryPending.delete(id); resolve(memory) })
    server.send({ type: 'security-memory', id })
  })
  const pending = new Map(); let nextId = 0, buffer = '', diagnostics = ''
  server.stdout.on('data', chunk => {
    buffer += chunk
    check(buffer.length < 2 * 1024 * 1024, 'MCP stdout exceeded fixture bound')
    let split
    while ((split = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, split); buffer = buffer.slice(split + 1)
      const message = JSON.parse(line)
      pending.get(message.id)?.resolve(message); pending.delete(message.id)
    }
  })
  server.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4096) })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`MCP ${method} timeout; ${diagnostics}`)) }, BUDGETS.requestMs)
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result) } })
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    await measured('mcp-initialize', () => rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'security-fixture', version: '1' } }))
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const tools = await measured('mcp-valid-tools-list', () => rpc('tools/list'))
    check(tools.result?.tools?.some(t => t.name === 'getTimeline'), 'actual AIT MCP did not expose tools')
    check((await rpc('tools/call', { name: 'getTimeline', arguments: { limit: [0] } })).result?.isError, 'MCP warmup admitted invalid tool input')
    const retained = await retainedSample('mcp-actual-server-retained-after-warmup', actualServerMemory)
    for (let round = 0; round < BUDGETS.rounds; round++) {
      const replies = await measured(`mcp-invalid-concurrent-${round}`, () => Promise.all(Array.from({ length: BUDGETS.concurrent }, () =>
        rpc('tools/call', { name: 'getTimeline', arguments: { limit: Array(BUDGETS.invalidElements).fill(0) } }))))
      check(replies.every(r => r.result?.isError), 'MCP malformed tool input admitted')
      await assertRetained(`mcp-actual-server-retained-round-${round}`, retained, actualServerMemory)
    }
    check((await measured('mcp-subsequent-read', () => rpc('tools/list'))).result?.tools?.length > 0, 'MCP failed subsequent permitted request')
    if (oversized) {
    // Fragments contain no newline; actual SDK framing must reject before JSON.parse.
    let pipeError
    server.stdin.on('error', error => { pipeError = error })
    const chunk = Buffer.alloc(65536, 32)
    for (let offset = 0; offset <= BUDGETS.stdioBytes; offset += chunk.length) {
      if (!server.stdin.write(chunk)) await Promise.race([once(server.stdin, 'drain'), once(server, 'exit')])
      if (server.exitCode !== null || pipeError) break
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    await until(() => diagnostics.includes(`SECURITY_FRAME_ERROR:ReadBuffer exceeded maximum size of ${BUDGETS.stdioBytes} bytes`))
    await assertRetained('mcp-actual-server-retained-after-framing-close', retained, actualServerMemory)
    checks.push({ id: 'mcp-oversized-transport-rejected', error: `ReadBuffer exceeded maximum size of ${BUDGETS.stdioBytes} bytes` })
    }
    check(JSON.stringify(fs.readdirSync(process.env.HOME).sort()) === JSON.stringify(homeBeforeMcp), 'MCP invalid calls created new persisted state')
  } finally {
    server.stdin.destroy()
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await once(server, 'exit') }
  }
  if (oversized) await measured('mcp-fresh-session-after-frame-rejection', () => mcpTest(false))
}

async function childMain(group) {
  // Node's tsx loader reads candidate TypeScript, never a built installed copy.
  if (group === 'plc') await plcTest()
  else if (group === 'database') await databaseTest()
  else if (group === 'pds') await pdsTest()
  else if (group.startsWith('peer-')) await peerTest(group.slice(5))
  else if (group === 'mcp') await mcpTest()
  else throw Error(`Required ingress fixture not implemented: ${group}`)
  return { group, checks, metrics, maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }
}

async function parentMain() {
  const commit = execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const testHash = createHash('sha256').update(fs.readFileSync(self)).digest('hex')
  const budgetHash = createHash('sha256').update(JSON.stringify(BUDGETS)).digest('hex')
  const results = [], errors = []
  // Compile the deployed JS before the runtime measurements. TypeScript's
  // positive build workload has a separate finite budget; it is not an input
  // parser and does not share the service's fixed heap/RSS acceptance envelope.
  const buildHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-security-build-'))
  try {
    execFileSync(process.execPath, ['--max-old-space-size=1024', req('mcp').resolve('typescript/bin/tsc'), '--project', path.join(candidate, 'mcp/tsconfig.json')], {
      cwd: buildHome, env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: buildHome, TMPDIR: buildHome },
      timeout: 60000, maxBuffer: 1024 * 1024, stdio: 'pipe',
    })
  } finally { fs.rmSync(buildHome, { recursive: true, force: true }) }
  for (const group of ['database', 'plc', 'pds', 'peer-log', 'peer-car', 'peer-ws', 'mcp']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-security-input-'))
    const output = []
    let outputBytes = 0, peakRssMiB = 0, failure
    const child = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=' + BUDGETS.oldSpaceMiB,
      '--import', req('appview').resolve('tsx/esm'), self, '--candidate', candidate, '--child', group], {
      cwd: home, detached: true, env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
        HOME: home, TMPDIR: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
        XDG_CACHE_HOME: home, NODE_ENV: 'test', LOG_LEVEL: 'silent', AIT_NOTIFICATION_MODE: 'poll' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const kill = reason => { failure ??= reason; try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    const timer = setTimeout(() => kill('parent deadline exceeded'), BUDGETS.childMs)
    const monitor = setInterval(() => {
      try {
        const rows = execFileSync('ps', ['-axo', 'pgid=,rss='], { encoding: 'utf8' })
        const rss = rows.split('\n').reduce((sum, row) => {
          const [pgid, kib] = row.trim().split(/\s+/).map(Number)
          return sum + (pgid === child.pid ? kib : 0)
        }, 0) / 1024
        peakRssMiB = Math.max(peakRssMiB, rss)
        if (rss > BUDGETS.rssMiB) kill(`RSS ${Math.ceil(rss)}MiB exceeded ${BUDGETS.rssMiB}MiB`)
      } catch (error) { kill('RSS watchdog failed: ' + error.message) }
    }, 50)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes > 1024 * 1024) kill('child diagnostic output exceeded 1MiB')
      else output.push(chunk.toString())
    })
    const [code, signal] = await once(child, 'exit')
    clearTimeout(timer); clearInterval(monitor)
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    const lines = output.join('').trim().split('\n')
    let evidence
    try { evidence = JSON.parse(lines.at(-1)) } catch {}
    const passed = code === 0 && !failure && evidence?.group === group
    results.push({ group, status: passed ? 'passed' : 'blocked', peakRssMiB: Math.ceil(Math.max(peakRssMiB, evidence?.maxRssMiB || 0)), evidence,
      ...(!passed ? { error: failure ?? evidence?.error ?? lines.slice(-5).join('\n'), code, signal } : {}) })
    if (!passed) errors.push(`${group}: ${results.at(-1).error}`)
    fs.rmSync(home, { recursive: true, force: true })
  }
  const passed = results.every(r => r.status === 'passed')
  const report = { schemaVersion: 1, candidateCommit: commit, testHash, budgetHash, budgets: BUDGETS,
    status: passed ? 'passed' : 'blocked', checks: [
      { id: 'kysely-dialects', status: results.find(r => r.group === 'database').status },
      { id: 'zod-ingress', status: results.filter(r => r.group !== 'database').every(r => r.status === 'passed') ? 'passed' : 'blocked' },
    ], results, errors }
  console.log(JSON.stringify(report, null, args.includes('--json') ? 0 : 2))
  process.exitCode = passed ? 0 : 1
}
if (args.includes('--child')) {
  try { console.log(JSON.stringify(await childMain(value('--child')))); process.exit(0) }
  catch (error) { console.log(JSON.stringify({ group: value('--child'), error: error.stack, metrics })); process.exit(1) }
} else await parentMain()
