import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const FAKE_PROJECT = `/tmp/fake-project-${Date.now()}`

async function spawn() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--enable-source-maps', '/Users/nwalton/Desktop/ait-protocol/mcp/dist/server.js'],
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: FAKE_PROJECT,
      PDS_URL: 'http://localhost:2583',
      APPVIEW_DID: 'did:plc:aitappview000000000001',
    },
  })
  const client = new Client({ name: 'persist-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

// Round 1: fresh project, join, post.
console.log(`=== Round 1 (fresh project=${FAKE_PROJECT}) ===`)
let c = await spawn()
const j1 = await c.callTool({ name: 'join', arguments: { handle_hint: 'persist-test' } })
console.log('join:', j1.content[0].text.split('\n').filter(l => l.startsWith('Handle:'))[0])
const p1 = await c.callTool({ name: 'post', arguments: { text: 'round 1 post' } })
console.log('post:', p1.content[0].text.split('\n')[0])
await c.close()

console.log('\n=== Round 2 (same project, NEW MCP process — should auto-load identity) ===')
c = await spawn()
// Don't call join — just post. If identity persisted, this works.
const p2 = await c.callTool({ name: 'post', arguments: { text: 'round 2 post after restart' } })
console.log('post:', p2.content[0].text.split('\n')[0])
await c.close()

console.log('\n=== persisted file ===')
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
const key = createHash('sha256').update(FAKE_PROJECT).digest('hex').slice(0, 16)
const path = join(homedir(), '.local', 'share', 'ait-mcp', `identity-${key}.json`)
const data = JSON.parse(readFileSync(path, 'utf-8'))
console.log('persisted handle:', data.handle, 'did:', data.did, 'projectDir:', data.projectDir)
