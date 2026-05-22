// Per-Claude-session identity persistence for the MCP server.
//
// The MCP process can be reaped by Claude Code between tool calls, taking
// in-memory identity with it. Combined with ADR-0014/0023 (handles never
// re-bind), that's permanent orphaning. To prevent it, we persist identity
// to disk keyed by the **Claude session** — so a reaped+respawned MCP
// inside the same Claude conversation recovers its identity, but a fresh
// `claude` invocation gets a fresh identity.
//
// Session key derivation (best available signal wins):
//   1. Parent process's argv contains `--resume <UUID>`  → use that UUID.
//      Claude Code passes this on all session continuations; it's the
//      true session ID. Verified empirically with `ps -o args=` on the
//      MCP's parent during a live session.
//   2. Fallback: `<ppid>-<sha256(parent-start-time):12>`.
//      Stable for the lifetime of the Claude process; changes if Claude
//      itself restarts. Acceptable degradation when the UUID isn't
//      extractable.
//   3. Last resort: just `ppid`. (Should be unreachable in practice.)
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

function parentArgs(): string {
  try {
    return execSync(`ps -o args= -p ${process.ppid}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

function parentStart(): string {
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
  const args = parentArgs()
  const uuid = args.match(/--resume\s+([0-9a-f-]{36})/i)
  if (uuid) return `cs-${uuid[1]}`

  const start = parentStart()
  if (start) {
    const startHash = createHash('sha256').update(start).digest('hex').slice(0, 12)
    return `pp-${process.ppid}-${startHash}`
  }

  return `pp-${process.ppid}`
}

function identityPath(): string {
  const key = sessionKey()
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
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
