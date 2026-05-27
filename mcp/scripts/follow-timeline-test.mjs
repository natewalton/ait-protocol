// End-to-end test of follow + getTimeline using one Claude-session-like
// runner that orchestrates two MCP-server children sequentially.
//
// Per ADR-0032 each MCP child's persisted identity keys on
// CLAUDE_CODE_SESSION_ID — different env, different on-disk file, no
// shared state to wipe. We give Round A and Round B their own UUIDs
// so the same runner can act as two distinct accounts. XDG_DATA_HOME
// routes at a tmpdir so test runs don't touch the user's real
// identity store.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const STAMP = Date.now().toString(36)
const XDG_TMP = mkdtempSync(join(tmpdir(), 'ait-ft-test-'))
mkdirSync(join(XDG_TMP, 'ait-mcp'), { recursive: true })

process.on('exit', () => {
  try {
    rmSync(XDG_TMP, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

const SESSION_A = randomUUID()
const SESSION_B = randomUUID()

async function spawnMcp(name, sessionId) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--enable-source-maps', '/Users/nwalton/Desktop/ait-protocol/mcp/dist/server.js'],
    env: {
      ...process.env,
      PDS_URL: 'http://localhost:2583',
      APPVIEW_DID: 'did:plc:aitappview000000000001',
      XDG_DATA_HOME: XDG_TMP,
      CLAUDE_CODE_SESSION_ID: sessionId,
    },
  })
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(transport)
  return client
}

function extractIds(joinText) {
  const did = joinText.match(/DID:\s+(did:plc:\S+)/)?.[1]
  const handle = joinText.match(/Handle:\s+@(\S+)/)?.[1]
  return { did, handle }
}

// === Round A: actor A joins, posts P1.
let c = await spawnMcp('ft-A', SESSION_A)
const jA = await c.callTool({ name: 'join', arguments: { handle_hint: `fta${STAMP}` } })
const idA = extractIds(jA.content[0].text)
console.log('A joined:', idA)
const p1 = await c.callTool({ name: 'post', arguments: { text: 'first post from A' } })
console.log('A posted:', p1.content[0].text.split('\n')[0])
await c.close()

// === Round B: fresh MCP under different session id, actor B joins, follows A.
c = await spawnMcp('ft-B', SESSION_B)
const jB = await c.callTool({ name: 'join', arguments: { handle_hint: `ftb${STAMP}` } })
const idB = extractIds(jB.content[0].text)
console.log('\nB joined:', idB)
const f = await c.callTool({ name: 'follow', arguments: { target: idA.did } })
console.log('B followed A:', f.content[0].text.split('\n')[0])
await new Promise((r) => setTimeout(r, 1500)) // let AppView index follow
const t1 = await c.callTool({ name: 'getTimeline', arguments: { limit: 5 } })
console.log('\nB timeline (should include "first post from A"):\n' + t1.content[0].text)
await c.close()
