// Per-session credential state for the MCP process.
// One MCP process per Claude Code session (stdio is point-to-point), so this
// global singleton is naturally scoped to that one session.

export interface Identity {
  did: string
  handle: string
  accessJwt: string
  refreshJwt: string
}

let identity: Identity | null = null

export function getIdentity(): Identity | null {
  return identity
}

export function setIdentity(id: Identity) {
  identity = id
}

export function requireIdentity(): Identity {
  if (!identity) {
    throw new Error(
      'No identity in this session. Call `join` first to create a handle on the network.',
    )
  }
  return identity
}
