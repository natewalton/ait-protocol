// Production AppView main with temporary state and ephemeral loopback PDS/PLC.
// Nothing reads installed env/data or binds an AIT fixed port. The only native
// peer endpoint is loopback-only with assistance disabled and no approved peer.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { WebSocketServer } from 'ws'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'
import { formatDidDoc } from '@did-plc/lib'
import { cidForRecord } from '@atproto/repo'
import { base32 } from 'multiformats/bases/base32'
import { openDb } from '../dist/db.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const APPVIEW = 'did:plc:cccccccccccccccccccccccc'
const localHandle = `terminal-observer.${'a'.repeat(52)}.aitproto.com`
const peerHandle = `terminal-observer.${base32.baseEncode(Buffer.from('ab'.repeat(32), 'hex'))}.aitproto.com`
const timestamp = '2026-11-09T12:00:00.000Z'
const fixedPorts = new Set([2582, 2583, 2585])

async function within(promise, label, timeout = 5000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`timed out: ${label}`)), timeout)
    })])
  } finally { clearTimeout(timer) }
}
async function until(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw Error(`timed out: ${label}${last ? ` (${last.message})` : ''}`)
}
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  assert(!fixedPorts.has(server.address().port), 'fixture must not use a live service port')
  return server.address().port
}
async function availablePort() {
  const server = net.createServer(), port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}

