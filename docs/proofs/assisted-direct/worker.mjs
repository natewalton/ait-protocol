import readline from 'node:readline'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const pkg = createRequire(import.meta.url)(process.env.IROH_BINDING)
const { Endpoint, EndpointId, EndpointAddr, RelayMode, presetMinimal } = pkg
const [role, bindPort, relayUrl] = process.argv.slice(2)
const out = value => process.stdout.write(JSON.stringify(value) + '\n')
const builder = Endpoint.builder(); presetMinimal(builder)
builder.bindAddr(`127.0.0.1:${bindPort}`)
builder.alpns([[97,105,116,45,112,114,111,111,102]])
builder.relayMode(RelayMode.customFromUrls([relayUrl]))
if (process.env.IROH_POLICY === 'strict') builder.directApplicationDataOnly()
const endpoint = await builder.bind()
if (typeof endpoint.directApplicationDataOnly !== 'function' ||
    endpoint.directApplicationDataOnly() !== (process.env.IROH_POLICY === 'strict')) {
  await endpoint.close(); throw Error('effective native payload policy mismatch')
}
let connection, watcher
const received = []
function connected(c) {
  connection = c
  watcher = c.watchPaths((...args) => {
    const paths = args.find(Array.isArray)
    if (paths) out({ event: 'paths', connectionId: c.stableId(), paths })
    else out({ event: 'watchError', args })
  })
  out({ event: 'connected', connectionId: c.stableId(), paths: c.paths() })
  void (async () => {
    while (true) {
      const stream = await c.acceptUni()
      const data = Buffer.from(await stream.readToEnd(2 * 1024 * 1024))
      const item = { length: data.length, sha256: createHash('sha256').update(data).digest('hex') }
      received.push(item); out({ event: 'received', ...item })
    }
  })().catch(error => out({ event: 'receiverClosed', error: String(error) }))
  void (async () => {
    while (true) {
      const data = Buffer.from(await c.readDatagram())
      out({ event: 'datagramReceived', length: data.length, sha256: createHash('sha256').update(data).digest('hex') })
    }
  })().catch(() => {})
  void (async () => {
    while (true) {
      const stream = await c.acceptBi()
      const data = await stream.recv.readToEnd(2 * 1024 * 1024)
      await stream.send.writeAll(data); await stream.send.finish(); await stream.send.stopped()
    }
  })().catch(() => {})
}
if (role === 'server') void (async () => {
  while (!endpoint.isClosed()) {
    const incoming = await endpoint.acceptNext()
    if (!incoming) return
    connected(await (await incoming.accept()).connect())
  }
})().catch(error => out({ event: 'acceptClosed', error: String(error) }))
out({ event: 'ready', id: endpoint.id().toString(), addr: endpoint.addr().directAddresses() })
process.once('beforeExit', () => {
  const resources = process.getActiveResourcesInfo()
  if (resources.some(r => ['UDPWrap','TCPServerWrap','Timeout'].includes(r))) throw Error(`owned resources at exit: ${resources}`)
  out({event:'resourcesAtExit',resources,closed:endpoint.isClosed()})
})
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => { void (async () => {
  const request = JSON.parse(line)
  try {
    let value
    if (request.command === 'connect') {
      connected(await endpoint.connect(new EndpointAddr(EndpointId.fromString(request.peer), request.directOnly ? undefined : relayUrl,
        [`127.0.0.1:${request.proxyPort}`]), [97,105,116,45,112,114,111,111,102]))
      value = true
    } else if (request.command === 'advertise') { await endpoint.addExternalAddr(request.address); value = true }
    else if (request.command === 'removeRelay') value = await endpoint.removeRelay(relayUrl)
    else if (request.command === 'disconnect') {
      if (watcher) await watcher.stop()
      connection.close(0n, []); await connection.closed(); value = true
    }
    else if (request.command === 'send') {
      const stream = await connection.openUni()
      const data = Buffer.alloc(request.size, request.byte)
      await stream.writeAll([...data]); await stream.finish(); await stream.stopped()
      value = { length: data.length, sha256: createHash('sha256').update(data).digest('hex') }
    } else if (request.command === 'datagram') {
      const data = Buffer.alloc(1024, request.byte)
      await connection.sendDatagramWait([...data])
      value = { length: data.length, sha256: createHash('sha256').update(data).digest('hex') }
    } else if (request.command === 'bidirectional') {
      const data = Buffer.alloc(16384, 23), stream = await connection.openBi()
      await stream.send.writeAll([...data]); await stream.send.finish()
      const echoed = Buffer.from(await stream.recv.readToEnd(32768))
      if (!echoed.equals(data)) throw Error('bidirectional echo mismatch')
      value = { length: echoed.length, sha256: createHash('sha256').update(echoed).digest('hex') }
    } else if (request.command === 'snapshot') value = { connectionId: connection?.stableId(), closed: connection?.closeReason(), strict: endpoint.directApplicationDataOnly(), paths: connection?.paths(), stats: endpoint.stats(), received }
    else if (request.command === 'close') {
      if (watcher) await watcher.stop()
      if (connection) connection.close(0n, [])
      await endpoint.close(); lines.close(); value = { closed: endpoint.isClosed() }
    } else throw Error('unknown command')
    out({ response: request.id, value })
  } catch (error) { out({ response: request.id, error: String(error) }) }
})() })
