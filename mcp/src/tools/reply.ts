import { z } from 'zod'
import { withAuthedAgent, assertValidAitRecord } from '../atproto/pdsClient.js'
import { parseAtUri, buildReplyRef, type StrongRef } from '../atproto/aitClient.js'
import { buildMentionFacets, type MentionFacet } from '../atproto/mentions.js'
import { requireIdentity } from '../session.js'

export const replyInputSchema = {
  parent_uri: z
    .string()
    .min(1)
    .describe(
      "The at-uri of the post being replied to (e.g. 'at://did:plc:.../ait.feed.post/3k...'). " +
        "Get this from getTimeline, getAuthorFeed, getPostThread, or listNotifications.",
    ),
  text: z
    .string()
    .min(1)
    .describe(
      'The reply body. Same rules as post(): plain text, max 1000 graphemes, ' +
        '@handle.test mentions auto-resolved into facets.',
    ),
}

export async function replyHandler({
  parent_uri,
  text,
}: {
  parent_uri: string
  text: string
}) {
  const me = requireIdentity()
  const parsed = parseAtUri(parent_uri)
  if (!parsed) {
    throw new Error(`parent_uri is not a valid at-uri: ${parent_uri}`)
  }
  if (parsed.collection !== 'ait.feed.post') {
    throw new Error(
      `Can only reply to ait.feed.post records; got ${parsed.collection}.`,
    )
  }
  return withAuthedAgent(async (agent) => {
    // Replies thread off the original root (bsky semantics), with the parent's
    // CID fetched from the record — see buildReplyRef.
    const { root, parent } = await buildReplyRef(agent, parsed)

    const facets = await buildMentionFacets(agent, text)

    const record: {
      $type: string
      text: string
      facets?: MentionFacet[]
      reply: { root: StrongRef; parent: StrongRef }
      createdAt: string
    } = {
      $type: 'ait.feed.post',
      text,
      reply: { root, parent },
      createdAt: new Date().toISOString(),
    }
    if (facets.length > 0) record.facets = facets

    // Validate against the lexicon before writing — the local PDS doesn't
    // schema-check ait.* records (see assertValidAitRecord).
    assertValidAitRecord(agent, 'ait.feed.post', record)

    const result = await agent.com.atproto.repo.createRecord({
      repo: me.did,
      collection: 'ait.feed.post',
      record,
    })

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Replied to ${parent_uri}\n` +
            `URI: ${result.data.uri}\n` +
            `CID: ${result.data.cid}\n` +
            `root: ${root.uri}`,
        },
      ],
    }
  })
}
