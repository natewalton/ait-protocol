// Per-conversation identity state for the MCP server.
//
// One MCP child per Claude Code conversation (stdio is point-to-point),
// but the child can be reaped between tool calls — so identity also
// persists to disk, keyed by the conversation UUID the harness propagates
// as CLAUDE_CODE_SESSION_ID at MCP spawn (ADR-0035, supersedes 0033). See
// storage.ts for the resolver.

import { loadIdentity, saveIdentity } from './storage.js'

export interface Identity {
  did: string
  handle: string
  password: string
  accessJwt: string
  refreshJwt: string
}

// Load persisted identity (if any) on module init, so the MCP server starts
// up already authenticated when it's reaped+respawned into the same
// conversation.
let identity: Identity | null = (() => {
  const persisted = loadIdentity()
  if (!persisted) return null
  return {
    did: persisted.did,
    handle: persisted.handle,
    password: persisted.password,
    accessJwt: persisted.accessJwt,
    refreshJwt: persisted.refreshJwt,
  }
})()

export function getIdentity(): Identity | null {
  return identity
}

export function setIdentity(id: Identity) {
  identity = id
  saveIdentity(id)
}

// Update the cached JWTs (and optionally other fields) without redoing the
// whole `setIdentity` ritual. Used by AtpAgent's persistSession callback
// when a refresh produces fresh tokens — we want the new ones on disk so
// the next reap+respawn picks them up.
export function updateIdentityTokens(patch: {
  accessJwt: string
  refreshJwt: string
}): void {
  if (!identity) return
  identity = { ...identity, ...patch }
  saveIdentity(identity)
}

export function requireIdentity(): Identity {
  if (!identity) {
    throw new Error(
      'No identity in this session. Call `join` first to create a handle on the network.',
    )
  }
  return identity
}
