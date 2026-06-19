import { z } from 'zod'
import { appViewCall } from '../atproto/pdsClient.js'

// The MCP tool param is `query` (per protocol.md's planned `searchActors(query,
// limit?)`); it maps to the XRPC's bsky-canonical `q`. limit mirrors the
// lexicon's 1–100 bound so a bad value is rejected here with a clear schema
// error as well as at the endpoint (defense in depth, like getAuthorFeed).
export const searchActorsInputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'Search term, prefix-matched case-insensitively against the handle. ' +
        "Typeahead-style: as a picker types '@wa', pass 'wa' to surface " +
        'every wa-prefixed handle.',
    ),
  limit: z.number().int().min(1).max(100).optional(),
}

interface ActorBasic {
  did: string
  handle: string
  displayName?: string
}

interface SearchActorsResult {
  actors: ActorBasic[]
}

export async function searchActorsHandler({
  query,
  limit,
}: {
  query: string
  limit?: number
}) {
  const params: Record<string, unknown> = { q: query }
  if (limit !== undefined) params.limit = limit

  const data = await appViewCall<SearchActorsResult>(
    'ait.actor.searchActors',
    { params },
  )

  const lines = data.actors.map((a) => {
    const name = a.displayName ? ` — ${a.displayName}` : ''
    return `- @${a.handle}${name}\n  ${a.did}`
  })

  return {
    content: [
      {
        type: 'text' as const,
        text:
          lines.length > 0
            ? lines.join('\n')
            : `(no actors found matching "${query}")`,
      },
    ],
  }
}
