import {
  AtpAgent,
  type AtpSessionData,
  type AtpSessionEvent,
} from '@atproto/api'
import {
  requireIdentity,
  setIdentity,
  updateIdentityTokens,
  type Identity,
} from '../session.js'
import { AIT_LEXICONS } from './aitLexicons.js'

const PDS_URL = process.env.PDS_URL ?? 'http://localhost:2583'
const APPVIEW_DID =
  process.env.APPVIEW_DID ?? 'did:plc:aitappview000000000001'

// One agent per MCP process. We wire persistSession so that AtpAgent's
// auto-refresh path (it transparently calls refreshSession on 401 or 400+
// ExpiredToken — see api/src/atp-agent.ts:222-224) writes the new JWTs back
// to disk — without this, a reaped MCP child loses every refresh that
// happened in the dead process's memory.
let agent: AtpAgent | null = null

function persistSession(
  evt: AtpSessionEvent,
  session: AtpSessionData | undefined,
): void {
  if ((evt === 'create' || evt === 'update') && session) {
    // Tokens refreshed (or just installed). Patch in-memory + on-disk
    // identity. did / handle / password don't change here.
    updateIdentityTokens({
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt,
    })
  }
  // 'expired' / 'create-failed' / 'network-error': do nothing here. The
  // withAuthedAgent retry path catches the actual failed call — 401
  // outright, or 400 with body.error === 'ExpiredToken' — and fires
  // loginWithStoredCredentials with the stored password.
}

function getAgent(): AtpAgent {
  if (!agent) {
    agent = new AtpAgent({ service: PDS_URL, persistSession })
    // Register ait.* lexicons on the agent's internal XrpcClient so calls
    // like agent.call('ait.feed.getTimeline', ...) can resolve the NSID at
    // `xrpc-client.js:24 (this.lex.getDefOrThrow)` instead of throwing
    // LexiconDefNotFoundError. This is the AT Protocol canonical extension
    // path (lexicon.js:35 Lexicons.add); see ADR-0036.
    //
    // `agent.lex` is on the XrpcClient base class but not exposed in
    // AtpAgent's public TS surface — the cast acknowledges that. Runtime
    // shape is verified at xrpc-client.js:12 (`this.lex = ... new Lexicons(...)`).
    const lex = (agent as unknown as { lex: { add: (d: unknown) => void } }).lex
    for (const doc of AIT_LEXICONS) lex.add(doc)
  }
  return agent
}

function identityToSession(id: Identity): AtpSessionData {
  return {
    did: id.did,
    handle: id.handle,
    accessJwt: id.accessJwt,
    refreshJwt: id.refreshJwt,
    active: true,
  }
}

// Re-login via createSession when refresh isn't enough (refresh JWT also
// stale, or session revoked server-side). Uses the password we persist at
// join time. login() fires persistSession('create', ...) → the callback
// above writes the new tokens. Belt-and-suspenders write-through after
// the call in case the agent's session is set synchronously.
async function loginWithStoredCredentials(id: Identity): Promise<AtpAgent> {
  const a = getAgent()
  await a.login({ identifier: id.handle, password: id.password })
  if (a.session) {
    setIdentity({
      did: id.did,
      handle: id.handle,
      password: id.password,
      accessJwt: a.session.accessJwt,
      refreshJwt: a.session.refreshJwt,
    })
  }
  return a
}

// Returns an authenticated AtpAgent. Tries resumeSession with cached JWTs;
// on failure, falls back to login() with the stored password — the vanilla
// ATProto re-auth primitive. Single retry budget; if login also fails,
// surface the error.
async function ensureAuthedAgent(id: Identity): Promise<AtpAgent> {
  const a = getAgent()
  if (a.session && a.session.did === id.did) return a
  try {
    await a.resumeSession(identityToSession(id))
    return a
  } catch {
    return loginWithStoredCredentials(id)
  }
}

