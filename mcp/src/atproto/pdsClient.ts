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

const PDS_URL = process.env.PDS_URL ?? 'http://localhost:2583'
const APPVIEW_DID =
  process.env.APPVIEW_DID ?? 'did:plc:aitappview000000000001'

// One agent per MCP process. We wire persistSession so that AtpAgent's
// auto-refresh path (it transparently calls refreshSession on 401) writes
// the new JWTs back to disk — without this, a reaped MCP child loses
// every refresh that happened in the dead process's memory.
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
  // 'expired' / 'create-failed' / 'network-error': do nothing. The
  // ensureAuthedAgent retry path handles 'expired' by calling login()
  // with the stored password.
}

function getAgent(): AtpAgent {
  if (!agent) {
    agent = new AtpAgent({ service: PDS_URL, persistSession })
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

// Returns an unauthenticated AtpAgent (for createAccount, etc.)
export function getRawAgent(): AtpAgent {
  return getAgent()
}

// Returns an agent cloned with the AppView proxy header set, so reads go via
// the PDS service-proxy fast-path to our AppView (per ADR-0025).
export async function getAppViewAgent(): Promise<AtpAgent> {
  const base = await getAuthedAgent()
  return base.withProxy('bsky_appview', APPVIEW_DID) as AtpAgent
}

function isAuthError(err: unknown): boolean {
  // AtpAgent throws an XRPCError with .status on transport-level failure.
  // Anything that surfaced 401 should trigger a single re-login retry; any
  // other status (or non-status error) just propagates.
  return (err as { status?: number })?.status === 401
}

// Run fn with an authed AtpAgent. If fn throws a 401, fire a fresh login
// via the stored password and replay fn once. Closes the
// persistSession('expired') gap that left auto-refresh failures unhandled
// (see specs/reauth-robustness.md Fix 13).
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

// Same retry shape for fetch-based reads (the ait.* lexicons aren't in
// @atproto/api's registry, so the read tools call PDS-proxied XRPC via raw
// fetch). Returns the Response — the caller checks .ok and parses JSON.
// Always sends the AppView proxy header.
export async function authedFetch(
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<Response> {
  const id = requireIdentity()
  await ensureAuthedAgent(id)
  const call = async (): Promise<Response> => {
    const jwt = requireIdentity().accessJwt
    const headers = {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${jwt}`,
      'atproto-proxy': `${APPVIEW_DID}#bsky_appview`,
    } as Record<string, string>
    return fetch(`${PDS_URL}${pathAndQuery}`, { ...init, headers })
  }
  const first = await call()
  if (first.status !== 401) return first
  await loginWithStoredCredentials(id)
  return call()
}

export { PDS_URL, APPVIEW_DID }
