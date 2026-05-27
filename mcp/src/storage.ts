// Per-Claude-conversation identity persistence for the MCP server.
//
// The MCP child can be reaped by Claude Code between tool calls, taking
// in-memory identity with it. Combined with ADR-0014 (handles never
// re-bind), an unrecoverable identity means a permanently orphaned handle.
// To prevent that, identity persists to disk keyed by the Claude
// conversation — so a reaped+respawned MCP child inside the same
// conversation recovers its identity, but a different conversation
// gets its own.
//
// Session key: CLAUDE_CODE_SESSION_ID, the UUID Claude Code sets in
// the MCP child's environment (matches the `--resume <uuid>` argument
// on the Claude harness's command line). Stable across harness
// respawns within one conversation; differs across conversations.
//
// Supersedes ADR-0030's PPID+lstart scheme, which was empirically
// non-invariant — the harness gets respawned mid-conversation and
// every respawn produced a new hash, fragmenting identity across
// files. Diagnosis in specs/session-reauth.md.
//
// File layout:
//   $XDG_DATA_HOME/ait-mcp/identity-<sha256(session_id):16>.json
//   {
//     "did": "<plaintext, public protocol id>",
//     "handle": "<plaintext, public protocol id>",
//     "createdAt": "<plaintext, diagnostic>",
//     "ciphertext": "<base64 AES-256-GCM ct of { password, accessJwt, refreshJwt }>",
//     "nonce": "<base64 12 bytes, fresh per write>",
//     "tag": "<base64 16 bytes, GCM auth tag>"
//   }
//
// Encryption key: sha256(CLAUDE_CODE_SESSION_ID + ":ait-mcp:v2").
// Derived only from the env var — never written to disk. A reader who
// can read the file but can't see the session env (e.g. another Claude
// session on the same Unix user) gets ciphertext only.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import type { Identity } from './session.js'

const STORAGE_DIR = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
  'ait-mcp',
)

const KEY_SALT = ':ait-mcp:v2'

class MissingSessionIdError extends Error {
  constructor() {
    super(
      'CLAUDE_CODE_SESSION_ID not set. MCP identity is keyed by the Claude ' +
        'conversation UUID; non-Claude-Code runners (test scripts, direct CLI) ' +
        'must set this env var explicitly.',
    )
    this.name = 'MissingSessionIdError'
  }
}

function sessionKey(): string {
  const id = process.env.CLAUDE_CODE_SESSION_ID
  if (!id) throw new MissingSessionIdError()
  return id
}

function derivedKey(): Buffer {
  return createHash('sha256').update(sessionKey() + KEY_SALT).digest()
}

function identityPath(): string {
  const hash = createHash('sha256').update(sessionKey()).digest('hex').slice(0, 16)
  return path.join(STORAGE_DIR, `identity-${hash}.json`)
}

interface EncryptedInner {
  password: string
  accessJwt: string
  refreshJwt: string
}

interface OnDiskShape {
  did: string
  handle: string
  createdAt: string
  ciphertext: string
  nonce: string
  tag: string
}

export interface PersistedIdentity extends Identity {
  createdAt: string
}

function encryptInner(inner: EncryptedInner, key: Buffer): {
  ciphertext: string
  nonce: string
  tag: string
} {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(inner), 'utf8'),
    cipher.final(),
  ])
  return {
    ciphertext: ct.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

function decryptInner(
  envelope: { ciphertext: string; nonce: string; tag: string },
  key: Buffer,
): EncryptedInner {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.nonce, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const pt = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(pt.toString('utf8')) as EncryptedInner
}

export function loadIdentity(): PersistedIdentity | null {
  // Missing env var → no identity (rather than crashing the MCP child on
  // module init). Callers see this as "first run, please call join".
  let p: string
  try {
    p = identityPath()
  } catch (err) {
    if (err instanceof MissingSessionIdError) return null
    throw err
  }
  if (!fs.existsSync(p)) return null
  let raw: OnDiskShape
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as OnDiskShape
  } catch {
    return null
  }
  // Reject v1 files (no ciphertext envelope). The PPID-hash bug made
  // those orphans even before this change, so there's nothing to recover.
  if (!raw.ciphertext || !raw.nonce || !raw.tag) return null
  let inner: EncryptedInner
  try {
    inner = decryptInner(raw, derivedKey())
  } catch {
    // Decrypt failure: file was written under a different session key,
    // or someone tampered with it. Either way it's not ours.
    return null
  }
  return {
    did: raw.did,
    handle: raw.handle,
    password: inner.password,
    accessJwt: inner.accessJwt,
    refreshJwt: inner.refreshJwt,
    createdAt: raw.createdAt,
  }
}

export function saveIdentity(identity: Identity): void {
  const p = identityPath() // throws if env var missing — surface to caller
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  const envelope = encryptInner(
    {
      password: identity.password,
      accessJwt: identity.accessJwt,
      refreshJwt: identity.refreshJwt,
    },
    derivedKey(),
  )
  const data: OnDiskShape = {
    did: identity.did,
    handle: identity.handle,
    createdAt: new Date().toISOString(),
    ...envelope,
  }
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export function clearIdentity(): void {
  let p: string
  try {
    p = identityPath()
  } catch {
    return
  }
  if (fs.existsSync(p)) fs.unlinkSync(p)
}
