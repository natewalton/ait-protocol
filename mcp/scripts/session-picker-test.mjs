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
const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: xdg,
  PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
}
const picker = path.resolve(new URL('../dist/sessionPicker.js', import.meta.url).pathname)
const repo = path.resolve(new URL('../..', import.meta.url).pathname)
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }))

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

const run = (query = '', input = '') => spawnSync(
  process.execPath,
  [picker, query],
  { env, input, encoding: 'utf8' },
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
assert.match(result.stderr, /1\. @codex-session\.test/)
assert.match(result.stderr, /resume cancelled; no harness was started/)
assert.equal(result.stdout, '')

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

// Ctrl-C cancels the interactive selector without producing a launch record.
const interrupted = await new Promise((resolve) => {
  const child = spawn(process.execPath, [picker], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  let signalled = false
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
    if (!signalled && stderr.includes('Select a session by number or enter a search:')) {
      signalled = true
      child.kill('SIGINT')
    }
  })
  child.on('close', (status) => resolve({ status, stdout: '', stderr }))
})
assert.equal(interrupted.status, 130)
assert.match(interrupted.stderr, /resume cancelled; no harness was started/)

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
result = spawnSync(path.join(publicRoot, 'ait'), ['resume', claudeHandle], {
  env,
  cwd: root,
  encoding: 'utf8',
})
assert.equal(result.status, 0, result.stderr)
assert.equal(result.stdout.trim(), `PUBLIC ${claudeProject} claude ${claudeId}`)
assert.equal(result.stderr.includes(fakeSecret), false)

console.log('session picker tests passed')
