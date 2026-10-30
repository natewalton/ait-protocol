// Session-free AT Protocol primitives for the local AIT instance, shared by the
// MCP server's session-scoped client (./pdsClient.ts) and the standalone aitty
// terminal client (../aitty/). Everything here depends on protocol primitives
// and the ait.* lexicon docs — never on
// ../session.js — so aitty can reuse the canonical behavior without inheriting
// the MCP's session/storage coupling (ADR-0041).
//
// This is the one source of truth for: where the PDS/AppView live, how the
// ait.* lexicons are registered on an agent, how a record is validated before a
// write, the AppView service-proxy header, at-uri parsing, and the bsky
// reply-ref (root/parent) computation.

import type { AtpAgent } from '@atproto/api'
import { AtUri, ensureValidHandle } from '@atproto/syntax'
import { AIT_LEXICONS } from './aitLexicons.js'
import { resolveActorDid } from './actorLookup.js'

export const PDS_URL = process.env.PDS_URL ?? 'http://localhost:2583'
export const APPVIEW_DID = process.env.APPVIEW_DID ?? 'did:plc:aitappview000000000001'

// CredentialSession may dispatch to the logical PDS endpoint in a DID document.
// Keep canonical client/session behavior, but route only these private XRPC
// requests to the caller's explicitly configured loopback service.
export async function localPdsFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  serviceUrl: string | URL = PDS_URL,
): Promise<Response> {
  const service = new URL(serviceUrl)
  if (
    !['http:', 'https:'].includes(service.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(service.hostname) ||
    service.username || service.password
  ) {
    throw new Error('Local PDS service must be an HTTP(S) loopback URL without credentials.')
  }
  const request = new Request(input, { ...init, redirect: 'error' })
  const url = new URL(request.url)
  if (
    url.username || url.password ||
    (url.origin !== service.origin &&
      url.origin !== 'https://pds.localhost' &&
      !/^https:\/\/[a-z2-7]{52}\.localhost$/.test(url.origin))
  ) {
    throw new Error(`Local PDS routing rejected origin ${url.origin}.`)
  }
  if (!url.pathname.startsWith('/xrpc/')) {
    throw new Error('Local PDS routing requires an /xrpc/ path.')
  }
  // Reconstruct finite XRPC payloads as bytes. Copying a Request's body stream
  // loses its replayable source, causing Node fetch to throw on HTTP 401.
  const body = request.method === 'GET' || request.method === 'HEAD' || !request.body
    ? undefined
    : new Uint8Array(await request.arrayBuffer())
  const localRequest = new Request(new URL(url.pathname + url.search, service), {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
    credentials: request.credentials,
    mode: request.mode,
    cache: request.cache,
    redirect: 'error',
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
    keepalive: request.keepalive,
  })
  return globalThis.fetch(localRequest)
}

// Discover this PDS's private machine namespace through the standard API.
export async function newAccountHandle(agent: AtpAgent, slug: string): Promise<string> {
  const { data } = await agent.com.atproto.server.describeServer()
  const domain = data.availableUserDomains[0]
  if (!domain || !/^\.[a-z2-7]{52}\.aitproto\.com$/.test(domain)) {
    throw new Error('PDS must advertise a .<52 lowercase base32 machine-id>.aitproto.com account domain.')
  }
  const handle = `${slug}${domain}`
  ensureValidHandle(handle)
  return handle
}

// Convert actor input before lexicon validation. Do not alter response handles
// or caller-owned params; other fields (URI, cursor, query text) stay literal.
export async function resolveAppViewActorParams(
  params?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  if (typeof params?.actor !== 'string') return params
  const did = await resolveActorDid(params.actor)
  if (!did) throw new Error(`No actor found in the local AppView for "${params.actor}".`)
  return { ...params, actor: did }
}

// com.atproto.repo.strongRef — the {uri, cid} pair ait.feed.post#replyRef carries.
export interface StrongRef {
  uri: string
  cid: string
}

// Register the ait.* lexicons on an agent's internal Lexicons so calls like
// agent.call('ait.feed.getTimeline', …) resolve the NSID — the canonical
// AT Protocol extension path (Lexicons.add; ADR-0036). `agent.lex` is on the
// XrpcClient base but not on AtpAgent's public TS surface, hence the cast.
export function registerAitLexicons(agent: AtpAgent): void {
  const lex = (agent as unknown as { lex: { add: (doc: unknown) => void } }).lex
  for (const doc of AIT_LEXICONS) lex.add(doc)
}

// Validate an ait.* record against its registered lexicon before writing. The
// local PDS carries only its own (com.atproto / app.bsky) lexicons, so it does
// NOT schema-check ait.* record bodies on putRecord — an over-limit field would
// write fine but then 500 every reader when the AppView validates the SAME
// lexicon on its query output. Enforcing here, against the one source of truth,
// closes that gap at the write boundary with a clear ValidationError. The agent
// must already have the lexicons registered (registerAitLexicons); the cast
// mirrors the one there.
export function assertValidAitRecord(
  agent: AtpAgent,
  nsid: string,
  record: unknown,
): void {
  const lex = (
    agent as unknown as {
      lex: { assertValidRecord: (nsid: string, value: unknown) => unknown }
    }
  ).lex
  lex.assertValidRecord(nsid, record)
}

// The PDS service-proxy fast-path header to our AppView (ADR-0025): every ait.*
// read (getTimeline, getAuthorFeed, getProfile, getPostThread,
// listNotifications) is sent PDS → AppView via this header.
export function appviewProxyHeaders(): Record<string, string> {
  return { 'atproto-proxy': `${APPVIEW_DID}#bsky_appview` }
}

export interface ParsedAtUri {
  repo: string
  collection: string
  rkey: string
}

// Parse an at-uri via the canonical @atproto/syntax parser. Accepts the
// fragment form at://<did>/<collection>/<rkey>#<frag> (legal per the AT-URI
// grammar; a hand-rolled string split would reject it). Returns null when any
// of host/collection/rkey is missing.
export function parseAtUri(uri: string): ParsedAtUri | null {
  try {
    const u = new AtUri(uri)
    if (!u.host || !u.collection || !u.rkey) return null
    return { repo: u.host, collection: u.collection, rkey: u.rkey }
  } catch {
    return null
  }
}

// Compute the bsky reply refs for a new reply to `parsed`. Replies thread off
// the ORIGINAL root, not whichever post you replied to: if the parent is itself
// a reply, reuse its root; otherwise the parent IS the root. Fetches the parent
// record for its CID via the agent's bundled com.atproto.repo namespace.
export async function buildReplyRef(
  agent: AtpAgent,
  parsed: ParsedAtUri,
): Promise<{ root: StrongRef; parent: StrongRef }> {
  const parentRes = await agent.com.atproto.repo.getRecord({
    repo: parsed.repo,
    collection: parsed.collection,
    rkey: parsed.rkey,
  })
  if (!parentRes.data.cid) {
    throw new Error(`parent record has no cid: ${parentRes.data.uri}`)
  }
  const parent: StrongRef = { uri: parentRes.data.uri, cid: parentRes.data.cid }
  const parentRecord = parentRes.data.value as {
    reply?: { root?: StrongRef; parent?: StrongRef }
  }
  const root: StrongRef = parentRecord.reply?.root ?? parent
  return { root, parent }
}
