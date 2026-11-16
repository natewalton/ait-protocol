import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createIdentityFetch } from '../dist/identityFetch.js'

test('only the configured PLC origin permits local identity requests; redirects and oversized responses fail', async t => {
  let otherRequests = 0
  const other = http.createServer((_req, res) => { otherRequests++; res.end('{}') })
  other.listen(0, '127.0.0.1'); await once(other, 'listening')
  const otherUrl = `http://127.0.0.1:${other.address().port}`
  let plcRequests = 0
  const plc = http.createServer((req, res) => {
    plcRequests++
    if (req.url === '/redirect') { res.writeHead(302, { location: otherUrl }); res.end(); return }
    if (req.url === '/large') { res.end('x'.repeat(600 * 1024)); return }
    res.setHeader('content-type', 'application/json'); res.end('{"id":"did:plc:fixture"}')
  })
  plc.listen(0, '127.0.0.1'); await once(plc, 'listening')
  const plcUrl = `http://127.0.0.1:${plc.address().port}`
  assert.ok(![2582, 2583, 2585].includes(plc.address().port))
  assert.ok(![2582, 2583, 2585].includes(other.address().port))
  t.after(async () => {
    for (const server of [plc, other]) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
  const fetch = createIdentityFetch(plcUrl)
  assert.deepEqual(await (await fetch(new URL('/did:plc:fixture', plcUrl), { redirect: 'error' })).json(), { id: 'did:plc:fixture' })
  await assert.rejects(fetch(otherUrl, { redirect: 'error' }))
  await assert.rejects(fetch(plcUrl + '/redirect', { redirect: 'follow' }))
  assert.equal(otherRequests, 0, 'unconfigured private origin must receive no request')
  await assert.rejects(async () => (await fetch(plcUrl + '/large', { redirect: 'error' })).text())
  assert.equal(plcRequests, 3)
})
