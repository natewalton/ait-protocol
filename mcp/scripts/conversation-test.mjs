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
// Identity juggling: per ADR-0030 the MCP persists identity keyed to the
// test runner's PID — so to act as a different account we must clear the
// store between turns. To return to A in round 4 we snapshot A's identity
// file in round 1 and restore it before spawning the third MCP.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = '/Users/nwalton/Desktop/ait-protocol'
const STAMP = Date.now().toString(36)

// Isolate identity storage from any concurrent Claude session by routing
// XDG_DATA_HOME at a tmp directory. Without this, clearIdentityFiles()
// (needed to act as multiple accounts within one runner) wipes out the
// real-user identity files of any session that shares the home dir.
const XDG_TMP = mkdtempSync(join(tmpdir(), 'ait-conv-test-'))
mkdirSync(join(XDG_TMP, 'ait-mcp'), { recursive: true })
const IDENTITY_DIR = join(XDG_TMP, 'ait-mcp')

process.on('exit', () => {
  try {
    rmSync(XDG_TMP, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

async function spawnMcp(name) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      '--enable-source-maps',
      `${REPO}/.claude/worktrees/cool-leakey-4ecf15/mcp/dist/server.js`,
    ],
    env: {
      ...process.env,
      PDS_URL: 'http://localhost:2583',
      APPVIEW_DID: 'did:plc:aitappview000000000001',
      XDG_DATA_HOME: XDG_TMP,
    },
  })
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(transport)
  return client
}

function listIdentityFiles() {
  if (!existsSync(IDENTITY_DIR)) return []
  return readdirSync(IDENTITY_DIR).filter((f) => f.startsWith('identity-'))
}

function clearIdentityFiles() {
  for (const f of listIdentityFiles()) {
    unlinkSync(join(IDENTITY_DIR, f))
  }
}

function snapshotIdentity(label) {
  const files = listIdentityFiles()
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one identity file after ${label}, got ${files.length}: ${files.join(', ')}`,
    )
  }
  const snap = join(tmpdir(), `ait-conversation-test-${label}-${STAMP}.json`)
  copyFileSync(join(IDENTITY_DIR, files[0]), snap)
  return { fileName: files[0], snapshot: snap }
}

function restoreIdentity(snap) {
  clearIdentityFiles()
  copyFileSync(snap.snapshot, join(IDENTITY_DIR, snap.fileName))
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
clearIdentityFiles()
let c = await spawnMcp('conv-A')
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
const snapA = snapshotIdentity('A')

// === Round 2: B joins, follows A, replies to P1. ===
clearIdentityFiles()
c = await spawnMcp('conv-B')
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

// === Round 3: restore A, query notifications + thread. ===
restoreIdentity(snapA)
// Give the AppView a moment to index the follow + reply.
await new Promise((r) => setTimeout(r, 1500))
c = await spawnMcp('conv-A-2')
const notifs = await c.callTool({ name: 'listNotifications', arguments: {} })
const notifText = notifs.content[0].text
console.log('\nA notifications:\n' + notifText)

// Reply notification: B replied to A's P1.
assertContains('notif: reply tag', notifText, `[reply]`)
assertContains('notif: reply author DID', notifText, idB.did)
assertContains('notif: reply subject = P1', notifText, p1Uri)
assertContains('notif: reply uri = B reply', notifText, replyUri)

// Follow notification: B followed A.
assertContains('notif: follow tag', notifText, `[follow]`)

// Mention notification: B's reply mentions @A. Same recipient as the reply,
// so it collapses with the reply row (PK is uri+recipient_did). That's
// intentional — bsky behaviour — so we don't assert a separate [mention].

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
