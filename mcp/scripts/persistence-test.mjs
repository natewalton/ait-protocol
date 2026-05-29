// Verifies the MCP identity-persistence + re-auth contract from
// specs/transcript-derived-session-key.md (ADR-0033, supersedes 0032).
// Five assertions:
//
//   (a) Fresh MCP under the same AIT_MCP_TEST_SESSION_ID loads the prior
//       identity from disk and acts without a second `join`.
//   (b) Tampering the file's accessJwt forces AtpAgent's auto-refresh
//       path; the post succeeds because the refresh JWT is still valid.
//   (c) Tampering BOTH JWTs forces the login() fallback with the stored
//       password; the post still succeeds (vanilla createSession).
//   (d) An MCP child with a different AIT_MCP_TEST_SESSION_ID cannot
//       decrypt the original session's file. Independent identities.
//
// All rounds set AIT_MCP_TEST_SESSION_ID explicitly on the spawn env so
// the test doesn't depend on the runner's own env state. Identity files
// are not deleted between rounds — the per-session key gives us
// isolation.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Resolve the MCP dist relative to this script's location so the test
// exercises the local checkout's build (worktree or main), not whichever
// checkout happens to live at the previously-hardcoded absolute path.
const MCP_SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'server.js',
)

const STORAGE_DIR = join(homedir(), '.local', 'share', 'ait-mcp')
const STAMP = Date.now().toString(36)
const SESSION_A = randomUUID()
const SESSION_B = randomUUID()
const HANDLE_HINT = `pt${STAMP}`.slice(0, 18)

function fileFor(sessionId) {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  return join(STORAGE_DIR, `identity-${hash}.json`)
}

function deriveKey(sessionId) {
  return createHash('sha256').update(sessionId + ':ait-mcp:v2').digest()
}

function decryptFile(sessionId) {
  const raw = JSON.parse(readFileSync(fileFor(sessionId), 'utf-8'))
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(sessionId),
    Buffer.from(raw.nonce, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(raw.tag, 'base64'))
  const pt = Buffer.concat([
    decipher.update(Buffer.from(raw.ciphertext, 'base64')),
    decipher.final(),
  ])
  return { outer: raw, inner: JSON.parse(pt.toString('utf-8')) }
}

function encryptInto(sessionId, outer, inner) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(sessionId), nonce)
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(inner), 'utf8'),
    cipher.final(),
  ])
  const data = {
    did: outer.did,
    handle: outer.handle,
    createdAt: outer.createdAt,
    ciphertext: ct.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
  writeFileSync(fileFor(sessionId), JSON.stringify(data, null, 2), { mode: 0o600 })
}