async function fixture(t, { held = true, occupiedPort = false, operator = 'terminal-observer.test' } = {}) {
  const root = fs.mkdtempSync('/private/tmp/ait-startup-ready-')
  const state = { root, child: undefined, held: new Set(), reads: 0, aborts: 0,
    result: 'hold', out: '', err: '', exit: undefined, closed: false }
  t.after(async () => {
    if (state.closed) return
    if (state.child && !state.exit) {
      state.child.kill('SIGTERM')
      try { await within(state.exited, 'child cleanup', 3000) }
      catch { state.child.kill('SIGKILL'); await state.exited }
    }
    for (const response of state.held) response.destroy()
    for (const socket of state.wss.clients) socket.terminate()
    await new Promise(resolve => state.wss.close(resolve))
    state.pds.closeAllConnections()
    await new Promise(resolve => state.pds.close(resolve))
    if (state.occupied) await new Promise(resolve => state.occupied.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
    state.closed = true
  })
  for (const name of ['appview', 'pds', 'home', 'xdg', 'logs']) fs.mkdirSync(path.join(root, name))
  const accountFile = path.join(root, 'pds', 'account.sqlite')
  const accounts = new Database(accountFile)
  accounts.exec('CREATE TABLE actor (did TEXT PRIMARY KEY, handle TEXT)')
  accounts.prepare('INSERT INTO actor VALUES (?, ?)').run(A, localHandle)
  accounts.close()
  fs.writeFileSync(path.join(root, 'pds', '.env'), 'PDS_ACCOUNT_DB_LOCATION=account.sqlite\n')
  fs.writeFileSync(path.join(root, 'appview', '.env'), `APPVIEW_OPERATOR=${operator}\n`)
  const dbPath = path.join(root, 'appview', 'data', 'appview.sqlite')
  const db = openDb(dbPath)
  for (const actor of [[A, 'local', localHandle], [B, 'ab'.repeat(32), peerHandle]]) {
    db.prepare('INSERT INTO actors (did, source, label, claimedHandle, indexedAt) VALUES (?, ?, ?, ?, ?)')
      .run(actor[0], actor[1], 'terminal-observer', actor[2], timestamp)
  }
  const record = { $type: 'ait.feed.post', text: 'retained peer history', createdAt: timestamp }
  const cid = (await cidForRecord(record)).toString()
  const uri = `at://${B}/ait.feed.post/retained`
  db.prepare('INSERT INTO posts (uri,cid,recordJson,did,text,createdAt,indexedAt) VALUES (?,?,?,?,?,?,?)')
    .run(uri, cid, JSON.stringify(record), B, record.text, timestamp, timestamp)
  db.close()
  state.uri = uri; state.record = record; state.cid = cid; state.dbPath = dbPath
  const signer = await Secp256k1Keypair.create()
  state.signer = signer
  state.pds = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture')
    if (decodeURIComponent(url.pathname) === `/` + A) {
      const document = formatDidDoc({ did: A, verificationMethods: { atproto: signer.did() },
        rotationKeys: [signer.did()], alsoKnownAs: [`at://${localHandle}`],
        services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: state.pdsUrl } } })
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(document)); return
    }
    if (url.pathname === '/xrpc/com.atproto.sync.listRepos') {
      state.reads++
      if (state.result === 'hold') {
        state.held.add(res)
        res.once('close', () => { state.held.delete(res); if (!res.writableEnded) state.aborts++ })
      } else state.reply(res)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"fixture-not-found"}')
  })
  state.wss = new WebSocketServer({ server: state.pds })
  state.pdsUrl = `http://127.0.0.1:${await listen(state.pds)}`
  state.reply = response => {
    response.writeHead(state.result === 'fail' ? 503 : 200, { 'content-type': 'application/json' })
    response.end(state.result === 'fail' ? '{"error":"fixture-backfill-failure"}' : '{"repos":[]}')
  }
  state.release = result => {
    state.result = result
    for (const response of state.held) state.reply(response)
    state.held.clear()
  }
  if (!held) state.result = 'ok'
  let port
  if (occupiedPort) {
    state.occupied = net.createServer(); port = await listen(state.occupied)
  } else port = await availablePort()
  state.url = `http://127.0.0.1:${port}`
  const entry = `import {main} from ${JSON.stringify(pathToFileURL(path.join(repo, 'appview/dist/server.js')).href)};
main({assistanceRelay:'',bindAddress:'127.0.0.1:0'}).catch(error=>{console.error('FIXTURE_MAIN_REJECTED',error.code,error.message);process.exitCode=7});`
  const env = { ...process.env, HOME: path.join(root, 'home'), XDG_DATA_HOME: path.join(root, 'xdg'),
    AIT_LOG_DIR: path.join(root, 'logs'), APPVIEW_OPERATOR: operator, APPVIEW_DID: APPVIEW,
    APPVIEW_PORT: String(port), APPVIEW_DB_PATH: dbPath, APPVIEW_PDS_URL: state.pdsUrl,
    APPVIEW_PDS_WS_URL: state.pdsUrl.replace('http:', 'ws:'), APPVIEW_PLC_URL: state.pdsUrl,
    APPVIEW_PEER_RELAY: '', DOTENV_CONFIG_PATH: path.join(root, 'appview', '.env') }
  state.child = spawn(process.execPath, ['--input-type=module', '-e', entry], {
    cwd: path.join(root, 'appview'), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  state.exited = once(state.child, 'exit').then(([code, signal]) => state.exit = { code, signal })
  state.child.stdout.on('data', data => state.out += data)
  state.child.stderr.on('data', data => state.err += data)
  state.token = async (method, overrides = {}) => createServiceJwt({ iss: A, aud: APPVIEW,
    lxm: method, keypair: signer, ...overrides })
  state.call = async (method, params, { data, token } = {}) => {
    const url = new URL(`/xrpc/${method}`, state.url)
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value))
    const response = await fetch(url, { method: data ? 'POST' : 'GET',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(2000) })
    return { status: response.status, body: await response.json() }
  }
  state.health = () => state.call('_health')
  state.stop = async () => {
    state.child.kill('SIGTERM')
    const exit = await within(state.exited, 'SIGTERM cleanup', 3000)
    assert.deepEqual(exit, { code: 0, signal: null }, state.err)
  }
  if (!occupiedPort) {
    await until(async () => {
      if (state.exit) throw Error(`AppView exited: ${state.err}`)
      return state.out.includes('appview listening on') && state.reads > 0
    }, 'AppView fixture listening and backfill begun')
    if (operator === 'terminal-observer.test') assert.match(state.out, new RegExp(`operator ${A} bound to the local PDS account`))
  }
  return state
}

