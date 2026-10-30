import assert from 'node:assert/strict'
import https from 'node:https'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { createVerifiedFeed } from './peerFeed.mjs'
import { safeFetchWrap } from '@atproto-labs/fetch-node'
import { formatDidDoc, validateOperationLog } from '@did-plc/lib'
import { Agent, buildConnector, fetch as transportFetch } from 'undici'

// One approved source, one official resolver/cache and one TLS trust anchor.
export function createPeerClient({ hostname, entryPort, ca, isApproved, db, source, isApprovedSource = () => true }) {
  assert.match(hostname, /^[a-z2-7]{52}\.localhost$/)
  const origin = `https://${hostname}`
  const permitted = url => {
    assert(isApproved(), 'peer is not approved')
    assert.equal(url.origin, origin, 'unapproved destination')
    assert.equal(url.username + url.password + url.hash, '', 'invalid destination')
  }
  const lookup = (name, opts, done) => {
    try {
      permitted(new URL(`https://${name}`))
      opts.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)
    } catch (error) { done(error) }
  }
  const connector = buildConnector({ ca, lookup })
  const dispatcher = new Agent({ connect(opts, done) {
    try { permitted(new URL(`${opts.protocol}//${opts.hostname}`)) }
    catch (error) { return done(error) }
    connector({ ...opts, port: String(entryPort) }, done)
  } })
  const wsAgent = new https.Agent({ ca })
  wsAgent.createConnection = (opts, done) => {
    try { permitted(new URL(`https://${opts.host}`)) }
    catch (error) { done(error); return }
    return https.Agent.prototype.createConnection.call(wsAgent,
      { ...opts, port: entryPort, lookup }, done)
  }
  const transport = (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    permitted(url)
    assert.equal(request.method, 'GET', 'peer routes are read-only')
    assert.equal(request.redirect, 'error', 'peer redirects are refused')
    assert(/^\/did:plc:[a-z2-7]{24}\/log$/.test(url.pathname) ||
      ['/xrpc/com.atproto.sync.getRepo', '/xrpc/com.atproto.sync.getBlob', '/xrpc/com.atproto.sync.listRepos'].includes(url.pathname),
    'peer route is not allowed')
    return transportFetch(request.url, { method: request.method, headers: request.headers,
      signal: request.signal, redirect: request.redirect, dispatcher })
  }
  const small = safeFetchWrap({ fetch: transport })
  const repo = safeFetchWrap({ fetch: transport, responseMaxSize: 100 * 1024 * 1024 })
  const raw = (input, init) => (new URL(input).pathname === '/xrpc/com.atproto.sync.getRepo' ? repo : small)(input, init)
  const cache = new MemoryCache()
  const resolver = new IdResolver({ plcUrl: origin, didCache: cache, fetch: async (input, init) => {
    const url = new URL(input); permitted(url)
    const did = decodeURIComponent(url.pathname.slice(1))
    assert.match(did, /^did:plc:[a-z2-7]{24}$/)
    const response = await raw(new URL(`/${did}/log`, origin), init)
    if (!response.ok) return response
    const data = await validateOperationLog(did, await response.json())
    if (!data) return new Response('', { status: 404 })
    assert.equal(data.services.atproto_pds?.endpoint, origin, 'identity belongs to another peer')
    return Response.json(formatDidDoc(data))
  } })
  resolver.handle.resolve = async () => undefined
  const read = async route => {
    const response = await raw(new URL(route, origin), { redirect: 'error' })
    assert(response.ok, `peer read failed: ${response.status}`)
    return response
  }
  const feed = createVerifiedFeed({ db, source, isApprovedSource,
    service: origin.replace('https:', 'wss:'), agent: wsAgent, idResolver: resolver,
    getJson: async route => (await read(route)).json(),
    getRepo: async did => new Uint8Array(await (await read(`/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`)).arrayBuffer()),
    onError: error => console.error(`peer ${hostname}: ${error.message}`, error.cause) })
  let running
  return { resolver, start() { running = feed.start(); void running.catch(() => {}) },
    async close() {
      try { await feed.destroy().catch(() => {}); await running?.catch(() => {}) }
      finally { wsAgent.destroy(); await dispatcher.destroy(); await cache.clear() }
    } }
}
