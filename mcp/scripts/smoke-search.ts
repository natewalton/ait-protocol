// Smoke test for the searchActors vertical (specs/actor-search.md).
//
// Verifies the directory-search endpoint through the end-client surface (MCP
// tool → PDS service-proxy → AppView), never raw HTTP to a service port:
// end-client parity is absolute, even for a test (ADR-0006, no architecture
// penetration). This is the full-stack proof acceptance #3/#5 ask for.
//
// Approach: join a *throwaway* identity (just to authenticate the call — a real
// end-client must be logged in), then assert searchActors(q="wa") surfaces the
// pre-existing, already-indexed fixture @watch-smoke-test.test. We do NOT
// createAccount the fixture: handles are permanent (ADR-0014) and it already
// exists, so a create would fail "handle already taken". A fresh randomUUID()
// session each run means the throwaway never collides.
//
// Run against a live local stack (bin/start-all.sh) with the AppView serving
// ait.actor.searchActors:
//
//   npx tsx mcp/scripts/smoke-search.ts

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = path.resolve(__dirname, '..', 'src', 'server.ts')
// Spawn tsx directly, not via `npx`/`npm exec`: the npm-exec wrapper process
// sits between the MCP client and the server's stdio and breaks the JSON-RPC
// handshake, so connect() hangs and the client re-spawns. The repo-local tsx
// binary keeps stdio direct.
const tsxBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx')

const SESSION_ID = randomUUID() // fresh throwaway identity each run
const HANDLE_HINT = `smoke-${SESSION_ID.slice(0, 8)}` // unique, never taken, non-'wa'
const EXPECT_HANDLE = 'watch-smoke-test.test' // pre-existing, indexed fixture
const PREFIX = 'wa'
const POLL_ATTEMPTS = 20
const POLL_INTERVAL_MS = 500

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function textOf(result: { content?: Array<{ type: string; text?: string }> }) {
  return (result.content ?? [])
    .map((c) => (c.type === 'text' ? c.text ?? '' : ''))
    .join('\n')
}

async function main() {
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [serverEntry],
    env: {
      ...process.env,
      PDS_URL: process.env.PDS_URL ?? 'http://localhost:2583',
      APPVIEW_DID: process.env.APPVIEW_DID ?? 'did:plc:aitappview000000000001',
      AIT_MCP_TEST_SESSION_ID: SESSION_ID,
    } as Record<string, string>,
  })

  const client = new Client({ name: 'ait-smoke-search', version: '0.0.0' })
  await client.connect(transport)

  // Throwaway identity — searchActors is an authenticated end-client call, so
  // we need a session. Unique slug + fresh UUID → never "handle taken".
  const joinResult = await client.callTool({
    name: 'join',
    arguments: { handle_hint: HANDLE_HINT },
  })
  if ((joinResult as { isError?: boolean }).isError) {
    throw new Error(`join failed: ${textOf(joinResult as never)}`)
  }
  console.log(`joined throwaway identity (hint=${HANDLE_HINT})`)

  // Assert searchActors(q="wa") surfaces the indexed fixture. Poll to absorb
  // any indexing lag; surface a route error immediately rather than masking it
  // as "not found".
  let surfaced = false
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const res = await client.callTool({
      name: 'searchActors',
      arguments: { query: PREFIX },
    })
    if ((res as { isError?: boolean }).isError) {
      throw new Error(`searchActors(query=${PREFIX}) errored: ${textOf(res as never)}`)
    }
    if (textOf(res as never).includes(EXPECT_HANDLE)) {
      surfaced = true
      break
    }
    await sleep(POLL_INTERVAL_MS)
  }
  if (!surfaced) {
    const secs = (POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000
    throw new Error(
      `searchActors(query=${PREFIX}) did not surface @${EXPECT_HANDLE} within ${secs}s`,
    )
  }
  console.log(`ok — searchActors(query=${PREFIX}) surfaces @${EXPECT_HANDLE}`)

  // Bad input is rejected (zod at the tool boundary; the lexicon enforces the
  // same bounds at the endpoint). A throw or an isError result both count.
  const expectRejected = async (
    args: Record<string, unknown>,
    label: string,
  ) => {
    const res = await client
      .callTool({ name: 'searchActors', arguments: args })
      .catch(() => ({ isError: true }))
    if (!(res as { isError?: boolean }).isError) {
      throw new Error(`${label}: expected rejection, got a result`)
    }
    console.log(`ok — ${label} rejected`)
  }
  await expectRejected({ query: '' }, 'empty query')
  await expectRejected({ query: PREFIX, limit: 0 }, 'limit=0')
  await expectRejected({ query: PREFIX, limit: 101 }, 'limit=101')

  await client.close()
  console.log('\nsmoke-search: all assertions passed')
}

main().catch((err) => {
  console.error('\nsmoke-search FAILED:', err)
  process.exit(1)
})
