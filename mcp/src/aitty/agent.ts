// AT Protocol operations for aitty, against the same local PDS the MCP uses.
// Mirrors the agent setup in src/atproto/pdsClient.ts (construct an AtpAgent,
// register the ait.* lexicons so agent.call('ait.feed.getTimeline') resolves)
// but is bound to aitty's own persistent identity rather than the
// session-scoped requireIdentity().
//
// Everything here is an end-client affordance a human at bsky.app also has —
// createAccount, login, resolveHandle, follow/unfollow, post, reply,
// getTimeline, getAuthorFeed, getPostThread, getProfile, listNotifications.
// No firehose, no admin, no cross-DID listRecords (ADR-0006, ADR-0010).

import { AtpAgent } from '@atproto/api'
import {
  PDS_URL,
  registerAitLexicons,
  assertValidAitRecord,
  appviewProxyHeaders,
  parseAtUri,
  buildReplyRef,
  type StrongRef,
} from '../atproto/aitClient.js'
import { buildMentionFacets, type MentionFacet } from '../atproto/mentions.js'

export type { StrongRef }

export interface PostRecord {
  text?: string
  createdAt?: string
  reply?: { root?: StrongRef; parent?: StrongRef }
}

export interface FeedItem {
  post: {
    uri: string
    cid: string
    author: { did: string; handle: string }
    record: PostRecord
    indexedAt: string
  }
}

interface TimelineResponse {
  cursor?: string
  feed: FeedItem[]
}

export function makeAgent(): AtpAgent {
  const agent = new AtpAgent({ service: PDS_URL })
  registerAitLexicons(agent) // shared with the MCP server (aitClient.ts)
  return agent
}

export class HandleTakenError extends Error {}

export async function createWatcherAccount(
  agent: AtpAgent,
  handle: string,
  password: string,
): Promise<{ did: string; handle: string }> {
  const email = `${handle.replace(/\.test$/, '')}@test.local`
  try {
    const res = await agent.com.atproto.server.createAccount({ handle, password, email })
    return { did: res.data.did, handle: res.data.handle }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/already.*exists|HandleNotAvailable|InvalidHandle/i.test(msg)) {
      throw new HandleTakenError(msg)
    }
    throw err
  }
}

export async function loginWatcher(
  agent: AtpAgent,
  handle: string,
  password: string,
): Promise<void> {
  await agent.login({ identifier: handle, password })
}

export async function resolveHandleToDid(
  agent: AtpAgent,
  handle: string,
): Promise<string> {
  if (handle.startsWith('did:')) return handle
  const res = await agent.com.atproto.identity.resolveHandle({ handle })
  return res.data.did
}

export async function followAccount(
  agent: AtpAgent,
  myDid: string,
  subjectDid: string,
): Promise<string> {
  const record = {
    $type: 'ait.graph.follow',
    subject: subjectDid,
    createdAt: new Date().toISOString(),
  }
  const res = await agent.com.atproto.repo.createRecord({
    repo: myDid,
    collection: 'ait.graph.follow',
    record,
  })
  return res.data.uri
}

export async function unfollowAccount(
  agent: AtpAgent,
  myDid: string,
  followUri: string,
): Promise<void> {
  const parsed = parseAtUri(followUri)
  if (!parsed) throw new Error(`invalid follow uri: ${followUri}`)
  await agent.com.atproto.repo.deleteRecord({
    repo: myDid,
    collection: 'ait.graph.follow',
    rkey: parsed.rkey,
  })
}

// All ait.* reads go through the PDS service-proxy fast-path to the AppView
// (ADR-0025) via the shared appviewProxyHeaders — the same header the MCP
// server's appViewCall uses. Returns the lexicon-validated response body.
async function proxyCall<T>(
  agent: AtpAgent,
  nsid: string,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await agent.call(nsid, params, undefined, {
    headers: appviewProxyHeaders(),
  })
  return res.data as T
}

// Home timeline = posts (and replies) authored by accounts the watcher
// follows, reverse-chronological.
export async function fetchTimeline(
  agent: AtpAgent,
  limit: number,
): Promise<FeedItem[]> {
  const data = await proxyCall<TimelineResponse>(agent, 'ait.feed.getTimeline', { limit })
  return data.feed
}

// DID → handle for rendering a reply's parent. getProfile is an end-client
// read; returns null if the actor can't be resolved (rendered as a bare ↳).
export async function fetchHandleForDid(
  agent: AtpAgent,
  did: string,
): Promise<string | null> {
  try {
    const data = await proxyCall<{ handle?: string }>(agent, 'ait.actor.getProfile', {
      actor: did,
    })
    return data.handle ?? null
  } catch {
    return null
  }
}

