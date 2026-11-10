// Offline lifecycle checks: temporary peer state and loopback-only endpoints.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { Endpoint, Connection, SecretKey, EndpointAddr, EndpointTicket, RelayMode, presetMinimal } from '@natewalton/iroh-direct'
import { startPeerNetwork } from '../src/peerNetwork.mjs'
import { loadState } from '../src/peerState.mjs'
import { openDb } from '../src/db.ts'
import { localCommand } from '../src/peerCli.mjs'

function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/ait-peer-life-')
  const directory = path.join(root, 'appview/data/peers')
  fs.mkdirSync(path.join(root, 'pds'), { recursive: true })
  fs.mkdirSync(path.join(root, 'appview'), { recursive: true })
  fs.writeFileSync(path.join(root, 'pds/.env'), 'PDS_DATA_DIRECTORY=.pds/\n')
  fs.writeFileSync(path.join(root, 'appview/.env'), 'APPVIEW_DB_PATH=./data/appview.sqlite\n')
  const db = openDb(':memory:')
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, directory, db, options: {
    directory, db, pdsUrl: 'http://127.0.0.1:9', plcUrl: 'http://127.0.0.1:9',
    localResolver: { did: { resolve: async () => null } },
    accountFile: path.join(root, 'pds/.pds/account.sqlite'),
    bindAddress: '127.0.0.1:0', assistanceRelay: '',
  } }
}
async function runCli(root) {
  const child = spawn(process.execPath, ['--import', 'tsx',
    new URL('../src/peerCli.mjs', import.meta.url).pathname, 'status', root], {
    env: { ...process.env, HOME: root, XDG_DATA_HOME: path.join(root, 'xdg') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  const [code, signal] = await once(child, 'exit')
  clearTimeout(timeout)
  assert.equal(signal, null, stderr)
  assert.equal(code, 0, stderr)
  return stdout
}
function savePeer(directory, relay) {
  const machine = loadState(directory)
  const id = SecretKey.fromBytes([...randomBytes(32)]).public()
  machine.state.peers[id.toString()] = { name: 'fixture saved peer', ca: machine.ca,
    ticket: EndpointTicket.fromAddr(new EndpointAddr(id, relay, ['127.0.0.1:9'])).toString() }
  machine.save()
  return id.toString()
}

test('incompatible saved relay retains approval and exposes failed attachment through real CLI', { timeout: 10000 }, async t => {
  const f = fixture(t), machine = loadState(f.directory)
  const id = SecretKey.fromBytes([...randomBytes(32)]).public()
  const ticket = EndpointTicket.fromAddr(new EndpointAddr(id,
    'https://127.0.0.1:9/', ['127.0.0.1:9'])).toString()
  machine.state.peers[id.toString()] = { name: 'fixture saved peer', ca: machine.ca, ticket }
  machine.save()
  const before = fs.readFileSync(path.join(f.directory, 'machine.json'), 'utf8')
  const network = await startPeerNetwork(f.options)
  t.after(() => network.close())
  const status = await localCommand(path.join(f.directory, 'control.sock'), 'status')
  assert.deepEqual(status.peers, [{
    id: id.toString(), name: 'fixture saved peer', state: 'Unavailable', indexing: null,
    error: 'unconfigured assistance relay',
  }])
  assert.equal(fs.readFileSync(path.join(f.directory, 'machine.json'), 'utf8'), before)
  assert.match(await runCli(f.root), /Unavailable "fixture saved peer" .*indexing not started: unconfigured assistance relay/)
  await network.close()
  await network.close()
  assert(!fs.existsSync(path.join(f.directory, 'control.sock')))
})

test('CLI reports a failed importer even while its transport is Linked', { timeout: 10000 }, async t => {
  const f = fixture(t)
  fs.mkdirSync(f.directory, { recursive: true })
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ peers: [{
      id: 'fixture-id', name: 'quiet transport', state: 'Linked',
      indexing: { state: 'failed', error: 'verified snapshot refused' },
    }] }))
  })
  server.listen(path.join(f.directory, 'control.sock'))
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  assert.match(await runCli(f.root), /Linked "quiet transport" fixture-id indexing failed: verified snapshot refused/)
})

