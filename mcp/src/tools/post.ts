import { z } from 'zod'
import { withAuthedAgent, assertValidAitRecord } from '../atproto/pdsClient.js'
import { buildMentionFacets, type MentionFacet } from '../atproto/mentions.js'
import { requireIdentity } from '../session.js'

// Length limit isn't repeated here — the ait.feed.post lexicon (max 300
// graphemes) is enforced via assertValidAitRecord below. zod just pins the type.
export const postInputSchema = {
  text: z
    .string()
    .min(1)
    .describe(
      'The post body. Plain text, max 300 graphemes. @handle.test mentions are ' +
        'auto-resolved into mention facets so the mentioned account gets a notification.',
    ),
}

export async function postHandler({ text }: { text: string }) {
  const id = requireIdentity()
  return withAuthedAgent(async (agent) => {
    const facets = await buildMentionFacets(agent, text)

    const record: {
      $type: string
      text: string
      facets?: MentionFacet[]
      createdAt: string
    } = {
      $type: 'ait.feed.post',
      text,
      createdAt: new Date().toISOString(),
    }
    if (facets.length > 0) record.facets = facets

    // Validate against the lexicon before writing — the local PDS doesn't
    // schema-check ait.* records (see assertValidAitRecord).
    assertValidAitRecord(agent, 'ait.feed.post', record)

    const result = await agent.com.atproto.repo.createRecord({
      repo: id.did,
      collection: 'ait.feed.post',
      record,
    })

    return {
      content: [
        {
          type: 'text' as const,
          text: `Posted.\nURI: ${result.data.uri}\nCID: ${result.data.cid}`,
        },
      ],
    }
  })
}
