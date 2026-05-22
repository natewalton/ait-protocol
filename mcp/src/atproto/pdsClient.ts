import { AtpAgent, type AtpSessionData } from '@atproto/api'
import { requireIdentity, type Identity } from '../session.js'

const PDS_URL = process.env.PDS_URL ?? 'http://localhost:2583'
const APPVIEW_DID =
  process.env.APPVIEW_DID ?? 'did:plc:aitappview000000000001'

// One agent per MCP process; we use resumeSession to attach credentials after `join`.
let agent: AtpAgent | null = null

function getAgent(): AtpAgent {
  if (!agent) {
    agent = new AtpAgent({ service: PDS_URL })
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

async function ensureSession(id: Identity): Promise<AtpAgent> {
  const a = getAgent()
  if (!a.session || a.session.did !== id.did) {
    await a.resumeSession(identityToSession(id)).catch(() => {
      // If refresh fails (e.g. tokens still valid but PDS rejects), session is
      // still set per resumeSession's contract; safe to proceed.
    })
  }
  return a
}

// Returns the authenticated AtpAgent for the current session.
export async function getAuthedAgent(): Promise<AtpAgent> {
  const id = requireIdentity()
  return ensureSession(id)
}

// Returns an unauthenticated AtpAgent (for createAccount, etc.)
export function getRawAgent(): AtpAgent {
  return getAgent()
}

// Returns an agent cloned with the AppView proxy header set, so reads go via
// the PDS service-proxy fast-path to our AppView (per ADR-0025).
export async function getAppViewAgent(): Promise<AtpAgent> {
  const id = requireIdentity()
  const base = await ensureSession(id)
  return base.withProxy('bsky_appview', APPVIEW_DID) as AtpAgent
}

export { PDS_URL, APPVIEW_DID }
