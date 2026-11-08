// Codex sink behaviour:
//   - cursor boundary: acceptance is not delivery. The opaque AppView cursor
//     commits only after the matching successful completion, including when
//     completion races ahead of the turn/start response.
//   - batching: pending notifications ride ONE turn, not one turn each.
//   - steering: while a turn is running, notifications join it rather than
//     waiting for it to end.

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
  closed = []
  isClosed = false
  onClose(fn) { this.closed.push(fn) }
  close() { this.isClosed = true; this.completed.length = 0; for (const fn of this.closed.splice(0)) fn() }
  starts = []
  steers = []
  early = false
  running = null // id of a turn already in flight, or null when idle
  steerFails = false
  onSteerFail = null

  activeTurnId() { return this.running }
  onTurnCompleted(fn) { this.completed.push(fn) }

  async turnStart(threadId, text) {
    const id = `turn-${this.starts.length + 1}`
    this.starts.push({ threadId, text, id })
    if (this.early) this.emit(threadId, id, 'completed')
    return id
  }

  async turnSteer(threadId, expectedTurnId, text) {
    if (this.steerFails) {
      // Lets a case model "the turn ended during the call" by clearing running.
      this.onSteerFail?.()
      throw new Error('expectedTurnId is not the active turn')
    }
    this.steers.push({ threadId, expectedTurnId, text })
    return expectedTurnId
  }

  emit(threadId, id, status) {
    for (const fn of this.completed) fn({ threadId, turn: { id, status } })
  }

  complete(index, status = 'completed') {
    const turn = this.starts[index]
    this.emit(turn.threadId, turn.id, status)
  }
}

const view = (uri, cursor) => ({
  uri,
  cid: 'cid',
  author: { did: 'did:plc:author', handle: 'author.iq3l5t4vuaat4l2zbzjrkoryccobcfi4s5pujtcmtsqen6vf6jea.aitproto.com' },
  reason: 'mention',
  reasonSubject: uri,
  record: { text: 'ping' },
  indexedAt: '2026-07-16T00:00:00.000Z',
  cursor,
})
const tick = () => new Promise((resolve) => setImmediate(resolve))
const checkpoint = () => storage.getNotificationRegistrationCheckpoint().value

let failures = 0
const check = (label, condition) => {
  if (condition) console.log(`ok    ${label}`)
  else { console.error(`FAIL  ${label}`); failures++ }
}

const client = new FakeClient()
const deliver = createCodexSink(client, 'thread-1')

await deliver(view('at://one', 'cursor-1'))
await tick()
check('(a.1) notification author is friendly and body/URI remain original',
  client.starts[0].text.includes('@author mentioned you:') &&
  client.starts[0].text.includes('> ping') && client.starts[0].text.includes('uri=at://one') &&
  !client.starts[0].text.includes('iq3l5t4vuaat4l2zbzjrkoryccobcfi4s5pujtcmtsqen6vf6jea'))
check('(a) turn/start ACK does not commit', checkpoint() === 'cursor-0')
client.complete(0)
check('(b) matching successful completion commits', checkpoint() === 'cursor-1')

client.early = true
await deliver(view('at://two', 'cursor-2'))
await tick()
check('(c) completion-before-response race commits', checkpoint() === 'cursor-2')

client.early = false
await deliver(view('at://three', 'cursor-3'))
await tick()
client.complete(2, 'failed')
check('(d) failed completion does not commit', checkpoint() === 'cursor-2')
await new Promise((resolve) => setTimeout(resolve, 3100))
check('(d.2) failed batch retries', client.starts.length === 4)
client.complete(3)
check('(d.3) successful retry commits retained batch', checkpoint() === 'cursor-3')

// --- batching -----------------------------------------------------------------
// Three notifications arrive while turn-5 is in flight. They must leave as ONE
// turn when it completes, not three.
const startsBefore = client.starts.length
await deliver(view('at://four', 'cursor-4'))
await tick()
check('(e) first notification opens a turn', client.starts.length === startsBefore + 1)
await deliver(view('at://five', 'cursor-5'))
await deliver(view('at://six', 'cursor-6'))
await tick()
check('(e.2) notifications during a turn do not open more turns',
  client.starts.length === startsBefore + 1)
client.complete(startsBefore) // turn carrying 'four' completes
await tick()
check('(e.3) the backlog leaves as one turn, not two',
  client.starts.length === startsBefore + 2)
