import { z } from 'zod'
import { requireIdentity } from '../session.js'
import { PDS_URL, APPVIEW_DID } from '../atproto/pdsClient.js'

export const getPostThreadInputSchema = {
  post_uri: z
    .string()
    .min(1)
    .describe(
      "The at-uri of the thread root (e.g. 'at://did:plc:.../ait.feed.post/3k...'). " +
        'Returns the root and every reply beneath it, organized as a tree.',
    ),
}

interface PostView {
  uri: string
  cid: string
  author: { did: string; handle: string }
  record: { text?: string; createdAt?: string }
  indexedAt: string
}

interface ThreadViewPost {
  post: PostView
  replies?: ThreadViewPost[]
}

interface ThreadResult {
  thread: ThreadViewPost
}

// Render a threadViewPost as indented lines so the conversation reads top-down.
function renderThread(node: ThreadViewPost, depth = 0): string {
  const indent = '  '.repeat(depth)
  const p = node.post
  const author = p.author.handle ? `@${p.author.handle}` : p.author.did
  const head = `${indent}- ${p.uri}\n${indent}  by ${author} at ${p.indexedAt}\n${indent}  ${p.record.text ?? ''}`
  const children = (node.replies ?? []).map((r) => renderThread(r, depth + 1))
  return [head, ...children].join('\n\n')
}

export async function getPostThreadHandler({ post_uri }: { post_uri: string }) {
  const session = requireIdentity()

  // Raw fetch (same reason as getTimeline / getAuthorFeed): @atproto/api
  // validates NSIDs against its bundled lexicon registry, which doesn't
  // know about ait.*. Direct call preserves PDS-proxy shape.
  const params = new URLSearchParams({ uri: post_uri })
  const res = await fetch(
    `${PDS_URL}/xrpc/ait.feed.getPostThread?${params}`,
    {
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
        'atproto-proxy': `${APPVIEW_DID}#bsky_appview`,
      },
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getPostThread failed: ${res.status} ${body}`)
  }

  const data = (await res.json()) as ThreadResult
  return {
    content: [
      {
        type: 'text' as const,
        text: renderThread(data.thread),
      },
    ],
  }
}
