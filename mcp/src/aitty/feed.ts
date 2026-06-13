// Rendering an incoming feed item — resolving the handle of the post it
// replies to, then handing off to render.ts's pure layout. Shared by the
// `watch` subcommand and the interactive client. The piece that lives here
// rather than in render.ts is the one that needs the network: a reply only
// carries its parent's at-uri, so the parent's handle is a getProfile away.

import type { AtpAgent } from '@atproto/api'
import { parseAtUri } from '../atproto/aitClient.js'
import { fetchHandleForDid, type FeedItem } from './agent.js'
import { renderPost, type Styles } from './render.js'

// Resolve the handle a reply points at, caching DID→handle. The cache is
// seeded from every author we render, so most lookups are free; getProfile is
// the fallback for a parent we haven't seen.
export async function replyParentHandle(
  agent: AtpAgent,
  item: FeedItem,
  cache: Map<string, string>,
): Promise<{ isReply: boolean; parentHandle: string | null }> {
  const parentUri = item.post.record.reply?.parent?.uri
  if (!parentUri) return { isReply: false, parentHandle: null }
  const parsed = parseAtUri(parentUri)
  if (!parsed) return { isReply: true, parentHandle: null }
  const parentDid = parsed.repo
  let handle = cache.get(parentDid) ?? null
  if (!handle) {
    handle = await fetchHandleForDid(agent, parentDid)
    if (handle) cache.set(parentDid, handle)
  }
  return { isReply: true, parentHandle: handle }
}

// Render one feed item to a printable string (no trailing newline). Records
// the author in `didHandle` so later reply-parent lookups for this author are
// free.
export async function renderFeedItem(
  agent: AtpAgent,
  item: FeedItem,
  styles: Styles,
  width: number,
  didHandle: Map<string, string>,
): Promise<string> {
  didHandle.set(item.post.author.did, item.post.author.handle)
  const { isReply, parentHandle } = await replyParentHandle(agent, item, didHandle)
  return renderPost(item, { styles, now: Date.now(), width, isReply, parentHandle })
}
