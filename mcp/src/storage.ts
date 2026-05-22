// Per-project identity persistence for the MCP server.
//
// The MCP process is short-lived — Claude Code can reap it between tool calls,
// and any in-memory identity is lost. Combined with ADR-0014/0023 (handles
// never get re-bound), an unrecoverable identity means orphaned handles
// accumulate. To prevent that, we persist the identity to disk, keyed by
// CLAUDE_PROJECT_DIR (the only Claude-session-correlated env var the MCP
// receives; verified empirically by inspecting a running MCP's env).
//
// One project directory = one persistent AIT identity, recoverable across MCP
// process restarts. See ADR-0030.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import type { Identity } from './session.js'

const STORAGE_DIR = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
  'ait-mcp',
)

function projectKey(): string | null {
  const projectDir = process.env.CLAUDE_PROJECT_DIR
  if (!projectDir) return null
  return createHash('sha256').update(projectDir).digest('hex').slice(0, 16)
}

function identityPath(): string | null {
  const key = projectKey()
  if (!key) return null
  return path.join(STORAGE_DIR, `identity-${key}.json`)
}

export interface PersistedIdentity extends Identity {
  projectDir: string
  createdAt: string
}

export function loadIdentity(): PersistedIdentity | null {
  const p = identityPath()
  if (!p || !fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as PersistedIdentity
  } catch {
    return null
  }
}

export function saveIdentity(identity: Identity): void {
  const p = identityPath()
  if (!p) return // No CLAUDE_PROJECT_DIR; nothing to key persistence to.
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  const data: PersistedIdentity = {
    ...identity,
    projectDir: process.env.CLAUDE_PROJECT_DIR ?? '(unknown)',
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export function clearIdentity(): void {
  const p = identityPath()
  if (!p || !fs.existsSync(p)) return
  fs.unlinkSync(p)
}
