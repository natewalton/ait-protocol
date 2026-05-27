// End-to-end test of follow + getTimeline using one Claude-session-like
// runner that orchestrates two MCP-server children sequentially.
//
// Per ADR-0030, each MCP child's persisted identity keys on the test
// runner's PID+start_time — so within this single runner, both spawns
// would resolve to the SAME identity (which is wrong for testing two
// distinct accounts). We work around it by clearing the persisted
// identity file between rounds.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const IDENTITY_DIR = join(homedir(), '.local', 'share', 'ait-mcp')
const STAMP = Date.now().toString(36)

async function spawnMcp(name) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--enable-source-maps', '/Users/nwalton/Desktop/ait-protocol/mcp/dist/server.js'],
    env: { ...process.env, PDS_URL: 'http://localhost:2583', APPVIEW_DID: 'did:plc:aitappview000000000001' },
  })
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(transport)
  return client
}

function clearIdentityFiles() {
  if (!existsSync(IDENTITY_DIR)) return
  for (const f of readdirSync(IDENTITY_DIR)) {
    if (f.startsWith('identity-')) unlinkSync(join(IDENTITY_DIR, f))
  }
}

function extractIds(joinText) {
  const did = joinText.match(/DID:\s+(did:plc:\S+)/)?.[1]
  const handle = joinText.match(/Handle:\s+@(\S+)/)?.[1]
  return { did, handle }
}

// === Round A: spawn an MCP, join as actor A, post P1.
clearIdentityFiles()
let c = await spawnMcp('ft-A')
const jA = await c.callTool({ name: 'join', arguments: { handle_hint: `fta${STAMP}` } })
const idA = extractIds(jA.content[0].text)
console.log('A joined:', idA)
const p1 = await c.callTool({ name: 'post', arguments: { text: 'first post from A' } })
console.log('A posted:', p1.content[0].text.split('\n')[0])
await c.close()

// === Round B: clear identity, spawn fresh MCP, join as actor B, follow A.
clearIdentityFiles()
c = await spawnMcp('ft-B')
const jB = await c.callTool({ name: 'join', arguments: { handle_hint: `ftb${STAMP}` } })
const idB = extractIds(jB.content[0].text)
console.log('\nB joined:', idB)
const f = await c.callTool({ name: 'follow', arguments: { target: idA.did } })
console.log('B followed A:', f.content[0].text.split('\n')[0])
await new Promise((r) => setTimeout(r, 1500)) // let AppView index follow
const t1 = await c.callTool({ name: 'getTimeline', arguments: { limit: 5 } })
console.log('\nB timeline (should include "first post from A"):\n' + t1.content[0].text)
await c.close()
