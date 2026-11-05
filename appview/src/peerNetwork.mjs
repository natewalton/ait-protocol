import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import Database from 'better-sqlite3'
import { Endpoint, EndpointTicket, RelayMode, presetMinimal } from '@number0/iroh'
import { IdResolver } from '@atproto/identity'
import { base32 } from 'multiformats/bases/base32'
import { loadState } from './peerState.mjs'
import { createPeerClient } from './peerClient.mjs'

const CONTROL = [...Buffer.from('ait-link/1')], DATA = [...Buffer.from('ait-atproto/1')]
export const sharingScope = 'Share hosted AIT actors, complete repository history, future records and blobs. Never credentials, writes or machine administration.'
export const stateDirectory = dbPath => path.join(path.dirname(path.resolve(dbPath)), 'peers')
export const peerHostname = id => `${base32.baseEncode(Uint8Array.from(id.toBytes()))}.localhost`
export function parseInvitation(text) {
  assert(text.startsWith('ait-link:'), 'not an AIT invitation')
  const value = JSON.parse(Buffer.from(text.slice(9), 'base64url').toString())
  assert.equal(value.version, 1); assert(Number.isSafeInteger(value.expires) && value.expires > Date.now(), 'invitation expired')
  assert.match(value.secret, /^[a-f0-9]{64}$/)
  const address = EndpointTicket.fromString(value.ticket).endpointAddr()
  assert(address.directAddresses().length || address.relayUrl(), 'invitation has no connection address')
  return { ...value, address }
}
function checkDirect(connection, expected) {
  assert.equal(connection.remoteId().toString(), expected, 'wrong machine key')
  // RelayMode.disabled is the transport policy. A just-accepted connection may
  // not have emitted a Selected path snapshot yet; that is not a relay path.
  // Payload eligibility is enforced by the confirmed native endpoint policy.
}
async function readJson(stream) {
  const chunks = []; let size = 0
  for (;;) {
    const bytes = await stream.recv.read(4096)
    if (!bytes.length) break
    size += bytes.length; assert(size <= 16384, 'link request too large')
    chunks.push(Buffer.from(bytes))
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}
async function writeJson(stream, value) {
  await stream.send.writeAll([...Buffer.from(JSON.stringify(value))]); await stream.send.finish()
}
async function bridge(socket, stream) {
  try {
    await Promise.all([
      (async () => {
        for await (const chunk of socket.iterator({ destroyOnReturn: false })) await stream.send.writeAll([...chunk])
        await stream.send.finish()
        assert.equal(await stream.send.stopped(), null, 'remote aborted transfer')
      })(),
      (async () => {
        for (;;) {
          const bytes = await stream.recv.read(65536); if (!bytes.length) break
          await new Promise((resolve, reject) => socket.write(Buffer.from(bytes), error => error ? reject(error) : resolve()))
        }
        const drained = finished(socket, { readable: false, cleanup: true }); socket.end(); await drained
      })(),
    ])
  } catch (error) { socket.destroy(); throw error }
}

// AppView owns one machine endpoint and its private local command socket.
export async function startPeerNetwork({ directory, db, pdsUrl, plcUrl, localResolver, accountFile,
  bindAddress = '0.0.0.0:0', name = os.hostname(), assistanceRelay, directAddress }) {
  const builder = Endpoint.builder(); presetMinimal(builder)
  const policyError = 'Private peer networking unavailable: this Iroh build cannot confirm direct-only application data.'
  assert.equal(typeof builder.directApplicationDataOnly, 'function', policyError)
  builder.directApplicationDataOnly()
  const machine = loadState(directory), sources = new Map(), connections = new Set(), sockets = new Set(), tasks = new Set()
  const controlPath = path.join(directory, 'control.sock')
  if (fs.existsSync(controlPath)) {
    const old = fs.lstatSync(controlPath)
    assert(old.isSocket() && old.uid === process.getuid(), 'peer command path is not an owned socket')
    const probe = net.connect(controlPath)
    try { await once(probe, 'connect'); throw Error('peer command socket is already serving another instance') }
    catch (error) {
      assert.equal(error.code, 'ECONNREFUSED', 'refusing to replace an active or uninspectable command socket')
      const current = fs.lstatSync(controlPath)
      assert.equal(current.ino, old.ino, 'peer command socket changed during startup')
      fs.unlinkSync(controlPath)
    } finally { probe.destroy() }
  }
  let stopping = false
  builder.secretKey([...Buffer.from(machine.state.secret, 'hex')]); builder.alpns([CONTROL, DATA])
  builder.bindAddr(bindAddress); builder.relayMode(assistanceRelay ? RelayMode.customFromUrls([]) : RelayMode.disabled())
  const endpoint = await builder.bind()
  try {
    assert.equal(endpoint.directApplicationDataOnly?.(), true, policyError)
    if (assistanceRelay) await endpoint.insertRelay({ url: assistanceRelay })
    if (directAddress) await endpoint.addExternalAddr(directAddress)
  } catch (error) { await endpoint.close(); throw error }
  const isDirect = connection => !connection.closeReason() &&
    connection.paths().some(p => p.isSelected && p.isIp)
  async function waitDirect(connection, signal) {
    signal?.throwIfAborted()
    if (isDirect(connection)) return
    let watcher, aborted
    try {
      await new Promise((resolve, reject) => {
        aborted = () => reject(signal.reason)
        signal?.addEventListener('abort', aborted, { once: true })
        watcher = connection.watchPaths((...args) => {
          if (args.find(Array.isArray)?.some(p => p.isSelected && p.isIp)) resolve()
        })
        connection.closed().then(reason => reject(Error(reason)))
        if (isDirect(connection)) resolve()
        if (signal?.aborted) aborted()
      })
    } finally { signal?.removeEventListener('abort', aborted); await watcher?.stop() }
  }
  const allowAddress = address => {
    assert(!address.relayUrl() || assistanceRelay === address.relayUrl(), 'unconfigured assistance relay')
    assert(address.directAddresses().length || address.relayUrl(), 'no connection addresses')
  }
  const track = task => { tasks.add(task); task.then(() => tasks.delete(task), error => { tasks.delete(task); if (!stopping) console.error('private peer:', error.message) }); return task }
  const socket = value => { sockets.add(value); value.on('error', () => {}); value.once('close', () => sockets.delete(value)); return value }
  const rememberConnection = connection => {
    connections.add(connection)
    const changed = () => {
      const id = connection.remoteId().toString()
      if (machine.state.peers[id] && ![...connections].some(c => c.remoteId().toString() === id && isDirect(c))) {
        console.log(`Private peer ${id}: Unavailable: direct connection lost; no relay fallback.`)
      }
    }
    const watcher = connection.watchPathEvents((...args) => {
      if (args.some(event => event?.kind === 'Closed' && event.remoteAddr && event.remoteAddr !== 'unknown' && !/^https?:/.test(event.remoteAddr))) changed()
    })
    track(connection.closed().then(() => watcher.stop()))
  }
  const ownInfo = () => ({ ticket: EndpointTicket.fromAddr(endpoint.addr()).toString(), ca: machine.ca, name })
  const hosted = did => {
    if (!fs.existsSync(accountFile)) return false
    const accounts = new Database(accountFile, { readonly: true, fileMustExist: true })
    try { return !!accounts.prepare('SELECT did FROM actor WHERE did = ?').get(did) }
    finally { accounts.close() }
  }
  const requestTarget = req => {
    assert(req.method === 'GET' && req.headers.host === machine.hostname, 'peer request refused')
    // Accept only origin-form targets. Never let an absolute URL, // authority,
    // or backslash change the fixed local upstream selected below.
    assert(/^\/(?!\/)/.test(req.url) && !req.url.includes('\\'), 'invalid peer request target')
    return new URL(req.url, `https://${machine.hostname}`)
  }
  const upstreamTarget = (url, base) => {
    const target = new URL(base); target.pathname = url.pathname; target.search = url.search
    return target
  }
  const front = https.createServer({ key: machine.key, cert: machine.cert }, (req, res) => {
    try {
      const url = requestTarget(req), log = /^\/(did:plc:[a-z2-7]{24})\/log$/.exec(url.pathname)
      const repo = ['/xrpc/com.atproto.sync.getRepo', '/xrpc/com.atproto.sync.getBlob'].includes(url.pathname)
      const list = url.pathname === '/xrpc/com.atproto.sync.listRepos'
      if (!(log && hosted(log[1])) && !(repo && hosted(url.searchParams.get('did'))) && !list) { res.writeHead(403); return res.end() }
      const target = upstreamTarget(url, log ? plcUrl : pdsUrl)
      const upstream = http.get(target, { headers: { host: machine.hostname } }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res)
      })
      req.once('aborted', () => upstream.destroy()); res.once('close', () => upstream.destroy())
      upstream.on('error', error => res.destroy(error))
    } catch { res.writeHead(400); res.end() }
  })
  front.on('connection', socket)
  front.on('upgrade', (req, downstream, head) => {
    socket(downstream)
    try {
      const url = requestTarget(req)
      assert.equal(url.pathname, '/xrpc/com.atproto.sync.subscribeRepos')
      assert.equal(req.headers['sec-websocket-version'], '13')
      assert.equal(typeof req.headers['sec-websocket-key'], 'string')
      const upstreamRequest = http.request(upstreamTarget(url, pdsUrl), { headers: {
        host: machine.hostname, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-key': req.headers['sec-websocket-key'], 'sec-websocket-version': '13',
      } })
      upstreamRequest.on('upgrade', (response, upstream, rest) => {
        socket(upstream)
        downstream.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((out, value, i) => out + (i % 2 ? `${value}\r\n` : `${value}: `), '')}\r\n`)
        if (rest.length) downstream.write(rest)
        if (head.length) upstream.write(head)
        downstream.pipe(upstream).pipe(downstream)
        downstream.once('close', () => upstream.destroy()); upstream.once('close', () => downstream.destroy())
        upstream.on('error', () => downstream.destroy())
      })
      upstreamRequest.on('response', response => { response.resume(); downstream.destroy() })
      upstreamRequest.on('error', () => downstream.destroy()); upstreamRequest.end()
    } catch { downstream.destroy() }
  })
  front.listen(0, '127.0.0.1'); await once(front, 'listening')
  // Source resolvers already own their caches and refresh them on #identity.
  // Do not add a second cache that could hide those updates or survive Unlink.
  const resolver = new IdResolver({ plcUrl, fetch: async input => {
    const url = new URL(input), base = new URL(plcUrl)
    assert.equal(url.origin, base.origin, 'only local PLC or approved sources may resolve identities')
    const did = decodeURIComponent(url.pathname.slice(1))
    assert.match(did, /^did:plc:[a-z2-7]{24}$/)
    const source = db.prepare('SELECT source FROM actors WHERE did = ?').get(did)?.source
    if (source && source !== 'local') {
      const peer = sources.get(source); assert(peer, 'source is Unlinked or Unavailable')
      return Response.json(await peer.client.resolver.did.resolve(did))
    }
    const local = await localResolver.did.resolve(did)
    if (local) return Response.json(local)
    const answers = await Promise.all([...sources.values()].map(async peer => {
      try { return await peer.client.resolver.did.resolve(did) } catch (error) {
        if (error?.name === 'DidNotFoundError') return undefined
        throw error
      }
    }))
    const found = answers.filter(Boolean); assert(found.length <= 1, 'conflicting identity sources')
    return found.length ? Response.json(found[0]) : new Response('', { status: 404 })
  } })
  resolver.handle.resolve = async () => undefined

  async function attach(id) {
    const peer = machine.state.peers[id]
    const address = EndpointTicket.fromString(peer.ticket).endpointAddr()
    assert.equal(address.id().toString(), id); allowAddress(address)
    const entry = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, value => track((async () => {
      socket(value); let connection
      const disconnected = new AbortController()
      const cancel = () => { disconnected.abort(Error('local peer request closed')); connection?.close(0n, []) }
      value.once('close', cancel)
      try {
        assert(machine.state.peers[id], 'Unlinked')
        connection = await endpoint.connect(address, DATA); rememberConnection(connection); checkDirect(connection, id)
        await waitDirect(connection, disconnected.signal)
        assert(machine.state.peers[id], 'Unlinked')
        await bridge(value, await connection.openBi()); connection.close(0n, []); await connection.closed()
      } catch (error) { connection?.close(1n, []); value.destroy(); throw error }
      finally { value.off('close', cancel); if (connection) connections.delete(connection); value.destroy() }
    })()))
    entry.listen(0, '127.0.0.1'); await once(entry, 'listening')
    const client = createPeerClient({ hostname: peerHostname(address.id()), entryPort: entry.address().port,
      ca: peer.ca, isApproved: () => !!machine.state.peers[id], db, source: id,
      isApprovedSource: previous => previous === 'local' || !!machine.state.peers[previous] })
    sources.set(id, { client, entry }); client.start()
  }
  async function forget(id, pairingConnection) {
    assert(machine.state.peers[id], 'unknown machine key')
    delete machine.state.peers[id]; machine.save()
    for (const connection of connections) if (connection !== pairingConnection && connection.remoteId().toString() === id) connection.close(1n, [])
    const source = sources.get(id); sources.delete(id)
    if (source) { await source.client.close(); await new Promise(resolve => source.entry.close(resolve)) }
    return { state: 'Unlinked', id }
  }
  const acceptTask = (async () => {
    while (!stopping) {
      const incoming = await endpoint.acceptNext(); if (!incoming) return
      track((async () => {
        let connection, value
        try {
          connection = await (await incoming.accept()).connect(); rememberConnection(connection)
          const id = connection.remoteId().toString(); checkDirect(connection, id)
          if (Buffer.from(connection.alpn()).equals(Buffer.from(CONTROL))) {
            const stream = await connection.acceptBi(), request = await readJson(stream)
            const invite = machine.state.invitation
            assert(request.op === 'pair' && invite && invite.expires > Date.now(), 'no valid invitation')
            const secret = Buffer.from(request.secret || '', 'hex'), expected = Buffer.from(invite.secret, 'hex')
            assert(secret.length === expected.length && timingSafeEqual(secret, expected), 'invalid invitation')
            validatePeer(request.peer, id)
            if (machine.state.peers[id]) await forget(id, connection)
            delete machine.state.invitation; machine.state.peers[id] = request.peer; machine.save()
            await writeJson(stream, { peer: ownInfo() })
            // The recipient closes control after saving its reciprocal approval.
            // Only then open data reads; pairing needs no retry or grace period.
            await connection.closed(); await attach(id)
          } else {
            assert(machine.state.peers[id], 'Unlinked or unapproved machine')
            const stream = await connection.acceptBi()
            assert(machine.state.peers[id], 'Unlinked')
            value = socket(net.connect({ host: '127.0.0.1', port: front.address().port, allowHalfOpen: true }))
            await once(value, 'connect'); await bridge(value, stream); await connection.closed()
          }
        } catch (error) { connection?.close(1n, []); value?.destroy(); throw error }
        finally { if (connection) connections.delete(connection); value?.destroy() }
      })())
    }
  })()
  function validatePeer(peer, expectedId) {
    assert(peer && typeof peer.ca === 'string' && peer.ca.length < 8192 && peer.ca.includes('BEGIN CERTIFICATE'))
    assert(typeof peer.name === 'string' && /^[\x20-\x7e]{1,80}$/.test(peer.name), 'invalid machine name')
    const address = EndpointTicket.fromString(peer.ticket).endpointAddr()
    assert.equal(address.id().toString(), expectedId); allowAddress(address)
  }
  async function command(op, body = {}, signal) {
    if (op === 'status') return { id: machine.id, peers: Object.entries(machine.state.peers).map(([id, peer]) => ({
      id, name: peer.name, state: [...connections].some(c => c.remoteId().toString() === id && isDirect(c)) ? 'Linked' : 'Unavailable',
    })) }
    if (op === 'invite') {
      const invitation = { version: 1, ticket: ownInfo().ticket, name, secret: randomBytes(32).toString('hex'), expires: Date.now() + 10 * 60 * 1000 }
      machine.state.invitation = invitation; machine.save()
      return { invitation: `ait-link:${Buffer.from(JSON.stringify(invitation)).toString('base64url')}` }
    }
    if (op === 'unlink') return forget(body.id)
    assert.equal(op, 'link', 'unknown peer command')
    const invite = parseInvitation(body.invitation), id = invite.address.id().toString()
    assert.notEqual(id, machine.id, 'cannot link this machine to itself')
    allowAddress(invite.address)
    let connection
    const attempt = new AbortController()
    const cancelled = () => attempt.abort(Error('Link cancelled; no relay fallback.'))
    signal?.addEventListener('abort', cancelled, { once: true })
    const timeout = setTimeout(() => attempt.abort(Error('Unavailable: could not establish a direct connection; no relay fallback.')), 30000)
    const operation = (async () => {
      connection = await endpoint.connect(invite.address, CONTROL)
      rememberConnection(connection); checkDirect(connection, id)
      attempt.signal.throwIfAborted()
      await waitDirect(connection, attempt.signal)
      const stream = await connection.openBi(); await writeJson(stream, { op: 'pair', secret: invite.secret, peer: ownInfo() })
      const response = await readJson(stream); validatePeer(response.peer, id)
      attempt.signal.throwIfAborted()
      if (machine.state.peers[id]) await forget(id, connection)
      machine.state.peers[id] = response.peer; machine.save(); await attach(id)
      connection.close(0n, []); await connection.closed()
      return { state: 'Linked', id, name: response.peer.name }
    })()
    let abort
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        abort = () => { connection?.close(0n, []); reject(attempt.signal.reason) }
        attempt.signal.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) cancelled()
      })])
    } catch (error) {
      if (machine.state.peers[id]) {
        const state = [...connections].some(c => c.remoteId().toString() === id && isDirect(c)) ? 'Linked' : 'Unavailable'
        throw Error(`${error.message} Approval retained; current status: ${state}.`)
      }
      throw error
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', cancelled)
      attempt.signal.removeEventListener('abort', abort)
      connection?.close(0n, [])
      await operation.catch(() => {})
      if (connection) { connection.close(0n, []); connections.delete(connection) }
    }
  }
  const control = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST')
      const chunks = []; let length = 0
      for await (const part of req) { length += part.length; assert(length <= 16384); chunks.push(part) }
      const cancelled = new AbortController()
      res.once('close', () => { if (!res.writableEnded) cancelled.abort() })
      const value = await command(req.url.slice(1), JSON.parse(Buffer.concat(chunks).toString() || '{}'), cancelled.signal)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value))
    } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }
  })
  control.listen(controlPath); await once(control, 'listening'); fs.chmodSync(controlPath, 0o600)
  for (const id of Object.keys(machine.state.peers)) await attach(id)
  return { resolver, command, endpoint, id: machine.id, hostname: machine.hostname,
    async close() {
      stopping = true
      for (const connection of connections) connection.close(0n, [])
      for (const value of sockets) value.destroy()
      for (const { client, entry } of sources.values()) { await client.close(); await new Promise(resolve => entry.close(resolve)) }
      await endpoint.close(); await acceptTask; await Promise.allSettled([...tasks])
      await new Promise(resolve => front.close(resolve)); await new Promise(resolve => control.close(resolve))
    } }
}
