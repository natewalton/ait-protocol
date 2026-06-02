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
// Identity isolation: ADR-0035 keys the MCP's persisted identity on the
// parent claude process's `--resume <UUID>` argv (or CLAUDE_CODE_SESSION_ID
// for cold-start), or — for runners like this one without a Claude Code
// harness — on the test-only AIT_MCP_TEST_SESSION_ID env var. Each round
// in this test passes its own
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
// fix7 wrong-sig assertion needs jwt-mint primitives. Pulled from the
// appview's deps (where they're already a direct dep for verifyJwt)
// rather than adding them as mcp devDeps for a single assertion.
import { createServiceJwt } from '../../appview/node_modules/@atproto/xrpc-server/dist/index.js'
import { Secp256k1Keypair } from '../../appview/node_modules/@atproto/crypto/dist/index.js'

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
// Fix 1: hydrated reply now carries the parent CID alongside the URI.
// renderer emits 'replyParent: <uri> cid=<cid>' for each reply node — the
// cid suffix must be a non-empty value (starts with 'bafy...' for v1 CIDs).
assertContains('thread: reply parent CID present', threadText, `cid=baf`)
assertContains('thread: reply parent uri', threadText, `replyParent: ${p1Uri}`)

// Fix 2: fetching the thread at the reply URI returns the ancestor chain
// via threadViewPost.parent, surfaced by the renderer as a top 'ancestors:'
// section that contains the original post URI.
const threadAtReply = await c.callTool({
  name: 'getPostThread',
  arguments: { post_uri: replyUri },
})
const threadAtReplyText = threadAtReply.content[0].text
console.log('\nA thread at reply URI:\n' + threadAtReplyText)
assertContains('ancestors section header', threadAtReplyText, 'ancestors:')
assertContains('ancestor is original P1', threadAtReplyText, p1Uri)
assertContains('thread root is the reply', threadAtReplyText, replyUri)

await c.close()

// Fix 6: AppView rejects bad ?limit with 400 InvalidRequest (not 500).
const APPVIEW_URL = process.env.APPVIEW_URL ?? 'http://localhost:2585'
async function expectStatus(label, url, expected) {
  const r = await fetch(url)
  if (r.status !== expected) {
    console.error(`FAIL [${label}]: expected ${expected}, got ${r.status}`)
    console.error('--- body ---\n' + (await r.text()) + '\n---')
    process.exit(1)
  }
  console.log(`ok    [${label}]: ${expected} from ${url}`)
}
await expectStatus(
  'fix6: limit=banana → 400',
  `${APPVIEW_URL}/xrpc/ait.feed.getAuthorFeed?actor=${encodeURIComponent(idA.did)}&limit=banana`,
  400,
)
await expectStatus(
  'fix6: limit=-1 → 400',
  `${APPVIEW_URL}/xrpc/ait.feed.getAuthorFeed?actor=${encodeURIComponent(idA.did)}&limit=-1`,
  400,
)
await expectStatus(
  'fix6: limit=101 → 400',
  `${APPVIEW_URL}/xrpc/ait.feed.getAuthorFeed?actor=${encodeURIComponent(idA.did)}&limit=101`,
  400,
)

// Fix 8: extra-suffix path must not match the route via prefix. The canonical
// xrpc-server replies 501 MethodNotImplemented for any unknown NSID under
// /xrpc/* (server.js's catchall → `next(new MethodNotImplementedError())`).
// The hand-rolled server used to reply 404 NotFound here; ADR-0037 documents
// that wire-shape change as one of the consequences of moving to canonical
// dispatch.
await expectStatus(
  'fix8: /xrpc/ait.feed.getAuthorFeedExtra → 501',
  `${APPVIEW_URL}/xrpc/ait.feed.getAuthorFeedExtra?actor=${encodeURIComponent(idA.did)}`,
  501,
)

// Fix 9: parser accepts at-uri fragments (records can't carry one, but the
// grammar allows them — the hand-rolled split previously rejected). We
// don't expose the parser directly, but reply() uses it; calling reply
// with a #frag-suffixed parent_uri should still resolve the parent and
// succeed. We use B's reply URI plus a fragment.
const c2 = await spawnMcp('conv-B-2', SESSION_B)
const fragReply = await c2.callTool({
  name: 'reply',
  arguments: {
    parent_uri: `${replyUri}#fragment`,
    text: 'fragment-tolerance check',
  },
})
const fragReplyText = fragReply.content[0].text
assertContains('fix9: fragment URI reply succeeded', fragReplyText, 'URI:')
await c2.close()

