// Focused offline smoke for the MCP push-mode runtime (step 6 of
// specs/notification-push.md). Verifies the POST /notify path end-to-end
// without standing up the PDS or AppView:
//   (a) MCP in push mode opens a 127.0.0.1 listener and logs its URL to stderr
//   (b) MCP declares the experimental.claude/channel capability
//   (c) POSTing a NotificationView to /notify causes the MCP to emit a
//       notifications/claude/channel notification to the connected client
//   (d) The emitted content/meta match the spec's formatters (reason, author,
//       indexed_at, uri, in_reply_to; 'followed you' body for follow events)
//   (e) The notify handler advances lastSeenNotificationAt on disk
//   (f) The handler 404s wrong paths/methods
// Identity is pre-seeded so the MCP has a DID at startup; the tryRegister
// call will fail noisily (no real PDS) — that's expected and orthogonal.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const MCP_SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'server.js',
)

const SESSION = randomUUID()
const STORAGE_DIR = join(homedir(), '.local', 'share', 'ait-mcp')
const IDENT_PATH = join(
  STORAGE_DIR,
  `identity-${createHash('sha256').update(SESSION).digest('hex').slice(0, 16)}.json`,
)

mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 })

// Stub identity. The ciphertext won't decrypt — that's fine: push mode
// startup only reads the plaintext outer (did, cursor) for register, and
// the notify handler doesn't touch identity at all.
writeFileSync(
  IDENT_PATH,
  JSON.stringify(
    {
      did: 'did:plc:teststub',
      handle: 'pushtest.test',
      createdAt: '2026-05-29T00:00:00.000Z',
      lastSeenNotificationAt: null,
      ciphertext: Buffer.alloc(32).toString('base64'),
      nonce: Buffer.alloc(12).toString('base64'),
      tag: Buffer.alloc(16).toString('base64'),
    },
    null,
    2,
  ),
  { mode: 0o600 },
)

const env = { ...process.env }
delete env.CLAUDE_PROJECT_DIR
env.AIT_MCP_TEST_SESSION_ID = SESSION
env.AIT_NOTIFICATION_MODE = 'push'
env.PDS_URL = 'http://127.0.0.1:1' // unreachable; we expect tryRegister to fail
env.APPVIEW_DID = 'did:plc:aitappview000000000001'

// Capture stderr so we can pluck the listener URL out of the startup line.
const stderrChunks = []
const transport = new StdioClientTransport({
  command: 'node',
  args: ['--enable-source-maps', MCP_SERVER],
  env,
  stderr: 'pipe',
})
const client = new Client({ name: 'push-mode-test', version: '0.0.0' })

await client.connect(transport)

transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk.toString()))

// Wait for the listener URL line to appear (max ~3s).
let listenerUrl = null
for (let i = 0; i < 30 && !listenerUrl; i++) {
  await delay(100)
  const match = stderrChunks.join('').match(/ait push listener: (\S+)/)
  if (match) listenerUrl = match[1]
}

let failures = 0
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`ok    ${label}`)
  } else {
    console.error(`FAIL  ${label} ${detail}`)
    failures++
  }
}

check('(a) listener URL emitted to stderr', !!listenerUrl, stderrChunks.join('').slice(0, 200))

if (!listenerUrl) {
  console.error('cannot proceed without listener URL')
  await client.close()
  rmSync(IDENT_PATH)
  process.exit(1)
}

// (b) capability check — channel cap appears in server capabilities
const caps = client.getServerCapabilities()
check(
  '(b) experimental.claude/channel capability declared',
  caps?.experimental?.['claude/channel'] !== undefined,
  JSON.stringify(caps?.experimental ?? {}),
)

// (c) + (d) wire a notification handler and POST a synthetic view
const seenChannels = []
client.fallbackNotificationHandler = async (notification) => {
  if (notification.method === 'notifications/claude/channel') {
    seenChannels.push(notification.params)
  }
}

const mentionView = {
  uri: 'at://did:plc:bob/ait.feed.post/abc',
  cid: 'cid-abc',
  author: { did: 'did:plc:bob', handle: 'bob.test' },
  reason: 'mention',
  reasonSubject: 'at://did:plc:bob/ait.feed.post/abc',
  record: { text: 'hey @pushtest.test, you around?' },
  indexedAt: '2026-05-29T16:30:00.000Z',
}

const postRes = await fetch(listenerUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(mentionView),
})
check('(c) /notify POST returns 200', postRes.status === 200)

// Let the channel notification propagate to the client.
for (let i = 0; i < 20 && seenChannels.length === 0; i++) await delay(50)

check('(c) client received exactly one channel notification', seenChannels.length === 1)
const got = seenChannels[0]
check('(d) content is the post text', got?.content === mentionView.record.text)
check('(d) meta.reason = mention', got?.meta?.reason === 'mention')
check('(d) meta.author = @bob.test', got?.meta?.author === '@bob.test')
check('(d) meta.indexed_at matches', got?.meta?.indexed_at === mentionView.indexedAt)
check('(d) meta.uri matches', got?.meta?.uri === mentionView.uri)
check('(d) meta.in_reply_to matches reasonSubject', got?.meta?.in_reply_to === mentionView.reasonSubject)

// Follow-reason emits the canned 'followed you' body.
const followView = {
  uri: 'at://did:plc:carol/ait.graph.follow/xyz',
  cid: 'cid-xyz',
  author: { did: 'did:plc:carol', handle: 'carol.test' },
  reason: 'follow',
  record: null,
  indexedAt: '2026-05-29T16:31:00.000Z',
}
seenChannels.length = 0
await fetch(listenerUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(followView),
})
for (let i = 0; i < 20 && seenChannels.length === 0; i++) await delay(50)
check('(d) follow content is canned "followed you"', seenChannels[0]?.content === 'followed you')
check('(d) follow omits in_reply_to', seenChannels[0]?.meta?.in_reply_to === undefined)

// (e) cursor on disk advanced to the most recent indexedAt
const storage = await import('../dist/storage.js')
process.env.AIT_MCP_TEST_SESSION_ID = SESSION
delete process.env.CLAUDE_PROJECT_DIR
const cursor = storage.getLastSeenNotificationAt()
check('(e) cursor advanced to latest indexedAt', cursor === followView.indexedAt, `got ${cursor}`)

// (f) wrong method + wrong path both 404
const wrongMethod = await fetch(listenerUrl, { method: 'GET' })
check('(f) GET /notify is 404', wrongMethod.status === 404)
const wrongPath = await fetch(listenerUrl.replace('/notify', '/other'), {
  method: 'POST',
  body: '{}',
})
check('(f) POST /other is 404', wrongPath.status === 404)

await client.close()
rmSync(IDENT_PATH)

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall ok')
