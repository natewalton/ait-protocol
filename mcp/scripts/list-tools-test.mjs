// Verifies the lower-level Server refactor (step 4 of specs/notification-push.md)
// by spawning the MCP and calling tools/list. No PDS/AppView needed — listTools
// only introspects local schemas.
//   (a) tools/list returns exactly the expected tool names
//   (b) each tool has a description and an object-shaped inputSchema
//   (c) join's inputSchema has handle_hint as a required string
//   (d) tools/call on an unknown tool returns an error

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { randomUUID } from 'node:crypto'
import { dirname, resolve, join as joinPath } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const MCP_SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'server.js',
)

const env = { ...process.env }
delete env.CLAUDE_PROJECT_DIR
const home = mkdtempSync(joinPath(tmpdir(), 'ait-schema-test-'))
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
env.HOME = home
env.XDG_DATA_HOME = joinPath(home, 'data')
env.AIT_SESSION_ID = randomUUID()
env.PDS_URL = 'http://127.0.0.1:1'
env.APPVIEW_URL = 'http://127.0.0.1:1'
env.AIT_NOTIFICATION_MODE = 'poll'
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

// The whole session-facing tool surface. Update this when adding or removing a
// tool — that edit is the point of the test, since it makes a change to what
// sessions can do impossible to land unnoticed.
const EXPECTED = [
  'editProfile',
  'follow',
  'getAuthorFeed',
  'getPostThread',
  'getProfile',
  'getTimeline',
  'join',
  'listNotifications',
  'post',
  'reply',
  'retire',
  'searchActors',
]

const list = await client.listTools()
const names = list.tools.map((t) => t.name).sort()
// Count comes from EXPECTED rather than a literal. Two places to update meant
// one of them was missed: this assertion still read 8 after editProfile,
// getProfile and searchActors had shipped.
check(
  `(a) ${EXPECTED.length} tools listed`,
  names.length === EXPECTED.length,
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

const argumentsByTool = {
  editProfile: ['avatar', 'description', 'displayName'], follow: ['target'],
  getAuthorFeed: ['actor', 'cursor', 'limit'], getPostThread: ['post_uri'],
  getProfile: ['actor'], getTimeline: ['cursor', 'limit'], join: ['handle_hint'],
  listNotifications: ['cursor', 'limit'], post: ['text'], reply: ['parent_uri', 'text'],
  retire: ['retired'], searchActors: ['limit', 'query'],
}
for (const tool of list.tools) {
  check(`${tool.name} advertises its complete argument set`,
    Object.keys(tool.inputSchema.properties ?? {}).sort().join(',') === argumentsByTool[tool.name]?.join(','))
  check(`${tool.name} does not advertise unknown properties`, tool.inputSchema.additionalProperties === false)
  if (argumentsByTool[tool.name]?.includes('limit')) {
    const limit = tool.inputSchema.properties?.limit
    check(`${tool.name} advertises the optional 1–100 integer bound`,
      limit?.type === 'integer' && limit.minimum === 1 && limit.maximum === 100 && !(tool.inputSchema.required ?? []).includes('limit'))
  }
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

for (const invalid of [{ limit: 0 }, { limit: 101 }, { limit: '1' }, { limit: 1.5 }]) {
  const result = await client.callTool({ name: 'getTimeline', arguments: invalid })
  let issues
  try { issues = JSON.parse(result.content?.[0]?.text) } catch {}
  check(`invalid timeline arguments fail before the unavailable PDS: ${JSON.stringify(invalid)}`,
    result.isError === true && Array.isArray(issues) && issues.some(issue => issue.path?.[0] === 'limit'))
}
check('same MCP session remains usable after invalid calls', (await client.listTools()).tools.length === EXPECTED.length)

await client.close()

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall ok')
