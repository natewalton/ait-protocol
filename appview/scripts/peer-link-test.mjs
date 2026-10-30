// One production-shaped local journey. No installed env, account, fixed port,
// host Postgres or harness session is read or changed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import { once, EventEmitter } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { parse } from 'dotenv'
import { AtpAgent } from '@atproto/api'
import { Endpoint, EndpointTicket, RelayMode, presetMinimal } from '@number0/iroh'
import { prepareInstallation, needsPreparation, installationPaths } from '../dist/peerPrepare.mjs'
import { localCommand } from '../dist/peerCli.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pdsRequire = createRequire(path.join(repo, 'pds/package.json'))
const plcRequire = createRequire(path.join(repo, 'plc/package.json'))
const { PDS, envToCfg, envToSecrets } = await import(pathToFileURL(pdsRequire.resolve('@atproto/pds')))
const { Database, PlcServer } = plcRequire('@did-plc/server')
const { registerAitLexicons, localPdsFetch } = await import(pathToFileURL(path.join(repo, 'mcp/dist/atproto/aitClient.js')))
const root = fs.mkdtempSync('/private/tmp/ait-link-'), instances = [], pgBin = '/opt/homebrew/opt/postgresql@17/bin'
const pgData = path.join(root, 'postgres'), outcomes = []
let postmasterPid, failure
const hash = value => createHash('sha256').update(value).digest('hex')
const report = check => { outcomes.push(check); console.log(`PASS ${check}`) }
const within = async (promise, label) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`timed out: ${label}`)), 20000) })]) }
  finally { clearTimeout(timer) }
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve))
  assert(![2582, 2583, 2585].includes(port)); return port
}
const envText = values => Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n'
async function startPds(s, values) {
  s.pds = await PDS.create(envToCfg(values), envToSecrets(values))
  const listen = s.pds.app.listen.bind(s.pds.app)
  s.pds.app.listen = (port, ...args) => listen(port, '127.0.0.1', ...args)
  const server = await s.pds.start(); s.pdsPort = server.address().port
  assert(![2582, 2583, 2585].includes(s.pdsPort)); s.url = `http://127.0.0.1:${s.pdsPort}`
}
async function stopPds(s) {
  if (!s.pds) return
  await s.pds.ctx.didCache.destroy(); await s.pds.destroy()
  await s.pds.ctx.didCache.db.db.destroy(); await s.pds.ctx.sequencer.db.db.destroy(); s.pds = undefined
}
async function fixture(name, pgPort) {
  const s = { name, repo: path.join(root, name), session: randomUUID(), push: [], events: new EventEmitter() }
  instances.push(s)
  for (const dir of ['plc', 'pds', 'appview', 'home', 'bin']) fs.mkdirSync(path.join(s.repo, dir), { recursive: true })
  for (const pkg of ['plc', 'pds', 'appview']) {
    fs.symlinkSync(path.join(repo, pkg, 'node_modules'), path.join(s.repo, pkg, 'node_modules'))
    fs.copyFileSync(path.join(repo, pkg, 'package.json'), path.join(s.repo, pkg, 'package.json'))
  }
  fs.symlinkSync(path.join(repo, 'appview/dist'), path.join(s.repo, 'appview/dist'))
  fs.copyFileSync(path.join(repo, 'ait'), path.join(s.repo, 'ait'))
  const databaseUrl = `postgres://ait_fixture@127.0.0.1:${pgPort}/${name}`
  execFileSync(`${pgBin}/createdb`, ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'ait_fixture', name])
  const database = Database.postgres({ url: databaseUrl }); await database.migrateToLatestOrThrow()
  s.plc = PlcServer.create({ db: database, port: 0 })
  const listen = s.plc.app.listen.bind(s.plc.app); s.plc.app.listen = (port, ...args) => listen(port, '127.0.0.1', ...args)
  s.plcPort = (await s.plc.start()).address().port
  fs.writeFileSync(path.join(s.repo, 'plc/.env'), envText({ DATABASE_URL: databaseUrl }))
  s.values = { port: 0, hostname: 'pds.localhost', serviceDid: 'did:web:pds.localhost',
    dataDirectory: path.join(s.repo, 'pds/.pds'), blobstoreDiskLocation: path.join(s.repo, 'pds/.pds/blobs'),
    didPlcUrl: `http://127.0.0.1:${s.plcPort}`, inviteRequired: false, rateLimitsEnabled: false,
    jwtSecret: randomBytes(32).toString('hex'), adminPassword: randomBytes(32).toString('hex'),
    plcRotationKeyK256PrivateKeyHex: randomBytes(32).toString('hex'), serviceHandleDomains: ['.test'],
    disableSsrfProtection: true, crawlers: [] }
  fs.mkdirSync(s.values.dataDirectory, { recursive: true })
  s.appviewPort = await freePort(); s.appviewUrl = `http://127.0.0.1:${s.appviewPort}`
  s.values.bskyAppViewUrl = s.appviewUrl; s.values.bskyAppViewDid = 'did:plc:aitappview000000000001'
  await startPds(s, s.values)
  const agent = new AtpAgent({ service: s.url, fetch: (input, init) => localPdsFetch(input, init, s.url) }); registerAitLexicons(agent)
  s.password = randomBytes(16).toString('hex')
  s.account = (await agent.createAccount({ handle: `${name}.test`, email: `${name}@example.com`, password: s.password })).data
  s.agent = agent
  s.env = {
    PDS_HOSTNAME: 'pds.localhost', PDS_PORT: 0, PDS_DATA_DIRECTORY: s.values.dataDirectory,
    PDS_BLOBSTORE_DISK_LOCATION: s.values.blobstoreDiskLocation, PDS_DID_PLC_URL: s.values.didPlcUrl,
    PDS_JWT_SECRET: s.values.jwtSecret, PDS_ADMIN_PASSWORD: s.values.adminPassword,
    PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: s.values.plcRotationKeyK256PrivateKeyHex,
    PDS_SERVICE_HANDLE_DOMAINS: '.test', PDS_DISABLE_SSRF_PROTECTION: true,
    PDS_BSKY_APP_VIEW_URL: s.appviewUrl, PDS_BSKY_APP_VIEW_DID: s.values.bskyAppViewDid,
    PDS_INVITE_REQUIRED: false, PDS_CRAWLERS: '',
  }
  fs.writeFileSync(path.join(s.repo, 'pds/.env'), envText(s.env), { mode: 0o600 })
  fs.writeFileSync(path.join(s.repo, 'appview/.env'), envText({ APPVIEW_DB_PATH: './data/appview.sqlite', APPVIEW_DID: s.values.bskyAppViewDid }))
  s.callback = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part)
    const body = JSON.parse(Buffer.concat(chunks).toString()); s.push.push(body); s.events.emit('push', body); res.end('ok')
  })
  s.callback.listen(0, '127.0.0.1'); await once(s.callback, 'listening')
  s.callbackUrl = `http://127.0.0.1:${s.callback.address().port}/push`
  return s
}
async function writeOldPost(s, target) {
  const record = { $type: 'ait.feed.post', text: `old ${s.name} history`, createdAt: new Date().toISOString(),
    facets: [{ index: { byteStart: 0, byteEnd: 3 }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: target.account.did }] }] }
  // Same lexicon gate as real MCP writes, before PDS's unknown ait.* schema.
  s.agent.lex.assertValidRecord('ait.feed.post', record)
  s.oldPost = (await s.agent.com.atproto.repo.createRecord({ repo: s.account.did, collection: 'ait.feed.post', record, validate: false })).data
  s.carHash = hash(Buffer.from((await s.agent.com.atproto.sync.getRepo({ did: s.account.did })).data))
}
async function startAppview(s) {
  const env = { PATH: process.env.PATH, HOME: path.join(s.repo, 'home'), LOG_ENABLED: 'false',
    APPVIEW_PORT: String(s.appviewPort), APPVIEW_PDS_URL: s.url, APPVIEW_PDS_WS_URL: s.url.replace('http:', 'ws:'),
    APPVIEW_PLC_URL: s.values.didPlcUrl }
  s.child = spawn(process.execPath, [path.join(repo, 'appview/dist/server.js')], { cwd: path.join(s.repo, 'appview'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  s.output = ''
  const capture = chunk => { s.output += chunk; fs.appendFileSync(path.join(s.repo, 'appview-output.log'), chunk) }
  s.child.stdout.on('data', chunk => { capture(chunk); s.events.emit('output') })
  s.child.stderr.on('data', capture)
  await within(new Promise((resolve, reject) => {
    const ready = () => { if (s.output.includes('appview listening')) { s.events.off('output', ready); resolve() } }
    s.events.on('output', ready); ready(); s.child.once('exit', code => reject(Error(`AppView exited ${code}: ${s.output}`)))
  }), `${s.name} AppView ready`)
  s.control = path.join(installationPaths(s.repo).directory, 'control.sock')
  await s.agent.call('ait.notification.registerPushTarget', undefined, { url: s.callbackUrl }, {
    encoding: 'application/json', headers: { 'atproto-proxy': `${s.values.bskyAppViewDid}#bsky_appview` },
  })
}
function notification(s, uri) {
  return within(new Promise(resolve => {
    const found = s.push.find(n => n.uri === uri); if (found) return resolve(found)
    const listen = n => { if (n.uri === uri) { s.events.off('push', listen); resolve(n) } }
    s.events.on('push', listen)
  }), `${s.name} notification ${uri}`)
}
async function tool(s, name, args) {
  const script = `const{setIdentity}=await import(${JSON.stringify(pathToFileURL(path.join(repo, 'mcp/dist/session.js')).href)});setIdentity(JSON.parse(process.env.FIXTURE_ID));const m=await import(${JSON.stringify(pathToFileURL(path.join(repo, `mcp/dist/tools/${name}.js`)).href)});const r=await m[${JSON.stringify(`${name}Handler`)}](JSON.parse(process.env.FIXTURE_ARGS));console.log(JSON.stringify(r));`
  const env = { PATH: process.env.PATH, HOME: path.join(s.repo, 'home'), XDG_DATA_HOME: path.join(s.repo, 'home/data'),
    AIT_SESSION_ID: s.session, PDS_URL: s.url, APPVIEW_URL: s.appviewUrl, APPVIEW_DID: s.values.bskyAppViewDid,
    FIXTURE_ID: JSON.stringify({ ...s.account, password: s.password }), FIXTURE_ARGS: JSON.stringify(args) }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, cwd: s.repo, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c }); child.stderr.on('data', c => { stderr += c })
    child.once('exit', code => code === 0 ? resolve(JSON.parse(stdout.trim().split('\n').at(-1))) : reject(Error(`MCP ${name}: ${code}: ${stderr}`)))
  })
}
async function publicLink(s, invitation = '') {
  const code = `set timeout 20\nspawn env -i PATH=$env(PATH) HOME=$env(FIXTURE_HOME) /bin/bash $env(FIXTURE_AIT) link $env(FIXTURE_INVITE)\n${invitation ? 'expect {\n  -exact {Link this computer? [y/N] } {send -- "yes\\r"}\n  eof {exit 91}\n  timeout {exit 90}\n}\n' : ''}expect eof\nset result [wait]\nexit [lindex $result 3]\n`
  const child = spawn('/usr/bin/expect', ['-c', code], { env: { PATH: process.env.PATH, FIXTURE_HOME: path.join(s.repo, 'home'), FIXTURE_AIT: path.join(s.repo, 'ait'), FIXTURE_INVITE: invitation }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', c => { output += c }); child.stderr.on('data', c => { output += c })
  const [status] = await within(once(child, 'exit'), 'public ait link confirmation')
  assert.equal(status, 0, output)
  if (invitation) assert.match(output, /"state":"Linked"/)
  else return /ait-link:[a-zA-Z0-9_-]+/.exec(output)[0]
}

async function unapprovedRead(invitation) {
  const ticket = JSON.parse(Buffer.from(invitation.slice(9), 'base64url'))
  const builder = Endpoint.builder(); presetMinimal(builder)
  builder.bindAddr('0.0.0.0:0'); builder.alpns([[...Buffer.from('ait-atproto/1')]])
  builder.relayMode(RelayMode.disabled())
  const endpoint = await builder.bind()
  let connection, received = new Uint8Array()
  try {
    connection = await endpoint.connect(EndpointTicket.fromString(ticket.ticket).endpointAddr(), [...Buffer.from('ait-atproto/1')])
    // Knowing the address/ticket is not approval. No secret is redeemed here.
    try {
      const stream = await connection.openBi()
      await stream.send.writeAll([...Buffer.from('GET /xrpc/com.atproto.sync.listRepos HTTP/1.1\r\n\r\n')])
      received = await stream.recv.read(4096)
    } catch (error) { assert(error, 'unapproved stream must close') }
    const reason = await within(connection.closed(), 'unapproved native connection refused')
    assert.match(reason, /ApplicationClosed|closed by peer/i, 'must observe an explicit peer refusal, not a network timeout')
    assert.equal(received.length, 0, 'unapproved endpoint received application bytes')
  } finally { connection?.close(0n, []); await endpoint.close() }
}

try {
  execFileSync(`${pgBin}/initdb`, ['-D', pgData, '-U', 'ait_fixture', '--auth-local=trust', '--auth-host=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'ignore' })
  const pgPort = await freePort()
  execFileSync(`${pgBin}/pg_ctl`, ['-D', pgData, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${pgPort} -c unix_socket_directories=''`, '-w', 'start'], { stdio: 'ignore' })
  postmasterPid = Number(fs.readFileSync(path.join(pgData, 'postmaster.pid'), 'utf8').split('\n')[0])
  const a = await fixture('alice', pgPort), b = await fixture('bobby', pgPort)
  await writeOldPost(a, b); await writeOldPost(b, a)
  for (const s of instances) {
    await stopPds(s); assert(needsPreparation(s.repo)); await prepareInstallation(s.repo)
    assert(!needsPreparation(s.repo)); await prepareInstallation(s.repo)
    const env = parse(fs.readFileSync(path.join(s.repo, 'pds/.env')))
    assert.match(env.PDS_SERVICE_HANDLE_DOMAINS, /^\.[a-z2-7]{52}\.aitproto\.com$/)
    await startPds(s, { ...s.values, hostname: env.PDS_HOSTNAME, serviceDid: env.PDS_SERVICE_DID, serviceHandleDomains: [env.PDS_SERVICE_HANDLE_DOMAINS] })
    s.agent = new AtpAgent({ service: s.url, fetch: (input, init) => localPdsFetch(input, init, s.url) }); registerAitLexicons(s.agent); await s.agent.resumeSession(s.account)
    assert.equal((await s.agent.com.atproto.server.getSession()).data.did, s.account.did)
    const refreshed = await s.agent.com.atproto.server.refreshSession(undefined, { headers: { authorization: `Bearer ${s.account.refreshJwt}` } })
    assert.equal(refreshed.data.did, s.account.did); assert.match(refreshed.data.handle, /\.aitproto\.com$/)
    assert.equal(hash(Buffer.from((await s.agent.com.atproto.sync.getRepo({ did: s.account.did })).data)), s.carHash)
    await startAppview(s)
  }
  report('existing actors prepared idempotently; DIDs, repository bytes and old token audiences preserved; new private handles')
  const invitation = await publicLink(a)
  await unapprovedRead(invitation)
  await publicLink(b, invitation)
  await Promise.all([notification(a, b.oldPost.uri), notification(b, a.oldPost.uri)])
  await assert.rejects(localCommand(b.control, 'link', { invitation }))
  report('public Link confirmation creates approved direct streams; old history replays and invitation reuse fails')
  const directory = await tool(a, 'searchActors', { query: 'bobby' })
  assert.match(directory.content[0].text, new RegExp(b.account.did)); assert(!directory.content[0].text.includes('.test'))
  await tool(a, 'follow', { target: 'bobby' })
  const posted = await tool(a, 'post', { text: 'hello @bobby from a direct peer' })
  const postUri = /URI: (\S+)/.exec(posted.content[0].text)[1]
  await notification(b, postUri)
  const replied = await tool(b, 'reply', { parent_uri: postUri, text: 'reply to @alice through local PDS getRecord' })
  const replyUri = /URI: (\S+)/.exec(replied.content[0].text)[1]
  await notification(a, replyUri)
  const thread = await tool(a, 'getPostThread', { post_uri: postUri })
  assert.match(thread.content[0].text, new RegExp(replyUri))
  const record = (await b.agent.com.atproto.repo.getRecord({ repo: a.account.did, collection: 'ait.feed.post', rkey: postUri.split('/').at(-1) })).data
  assert.equal(record.uri, postUri); assert.equal(record.value.facets[0].features[0].did, b.account.did)
  await assert.rejects(b.agent.com.atproto.repo.getRecord({ repo: a.account.did, collection: 'ait.feed.post', rkey: postUri.split('/').at(-1), cid: b.oldPost.cid }))
  report('existing MCP discovery/follow/post/reply/thread and local-PDS reply lookup agree on original DIDs/CIDs; callbacks delivered')
  const before = a.push.length, key = (await localCommand(a.control, 'status')).peers[0].id
  assert.equal((await localCommand(a.control, 'unlink', { id: key })).state, 'Unlinked')
  assert.equal((await localCommand(a.control, 'status')).peers.length, 0)
  await publicLink(b, await publicLink(a))
  // A new notification is an event barrier behind replay, not a timing sleep.
  const barrier = await tool(b, 'post', { text: 'after relink @alice' })
  await notification(a, /URI: (\S+)/.exec(barrier.content[0].text)[1])
  assert.equal(a.push.length, before + 1)
  report('Unlink closes approved access; relink/replay does not duplicate notifications')
} catch (error) { failure = error; console.error(error) }
finally {
  for (const s of instances) {
    if (s.child && s.child.exitCode === null) {
      s.child.kill('SIGTERM')
      try { await within(once(s.child, 'exit'), 'owned AppView close') } catch (error) { failure ??= error }
    }
    try { await stopPds(s); await s.plc?.destroy() } catch (error) { failure ??= error }
    if (s.callback) await new Promise(resolve => s.callback.close(resolve))
    if (failure) fs.writeFileSync(path.join(s.repo, 'appview-output.log'), s.output || '')
  }
  if (postmasterPid) {
    assert.equal(Number(fs.readFileSync(path.join(pgData, 'postmaster.pid'), 'utf8').split('\n')[0]), postmasterPid)
    execFileSync(`${pgBin}/pg_ctl`, ['-D', pgData, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' })
  }
}
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ root, outcomes, failure: failure?.stack, liveTouched: false }, null, 2))
console.log(JSON.stringify({ root, outcomes: outcomes.length, failure: failure?.message }))
if (failure) process.exitCode = 1
