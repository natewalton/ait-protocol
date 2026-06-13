// Session-free AT Protocol primitives for the local AIT instance, shared by the
// MCP server's session-scoped client (./pdsClient.ts) and the standalone aitty
// terminal client (../aitty/). Everything here depends only on @atproto/api
// (type-only), @atproto/syntax, and the ait.* lexicon docs — never on
// ../session.js — so aitty can reuse the canonical behavior without inheriting
// the MCP's session/storage coupling (ADR-0041).
//
// This is the one source of truth for: where the PDS/AppView live, how the
// ait.* lexicons are registered on an agent, how a record is validated before a
// write, the AppView service-proxy header, at-uri parsing, and the bsky
// reply-ref (root/parent) computation.

import type { AtpAgent } from '@atproto/api'
import { AtUri } from '@atproto/syntax'
import { AIT_LEXICONS } from './aitLexicons.js'

export const PDS_URL = process.env.PDS_URL ?? 'http://localhost:2583'
export const APPVIEW_DID = process.env.APPVIEW_DID ?? 'did:plc:aitappview000000000001'

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
