// Verifies the lexicon write-gate on post / reply / follow: every ait.* record
// write is validated against its registered lexicon (assertValidAitRecord)
// before hitting the PDS, which — being vanilla — doesn't schema-check ait.*
// records itself.
//
// Pure write-side: needs only the PDS + PLC (no AppView, no read-back). Same
// harness shape as follow-timeline-test.mjs. The interesting cases are the ones
// that exercise lexicon ref resolution through the gate: a mention facet
// (app.bsky.richtext.facet) and a reply (com.atproto.repo.strongRef) — if those
// refs didn't resolve in the agent's Lexicons, the gate would reject a valid
// write. Plus the actual point: an over-300-grapheme post is refused.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const MCP_SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'server.js',
)
const STAMP = Date.now().toString(36)
const XDG_TMP = mkdtempSync(join(tmpdir(), 'ait-wgate-test-'))
mkdirSync(join(XDG_TMP, 'ait-mcp'), { recursive: true })

process.on('exit', () => {
  try {
    rmSync(XDG_TMP, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

async function spawnMcp(name, sessionId) {
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

const uriOf = (text) => text.match(/URI:\s+(at:\/\/\S+)/)?.[1]

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

// === A and B join (B is the mention/reply/follow target).
const cA = await spawnMcp('wgate-A', randomUUID())
const idA = extractIds((await cA.callTool({ name: 'join', arguments: { handle_hint: `wga${STAMP}` } })).content[0].text)
console.log('A joined:', idA)

const cB = await spawnMcp('wgate-B', randomUUID())
const idB = extractIds((await cB.callTool({ name: 'join', arguments: { handle_hint: `wgb${STAMP}` } })).content[0].text)
console.log('B joined:', idB)

const bParent = await cB.callTool({ name: 'post', arguments: { text: 'parent post from B' } })
const parentUri = uriOf(bParent.content[0].text)
console.log('B posted parent:', parentUri)
assert(parentUri, 'B post should return a URI (plain post passes the gate)')

// === A: post (plain), post (mention facet), over-length (rejected), reply, follow.
const plain = await cA.callTool({ name: 'post', arguments: { text: 'hello world from A' } })
console.log('A post plain →', uriOf(plain.content[0].text) ? 'ok' : 'FAIL')
assert(uriOf(plain.content[0].text), 'plain post should pass the gate')

const mention = await cA.callTool({ name: 'post', arguments: { text: `@${idB.handle} hi` } })
console.log('A post w/ mention facet →', uriOf(mention.content[0].text) ? 'ok' : 'FAIL')
assert(uriOf(mention.content[0].text), 'mention post should pass the gate (app.bsky.richtext.facet ref resolves)')

// Post cap raised to 1000 graphemes (ADR-0040 — bsky-divergence). A 500-char
// post, rejected under the old 300 cap, now passes; 1001 still rejected.
const midLen = await cA.callTool({ name: 'post', arguments: { text: 'x'.repeat(500) } })
console.log('A post 500 graphemes →', uriOf(midLen.content[0].text) ? 'ok (was rejected pre-bump)' : 'FAIL')
assert(uriOf(midLen.content[0].text), '500-grapheme post should pass under the 1000 cap')

const long = await cA.callTool({ name: 'post', arguments: { text: 'x'.repeat(1001) } })
console.log('A post 1001 graphemes →', long.isError ? 'rejected' : 'ACCEPTED')
assert(long.isError === true, 'over-1000-grapheme post should be rejected by the write-gate')
assert(/graphemes/i.test(long.content[0].text), 'rejection should cite the grapheme limit')

const reply = await cA.callTool({ name: 'reply', arguments: { parent_uri: parentUri, text: 'good point' } })
console.log('A reply →', uriOf(reply.content[0].text) ? 'ok' : 'FAIL')
assert(uriOf(reply.content[0].text), 'reply should pass the gate (com.atproto.repo.strongRef ref resolves)')

const follow = await cA.callTool({ name: 'follow', arguments: { target: idB.did } })
console.log('A follow B →', /Followed/.test(follow.content[0].text) ? 'ok' : 'FAIL')
assert(/Followed/.test(follow.content[0].text), 'follow should pass the gate')

await cA.close()
await cB.close()
console.log('\nPASS: post/reply/follow lexicon write-gate (valid writes pass, over-length post rejected)')
