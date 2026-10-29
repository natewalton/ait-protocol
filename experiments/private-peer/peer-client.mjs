// Isolated integration prototype, not installed by AIT.
import assert from 'node:assert/strict'
import https from 'node:https'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { safeFetchWrap } from '@atproto-labs/fetch-node'
import { formatDidDoc, validateOperationLog } from '@did-plc/lib'
import { Agent, buildConnector, fetch as transportFetch } from 'undici'

// One approved source, one resolver/cache and one private TLS trust anchor.
// No global fetch, DNS, trust-store or resolver-method modification.
export function createPeerClient({ hostname, entryPort, ca, isApproved }) {
  assert.match(hostname, /^[a-z2-7]{52}\.localhost$/)
  assert.ok(Number.isInteger(entryPort) && entryPort > 0)
  const origin = `https://${hostname}`
  const permitted = url => {
    assert.equal(isApproved(), true, 'peer is not approved')
    assert.equal(url.origin, origin, 'unapproved destination')
    assert.equal(url.username + url.password + url.hash, '', 'invalid destination')
  }
  const lookup = (name, opts, done) => {
    try {
      assert.equal(isApproved(), true, 'peer is not approved')
      assert.equal(name, hostname, 'unapproved hostname')
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
  const raw = safeFetchWrap({ fetch: (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    permitted(url)
    assert.equal(request.method, 'GET', 'peer route is read-only')
    assert.equal(request.redirect, 'error', 'peer redirects are refused')
    const path = decodeURIComponent(url.pathname)
    assert.ok(/^\/did:plc:[a-z2-7]{24}\/log$/.test(path) ||
      ['/xrpc/com.atproto.sync.getRepo', '/xrpc/com.atproto.sync.getBlob'].includes(path),
    'peer route is not allowed')
    // The exact route above is authoritative. Use our peer-scoped connector,
    // not safeFetchWrap's general DNS dispatcher; retain its size/time limits.
    return transportFetch(request.url, { method: request.method,
      headers: request.headers, signal: request.signal, redirect: request.redirect,
      dispatcher })
  } })
  const resolver = new IdResolver({ plcUrl: origin, didCache: new MemoryCache(),
    fetch: async (input, init) => {
      const url = new URL(input)
      permitted(url)
      const did = decodeURIComponent(url.pathname.slice(1))
      assert.match(did, /^did:plc:[a-z2-7]{24}$/)
      const response = await raw(new URL(`/${did}/log`, origin), init)
      if (!response.ok) return response
      const data = await validateOperationLog(did, await response.json())
      if (data === null) return new Response('', { status: 404 })
      assert.equal(data.services.atproto_pds?.endpoint, origin, 'identity belongs to another peer')
      return Response.json(formatDidDoc(data))
    } })
  // Private labels are self-asserted, not globally verified DNS handles.
  resolver.handle.resolve = async () => undefined
  return { origin, resolver, wsAgent,
    get: path => raw(new URL(path, origin), { redirect: 'error' }),
    async close() { wsAgent.destroy(); await dispatcher.close() } }
}
