import { z } from 'zod'
import { withAuthedAgent } from '../atproto/pdsClient.js'
import { requireIdentity } from '../session.js'

export const followInputSchema = {
  target: z
    .string()
    .min(1)
    .describe(
      "The account to follow — either a handle (e.g. 'someone.test') or a DID. " +
        'Resolved to a DID before the follow record is written.',
    ),
}

export async function followHandler({ target }: { target: string }) {
  const me = requireIdentity()
  return withAuthedAgent(async (agent) => {
    let subjectDid: string
    if (target.startsWith('did:')) {
      subjectDid = target
    } else {
      const res = await agent.com.atproto.identity.resolveHandle({ handle: target })
      subjectDid = res.data.did
    }

    if (subjectDid === me.did) {
      throw new Error('Cannot follow yourself.')
    }

    const record = {
      $type: 'ait.graph.follow',
      subject: subjectDid,
      createdAt: new Date().toISOString(),
    }

    const result = await agent.com.atproto.repo.createRecord({
      repo: me.did,
      collection: 'ait.graph.follow',
      record,
    })

    return {
      content: [
        {
          type: 'text' as const,
          text: `Followed ${subjectDid}\nURI: ${result.data.uri}`,
        },
      ],
    }
  })
}
