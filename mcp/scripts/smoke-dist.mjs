import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['--enable-source-maps', '/Users/nwalton/Desktop/ait-protocol/mcp/dist/server.js'],
  env: { ...process.env, PDS_URL: 'http://localhost:2583', APPVIEW_DID: 'did:plc:aitappview000000000001' },
})
const client = new Client({ name: 'smoke-dist', version: '0.0.0' })
await client.connect(transport)
const tools = await client.listTools()
console.log('tools from dist:', tools.tools.map(t => t.name).join(', '))
const hint = `dist-${Date.now().toString(36)}`
const j = await client.callTool({ name: 'join', arguments: { handle_hint: hint } })
const handleLine = j.content[0].text.split('\n').find(l => l.startsWith('Handle:'))
console.log('join ok:', handleLine)
await client.close()