test('failed attachment after entry bind releases the entry and retains its reason', { timeout: 10000 }, async t => {
  const f = fixture(t), id = savePeer(f.directory)
  const listen = net.Server.prototype.listen
  let entry
  net.Server.prototype.listen = function (...args) {
    if (!(this instanceof https.Server) && args[0] === 0 && args[1] === '127.0.0.1') {
      entry = this
      this.once('listening', () => this.emit('error', Error('fixture entry initialization failed')))
    }
    return listen.apply(this, args)
  }
  t.after(() => { net.Server.prototype.listen = listen })
  const network = await startPeerNetwork(f.options)
  t.after(() => network.close())
  assert(entry)
  assert.equal(entry.listening, false)
  const peer = (await network.command('status')).peers.find(peer => peer.id === id)
  assert.equal(peer.indexing, null)
  assert.equal(peer.error, 'fixture entry initialization failed')
})

test('unlink cancels an attachment waiting for its listener without creating a client', { timeout: 10000 }, async t => {
  const f = fixture(t), id = savePeer(f.directory)
  const listen = net.Server.prototype.listen, entered = Promise.withResolvers()
  net.Server.prototype.listen = function (...args) {
    if (!(this instanceof https.Server) && args[0] === 0 && args[1] === '127.0.0.1') {
      entered.resolve()
      return this // Hold acquisition pending until Unlink aborts it.
    }
    return listen.apply(this, args)
  }
  t.after(() => { net.Server.prototype.listen = listen })
  const starting = startPeerNetwork(f.options)
  await entered.promise
  const result = await localCommand(path.join(f.directory, 'control.sock'), 'unlink', { id })
  assert.equal(result.state, 'Unlinked')
  const network = await starting
  t.after(() => network.close())
  assert.deepEqual((await network.command('status')).peers, [])
  assert(!JSON.parse(fs.readFileSync(path.join(f.directory, 'machine.json'))).peers[id])
})

test('an occupied command socket remains a fatal local ownership conflict', { timeout: 10000 }, async t => {
  const f = fixture(t)
  fs.mkdirSync(f.directory, { recursive: true })
  const sockets = new Set()
  const server = net.createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.listen(path.join(f.directory, 'control.sock'))
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  await assert.rejects(startPeerNetwork(f.options), /refusing to replace an active or uninspectable command socket/)
  assert(server.listening)
})

test('failed control binding closes an already bound native endpoint', { timeout: 10000 }, async t => {
  const f = fixture(t)
  // Unix socket paths are bounded on the supported macOS platform; the local
  // HTTPS bridge and native endpoint are acquired before this bind fails.
  const directory = path.join(f.root, 'x'.repeat(150))
  const close = Endpoint.prototype.close, closed = []
  Endpoint.prototype.close = async function () {
    await close.call(this)
    closed.push(this.isClosed())
  }
  t.after(() => { Endpoint.prototype.close = close })
  await assert.rejects(startPeerNetwork({ ...f.options, directory }), /EADDRINUSE|ENAMETOOLONG|EINVAL|listen/)
  assert.deepEqual(closed, [true], 'startup failure closes the acquired native endpoint')
})

