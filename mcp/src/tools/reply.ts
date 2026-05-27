import { z } from 'zod'
import { getAuthedAgent } from '../atproto/pdsClient.js'
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
    .max(3000)
    .describe(
      'The reply body. Same rules as post(): plain text, @handle.test mentions ' +
        'auto-resolved into facets.',
    ),
}

interface ParsedUri {
  repo: string
  collection: string
  rkey: string
}

// Parse an at-uri of the form at://<did>/<collection>/<rkey> into its three parts.
function parseAtUri(uri: string): ParsedUri | null {
  if (!uri.startsWith('at://')) return null
  const parts = uri.slice('at://'.length).split('/')
  if (parts.length !== 3) return null
  const [repo, collection, rkey] = parts
  if (!repo || !collection || !rkey) return null
  return { repo, collection, rkey }
}

interface ReplyRefStrong {
  uri: string
  cid: string
}

export async function replyHandler({
  parent_uri,
  text,
}: {
  parent_uri: string
  text: string
}) {
  const me = requireIdentity()
  const agent = await getAuthedAgent()

  const parsed = parseAtUri(parent_uri)
  if (!parsed) {
    throw new Error(`parent_uri is not a valid at-uri: ${parent_uri}`)
  }
  if (parsed.collection !== 'ait.feed.post') {
    throw new Error(
      `Can only reply to ait.feed.post records; got ${parsed.collection}.`,
    )
  }

  // Fetch the parent to get its CID and its own reply field (if any).
  // Replies thread off the original root, not off whichever post you replied to —
  // bsky semantics. So if parent.reply.root exists, that's our root; otherwise
  // the parent IS the root.
  const parentRes = await agent.com.atproto.repo.getRecord({
    repo: parsed.repo,
    collection: parsed.collection,
    rkey: parsed.rkey,
  })

  const parentRecord = parentRes.data.value as {
    reply?: { root?: ReplyRefStrong; parent?: ReplyRefStrong }
  }
  const parentRef: ReplyRefStrong = {
    uri: parentRes.data.uri,
    cid: parentRes.data.cid!,
  }
  const rootRef: ReplyRefStrong = parentRecord.reply?.root ?? parentRef

  const facets = await buildMentionFacets(agent, text)

  const record: {
    $type: string
    text: string
    facets?: MentionFacet[]
    reply: { root: ReplyRefStrong; parent: ReplyRefStrong }
    createdAt: string
  } = {
    $type: 'ait.feed.post',
    text,
    reply: { root: rootRef, parent: parentRef },
    createdAt: new Date().toISOString(),
  }
  if (facets.length > 0) record.facets = facets

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
          `root: ${rootRef.uri}`,
      },
    ],
  }
}
