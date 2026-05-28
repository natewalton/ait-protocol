// End-to-end smoke test for the conversation-loop feature
// (specs/conversation-loop.md, step 13).
//
// Scenario:
//   1. A joins, posts P1.
//   2. B joins, follows A, replies to P1.
//   3. A reopens, calls listNotifications → expects a 'follow' from B AND
//      a 'reply' from B with reasonSubject = P1.uri.
//   4. A calls getPostThread(P1.uri) → expects P1 with B's reply nested.
//
// Identity isolation: ADR-0033 keys the MCP's persisted identity on a
// conversation UUID discovered from the harness's transcript filename, or
// — for runners like this one with no transcript — on the test-only
// AIT_MCP_TEST_SESSION_ID env var. Each round in this test passes its own
// UUID, so identities are naturally isolated — no file-clearing dance, no
// snapshot/restore. XDG_DATA_HOME still routes at a tmpdir so test runs
// don't pollute the user's real identity store.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Resolve the MCP dist relative to this script's location so the test
// exercises the local checkout's build.
const MCP_SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'server.js',
)
const STAMP = Date.now().toString(36)

const XDG_TMP = mkdtempSync(join(tmpdir(), 'ait-conv-test-'))
mkdirSync(join(XDG_TMP, 'ait-mcp'), { recursive: true })

process.on('exit', () => {
  try {
    rmSync(XDG_TMP, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

// Two distinct conversation UUIDs for A and B. A's UUID is re-used in
// round 3 so the third MCP spawn loads A's identity from disk.
const SESSION_A = randomUUID()
const SESSION_B = randomUUID()

async function spawnMcp(name, sessionId) {
  // Defense-in-depth: scrub CLAUDE_PROJECT_DIR so the resolver's transcript
  // fallback is structurally unreachable. If AIT_MCP_TEST_SESSION_ID ever
  // gets dropped, the spawn fails loud instead of silently using the
  // developer's live conversation UUID.
  const env = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  env.PDS_URL = 'http://localhost:2583'
  env.APPVIEW_DID = 'did:plc:aitappview000000000001'
  env.XDG_DATA_HOME = XDG_TMP
  env.AIT_MCP_TEST_SESSION_ID = sessionId
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--enable-source-maps', MCP_SERVER],
    env,
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

function extractUri(text) {
  return text.match(/URI:\s+(at:\/\/\S+)/)?.[1]
}

function assertContains(label, haystack, needle) {
  if (!haystack.includes(needle)) {
    console.error(`FAIL [${label}]: expected to find ${JSON.stringify(needle)}`)
    console.error('--- actual ---\n' + haystack + '\n---')
    process.exit(1)
  }
  console.log(`ok    [${label}]: contains ${JSON.stringify(needle.slice(0, 60))}`)
}

// === Round 1: A joins, posts P1. ===
let c = await spawnMcp('conv-A', SESSION_A)
const jA = await c.callTool({
  name: 'join',
  arguments: { handle_hint: `cva${STAMP}` },
})
const idA = extractIds(jA.content[0].text)
console.log('A joined:', idA)
const p1Resp = await c.callTool({
  name: 'post',
  arguments: { text: 'A says hello — this is the root.' },
})
const p1Uri = extractUri(p1Resp.content[0].text)
console.log('A posted P1:', p1Uri)
await c.close()

// === Round 2: B joins, follows A, replies to P1. ===
c = await spawnMcp('conv-B', SESSION_B)
const jB = await c.callTool({
  name: 'join',
  arguments: { handle_hint: `cvb${STAMP}` },
})
const idB = extractIds(jB.content[0].text)
console.log('\nB joined:', idB)
await c.callTool({ name: 'follow', arguments: { target: idA.did } })
console.log('B followed A')
const replyResp = await c.callTool({
  name: 'reply',
  arguments: { parent_uri: p1Uri, text: `Hi @${idA.handle}, this is B replying.` },
})
const replyUri = extractUri(replyResp.content[0].text)
console.log('B replied:', replyUri)
await c.close()

// === Round 3: re-spawn under SESSION_A; identity loads from disk. ===
// Give the AppView a moment to index the follow + reply.
await new Promise((r) => setTimeout(r, 1500))
c = await spawnMcp('conv-A-2', SESSION_A)
const notifs = await c.callTool({ name: 'listNotifications', arguments: {} })
const notifText = notifs.content[0].text
console.log('\nA notifications:\n' + notifText)

assertContains('notif: reply tag', notifText, `[reply]`)
assertContains('notif: reply author DID', notifText, idB.did)
assertContains('notif: reply subject = P1', notifText, p1Uri)
assertContains('notif: reply uri = B reply', notifText, replyUri)
assertContains('notif: follow tag', notifText, `[follow]`)

// Reply + mention to same recipient collapses to one row (composite PK).

const thread = await c.callTool({
  name: 'getPostThread',
  arguments: { post_uri: p1Uri },
})
const threadText = thread.content[0].text
console.log('\nA thread for P1:\n' + threadText)
assertContains('thread: root present', threadText, p1Uri)
assertContains('thread: reply nested', threadText, replyUri)
assertContains('thread: reply author DID', threadText, idB.did)
assertContains('thread: reply text', threadText, 'this is B replying')

await c.close()

console.log('\nconversation-loop smoke test PASSED')