async function assertNamedUnavailable(state) {
  const endpoints = [
    ['com.atproto.identity.resolveHandle', { handle: 'terminal-observer.test' }],
    ['ait.feed.getAuthorFeed', { actor: 'terminal-observer.test' }],
    ['com.atproto.repo.getRecord', { repo: 'terminal-observer.test', collection: 'ait.feed.post', rkey: 'retained' }],
    ['ait.actor.getProfile', { actor: 'terminal-observer.test' }, { token: await state.token('ait.actor.getProfile') }],
    ['ait.actor.setRetired', undefined, { token: await state.token('ait.actor.setRetired'), data: { subject: 'terminal-observer.test', retired: true } }],
  ]
  for (const [method, params, options] of endpoints) {
    const result = await state.call(method, params, options)
    assert.equal(result.status, 503, `${method}: ${JSON.stringify(result)}`)
    assert.equal(result.body.error, 'ProjectionUnavailable', method)
  }
}

async function assertExplicitHistoryAndRetirement(state) {
  const record = await state.call('com.atproto.repo.getRecord', { repo: B, collection: 'ait.feed.post', rkey: 'retained' })
  assert.equal(record.status, 200); assert.equal(record.body.uri, state.uri)
  const feed = await state.call('ait.feed.getAuthorFeed', { actor: B })
  assert.equal(feed.status, 200); assert.equal(feed.body.feed[0].post.uri, state.uri)
  const profile = await state.call('ait.actor.getProfile', { actor: B }, { token: await state.token('ait.actor.getProfile') })
  assert.equal(profile.status, 200); assert.equal(profile.body.did, B)
  for (const subject of [A, B]) {
    for (const retired of [true, false]) {
      const response = await state.call('ait.actor.setRetired', undefined, {
        token: await state.token('ait.actor.setRetired'), data: { subject, retired },
      })
      assert.equal(response.status, 200, JSON.stringify(response))
      assert.equal(response.body.subject, subject)
      assert.equal(response.body.retiredAt === null, !retired)
    }
  }
  const after = await state.call('ait.feed.getAuthorFeed', { actor: B })
  assert.equal(after.body.feed[0].post.uri, state.uri, 'retirement changes no retained history')
}

test('starting and failed local projections cannot provide authoritative names or suppress a mention', async t => {
  const state = await fixture(t)
  const starting = await state.health()
  assert.equal(starting.status, 503); assert.equal(starting.body.status, 'starting')
  assert.deepEqual(starting.body.indexing, { state: 'starting', connection: 'connected' })
  await assertNamedUnavailable(state)
  await assertExplicitHistoryAndRetirement(state)
  const { createPost } = await import('../../mcp/dist/aitty/agent.js')
  const previous = process.env.APPVIEW_URL
  process.env.APPVIEW_URL = state.url
  let writes = 0
  const agent = { com: { atproto: { repo: { createRecord: async () => { writes++; throw Error('unexpected fixture write') } } } } }
  try {
    await assert.rejects(createPost(agent, A, 'Notify @terminal-observer.test'),
      error => error.status === 503 && error.error === 'ProjectionUnavailable')
    assert.equal(writes, 0)
  } finally {
    if (previous === undefined) delete process.env.APPVIEW_URL
    else process.env.APPVIEW_URL = previous
  }
  state.release('fail')
  const failed = await until(async () => {
    const health = await state.health()
    return health.body.indexing.state === 'failed' && health
  }, 'terminal local indexing failure')
  assert.equal(failed.status, 503); assert.equal(failed.body.status, 'degraded')
  assert.match(failed.body.indexing.error, /listing failed: 503/)
  await assertNamedUnavailable(state)
  await assertExplicitHistoryAndRetirement(state)
  state.release('ok')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(state.reads, 1, 'terminal consumer does not falsely restart itself')
  assert.equal((await state.health()).body.status, 'degraded')
  assert.equal(state.exit, undefined, 'retained history stays available after indexing fails')
  await state.stop()
})

