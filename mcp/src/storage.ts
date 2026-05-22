// Per-Claude-session identity persistence for the MCP server.
//
// The MCP process can be reaped by Claude Code between tool calls, taking
// in-memory identity with it. Combined with ADR-0014/0023 (handles never
// re-bind), that's permanent orphaning. To prevent it, we persist identity
// to disk keyed by the **Claude process** — so a reaped+respawned MCP
// inside the same Claude conversation recovers its identity, but a fresh
// `claude` invocation gets a fresh identity.
//
// Session key: `sha256(<ppid>-<parent_start_time>)`, truncated.
//
//   - PPID + parent-process-start-time uniquely identifies the parent
//     Claude process. The pair is invariant for the lifetime of that
//     process, so every MCP child it spawns derives the same key.
//   - The pair changes when Claude itself restarts (new PID, new start
//     time even on PID reuse), which gives "fresh `claude` invocation =
//     fresh identity" semantics.
//   - There is NO fallback or alternate scheme. A single deterministic
//     derivation eliminates the risk that one logical session resolves
//     to two different storage files at different moments (which would
//     give the same conversation two distinct AIT identities — bad).
//
// Trade-off accepted: `claude --resume <uuid>` after a full Claude restart
// produces a new parent process, hence a new key, hence a new AIT identity.
// We lose continuity across Claude restarts in exchange for a guarantee
// that the same Claude process always sees the same identity.
//
// See ADR-0030.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import type { Identity } from './session.js'

const STORAGE_DIR = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
  'ait-mcp',
)

function parentStart(): string {
  // `lstart` is the canonical absolute start time on macOS / BSD ps. On Linux
  // it's accepted too. We tolerate failure: an empty start string means the
  // key collapses to just the PPID, which is still stable for that process's
  // lifetime — same parent process, same key.
  try {
    return execSync(`ps -o lstart= -p ${process.ppid}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function sessionKey(): string {
  return `${process.ppid}-${parentStart()}`
}

function identityPath(): string {
  const hash = createHash('sha256').update(sessionKey()).digest('hex').slice(0, 16)
  return path.join(STORAGE_DIR, `identity-${hash}.json`)
}

export interface PersistedIdentity extends Identity {
  sessionKey: string
  createdAt: string
}

export function loadIdentity(): PersistedIdentity | null {
  const p = identityPath()
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as PersistedIdentity
  } catch {
    return null
  }
}

export function saveIdentity(identity: Identity): void {
  const p = identityPath()
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  const data: PersistedIdentity = {
    ...identity,
    sessionKey: sessionKey(),
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export function clearIdentity(): void {
  const p = identityPath()
  if (fs.existsSync(p)) fs.unlinkSync(p)
}
