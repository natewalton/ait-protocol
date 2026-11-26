import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = await mkdtemp(path.join(tmpdir(), 'ait-join-'))
const domain = '.' + 'a'.repeat(52) + '.aitproto.com'
const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const token = 'e30.' + Buffer.from(JSON.stringify({ sub: did, exp: 2147483647 })).toString('base64url') + '.sig'
let handle, creates = 0, logins = 0
const unexpected = []
const pds = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json')
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname.endsWith('/com.atproto.server.describeServer')) {
    res.end(JSON.stringify({ did, availableUserDomains: [domain] }))
    return
  }
  if (url.pathname.endsWith('/com.atproto.server.createAccount')) {
    creates++
    handle = JSON.parse(Buffer.concat(chunks)).handle
  } else if (url.pathname.endsWith('/com.atproto.server.createSession')) {
    logins++
    assert.ok([handle, did].includes(JSON.parse(Buffer.concat(chunks)).identifier))
  } else if (!/\/com\.atproto\.server\.(?:refreshSession|getSession)$/.test(url.pathname)) {
    unexpected.push(url.pathname)
    res.writeHead(503).end('{}')
    return
  }
  res.end(JSON.stringify({ did, handle, accessJwt: token, refreshJwt: token }))
})
pds.listen(0, '127.0.0.1')
await once(pds, 'listening')
const server = fileURLToPath(new URL('../dist/server.js', import.meta.url))

async function withClient(mode, declared, uuid, callback) {
  const url = `http://127.0.0.1:${pds.address().port}`
  const client = new Client({ name: 'join-fixture', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath, args: [server], cwd: root, stderr: 'pipe',
    env: { PATH: process.env.PATH, HOME: root, XDG_DATA_HOME: root, AIT_MCP_TEST_SESSION_ID: uuid,
      PDS_URL: url, APPVIEW_URL: 'http://127.0.0.1:1', AIT_NOTIFICATION_MODE: mode,
      AIT_JOIN_DELIVERY: declared },
  })
  try {
    await client.connect(transport)
    await callback(async hint => {
      const response = await client.callTool({ name: 'join', arguments: { handle_hint: hint } })
      assert.ok(!response.isError, JSON.stringify(response))
      return response.content[0].text
    })
  } finally {
    await client.close()
  }
}

try {
  for (const [mode, declared, delivery] of [
    ['push', '', /Claude Channels/],
    ['poll', 'codex-driver', /the AIT Codex driver/],
    ['poll', '', /every three minutes/],
    ['poll', 'unknown', /every three minutes/],
  ]) {
    const uuid = randomUUID()
    const createCount = creates
    const loginCount = logins
    const check = (text, receipt) => {
      assert.match(text, receipt)
      assert.ok(text.includes(did))
      const [, orientation, continuation, cadence] = text.split('\n\n')
      assert.ok((orientation + ' ' + continuation).split(/\s+/).length <= 150)
      assert.ok(cadence.split(/\s+/).length <= 100)
      assert.match(text, /searchActors/)
      assert.match(cadence, delivery)
      assert.match(cadence, /Keep an existing matching job and its cursor/)
      if (mode === 'push' || declared === 'codex-driver') {
        assert.match(cadence, /every ten minutes/)
        assert.doesNotMatch(cadence, /listNotifications/)
      } else {
        assert.match(cadence, /listNotifications and getTimeline in parallel/)
        assert.match(cadence, /Without a scheduler/)
      }
      assert.doesNotMatch(text, /CronCreate|ToolSearch|mcp__|re-registered|delivery restored/)
    }
    await withClient(mode, declared, uuid, async join => {
      check(await join('join-fixture'), /Joined AIT as @join-fixture/)
      check(await join('discard-this-hint'), /Re-authenticated as @join-fixture/)
    })
    if (mode !== 'push') {
      await withClient(mode, declared, uuid, async join => {
        check(await join('discard-another-hint'), /Re-authenticated as @join-fixture/)
      })
    }
    assert.equal(creates, createCount + 1)
    assert.ok(logins >= loginCount + (mode === 'push' ? 1 : 2), 'rejoins must refresh authentication')
  }
  assert.deepEqual(unexpected, [])
  console.log('PASS join, re-authentication and restored MCP process across all delivery declarations')
} finally {
  pds.closeAllConnections()
  await new Promise(resolve => pds.close(resolve))
  await rm(root, { recursive: true, force: true })
}
