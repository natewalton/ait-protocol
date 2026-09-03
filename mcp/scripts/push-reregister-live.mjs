// LIVE diagnostic: does a push-mode session keep receiving notifications after
// the AppView is restarted out from under it? This creates an AIT account,
// publishes mentions, and restarts live services. It is not an isolated test.
//
//   1. start an MCP in push mode, join (mints a handle), confirm a mention arrives
//   2. restart the AppView, wiping its registry
//   3. wait past one heartbeat, send another mention, see whether it arrives
//
// Run from the repo root. Needs PLC/PDS/AppView up.
//   node mcp/scripts/push-reregister-live.mjs --live [all|appview]

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scope = process.argv[3] ?? 'all'
if (
  process.argv[2] !== '--live' ||
  !['all', 'appview'].includes(scope) ||
  process.argv.length > 4
) {
  console.error('refusing: this diagnostic creates an AIT account, publishes mentions, and restarts live services')
  console.error('run: node mcp/scripts/push-reregister-live.mjs --live [all|appview]')
  process.exit(2)
}

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SESSION = randomUUID()
const env = { ...process.env }
delete env.CLAUDE_PROJECT_DIR
env.AIT_MCP_TEST_SESSION_ID = SESSION
env.AIT_NOTIFICATION_MODE = 'push'
env.XDG_DATA_HOME = join(tmpdir(), `ait-pushrestart-${SESSION}`)
env.PDS_URL = 'http://localhost:2583'
env.APPVIEW_DID = 'did:plc:aitappview000000000001'

const received = []
const client = new Client(
  { name: 'push-restart-test', version: '0.0.0' },
  { capabilities: { experimental: { 'claude/channel': {} } } },
)
client.fallbackNotificationHandler = async (n) => {
  if (n.method?.includes('channel')) received.push(JSON.stringify(n.params).slice(0, 120))
}
await client.connect(new StdioClientTransport({
  command: 'node', args: ['--enable-source-maps', `${REPO}/mcp/dist/server.js`], env,
}))

const joined = await client.callTool({ name: 'join', arguments: { handle_hint: `pushr${Date.now() % 100000}` } })
const handle = (joined.content[0].text.match(/@([a-z0-9-]+\.test)/) || [])[1]
console.log('joined as', handle)

// A second identity to mention it with: aitty's stored account.
const mention = async (label) => {
  execFileSync('node', ['-e', `
    import('${REPO}/mcp/dist/aitty/identity.js').then(async (idm) => {
      const a = await import('${REPO}/mcp/dist/aitty/agent.js')
      const id = idm.loadIdentity()
      const agent = a.makeAgent()
      await a.loginWatcher(agent, id.handle, id.password)
      await a.createPost(agent, id.did, '${label} @${handle} ping')
    })
  `], { env: { ...process.env, PDS_URL: env.PDS_URL, APPVIEW_DID: env.APPVIEW_DID }, stdio: 'inherit' })
}

const waitFor = async (n, secs) => {
  for (let i = 0; i < secs; i++) {
    if (received.length >= n) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

await new Promise((r) => setTimeout(r, 3000))
await mention('before-restart')
const first = await waitFor(1, 25)
console.log(`(1) mention BEFORE restart delivered: ${first}`)

// FULL restart by default — PDS and AppView both — because that is what
// bin/stop-all.sh does, and a PDS restart is the half that can invalidate a
// session's stored JWTs. Pass `appview` to restart only the AppView.
console.log(`restarting ${scope === 'appview' ? 'the AppView' : 'PDS + AppView'}…`)
// The codex app-server is deliberately left alone: stopping it would take down
// every attached codex session, which has nothing to do with what is under test.
const restart = scope === 'appview'
  ? `kill $(cat /tmp/ait-appview.pid); sleep 3; ${REPO}/bin/start-all.sh >/dev/null 2>&1`
  : `kill $(cat /tmp/ait-pds.pid) $(cat /tmp/ait-appview.pid); sleep 4; ${REPO}/bin/start-all.sh >/dev/null 2>&1`
execFileSync('bash', ['-c', restart], { stdio: 'inherit' })
await new Promise((r) => setTimeout(r, 8000))

console.log('waiting 35s for the re-register heartbeat…')
await new Promise((r) => setTimeout(r, 35000))

const before = received.length
await mention('after-restart')
const second = await waitFor(before + 1, 30)
console.log(`(2) mention AFTER restart delivered: ${second}`)

console.log(`\ntotal channel notifications: ${received.length}`)
await client.close()
process.exit(second ? 0 : 1)
