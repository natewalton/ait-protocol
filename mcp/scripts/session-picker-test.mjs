#!/usr/bin/env node

// Isolated read-time join tests for `ait resume`. The fixtures contain only
// public handles and fake encrypted-envelope fields; no live service, session,
// or credential is opened.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-session-picker-')))
const home = path.join(root, 'home')
const xdg = path.join(root, 'xdg')
const bin = path.join(root, 'bin')
const claudeProject = path.join(root, 'project with spaces_under.score')
const codexProject = path.join(root, 'codex project')
const missingProject = path.join(root, 'deleted project')
const claudeId = '11111111-1111-4111-8111-111111111111'
const codexId = '22222222-2222-4222-8222-222222222222'
const claudeHandle = 'claude-session.test'
const machineKey = 'iq3l5t4vuaat4l2zbzjrkoryccobcfi4s5pujtcmtsqen6vf6jea'
const codexHandle = `codex-session.${machineKey}.aitproto.com`
const fakeSecret = 'THIS MUST NEVER BE PRINTED'
const actorDid = (handle) => `did:plc:${createHash('sha256').update(handle).digest('hex').slice(0, 24)}`

const mkdir = (directory) => fs.mkdirSync(directory, { recursive: true })
const write = (file, value) => {
  mkdir(path.dirname(file))
  fs.writeFileSync(file, value)
}
const identityPath = (id) => path.join(
  xdg,
  'ait-mcp',
  `identity-${createHash('sha256').update(id).digest('hex').slice(0, 16)}.json`,
)
const writeIdentity = (id, handle) => write(identityPath(id), JSON.stringify({
  did: actorDid(handle),
  handle,
  ciphertext: fakeSecret,
  nonce: 'nonce',
  tag: 'tag',
}))
const writeExecutable = (name) => {
  const file = path.join(bin, name)
  write(file, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(file, 0o755)
}

const liveFile = path.join(root, 'live-handles.json')
const retiredFile = path.join(root, 'retired-handles.json')
const actorsFile = path.join(root, 'directory-actors.json')
const directoryActors = [claudeHandle, codexHandle].map((handle) => ({ did: actorDid(handle), handle }))
const concurrencyFile = path.join(root, 'presence-concurrency')
const presenceStall = path.join(root, 'presence-stall.json')
write(presenceStall, 'false')
const appviewServerFile = path.join(root, 'appview-server.mjs')
write(liveFile, '[]')
write(retiredFile, '[]')
write(actorsFile, JSON.stringify(directoryActors))
write(concurrencyFile, '0')
write(appviewServerFile, `
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
const [liveFile, retiredFile, concurrencyFile, actorsFile, presenceStall] = process.argv.slice(2)
let active = 0
let peak = 0
const server = createServer((request, response) => {
  active += 1
  peak = Math.max(peak, active)
  writeFileSync(concurrencyFile, String(peak))
  if (JSON.parse(readFileSync(presenceStall, 'utf8'))) {
    writeFileSync(presenceStall, JSON.stringify('entered'))
    request.once('close', () => { active -= 1 })
    return
  }
  const url = new URL(request.url, 'http://localhost')
  const query = (url.searchParams.get('q') ?? '').toLowerCase()
  const live = new Set(JSON.parse(readFileSync(liveFile, 'utf8')))
  const retired = new Set(JSON.parse(readFileSync(retiredFile, 'utf8')))
  const retiredOnly = url.searchParams.get('retiredOnly') === 'true'
  const actors = JSON.parse(readFileSync(actorsFile, 'utf8'))
    .filter((actor) => actor.handle.startsWith(query) && retired.has(actor.handle) === retiredOnly)
    .slice(0, Number(url.searchParams.get('limit') ?? 100))
    .map((actor) => ({ ...actor, live: live.has(actor.handle) }))
  setTimeout(() => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ actors }))
    active -= 1
  }, 15)
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port) + '\\n')
})
`)
const appviewServer = spawn(
  process.execPath,
  [appviewServerFile, liveFile, retiredFile, concurrencyFile, actorsFile, presenceStall],
  { stdio: ['ignore', 'pipe', 'inherit'] },
)
const appviewPort = await new Promise((resolve, reject) => {
  let output = ''
  appviewServer.stdout.on('data', (chunk) => {
    output += chunk.toString()
    const line = output.split('\n')[0]
    if (/^\d+$/.test(line)) resolve(Number(line))
  })
  appviewServer.once('exit', (status) => reject(new Error(`fixture AppView exited ${status}`)))
})
const env = {
  ...process.env,
  HOME: home,
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  XDG_DATA_HOME: xdg,
  APPVIEW_URL: `http://127.0.0.1:${appviewPort}`,
  TZ: 'UTC',
  PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
}
for (const marker of [
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'AIT_SESSION_ID', 'AI_AGENT',
]) delete env[marker]
const repo = path.resolve(new URL('../..', import.meta.url).pathname)
// Compile source into the fixture, leaving the shared checkout's build alone.
const fixtureDist = path.join(root, 'build', 'mcp', 'dist')
const build = spawnSync(process.execPath, [
  path.join(repo, 'mcp', 'node_modules', 'typescript', 'bin', 'tsc'),
  '--project', path.join(repo, 'mcp', 'tsconfig.json'), '--outDir', fixtureDist,
], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stdout + build.stderr)
fs.symlinkSync(path.join(repo, 'mcp', 'node_modules'), path.join(root, 'build', 'mcp', 'node_modules'))
const picker = path.join(fixtureDist, 'sessionPicker.js')
process.on('exit', () => {
  appviewServer.kill()
  codexServer.kill()
  fs.rmSync(path.dirname(codexSocket), { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

mkdir(claudeProject)
mkdir(codexProject)
mkdir(missingProject)
writeExecutable('claude')
writeExecutable('codex')

// The directory name is deliberately not a reversible path encoding. The
// first cwd-bearing record is the source of truth, including punctuation.
const claudeDir = path.join(home, '.claude', 'projects', '-opaque-storage-slug')
write(path.join(claudeDir, `${claudeId}.jsonl`), [
  JSON.stringify({ type: 'queue-operation', sessionId: claudeId }),
  JSON.stringify({ type: 'assistant', cwd: claudeProject, text: fakeSecret }),
  '',
].join('\n'))
write(path.join(claudeDir, 'subagents', '33333333-3333-4333-8333-333333333333.jsonl'),
  JSON.stringify({ cwd: claudeProject }))
writeIdentity('33333333-3333-4333-8333-333333333333', 'nested-session.test')
writeIdentity(claudeId, claudeHandle)

const malformedId = '44444444-4444-4444-8444-444444444444'
write(path.join(claudeDir, `${malformedId}.jsonl`), '{not-json\n')
writeIdentity(malformedId, 'malformed-session.test')
const missingId = '55555555-5555-4555-8555-555555555555'
write(path.join(claudeDir, `${missingId}.jsonl`),
  `${JSON.stringify({ cwd: missingProject })}\n${JSON.stringify({ cwd: claudeProject })}\n`)
writeIdentity(missingId, 'missing-project.test')

// Codex 0.163 keeps threads in its own database and deletes the rollout
// files, so the picker asks the shared app-server. This fixture answers
// thread/read for exactly the threads it is given; there is no rollout file.
const unknownCodexId = '66666666-6666-4666-8666-666666666666'
const corruptCodexId = '88888888-8888-4888-8888-888888888888'
const codexServerFile = path.join(root, 'codex-server.mjs')
const writerState = path.join(root, 'writer-state.json')
const writerHome = path.join(root, 'native-server-home')
const writerLock = path.join(writerHome, 'thread-writer-locks', `${codexId}.lock`)
write(writerState, JSON.stringify({ enabled: false, calls: [] }))
const codexSocket = path.join(fs.mkdtempSync('/tmp/aitp-'), 's.sock')
write(codexServerFile, `
import { createServer } from 'node:http'
import { WebSocketServer } from ${JSON.stringify(new URL('../node_modules/ws/wrapper.mjs', import.meta.url).href)}
import { readFileSync } from 'node:fs'
const [socket, threadsJson, dropFile, writerState, writerHome] = process.argv.slice(2)
const threads = JSON.parse(threadsJson)
const http = createServer()
const server = new WebSocketServer({ server: http })
http.listen(socket, () => process.stdout.write('ready\\n'))
server.on('connection', (ws) => ws.on('message', (data) => {
  const message = JSON.parse(String(data))
  if (message.id === undefined) return
  const state = JSON.parse(readFileSync(writerState, 'utf8'))
  if (message.method === 'initialize') return ws.send(JSON.stringify({ id: message.id, result: state.enabled ? { codexHome: writerHome } : {} }))
  if (message.method === 'server/diagnostics') return ws.send(JSON.stringify({ id: message.id, result: { process: { id: process.pid } } }))
  if (JSON.parse(readFileSync(dropFile, 'utf8')).includes(message.params?.threadId)) return ws.terminate()
  const thread = message.method === 'thread/read' ? threads[message.params.threadId] : undefined
  if (thread) return ws.send(JSON.stringify({ id: message.id, result: { thread } }))
  if (message.params?.threadId === ${JSON.stringify(corruptCodexId)}) {
    return ws.send(JSON.stringify({ id: message.id, error: { code: -32603, message: 'failed to read thread' } }))
  }
  ws.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'thread not loaded' } }))
}))
`)
const deletedCwdCodexId = '77777777-7777-4777-8777-777777777777'
const codexDropFile = path.join(root, 'codex-drop.json')
write(codexDropFile, '[]')
const codexServer = spawn(process.execPath, [codexServerFile, codexSocket, JSON.stringify({
  [codexId]: { id: codexId, cwd: codexProject, updatedAt: Math.floor(Date.now() / 1000) + 1000 },
  [deletedCwdCodexId]: { id: deletedCwdCodexId, cwd: missingProject, updatedAt: 1 },
}), codexDropFile, writerState, writerHome], { stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => {
  codexServer.stdout.once('data', resolve)
  codexServer.once('exit', (status) => reject(new Error(`fixture Codex server exited ${status}`)))
})
env.AIT_CODEX_SHARED_SOCKET = codexSocket
write(path.join(xdg, 'ait-mcp', `codex-thread-${codexId}.json`), JSON.stringify({
  threadId: codexId,
  sessionId: codexId,
}))
writeIdentity(codexId, codexHandle)
// AIT still maps this thread, but Codex no longer has it.
write(path.join(xdg, 'ait-mcp', `codex-thread-${unknownCodexId}.json`), JSON.stringify({
  threadId: unknownCodexId,
  sessionId: unknownCodexId,
}))
writeIdentity(unknownCodexId, 'gone-codex.test')
// Codex has this thread but cannot read it; only this row is lost.
write(path.join(xdg, 'ait-mcp', `codex-thread-${corruptCodexId}.json`), JSON.stringify({
  threadId: corruptCodexId,
  sessionId: corruptCodexId,
}))
writeIdentity(corruptCodexId, 'corrupt-codex.test')
// Codex has this thread, but its project folder is gone (deleted below).
write(path.join(xdg, 'ait-mcp', `codex-thread-${deletedCwdCodexId}.json`), JSON.stringify({
  threadId: deletedCwdCodexId,
  sessionId: deletedCwdCodexId,
}))
writeIdentity(deletedCwdCodexId, 'deleted-codex-project.test')

const run = (query = '', input = '', envOverrides = {}) => spawnSync(
  process.execPath,
  [picker, query],
  { env: { ...env, ...envOverrides }, input, encoding: 'utf8' },
)
const assertSelection = (result, expectedHarness, expectedProject, expectedId) => {
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\t'), [
    expectedHarness,
    expectedProject,
    expectedId,
  ])
  assert.equal(result.stdout.includes(fakeSecret), false)
  assert.equal(result.stderr.includes(fakeSecret), false)
}

let result = run(codexHandle)
assertSelection(result, 'codex', codexProject, codexId)
assert.equal(fs.readFileSync(concurrencyFile, 'utf8'), '1',
  'presence checks must not overlap')
result = run(claudeHandle)
assertSelection(result, 'claude', claudeProject, claudeId)
result = run('@claude-session')
assertSelection(result, 'claude', claudeProject, claudeId)
// Native continuation bindings select the latest runtime once, including a
// worker stored under Claude's jobs directory rather than projects/.
const bgId = 'a1111111-1111-4111-8111-111111111111'
const bgNext = 'b1111111-1111-4111-8111-111111111111'
const mapFile = id => path.join(xdg, 'ait-mcp', `claude-thread-${id}.json`)
write(mapFile(bgId), JSON.stringify({ runtime: bgId, source: claudeId, identity: claudeId, project: claudeProject, config: path.join(home, '.claude') }))
result = run('@claude-session')
assertSelection(result, 'claude', claudeProject, bgId)
write(mapFile(bgNext), JSON.stringify({ runtime: bgNext, source: bgId, identity: claudeId, project: claudeProject, config: path.join(home, '.claude') }))
result = run('@claude-session')
assertSelection(result, 'claude', claudeProject, bgNext)
fs.unlinkSync(mapFile(bgId))
fs.unlinkSync(mapFile(bgNext))

result = run('@codex-session')
assertSelection(result, 'codex', codexProject, codexId)
result = run(claudeId)
assertSelection(result, 'claude', claudeProject, claudeId)
result = run(codexId)
assertSelection(result, 'codex', codexProject, codexId)

// Pre-upgrade identities retain their old names. Presence must join on DID
// when the directory hydrates the new private machine namespace, for BOTH
// harnesses and both listed/retired directory scopes. Discovery never writes.
const upgradedActors = directoryActors.map((actor) => ({
  ...actor, handle: `${actor.handle.split('.')[0]}.${'b'.repeat(52)}.aitproto.com`,
}))
const identitySnapshots = [claudeId, codexId].map((id) => fs.readFileSync(identityPath(id), 'utf8'))
write(actorsFile, JSON.stringify([
  ...Array.from({ length: 101 }, (_, i) => ({did: 'did:plc:prefixneighbor', handle: `codex-session-extra-${i}.test`})),
  ...upgradedActors,
]))
write(liveFile, JSON.stringify(upgradedActors.map((actor) => actor.handle)))
for (const retired of [[], upgradedActors.map((actor) => actor.handle)]) {
  write(retiredFile, JSON.stringify(retired))
  for (const [oldHandle, harness, project, id] of [
    [claudeHandle, 'claude', claudeProject, claudeId],
    [codexHandle, 'codex', codexProject, codexId],
  ]) {
    result = run(oldHandle, 'yes\n')
    assertSelection(result, harness, project, id)
    assert.match(result.stderr, /Resume it anyway\? \[y\/N\]/,
      `${harness} with old stored name must be confirmed live by its DID`)
    result = run(id, 'n\n')
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /resume cancelled; no harness was started/)
  }
}
assert.deepEqual([claudeId, codexId].map((id) => fs.readFileSync(identityPath(id), 'utf8')), identitySnapshots)

// A live namesake with a different DID must not make either local session live.
write(retiredFile, '[]')
write(actorsFile, JSON.stringify([
  ...directoryActors.map((actor) => ({ ...actor, did: 'did:plc:otherowner' })), ...upgradedActors,
]))
write(liveFile, JSON.stringify([claudeHandle, codexHandle]))
for (const [handle, harness, project, id] of [
  [claudeHandle, 'claude', claudeProject, claudeId],
  [codexHandle, 'codex', codexProject, codexId],
]) {
  result = run(handle)
  assertSelection(result, harness, project, id)
  assert.doesNotMatch(result.stderr, /Resume it anyway\? \[y\/N\]/)
}
write(actorsFile, JSON.stringify(directoryActors))
write(liveFile, '[]')

// A duplicate public handle fails closed and exposes only safe row data.
const duplicateId = '66666666-6666-4666-8666-666666666666'
const duplicateProject = path.join(root, 'duplicate.project')
mkdir(duplicateProject)
write(path.join(claudeDir, `${duplicateId}.jsonl`),
  JSON.stringify({ cwd: duplicateProject }) + '\n')
writeIdentity(duplicateId, claudeHandle)
result = run(claudeHandle)
assert.equal(result.status, 1)
assert.match(result.stderr, /ambiguous/)
assert.equal(result.stderr.includes(fakeSecret), false)
fs.unlinkSync(path.join(claudeDir, `${duplicateId}.jsonl`))
fs.unlinkSync(identityPath(duplicateId))

// A partial query renders only its match and a numbered answer selects it.
result = run('spaces_under', '1\n')
assertSelection(result, 'claude', claudeProject, claudeId)
assert.match(result.stderr, /claude-session/)

// No query orders the more recently updated Codex thread first; EOF cancels without launch.
result = run('', '')
assert.equal(result.status, 0, result.stderr)
assert.match(result.stderr, /1\.\s+@codex-session/)
assert.equal(result.stderr.includes('\t'), false)
assert.equal(result.stderr.includes(machineKey), false, 'normal table hides machine namespace')
const tableLines = result.stderr.split('\n')
const headerLine = tableLines.find((line) => line.includes('SESSION') && line.includes('LAST USED'))
const codexLine = tableLines.find((line) => line.includes('@codex-session'))
const claudeLine = tableLines.find((line) => line.includes('@claude-session'))
assert.ok(headerLine && codexLine && claudeLine)
const harnessColumn = headerLine.indexOf('HARNESS')
const projectColumn = headerLine.indexOf('PROJECT')
const lastUsedColumn = headerLine.indexOf('LAST USED')
assert.equal(codexLine.slice(harnessColumn, projectColumn).trim(), 'codex')
assert.equal(claudeLine.slice(harnessColumn, projectColumn).trim(), 'claude')
assert.equal(codexLine.slice(projectColumn, lastUsedColumn).trim(), codexProject)
assert.equal(claudeLine.slice(projectColumn, lastUsedColumn).trim(), claudeProject)
assert.match(codexLine.slice(lastUsedColumn), /^[A-Z][a-z]{2} \d{1,2}, \d{4}, .* UTC$/)
assert.match(claudeLine.slice(lastUsedColumn), /^[A-Z][a-z]{2} \d{1,2}, \d{4}, .* UTC$/)
assert.match(result.stderr, /\nresume cancelled; no harness was started/)
assert.equal(result.stdout, '')
// A thread AIT still maps but Codex no longer has is left out, not an error.
assert.doesNotMatch(result.stderr, /gone-codex\.test|corrupt-codex\.test|not answering/)
result = run('gone-codex')
assert.equal(result.status, 1)
assert.match(result.stderr, /no resumable AIT session matched/)

// Repeated narrowing keeps one readline interface, so piped lines are not lost.
result = run('', 'session\n1\n')
assertSelection(result, 'codex', codexProject, codexId)

// AppView presence keeps live sessions out of the ordinary table. An exact
// live handle or identifier gets one default-no confirmation instead.
write(liveFile, JSON.stringify([codexHandle]))
result = run('', '')
assert.equal(result.status, 0, result.stderr)
assert.match(result.stderr, /@claude-session/)
assert.doesNotMatch(result.stderr, /@codex-session/)
assert.match(result.stderr, /1 live session hidden/)
result = run('codex-session', 'yes\n')
assertSelection(result, 'codex', codexProject, codexId)
assert.match(result.stderr, /Resume it anyway\? \[y\/N\]/)
result = run(codexHandle, 'y\n')
assertSelection(result, 'codex', codexProject, codexId)
assert.match(result.stderr, /@codex-session checked in within the last five minutes/)
write(liveFile, JSON.stringify([claudeHandle, codexHandle]))
result = run(claudeHandle, 'YeS\n')
assertSelection(result, 'claude', claudeProject, claudeId)
result = run(claudeId, 'yes\n')
assertSelection(result, 'claude', claudeProject, claudeId)
result = run(codexId, 'Y\n')
assertSelection(result, 'codex', codexProject, codexId)
write(liveFile, JSON.stringify([codexHandle]))
result = run(claudeHandle, '')
assertSelection(result, 'claude', claudeProject, claudeId)
assert.doesNotMatch(result.stderr, /Resume it anyway\? \[y\/N\]/)
for (const [answer, expectedStatus] of [['', 0], ['n\n', 1], ['later\n', 1]]) {
  result = run(codexHandle, answer)
  assert.equal(result.status, expectedStatus, answer || 'EOF')
  assert.equal(result.stdout, '')
  assert.match(result.stderr, answer === ''
    ? /\nresume cancelled; no harness was started/
    : /resume cancelled; no harness was started/)
}

// Retirement hides an actor from the ordinary directory, not from the live
// status of a locally bound session. A retired live handle must not be offered
// as offline, while a retired offline handle remains resumable.
write(retiredFile, JSON.stringify([codexHandle]))
result = run('', '')
assert.equal(result.status, 0, result.stderr)
assert.doesNotMatch(result.stderr, /@codex-session/)
assert.match(result.stderr, /1 live session hidden/)
result = run(codexHandle, 'yes\n')
assertSelection(result, 'codex', codexProject, codexId)
assert.match(result.stderr, /Resume it anyway\? \[y\/N\]/)
write(liveFile, '[]')
result = run(codexHandle)
assertSelection(result, 'codex', codexProject, codexId)
assert.doesNotMatch(result.stderr, /Resume it anyway\? \[y\/N\]/)
write(retiredFile, '[]')

// A duplicate exact handle remains ambiguous even when one record is live.
const liveDuplicateId = '66666666-6666-4666-8666-666666666666'
const liveDuplicateProject = path.join(root, 'live-duplicate.project')
mkdir(liveDuplicateProject)
write(path.join(claudeDir, `${liveDuplicateId}.jsonl`),
  JSON.stringify({ cwd: liveDuplicateProject }) + '\n')
writeIdentity(liveDuplicateId, 'codex-session.test')
write(liveFile, JSON.stringify([codexHandle]))
result = run('codex-session', 'y\n')
assert.equal(result.status, 1)
assert.match(result.stderr, /ambiguous/)
assert.ok(result.stderr.includes(codexHandle))
assert.ok(result.stderr.includes('codex-session.test'))
assert.doesNotMatch(result.stderr, /Resume it anyway\? \[y\/N\]/)
fs.unlinkSync(path.join(claudeDir, `${liveDuplicateId}.jsonl`))
fs.unlinkSync(identityPath(liveDuplicateId))

// If presence is unavailable, selection fails closed rather than offering
// sessions blindly.
write(liveFile, '[]')
result = run(claudeHandle, '', { APPVIEW_URL: 'http://127.0.0.1:1' })
assert.equal(result.status, 1)
assert.match(result.stderr, /could not check which AIT sessions are live; run: ait start/)

// With the shared Codex server down, Claude sessions still resume and the
// missing Codex sessions are named in one line.
result = run(claudeHandle, '', { AIT_CODEX_SHARED_SOCKET: path.join(root, 'no-server.sock') })
assertSelection(result, 'claude', claudeProject, claudeId)
assert.match(result.stderr, /Codex sessions not listed: the shared Codex server is not answering; run: ait start/)
result = run(codexHandle, '', { AIT_CODEX_SHARED_SOCKET: path.join(root, 'no-server.sock') })
assert.equal(result.status, 1)
assert.match(result.stderr, /Codex sessions not listed: the shared Codex server is not answering; run: ait start/)
// A server that drops the connection mid-listing is handled the same way.
write(codexDropFile, JSON.stringify([codexId]))
result = run(claudeHandle)
assertSelection(result, 'claude', claudeProject, claudeId)
assert.match(result.stderr, /Codex sessions not listed: the shared Codex server is not answering; run: ait start/)
write(codexDropFile, '[]')

// The installed-harness gate and record/project validity are fail-closed.
fs.unlinkSync(path.join(bin, 'codex'))
result = run(codexHandle)
assert.equal(result.status, 1)
assert.match(result.stderr, /no resumable AIT session matched/)
writeExecutable('codex')
fs.rmSync(missingProject, { recursive: true, force: true })
for (const query of [
  'nested-session.test', 'malformed-session.test', 'missing-project.test', 'deleted-codex-project.test',
]) {
  result = run(query)
  assert.equal(result.status, 1, `${query} unexpectedly discovered`)
  assert.match(result.stderr, /no resumable AIT session matched/)
}

// One real PTY regression synchronizes on each prompt, sends Ctrl-C, and
// proves the selector is gone before the PTY shell continues. Merely observing
// status 130 is insufficient: Bash can continue after its command-substitution
// child handles SIGINT while that Node process still owns the terminal.
const ptyScript = path.join(root, 'cancel-prompt.exp')
write(ptyScript, `
set timeout -1
spawn -noecho /bin/zsh -f
expect "% "
send "PS1='AIT_TEST_SHELL> '\\r"
expect "AIT_TEST_SHELL> "
send "$env(AIT_PTY_COMMAND)\\r"
expect -exact $env(AIT_PTY_PROMPT)
send "\\003"
set status_seen 0
set cancel_seen 0
expect {
  -exact "resume cancelled; no harness was started" {
    set cancel_seen 1
    exp_continue
  }
  -exact "AIT_TEST_SHELL> " {
    if {$cancel_seen == 0} { exit 1 }
    after 200
    send "$env(AIT_PTY_VERIFY)\\r"
    exp_continue
  }
  -exact "SELECTOR_CHILD_STATUS=130" {
    set status_seen 1
    exp_continue
  }
  -exact "SELECTOR_CHILD_ALIVE=0" {
    if {$status_seen == 1} { exit 0 }
    exit 1
  }
  -exact "SELECTOR_CHILD_ALIVE=1" { exit 1 }
  eof { exit 1 }
}
`)
const cancelPublicRoot = path.join(root, 'public-cancel-checkout')
mkdir(path.join(cancelPublicRoot, 'mcp'))
fs.copyFileSync(path.join(repo, 'ait'), path.join(cancelPublicRoot, 'ait'))
fs.chmodSync(path.join(cancelPublicRoot, 'ait'), 0o755)
fs.cpSync(fixtureDist, path.join(cancelPublicRoot, 'mcp', 'dist'), {
  recursive: true,
})
// The selector lists Codex threads through the app-server client, which needs ws.
fs.symlinkSync(path.join(repo, 'mcp', 'node_modules'), path.join(cancelPublicRoot, 'mcp', 'node_modules'))
const cancelPicker = path.join(cancelPublicRoot, 'mcp', 'dist', 'sessionPicker.js')
const ptyCancel = (query, promptText) => {
  const command = [path.join(cancelPublicRoot, 'ait'), 'resume', query].filter(Boolean)
    .map((part) => JSON.stringify(part)).join(' ')
  const verify = 'child_status=$?; printf "\\nSELECTOR_CHILD_STATUS=%s\\n" "$child_status"' +
    `; ps -axo command= | awk -v needle=${JSON.stringify(cancelPicker)} ` +
    `'index($0, needle) && $1 ~ /(^|\\/)node$/ { found=1 } ` +
    `END { print "SELECTOR_CHILD_ALIVE=" (found ? 1 : 0) }'; exit`
  const result = spawnSync('/usr/bin/expect', [ptyScript], {
    env: {
      ...env,
      AIT_PTY_COMMAND: command,
      AIT_PTY_PROMPT: promptText,
      AIT_PTY_VERIFY: verify,
    },
    cwd: root,
    encoding: 'utf8',
  })
  return result.stdout + result.stderr
}

write(liveFile, '[]')
let ptyOutput = await ptyCancel('', 'Select a session by number or enter a search:')
assert.match(ptyOutput, /SELECTOR_CHILD_STATUS=130/)
assert.match(ptyOutput, /SELECTOR_CHILD_ALIVE=0/)
assert.match(ptyOutput, /\nresume cancelled; no harness was started/)
write(liveFile, JSON.stringify([codexHandle]))
write(retiredFile, JSON.stringify([codexHandle]))
ptyOutput = await ptyCancel(codexHandle, 'Resume it anyway? [y/N]')
assert.match(ptyOutput, /SELECTOR_CHILD_STATUS=130/)
assert.match(ptyOutput, /SELECTOR_CHILD_ALIVE=0/)
assert.match(ptyOutput, /\nresume cancelled; no harness was started/)
write(retiredFile, '[]')

// A delayed signal handler makes the public shell boundary deterministic. The
// outer interactive shell must not redraw its prompt before the selector has
// printed its cancellation result and terminated.
write(cancelPicker, `
process.stdin.resume()
process.once('SIGINT', () => {
  setTimeout(() => {
    process.stderr.write('\\nresume cancelled; no harness was started\\n')
    process.exitCode = 130
    process.stdin.pause()
  }, 250)
})
process.stderr.write('FIXTURE_RESUME_PROMPT')
`)
ptyOutput = await ptyCancel('', 'FIXTURE_RESUME_PROMPT')
assert.match(ptyOutput, /SELECTOR_CHILD_STATUS=130/)
assert.match(ptyOutput, /SELECTOR_CHILD_ALIVE=0/)
assert.match(ptyOutput, /\nresume cancelled; no harness was started/)

// The same record without its identity is not resumable, and a missing project
// is not repaired or listed.
fs.unlinkSync(identityPath(claudeId))
result = run(claudeHandle)
assert.equal(result.status, 1)
assert.match(result.stderr, /no resumable AIT session matched/)
// ...but its exact UUID still resumes it, so the operator can join from inside
// the conversation instead of having to leave AIT's flags behind.
result = run(claudeId)
assert.equal(result.status, 0, result.stderr)
assert.match(result.stdout, new RegExp(`^claude\t.*\t${claudeId}\n$`))
assert.equal(result.stderr.includes('(not joined)'), false)
// The listing does not show it: nothing joined, nothing to name.
result = run('', '\n')
assert.equal(result.stderr.includes('(not joined)'), false)
writeIdentity(claudeId, claudeHandle)
fs.rmSync(missingProject, { recursive: true, force: true })

// Ownership is separate from AIT presence. All process commands are fixture
// children; ownership files and unrelated sessions must remain untouched.
write(writerLock, '')
write(path.join(bin, 'lsof'), `#!${process.execPath}
const fs=require('node:fs'), state=JSON.parse(fs.readFileSync(${JSON.stringify(writerState)}));
state.calls.push('lsof');state.probes=(state.probes??0)+1;
fs.writeFileSync(${JSON.stringify(writerState)},JSON.stringify(state));
if(state.error){console.error('fixture inspection denied');process.exit(2)}
if(!process.argv.includes(${JSON.stringify(writerLock)}))process.exit(2);
if(state.becomesLive && state.probes>=2)fs.writeFileSync(${JSON.stringify(liveFile)},JSON.stringify([${JSON.stringify(codexHandle)}]));
if(state.stallOnRecheck && state.probes>=2)fs.writeFileSync(${JSON.stringify(presenceStall)},'true');
if(state.delayMs)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,state.delayMs);
if(!state.ownerPid || (state.releaseAt && state.probes>=state.releaseAt))process.exit(1);
console.log('p'+state.ownerPid); console.log('f46'); console.log('au'); console.log('n'+${JSON.stringify(writerLock)});
`)
fs.chmodSync(path.join(bin, 'lsof'), 0o755)
write(path.join(bin, 'ps'), `#!${process.execPath}
const fs=require('node:fs'), state=JSON.parse(fs.readFileSync(${JSON.stringify(writerState)}));
state.calls.push('ps');fs.writeFileSync(${JSON.stringify(writerState)},JSON.stringify(state));
console.log('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
`)
fs.chmodSync(path.join(bin, 'ps'), 0o755)
const ownership = fields => write(writerState, JSON.stringify({ enabled: true, ownerPid: 7654321, calls: [], ...fields }))
write(liveFile, '[]'); write(codexDropFile, '[]')
ownership({})
result = run('', '')
assert.match(result.stderr, /STATUS/)
assert.match(result.stderr, /Open in ChatGPT/)
assert.equal(result.stdout, '')
result = run(codexHandle, 'n\n')
assert.equal(result.status, 1)
assert.match(result.stderr, /finish and close only that conversation/)
assert.equal(result.stdout, '')
assert.equal(fs.existsSync(writerLock), true)
assert.equal(fs.readFileSync(writerLock, 'utf8'), '')

// A released/stale file requires no manual cleanup or extra invocation.
ownership({ ownerPid: null })
result = run(codexHandle)
assertSelection(result, 'codex', codexProject, codexId)
assert.equal(fs.existsSync(writerLock), true)
ownership({ ownerPid: codexServer.pid })
result = run(codexHandle)
assertSelection(result, 'codex', codexProject, codexId)
assert.deepEqual(JSON.parse(fs.readFileSync(writerState)).calls, ['lsof'])
ownership({ releaseAt: 2 })
result = run(codexHandle, '\n', { CODEX_HOME: path.join(root, 'wrong-client-home') })
assertSelection(result, 'codex', codexProject, codexId)
assert.match(result.stderr, /already open in ChatGPT/)
ownership({ releaseAt: 2 })
result = run('', '1\n\n')
assertSelection(result, 'codex', codexProject, codexId)
ownership({ releaseAt: 3 })
result = run(codexHandle, '\n\n')
assertSelection(result, 'codex', codexProject, codexId)
assert.equal((result.stderr.match(/already open in ChatGPT/g) ?? []).length, 2)
ownership({ releaseAt: 2, becomesLive: true })
result = run(codexHandle, '\nn\n')
assert.equal(result.status, 1)
assert.equal(result.stdout, '')
assert.match(result.stderr, /Resume it anyway\? \[y\/N\]/)
write(liveFile, '[]')
ownership({ releaseAt: 2, becomesLive: true })
result = run(codexHandle, '\ny\n')
assertSelection(result, 'codex', codexProject, codexId)
write(liveFile, '[]')
ownership({ error: true })
result = run(claudeHandle)
assertSelection(result, 'claude', claudeProject, claudeId)
assert.match(result.stderr, /could not check Codex writer ownership/)
assert.match(result.stderr, /retry ait resume/)

// The user can cancel while an async recheck is pending; its eventual answer
// cannot dispatch a harness after Ctrl-C.
ownership({ releaseAt: 2 })
const cancelling = spawn(process.execPath, [picker, codexHandle], { env, stdio: ['pipe','pipe','pipe'] })
let cancellationOutput = '', cancellationStdout = ''
cancelling.stderr.on('data', chunk => { cancellationOutput += chunk })
cancelling.stdout.on('data', chunk => { cancellationStdout += chunk })
const waitFor = async check => { const end=Date.now()+5000;while(!check()){assert(Date.now()<end,'fixture timed out');await new Promise(resolve=>setTimeout(resolve,10))} }
await waitFor(() => cancellationOutput.includes('Press Enter to recheck'))
const pendingOwner=JSON.parse(fs.readFileSync(writerState));pendingOwner.delayMs=500;write(writerState,JSON.stringify(pendingOwner))
cancelling.stdin.write('\n')
await waitFor(() => JSON.parse(fs.readFileSync(writerState)).probes >= 2)
cancelling.kill('SIGINT')
const cancelCode = await new Promise(resolve => cancelling.once('exit', resolve))
assert.equal(cancelCode, 130)
assert.equal(cancellationStdout, '')
assert.equal((cancellationOutput.match(/resume cancelled; no harness was started/g) ?? []).length, 1)
assert.equal(fs.existsSync(writerLock), true)
ownership({ releaseAt: 2, stallOnRecheck: true })
const stalledCancel = spawn(process.execPath, [picker, codexHandle], { env, stdio: ['pipe','pipe','pipe'] })
let stalledOutput = '', stalledStdout = ''
stalledCancel.stderr.on('data', chunk => { stalledOutput += chunk })
stalledCancel.stdout.on('data', chunk => { stalledStdout += chunk })
await waitFor(() => stalledOutput.includes('Press Enter to recheck'))
stalledCancel.stdin.write('\n')
await waitFor(() => JSON.parse(fs.readFileSync(presenceStall)) === 'entered')
const cancelStarted = Date.now()
stalledCancel.kill('SIGINT')
assert.equal(await new Promise(resolve => stalledCancel.once('exit', resolve)), 130)
assert(Date.now() - cancelStarted < 1500, 'Ctrl-C must abort stalled presence instead of waiting for its timeout')
assert.equal(stalledStdout, '')
assert.equal((stalledOutput.match(/resume cancelled; no harness was started/g) ?? []).length, 1)
assert.doesNotMatch(stalledOutput, /error:/)
write(presenceStall, 'false')
write(writerState, JSON.stringify({ enabled: false, calls: [] }))
console.log('writer-aware selection, same-invocation handoff, safe cancellation and unrelated-session isolation passed')

// Removing the Codex thread-to-identity join makes that row disappear.
fs.unlinkSync(path.join(xdg, 'ait-mcp', `codex-thread-${codexId}.json`))
result = run(codexHandle)
assert.equal(result.status, 1)
assert.match(result.stderr, /no resumable AIT session matched/)

// Exercise the public shell command through a fixture checkout. Its launcher
// only records argv, proving cwd and identifier dispatch without starting any
// real service or harness.
const publicRoot = path.join(root, 'public-checkout')
mkdir(path.join(publicRoot, 'mcp', 'dist'))
fs.copyFileSync(path.join(repo, 'ait'), path.join(publicRoot, 'ait'))
fs.chmodSync(path.join(publicRoot, 'ait'), 0o755)
fs.cpSync(fixtureDist, path.join(publicRoot, 'mcp', 'dist'), { recursive: true })
fs.symlinkSync(path.join(repo, 'mcp', 'node_modules'), path.join(publicRoot, 'mcp', 'node_modules'))
write(path.join(publicRoot, 'bin', 'install.sh'),
  '#!/bin/sh\nprintf "PUBLIC %s %s %s\\n" "$PWD" "$2" "$4"\n')
fs.chmodSync(path.join(publicRoot, 'bin', 'install.sh'), 0o755)
const publicOutput = path.join(root, 'public-output')
const publicOutputFd = fs.openSync(publicOutput, 'w')
result = spawnSync('/usr/bin/script', [
  '-q', '/dev/null', '/bin/bash', '-c',
  `${JSON.stringify(path.join(publicRoot, 'ait'))} resume ${claudeHandle}`,
], { env, cwd: root, stdio: ['ignore', publicOutputFd, 'pipe'], encoding: 'utf8' })
fs.closeSync(publicOutputFd)
const publicStdout = fs.readFileSync(publicOutput, 'utf8')
assert.equal(result.status, 0, result.stderr)
assert.match(publicStdout, new RegExp(`PUBLIC ${claudeProject} claude ${claudeId}`))
assert.equal(result.stderr.includes(fakeSecret), false)

// Public operator entry -> writer handoff -> one original-id/cwd dispatch.
write(path.join(xdg, 'ait-mcp', `codex-thread-${codexId}.json`), JSON.stringify({ threadId: codexId, sessionId: codexId }))
write(liveFile, '[]'); write(retiredFile, '[]')
const handoffPty = path.join(root, 'public-handoff.exp')
write(handoffPty, String.raw`
set timeout 10
spawn -noecho $env(AIT_PTY_EXECUTABLE) resume $env(AIT_PTY_HANDLE)
expect -exact "Press Enter to recheck and resume, or type n to cancel: "
if {$env(AIT_PTY_HANDOFF) eq "release"} { send "\r" } else { send "n\r" }
expect eof
set status [wait]
exit [lindex $status 3]
`)
const publicHandoff = answer => spawnSync('/usr/bin/expect', [handoffPty], {
  env: { ...env, AIT_PTY_EXECUTABLE: path.join(publicRoot, 'ait'), AIT_PTY_HANDLE: codexHandle, AIT_PTY_HANDOFF: answer },
  cwd: root, encoding: 'utf8', timeout: 15000,
})
ownership({ releaseAt: 2 })
result = publicHandoff('release')
assert.ifError(result.error)
assert.equal(result.status, 0, result.stdout + result.stderr)
assert.ok(result.stdout.includes(`PUBLIC ${codexProject} codex ${codexId}`), result.stdout)
assert.match(result.stdout, /already open in ChatGPT/)
assert.equal((result.stdout.match(/PUBLIC /g) ?? []).length, 1)
ownership({})
result = publicHandoff('cancel')
assert.ifError(result.error)
assert.doesNotMatch(result.stdout + result.stderr, /PUBLIC /)
assert.equal(fs.readFileSync(writerLock, 'utf8'), '')
console.log('public ait resume owner handoff dispatches once; cancellation never dispatches')

appviewServer.kill()
await new Promise((resolve) => appviewServer.once('close', resolve))
codexServer.kill()
await new Promise((resolve) => codexServer.once('close', resolve))
console.log('session picker tests passed')
