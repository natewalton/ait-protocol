// Codex sink cursor boundary: turn/start acceptance is not delivery. The
// opaque AppView cursor commits only after the matching successful completion,
// including when completion races ahead of the turn/start response.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SESSION = randomUUID()
process.env.AIT_MCP_TEST_SESSION_ID = SESSION
delete process.env.CLAUDE_PROJECT_DIR
process.env.XDG_DATA_HOME = join(tmpdir(), `ait-sink-test-${SESSION}`)

const target = join(
  process.env.XDG_DATA_HOME,
  'ait-mcp',
  `identity-${createHash('sha256').update(SESSION).digest('hex').slice(0, 16)}.json`,
)
if (existsSync(target)) rmSync(target)

const storage = await import('../dist/storage.js')
const { createCodexSink } = await import('../dist/codex/sink.js')

storage.saveIdentity({
  did: 'did:plc:sinktest',
  handle: 'sinktest.test',
  password: 'pw',
  accessJwt: 'access',
  refreshJwt: 'refresh',
})
storage.compareAndSwapNotificationCursor(null, 'cursor-0')

class FakeClient {
  completed = []
  starts = []
  early = false

  isTurnActive() { return false }
  onTurnCompleted(fn) { this.completed.push(fn) }
  async turnStart(threadId, text) {
    const id = `turn-${this.starts.length + 1}`
    this.starts.push({ threadId, text, id })
    if (this.early) {
      for (const fn of this.completed) {
        fn({ threadId, turn: { id, status: 'completed' } })
      }
    }
    return id
  }
  complete(index, status = 'completed') {
    const turn = this.starts[index]
    for (const fn of this.completed) {
      fn({ threadId: turn.threadId, turn: { id: turn.id, status } })
    }
  }
}

const view = (uri, cursor) => ({
  uri,
  cid: 'cid',
  author: { did: 'did:plc:author', handle: 'author.test' },
  reason: 'mention',
  reasonSubject: uri,
  record: { text: 'ping' },
  indexedAt: '2026-07-16T00:00:00.000Z',
  cursor,
})
const tick = () => new Promise((resolve) => setImmediate(resolve))

let failures = 0
const check = (label, condition) => {
  if (condition) console.log(`ok    ${label}`)
  else { console.error(`FAIL  ${label}`); failures++ }
}

const client = new FakeClient()
const deliver = createCodexSink(client, 'thread-1')
await deliver(view('at://one', 'cursor-1'))
await tick()
check(
  '(a) turn/start ACK does not commit',
  storage.getNotificationRegistrationCheckpoint().value === 'cursor-0',
)
client.complete(0)
check(
  '(b) matching successful completion commits',
  storage.getNotificationRegistrationCheckpoint().value === 'cursor-1',
)

client.early = true
await deliver(view('at://two', 'cursor-2'))
await tick()
check(
  '(c) completion-before-response race commits',
  storage.getNotificationRegistrationCheckpoint().value === 'cursor-2',
)

client.early = false
await deliver(view('at://three', 'cursor-3'))
await tick()
client.complete(2, 'failed')
check(
  '(d) failed completion does not commit',
  storage.getNotificationRegistrationCheckpoint().value === 'cursor-2',
)
await new Promise((resolve) => setTimeout(resolve, 3100))
check('(d.2) failed queue head retries', client.starts.length === 4)
client.complete(3)
check(
  '(d.3) successful retry commits retained head',
  storage.getNotificationRegistrationCheckpoint().value === 'cursor-3',
)

rmSync(target)
rmSync(process.env.XDG_DATA_HOME, { recursive: true, force: true })
if (failures) process.exit(1)
console.log('\nall ok')