// Fix 7: missing or malformed Bearer must return 401 AuthRequired (not 500).
await expectStatus(
  'fix7: getTimeline no auth → 401',
  `${APPVIEW_URL}/xrpc/ait.feed.getTimeline`,
  401,
)
async function expectStatusWithHeader(label, url, headers, expected) {
  const r = await fetch(url, { headers })
  if (r.status !== expected) {
    console.error(`FAIL [${label}]: expected ${expected}, got ${r.status}`)
    console.error('--- body ---\n' + (await r.text()) + '\n---')
    process.exit(1)
  }
  console.log(`ok    [${label}]: ${expected} from ${url}`)
}
await expectStatusWithHeader(
  'fix7: getTimeline garbage bearer → 401',
  `${APPVIEW_URL}/xrpc/ait.feed.getTimeline`,
  { Authorization: 'Bearer notajwt' },
  401,
)
await expectStatusWithHeader(
  'fix7: listNotifications no auth → 401',
  `${APPVIEW_URL}/xrpc/ait.notification.listNotifications`,
  {},
  401,
)
// Fix 7: verifyJwt enforces exp, aud, and sig — checked in that order
// (xrpc-server/dist/auth.js:99-135). Reusing one wrongKey to isolate
// each path: exp and aud throw BEFORE the sig check, so an expired or
// wrong-aud JWT signed by the wrong key still surfaces its intended
// failure mode (not a generic sig failure).
const APPVIEW_DID_CONST = process.env.APPVIEW_DID ?? 'did:plc:aitappview000000000001'
const wrongKey = await Secp256k1Keypair.create()
const wrongSigJwt = await createServiceJwt({
  iss: idA.did,
  aud: APPVIEW_DID_CONST,
  lxm: 'ait.feed.getTimeline',
  keypair: wrongKey,
})
await expectStatusWithHeader(
  'fix7: wrong-sig JWT → 401',
  `${APPVIEW_URL}/xrpc/ait.feed.getTimeline`,
  { Authorization: `Bearer ${wrongSigJwt}` },
  401,
)
const expiredJwt = await createServiceJwt({
  iss: idA.did,
  aud: APPVIEW_DID_CONST,
  lxm: 'ait.feed.getTimeline',
  keypair: wrongKey,
  exp: Math.floor(Date.now() / 1000) - 60,
})
await expectStatusWithHeader(
  'fix7: expired-exp JWT → 401',
  `${APPVIEW_URL}/xrpc/ait.feed.getTimeline`,
  { Authorization: `Bearer ${expiredJwt}` },
  401,
)
const wrongAudJwt = await createServiceJwt({
  iss: idA.did,
  aud: 'did:plc:notthisappview00000000',
  lxm: 'ait.feed.getTimeline',
  keypair: wrongKey,
})
await expectStatusWithHeader(
  'fix7: wrong-aud JWT → 401',
  `${APPVIEW_URL}/xrpc/ait.feed.getTimeline`,
  { Authorization: `Bearer ${wrongAudJwt}` },
  401,
)

// Fix 5: composite (createdAt, uri) cursor returns every record across
// pages even at limit=1. Post 4 more posts from A in tight succession,
// then paginate getAuthorFeed with limit=1 collecting all URIs. The
// collected set must contain P1 plus all 4 new posts (5 distinct URIs).
const c3 = await spawnMcp('conv-A-2', SESSION_A)
const extraUris = [p1Uri]
for (let i = 0; i < 4; i++) {
  const r = await c3.callTool({
    name: 'post',
    arguments: { text: `pagination tick ${i}` },
  })
  extraUris.push(extractUri(r.content[0].text))
}
// Allow firehose+indexer a short window to land all 5 records.
await new Promise((resolve) => setTimeout(resolve, 750))
const seen = new Set()
let cursor
for (let page = 0; page < 10; page++) {
  const q = new URLSearchParams({
    actor: idA.did,
    limit: '1',
  })
  if (cursor) q.set('cursor', cursor)
  const r = await fetch(`${APPVIEW_URL}/xrpc/ait.feed.getAuthorFeed?${q}`)
  if (!r.ok) {
    console.error(`FAIL [fix5: page ${page} fetch]: ${r.status}`)
    console.error('--- body ---\n' + (await r.text()))
    process.exit(1)
  }
  const body = await r.json()
  for (const item of body.feed) seen.add(item.post.uri)
  cursor = body.cursor
  if (!cursor) break
}
await c3.close()
const missing = extraUris.filter((u) => !seen.has(u))
if (missing.length > 0) {
  console.error(`FAIL [fix5: pagination total]: missing ${missing.length} of ${extraUris.length} URIs`)
  console.error('missing:', missing)
  console.error('seen:', [...seen])
  process.exit(1)
}
console.log(`ok    [fix5: pagination total]: all ${extraUris.length} URIs returned across limit=1 pages`)

