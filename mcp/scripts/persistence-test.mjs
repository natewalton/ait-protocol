// Verifies that the MCP server's identity persists across process restarts
// within the same Claude session — the property added by ADR-0030.
//
// Spawns the MCP twice (simulating Claude Code reaping + respawning) and
// asserts the second spawn auto-loads the first's identity from disk.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HANDLE_HINT = `pt-${Date.now().toString(36)}`

async function spawn() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--enable-source-maps', '/Users/nwalton/Desktop/ait-protocol/mcp/dist/server.js'],
    env: {
      ...process.env,
      PDS_URL: 'http://localhost:2583',
      APPVIEW_DID: 'did:plc:aitappview000000000001',
    },
  })
  const client = new Client({ name: 'persist-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

function findFreshIdentityFile(sinceMs) {
  const dir = join(homedir(), '.local', 'share', 'ait-mcp')
  if (!existsSync(dir)) return null
  const candidates = readdirSync(dir)
    .filter((f) => f.startsWith('identity-') && f.endsWith('.json'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .filter((x) => x.mtime >= sinceMs)
    .sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.f ?? null
}

const startedAt = Date.now()

console.log(`=== Round 1 (handle_hint=${HANDLE_HINT}) ===`)
let c = await spawn()
const j1 = await c.callTool({ name: 'join', arguments: { handle_hint: HANDLE_HINT } })
console.log('join response (first 200 chars):', JSON.stringify(j1.content[0]).slice(0, 200))
const p1 = await c.callTool({ name: 'post', arguments: { text: 'round 1 post' } })
console.log('post:', p1.content[0].text.split('\n')[0])
await c.close()

console.log('\n=== Round 2 (NEW MCP process — should auto-load identity) ===')
c = await spawn()
const p2 = await c.callTool({ name: 'post', arguments: { text: 'round 2 post after restart' } })
console.log('post:', p2.content[0].text.split('\n')[0])
await c.close()

console.log('\n=== persisted file (newest created this run) ===')
const f = findFreshIdentityFile(startedAt)
if (!f) {
  console.error('no fresh identity file under ~/.local/share/ait-mcp/')
  process.exit(1)
}
const data = JSON.parse(readFileSync(join(homedir(), '.local', 'share', 'ait-mcp', f), 'utf-8'))
console.log(f, '->', { handle: data.handle, did: data.did, sessionKey: data.sessionKey })