test('pairing CONTROL alone cannot report Linked; DATA and unlink use the same snapshot', { timeout: 15000 }, async t => {
  const f = fixture(t), machine = loadState(f.directory)
  const builder = Endpoint.builder(); presetMinimal(builder)
  builder.directApplicationDataOnly(); builder.bindAddr('127.0.0.1:0')
  builder.relayMode(RelayMode.disabled())
  builder.alpns(['ait-link/1', 'ait-atproto/1'].map(value => [...Buffer.from(value)]))
  const remote = await builder.bind()
  t.after(() => remote.close())
  const id = remote.id().toString()
  // Retain approval but prevent the importer from creating its own DATA dial.
  machine.state.peers[id] = { name: 'control-only fixture', ca: machine.ca,
    ticket: EndpointTicket.fromAddr(new EndpointAddr(remote.id(),
      'https://127.0.0.1:9/', remote.addr().directAddresses())).toString() }
  machine.save()
  const network = await startPeerNetwork(f.options)
  t.after(() => network.close())
  const control = await remote.connect(network.endpoint.addr(), [...Buffer.from('ait-link/1')])
  t.after(() => control.close(0n, []))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal((await network.command('status')).peers[0].state, 'Unavailable')
  const data = await remote.connect(network.endpoint.addr(), [...Buffer.from('ait-atproto/1')])
  t.after(() => data.close(0n, []))
  for (let i = 0; i < 100 && (await network.command('status')).peers[0].state !== 'Linked'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const peer = (await network.command('status')).peers[0]
  assert.equal(peer.state, 'Linked'); assert.equal(peer.indexing, null)
  assert.equal(peer.error, 'unconfigured assistance relay')
  data.close(0n, []); await data.closed()
  for (let i = 0; i < 100 && (await network.command('status')).peers[0].state !== 'Unavailable'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal((await network.command('status')).peers[0].state, 'Unavailable')
  assert.equal((await network.command('unlink', { id })).state, 'Unlinked')
  assert.deepEqual((await network.command('status')).peers, [])
  assert.match(await runCli(f.root), /No approved peers/)
})

test('successful pairing reports approval without inventing a DATA connection', { timeout: 15000 }, async t => {
  const a = fixture(t), b = fixture(t), original = Endpoint.prototype.connect
  Endpoint.prototype.connect = function (address, alpn) {
    if (Buffer.from(alpn).toString() === 'ait-atproto/1') return Promise.reject(Error('fixture DATA dial unavailable'))
    return original.call(this, address, alpn)
  }
  t.after(() => { Endpoint.prototype.connect = original })
  const first = await startPeerNetwork(a.options)
  t.after(() => first.close())
  const second = await startPeerNetwork(b.options)
  t.after(() => second.close())
  const { invitation } = await first.command('invite')
  const result = await second.command('link', { invitation })
  assert.equal(result.approved, true)
  assert.equal(result.state, 'Unavailable')
  assert.equal(result.id, first.id)
  assert.equal((await second.command('status')).peers[0].state, result.state)
  // Declining a second request is a no-op, regardless of retained approval.
  const child = spawn(process.execPath, ['--import', 'tsx',
    new URL('../src/peerCli.mjs', import.meta.url).pathname, 'link', b.root, invitation], {
    env: { ...process.env, HOME: b.root }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('[y/N]')) child.stdin.end('n\n') })
  child.stderr.on('data', chunk => { errors += chunk })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  const [code] = await once(child, 'exit'); clearTimeout(timeout)
  assert.equal(code, 0, errors)
  assert.match(output, /Link request not submitted; existing approvals unchanged/)
  assert.equal((await second.command('status')).peers.length, 1)
})


test('unlink while pairing finishes cannot leave a stale approval in its reply', { timeout: 15000 }, async t => {
  const a = fixture(t), b = fixture(t)
  const connect = Endpoint.prototype.connect, closed = Connection.prototype.closed
  const gate = Promise.withResolvers(), closing = Promise.withResolvers()
  Endpoint.prototype.connect = function (address, alpn) {
    if (Buffer.from(alpn).toString() === 'ait-atproto/1') return Promise.reject(Error('fixture DATA dial unavailable'))
    return connect.call(this, address, alpn)
  }
  Connection.prototype.closed = async function () {
    const result = await closed.call(this)
    closing.resolve()
    await gate.promise // Hold completion after native close while Unlink runs.
    return result
  }
  t.after(() => { gate.resolve(); Endpoint.prototype.connect = connect; Connection.prototype.closed = closed })
  const first = await startPeerNetwork(a.options)
  t.after(() => first.close())
  const second = await startPeerNetwork(b.options)
  t.after(() => second.close())
  const { invitation } = await first.command('invite')
  const pending = second.command('link', { invitation })
  await closing.promise
  await second.command('unlink', { id: first.id })
  gate.resolve()
  const result = await pending
  assert.equal(result.approved, false)
  assert.equal(result.state, 'Unlinked')
  assert.deepEqual((await second.command('status')).peers, [])
})
