// Real main-stack journey: public MCP stdio tools -> PDS -> PLC/AppView -> client.
// All accounts, data, homes, ports and child processes belong to this fixture.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const script = fileURLToPath(import.meta.url)
const candidateIndex = process.argv.indexOf('--candidate')
const candidate = fs.realpathSync(candidateIndex < 0 ? path.resolve(path.dirname(script), '../..') : process.argv[candidateIndex + 1])
if (!process.argv.includes('--fixture-child')) {
  const [major, minor] = process.versions.node.split('.').map(Number)
  assert.ok(major > 22 || major === 22 && minor >= 19, 'Run with Node 22.19 or later')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-stack-test-'))
  let groupPid
  try {
    const result = spawnSync(process.execPath, ['--max-old-space-size=768', script, '--candidate', candidate, '--fixture-child', home], {
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_DATA_HOME: path.join(home, 'data'), LOG_ENABLED: 'false', NODE_ENV: 'test' },
      detached: true, encoding: 'utf8', timeout: 180000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    })
    groupPid = result.pid
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    assert.ifError(result.error)
    assert.equal(result.status, 0, `stack fixture failed (${result.signal ?? result.status})`)
  } finally {
    if (groupPid) { try { process.kill(-groupPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    fs.rmSync(home, { recursive: true, force: true })
    assert.ok(!fs.existsSync(home), 'owned fixture root was not removed')
  }
} else {
  await journey(process.argv.at(-1))
}

async function journey(home) {
  process.umask(0o077)
  assert.ok(fs.existsSync(path.join(candidate, 'appview/dist/localFeed.mjs')), 'This main-stack fixture requires the local feed; peer has its separate verified-link journey')
  const portsFile = path.join(home, 'allowed-ports.json')
  const ports = new Set()
  const allow = port => {
    assert.ok(Number.isInteger(port) && port > 0 && ![2582, 2583, 2585].includes(port), 'fixed/live service port forbidden')
    ports.add(port); fs.writeFileSync(portsFile, JSON.stringify([...ports]))
  }
  fs.writeFileSync(portsFile, '[]')
  const guard = path.join(home, 'network-guard.mjs')
  fs.writeFileSync(guard, `import assert from 'node:assert/strict';import fs from 'node:fs';import net from 'node:net';import tls from 'node:tls';import dgram from 'node:dgram';\nconst original=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const opts=typeof first==='object'?first:{port:first,host:args[1]};const host=opts.host??'localhost';assert.ok(['127.0.0.1','localhost','::1'].includes(host),'unowned network host: '+host);assert.ok(JSON.parse(fs.readFileSync(process.env.AIT_STACK_PORTS)).includes(Number(opts.port)),'unowned network port: '+opts.port);return original.apply(this,args)};tls.connect=()=>{throw Error('fixture forbids TLS/outbound network')};dgram.Socket.prototype.send=function(){throw Error('fixture forbids UDP/outbound network')};\n`)
  process.env.AIT_STACK_PORTS = portsFile
  await import(pathToFileURL(guard))
  const baseEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_DATA_HOME: path.join(home, 'data'), LOG_ENABLED: 'false', NODE_ENV: 'test', AIT_STACK_PORTS: portsFile }
  const requireAt = workspace => createRequire(path.join(candidate, workspace, 'package.json'))
  const plcRequire = requireAt('plc'), pdsRequire = requireAt('pds'), mcpRequire = requireAt('mcp')
  const { Database } = plcRequire('@did-plc/server')
  const { createPlcServer } = plcRequire(path.join(candidate, 'plc/launcher.js'))
  const { PDS, envToCfg, envToSecrets } = pdsRequire('@atproto/pds')
  const { Client } = mcpRequire('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js')
  const clients = [], children = []
  let plc, pds, appviewLog = ''
  const pass = label => console.log(`PASS ${label}`)
  const within = async (promise, label, ms = 20000) => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`timed out: ${label}\n${appviewLog.slice(-5000)}`)), ms) })]) }
    finally { clearTimeout(timer) }
  }
  const until = async (fn, label, ms = 20000) => {
    const end = Date.now() + ms
    do { if (await fn()) return; await delay(30) } while (Date.now() < end)
    throw Error(`timed out: ${label}\n${appviewLog.slice(-5000)}`)
  }
  const freePort = async () => {
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const port = server.address().port; await new Promise(resolve => server.close(resolve)); allow(port); return port
  }
  async function closeClient(s) {
    if (s.closed) return
    s.closed = true
    const pid = s.transport.pid
    try { await within(s.client.close(), 'MCP close', 8000) }
    catch (error) {
      if (pid) { try { process.kill(pid, 'SIGKILL') } catch (killError) { if (killError.code !== 'ESRCH') throw killError } }
      throw error
    }
  }
  async function stopChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    try { await within(once(child, 'exit'), 'owned AppView exit', 5000) }
    catch { child.kill('SIGKILL'); await within(once(child, 'exit'), 'owned AppView kill', 3000) }
  }
  try {
    const plcDb = Database.mock()
    plc = createPlcServer({ db: plcDb, port: 0 })
    const plcServer = await plc.start(); const plcPort = plcServer.address().port; allow(plcPort)
    assert.equal(plcServer.address().address, '127.0.0.1')
    const plcUrl = `http://127.0.0.1:${plcPort}`
    const pdsPort = await freePort(), appviewPort = await freePort()
    const pdsUrl = `http://127.0.0.1:${pdsPort}`, appviewUrl = `http://127.0.0.1:${appviewPort}`
    const appviewDid = 'did:plc:aitappview000000000001'
    const jwtSecret = randomBytes(32).toString('hex')
    const values = {
      port: pdsPort, hostname: 'pds.localhost', serviceDid: 'did:web:localhost', dataDirectory: path.join(home, 'pds'), blobstoreDiskLocation: path.join(home, 'pds/blobs'),
      didPlcUrl: plcUrl, inviteRequired: false, rateLimitsEnabled: false, serviceHandleDomains: ['.test'], crawlers: [],
      jwtSecret, adminPassword: randomBytes(32).toString('hex'), plcRotationKeyK256PrivateKeyHex: randomBytes(32).toString('hex'),
      bskyAppViewUrl: appviewUrl, bskyAppViewDid: appviewDid,
      // All data/network is owned and the process guard still refuses any other
      // destination. This permits the intentionally loopback fixture services.
      disableSsrfProtection: true,
    }
    fs.mkdirSync(values.dataDirectory)
    const cfg = envToCfg(values)
    pds = await PDS.create(cfg, envToSecrets(values))
    const listen = pds.app.listen.bind(pds.app)
    pds.app.listen = (port, ...args) => listen(port, '127.0.0.1', ...args)
    const pdsServer = await pds.start()
    const requests = []
    pdsServer.on('request', (req, res) => {
      const method = new URL(req.url, pdsUrl).pathname
      res.once('finish', () => requests.push({ method, status: res.statusCode }))
    })
    fs.mkdirSync(path.join(home, 'appview'))
    const appview = spawn(process.execPath, ['--max-old-space-size=256', '--import', guard, path.join(candidate, 'appview/dist/server.js')], {
      cwd: path.join(home, 'appview'), env: { ...baseEnv, APPVIEW_PORT: String(appviewPort), APPVIEW_DB_PATH: path.join(home, 'appview.sqlite'), APPVIEW_DID: appviewDid, APPVIEW_OPERATOR: '', APPVIEW_PDS_URL: pdsUrl, APPVIEW_PDS_WS_URL: pdsUrl.replace('http:', 'ws:'), APPVIEW_PLC_URL: plcUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(appview)
    for (const stream of [appview.stdout, appview.stderr]) stream.on('data', bytes => { appviewLog += bytes; assert.ok(appviewLog.length <= 1024 * 1024, 'AppView output exceeded fixture budget') })
    await until(async () => {
      assert.equal(appview.exitCode, null, appviewLog)
      try { const response = await fetch(`${appviewUrl}/xrpc/_health`, { signal: AbortSignal.timeout(1000) }); return response.status === 200 && (await response.json()).indexing.state === 'running' }
      catch (error) { if (error.code === 'ERR_ASSERTION') throw error; return false }
    }, 'actual AppView startup')
    pass('actual PLC, PDS and compiled AppView start on owned ports')

    async function startClient(label, mode, uuid = randomUUID()) {
      const directory = path.join(home, label); fs.mkdirSync(directory, { recursive: true })
      const transport = new StdioClientTransport({ command: process.execPath, args: ['--max-old-space-size=128', '--import', guard, path.join(candidate, 'mcp/dist/server.js')], cwd: directory,
        env: { ...baseEnv, HOME: directory, XDG_DATA_HOME: path.join(directory, 'data'), AIT_MCP_TEST_SESSION_ID: uuid, AIT_NOTIFICATION_MODE: mode, PDS_URL: pdsUrl, APPVIEW_URL: appviewUrl, APPVIEW_DID: appviewDid }, stderr: 'pipe' })
      const client = new Client({ name: `stack-${label}`, version: '0.0.0' })
      const s = { client, transport, uuid, directory, mode, notifications: [], stderr: '', closed: false }
      clients.push(s)
      client.fallbackNotificationHandler = async notification => { if (notification.method === 'notifications/claude/channel') s.notifications.push(notification.params) }
      transport.stderr?.on('data', bytes => {
        s.stderr += bytes; assert.ok(s.stderr.length <= 1024 * 1024, 'MCP output exceeded fixture budget')
        const match = s.stderr.match(/ait push listener: http:\/\/127\.0\.0\.1:(\d+)\/notify/)
        if (match) allow(Number(match[1]))
      })
      await within(client.connect(transport), `${label} MCP connect`)
      if (mode === 'push') await until(() => /ait push listener:/.test(s.stderr), `${label} push listener`)
      return s
    }
    const textOf = result => (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
    const raw = (s, name, args = {}) => within(s.client.callTool({ name, arguments: args }), `${name} tool`)
    const call = async (s, name, args = {}) => {
      const result = await raw(s, name, args); assert.ok(!result.isError, `${name}: ${textOf(result)}\n${s.stderr.slice(-1000)}`); return textOf(result)
    }
    const rejected = async (s, name, args) => {
      let failed = false
      try { failed = (await raw(s, name, args)).isError === true } catch { failed = true }
      assert.ok(failed, `${name} unexpectedly accepted invalid input`)
    }
    const alice = await startClient('alice', 'poll'), bob = await startClient('bob', 'push')
    for (const s of [alice, bob]) {
      const { tools } = await s.client.listTools()
      assert.equal(tools.length, 12)
      const timeline = tools.find(tool => tool.name === 'getTimeline').inputSchema
      assert.equal(timeline.properties.limit.maximum, 100); assert.equal(timeline.properties.limit.minimum, 1)
      assert.equal(timeline.properties.cursor.type, 'string')
      assert.equal(tools.find(tool => tool.name === 'post').inputSchema.properties.text.minLength, 1)
    }
    const aliceJoin = await call(alice, 'join', { handle_hint: 'stack-alice' })
    const bobJoin = await call(bob, 'join', { handle_hint: 'stack-bob' })
    const aliceDid = /DID: (did:plc:[a-z2-7]{24})/.exec(aliceJoin)?.[1], bobDid = /DID: (did:plc:[a-z2-7]{24})/.exec(bobJoin)?.[1]
    assert.ok(aliceDid && bobDid && aliceDid !== bobDid)
    await until(async () => (await call(alice, 'searchActors', { query: 'stack-' })).includes(bobDid), 'actual account indexing')
    await until(() => requests.some(req => req.method === '/xrpc/ait.notification.registerPushTarget' && req.status === 200), 'push target registration')
    pass('two actual MCP clients advertise argument schemas and join distinct PLC-backed accounts')
    await rejected(alice, 'getTimeline', { limit: 101 })
    await call(alice, 'getTimeline', { limit: 10 })
    pass('invalid tool arguments fail and the same MCP session remains usable')

    await call(alice, 'follow', { target: '@stack-bob' })
    const broadcast = await call(bob, 'post', { text: 'A broadcast from Bob after the stack migration' })
    const broadcastUri = /URI: (at:\/\/\S+)/.exec(broadcast)?.[1]; assert.ok(broadcastUri)
    await until(async () => (await call(alice, 'getTimeline')).includes(broadcastUri), 'followed broadcast timeline')
    pass('follow and post traverse the actual repository subscription into the follower timeline')
    const mention = await call(alice, 'post', { text: 'Hello @stack-bob from Alice through the upgraded stack' })
    const mentionUri = /URI: (at:\/\/\S+)/.exec(mention)?.[1]; assert.ok(mentionUri)
    await until(() => bob.notifications.some(n => n.meta?.uri === mentionUri || n.content?.includes(mentionUri)), 'real mention push')
    await until(async () => (await call(bob, 'listNotifications')).includes(mentionUri), 'mention notification read')
    const recordUrl = new URL(`${pdsUrl}/xrpc/com.atproto.repo.getRecord`)
    for (const [key, value] of Object.entries({ repo: aliceDid, collection: 'ait.feed.post', rkey: mentionUri.split('/').at(-1) })) recordUrl.searchParams.set(key, value)
    const storedMention = await (await fetch(recordUrl)).json()
    assert.equal(storedMention.value.facets[0].features[0].did, bobDid)
    pass('mention facet, indexed notification and real push delivery reach the other MCP session')
    const reply = await call(bob, 'reply', { parent_uri: mentionUri, text: 'Reply from Bob through the upgraded stack' })
    const replyUri = /URI: (at:\/\/\S+)/.exec(reply)?.[1]; assert.ok(replyUri)
    await until(async () => (await call(alice, 'getPostThread', { post_uri: mentionUri })).includes(replyUri), 'root/reply thread')
    await until(async () => (await call(alice, 'listNotifications')).includes(replyUri), 'reply notification')
    pass('reply references survive repository encoding and authenticated thread/notification reads')

    await call(alice, 'editProfile', { description: 'A migrated client profile Ω', displayName: 'Alice Stack' })
    await until(async () => (await call(bob, 'getProfile', { actor: '@stack-alice' })).includes('Alice Stack'), 'profile text projection')
    await call(alice, 'editProfile', { description: 'Updated bio preserves the avatar' })
    await until(async () => { const result = await call(bob, 'getProfile', { actor: aliceDid }); return result.includes('Updated bio preserves the avatar') && result.includes('Alice Stack') }, 'profile text merge')
    pass('profile text and read-modify-write fields survive the upstream generation')
    const countPosts = async () => (await (await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?repo=${aliceDid}&collection=ait.feed.post&limit=100`)).json()).records.length
    const before = await countPosts()
    await rejected(alice, 'post', { text: 'x'.repeat(1001) })
    await rejected(alice, 'editProfile', { description: 'x'.repeat(257) })
    assert.equal(await countPosts(), before, 'invalid record reached the PDS')
    assert.match(await call(alice, 'getProfile'), /Updated bio preserves the avatar/)
    pass('lexicon-invalid records are rejected before repository writes and subsequent reads still work')

    const identityPath = s => path.join(s.directory, 'data/ait-mcp', `identity-${createHash('sha256').update(s.uuid).digest('hex').slice(0, 16)}.json`)
    const keyFor = s => createHash('sha256').update(s.uuid + ':ait-mcp:v2').digest()
    const readIdentity = s => {
      const envelope = JSON.parse(fs.readFileSync(identityPath(s)))
      const decipher = createDecipheriv('aes-256-gcm', keyFor(s), Buffer.from(envelope.nonce, 'base64')); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      return { envelope, inner: JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()])) }
    }
    await closeClient(bob)
    const old = readIdentity(bob); assert.equal(old.envelope.did, bobDid)
    const [headerPart, payloadPart] = old.inner.accessJwt.split('.')
    assert.equal(JSON.parse(Buffer.from(headerPart, 'base64url')).alg, 'HS256')
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url')); claims.exp = Math.floor(Date.now() / 1000) - 120
    const unsigned = headerPart + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url')
    old.inner.accessJwt = unsigned + '.' + createHmac('sha256', jwtSecret).update(unsigned).digest('base64url')
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyFor(bob), nonce)
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(old.inner)), cipher.final()])
    fs.writeFileSync(identityPath(bob), JSON.stringify({ ...old.envelope, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }), { mode: 0o600 })
    const refreshBefore = requests.filter(req => req.method === '/xrpc/com.atproto.server.refreshSession').length
    const accountCount = (await pds.ctx.accountManager.db.db.selectFrom('actor').selectAll().execute()).length
    const resumed = await startClient('bob', 'push', bob.uuid)
    assert.match(await call(resumed, 'getProfile'), /stack-bob/)
    assert.ok(requests.filter(req => req.method === '/xrpc/com.atproto.server.refreshSession' && req.status === 200).length > refreshBefore, 'expired cached access JWT did not use the actual refresh route')
    const refreshed = readIdentity(resumed)
    assert.equal(refreshed.envelope.did, bobDid); assert.equal(refreshed.envelope.handle, old.envelope.handle)
    assert.notEqual(refreshed.inner.accessJwt, old.inner.accessJwt, 'refreshed tokens were not persisted')
    assert.ok(JSON.parse(Buffer.from(refreshed.inner.accessJwt.split('.')[1], 'base64url')).exp > Date.now() / 1000)
    const joinedAgain = await call(resumed, 'join', { handle_hint: 'must-not-mint' })
    assert.ok(joinedAgain.includes(bobDid) && joinedAgain.includes('Re-authenticated'))
    assert.equal((await pds.ctx.accountManager.db.db.selectFrom('actor').selectAll().execute()).length, accountCount)
    const resumedReply = await call(resumed, 'reply', { parent_uri: mentionUri, text: 'Bob is still the same account after MCP restart' })
    const resumedUri = /URI: (at:\/\/\S+)/.exec(resumedReply)[1]
    await until(async () => (await call(alice, 'listNotifications')).includes(resumedUri), 'resumed account reply')
    pass('MCP restart preserves identity, refreshes a genuinely expired JWT, persists tokens and resumes the same conversation')
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
    const avatar = path.join(home, 'avatar.png'); fs.writeFileSync(avatar, png)
    await call(alice, 'editProfile', { avatar })
    let profile
    await until(async () => { profile = await call(resumed, 'getProfile', { actor: '@stack-alice' }); return profile.includes('Alice Stack') && profile.includes('avatar:') }, 'profile projection')
    assert.match(profile, /Updated bio preserves the avatar/)
    const avatarUrl = /avatar: (\S+)/.exec(profile)[1]
    assert.equal(new URL(avatarUrl).origin, pdsUrl)
    const avatarResponse = await fetch(avatarUrl); assert.equal(avatarResponse.status, 200)
    assert.deepEqual(Buffer.from(await avatarResponse.arrayBuffer()), png)
    await call(alice, 'editProfile', { description: 'Updated bio preserves the avatar' })
    await until(async () => { const result = await call(resumed, 'getProfile', { actor: aliceDid }); return result.includes('Updated bio preserves the avatar') && result.includes(avatarUrl) && result.includes('Alice Stack') }, 'profile merge')
    pass('profile avatar BlobRef, byte content and read-modify-write fields survive the upstream generation')
    assert.equal(Object.keys(plcDb.contents).length, 2, 'fixture unexpectedly minted extra PLC identities')
    pass('real two-session main-stack collaboration completed without installed services or extra accounts')
  } finally {
    const failures = []
    for (const s of clients.reverse()) try { await closeClient(s) } catch (error) { failures.push(error) }
    for (const child of children.reverse()) try { await stopChild(child) } catch (error) { failures.push(error) }
    if (pds) try {
      for (const transport of [pds.ctx.mailer.transporter, pds.ctx.moderationMailer.transporter]) transport.close()
      await pds.ctx.didCache.destroy(); await pds.destroy(); await pds.ctx.didCache.db.db.destroy(); await pds.ctx.sequencer.db.db.destroy()
    } catch (error) { failures.push(error) }
    if (plc) try { await plc.destroy() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'owned stack fixture cleanup failed')
  }
}
