// Verifies the lower-level Server refactor (step 4 of specs/notification-push.md)
// by spawning the MCP and calling tools/list. No PDS/AppView needed — listTools
// only introspects local schemas.
//   (a) tools/list returns 8 tools with the expected names
//   (b) each tool has a description and an object-shaped inputSchema
//   (c) join's inputSchema has handle_hint as a required string
//   (d) tools/call on an unknown tool returns an error

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MCP_SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'server.js',
)

const env = { ...process.env }
delete env.CLAUDE_PROJECT_DIR
env.AIT_MCP_TEST_SESSION_ID = randomUUID()
env.PDS_URL = 'http://localhost:2583'
env.APPVIEW_DID = 'did:plc:aitappview000000000001'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['--enable-source-maps', MCP_SERVER],
  env,
})
const client = new Client({ name: 'list-tools-test', version: '0.0.0' })
await client.connect(transport)

let failures = 0
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`ok    ${label}`)
  } else {
    console.error(`FAIL  ${label} ${detail}`)
    failures++
  }
}

const EXPECTED = [
  'join',
  'post',
  'getAuthorFeed',
  'follow',
  'getTimeline',
  'reply',
  'getPostThread',
  'listNotifications',
]

const list = await client.listTools()
const names = list.tools.map((t) => t.name).sort()
check(
  '(a) 8 tools listed',
  names.length === 8,
  `got ${names.length}: ${names.join(',')}`,
)
check(
  '(a) tool names match expected',
  EXPECTED.slice().sort().join(',') === names.join(','),
  `expected ${EXPECTED.slice().sort().join(',')}, got ${names.join(',')}`,
)

for (const tool of list.tools) {
  check(
    `(b) ${tool.name} has non-empty description`,
    typeof tool.description === 'string' && tool.description.length > 10,
  )
  check(
    `(b) ${tool.name} has object inputSchema`,
    tool.inputSchema && tool.inputSchema.type === 'object',
  )
}

const join = list.tools.find((t) => t.name === 'join')
check(
  '(c) join.inputSchema.properties.handle_hint is a string',
  join?.inputSchema?.properties?.handle_hint?.type === 'string',
)
check(
  '(c) join.inputSchema.required includes handle_hint',
  Array.isArray(join?.inputSchema?.required) &&
    join.inputSchema.required.includes('handle_hint'),
)

const unknownResult = await client
  .callTool({ name: 'definitely-not-a-tool', arguments: {} })
  .catch((e) => ({ error: e.message ?? String(e) }))
check(
  '(d) unknown tool name returns error',
  !!unknownResult?.error || unknownResult?.isError === true,
  JSON.stringify(unknownResult).slice(0, 100),
)

await client.close()

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall ok')
