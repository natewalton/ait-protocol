// Claude channel sink: opaque cursor commit, in-process URI dedup, and retry
// after a failed MCP notification call.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SESSION = randomUUID()
process.env.AIT_MCP_TEST_SESSION_ID = SESSION
process.env.XDG_DATA_HOME = join(tmpdir(), `ait-channel-test-${SESSION}`)
delete process.env.CLAUDE_PROJECT_DIR

const target = join(
  process.env.XDG_DATA_HOME,
  'ait-mcp',
  `identity-${createHash('sha256').update(SESSION).digest('hex').slice(0, 16)}.json`,
)
if (existsSync(target)) rmSync(target)

const storage = await import('../dist/storage.js')
const { channelSink } = await import('../dist/push.js')
storage.saveIdentity({
  did: 'did:plc:channeltest', handle: 'channeltest.test', password: 'pw',
  accessJwt: 'access', refreshJwt: 'refresh',
})
storage.compareAndSwapNotificationCursor(null, 'cursor-0')

let calls = 0
let fail = true
let notification
const sink = channelSink({
  async notification(value) {
    notification = value
    calls++
    if (fail) throw new Error('synthetic channel failure')
  },
})
const view = {
  uri: 'at://one', cid: 'cid',
  author: { did: 'did:plc:author', handle: 'author.iq3l5t4vuaat4l2zbzjrkoryccobcfi4s5pujtcmtsqen6vf6jea.aitproto.com' },
  reason: 'mention', reasonSubject: 'at://one', record: { text: 'ping' },
  indexedAt: '2026-07-16T00:00:00.000Z', cursor: 'cursor-1',
}

let failures = 0
const check = (label, condition) => {
  if (condition) console.log(`ok    ${label}`)
  else { console.error(`FAIL  ${label}`); failures++ }
}

await sink(view).catch(() => {})
check(
  '(a) failed channel does not commit',
  storage.getNotificationRegistrationCheckpoint().value === 'cursor-0',
)
fail = false
await sink(view)
check('(b) replay retries same URI after failure', calls === 2)
check('(b.2) author is friendly; body and delivery metadata stay original',
  notification.params.meta.author === '@author' &&
  notification.params.meta.author_handle === view.author.handle &&
  notification.params.meta.author_did === view.author.did &&
  notification.params.content === 'ping' &&
  notification.params.meta.uri === view.uri &&
  notification.params.meta.in_reply_to === view.reasonSubject &&
  notification.params.meta.indexed_at === view.indexedAt)
check(
  '(c) successful channel commits opaque cursor',
  storage.getNotificationRegistrationCheckpoint().value === 'cursor-1',
)
await sink(view)
check('(d) successful URI dedupes in process', calls === 2)

// Handover during the awaited channel write must leave the durable cursor for
// the new runtime, even if the old transport accepted the notification.
delete process.env.AIT_MCP_TEST_SESSION_ID
process.env.CLAUDE_CODE_SESSION_ID = SESSION
process.env.CLAUDE_CONFIG_DIR = join(process.env.XDG_DATA_HOME, 'claude')
const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture')
mkdirSync(project, { recursive: true })
const transcript = join(project, `${SESSION}.jsonl`)
writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: SESSION }) + '\n')
const lateSink = channelSink({
  async notification() {
    appendFileSync(transcript, JSON.stringify({ type: 'continued-in', sessionId: SESSION, continuedInSessionId: randomUUID() }) + '\n')
  },
})
let retired = false
await lateSink({ ...view, uri: 'at://late', cursor: 'must-not-commit' }).catch(() => { retired = true })
check('(e) handover during channel write does not commit the old cursor', retired && storage.getNotificationRegistrationCheckpoint().value === 'cursor-1')

rmSync(process.env.XDG_DATA_HOME, { recursive: true, force: true })
if (failures) process.exit(1)
console.log('\nall ok')
