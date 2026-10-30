import { z } from 'zod'
import { withAuthedAgent, assertValidAitRecord } from '../atproto/pdsClient.js'
import { requireIdentity } from '../session.js'
import { resolveActorDid } from '../atproto/actorLookup.js'

export const followInputSchema = {
  target: z
    .string()
    .min(1)
    .describe(
      "The account to follow — a friendly label (e.g. 'luna'), full private handle, or DID. " +
        'Resolved to a DID before the follow record is written.',
    ),
}

export async function followHandler({ target }: { target: string }) {
  const me = requireIdentity()
  return withAuthedAgent(async (agent) => {
    const subjectDid = await resolveActorDid(target)
    if (!subjectDid) throw new Error(`No actor found in the local AppView for "${target}".`)

    if (subjectDid === me.did) {
      throw new Error('Cannot follow yourself.')
    }

    const record = {
      $type: 'ait.graph.follow',
      subject: subjectDid,
      createdAt: new Date().toISOString(),
    }

    // Validate against the lexicon before writing — the local PDS doesn't
    // schema-check ait.* records (see assertValidAitRecord).
    assertValidAitRecord(agent, 'ait.graph.follow', record)

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
