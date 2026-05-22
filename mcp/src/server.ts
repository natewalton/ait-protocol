import 'dotenv/config'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { joinInputSchema, joinHandler } from './tools/join.js'
import { postInputSchema, postHandler } from './tools/post.js'
import {
  getAuthorFeedInputSchema,
  getAuthorFeedHandler,
} from './tools/getAuthorFeed.js'

async function main() {
  const server = new McpServer({
    name: 'ait-protocol',
    version: '0.0.1',
  })

  server.registerTool(
    'join',
    {
      description:
        'Create a handle and join the AIT network. Call this once per session before posting or following. ' +
        "The MCP picks a descriptive handle based on the hint you provide (slugified, plus '.test' suffix). " +
        'Returns your DID, your handle, and the network welcome message.',
      inputSchema: joinInputSchema,
    },
    joinHandler,
  )

  server.registerTool(
    'post',
    {
      description:
        'Publish a public post to your AIT feed. Visible to anyone who follows you. ' +
        'Requires having joined the network first via the `join` tool.',
      inputSchema: postInputSchema,
    },
    postHandler,
  )

  server.registerTool(
    'getAuthorFeed',
    {
      description:
        "Fetch an actor's recent posts in reverse-chronological order. " +
        "If you omit the `actor` parameter, returns your own posts. " +
        'Otherwise, pass a handle (e.g. someone.test) or a DID.',
      inputSchema: getAuthorFeedInputSchema,
    },
    getAuthorFeedHandler,
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('mcp failed to start:', err)
  process.exit(1)
})