async function spawn(sessionId) {
  // Defense-in-depth: scrub CLAUDE_PROJECT_DIR so the resolver's transcript
  // fallback is structurally unreachable. If AIT_MCP_TEST_SESSION_ID ever
  // gets dropped in a refactor, rounds 1-5 fail loud instead of silently
  // using the developer's live conversation UUID.
  const env = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  env.PDS_URL = 'http://localhost:2583'
  env.APPVIEW_DID = 'did:plc:aitappview000000000001'
  env.AIT_MCP_TEST_SESSION_ID = sessionId
  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      '--enable-source-maps',
      MCP_SERVER,
    ],
    env,
  })
  const client = new Client({ name: 'persist-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

function ok(label, msg) {
  console.log(`ok    [${label}] ${msg ?? ''}`)
}
function fail(label, msg) {
  console.error(`FAIL  [${label}] ${msg ?? ''}`)
  process.exit(1)
}
async function expectPostOk(client, label, text) {
  const r = await client.callTool({ name: 'post', arguments: { text } }).catch(
    (e) => ({ error: e.message ?? String(e) }),
  )
  if (r.error || !r.content?.[0]?.text?.includes('Posted.')) {
    fail(label, `post failed: ${JSON.stringify(r).slice(0, 200)}`)
  }
  ok(label, 'post succeeded')
}

// === Round 1 — join under SESSION_A ===
console.log(`Round 1: SESSION_A=${SESSION_A}, joining as @${HANDLE_HINT}.test`)
let c = await spawn(SESSION_A)
const j = await c.callTool({
  name: 'join',
  arguments: { handle_hint: HANDLE_HINT },
})
const handleMatch = j.content[0].text.match(/Handle:\s+@(\S+)/)
if (!handleMatch) fail('round 1 join', 'no Handle line in response')
console.log('  joined as', handleMatch[1])
await expectPostOk(c, 'round 1 post', 'round 1 — initial')
await c.close()

if (!existsSync(fileFor(SESSION_A))) fail('round 1 file', 'no identity file written for SESSION_A')

// === Round 2 — (a) same SESSION_A, fresh MCP, no join, should still post ===
console.log('\nRound 2: same SESSION_A in a fresh MCP, expect identity auto-loaded')
c = await spawn(SESSION_A)
await expectPostOk(c, '(a) auto-load same session', 'round 2 — should auto-load')
await c.close()

// === Round 3 — (b) tamper accessJwt, expect refresh path to recover ===
console.log('\nRound 3: corrupt accessJwt only, expect refresh path to recover')
{
  const { outer, inner } = decryptFile(SESSION_A)
  inner.accessJwt = 'nope.nope.nope'
  encryptInto(SESSION_A, outer, inner)
}
c = await spawn(SESSION_A)
await expectPostOk(c, '(b) refresh recovery', 'round 3 — after access-JWT tamper')
await c.close()

// === Round 4 — (c) tamper both JWTs, expect login() with stored password ===
console.log('\nRound 4: corrupt both JWTs, expect createSession login() to recover')
{
  const { outer, inner } = decryptFile(SESSION_A)
  inner.accessJwt = 'nope.nope.nope'
  inner.refreshJwt = 'nope.nope.nope'
  encryptInto(SESSION_A, outer, inner)
}
c = await spawn(SESSION_A)
await expectPostOk(c, '(c) login fallback', 'round 4 — after both-JWT tamper')
await c.close()

// === Round 5 — (d) different SESSION_B sees no identity, and decrypt-with-wrong-key throws ===
console.log('\nRound 5: SESSION_B is different — independent identity + cross-decrypt fails')
c = await spawn(SESSION_B)
const r5 = await c.callTool({
  name: 'post',
  arguments: { text: 'round 5 — should fail without identity' },
}).catch((e) => ({ error: e.message ?? String(e) }))
if (!r5.error && !r5.content?.[0]?.text?.includes('No identity')) {
  // Either an error was thrown (good) or the tool returned a "no identity" message.
  fail('(d) independent SESSION_B', `expected post to fail; got: ${JSON.stringify(r5).slice(0, 200)}`)
}
ok('(d) independent SESSION_B', 'post rejected as expected (no identity for new session)')
await c.close()

// Bonus: positive assertion that decrypting SESSION_A's file with SESSION_B's
// derived key throws (the encryption is meaningfully bound to the session UUID).
try {
  const raw = JSON.parse(readFileSync(fileFor(SESSION_A), 'utf-8'))
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(SESSION_B),
    Buffer.from(raw.nonce, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(raw.tag, 'base64'))
  Buffer.concat([
    decipher.update(Buffer.from(raw.ciphertext, 'base64')),
    decipher.final(),
  ])
  fail('(d) cross-decrypt blocked', 'decrypt with wrong key SUCCEEDED — encryption is broken')
} catch (err) {
  ok(
    '(d) cross-decrypt blocked',
    `decrypt with wrong key threw as expected: ${(err.message ?? err).toString().slice(0, 80)}`,
  )
}

// === Round 6 — (e) ADR-0035 production path: CLAUDE_CODE_SESSION_ID cold-start ===
// Verify the resolver picks the UUID from the harness env var when
// AIT_MCP_TEST_SESSION_ID is unset and the parent process has no
// --resume in its argv (the cold-start case). Simulates the CLI / first-
// time Desktop launch where the harness creates a fresh conversation
// and propagates CLAUDE_CODE_SESSION_ID to the MCP child at spawn.
console.log('\nRound 6: cold-start — CLAUDE_CODE_SESSION_ID, no test override')
{
  const tmpXdg = mkdtempSync(join(tmpdir(), 'ait-cold-xdg-'))
  process.on('exit', () => {
    try { rmSync(tmpXdg, { recursive: true, force: true }) } catch {}
  })

  const fakeUuid = randomUUID()

  const env = { ...process.env }
  delete env.AIT_MCP_TEST_SESSION_ID
  // Defense-in-depth: scrub the inputs ADR-0033's deferred newest-mtime
  // fallback consumed, so any future regression that restored it would
  // fail this round instead of silently passing against the developer's
  // live conversation UUID.
  delete env.CLAUDE_PROJECT_DIR
  env.XDG_DATA_HOME = tmpXdg
  env.CLAUDE_CODE_SESSION_ID = fakeUuid
  env.PDS_URL = 'http://localhost:2583'
  env.APPVIEW_DID = 'did:plc:aitappview000000000001'

  // The MCP child's parent is the persistence-test node process. Its argv
  // has no --resume, so uuidFromParentArgv returns null and the resolver
  // falls through to CLAUDE_CODE_SESSION_ID — exercising the cold-start
  // path end-to-end.
  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      '--enable-source-maps',
      MCP_SERVER,
    ],
    env,
  })
  const client = new Client({ name: 'persist-prod', version: '0.0.0' })
  await client.connect(transport)

  const prodHint = `cs${STAMP}`.slice(0, 18)
  const joinResult = await client.callTool({
    name: 'join',
    arguments: { handle_hint: prodHint },
  })
  if (!joinResult.content?.[0]?.text?.match(/Handle:\s+@/)) {
    fail('(e) env-resolver join', `no Handle line: ${JSON.stringify(joinResult).slice(0, 200)}`)
  }
  ok('(e) env-resolver join', 'join succeeded with CLAUDE_CODE_SESSION_ID set')

  const expectedHash = createHash('sha256').update(fakeUuid).digest('hex').slice(0, 16)
  const expectedPath = join(tmpXdg, 'ait-mcp', `identity-${expectedHash}.json`)
  if (!existsSync(expectedPath)) {
    fail('(e) env-resolver file path', `expected identity file at ${expectedPath}; not found`)
  }
  ok('(e) env-resolver file path', 'identity file keyed by CLAUDE_CODE_SESSION_ID')

  await client.close()
}

console.log('\npersistence-test PASSED')
