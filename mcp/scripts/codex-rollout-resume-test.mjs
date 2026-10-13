#!/usr/bin/env node

// Production-shaped regression for the rollout contract used by
// bin/codex-session.sh. It runs the installed Codex app-server in an isolated
// CODEX_HOME, so it exercises the real binary without touching real sessions or
// making a model request.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-codex-rollout-test-'))
const codexHome = path.join(testRoot, 'codex-home')
const socketPath = path.join(testRoot, 'app.sock')
const delayedMcpPath = path.join(testRoot, 'delayed-mcp.mjs')
const delayedMcpPidPath = path.join(testRoot, 'delayed-mcp.pid')
const delayedMcpReleasePath = path.join(testRoot, 'delayed-mcp.release')
fs.mkdirSync(codexHome, { recursive: true })
process.env.XDG_DATA_HOME = path.join(testRoot, 'xdg')
const codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
const versionMatch = codexVersion.match(/codex-cli (\d+)\.(\d+)\.(\d+)/)
assert.ok(versionMatch, `unexpected codex version output: ${codexVersion}`)
const supportsMcpReadiness =
  Number(versionMatch[1]) > 0 || Number(versionMatch[2]) >= 152

// A deterministic MCP startup barrier. The first instance reports its pid and
// completes initialize only after SIGUSR1; later thread instances see the
// release marker and initialize immediately. This proves the launcher gate is
// released by a real app-server terminal event, never elapsed time.
fs.writeFileSync(delayedMcpPath, `
import * as fs from 'node:fs'
import * as readline from 'node:readline'

const [pidPath, releasePath] = process.argv.slice(2)
let blockedInitialize = null
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const release = () => {
  if (!blockedInitialize) return
  fs.writeFileSync(releasePath, 'released\\n')
  respond(blockedInitialize.id, {
    protocolVersion: blockedInitialize.params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'ait-readiness-probe', version: '1.0.0' },
  })
  blockedInitialize = null
}
process.on('SIGUSR1', release)
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    blockedInitialize = message
    if (fs.existsSync(releasePath)) release()
    else fs.writeFileSync(pidPath, String(process.pid))
  } else if (message.id != null && message.method === 'tools/list') {
    respond(message.id, { tools: [] })
  } else if (message.id != null) {
    respond(message.id, {})
  }
})
`)
fs.writeFileSync(path.join(codexHome, 'config.toml'), `
[mcp_servers.readiness_probe]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(delayedMcpPath)}, ${JSON.stringify(delayedMcpPidPath)}, ${JSON.stringify(delayedMcpReleasePath)}]

[mcp_servers.ait]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(fileURLToPath(new URL('../dist/server.js', import.meta.url)))}]
[mcp_servers.ait.env]
AIT_NOTIFICATION_MODE = "poll"
PDS_URL = "http://127.0.0.1:1"
`)

