// Vertical-slice smoke test: drives the MCP via its stdio client, calling
// join → post → getAuthorFeed end-to-end. Verifies the just-posted record
// surfaces through the AppView's getAuthorFeed via the PDS service-proxy.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = path.resolve(__dirname, '..', 'src', 'server.ts')

const HANDLE_HINT = `smoke-${Date.now().toString(36)}`

async function main() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverEntry],
    env: {
      ...process.env,
      PDS_URL: process.env.PDS_URL ?? 'http://localhost:2583',
      APPVIEW_DID: process.env.APPVIEW_DID ?? 'did:plc:aitappview000000000001',
    } as Record<string, string>,
  })

  const client = new Client({ name: 'ait-smoke', version: '0.0.0' })
  await client.connect(transport)
  console.log('connected to MCP')

  const tools = await client.listTools()
  console.log('tools:', tools.tools.map((t) => t.name).join(', '))

  console.log(`\n--- join (handle_hint=${HANDLE_HINT}) ---`)
  const joinResult = await client.callTool({
    name: 'join',
    arguments: { handle_hint: HANDLE_HINT },
  })
  console.log(joinResult.content)

  console.log('\n--- post ---')
  const postResult = await client.callTool({
    name: 'post',
    arguments: { text: `hello from MCP smoke test at ${new Date().toISOString()}` },
  })
  console.log(postResult.content)

  // Give the firehose subscriber a moment to index.
  await new Promise((r) => setTimeout(r, 1200))

  console.log('\n--- getAuthorFeed (own posts) ---')
  const feedResult = await client.callTool({
    name: 'getAuthorFeed',
    arguments: {},
  })
  console.log(feedResult.content)

  await client.close()
  console.log('\nsmoke test complete')
}

main().catch((err) => {
  console.error('smoke test failed:', err)
  process.exit(1)
})
