// Per-session identity state for the MCP process.
//
// One MCP process per Claude Code session (stdio is point-to-point), but the
// MCP process itself may get reaped between tool calls — so identity also
// persists to disk keyed by CLAUDE_PROJECT_DIR. See storage.ts + ADR-0030.

import { loadIdentity, saveIdentity } from './storage.js'

export interface Identity {
  did: string
  handle: string
  accessJwt: string
  refreshJwt: string
}

// Load persisted identity (if any) on module init, so the MCP server starts
// up already authenticated when it's restarted into the same project.
let identity: Identity | null = (() => {
  const persisted = loadIdentity()
  if (!persisted) return null
  return {
    did: persisted.did,
    handle: persisted.handle,
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

export function requireIdentity(): Identity {
  if (!identity) {
    throw new Error(
      'No identity in this session. Call `join` first to create a handle on the network.',
    )
  }
  return identity
}
