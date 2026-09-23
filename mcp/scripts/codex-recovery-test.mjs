#!/usr/bin/env node

import assert from 'node:assert/strict'
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
  starts = []
  rejectNext = false
  activeTurnId() { return null }
  onTurnCompleted(listener) { this.completions.push(listener) }
  async turnStart(threadId, text) {
    if (this.rejectNext) {
      this.rejectNext = false
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
const pendingTurn = stalledClient.threadStart({})
await assert.rejects(stalledClient.assertResponsive(50), /protocol check timed out/)
await assert.rejects(pendingTurn, /protocol check timed out/)
assert.equal(stalledClient.pending.size, 0, 'closed transport retained pending requests')
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
