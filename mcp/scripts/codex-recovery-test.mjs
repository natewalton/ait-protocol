#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-codex-recovery-'))
process.env.AIT_MCP_TEST_SESSION_ID = randomUUID()
process.env.XDG_DATA_HOME = path.join(root, 'xdg')
delete process.env.CLAUDE_PROJECT_DIR

const storage = await import('../dist/storage.js')
const session = await import('../dist/session.js')
const push = await import('../dist/push.js')
const { AppServerClient } = await import('../dist/codex/appServerClient.js')

storage.saveIdentity({
  did: 'did:plc:recoverytest',
  handle: 'recovery.test',
  password: 'pw',
  accessJwt: 'access',
  refreshJwt: 'refresh',
})
session.setIdentity(storage.loadIdentity())
const checkpoint = () => storage.getNotificationRegistrationCheckpoint().value
const deliveryBoundaries = []
const assertCursorUnchanged = (boundary, before) => {
  const after = checkpoint()
  assert.equal(after, before, `${boundary} advanced the cursor`)
  deliveryBoundaries.push({ boundary, cursorBefore: before, cursorAfter: after })
}

let outstanding = 0
let aborted = 0
const hangingRegistration = async (_nsid, opts) => {
  outstanding++
  return new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      outstanding--
      aborted++
      reject(opts.signal.reason ?? new Error('aborted'))
    }, { once: true })
  })
}

let listenerLine = ''
const originalError = console.error
console.error = (...args) => {
  const line = args.map(String).join(' ')
  if (line.startsWith('ait push listener:')) listenerLine = line
}
await push.startPushListener(
  async () => { throw new Error('Codex notification sink unavailable') },
  () => false,
)
const registrationCursor = checkpoint()
await push.tryRegister(() => true, hangingRegistration, 25)
assert.equal(aborted, 1, 'hung registration must be aborted')
assert.equal(outstanding, 0, 'aborted registration must release its request')
assertCursorUnchanged('appview request timeout', registrationCursor)
let secondBeat = 0
await push.tryRegister(
  () => true,
  async () => { secondBeat++; return { status: 'ok', cursor: 'cursor-1' } },
  25,
)
assert.equal(secondBeat, 1, 'a later registration beat must still run')

const listenerUrl = listenerLine.match(/ait push listener: (\S+)/)?.[1]
assert.ok(listenerUrl, 'push listener URL missing')
const nullSinkCursor = checkpoint()
const pendingForReplay = notification('at://null-sink', 'cursor-null')
const unavailable = await fetch(listenerUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(pendingForReplay),
})
assert.equal(unavailable.status, 500, 'an unavailable sink must make AppView retry')
assertCursorUnchanged('notification received without an active sink', nullSinkCursor)
await push.stopPushListener()

let replayListenerLine = ''
const replayed = []
console.error = (...args) => {
  const line = args.map(String).join(' ')
  if (line.startsWith('ait push listener:')) replayListenerLine = line
}
await push.startPushListener(async (view) => { replayed.push(view.uri) }, () => false)
const replayListenerUrl = replayListenerLine.match(/ait push listener: (\S+)/)?.[1]
assert.ok(replayListenerUrl, 'replacement push listener URL missing')
await push.tryRegister(
  () => true,
  async () => {
    const response = await fetch(replayListenerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pendingForReplay),
    })
    assert.equal(response.status, 200, 'replacement listener refused replay')
    return { status: 'ok', cursor: checkpoint() }
  },
  25,
)
assert.deepEqual(replayed, ['at://null-sink'], 'next registration did not replay null-sink delivery')
await push.stopPushListener()
console.error = originalError
console.log('ok - a hung registration is cancelled and the next beat runs')