test('quiet completed backfill is healthy and local operator remains bound despite a peer namesake', async t => {
  const state = await fixture(t, { held: false })
  const ready = await until(async () => {
    const health = await state.health(); return health.status === 200 && health
  }, 'quiet backfill ready')
  assert.deepEqual(ready.body, { status: 'ok', indexing: { state: 'running', connection: 'connected' } })
  assert.equal(state.reads, 1)
  const ambiguous = await state.call('com.atproto.identity.resolveHandle', { handle: 'terminal-observer.test' })
  assert.equal(ambiguous.status, 400); assert.equal(ambiguous.body.error, 'AmbiguousHandle')
  await assertExplicitHistoryAndRetirement(state)
  const profile = 'ait.actor.getProfile'
  for (const token of [await state.token(profile, { aud: B }), await state.token(profile, { lxm: 'ait.feed.getTimeline' }),
    await state.token(profile, { keypair: await Secp256k1Keypair.create() }),
    await state.token(profile, { iss: B })]) {
    assert.equal((await state.call(profile, { actor: B }, { token })).status, 401)
  }
  assert.equal((await state.health()).status, 200, 'quiet healthy feed needs no posts or activity timeout')
  await state.stop()
})

test('SIGTERM cancels a held backfill HTTP read and closes the actual main promptly', async t => {
  const state = await fixture(t)
  assert.equal(state.held.size, 1)
  await state.stop()
  await until(() => state.aborts === 1, 'held PDS request aborted')
})

test('initial HTTP listen failure cleans already acquired indexing and peer resources', async t => {
  const state = await fixture(t, { occupiedPort: true })
  const exit = await within(state.exited, 'main rejects and exits without leaked resources', 5000)
  assert.deepEqual(exit, { code: 7, signal: null }, state.err)
  assert.match(state.err, /FIXTURE_MAIN_REJECTED EADDRINUSE/)
  assert(!state.out.includes('appview listening on'))
})


test('invalid operator configuration warns without disabling startup or self-retirement', async t => {
  const state = await fixture(t, { held: false, operator: 'did:not-an-identity' })
  await until(async () => (await state.health()).status === 200, 'invalid-operator local core ready')
  assert.match(state.out, /operator disabled: APPVIEW_OPERATOR is malformed/)
  const self = await state.call('ait.actor.setRetired', undefined, {
    token: await state.token('ait.actor.setRetired'), data: { subject: A, retired: true },
  })
  assert.equal(self.status, 200); assert.equal(self.body.subject, A)
  const other = await state.call('ait.actor.setRetired', undefined, {
    token: await state.token('ait.actor.setRetired'), data: { subject: B, retired: true },
  })
  assert.equal(other.status, 400); assert.equal(other.body.error, 'NotOperator')
  assert.equal((await state.health()).status, 200)
  await state.stop()
})


test('a local subscription blip reports its connection without invalidating the ready projection', async t => {
  const state = await fixture(t, { held: false })
  await until(async () => (await state.health()).status === 200, 'initial projection ready')
  for (const socket of state.wss.clients) socket.terminate()
  const reconnecting = await until(async () => {
    const health = await state.health()
    return health.body.indexing.connection === 'reconnecting' && health
  }, 'subscription reconnect detail')
  assert.equal(reconnecting.status, 200)
  assert.equal(reconnecting.body.status, 'ok')
  assert.equal(reconnecting.body.indexing.state, 'running')
  const canonical = await state.call('com.atproto.identity.resolveHandle', { handle: localHandle })
  assert.equal(canonical.status, 200)
  assert.equal(canonical.body.did, A)
  const ambiguous = await state.call('com.atproto.identity.resolveHandle', { handle: 'terminal-observer.test' })
  assert.equal(ambiguous.body.error, 'AmbiguousHandle')
  await until(async () => (await state.health()).body.indexing.connection === 'connected', 'subscription reopened')
  await state.stop()
})
