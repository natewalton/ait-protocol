// One production-shaped local journey. No installed env, account, fixed port,
// host Postgres or harness session is read or changed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import dgram from 'node:dgram'
import tls from 'node:tls'
import { Duplex } from 'node:stream'
import { once, EventEmitter } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { parse } from 'dotenv'
import { AtpAgent } from '@atproto/api'
import { Endpoint, EndpointTicket, RelayMode, presetMinimal } from '@natewalton/iroh-direct'
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
let postmasterPid, failure, relay, proxy, secondProxy, relayUrl, gateOpen = false
const hash = value => createHash('sha256').update(value).digest('hex')
const report = check => { outcomes.push(check); console.log(`PASS ${check}`) }
const within = async (promise, label, ms = 20000) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`timed out: ${label}`)), ms) })]) }
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
  s.upgradeHeaders = []
  server.on('upgrade', req => { s.upgradeHeaders.push({ ...req.headers }) })
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
  fs.copyFileSync(path.join(repo, 'bin/run-appview.sh'), path.join(s.repo, 'bin/run-appview.sh'))
  const databaseUrl = `postgres://ait_fixture@127.0.0.1:${pgPort}/${name}`
  execFileSync(`${pgBin}/createdb`, ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'ait_fixture', name])
  const database = Database.postgres({ url: databaseUrl }); await database.migrateToLatestOrThrow()
  s.plc = PlcServer.create({ db: database, port: 0 })
  const listen = s.plc.app.listen.bind(s.plc.app); s.plc.app.listen = (port, ...args) => listen(port, '127.0.0.1', ...args)
  const plcHttp = await s.plc.start(); s.plcPort = plcHttp.address().port
  s.plcDocReads = 0
  plcHttp.on('request', req => {
    if (/^\/did:plc:[a-z2-7]{24}$/.test(decodeURIComponent(new URL(req.url, 'http://fixture').pathname))) s.plcDocReads++
  })
  fs.writeFileSync(path.join(s.repo, 'plc/.env'), envText({ DATABASE_URL: databaseUrl }))
  s.values = { port: 0, hostname: 'pds.localhost', serviceDid: 'did:web:pds.localhost',
    dataDirectory: path.join(s.repo, 'pds/.pds'), blobstoreDiskLocation: path.join(s.repo, 'pds/.pds/blobs'),
    didPlcUrl: `http://127.0.0.1:${s.plcPort}`, inviteRequired: false, rateLimitsEnabled: false,
    jwtSecret: randomBytes(32).toString('hex'), adminPassword: randomBytes(32).toString('hex'),
    plcRotationKeyK256PrivateKeyHex: randomBytes(32).toString('hex'), serviceHandleDomains: ['.test', '.watcher.example.com'],
    disableSsrfProtection: true, crawlers: [] }
  fs.mkdirSync(s.values.dataDirectory, { recursive: true })
  s.appviewPort = await freePort(); s.appviewUrl = `http://127.0.0.1:${s.appviewPort}`
  s.values.bskyAppViewUrl = s.appviewUrl; s.values.bskyAppViewDid = 'did:plc:aitappview000000000001'
  await startPds(s, s.values)
  const agent = new AtpAgent({ service: s.url, fetch: (input, init) => localPdsFetch(input, init, s.url) }); registerAitLexicons(agent)
  s.password = randomBytes(16).toString('hex')
  s.account = (await agent.createAccount({ handle: `${name}.test`, email: `${name}@example.com`, password: s.password })).data
  s.agent = agent
  s.watcherAgent = new AtpAgent({ service: s.url, fetch: (input, init) => localPdsFetch(input, init, s.url) })
  registerAitLexicons(s.watcherAgent)
  s.watcher = (await s.watcherAgent.createAccount({ handle: 'terminal-observer.watcher.example.com',
    email: 'watcher@example.com', password: s.password })).data
  s.env = {
    PDS_HOSTNAME: 'pds.localhost', PDS_PORT: 0, PDS_DATA_DIRECTORY: s.values.dataDirectory,
    PDS_BLOBSTORE_DISK_LOCATION: s.values.blobstoreDiskLocation, PDS_DID_PLC_URL: s.values.didPlcUrl,
    PDS_JWT_SECRET: s.values.jwtSecret, PDS_ADMIN_PASSWORD: s.values.adminPassword,
    PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: s.values.plcRotationKeyK256PrivateKeyHex,
    PDS_SERVICE_HANDLE_DOMAINS: '.test,.watcher.example.com', PDS_DISABLE_SSRF_PROTECTION: true,
    PDS_BSKY_APP_VIEW_URL: s.appviewUrl, PDS_BSKY_APP_VIEW_DID: s.values.bskyAppViewDid,
    PDS_INVITE_REQUIRED: false, PDS_CRAWLERS: '',
  }
  fs.writeFileSync(path.join(s.repo, 'pds/.env'), envText(s.env), { mode: 0o600 })
  fs.writeFileSync(path.join(s.repo, 'appview/.env'), envText({ APPVIEW_DB_PATH: './data/appview.sqlite', APPVIEW_DID: s.values.bskyAppViewDid, APPVIEW_OPERATOR: 'terminal-observer.watcher.example.com' }))
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
    APPVIEW_PLC_URL: s.values.didPlcUrl, APPVIEW_PEER_RELAY: s.peerOptions?.assistanceRelay ?? '' }
  if (s.legacyOperator) env.APPVIEW_OPERATOR = 'terminal-observer.test'
  s.launchEnv = env
  if (s.peerOptions) {
    const profile = `(version 1)(allow default)(deny network*)(allow network-bind (local ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote tcp "localhost:*"))(allow network-outbound (remote udp "localhost:${s.proxyPort}"))(allow network-bind (local unix-socket (regex #"^${root}/")))(allow network-inbound (local unix-socket (regex #"^${root}/")))(allow network-outbound (remote unix-socket (regex #"^${root}/")))`
    const serverFile = s.serverFile ?? path.join(repo,'appview/dist/server.js')
    const setup = s.policyOff ? `import {createRequire} from 'node:module';createRequire(${JSON.stringify(serverFile)})('@natewalton/iroh-direct').EndpointBuilder.prototype.directApplicationDataOnly=function(){};` : ''
    const { assistanceRelay, ...options } = s.peerOptions
    const source = `${setup}const {main}=await import(${JSON.stringify(pathToFileURL(serverFile).href)}); await main(${JSON.stringify(options)})`
    s.child = spawn('sandbox-exec', ['-p', profile, process.execPath, '--input-type=module', '-e', source], { cwd: path.join(s.repo, 'appview'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  } else {
    // Exercise the real wrapper and the realpath direct-execution guard.
    s.child = process.env.IROH_RELAY_BIN ? spawn('sandbox-exec', ['-f', path.join(repo,'appview/scripts/peer-loopback.sb'), '/bin/bash', path.join(s.repo, 'bin/run-appview.sh')], { cwd: s.repo, env, stdio: ['ignore', 'pipe', 'pipe'] }) : spawn('/bin/bash', [path.join(s.repo,'bin/run-appview.sh')], { cwd:s.repo,env,stdio:['ignore','pipe','pipe'] })
  }
  s.output = ''
  const capture = chunk => { s.output += chunk; fs.appendFileSync(path.join(s.repo, 'appview-output.log'), chunk) }
  s.child.stdout.on('data', chunk => { capture(chunk); s.events.emit('output') })
  s.child.stderr.on('data', chunk => { capture(chunk); s.events.emit('output') })
  await within(new Promise((resolve, reject) => {
    const ready = () => { if (s.output.includes('appview listening')) { s.events.off('output', ready); resolve() } }
    s.events.on('output', ready); ready(); s.child.once('exit', code => reject(Error(`AppView exited ${code}: ${s.output}`)))
  }), `${s.name} AppView ready`)
  await within((async () => {
    while (true) {
      const response = await fetch(`${s.appviewUrl}/xrpc/_health`)
      const health = await response.json()
      if (response.ok) { assert.equal(health.indexing.state, 'running'); return }
      assert.equal(health.status, 'starting', JSON.stringify(health))
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })(), `${s.name} initial local backfill`)
  s.control = path.join(installationPaths(s.repo).directory, 'control.sock')
  if (!s.skipRegistration) await s.agent.call('ait.notification.registerPushTarget', undefined, { url: s.callbackUrl }, {
    encoding: 'application/json', headers: { 'atproto-proxy': `${s.values.bskyAppViewDid}#bsky_appview` },
  })
}
function notification(s, uri, ms = 20000) {
  return within(new Promise(resolve => {
    const found = s.push.find(n => n.uri === uri); if (found) return resolve(found)
    const listen = n => { if (n.uri === uri) { s.events.off('push', listen); resolve(n) } }
    s.events.on('push', listen)
  }), `${s.name} notification ${uri}`, ms)
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
async function publicLink(s, invitation = '', options = {}) {
  const interrupt = options.interrupt ? 'expect -exact {Connecting directly…}\nsend -- "\\003"\n' : ''
  const code = `set timeout 40\nspawn env -i PATH=$env(PATH) HOME=$env(FIXTURE_HOME) /bin/bash $env(FIXTURE_AIT) link $env(FIXTURE_INVITE)\n${invitation ? 'expect {\n  -exact {Link this computer? [y/N] } {send -- "yes\\r"}\n  eof {exit 91}\n  timeout {exit 90}\n}\n' : ''}${interrupt}expect eof\nset result [wait]\nexit [lindex $result 3]\n`
  const child = spawn('/usr/bin/expect', ['-c', code], { env: { PATH: process.env.PATH, FIXTURE_HOME: path.join(s.repo, 'home'), FIXTURE_AIT: path.join(s.repo, 'ait'), FIXTURE_INVITE: invitation }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', c => { output += c; if (options.openDirect && output.includes('Connecting directly…')) gateOpen = true })
  child.stderr.on('data', c => { output += c })
  const [status] = await within(once(child, 'exit'), 'public ait link confirmation', 45000)
  assert.equal(status, options.status ?? 0, output)
  if (options.status) { assert.match(output, options.interrupt ? /Link cancelled/ : /Unavailable: could not establish a direct connection/); return }
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

// An approved but adversarial peer controls its HTTP bytes, not the gateway's
// destination or forwarded credentials. Use real native auth and verified TLS.
async function peerRequest(from, to, invitation, request, complete = false) {
  const saved = JSON.parse(fs.readFileSync(path.join(installationPaths(from.repo).directory, 'machine.json')))
  const ticket = JSON.parse(Buffer.from(invitation.slice(9), 'base64url'))
  const builder = Endpoint.builder(); presetMinimal(builder)
  builder.secretKey([...Buffer.from(saved.secret, 'hex')]); builder.bindAddr('0.0.0.0:0')
  builder.relayMode(RelayMode.disabled()); builder.alpns([[...Buffer.from('ait-atproto/1')]])
  const endpoint = await builder.bind()
  let connection, secure
  try {
    connection = await endpoint.connect(EndpointTicket.fromString(ticket.ticket).endpointAddr(), [...Buffer.from('ait-atproto/1')])
    const stream = await connection.openBi()
    const transport = new Duplex({
      read() { stream.recv.read(65536).then(bytes => this.push(bytes.length ? Buffer.from(bytes) : null), error => this.destroy(error)) },
      write(chunk, _, done) { stream.send.writeAll([...chunk]).then(() => done(), done) },
      final(done) { stream.send.finish().then(() => done(), done) },
    })
    const values = parse(fs.readFileSync(path.join(to.repo, 'pds/.env')))
    secure = tls.connect({ socket: transport, servername: values.PDS_HOSTNAME,
      ca: fs.readFileSync(path.join(installationPaths(to.repo).directory, 'ca.pem')) })
    await within(once(secure, 'secureConnect'), 'adversarial peer TLS')
    let response = ''
    const result = new Promise((resolve, reject) => {
      secure.on('data', part => { response += part; if (!complete && response.includes('\r\n\r\n')) resolve(response) })
      secure.once('end', () => resolve(response)); secure.once('error', reject)
    })
    secure.write(request)
    return await within(result, 'adversarial peer request')
  } finally { secure?.destroy(); connection?.close(0n, []); await endpoint.close() }
}

async function policyRefusals(local) {
    if (!fs.existsSync(path.join(root,'lexicons'))) fs.symlinkSync(path.join(repo,'lexicons'),path.join(root,'lexicons'))
    if (local) {
      const exited=once(local.child,'exit');local.child.kill('SIGTERM');await within(exited,'normal peer server stop')
    }
    assert(process.env.IROH_STOCK_BINDING, 'explicit stock binding needed for refusal control')
    for (const mode of ['stock', 'off']) {
      const directory = path.join(root, `refusal-${mode}`)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory,'package.json'), JSON.stringify({type:'module'}))
      fs.cpSync(path.join(repo,'appview/dist'),path.join(directory,'dist'),{recursive:true})
      const modules = path.join(directory,'node_modules');fs.mkdirSync(modules)
      for (const entry of fs.readdirSync(path.join(repo,'appview/node_modules'))) {
        if (entry !== '@natewalton') fs.symlinkSync(path.join(repo,'appview/node_modules',entry),path.join(modules,entry))
        else {
          const scope=path.join(modules,entry);fs.mkdirSync(scope)
          for (const name of fs.readdirSync(path.join(repo,'appview/node_modules',entry))) {
            fs.symlinkSync(name==='iroh-direct' && mode==='stock' ? path.dirname(process.env.IROH_STOCK_BINDING) : path.join(repo,'appview/node_modules',entry,name),path.join(scope,name))
          }
        }
      }
      const script = `import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(path.join(directory,'package.json'))});const binding=require('@natewalton/iroh-direct');if(${JSON.stringify(mode)}==='off') binding.EndpointBuilder.prototype.directApplicationDataOnly=function(){};const {startPeerNetwork}=await import(${JSON.stringify(pathToFileURL(path.join(directory,'dist/peerNetwork.mjs')).href)});await assert.rejects(startPeerNetwork({directory:${JSON.stringify(path.join(directory,'peers'))},bindAddress:'127.0.0.1:0'}),/cannot confirm direct-only application data/);assert(!fs.existsSync(${JSON.stringify(path.join(directory,'peers/control.sock'))}));assert(!process.getActiveResourcesInfo().some(x=>['UDPWrap','TCPServerWrap'].includes(x)));console.log('refused')`
      const child = spawn('sandbox-exec', ['-f',path.join(repo,'appview/scripts/peer-loopback.sb'),process.execPath,'--input-type=module','-e',script], { env: { PATH: process.env.PATH, HOME: path.join(root,'refusal-home') }, stdio: ['ignore','pipe','pipe'] })
      let output = '';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c)
      assert.equal((await within(once(child,'exit'),'native policy refusal'))[0],0,output)
      assert.match(output,/refused/)
      if (local) {
        local.serverFile = path.join(directory,'dist/server.js')
        local.policyOff = mode === 'off'
        await startAppview(local)
        assert.match(local.output,/cannot confirm direct-only application data/)
        await assert.rejects(localCommand(local.control,'status'))
        assert.match((await tool(local,'getProfile',{actor:local.account.did})).content[0].text,new RegExp(local.name))
        assert.match((await tool(local,'getAuthorFeed',{actor:local.account.did})).content[0].text,/old alice history/)
        assert(!(await tool(local,'getTimeline',{})).isError)
        const localPost=await tool(local,'post',{text:`local-only post with ${mode} peer policy unavailable`})
        assert.match(localPost.content[0].text,/URI: at:\/\//)
        const exited=once(local.child,'exit');local.child.kill('SIGTERM');await within(exited,'local-only server stop')
      }
    }
    report(local ? 'stock and policy-off refuse peer startup while real AppView serves authenticated local reads/writes' : 'stock binding and fork-policy-off both refuse before peer startup; constructed endpoints close')
  }



async function defaultAssistance(s) {
  const serverFile = path.join(repo, 'appview/dist/server.js')
  const hook = path.join(root, 'default-relay-hook.mjs')
  const replacement = `import assert from 'node:assert/strict';export const stateDirectory=()=>'';export async function startPeerNetwork(options){assert.equal(options.assistanceRelay,'https://use1-1.relay.n0.iroh.link./');console.log('DEFAULT_ASSISTANCE_VERIFIED');process.exit(0)}`
  fs.writeFileSync(hook, `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='./peerNetwork.mjs'&&context.parentURL===${JSON.stringify(pathToFileURL(serverFile).href)})return {url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(replacement))},shortCircuit:true};return next(specifier,context)}})`)
  const env = { ...s.launchEnv, APPVIEW_DB_PATH: path.join(root, 'default-relay.sqlite'), NODE_OPTIONS: `--import=${hook}` }
  delete env.APPVIEW_PEER_RELAY
  const child = spawn('sandbox-exec', ['-f', path.join(repo,'appview/scripts/peer-loopback.sb'), '/bin/bash', path.join(s.repo,'bin/run-appview.sh')], { cwd: s.repo, env, stdio:['ignore','pipe','pipe'] })
  let output = ''
  child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c)
  assert.equal((await within(once(child,'exit'),'unset relay default'))[0], 0, output)
  assert.match(output, /(?:^|\n)DEFAULT_ASSISTANCE_VERIFIED\r?\n/)
  report('real launch wrapper selects explicit n0 assistance when relay env is unset; captured before network construction')
}

async function connectBound() {
  const { startPeerNetwork } = await import('../dist/peerNetwork.mjs')
  const { IdResolver } = await import('@atproto/identity')
  const { default: Sqlite } = await import('better-sqlite3')
  const db = new Sqlite(':memory:')
  const directory = path.join(root,'connect-bound')
  const network = await startPeerNetwork({ directory,db,pdsUrl:'http://127.0.0.1:9',plcUrl:'http://127.0.0.1:9',
    localResolver:new IdResolver({plcUrl:'http://127.0.0.1:9'}),accountFile:path.join(root,'no-account'),bindAddress:'127.0.0.1:0' })
  const builder=Endpoint.builder();presetMinimal(builder);builder.directApplicationDataOnly()
  const alpn=[...Buffer.from('ait-link/1')];builder.alpns([alpn]);builder.bindAddr('127.0.0.1:0')
  const target=await builder.bind(), original=Endpoint.prototype.connect
  const invitation=`ait-link:${Buffer.from(JSON.stringify({version:1,ticket:EndpointTicket.fromAddr(target.addr()).toString(),name:'late native connect',secret:randomBytes(32).toString('hex'),expires:Date.now()+600000})).toString('base64url')}`
  try {
    for (const cancel of [true,false]) {
      const [hidden,remote]=await Promise.all([original.call(network.endpoint,target.addr(),alpn),
        (async()=>await (await (await target.acceptNext()).accept()).connect())()])
      const noPairingBytes=remote.acceptBi().then(()=>{throw Error('late connect started pairing')},()=>{})
      let release
      Endpoint.prototype.connect=function(){return new Promise(resolve=>{release=resolve})}
      try {
        const abort=new AbortController(), start=performance.now()
        const command=network.command('link',{invitation},abort.signal)
        if(cancel) abort.abort()
        await assert.rejects(within(command,'pending native connect bound',cancel?1000:35000),cancel?/Link cancelled/:/Unavailable: could not establish a direct connection/)
        if(!cancel) assert(performance.now()-start>=29000,'deadline was not exercised')
        assert.equal((await network.command('status')).peers.length,0)
        release(hidden)
        await within(hidden.closed(),'late native connection closes',2000)
        await within(noPairingBytes,'late connect sends no pairing stream',2000)
      } finally {
        Endpoint.prototype.connect=original;release?.(hidden);hidden.close(0n,[]);remote.close(0n,[])
      }
    }
    report('pending native connect cannot hold cancellation/deadline; late real connections close without pairing')
  } finally { Endpoint.prototype.connect=original;await target.close();await network.close();db.close() }
}


try {
  if (process.argv.includes('--policy-controls')) await policyRefusals()
  else if (process.argv.includes('--connect-bound')) await connectBound()
  else {
  execFileSync(`${pgBin}/initdb`, ['-D', pgData, '-U', 'ait_fixture', '--auth-local=trust', '--auth-host=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'ignore' })
  const pgPort = await freePort()
  execFileSync(`${pgBin}/pg_ctl`, ['-D', pgData, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${pgPort} -c unix_socket_directories=''`, '-w', 'start'], { stdio: 'ignore' })
  postmasterPid = Number(fs.readFileSync(path.join(pgData, 'postmaster.pid'), 'utf8').split('\n')[0])
  const a = await fixture('alice', pgPort), b = await fixture('bobby', pgPort)
  await writeOldPost(a, b); await writeOldPost(b, a)
  for (const s of instances) {
    await stopPds(s); assert(needsPreparation(s.repo))
    if (s === a) {
      // Throw after a real successful account rename, then recover using only
      // the durable operator setting. No production test hook or state marker.
      const realFetch = globalThis.fetch
      let renamed = false
      globalThis.fetch = async (input, init) => {
        const response = await realFetch(input, init)
        if (!renamed && String(input).endsWith('/xrpc/com.atproto.admin.updateAccountHandle') && response.ok) {
          renamed = true
          throw Error('fixture crash after first namespace rename')
        }
        return response
      }
      try { await assert.rejects(prepareInstallation(s.repo), /fixture crash after first namespace rename/) }
      finally { globalThis.fetch = realFetch }
      assert(renamed)
      assert.equal(parse(fs.readFileSync(path.join(s.repo, 'appview/.env'))).APPVIEW_OPERATOR, s.watcher.did)
    }
    await prepareInstallation(s.repo)
    assert(!needsPreparation(s.repo)); await prepareInstallation(s.repo)
    const env = parse(fs.readFileSync(path.join(s.repo, 'pds/.env')))
    assert.match(env.PDS_SERVICE_HANDLE_DOMAINS, /^\.[a-z2-7]{52}\.aitproto\.com$/)
    await startPds(s, { ...s.values, hostname: env.PDS_HOSTNAME, serviceDid: env.PDS_SERVICE_DID, serviceHandleDomains: [env.PDS_SERVICE_HANDLE_DOMAINS] })
    s.agent = new AtpAgent({ service: s.url, fetch: (input, init) => localPdsFetch(input, init, s.url) }); registerAitLexicons(s.agent); await s.agent.resumeSession(s.account)
    s.watcherAgent = new AtpAgent({ service: s.url, fetch: (input, init) => localPdsFetch(input, init, s.url) })
    registerAitLexicons(s.watcherAgent)
    await s.watcherAgent.login({ identifier: s.watcher.did, password: s.password })
    assert.equal((await s.agent.com.atproto.server.getSession()).data.did, s.account.did)
    const refreshed = await s.agent.com.atproto.server.refreshSession(undefined, { headers: { authorization: `Bearer ${s.account.refreshJwt}` } })
    assert.equal(refreshed.data.did, s.account.did); assert.match(refreshed.data.handle, /\.aitproto\.com$/)
    assert.equal(hash(Buffer.from((await s.agent.com.atproto.sync.getRepo({ did: s.account.did })).data)), s.carHash)
    await startAppview(s)
  }
  await defaultAssistance(a)
  if (process.argv.includes('--server-policy')) {
    a.peerOptions={bindAddress:`127.0.0.1:${a.appviewPort}`};a.proxyPort=await freePort()
    await policyRefusals(a)
  } else {
  report('existing actors prepared idempotently; DIDs, repository bytes and old token audiences preserved; new private handles')
  // Real wrapper was reached with assistance explicitly disabled in the fixture.
  assert.equal(EndpointTicket.fromString(JSON.parse(Buffer.from((await publicLink(a)).slice(9), 'base64url')).ticket).endpointAddr().relayUrl(), null)
  report('real run-appview.sh starts via realpath guard with fixture assistance explicitly disabled')
  if (process.env.IROH_RELAY_BIN) {
    const relayPort = await freePort(); relayUrl = `http://127.0.0.1:${relayPort}/`
    const config = path.join(root, 'relay.toml')
    fs.writeFileSync(config, `http_bind_addr = "127.0.0.1:${relayPort}"\nenable_quic_addr_discovery = false\nenable_metrics = false\n`)
    relay = spawn('sandbox-exec', ['-f', path.join(repo,'appview/scripts/peer-loopback.sb'), process.env.IROH_RELAY_BIN, '--dev', '-c', config], { env: { ...process.env, RUST_LOG: 'info' }, stdio: ['ignore', 'pipe', 'pipe'] })
    await within(new Promise((resolve, reject) => {
      const ready = c => { fs.appendFileSync(path.join(root,'relay.log'),c); if (/relay: serving on/i.test(c.toString())) resolve() }
      relay.stdout.on('data', ready); relay.stderr.on('data', ready); relay.once('exit', () => reject(Error('fixture relay exited')))
    }), 'owned relay readiness')
    proxy = dgram.createSocket('udp4'); proxy.bind(0, '127.0.0.1'); await once(proxy, 'listening')
    secondProxy = dgram.createSocket('udp4'); secondProxy.bind(0, '127.0.0.1'); await once(secondProxy, 'listening')
    for (const [incoming,outgoing,source,target] of [[secondProxy,proxy,a,b],[proxy,secondProxy,b,a]]) {
      incoming.on('message',(bytes,from)=>{
        if (from.address !== '127.0.0.1' || from.port !== source.appviewPort) return
        if (gateOpen) outgoing.send(bytes,target.appviewPort,'127.0.0.1')
      })
    }
    for (const s of [a,b]) {
      const exited = once(s.child, 'exit'); s.child.kill('SIGTERM'); await within(exited, 'default AppView close')
      s.proxyPort = (s === a ? secondProxy : proxy).address().port
      s.peerOptions = { assistanceRelay: relayUrl, bindAddress: `127.0.0.1:${s.appviewPort}`, directAddress: `127.0.0.1:${(s === a ? proxy : secondProxy).address().port}` }
      await startAppview(s)
    }
  }
  const invitation = await publicLink(a)
  if (relay && !process.argv.includes('--repeat-core')) {
    const start = performance.now()
    await publicLink(b, invitation, { status: 1 })
    assert(performance.now() - start >= 29000, 'Link did not exercise the real deadline')
    assert.equal((await localCommand(b.control, 'status')).peers.length, 0)
    await publicLink(b, invitation, { interrupt: true, status: 130 })
    assert.equal((await localCommand(b.control, 'status')).peers.length, 0)
    report('relay-only Link fails at 30s; prompt-synchronized Ctrl-C cancels without approval')
  }
  if (!relay) await unapprovedRead(invitation)
  await publicLink(b, invitation, { openDirect: !!relay })
  await Promise.all([notification(a, b.oldPost.uri), notification(b, a.oldPost.uri)])
  await assert.rejects(localCommand(b.control, 'link', { invitation }))
  report('public Link confirmation creates approved direct streams; old history replays and invitation reuse fails')
  const retire = async (s, actor, subject, retired) => actor.call('ait.actor.setRetired', undefined,
    { subject, retired }, { encoding: 'application/json', headers: { 'atproto-proxy': `${s.values.bskyAppViewDid}#bsky_appview` } })
  for (const s of instances) {
    await within((async () => {
      while (true) {
        const state = (await localCommand(s.control, 'status')).peers[0]
        if (state.indexing?.state === 'running') return
        assert.notEqual(state.indexing?.state, 'failed', JSON.stringify(state))
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    })(), `${s.name} complete peer backfill`)
    const directory = await s.agent.call('ait.actor.searchActors', { q: 'terminal-observer', limit: 100 }, undefined,
      { headers: { 'atproto-proxy': `${s.values.bskyAppViewDid}#bsky_appview` } })
    assert.equal(directory.data.actors.length, 2)
    const ambiguous = await fetch(`${s.appviewUrl}/xrpc/com.atproto.identity.resolveHandle?handle=terminal-observer.test`)
    assert.equal(ambiguous.status, 400); assert.equal((await ambiguous.json()).error, 'AmbiguousHandle')
    await assert.rejects(retire(s, s.agent, s.watcher.did, true), error => error.error === 'NotOperator')
    await retire(s, s.agent, s.account.did, true) // ordinary actors retain self-retirement
    await retire(s, s.agent, s.account.did, false)
    await retire(s, s.watcherAgent, s.account.did, true)
    const hidden = await s.agent.call('ait.actor.searchActors', { q: s.name, limit: 100 }, undefined,
      { headers: { 'atproto-proxy': `${s.values.bskyAppViewDid}#bsky_appview` } })
    assert(!hidden.data.actors.some(actor => actor.did === s.account.did))
    assert.equal((await s.agent.call('ait.feed.getAuthorFeed', { actor: s.account.did }, undefined,
      { headers: { 'atproto-proxy': `${s.values.bskyAppViewDid}#bsky_appview` } })).data.feed.length, 1)
    await retire(s, s.watcherAgent, s.account.did, false)
  }
  report('same-name watcher peers keep local operator authority; public retirement/search/history agree and self-only auth holds')

  let trapRequests = 0
  if (!relay) { // Adversarial endpoints use the unchanged direct-only fixture run.
  const trap = http.createServer((req, res) => { trapRequests++; res.end('unreachable') })
  trap.listen(0, '127.0.0.1'); await once(trap, 'listening')
  const host = parse(fs.readFileSync(path.join(a.repo, 'pds/.env'))).PDS_HOSTNAME
  try {
    for (const target of ['//', `https://example.com/xrpc/com.atproto.sync.listRepos`,
      `http://127.0.0.1:${trap.address().port}/xrpc/com.atproto.sync.listRepos`]) {
      const response = await peerRequest(b, a, invitation, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
      assert.match(response, /^HTTP\/1\.1 400/, `unsafe request target ${target}`)
    }
    assert.equal(trapRequests, 0, 'peer-chosen origin must never receive a request')
    const ownProfile = await peerRequest(b, a, invitation,
      `GET /xrpc/ait.actor.getProfile?actor=${encodeURIComponent(a.account.did)}&includePresence=true HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`, true)
    assert.match(ownProfile, /^HTTP\/1\.1 200/)
    assert.match(ownProfile, /"live":true/)
    const reads = a.plcDocReads
    for (const actor of [b.account.did, 'alice', 'did:plc:' + 'z'.repeat(24)]) {
      const refused = await peerRequest(b, a, invitation,
        `GET /xrpc/ait.actor.getProfile?actor=${encodeURIComponent(actor)}&includePresence=true HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
      assert.match(refused, /^HTTP\/1\.1 403/)
    }
    assert.equal(a.plcDocReads, reads, 'non-hosted actors refuse before identity/profile work')

    const response = await peerRequest(b, a, invitation,
      `GET /xrpc/com.atproto.sync.subscribeRepos?cursor=0 HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nAuthorization: Bearer peer-secret\r\nCookie: peer-cookie\r\nX-Forwarded-For: 10.0.0.1\r\n\r\n`)
    assert.match(response, /^HTTP\/1\.1 101/)
    const forwarded = a.upgradeHeaders.at(-1)
    for (const header of ['authorization', 'cookie', 'x-forwarded-for']) assert.equal(forwarded[header], undefined)
  } finally { await new Promise(resolve => trap.close(resolve)) }
  report('approved-peer malformed/absolute targets refuse without crash or SSRF; WSS strips peer credentials')
  }
  const directory = await tool(a, 'searchActors', { query: 'bobby' })
  assert.match(directory.content[0].text, new RegExp(b.account.did)); assert(!directory.content[0].text.includes('.test'))
  assert.match(directory.content[0].text, /presence unknown/)
  const metadata = (await a.agent.call('ait.actor.getProfile', { actor: b.account.did }, undefined, {
    headers: { 'atproto-proxy': `${a.values.bskyAppViewDid}#bsky_appview` },
  })).data
  assert.equal(Object.hasOwn(metadata, 'live'), false, 'metadata-only profile does not request remote presence')
  assert.match((await tool(a, 'getProfile', { actor: b.account.did })).content[0].text, /session: live/)
  report('directory/metadata stay Unknown; explicit MCP profile reads owner registration over the approved link')

  const readsBefore = a.plcDocReads
  await tool(a, 'getProfile', { actor: b.account.did })
  const readsAfterFirst = a.plcDocReads
  await tool(a, 'getProfile', { actor: b.account.did })
  assert(readsAfterFirst - readsBefore <= 1, 'first viewer-key verification should need at most one PLC read')
  assert.equal(a.plcDocReads, readsAfterFirst, 'repeat authenticated read must reuse the local viewer-key cache')
  console.log(`viewer-key PLC reads: first=${readsAfterFirst - readsBefore}, repeat=${a.plcDocReads - readsAfterFirst}`)
  await tool(a, 'follow', { target: 'bobby' })
  const posted = await tool(a, 'post', { text: 'hello @bobby from a direct peer' })
  const postUri = /URI: (\S+)/.exec(posted.content[0].text)[1]
  await notification(b, postUri)
  const replied = await tool(b, 'reply', { parent_uri: postUri, text: 'reply to @alice through local PDS getRecord' })
  const replyUri = /URI: (\S+)/.exec(replied.content[0].text)[1]
  await notification(a, replyUri)
  const thread = await tool(a, 'getPostThread', { post_uri: postUri })
  assert.match(thread.content[0].text, new RegExp(replyUri))
  if (relay && !process.argv.includes('--repeat-core')) {
    const outputStart = a.output.length
    gateOpen = false
    await within(new Promise(resolve => {
      const ready = () => {
        if (a.output.slice(outputStart).includes('Unavailable: direct connection lost')) {
          a.events.off('output', ready); resolve()
        }
      }
      a.events.on('output', ready); ready()
    }), 'native direct-loss status event', 30000)
    assert.equal((await localCommand(a.control, 'status')).peers[0].state, 'Unavailable')
    assert.match((await tool(a, 'getProfile', { actor: b.account.did })).content[0].text, /session: presence unknown/)
    const backlog = await tool(b, 'post', { text: '@alice local commit while direct connection is unavailable' })
    const backlogUri = /URI: (\S+)/.exec(backlog.content[0].text)[1]
    assert(!a.push.some(n => n.uri === backlogUri), 'unavailable peer must not have received the new record')
    gateOpen = true
    await notification(a, backlogUri, 90000)
    assert.match(a.output.slice(outputStart), /Linked: direct application path available/)
    const machineFile = path.join(path.dirname(a.control), 'machine.json')
    const stateBeforeStatus = fs.readFileSync(machineFile, 'utf8')
    fs.copyFileSync(path.join(repo,'bin/status.sh'),path.join(a.repo,'bin/status.sh'))
    fs.copyFileSync(path.join(repo,'bin/lib-service-pids.sh'),path.join(a.repo,'bin/lib-service-pids.sh'))
    fs.writeFileSync(path.join(a.repo,'bin/curl'), '#!/bin/sh\nprintf "{}"\n', {mode:0o755})
    fs.symlinkSync(process.execPath,path.join(a.repo,'bin/node'))
    const statusText = execFileSync('/bin/bash', [path.join(a.repo,'bin/status.sh')], {encoding:'utf8', env:{...process.env,
      HOME:path.join(a.repo,'home'), AIT_CODEX_SHARED_SOCKET:path.join(a.repo,'no-codex.sock'), PATH:`${path.join(a.repo,'bin')}:/usr/bin:/bin`}})
    assert.match(statusText, /Linked/)
    assert.equal(fs.readFileSync(machineFile, 'utf8'), stateBeforeStatus, 'status never mints an invitation')
    assert.equal(a.push.filter(n => n.uri === backlogUri).length, 1)
    report('Unavailable is visible while direct UDP is cut; local post survives and sync resumes without loss')
  }
  const record = (await b.agent.com.atproto.repo.getRecord({ repo: a.account.did, collection: 'ait.feed.post', rkey: postUri.split('/').at(-1) })).data
  assert.equal(record.uri, postUri); assert.equal(record.value.facets[0].features[0].did, b.account.did)
  await assert.rejects(b.agent.com.atproto.repo.getRecord({ repo: a.account.did, collection: 'ait.feed.post', rkey: postUri.split('/').at(-1), cid: b.oldPost.cid }))
  report('existing MCP discovery/follow/post/reply/thread and local-PDS reply lookup agree on original DIDs/CIDs; callbacks delivered')
  let before = a.push.length
  const key = (await localCommand(a.control, 'status')).peers[0].id
  assert.equal((await localCommand(a.control, 'unlink', { id: key })).state, 'Unlinked')
  assert.equal((await localCommand(a.control, 'status')).peers.length, 0)
  assert.match((await tool(a, 'getPostThread', { post_uri: postUri })).content[0].text, new RegExp(replyUri))
  assert.match((await tool(a, 'getProfile', { actor: b.account.did })).content[0].text, /bobby/)
  assert.match((await tool(a, 'getProfile', { actor: b.account.did })).content[0].text, /session: presence unknown/)
  assert.match((await tool(a, 'getTimeline', {})).content[0].text, /bobby/)
  assert.match((await tool(a, 'listNotifications', {})).content[0].text, /bobby/)
  const duplicate = spawn(process.execPath, [path.join(repo, 'appview/dist/server.js')], {
    cwd: path.join(a.repo, 'appview'), env: a.launchEnv, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let duplicateError = ''; duplicate.stderr.on('data', chunk => { duplicateError += chunk })
  assert.equal((await within(once(duplicate, 'exit'), 'active socket owner refusal'))[0], 1)
  assert.match(duplicateError, /refusing to replace an active/)
  assert.equal((await localCommand(a.control, 'status')).peers.length, 0)
  const stopped = once(a.child, 'exit'); a.child.kill('SIGKILL'); await within(stopped, 'owned fixture crash')
  assert(fs.lstatSync(a.control).isSocket(), 'SIGKILL must leave the fixture socket for this regression')
  a.legacyOperator = true
  await startAppview(a)
  await retire(a, a.watcherAgent, a.account.did, true)
  await retire(a, a.watcherAgent, a.account.did, false)
  assert.match((await tool(a, 'getPostThread', { post_uri: postUri })).content[0].text, new RegExp(replyUri))
  before = a.push.length // Startup backlog replay is separate from relink idempotence.
  report('retained peer history stays readable after Unlink/restart; dead socket is reclaimed and active owner preserved')
  const renewed = await publicLink(a)
  const addresses = text => EndpointTicket.fromString(JSON.parse(Buffer.from(text.slice(9), 'base64url')).ticket).endpointAddr().directAddresses().sort()
  assert.deepEqual(addresses(renewed), addresses(invitation), 'direct addresses must survive ordinary AppView restart')
  await publicLink(b, renewed)
  // A new notification is an event barrier behind replay, not a timing sleep.
  const barrier = await tool(b, 'post', { text: 'after relink @alice' })
  await notification(a, /URI: (\S+)/.exec(barrier.content[0].text)[1])
  assert.equal(a.push.length, before + 1)
  const reverse = (await localCommand(b.control, 'status')).peers[0].id
  await localCommand(b.control, 'unlink', { id: reverse })
  await publicLink(b, await publicLink(a)) // Inviter still had approval this time.
  const reverseBarrier = await tool(b, 'post', { text: 'reverse relink @alice' })
  await notification(a, /URI: (\S+)/.exec(reverseBarrier.content[0].text)[1])
  assert.equal(a.push.length, before + 2)
  report('Unlink closes approved access; relink/replay does not duplicate notifications')
  const stoppedOwner = once(b.child, 'exit'); b.child.kill('SIGTERM'); await within(stoppedOwner, 'owner presence restart')
  b.skipRegistration = true
  await startAppview(b)
  const presenceBarrier = await tool(b, 'post', { text: 'owner restarted without a callback @alice' })
  await notification(a, /URI: (\S+)/.exec(presenceBarrier.content[0].text)[1])
  assert.match((await tool(a, 'getProfile', { actor: b.account.did })).content[0].text, /session: offline/)
  report('reachable owner without a callback reports Offline; Unlink reports Unknown without losing retained profiles')

  if (relay && !process.argv.includes('--repeat-core')) { await policyRefusals(a); await connectBound() }
  }
  }
} catch (error) { failure = error; console.error(error) }
finally {
  gateOpen = false
  for (const s of instances) {
    if (s.child && s.child.exitCode === null) {
      s.child.kill('SIGTERM')
      try { await within(once(s.child, 'exit'), 'owned AppView close') } catch (error) { failure ??= error; const exited = once(s.child,'exit'); s.child.kill('SIGKILL'); await exited }
    }
    try { await stopPds(s); await s.plc?.destroy() } catch (error) { failure ??= error }
    if (s.callback) await new Promise(resolve => s.callback.close(resolve))
    if (failure) fs.writeFileSync(path.join(s.repo, 'appview-output.log'), s.output || '')
  }
  if (proxy) { proxy.close(); proxy = undefined }
  if (secondProxy) { secondProxy.close(); secondProxy = undefined }
  if (relay && relay.exitCode === null) { const exited = once(relay, 'exit'); relay.kill('SIGTERM'); await within(exited, 'owned relay close') }
  if (postmasterPid) {
    assert.equal(Number(fs.readFileSync(path.join(pgData, 'postmaster.pid'), 'utf8').split('\n')[0]), postmasterPid)
    execFileSync(`${pgBin}/pg_ctl`, ['-D', pgData, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' })
  }
}
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ root, outcomes, failure: failure?.stack, liveTouched: false }, null, 2))
console.log(JSON.stringify({ root, outcomes: outcomes.length, failure: failure?.message }))
if (failure) process.exitCode = 1
