// One isolated functional run against real reference PLC/PDS services.
// No installed launcher, .env, account, database or lifecycle command is used.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { createHash, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { base32 } from 'multiformats/bases/base32'
import { EndpointId } from '@number0/iroh'
import { Secp256k1Keypair } from '@atproto/crypto'
import { Client, validateOperationLog } from '@did-plc/lib'
import { MemoryRunner } from '@atproto/sync'
import { verifyRepoCar } from '@atproto/repo'
import { start as startTunnel } from './iroh-tcp-tunnel.mjs'
import { createPeerClient } from './peer-client.mjs'

process.umask(0o077)
process.env.LOG_ENABLED = 'false'
for (const key of Object.keys(process.env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete process.env[key]
const installed = '/Users/nwalton/.local/share/ait-protocol'
const pdsRequire = createRequire(`${installed}/pds/package.json`)
const plcRequire = createRequire(`${installed}/plc/package.json`)
const mcpRequire = createRequire(`${installed}/mcp/package.json`)
const { PDS, envToCfg, envToSecrets } = await import(pathToFileURL(pdsRequire.resolve('@atproto/pds')))
const { Database, PlcServer } = plcRequire('@did-plc/server')
const { AtpAgent } = await import(pathToFileURL(mcpRequire.resolve('@atproto/api')))
const { registerAitLexicons, assertValidAitRecord } = await import(`${installed}/mcp/dist/atproto/aitClient.js`)
const { openDb } = await import(`${installed}/appview/dist/db.js`)
const { handleEvent } = await import(`${installed}/appview/dist/indexer.js`)
const { getPostThread } = await import(`${installed}/appview/dist/queries/getPostThread.js`)
const { listNotifications } = await import(`${installed}/appview/dist/queries/listNotifications.js`)
const root = mkdtempSync(path.join(tmpdir(), 'ait-peer-real-services-'))
const pgData = path.join(root, 'postgres')
const instances = [], databases = []
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const pgBin = '/opt/homebrew/opt/postgresql@17/bin'
let postmasterPid, failure
const outcomes = []
function report(name, detail = {}) { outcomes.push({ name, ...detail }); console.log(JSON.stringify(outcomes.at(-1))) }
function within(promise, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`functional run timed out: ${label}`)), 20000)
  })]).finally(() => clearTimeout(timer))
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function startPds(s, hostname, serviceDid) {
  s.env = { ...s.env, hostname, serviceDid }
  const cfg = envToCfg(s.env)
  s.pds = await PDS.create(cfg, envToSecrets(s.env))
  const listen = s.pds.app.listen.bind(s.pds.app)
  s.pds.app.listen = (port, ...args) => listen(port, '127.0.0.1', ...args)
  const server = await s.pds.start()
  s.pdsPort = server.address().port
  assert.ok(![2582, 2583, 2585].includes(s.pdsPort))
  s.localUrl = `http://127.0.0.1:${s.pdsPort}`
  return cfg
}
async function stopPds(s) {
  const pds = s.pds
  await pds.ctx.didCache.destroy()
  await pds.destroy()
  await pds.ctx.didCache.db.db.destroy()
  await pds.ctx.sequencer.db.db.destroy()
  s.pds = undefined
}
async function rpc(s, method, body, token) {
  if (body?.record) assertValidAitRecord(s.lex, body.collection, body.record)
  const response = await fetch(`${s.localUrl}/xrpc/${method}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(result)}`)
  return result
}
async function localRepo(s) {
  const response = await fetch(`${s.localUrl}/xrpc/com.atproto.sync.getRepo?did=${s.account.did}`)
  assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer())
}
function certificates(s) {
  const file = name => path.join(s.directory, name)
  writeFileSync(file('ca.cnf'), `[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Owned fixture CA\n[ca]\nbasicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:${s.hostname}\n`)
  writeFileSync(file('leaf.ext'), `basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${s.hostname}\n`)
  const ssl = (...args) => execFileSync('/usr/bin/openssl', args, { stdio: 'ignore' })
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', file('ca.key'), '-out', file('ca.pem'), '-config', file('ca.cnf'))
  ssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Owned peer fixture', '-keyout', file('leaf.key'), '-out', file('leaf.csr'))
  ssl('x509', '-req', '-in', file('leaf.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-set_serial', '2', '-days', '1', '-extfile', file('leaf.ext'), '-out', file('leaf.pem'))
  s.ca = readFileSync(file('ca.pem'))
  s.front.setSecureContext({ key: readFileSync(file('leaf.key')), cert: readFileSync(file('leaf.pem')) })
}
async function prepare(s) {
  const rotation = await Secp256k1Keypair.import(s.env.plcRotationKeyK256PrivateKeyHex)
  const log = await s.plcClient.getOperationLog(s.account.did)
  const before = await validateOperationLog(s.account.did, log)
  if (before.services.atproto_pds.endpoint !== s.origin) {
    await s.plcClient.updatePds(s.account.did, rotation, s.origin)
  }
  const afterLog = await s.plcClient.getOperationLog(s.account.did)
  const after = await validateOperationLog(s.account.did, afterLog)
  assert.equal(after.services.atproto_pds.endpoint, s.origin)
  assert.equal(after.did, before.did)
  assert.deepEqual(after.verificationMethods, before.verificationMethods)
  assert.deepEqual(after.rotationKeys, before.rotationKeys)
  assert.deepEqual(after.alsoKnownAs, before.alsoKnownAs)
  return { before, after, count: afterLog.length }
}
async function instance(label, pgPort) {
  const s = { label, directory: path.join(root, label), hosted: new Set(), sockets: new Set() }
  instances.push(s); mkdirSync(s.directory)
  execFileSync(`${pgBin}/createdb`, ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'ait_fixture', label], { stdio: 'ignore' })
  const db = Database.postgres({ url: `postgres://ait_fixture@127.0.0.1:${pgPort}/${label}` })
  s.plcDb = db; await db.migrateToLatestOrThrow()
  s.plc = PlcServer.create({ db, port: 0 })
  const listen = s.plc.app.listen.bind(s.plc.app)
  s.plc.app.listen = (port, ...args) => listen(port, '127.0.0.1', ...args)
  s.plcPort = (await s.plc.start()).address().port
  assert.ok(![2582, 2583, 2585].includes(s.plcPort))
  s.plcClient = new Client(`http://127.0.0.1:${s.plcPort}`)
  s.env = { port: 0, dataDirectory: path.join(s.directory, 'pds'), blobstoreDiskLocation: path.join(s.directory, 'blobs'),
    didPlcUrl: `http://127.0.0.1:${s.plcPort}`, serviceHandleDomains: ['.test'],
    inviteRequired: false, rateLimitsEnabled: false, jwtSecret: randomBytes(32).toString('hex'),
    adminPassword: randomBytes(32).toString('hex'), plcRotationKeyK256PrivateKeyHex: randomBytes(32).toString('hex'),
    crawlers: [], disableSsrfProtection: true }
  mkdirSync(s.env.dataDirectory)
  s.lex = new AtpAgent({ service: 'http://127.0.0.1:1' }); registerAitLexicons(s.lex)
  const cfg = await startPds(s, 'pds.localhost')
  s.serviceDid = cfg.service.did
  s.account = await rpc(s, 'com.atproto.server.createAccount', {
    handle: `${label}.test`, email: `${label}@example.com`, password: randomBytes(24).toString('hex'),
  })
  s.hosted.add(s.account.did)
  s.identityFile = path.join(s.directory, 'identity.json')
  writeFileSync(s.identityFile, JSON.stringify(s.account))
  s.identityHash = sha(readFileSync(s.identityFile))
  s.oldPost = await rpc(s, 'com.atproto.repo.createRecord', { repo: s.account.did, collection: 'ait.feed.post',
    record: { $type: 'ait.feed.post', text: `existing ${label} history`, createdAt: new Date().toISOString() }, validate: false }, s.account.accessJwt)
  s.repoHash = sha(await localRepo(s))
  s.front = https.createServer({}, (req, res) => {
    if (req.method !== 'GET' || req.headers.host !== s.hostname) { res.writeHead(403); return res.end() }
    const url = new URL(req.url, s.origin)
    const match = /^\/(did:plc:[a-z2-7]{24})\/log$/.exec(url.pathname)
    const repo = ['/xrpc/com.atproto.sync.getRepo', '/xrpc/com.atproto.sync.getBlob'].includes(url.pathname)
    if (!(match && s.hosted.has(match[1])) && !(repo && s.hosted.has(url.searchParams.get('did')))) {
      res.writeHead(403); return res.end()
    }
    const upstream = http.request({ host: '127.0.0.1', port: match ? s.plcPort : s.pdsPort,
      path: req.url, method: 'GET', headers: { host: s.hostname } }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res)
    })
    upstream.on('error', error => res.destroy(error)); upstream.end()
  })
  s.front.on('connection', socket => { s.sockets.add(socket); socket.once('close', () => s.sockets.delete(socket)) })
  s.front.on('upgrade', (req, socket, head) => {
    if (req.headers.host !== s.hostname || new URL(req.url, s.origin).pathname !== '/xrpc/com.atproto.sync.subscribeRepos') return socket.destroy()
    const request = http.request({ host: '127.0.0.1', port: s.pdsPort, path: req.url, headers: req.headers })
    request.on('upgrade', (response, upstream, remainder) => {
      s.sockets.add(upstream); upstream.once('close', () => s.sockets.delete(upstream))
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((out, value, index) => out + (index % 2 ? `${value}\r\n` : `${value}: `), '')}\r\n`)
      if (remainder.length) socket.write(remainder)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
      socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
      socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy())
    })
    request.on('error', () => socket.destroy()); request.end()
  })
  s.front.listen(0, '127.0.0.1'); await once(s.front, 'listening')
  s.tunnel = await startTunnel(s.front.address().port, { inheritSandbox: true })
  s.hostname = `${base32.encode(Uint8Array.from(EndpointId.fromString(s.tunnel.serverId).toBytes())).slice(1)}.localhost`
  s.origin = `https://${s.hostname}`; certificates(s)
  const change = await prepare(s)
  assert.equal(change.count, 2)
  assert.equal((await prepare(s)).count, 2, 'repeat preparation must not append another operation')
  await stopPds(s)
  const preparedCfg = await startPds(s, s.hostname, s.serviceDid)
  assert.equal(preparedCfg.service.did, s.serviceDid)
  assert.equal((await rpc(s, 'com.atproto.server.getSession', undefined, s.account.accessJwt)).did, s.account.did)
  assert.equal(sha(await localRepo(s)), s.repoHash)
  assert.equal(sha(readFileSync(s.identityFile)), s.identityHash)
  s.link = { approved: true }
  s.peer = createPeerClient({ hostname: s.hostname, entryPort: s.tunnel.entryPort, ca: s.ca, isApproved: () => s.link.approved })
  const identity = await s.peer.resolver.did.resolveAtprotoData(s.account.did)
  const car = Buffer.from(await (await s.peer.get(`/xrpc/com.atproto.sync.getRepo?did=${s.account.did}`)).arrayBuffer())
  assert.equal(sha(car), s.repoHash); await verifyRepoCar(car, s.account.did, identity.signingKey)
  report('real PLC/PDS preparation preserves actor, keys, old access token and signed repository', {
    source: label, did: s.account.did, serviceDid: s.serviceDid, operations: change.count,
    repoSha256: s.repoHash, identityFileSha256: s.identityHash,
  })
  return s
}

try {
  execFileSync(`${pgBin}/initdb`, ['-D', pgData, '-U', 'ait_fixture', '--auth-local=trust', '--auth-host=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'ignore' })
  const pgPort = await freePort()
  execFileSync(`${pgBin}/pg_ctl`, ['-D', pgData, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${pgPort} -c unix_socket_directories=''`, '-w', 'start'], { stdio: 'ignore' })
  postmasterPid = Number(readFileSync(path.join(pgData, 'postmaster.pid'), 'utf8').split('\n')[0])
  assert.ok(postmasterPid > 1)
  report('owned Postgres started with TCP loopback only', { postmasterPid, pgPort })
  const a = await instance('alice', pgPort), b = await instance('bob', pgPort)
  const db = openDb(path.join(root, 'view.sqlite')); databases.push(db)
  let resolveIndexed
  const indexed = new Promise(resolve => { resolveIndexed = resolve })
  for (const s of instances) {
    s.subscription = s.peer.subscribe({ runner: new MemoryRunner({ startCursor: 0 }),
      handleEvent: async event => {
        await handleEvent(db, event, s.peer.resolver)
        if (db.prepare('SELECT COUNT(*) n FROM posts').get().n === 3) resolveIndexed()
      }, onError: error => { throw error } })
  }
  const parent = { uri: a.oldPost.uri, cid: a.oldPost.cid }
  const reply = await rpc(b, 'com.atproto.repo.createRecord', { repo: b.account.did, collection: 'ait.feed.post',
    record: { $type: 'ait.feed.post', text: 'reply after endpoint preparation', createdAt: new Date().toISOString(),
      reply: { root: parent, parent } }, validate: false }, b.account.accessJwt)
  await within(indexed, 'real signed records projected over Iroh')
  const resolver = { did: { resolveAtprotoData: did =>
    instances.find(s => s.hosted.has(did)).peer.resolver.did.resolveAtprotoData(did) } }
  const thread = await getPostThread(db, resolver, { uri: a.oldPost.uri })
  assert.equal(thread.thread.replies[0].post.uri, reply.uri)
  assert.equal(thread.thread.replies[0].post.cid, reply.cid)
  const notes = await listNotifications(db, resolver, { viewer: a.account.did })
  assert.ok(notes.notifications.some(note => note.reason === 'reply' && note.author.did === b.account.did))
  report('real PDS writes traverse authenticated WSS/Iroh into unchanged AIT thread and notification queries', {
    root: a.oldPost.uri, reply: reply.uri, cid: reply.cid,
  })
} catch (error) { failure = error; console.error(error) }
finally {
  const cleanup = async (label, fn) => {
    try { await fn() } catch (error) { failure ??= error; console.error(`cleanup ${label}`, error) }
  }
  for (const s of instances) {
    if (s.peer) await cleanup('peer', () => s.peer.close())
    if (s.tunnel) await cleanup('tunnel', async () => {
      s.closed = await s.tunnel.close()
      assert.ok(s.closed.workerExited)
      assert.deepEqual(s.closed.nativeClosed, [true, true])
      assert.equal(s.closed.activeSockets, 0); assert.equal(s.closed.activeConnections, 0)
    })
    for (const socket of s.sockets) socket.destroy()
    if (s.front) await cleanup('front', () => new Promise(resolve => s.front.close(resolve)))
    if (s.pds) await cleanup('PDS', () => stopPds(s))
    if (s.plc) await cleanup('PLC', () => s.plc.destroy())
    else if (s.plcDb) await cleanup('PLC database', () => s.plcDb.close())
  }
  for (const db of databases) db.close()
  if (postmasterPid) await cleanup('owned Postgres', () => {
    assert.equal(Number(readFileSync(path.join(pgData, 'postmaster.pid'), 'utf8').split('\n')[0]), postmasterPid)
    execFileSync(`${pgBin}/pg_ctl`, ['-D', pgData, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' })
    report('owned Postgres stopped', { postmasterPid })
  })
}
writeFileSync(path.join(root, 'result.json'), JSON.stringify({ root, outcomes, failure: failure && String(failure),
  cleanup: instances.map(s => ({ source: s.label, plcPort: s.plcPort, pdsPort: s.pdsPort, tunnel: s.closed })),
  limits: 'Owned real PLC/Postgres and PDS/SQLite plus reviewed Iroh/client and installed AIT query modules. No ordinary ait update, link UI, friendly names, local-PDS reply lookup, VM/two-host or real harness delivery proof.' }, null, 2))
console.log(JSON.stringify({ root, passed: outcomes.length, failure: failure && String(failure) }))
if (failure) process.exitCode = 1