const batched = client.starts[startsBefore + 1].text
check('(e.4) that turn carries both notifications',
  batched.includes('at://five') && batched.includes('at://six'))
check('(e.5) batch is not committed before completion', checkpoint() === 'cursor-4')
client.complete(startsBefore + 1)
check('(e.6) a batch commits its newest cursor', checkpoint() === 'cursor-6')

// --- steering -----------------------------------------------------------------
// A turn the sink did not start is running (host.ts's opening prompt is one).
// Notifications must join it rather than wait.
client.running = 'operator-turn'
await deliver(view('at://seven', 'cursor-7'))
await tick()
check('(f) a notification steers into the running turn', client.steers.length === 1)
check('(f.2) steering opens no new turn', client.starts.length === startsBefore + 2)
check('(f.3) the steer names the running turn as its precondition',
  client.steers[0].expectedTurnId === 'operator-turn')
check('(f.4) steered input is not committed on acceptance', checkpoint() === 'cursor-6')
client.running = null
client.emit('thread-1', 'operator-turn', 'completed')
check('(f.5) the steered turn completing commits it', checkpoint() === 'cursor-7')

// A long turn must keep taking notifications, not just its first. This is the
// whole point: one steer per turn would leave everything after it waiting out
// the turn, which is the pileup being fixed.
client.running = 'long-turn'
const steersBefore = client.steers.length
for (const [uri, cursor] of [['at://s1', 'cursor-s1'], ['at://s2', 'cursor-s2'], ['at://s3', 'cursor-s3']]) {
  await deliver(view(uri, cursor))
  await tick()
}
check('(h) every notification during a turn steers into it, not just the first',
  client.steers.length === steersBefore + 3)
check('(h.2) none of them opened a turn', client.starts.length === startsBefore + 2)
client.running = null
client.emit('thread-1', 'long-turn', 'completed')
check('(h.3) the turn completing commits the newest of them',
  checkpoint() === 'cursor-s3')

// A steer that loses its race — the turn ended mid-call — starts a turn instead.
client.running = 'stale-turn'
client.steerFails = true
const beforeFallback = client.starts.length
client.onSteerFail = () => { client.running = null } // the turn ended
await deliver(view('at://eight', 'cursor-8'))
await tick()
check('(g) a steer whose turn vanished falls back to turn/start',
  client.starts.length === beforeFallback + 1)
client.complete(beforeFallback)
check('(g.2) the fallback turn commits', checkpoint() === 'cursor-8')

// A turn that refuses steering (review, compact) refuses turn/start for the
// same reason, so the batch waits rather than failing twice.
client.running = 'review-turn'
client.steerFails = true
client.onSteerFail = null // the turn is still there
const beforeRefusal = client.starts.length
await deliver(view('at://nine', 'cursor-9'))
await tick()
check('(i) a non-steerable turn does not get a turn/start too',
  client.starts.length === beforeRefusal)
check('(i.2) and the notification is not committed', checkpoint() === 'cursor-8')
client.steerFails = false
await new Promise((resolve) => setTimeout(resolve, 3100))
check('(i.3) it retries once the turn accepts input again',
  client.steers.some((s) => s.text.includes('at://nine')))
client.running = null
client.emit('thread-1', 'review-turn', 'completed')
check('(i.4) and commits when that turn ends', checkpoint() === 'cursor-9')

// A rejection must wait on the existing delay, not recurse through microtasks.
// A second attempt blocks so reverting the fix fails boundedly, never spins.
client.close()
const timeoutCount = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
const baselineTimers = timeoutCount()
const rejected = new FakeClient()
let rejectedCalls = 0
rejected.turnStart = async () => {
  rejectedCalls++
  if (rejectedCalls > 1) return new Promise(() => {})
  throw new Error('fixture transient rejection')
}
const rejectedSink = createCodexSink(rejected, 'retirement')
await rejectedSink(view('at://retirement-retry', 'cursor-retirement'))
await tick()
check('(j) rejected injection waits instead of immediately retrying', rejectedCalls === 1)
check('(j.2) exactly one retry timer belongs to this live sink', timeoutCount() === baselineTimers + 1)
rejected.close()
await tick()
check('(j.3) closing the connection releases its retry timer', timeoutCount() === baselineTimers)
check('(j.4) closing releases completion and close listeners', rejected.completed.length === 0 && rejected.closed.length === 0)
let refusedClosed = false
try { await rejectedSink(view('at://after-close', 'must-not-commit')) } catch { refusedClosed = true }
check('(j.5) post-close HTTP delivery can be rejected for replay', refusedClosed)
check('(j.6) closing never advances the persisted checkpoint', checkpoint() === 'cursor-9')

