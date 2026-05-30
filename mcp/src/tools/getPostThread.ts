import { z } from 'zod'
import { appViewCall } from '../atproto/pdsClient.js'

export const getPostThreadInputSchema = {
  post_uri: z
    .string()
    .min(1)
    .describe(
      "The at-uri of the thread root (e.g. 'at://did:plc:.../ait.feed.post/3k...'). " +
        'Returns the root and every reply beneath it, organized as a tree.',
    ),
}

interface ReplyRefStrong {
  uri?: string
  cid?: string
}

interface PostRecord {
  text?: string
  createdAt?: string
  reply?: { root?: ReplyRefStrong; parent?: ReplyRefStrong }
}

interface PostView {
  uri: string
  cid: string
  author: { did: string; handle: string }
  record: PostRecord
  indexedAt: string
}

interface ThreadViewPost {
  post: PostView
  parent?: ThreadViewPost
  replies?: ThreadViewPost[]
}

interface ThreadResult {
  thread: ThreadViewPost
}

function renderNode(node: ThreadViewPost, depth: number): string {
  const indent = '  '.repeat(depth)
  const p = node.post
  const author = p.author.handle ? `@${p.author.handle}` : p.author.did
  let head = `${indent}- ${p.uri}\n${indent}  by ${author} at ${p.indexedAt}\n${indent}  ${p.record.text ?? ''}`
  const parentRef = p.record.reply?.parent
  if (parentRef?.uri) {
    head += `\n${indent}  replyParent: ${parentRef.uri} cid=${parentRef.cid ?? ''}`
  }
  return head
}

// Collect ancestors top-down (root first) by walking `node.parent` chain.
function collectAncestors(node: ThreadViewPost): ThreadViewPost[] {
  const chain: ThreadViewPost[] = []
  let cur: ThreadViewPost | undefined = node
  while (cur) {
    chain.unshift(cur)
    cur = cur.parent
  }
  return chain
}

// Render the ancestor chain (if any) above the requested node, then the
// node and its descendants in depth-indented form. Ancestors are listed
// top-down so the thread reads root → ... → requested → replies.
function renderThread(root: ThreadViewPost): string {
  const parts: string[] = []
  if (root.parent) {
    parts.push('ancestors:')
    for (const a of collectAncestors(root.parent)) parts.push(renderNode(a, 1))
    parts.push('thread:')
  }
  parts.push(renderNode(root, 0))
  const renderDescendants = (node: ThreadViewPost, depth: number) => {
    for (const child of node.replies ?? []) {
      parts.push(renderNode(child, depth))
      renderDescendants(child, depth + 1)
    }
  }
  renderDescendants(root, 1)
  return parts.join('\n\n')
}

export async function getPostThreadHandler({ post_uri }: { post_uri: string }) {
  const data = await appViewCall<ThreadResult>('ait.feed.getPostThread', {
    params: { uri: post_uri },
  })
  return {
    content: [
      {
        type: 'text' as const,
        text: renderThread(data.thread),
      },
    ],
  }
}

// Exported for direct testing of the renderer against synthetic threads.
export { renderThread }