// Fix 13: when both accessJwt and refreshJwt are stale (server-side
// session revoked, refresh JWT corrupted, etc.) the writers and readers
// must re-login with the stored password and retry once, not surface
// 401. Procedure: join a fresh handle, corrupt the on-disk JWTs (keep
// the password intact), spawn a new MCP child against the same session
// UUID, and call both a writer (post) and a reader (listNotifications).
// Both must succeed and the on-disk JWTs must be rewritten.
const SESSION_C = randomUUID()
const cFix13a = await spawnMcp('conv-Fix13-a', SESSION_C)
const jFix13 = await cFix13a.callTool({
  name: 'join',
  arguments: { handle_hint: `fix13${STAMP}` },
})
const idFix13 = extractIds(jFix13.content[0].text)
await cFix13a.close()

// Set the env the storage module reads at import time, then load the
// just-persisted identity, replace its JWTs with structurally-valid
// garbage that fails resumeSession AND refreshSession, and write back.
// The password remains intact so loginWithStoredCredentials can recover.
process.env.XDG_DATA_HOME = XDG_TMP
process.env.AIT_MCP_TEST_SESSION_ID = SESSION_C
const storage = await import('../dist/storage.js')
const persisted = storage.loadIdentity()
if (!persisted || persisted.did !== idFix13.did) {
  console.error('FAIL [fix13 precondition: loadIdentity for fresh handle]')
  console.error('persisted:', persisted)
  process.exit(1)
}
const GARBAGE_JWT =
  'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJnYXJiYWdlIn0.garbagesigbytes'
storage.saveIdentity({
  did: persisted.did,
  handle: persisted.handle,
  password: persisted.password,
  accessJwt: GARBAGE_JWT,
  refreshJwt: GARBAGE_JWT,
})
delete process.env.AIT_MCP_TEST_SESSION_ID

const cFix13b = await spawnMcp('conv-Fix13-b', SESSION_C)
const postRetry = await cFix13b.callTool({
  name: 'post',
  arguments: { text: 'fix13 retry probe' },
})
const retryUri = extractUri(postRetry.content[0].text)
if (!retryUri) {
  console.error('FAIL [fix13: post after stale JWTs did not surface a URI]')
  console.error('content:', postRetry.content[0].text)
  process.exit(1)
}
console.log(
  `ok    [fix13: post re-login retry]: post landed at ${retryUri.slice(0, 60)}`,
)
const notifsRetry = await cFix13b.callTool({
  name: 'listNotifications',
  arguments: {},
})
if (!notifsRetry.content[0].text.length) {
  console.error('FAIL [fix13: listNotifications after stale JWTs returned empty content]')
  process.exit(1)
}
console.log('ok    [fix13: listNotifications re-login retry]')
await cFix13b.close()

process.env.AIT_MCP_TEST_SESSION_ID = SESSION_C
const reloaded = storage.loadIdentity()
delete process.env.AIT_MCP_TEST_SESSION_ID
if (!reloaded || reloaded.accessJwt === GARBAGE_JWT || reloaded.refreshJwt === GARBAGE_JWT) {
  console.error('FAIL [fix13: re-login did not persist fresh JWTs to disk]')
  console.error('reloaded:', reloaded)
  process.exit(1)
}
console.log('ok    [fix13: fresh JWTs persisted on disk after re-login]')

console.log('\nconversation-loop smoke test PASSED')