const retired = new FakeClient()
const retiredSink = createCodexSink(retired, 'retirement')
await retiredSink(view('at://retirement-late', 'old-cursor'))
await tick()
const lateCompletion = retired.completed[0]
retired.close()
const replacement = new FakeClient()
const replay = createCodexSink(replacement, 'retirement')
await replay(view('at://retirement-late', 'replacement-cursor'))
await tick()
replacement.complete(0)
check('(k) replacement sink replays the same URI and commits on completion', checkpoint() === 'replacement-cursor')
lateCompletion({ threadId: 'retirement', turn: { id: 'turn-1', status: 'completed' } })
check('(k.2) late retired completion cannot regress the replacement cursor', checkpoint() === 'replacement-cursor')
replacement.close()

const duringSend = new FakeClient()
let finishSend
const pendingSend = new Promise((resolve) => { finishSend = resolve })
duringSend.turnStart = () => pendingSend
const duringSendSink = createCodexSink(duringSend, 'retirement')
await duringSendSink(view('at://retirement-inflight', 'pending-cursor'))
const lateDuringSend = duringSend.completed[0]
duringSend.close()
finishSend('late-turn')
await tick()
lateDuringSend({ threadId: 'retirement', turn: { id: 'late-turn', status: 'completed' } })
check('(l) close during send prevents a late response/completion commit', checkpoint() === 'replacement-cursor')
check('(l.2) closed sends leave no retry timer', timeoutCount() === baselineTimers)

// A notification-bearing turn fails while a second notification is steering
// into it. The next accepted turn must carry the old batch before the new one,
// whether the first replacement start succeeds or is itself rejected.
for (const rejectReplacement of [false, true]) {
  const label = rejectReplacement ? 'replacement-rejected' : 'replacement-accepted'
  const racing = new FakeClient()
  const racingSink = createCodexSink(racing, 'racing-thread')
  const beforeRace = checkpoint()
  const first = view(`at://${label}-n1`, `${label}-cursor-1`)
  const second = view(`at://${label}-n2`, `${label}-cursor-2`)
  await racingSink(first)
  await tick()
  racing.running = racing.starts[0].id
  racing.steerFails = true
  racing.onSteerFail = () => {
    racing.running = null
    racing.complete(0, 'failed')
  }
  const start = racing.turnStart.bind(racing)
  const attempts = []
  const cursors = [checkpoint()]
  let accepted
  const replacementAccepted = new Promise((resolve) => { accepted = resolve })
  racing.turnStart = async (thread, text) => {
    attempts.push({ text, checkpoint: checkpoint() })
    if (rejectReplacement && attempts.length === 1) throw new Error('fixture replacement rejection')
    const id = await start(thread, text)
    accepted(id)
    return id
  }
  await racingSink(second)
  await tick()
  cursors.push(checkpoint())
  let deadline
  try {
    await Promise.race([
      replacementAccepted,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('replacement stalled')), 8000) }),
    ])
    await tick()
    cursors.push(checkpoint())
    check(`(m ${label}) retry includes n1 before n2`, attempts.every(({ text }) =>
      text.includes(first.uri) && text.indexOf(first.uri) < text.indexOf(second.uri)))
    check(`(m ${label}.2) replacement rejection cannot strand the batch`, attempts.length === (rejectReplacement ? 2 : 1))
    check(`(m ${label}.3) no acceptance or failed turn skips the old cursor`,
      cursors.every((cursor) => cursor === beforeRace) && attempts.every((attempt) => attempt.checkpoint === beforeRace))
    racing.complete(1)
    cursors.push(checkpoint())
    check(`(m ${label}.4) cursor advances to n2 only after both were delivered`,
      checkpoint() === second.cursor && racing.starts[1].text.includes(first.uri))
    console.log(`cursor sequence ${label}: ${JSON.stringify(cursors)}`)
  } catch (err) {
    check(`(m ${label}) replacement completes: ${err.message}`, false)
  } finally {
    clearTimeout(deadline)
    racing.close()
  }
}

rmSync(target)
rmSync(process.env.XDG_DATA_HOME, { recursive: true, force: true })
if (failures) process.exit(1)
console.log('\nall ok')