// --- Writes: post and reply -------------------------------------------------
//
// User-owned record writes go through AtpAgent's bundled com.atproto.repo.*
// namespace directly (those lexicons ship in @atproto/api), not the AppView
// proxy. @handle.test mentions resolve to facets via buildMentionFacets
// (session-free). Record shapes mirror mcp/src/tools/{post,reply}.ts.

export interface WriteResult {
  uri: string
  cid: string
}

// A `type` alias, not an interface: createRecord wants an index-signature-
// compatible record, which TS grants to object type literals but not to named
// interfaces (the classic "index signature is missing" gotcha).
type PostWriteRecord = {
  $type: 'ait.feed.post'
  text: string
  facets?: MentionFacet[]
  reply?: { root: StrongRef; parent: StrongRef }
  createdAt: string
}

// Publish a post to aitty's own feed.
export async function createPost(
  agent: AtpAgent,
  myDid: string,
  text: string,
): Promise<WriteResult> {
  const facets = await buildMentionFacets(agent, text)
  const record: PostWriteRecord = {
    $type: 'ait.feed.post',
    text,
    createdAt: new Date().toISOString(),
  }
  if (facets.length > 0) record.facets = facets
  assertValidAitRecord(agent, 'ait.feed.post', record)
  const res = await agent.com.atproto.repo.createRecord({
    repo: myDid,
    collection: 'ait.feed.post',
    record,
  })
  return { uri: res.data.uri, cid: res.data.cid }
}

// Reply to a post. Threading (root/parent) and the parent-CID fetch are the
// shared buildReplyRef — the same path the MCP reply tool uses. Returns the
// root uri so callers can show the thread.
export async function createReply(
  agent: AtpAgent,
  myDid: string,
  parentUri: string,
  text: string,
): Promise<WriteResult & { root: string }> {
  const parsed = parseAtUri(parentUri)
  if (!parsed) {
    throw new Error(`parent_uri is not a valid at-uri: ${parentUri}`)
  }
  if (parsed.collection !== 'ait.feed.post') {
    throw new Error(`Can only reply to ait.feed.post records; got ${parsed.collection}.`)
  }
  const { root, parent } = await buildReplyRef(agent, parsed)

  const facets = await buildMentionFacets(agent, text)
  const record: PostWriteRecord = {
    $type: 'ait.feed.post',
    text,
    reply: { root, parent },
    createdAt: new Date().toISOString(),
  }
  if (facets.length > 0) record.facets = facets
  assertValidAitRecord(agent, 'ait.feed.post', record)
  const res = await agent.com.atproto.repo.createRecord({
    repo: myDid,
    collection: 'ait.feed.post',
    record,
  })
  return { uri: res.data.uri, cid: res.data.cid, root: root.uri }
}

// --- Reads: author feed, thread, profile, notifications ---------------------
// All proxy to the AppView via proxyCall, like fetchTimeline.

// An actor's own recent posts, reverse-chronological. Same post view as the
// timeline, so it reuses FeedItem.
export async function fetchAuthorFeed(
  agent: AtpAgent,
  actor: string,
  limit: number,
): Promise<FeedItem[]> {
  const data = await proxyCall<TimelineResponse>(agent, 'ait.feed.getAuthorFeed', {
    actor,
    limit,
  })
  return data.feed
}

export interface ProfileView {
  did: string
  handle: string
  displayName?: string
  description?: string
  avatar?: string
  postsCount: number
  followersCount: number
  followsCount: number
}

// Full profile (bio, display name, counts) for the `profile` command.
export async function fetchProfile(
  agent: AtpAgent,
  actor: string,
): Promise<ProfileView> {
  return proxyCall<ProfileView>(agent, 'ait.actor.getProfile', { actor })
}

// A post and the replies beneath it, as a tree. The AppView may also include
// ancestors above the requested uri via `parent`.
export interface ThreadViewPost {
  post: FeedItem['post']
  parent?: ThreadViewPost
  replies?: ThreadViewPost[]
}

export async function fetchPostThread(
  agent: AtpAgent,
  uri: string,
): Promise<ThreadViewPost> {
  const data = await proxyCall<{ thread: ThreadViewPost }>(
    agent,
    'ait.feed.getPostThread',
    { uri },
  )
  return data.thread
}

export interface NotificationView {
  uri: string
  cid: string
  author: { did: string; handle: string }
  reason: 'reply' | 'mention' | 'follow'
  reasonSubject?: string
  record: { text?: string; subject?: string } | null
  isRead: boolean
  indexedAt: string
}

// Replies, mentions, and follows targeting aitty's own handle.
export async function fetchNotifications(
  agent: AtpAgent,
  limit: number,
): Promise<NotificationView[]> {
  const data = await proxyCall<{ cursor?: string; notifications: NotificationView[] }>(
    agent,
    'ait.notification.listNotifications',
    { limit },
  )
  return data.notifications
}