const { createCodexSink } = await import('../dist/codex/sink.js')
storage.compareAndSwapNotificationCursor('cursor-1', 'cursor-0')
class DeliveryClient {
  completions = []
  closed = []
  isClosed = false
  onClose(fn) { this.closed.push(fn) }
  close() { this.isClosed = true; this.completions.length = 0; for (const fn of this.closed.splice(0)) fn() }
  starts = []
  rejectNext = false
  activeTurnId() { return null }
  onTurnCompleted(listener) { this.completions.push(listener) }
  async turnStart(threadId, text) {
    if (this.rejectNext) {
      this.rejectNext = false
      this.close()
      throw new Error('transport closed')
    }
    const id = `turn-${this.starts.length + 1}`
    this.starts.push({ threadId, text, id })
    return id
  }
  async turnSteer() { throw new Error('unexpected steer') }
  complete(index, status = 'completed') {
    const turn = this.starts[index]
    for (const listener of this.completions) {
      listener({ threadId: turn.threadId, turn: { id: turn.id, status } })
    }
  }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

const ambiguousClient = new DeliveryClient()
const abandonedSink = createCodexSink(ambiguousClient, 'same-thread')
const ambiguousCursor = checkpoint()
await abandonedSink(notification('at://ambiguous', 'cursor-ambiguous'))
await tick()
assertCursorUnchanged('app-server acceptance without turn completion', ambiguousCursor)
const replacementClient = new DeliveryClient()
const replacementSink = createCodexSink(replacementClient, 'same-thread')
await replacementSink(notification('at://ambiguous', 'cursor-ambiguous'))
await tick()
replacementClient.complete(0)
assert.equal(checkpoint(), 'cursor-ambiguous', 'replacement sink did not commit replay')

const failedClient = new DeliveryClient()
const failedSink = createCodexSink(failedClient, 'same-thread')
const failedCursor = checkpoint()
await failedSink(notification('at://failed', 'cursor-failed'))
await tick()
failedClient.complete(0, 'failed')
assertCursorUnchanged('failed delivery turn', failedCursor)
const postFailureClient = new DeliveryClient()
const postFailureSink = createCodexSink(postFailureClient, 'same-thread')
await postFailureSink(notification('at://failed', 'cursor-failed'))
await tick()
postFailureClient.complete(0)
assert.equal(checkpoint(), 'cursor-failed', 'failed turn was suppressed after replacement')

const closedClient = new DeliveryClient()
closedClient.rejectNext = true
const closedSink = createCodexSink(closedClient, 'same-thread')
const closedCursor = checkpoint()
await closedSink(notification('at://closed', 'cursor-closed'))
await tick()
assertCursorUnchanged('closed app-server transport', closedCursor)
const postCloseClient = new DeliveryClient()
const postCloseSink = createCodexSink(postCloseClient, 'same-thread')
await postCloseSink(notification('at://closed', 'cursor-closed'))
await tick()
postCloseClient.complete(0)
assert.equal(checkpoint(), 'cursor-closed', 'closed transport notification did not replay')

const exitingClient = new DeliveryClient()
const exitingSink = createCodexSink(exitingClient, 'same-thread')
const exitCursor = checkpoint()
await exitingSink(notification('at://exit', 'cursor-exit'))
await tick()
assertCursorUnchanged('session exit before turn completion', exitCursor)
const postExitClient = new DeliveryClient()
const postExitSink = createCodexSink(postExitClient, 'same-thread')
await postExitSink(notification('at://exit', 'cursor-exit'))
await tick()
postExitClient.complete(0)
assert.equal(checkpoint(), 'cursor-exit', 'session-exit notification did not replay')
assert.equal(deliveryBoundaries.length, 6, 'delivery boundary table is incomplete')
for (const client of [ambiguousClient, replacementClient, failedClient, postFailureClient, closedClient, postCloseClient, exitingClient, postExitClient]) client.close()
console.log(`delivery boundaries: ${JSON.stringify(deliveryBoundaries)}`)
console.log('ok - delivery failures leave the cursor replayable through a replacement sink')

const delayed = await fakeAppServer(path.join(root, 'delayed.sock'), {
  initializeDelayMs: 75,
})
const delayedClient = new AppServerClient(delayed.socketPath)
const before = Date.now()
await delayedClient.connect(500)
assert.ok(Date.now() - before >= 60, 'probe did not wait for initialize')
delayedClient.close()
await delayed.close()
console.log('ok - protocol readiness waits for initialize')

const dead = await fakeAppServer(path.join(root, 'dead.sock'), {
  ignoreInitialize: true,
})
const deadClient = new AppServerClient(dead.socketPath)
await assert.rejects(deadClient.connect(50), /initialize timed out/)
assert.equal(deadClient.pending.size, 0, 'timed-out initialize retained a request')
await dead.close()
console.log('ok - socket-bound protocol death fails and clears pending work')

const stalled = await fakeAppServer(path.join(root, 'stalled.sock'), {
  ignoreMethods: new Set(['thread/list', 'thread/start']),
})
const stalledClient = new AppServerClient(stalled.socketPath)
await stalledClient.connect(200)
stalledClient.onTurnCompleted(() => {})
stalledClient.onClose(() => {})
const pendingTurn = stalledClient.threadStart({})
await assert.rejects(stalledClient.assertResponsive(50), /protocol check timed out/)
await assert.rejects(pendingTurn, /protocol check timed out/)
assert.equal(stalledClient.pending.size, 0, 'closed transport retained pending requests')
assert.equal(stalledClient.turnCompletedListeners.length, 0, 'closed transport retained completion listeners')
assert.equal(stalledClient.closeListeners.size, 0, 'closed transport retained close listeners')
assert.equal(stalledClient.mcpStatusListeners.size, 0, 'closed transport retained readiness listeners')
await stalled.close()
console.log('ok - a stalled active connection closes and rejects pending work')

const approvals = await fakeAppServer(path.join(root, 'approvals.sock'))
const approvalClient = new AppServerClient(approvals.socketPath)
await approvalClient.connect(200)
assert.deepEqual(
  await approvals.requestClient('item/commandExecution/requestApproval'),
  { result: { decision: 'decline' } },
)
assert.deepEqual(
  await approvals.requestClient('item/fileChange/requestApproval'),
  { result: { decision: 'decline' } },
)
assert.deepEqual(
  await approvals.requestClient('item/permissions/requestApproval'),
  { error: { code: -32602, message: 'AIT does not grant additional permissions' } },
)
approvalClient.close()
await approvals.close()
console.log('ok - current v2 approval requests fail closed')

const testThread = '55555555-5555-4555-8555-555555555555'
// Exercise the production host rather than only connect(explicitTimeout).
let initializes = 0
let delayedInitializeCompleted = false
const waiting = await fakeAppServer(path.join(root, 'host-init.sock'), {
  async onRequest(message) {
    if (message.method === 'initialize') {
      initializes++
      if (initializes === 1) return null
      await delay(75)
      delayedInitializeCompleted = true
      return { result: {} }
    }
    if (message.method === 'thread/resume') return { result: threadResult() }
  },
})
const waitingDriver = launchDriver(waiting.socketPath)
try {
  await waitUntil(() => waitingDriver.output.includes('initialize timed out'), 'production initialize deadline')
  await waitUntil(() => waitingDriver.output.includes('→ thread'), 'reconnect after initialize timeout')
  assert.equal(initializes, 2, 'startup timeout must close and open a second connection')
  assert.equal(delayedInitializeCompleted, true, 'delayed valid initialize must complete')
  assert.equal(waitingDriver.child.exitCode, null, 'recovered driver must keep running')
} finally { await waitingDriver.close(); await waiting.close() }
console.log('ok - production driver times out, reconnects, and completes a delayed initialize')

// Resume has no short deadline: restoring valid history can take longer than
// initialize. Observe the stage and exact request while the server holds it.
let pendingResume
const restoring = await fakeAppServer(path.join(root, 'host-resume.sock'), {
  onRequest(message, socket) {
    if (message.method !== 'thread/resume') return
    assert.equal(message.params.excludeTurns, true, 'driver must not request unused turns')
    pendingResume = () => socket.send(JSON.stringify({ id: message.id, result: threadResult() }))
    return null
  },
})
const restoringDriver = launchDriver(restoring.socketPath)
try {
  await waitUntil(() => pendingResume, 'resume request')
  assert.ok(restoringDriver.output.includes(`ait codex session: resuming thread ${testThread}`), 'stage must precede pending resume')
  await delay(3200)
  assert.equal(restoringDriver.child.exitCode, null)
  assert.ok(!restoringDriver.output.includes('→ thread'), 'held resume must not report readiness')
  pendingResume()
  await waitUntil(() => restoringDriver.output.includes('→ thread'), 'delayed resume readiness')
} finally { await restoringDriver.close(); await restoring.close() }
console.log('ok - metadata-only resume reports its stage and waits for a valid delayed reply')

for (const [label, error, transient] of [
  ['draining', { code: -32600, message: 'Server is draining; retry after reconnecting', data: { reason: 'serverShuttingDown' } }, true],
  ['unknown', { code: -32600, message: 'no rollout found for test' }, false],
  ['writer', { code: -32600, message: `thread ${testThread} already has an active writer` }, false],
  ['other', { code: -32600, message: 'unrelated permanent refusal', data: { reason: 'other' } }, false],
]) {
  let attempts = 0
  const endpoint = await fakeAppServer(path.join(root, `host-${label}.sock`), {
    onRequest(message) {
      if (message.method !== 'thread/resume') return
      attempts++
      return attempts === 1 ? { error } : { result: threadResult() }
    },
  })
  const driver = launchDriver(endpoint.socketPath)
  try {
    if (transient) {
      await waitUntil(() => driver.output.includes('→ thread'), 'draining reconnect')
      assert.equal(attempts, 2, 'shutdown must reconnect and resume the same thread')
      assert.equal(driver.child.exitCode, null)
    } else {
      await waitUntil(() => driver.child.exitCode !== null, 'permanent failure')
      assert.equal(driver.child.exitCode, 1)
      assert.equal(attempts, 1, 'permanent -32600 must not retry')
      if (label === 'writer') {
        assert.match(driver.output, /already open in another Codex application/)
        assert.match(driver.output, /finish and close only that conversation/)
        assert.match(driver.output, /then run: ait resume/)
        assert.doesNotMatch(driver.output, /kill|delete.*lock|ait stop/)
      }
    }
  } finally { await driver.close(); await endpoint.close() }
}
console.log('ok - production host retries structured shutdown, not arbitrary -32600')

for (const [releases, noticeAvailable] of [[true, true], [false, true], [true, false]]) {
  let attempts = 0
  const noticePath = path.join(root, `writer-notice-${releases}-${noticeAvailable}.txt`)
  const noticeFd = noticeAvailable ? fs.openSync(noticePath, 'w') : undefined
  const endpoint = await fakeAppServer(path.join(root, `writer-race-${releases}-${noticeAvailable}.sock`), {
    onRequest(message) {
      if (message.method === 'initialize') return { result: { codexHome: path.join(root, 'writer-home') } }
      if (message.method === 'server/diagnostics') return { result: { process: { id: process.pid } } }
      if (message.method !== 'thread/resume') return
      assert.equal(message.params.threadId, testThread)
      assert.equal(message.params.excludeTurns, true)
      attempts++
      if (attempts === 2) assert.match(fs.readFileSync(noticePath, 'utf8'), /no external writer is visible; retrying this conversation once/,
        'user notice must be written before the retry reaches the server')
      if (attempts === 1 || !releases) return { error: { code: -32600, message: `thread ${testThread} already has an active writer` } }
      return { result: threadResult() }
    },
  })
  const driver = launchDriver(endpoint.socketPath, { AIT_CODEX_STARTUP_NOTICE_FD: '3' }, noticeFd)
  try {
    await waitUntil(() => releases && noticeAvailable ? driver.output.includes('→ thread') : driver.child.exitCode !== null, 'bounded writer race recovery')
    assert.equal(attempts, noticeAvailable ? 2 : 1, 'only retry after displaying the notice')
    if (!noticeAvailable) {
      assert.equal(driver.child.exitCode, 1)
      assert.match(driver.output, /could not display the recovery notice; resume was not retried/)
    } else if (releases) assert.match(driver.output, /resume recovered/)
    else {
      assert.equal(driver.child.exitCode, 1)
      assert.match(driver.output, /finish and close only that conversation/)
    }
  } finally { await driver.close(); await endpoint.close(); if (noticeFd !== undefined) fs.closeSync(noticeFd) }
}
console.log('ok - released writer recovers automatically; repeated ownership refusal stays bounded')

// An overload during the retry reconnects, but does not grant a second writer
// recovery attempt or print another pre-retry notice.
{
  let attempts = 0
  const endpoint = await fakeAppServer(path.join(root, 'writer-retry-overload.sock'), {
    onRequest(message) {
      if (message.method === 'initialize') return { result: { codexHome: path.join(root, 'writer-home') } }
      if (message.method === 'server/diagnostics') return { result: { process: { id: process.pid } } }
      if (message.method !== 'thread/resume') return
      attempts++
      if (attempts === 2) return { error: { code: -32001, message: 'Server overloaded' } }
      return { error: { code: -32600, message: `thread ${testThread} already has an active writer` } }
    },
  })
  const driver = launchDriver(endpoint.socketPath)
  try {
    await waitUntil(() => driver.child.exitCode !== null, 'writer retry budget survives reconnect')
    assert.equal(driver.child.exitCode, 1)
    assert.equal(attempts, 3, 'initial resume, one safe retry, then reconnect refusal without another retry')
    assert.equal(driver.output.split('retrying this conversation once').length - 1, 1)
    assert.match(driver.output, /finish and close only that conversation/)
  } finally { await driver.close(); await endpoint.close() }
}
console.log('ok - writer recovery retry budget is preserved across overload reconnects')


// Real driver HTTP push -> Codex request -> disconnect -> registration replay
// -> completed replacement turn -> persisted cursor. PDS/AppView are owned fakes.
const baseline = checkpoint()
const registrations = []
const identity = session.getIdentity()
const jwt = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: identity.did, scope: 'com.atproto.access', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`
const fakeSession = { did: identity.did, handle: identity.handle, active: true, accessJwt: jwt, refreshJwt: jwt }
const pds = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  res.setHeader('content-type', 'application/json')
  if (req.url === '/xrpc/ait.notification.registerPushTarget') {
    const data = JSON.parse(Buffer.concat(chunks).toString())
    registrations.push(data)
    res.end(JSON.stringify({ status: 'ok', cursor: data.cursor ?? baseline }))
  } else res.end(JSON.stringify(fakeSession))
})
await new Promise((resolve) => pds.listen(0, '127.0.0.1', resolve))
const pdsUrl = `http://127.0.0.1:${pds.address().port}`
let accepts = 0
let turnSocket
const injected = []
const endpoint = await fakeAppServer(path.join(root, 'host-replay.sock'), {
  onRequest(message, socket) {
    if (message.method === 'thread/resume') return { result: threadResult() }
    if (message.method !== 'turn/start') return
    accepts++
    turnSocket = socket
    injected.push(message.params.input[0].text)
    return { result: { turn: { id: `delivery-${accepts}` } } }
  },
})
const { writeThreadSessionId } = await import('../dist/codex/threadMap.js')
writeThreadSessionId(testThread, process.env.AIT_MCP_TEST_SESSION_ID)
const driver = launchDriver(endpoint.socketPath, { PDS_URL: pdsUrl, APPVIEW_URL: pdsUrl })
try {
  await waitUntil(() => registrations.length === 1, 'first registration')
  const delivery = notification('at://http-replay', 'cursor-http-replay')
  assert.equal((await fetch(registrations[0].url, { method: 'POST', body: JSON.stringify(delivery) })).status, 200)
  await waitUntil(() => accepts === 1, 'first injection')
  assert.equal(checkpoint(), baseline, 'acceptance must not commit')
  turnSocket.terminate()
  await waitUntil(() => registrations.length >= 2, 'reconnect registration')
  assert.equal(registrations.at(-1).cursor, baseline, 'registration must replay from the durable checkpoint')
  assert.equal((await fetch(registrations.at(-1).url, { method: 'POST', body: JSON.stringify(delivery) })).status, 200)
  await waitUntil(() => accepts === 2, 'replacement injection')
  assert.ok(injected.every((text) => text.includes(delivery.uri)))
  turnSocket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: testThread, turn: { id: 'delivery-2', status: 'completed' } } }))
  await waitUntil(() => checkpoint() === 'cursor-http-replay', 'completed cursor')
} finally {
  await driver.close()
  await endpoint.close()
  pds.closeAllConnections()
  await new Promise((resolve) => pds.close(resolve))
}
console.log('ok - production HTTP notification replays after reconnect and commits only on completion')

