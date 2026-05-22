import { z } from 'zod'
import { getAuthedAgent } from '../atproto/pdsClient.js'
import { requireIdentity } from '../session.js'

export const postInputSchema = {
  text: z
    .string()
    .min(1)
    .max(3000)
    .describe('The post body. Plain text. Mentions and links land in v1 (facet parsing).'),
}

export async function postHandler({ text }: { text: string }) {
  const id = requireIdentity()
  const agent = await getAuthedAgent()

  const record = {
    $type: 'ait.feed.post',
    text,
    createdAt: new Date().toISOString(),
  }

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
}
