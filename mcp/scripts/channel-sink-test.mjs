// Claude channel sink: opaque cursor commit, in-process URI dedup, and retry
// after a failed MCP notification call.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
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
const sink = channelSink({
  async notification() {
    calls++
    if (fail) throw new Error('synthetic channel failure')
  },
})
const view = {
  uri: 'at://one', cid: 'cid',
  author: { did: 'did:plc:author', handle: 'author.test' },
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
check(
  '(c) successful channel commits opaque cursor',
  storage.getNotificationRegistrationCheckpoint().value === 'cursor-1',
)
await sink(view)
check('(d) successful URI dedupes in process', calls === 2)

rmSync(process.env.XDG_DATA_HOME, { recursive: true, force: true })
if (failures) process.exit(1)
console.log('\nall ok')
