// End-to-end test of editProfile + getProfile across two MCP-server children.
//
// A joins → A writes a bio via editProfile → B joins → B reads A's profile
// via getProfile and should see the bio. Also checks the read-modify-write
// merge (a second editProfile setting only displayName keeps the bio) and a
// self-read.
//
// Same harness shape as follow-timeline-test.mjs: each child's persisted
// identity keys on the test-only AIT_MCP_TEST_SESSION_ID env var, and
// XDG_DATA_HOME routes at a tmpdir so test runs don't touch the user's real
// identity store. Requires the PDS, PLC, and AppView running locally.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const MCP_SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'server.js',
)
const STAMP = Date.now().toString(36)
const XDG_TMP = mkdtempSync(join(tmpdir(), 'ait-profile-test-'))
mkdirSync(join(XDG_TMP, 'ait-mcp'), { recursive: true })

process.on('exit', () => {
  try {
    rmSync(XDG_TMP, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

const SESSION_A = randomUUID()
const SESSION_B = randomUUID()

async function spawnMcp(name, sessionId) {
  const env = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  env.PDS_URL = 'http://localhost:2583'
  env.APPVIEW_DID = 'did:plc:aitappview000000000001'
  env.XDG_DATA_HOME = XDG_TMP
  env.AIT_MCP_TEST_SESSION_ID = sessionId
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--enable-source-maps', MCP_SERVER],
    env,
  })
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(transport)
  return client
}

function extractIds(joinText) {
  const did = joinText.match(/DID:\s+(did:plc:\S+)/)?.[1]
  const handle = joinText.match(/Handle:\s+@(\S+)/)?.[1]
  return { did, handle }
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

// Profile writes are eventually-consistent: editProfile commits to the PDS
// repo, then the firehose delivers the record to the AppView, which indexes
// it. So a getProfile right after an editProfile can legitimately race ahead
// of indexing. Poll until the record shows up rather than guessing a delay
// (this also absorbs the firehose's from-seq-0 replay on a cold AppView DB).
async function pollProfile(client, args, needle, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const res = await client.callTool({ name: 'getProfile', arguments: args })
    last = res.content[0].text
    if (last.includes(needle)) return last
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(
    `Timed out waiting for getProfile(${JSON.stringify(args)}) to include ` +
      `"${needle}". Last saw:\n${last}`,
  )
}

const BIO = 'I build infrastructure'

// === Round A: actor A joins, writes a bio, then sets a displayName.
let c = await spawnMcp('profile-A', SESSION_A)
const jA = await c.callTool({ name: 'join', arguments: { handle_hint: `pfa${STAMP}` } })
const idA = extractIds(jA.content[0].text)
console.log('A joined:', idA)

const e1 = await c.callTool({ name: 'editProfile', arguments: { description: BIO } })
console.log('A editProfile(description):', e1.content[0].text.split('\n')[0])
assert(/Profile saved/.test(e1.content[0].text), 'editProfile should report saved')

// Read-modify-write: setting only displayName must keep the bio.
const e2 = await c.callTool({ name: 'editProfile', arguments: { displayName: 'Infra A' } })
console.log('A editProfile(displayName):', e2.content[0].text.split('\n')[0])

// Write-gate: an over-256-grapheme bio must be rejected at write (assertValidAitRecord),
// not silently stored — otherwise it would 500 every getProfile that reads it back.
const longBio = 'x'.repeat(300)
const eLong = await c.callTool({ name: 'editProfile', arguments: { description: longBio } })
console.log('A editProfile(300-char bio) →', eLong.isError ? 'rejected' : 'ACCEPTED')
assert(eLong.isError === true, 'over-length bio should be rejected by the lexicon write-gate')
assert(/graphemes/i.test(eLong.content[0].text), 'rejection should cite the grapheme limit')

// A reads its own profile back — poll until the firehose has indexed the
// record. Asserting on the bio also proves the displayName-only second edit
// merged (didn't wipe the description).
const selfRead = await pollProfile(c, {}, BIO)
console.log('\nA self getProfile:\n' + selfRead)
assert(selfRead.includes('Infra A'), 'A self-read should include the displayName')
await c.close()

// === Round B: fresh actor B joins, reads A's profile by handle.
c = await spawnMcp('profile-B', SESSION_B)
const jB = await c.callTool({ name: 'join', arguments: { handle_hint: `pfb${STAMP}` } })
const idB = extractIds(jB.content[0].text)
console.log('\nB joined:', idB)

const got = await pollProfile(c, { actor: idA.handle }, BIO)
console.log(`\nB getProfile(@${idA.handle}):\n` + got)
assert(got.includes('Infra A'), "B should see A's displayName (merge preserved bio + name)")
await c.close()

console.log(
  '\nPASS: profile write + cross-session read + read-modify-write merge + over-length write-gate',
)
