// The actions aitty can take, as reusable functions that return a string to
// print. Both surfaces call these: the one-shot subcommands (main.ts) and the
// interactive command loop (interactive.ts). Keeping them here means a `post`
// typed at the prompt and `aitty post …` from the shell run identical code.
//
// Reads that produce a listing (notifs, profile, thread) render here too, using
// the shared styles so output matches the live feed.

import type { AtpAgent } from '@atproto/api'
import {
  createPost,
  createReply,
  followAccount,
  unfollowAccount,
  resolveHandleToDid,
  fetchNotifications,
  fetchProfile,
  fetchAuthorFeed,
  fetchPostThread,
  type FeedItem,
  type ThreadViewPost,
  type NotificationView,
  type ProfileView,
} from './agent.js'
import { saveIdentity, type WatcherIdentity } from './identity.js'
import { relativeTime, renderPost, type Styles } from './render.js'

// @foo → foo.test ; foo → foo.test ; foo.test → foo.test ; did:… passes through.
export function stripAt(s: string): string {
  return s.replace(/^@/, '').toLowerCase()
}

export function normalizeHandle(raw: string): string {
  const s = stripAt(raw)
  if (s.startsWith('did:')) return s
  return s.includes('.') ? s : `${s}.test`
}

// --- Writes -----------------------------------------------------------------

export async function actionPost(
  agent: AtpAgent,
  id: WatcherIdentity,
  text: string,
): Promise<string> {
  const { uri } = await createPost(agent, id.did, text)
  return `posted · ${uri}`
}

export async function actionReply(
  agent: AtpAgent,
  id: WatcherIdentity,
  parentUri: string,
  text: string,
): Promise<string> {
  const { uri } = await createReply(agent, id.did, parentUri, text)
  return `replied · ${uri}`
}

// Follow is monotonic: it adds a follow and remembers its uri (needed to
// unfollow later). The `watch` subcommand and the prompt share id.follows, so
// nothing here ever removes a follow the user made on purpose.
export async function actionFollow(
  agent: AtpAgent,
  id: WatcherIdentity,
  target: string,
): Promise<string> {
  const key = normalizeHandle(target)
  if (id.follows[key]) return `already following ${key}`
  const did = await resolveHandleToDid(agent, key)
  if (did === id.did) return `that's you — can't follow yourself`
  const followUri = await followAccount(agent, id.did, did)
  id.follows[key] = { did, followUri }
  saveIdentity(id)
  return `followed ${key}`
}

export async function actionUnfollow(
  agent: AtpAgent,
  id: WatcherIdentity,
  target: string,
): Promise<string> {
  const key = normalizeHandle(target)
  const entry = id.follows[key]
  if (!entry) return `not following ${key} (no local follow to undo)`
  await unfollowAccount(agent, id.did, entry.followUri)
  delete id.follows[key]
  saveIdentity(id)
  return `unfollowed ${key}`
}

// --- Reads (rendered listings) ----------------------------------------------

export async function actionNotifs(agent: AtpAgent, styles: Styles): Promise<string> {
  const notes = await fetchNotifications(agent, 30)
  return renderNotifications(notes, styles)
}

export async function actionProfile(
  agent: AtpAgent,
  actor: string,
  styles: Styles,
  width: number,
): Promise<string> {
  const key = normalizeHandle(actor)
  const [profile, recent] = await Promise.all([
    fetchProfile(agent, key),
    fetchAuthorFeed(agent, key, 5).catch(() => [] as FeedItem[]),
  ])
  return renderProfile(profile, recent, styles, width)
}

export async function actionThread(
  agent: AtpAgent,
  uri: string,
  styles: Styles,
  width: number,
): Promise<string> {
  const thread = await fetchPostThread(agent, uri)
  return renderThreadTree(thread, styles, width)
}

// --- Renderers --------------------------------------------------------------

function renderNotifications(notes: NotificationView[], styles: Styles): string {
  if (notes.length === 0) return styles.dim('(no notifications)')
  const now = Date.now()
  return notes
    .map((n) => {
      const who = styles.handle('@' + (n.author.handle || n.author.did))
      const when = styles.dim('· ' + relativeTime(n.indexedAt, now))
      if (n.reason === 'follow') return `${who} followed you ${when}`
      const verb = n.reason === 'reply' ? 'replied' : 'mentioned you'
      const snippet = (n.record?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      return `${who} ${verb} ${when}\n  ${snippet}\n  ${styles.dim(n.uri)}`
    })
    .join('\n\n')
}

function renderProfile(
  p: ProfileView,
  recent: FeedItem[],
  styles: Styles,
  width: number,
): string {
  const nameLine = p.displayName
    ? `${p.displayName} (${styles.handle('@' + p.handle)})`
    : styles.handle('@' + p.handle)
  const bio = p.description ? p.description : styles.dim('(no bio yet)')
  const counts = styles.dim(
    `${p.postsCount} posts · ${p.followersCount} followers · ${p.followsCount} following`,
  )
  const lines = [nameLine, styles.dim(p.did), '', bio, '', counts]
  if (recent.length > 0) {
    const now = Date.now()
    lines.push('', styles.dim('recent posts:'))
    for (const item of recent.slice(0, 5)) {
      const when = relativeTime(item.post.record.createdAt ?? item.post.indexedAt, now)
      const oneLine = (item.post.record.text ?? '').replace(/\s+/g, ' ').trim()
      const max = Math.max(20, width - 6)
      const clipped = oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
      lines.push(`  ${clipped} ${styles.dim('· ' + when)}`)
    }
  }
  return lines.join('\n')
}

// One thread node, rendered with renderPost (so wrapping + highlighting match
// the feed) and shifted right by its depth.
function renderThreadNode(
  node: ThreadViewPost,
  styles: Styles,
  width: number,
  depth: number,
): string {
  const item: FeedItem = { post: node.post }
  const isReply = Boolean(node.post.record.reply?.parent?.uri)
  const text = renderPost(item, {
    styles,
    now: Date.now(),
    width: Math.max(20, width - depth * 2),
    isReply,
    parentHandle: null,
  })
  const indent = '  '.repeat(depth)
  return text
    .split('\n')
    .map((l) => indent + l)
    .join('\n')
}

// Root + nested replies, depth-indented. If the AppView included ancestors
// above the requested post (via `parent`), they're listed first, top-down, so
// the conversation reads in order.
function renderThreadTree(root: ThreadViewPost, styles: Styles, width: number): string {
  const parts: string[] = []
  const ancestors: ThreadViewPost[] = []
  let cur = root.parent
  while (cur) {
    ancestors.unshift(cur)
    cur = cur.parent
  }
  for (const a of ancestors) parts.push(renderThreadNode(a, styles, width, 0))

  const walk = (node: ThreadViewPost, depth: number): void => {
    parts.push(renderThreadNode(node, styles, width, depth))
    for (const child of node.replies ?? []) walk(child, depth + 1)
  }
  walk(root, 0)
  return parts.join('\n\n')
}
