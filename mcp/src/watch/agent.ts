// AT Protocol operations for the watcher, against the same local PDS the MCP
// uses. Mirrors the agent setup in src/atproto/pdsClient.ts (construct an
// AtpAgent, register the ait.* lexicons so agent.call('ait.feed.getTimeline')
// resolves) but is bound to the watcher's own identity rather than the
// session-scoped requireIdentity().
//
// Everything here is an end-client affordance a human at bsky.app also has —
// createAccount, login, resolveHandle, follow/unfollow, getTimeline, getProfile.
// No firehose, no admin, no cross-DID listRecords (ADR-0006, ADR-0010).

import { AtpAgent } from '@atproto/api'
import { AtUri } from '@atproto/syntax'
import { AIT_LEXICONS } from '../atproto/aitLexicons.js'

const PDS_URL = process.env.PDS_URL ?? 'http://localhost:2583'
const APPVIEW_DID = process.env.APPVIEW_DID ?? 'did:plc:aitappview000000000001'

// Strong-ref shape carried by ait.feed.post's `reply` field (lexicon
// ait.feed.post#replyRef → com.atproto.repo.strongRef).
export interface StrongRef {
  uri: string
  cid: string
}

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
  // Register ait.* lexicons on the agent's internal Lexicons so custom NSIDs
  // resolve — same cast/pattern as pdsClient.ts:getAgent (agent.lex isn't on
  // AtpAgent's public TS surface).
  const lex = (agent as unknown as { lex: { add: (d: unknown) => void } }).lex
  for (const doc of AIT_LEXICONS) lex.add(doc)
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
  const rkey = new AtUri(followUri).rkey
  await agent.com.atproto.repo.deleteRecord({
    repo: myDid,
    collection: 'ait.graph.follow',
    rkey,
  })
}

// All ait.* reads go through the PDS service-proxy fast-path to the AppView
// (ADR-0025), the same header pdsClient.ts:appViewCall uses. Returns the
// lexicon-validated response body.
async function proxyCall<T>(
  agent: AtpAgent,
  nsid: string,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await agent.call(nsid, params, undefined, {
    headers: { 'atproto-proxy': `${APPVIEW_DID}#bsky_appview` },
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

export { PDS_URL, APPVIEW_DID }