let serverOutput = ''
const server = spawn('codex', [
  'app-server', '--listen', `unix://${socketPath}`,
  '-c', 'model="gpt-6.1-sol"',
  '-c', 'model_reasoning_effort="medium"',
], {
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (chunk) => { serverOutput += chunk })
server.stderr.on('data', (chunk) => { serverOutput += chunk })

let client
let driver
try {
  for (let attempt = 0; attempt < 100 && !fs.existsSync(socketPath); attempt++) {
    assert.equal(server.exitCode, null, `codex app-server exited early:\n${serverOutput}`)
    await delay(50)
  }
  assert.equal(fs.existsSync(socketPath), true, `codex app-server socket missing:\n${serverOutput}`)

  const { AppServerClient } = await import('../dist/codex/appServerClient.js')
  const { assertAitThreadContract } = await import('../dist/codex/host.js')
  client = new AppServerClient(socketPath)
  await client.connect()

  const profiles = await client.request('permissionProfile/list', { cwd: process.cwd() })
  assert.ok(profiles.data.some((profile) =>
    profile.id === ':danger-full-access' && profile.allowed),
  'Codex must allow the built-in unrestricted permission profile')

  const expectedThread = {
    model: 'gpt-6.1-sol',
    approvalPolicy: 'never',
    permissions: ':danger-full-access',
    config: { model_reasoning_effort: 'medium' },
  }
  const resumeThread = {
    approvalPolicy: 'never',
    permissions: ':danger-full-access',
    config: { 'mcp_servers.ait.env.AIT_SESSION_ID': '11111111-1111-4111-8111-111111111111' },
  }
  const assertThreadContract = (thread) => {
    assert.equal(thread.model, 'gpt-6.1-sol')
    assert.equal(thread.reasoningEffort, 'medium')
    assert.equal(thread.approvalPolicy, 'never')
    assert.equal(thread.activePermissionProfile?.id, ':danger-full-access')
  }
  const starting = client.threadStart({
    cwd: process.cwd(),
    historyMode: 'legacy',
    ...expectedThread,
  })
  const readiness = starting.then((thread) => client.waitForMcpStartup(thread.thread.id))
  let readinessSettled = false
  void readiness.then(() => { readinessSettled = true }, () => { readinessSettled = true })
  for (let attempt = 0; attempt < 100 && !fs.existsSync(delayedMcpPidPath); attempt++) {
    await delay(25)
  }
  assert.equal(fs.existsSync(delayedMcpPidPath), true,
    `delayed MCP never entered initialize:\n${serverOutput}`)
  // Current Codex can await required MCP initialization inside thread/start.
  // Release the fixture from its initialize event, before awaiting that call.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readinessSettled, false,
    'MCP readiness must wait for the blocked initialize event')
  process.kill(Number(fs.readFileSync(delayedMcpPidPath, 'utf8')), 'SIGUSR1')
  const legacy = await starting
  assertThreadContract(legacy)
  assert.doesNotThrow(() => assertAitThreadContract(legacy, true))
  const initiallyPending = await readiness
  if (supportsMcpReadiness) {
    // Codex 0.152 waits for the terminal event but reports an empty pending
    // snapshot after the released probe. Older versions include the probe
    // name. The event-gated wait above is the contract; accept either server
    // snapshot shape while rejecting any unexpected entry.
    assert.ok(
      initiallyPending.length === 0 ||
        initiallyPending.every((name) => ['readiness_probe', 'ait'].includes(name)),
      `unexpected MCP readiness snapshot: ${JSON.stringify(initiallyPending)}`,
    )
  } else {
    assert.deepEqual(initiallyPending, [])
  }

  await client.setName(legacy.thread.id, 'AIT clean rollout probe')
  const legacyRows = readRollout(legacy.thread.path)
  assert.equal(legacy.thread.historyMode, 'legacy')
  assert.equal(legacyRows.length, 1, 'legacy name seed must write only session_meta')
  assert.equal(legacyRows[0]?.type, 'session_meta')
  assert.equal(legacyRows[0]?.payload?.history_mode, 'legacy')
  assert.equal(hasDanglingSeed(legacyRows), false)
  const resumed = await client.threadResume({ threadId: legacy.thread.id, ...resumeThread })
  assert.equal(resumed.thread.id, legacy.thread.id)
  assertThreadContract(resumed)

  // A user may switch model/effort in the TUI. Reconnecting the notification
  // driver must accept that persisted thread choice without relaxing AIT's
  // approval and permission checks. Start with different settings to reproduce
  // the effective response without making a model turn.
  const switched = await client.threadStart({
    cwd: process.cwd(),
    historyMode: 'legacy',
    model: 'gpt-6-luna',
    approvalPolicy: 'never',
    permissions: ':danger-full-access',
    config: { model_reasoning_effort: 'high' },
  })
  await client.setName(switched.thread.id, 'AIT model-switch probe')
  const switchedResume = await client.threadResume({
    threadId: switched.thread.id,
    ...resumeThread,
  })
  assert.equal(switchedResume.model, 'gpt-6-luna')
  assert.equal(switchedResume.reasoningEffort, 'high')
  assert.doesNotThrow(() => assertAitThreadContract(switchedResume, false))
  assert.throws(() => assertAitThreadContract(switchedResume, true), /launch contract/)
  assert.throws(() => assertAitThreadContract({
    ...switchedResume,
    approvalPolicy: 'on-request',
  }, false), /launch contract/)
  assert.throws(() => assertAitThreadContract({
    ...switchedResume,
    activePermissionProfile: { id: ':workspace', extends: null },
  }, false), /launch contract/)
  assert.throws(() => assertAitThreadContract({
    ...switchedResume,
    activePermissionProfile: null,
  }, false), /launch contract/)

  // Exercise the production driver, including the exact start/resume request
  // it sends and the attach contract. No identity is joined or model turn made.
  let driverThreadId
  for (const resume of [false, true]) {
    const socketFile = path.join(testRoot, 'driver-ready')
    const args = resume ? ['--resume', driverThreadId] : []
    driver = spawn(process.execPath, [
      fileURLToPath(new URL('../dist/server.js', import.meta.url)), ...args,
    ], {
      cwd: testRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        AIT_NOTIFICATION_MODE: 'codex',
        AIT_CODEX_SHARED_SOCKET: socketPath,
        AIT_CODEX_SOCKET_FILE: socketFile,
        PDS_URL: 'http://127.0.0.1:1',
        APPVIEW_URL: 'http://127.0.0.1:1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    await new Promise((resolve, reject) => {
      let output = ''
      driver.stderr.on('data', (chunk) => {
        output += chunk
        if (/ait codex session: session .* → thread /.test(output)) resolve()
        if (output.includes('not connected to shared app-server')) reject(new Error(output))
      })
      driver.once('exit', (code) => reject(new Error(`driver exited ${code}: ${output}`)))
    })
    const [publishedSocket, id] = fs.readFileSync(socketFile, 'utf8').trim().split('\n')
    assert.equal(publishedSocket, socketPath)
    if (driverThreadId) assert.equal(id, driverThreadId, 'resume must keep the original thread')
    driverThreadId = id
    driver.kill('SIGTERM')
    await onceExit(driver)
    fs.unlinkSync(socketFile)
  }

  // Reproduce c767a5e's bad seed. The affected rollout cohort is deliberately
  // not rewritten or migrated; it is small and two hours old, so operators
  // start those test sessions fresh after this fix.
  const contaminated = await client.threadStart({
    cwd: process.cwd(),
    historyMode: 'paginated',
  })
  await client.setName(contaminated.thread.id, 'AIT contaminated rollout probe')
  await client.request('thread/inject_items', {
    threadId: contaminated.thread.id,
    items: [{
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'AIT rollout seed probe.' }],
    }],
  })
  const contaminatedRows = readRollout(contaminated.thread.path)
  assert.equal(hasDanglingSeed(contaminatedRows), true)

  console.log(
    'PASS codex rollout: production driver start/resume + named permissions + ' +
      'model switch + event-gated MCP readiness + ' +
      'legacy attach seed + prior paginated-seed reproduction',
  )
} finally {
  if (driver?.exitCode === null && driver.signalCode === null) {
    driver.kill('SIGTERM')
    await onceExit(driver)
  }
  client?.close()
  if (server.exitCode === null) {
    server.kill('SIGTERM')
    await Promise.race([onceExit(server), delay(2000)])
  }
  if (server.exitCode === null) {
    server.kill('SIGKILL')
    await onceExit(server)
  }
  // Codex may finish renaming a temporary plugin-cache directory just after the
  // server process exits. Node's bounded retry handles that harmless APFS race.
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function readRollout(rolloutPath) {
  assert.equal(typeof rolloutPath, 'string', 'app-server response must expose rollout path')
  return fs.readFileSync(rolloutPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
}

function hasDanglingSeed(rows) {
  return rows.some((row) =>
    row.type === 'turn_context' && row.payload?.turn_id === 'auto-compact-0')
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', resolve))
}