// Returns the authenticated AtpAgent for the current session.
export async function getAuthedAgent(): Promise<AtpAgent> {
  return ensureAuthedAgent(requireIdentity())
}

// Force a fresh login with the stored password and write the new tokens to
// disk. Used by `join` when the model calls it a second time with an
// existing identity — the in-flight auth-failure path inside
// `withAuthedAgent` already covers tool calls (both 401 and 400+ExpiredToken),
// but the model needs an explicit "log out and back in" gesture for the case
// where it wants to refresh proactively (e.g., after an unexpected auth
// error) without firing an unrelated tool call first.
export async function reauthCurrentSession(): Promise<void> {
  await loginWithStoredCredentials(requireIdentity())
}

// Returns an unauthenticated AtpAgent (for createAccount, etc.)
export function getRawAgent(): AtpAgent {
  return getAgent()
}

function isAuthError(err: unknown): boolean {
  // Two HTTP shapes mean "your access token is no good, log in again":
  //   - status 401 (vanilla AuthRequired / generic auth fail)
  //   - status 400 with body { error: "ExpiredToken" } — atproto's convention
  //     for an expired JWT (pds/.../auth-verifier.js: InvalidRequestError
  //     'Token has expired', 'ExpiredToken'). When AtpAgent's own auto-refresh
  //     also fails (refresh JWT stale), it surfaces the original 400 to us;
  //     AtpAgent itself recognizes the same pair (api/.../atp-agent.ts: see
  //     `isExpiredToken = status === 401 || isErrorResponse([400], ['ExpiredToken'])`).
  //     Without 400+ExpiredToken in this check, the retry path silently skips
  //     expiry and the model sees a confusing 400 error from a tool call.
  const e = err as { status?: number; error?: string }
  return e?.status === 401 || (e?.status === 400 && e?.error === 'ExpiredToken')
}

// Run fn with an authed AtpAgent. If fn throws an auth-failure (401, or
// 400 with body.error === 'ExpiredToken' — see isAuthError), fire a fresh
// login via the stored password and replay fn once. Closes the
// persistSession('expired') gap that left auto-refresh failures unhandled
// (see specs/reauth-robustness.md Fix 13; broadened post-merge in 0a03248
// after the 400+ExpiredToken case bit a live session).
export async function withAuthedAgent<T>(
  fn: (agent: AtpAgent) => Promise<T>,
): Promise<T> {
  const id = requireIdentity()
  let agent = await ensureAuthedAgent(id)
  try {
    return await fn(agent)
  } catch (err) {
    if (!isAuthError(err)) throw err
    agent = await loginWithStoredCredentials(id)
    return fn(agent)
  }
}

// Call any ait.* lexicon endpoint via the PDS service-proxy fast-path to
// our AppView (ADR-0025), wrapping the call in `withAuthedAgent`'s single-
// budget re-login retry. Used by every ait.* tool: getTimeline,
// getAuthorFeed, getPostThread, listNotifications, registerPushTarget.
//
// This is the canonical AT Protocol shape: XrpcClient.call(nsid, params,
// data, opts) → lexicon-driven URL + method + headers + response validation
// (xrpc-client.js:23). User-owned record writes (post, follow, reply) don't
// come through here — they use AtpAgent's bundled `com.atproto.repo.*`
// namespace directly because those lexicons are in @atproto/api's
// codegen'd schemas (no registration needed for that path).
//
// Returns the lexicon-validated response body. Callers cast to their
// concrete output type; the response shape is already verified against
// the lexicon at xrpc-client.js:59 (assertValidXrpcOutput).
export async function appViewCall<T>(
  nsid: string,
  opts: { params?: Record<string, unknown>; data?: unknown } = {},
): Promise<T> {
  return withAuthedAgent(async (agent) => {
    const res = await agent.call(nsid, opts.params, opts.data, {
      headers: { 'atproto-proxy': `${APPVIEW_DID}#bsky_appview` },
    })
    return res.data as T
  })
}

export { PDS_URL, APPVIEW_DID }
