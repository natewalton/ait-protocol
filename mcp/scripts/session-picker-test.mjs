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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-session-picker-'))
const home = path.join(root, 'home')
const xdg = path.join(root, 'xdg')
const bin = path.join(root, 'bin')
const claudeProject = path.join(root, 'project with spaces_under.score')
const codexProject = path.join(root, 'codex project')
const missingProject = path.join(root, 'deleted project')
const claudeId = '11111111-1111-4111-8111-111111111111'
const codexId = '22222222-2222-4222-8222-222222222222'
const claudeHandle = 'claude-session.test'
const codexHandle = 'codex-session.test'
const fakeSecret = 'THIS MUST NEVER BE PRINTED'

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
  did: 'did:plc:fixture',
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
const appviewServerFile = path.join(root, 'appview-server.mjs')
write(liveFile, '[]')
write(appviewServerFile, `
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
const [liveFile, ...handles] = process.argv.slice(2)
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const query = (url.searchParams.get('q') ?? '').toLowerCase()
  const live = new Set(JSON.parse(readFileSync(liveFile, 'utf8')))
  const actors = handles
    .filter((handle) => handle.startsWith(query))
    .map((handle) => ({ did: 'did:plc:fixture', handle, live: live.has(handle) }))
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ actors }))
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port) + '\\n')
})
`)
const appviewServer = spawn(
  process.execPath,
  [appviewServerFile, liveFile, claudeHandle, codexHandle],
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
  XDG_DATA_HOME: xdg,
  APPVIEW_URL: `http://127.0.0.1:${appviewPort}`,
  TZ: 'UTC',
  PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
}
for (const marker of [
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'AIT_SESSION_ID', 'AI_AGENT',
]) delete env[marker]
const picker = path.resolve(new URL('../dist/sessionPicker.js', import.meta.url).pathname)
const repo = path.resolve(new URL('../..', import.meta.url).pathname)
process.on('exit', () => {
  appviewServer.kill()
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

const rollout = path.join(home, '.codex', 'sessions', '2026', '09', '04',
  `rollout-2026-09-04T00-00-00-${codexId}.jsonl`)
write(rollout, `${JSON.stringify({
  type: 'session_meta',
  payload: { id: codexId, cwd: codexProject },
})}\n${JSON.stringify({ type: 'event_msg', payload: { text: fakeSecret } })}\n`)
write(path.join(xdg, 'ait-mcp', `codex-thread-${codexId}.json`), JSON.stringify({
  threadId: codexId,
  sessionId: codexId,
}))
writeIdentity(codexId, codexHandle)
fs.utimesSync(rollout, new Date(Date.now() + 1000), new Date(Date.now() + 1000))

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
result = run(claudeHandle)
assertSelection(result, 'claude', claudeProject, claudeId)
result = run(claudeId)
assertSelection(result, 'claude', claudeProject, claudeId)
result = run(codexId)
assertSelection(result, 'codex', codexProject, codexId)

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
assert.match(result.stderr, /claude-session\.test/)

// No query orders the newer Codex rollout first; EOF cancels without launch.
result = run('', '')
assert.equal(result.status, 0, result.stderr)
assert.match(result.stderr, /1\.\s+@codex-session\.test/)
assert.equal(result.stderr.includes('\t'), false)
const tableLines = result.stderr.split('\n')
const headerLine = tableLines.find((line) => line.includes('SESSION') && line.includes('LAST USED'))
const codexLine = tableLines.find((line) => line.includes('@codex-session.test'))
const claudeLine = tableLines.find((line) => line.includes('@claude-session.test'))
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

// Repeated narrowing keeps one readline interface, so piped lines are not lost.
result = run('', 'session\n1\n')
assertSelection(result, 'codex', codexProject, codexId)

// AppView presence keeps live sessions out of the ordinary table. An exact
// live handle or identifier gets one default-no confirmation instead.
write(liveFile, JSON.stringify([codexHandle]))
result = run('', '')
assert.equal(result.status, 0, result.stderr)
assert.match(result.stderr, /@claude-session\.test/)
assert.doesNotMatch(result.stderr, /@codex-session\.test/)
assert.match(result.stderr, /1 live session hidden/)
result = run('codex-session')
assert.equal(result.status, 1)
assert.doesNotMatch(result.stderr, /Resume it anyway\? \[y\/N\]/)
result = run(codexHandle, 'y\n')
assertSelection(result, 'codex', codexProject, codexId)
assert.match(result.stderr, /@codex-session\.test checked in within the last five minutes/)
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

// A duplicate exact handle remains ambiguous even when one record is live.
const liveDuplicateId = '66666666-6666-4666-8666-666666666666'
const liveDuplicateProject = path.join(root, 'live-duplicate.project')
mkdir(liveDuplicateProject)
write(path.join(claudeDir, `${liveDuplicateId}.jsonl`),
  JSON.stringify({ cwd: liveDuplicateProject }) + '\n')
writeIdentity(liveDuplicateId, codexHandle)
write(liveFile, JSON.stringify([codexHandle]))
result = run(codexHandle, 'y\n')
assert.equal(result.status, 1)
assert.match(result.stderr, /ambiguous/)
assert.doesNotMatch(result.stderr, /Resume it anyway\? \[y\/N\]/)
fs.unlinkSync(path.join(claudeDir, `${liveDuplicateId}.jsonl`))
fs.unlinkSync(identityPath(liveDuplicateId))

// If presence is unavailable, selection fails closed rather than offering
// sessions blindly.
write(liveFile, '[]')
result = run(claudeHandle, '', { APPVIEW_URL: 'http://127.0.0.1:1' })
assert.equal(result.status, 1)
assert.match(result.stderr, /could not check which AIT sessions are live; run: ait start/)

// The installed-harness gate and record/project validity are fail-closed.
fs.unlinkSync(path.join(bin, 'codex'))
result = run(codexHandle)
assert.equal(result.status, 1)
assert.match(result.stderr, /no resumable AIT session matched/)
writeExecutable('codex')
fs.rmSync(missingProject, { recursive: true, force: true })
for (const query of ['nested-session.test', 'malformed-session.test', 'missing-project.test']) {
  result = run(query)
  assert.equal(result.status, 1, `${query} unexpectedly discovered`)
  assert.match(result.stderr, /no resumable AIT session matched/)
}

// One real PTY regression synchronizes on each prompt, sends Ctrl-C, and
// captures the selector child's status inside the PTY shell.
const ptyScript = path.join(root, 'cancel-prompt.exp')
write(ptyScript, `
set timeout -1
spawn -noecho /bin/bash -c $env(AIT_PTY_COMMAND)
expect {
  -exact $env(AIT_PTY_PROMPT) {
    send "\\003"
    exp_continue
  }
  -exact "SELECTOR_CHILD_STATUS=130" { exit 0 }
  eof { exit 1 }
}
`)
const ptyCancel = (query, promptText) => {
  const command = [process.execPath, picker, query].filter(Boolean)
    .map((part) => JSON.stringify(part)).join(' ') +
    '; child_status=$?; printf "\\nSELECTOR_CHILD_STATUS=%s\\n" "$child_status"'
  const result = spawnSync('/usr/bin/expect', [ptyScript], {
    env: { ...env, AIT_PTY_COMMAND: command, AIT_PTY_PROMPT: promptText },
    cwd: root,
    encoding: 'utf8',
  })
  return result.stdout + result.stderr
}

write(liveFile, '[]')
let ptyOutput = await ptyCancel('', 'Select a session by number or enter a search:')
assert.match(ptyOutput, /SELECTOR_CHILD_STATUS=130/)
assert.match(ptyOutput, /\nresume cancelled; no harness was started/)
write(liveFile, JSON.stringify([codexHandle]))
ptyOutput = await ptyCancel(codexHandle, 'Resume it anyway? [y/N]')
assert.match(ptyOutput, /SELECTOR_CHILD_STATUS=130/)
assert.match(ptyOutput, /\nresume cancelled; no harness was started/)

// The same record without its identity is not resumable, and a missing project
// is not repaired or listed.
fs.unlinkSync(identityPath(claudeId))
result = run(claudeHandle)
assert.equal(result.status, 1)
assert.match(result.stderr, /no resumable AIT session matched/)
writeIdentity(claudeId, claudeHandle)
fs.rmSync(missingProject, { recursive: true, force: true })

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
fs.cpSync(path.join(repo, 'mcp', 'dist'), path.join(publicRoot, 'mcp', 'dist'), { recursive: true })
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

appviewServer.kill()
await new Promise((resolve) => appviewServer.once('close', resolve))
console.log('session picker tests passed')