fs.rmSync(root, { recursive: true, force: true })
console.log('PASS codex recovery')

function notification(uri, cursor) {
  return {
    uri,
    cid: 'cid',
    author: { did: 'did:plc:author', handle: 'author.test' },
    reason: 'mention',
    record: { text: 'ping' },
    indexedAt: new Date().toISOString(),
    cursor,
  }
}

async function fakeAppServer(socketPath, options = {}) {
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  const serverRequests = new Map()
  let nextServerRequestId = 10_000
  wss.on('connection', (socket) => {
    socket.on('message', async (bytes) => {
      const message = JSON.parse(bytes.toString())
      const pendingServerRequest = serverRequests.get(message.id)
      if (message.method == null && pendingServerRequest) {
        serverRequests.delete(message.id)
        pendingServerRequest.resolve(
          message.error ? { error: message.error } : { result: message.result },
        )
        return
      }
      const handled = await options.onRequest?.(message, socket)
      if (handled !== undefined) {
        if (handled !== null) socket.send(JSON.stringify({ id: message.id, ...handled }))
        return
      }
      if (message.method === 'initialize') {
        if (options.ignoreInitialize) return
        if (options.initializeDelayMs) await delay(options.initializeDelayMs)
        socket.send(JSON.stringify({ id: message.id, result: {} }))
        return
      }
      if (message.id == null || options.ignoreMethods?.has(message.method)) return
      socket.send(JSON.stringify({ id: message.id, result: { data: [] } }))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    socketPath,
    requestClient(method) {
      const socket = [...wss.clients][0]
      assert.ok(socket, 'app-server client is not connected')
      const id = nextServerRequestId++
      const response = new Promise((resolve, reject) => {
        serverRequests.set(id, { resolve, reject })
      })
      socket.send(JSON.stringify({ id, method, params: {} }))
      return response
    },
    async close() {
      for (const socket of wss.clients) socket.terminate()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function threadResult() {
  return { thread: { id: testThread }, model: 'gpt-6.1-sol', reasoningEffort: 'medium', approvalPolicy: 'never', activePermissionProfile: { id: ':danger-full-access' } }
}
async function waitUntil(check, label) {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    if (check()) return
    await delay(20)
  }
  assert.fail(`${label} did not complete`)
}
function launchDriver(socket, overrides = {}, noticeFd) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url)), '--resume', testThread], {
    cwd: root,
    env: { ...process.env, HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'), AIT_NOTIFICATION_MODE: 'codex', AIT_CODEX_SHARED_SOCKET: socket, PDS_URL: 'http://127.0.0.1:1', APPVIEW_URL: 'http://127.0.0.1:1', ...overrides },
    stdio: ['ignore', 'ignore', 'pipe', ...(noticeFd === undefined ? [] : [noticeFd])],
  })
  const driver = { child, output: '', async close() {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([exited, delay(2000)])
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
  } }
  child.stderr.on('data', (chunk) => { driver.output += chunk })
  return driver
}
