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
// Test and explicit Codex UUIDs retain priority. Claude runtime resolution
// lives in claudeSession.ts: ordinary resume uses its explicit UUID; a native
// fork uses its own UUID and only verified continued-in metadata can bind it
// back to an existing account. Neither newest transcript nor cwd selects an
// account. A successful continuation keeps the original encryption/cursor key.
//
// Resolution runs fresh on every public storage call — no module-level
// cache. Each public function calls resolveSessionUuid() once at entry
// and threads the UUID into derivedKey(uuid) / identityPath(uuid).
//
// File layout:
//   $XDG_DATA_HOME/ait-mcp/identity-<sha256(uuid):16>.json
//   {
//     "did": "<plaintext, public protocol id>",
//     "handle": "<plaintext, public protocol id>",
//     "createdAt": "<plaintext, diagnostic>",
//     "lastSeenNotificationAt": "<legacy plaintext ISO ts | null>",
//     "lastSeenNotificationCursor": "<opaque AppView cursor | null>",
//     "ciphertext": "<base64 AES-256-GCM ct of { password, accessJwt, refreshJwt }>",
//     "nonce": "<base64 12 bytes, fresh per write>",
//     "tag": "<base64 16 bytes, GCM auth tag>"
//   }
//
// Encryption key: sha256(uuid + ":ait-mcp:v2"), where uuid is the
// resolved conversation UUID. Derived only from the resolver output —
// never written to disk.

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
import { claudeRuntimeUuid, resolveClaudeIdentity, claudeIdentityUuid, ClaudeHandoverPending } from './claudeSession.js'

export const STORAGE_DIR = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
  'ait-mcp',
)

const KEY_SALT = ':ait-mcp:v2'

class MissingSessionIdError extends Error {
  constructor() {
    super(
      'No session UUID resolvable. AIT_MCP_TEST_SESSION_ID is not set, ' +
        "the parent claude process's argv has no --resume <UUID>, " +
        "CLAUDE_CODE_SESSION_ID is not in the MCP child's environment, and " +
        'AIT_SESSION_ID (the Codex-host source) is unset. Production code ' +
        'paths get the UUID from the harness (Claude: --resume on resume, ' +
        'env var on cold-start; Codex: AIT_SESSION_ID pre-minted by the ' +
        'launcher — see ADR-0035 and specs/notification-codex.md). Test ' +
        'scripts and non-harness runners must set AIT_MCP_TEST_SESSION_ID.',
    )
    this.name = 'MissingSessionIdError'
  }
}

// Conversation UUIDs are 36-char dash-separated lowercase hex (RFC 4122).
// The pattern stays lowercase-only because sha256 is case-sensitive: one
// logical UUID in two cases would derive two different encryption keys and
// two different identity files. Every source is lowercased before it reaches
// this test, so a harness that starts emitting uppercase keeps its identity
// instead of being read as a brand-new session and minting a second handle.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// The one spelling rule, so a source added later cannot forget it: trim,
// lowercase, shape-check. Null means "not a usable conversation UUID".
export function canonicalUuid(raw: string | null | undefined): string | null {
  if (!raw) return null
  const uuid = raw.trim().toLowerCase()
  return UUID_SHAPE.test(uuid) ? uuid : null
}

// Four-source resolver. Each source serves a distinct host type (not
// tier-hedging): test override for headless runners, parent argv for
// resumed Claude conversations, env var for cold-start Claude, and
// AIT_SESSION_ID for the Codex host. Resolved fresh per identity call
// (no module-level memoization). Override is shape-validated the same
// way the production sources are — an asymmetric trust gap would let a
// malformed value silently produce a stable-but-wrong identity file.
function resolveSessionUuid(): string {
  const rawOverride = process.env.AIT_MCP_TEST_SESSION_ID
  if (rawOverride !== undefined) {
    const override = canonicalUuid(rawOverride)
    if (override) return override
    if (rawOverride.trim().length > 0) {
      throw new Error(
        `AIT_MCP_TEST_SESSION_ID is set but does not match the UUID shape ` +
          `(RFC 4122 36-char hex; case is normalized). Got: ${JSON.stringify(rawOverride)}.`,
      )
    }
    // Empty / whitespace-only override → fall through to production sources.
  }
  // Codex host (authoritative when set): the launcher pre-mints AIT_SESSION_ID
  // into the tool-MCP's env before thread/start (specs/notification-codex.md,
  // Identity), since Codex propagates no per-thread id to child MCPs. Checked
  // ABOVE the Claude sources so a leaked CLAUDE_CODE_SESSION_ID or --resume argv
  // — e.g. a codex session launched from inside a Claude session, which inherits
  // that env — can't shadow the explicit codex id. Never set on the Claude path,
  // so Claude resolution stays independent of this explicit binding.
  const fromCodex = canonicalUuid(process.env.AIT_SESSION_ID)
  if (fromCodex) return fromCodex
  // A real native fork/background worker has its own runtime UUID. Only
  // Claude's explicit continued-in evidence can authorize the original identity.
  const runtime = claudeRuntimeUuid()
  if (runtime) return resolveClaudeIdentity(runtime)
  throw new MissingSessionIdError()
}

function derivedKey(uuid: string): Buffer {
  return createHash('sha256').update(uuid + KEY_SALT).digest()
}

function identityPath(uuid: string): string {
  const hash = createHash('sha256').update(uuid).digest('hex').slice(0, 16)
  return path.join(STORAGE_DIR, `identity-${hash}.json`)
}

const PUBLIC_HANDLE_SHAPE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i

// Discovery needs only the public binding. Keep this separate from
// loadIdentity(): a session picker must never resolve a harness environment,
// decrypt credentials, or write a repaired identity while joining existing
// records.
export function readPublicIdentity(
  sessionUuid: string,
): { did: string; handle: string } | null {
  const rawUuid = canonicalUuid(sessionUuid)
  const uuid = rawUuid ? claudeIdentityUuid(rawUuid) : null
  if (!uuid) return null
  const p = identityPath(uuid)
  let raw: Partial<OnDiskShape>
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<OnDiskShape>
  } catch {
    return null
  }
  if (
    typeof raw.did !== 'string' ||
    raw.did.length === 0 ||
    typeof raw.handle !== 'string' ||
    raw.handle.length > 253 ||
    !PUBLIC_HANDLE_SHAPE.test(raw.handle) ||
    typeof raw.ciphertext !== 'string' ||
    typeof raw.nonce !== 'string' ||
    typeof raw.tag !== 'string'
  ) {
    return null
  }
  return { did: raw.did, handle: raw.handle }
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
  lastSeenNotificationAt?: string | null
  // Opaque AppView-issued cursor. New identities leave this null until their
  // first registerPushTarget response supplies a baseline. The legacy ISO
  // field above remains readable indefinitely for dormant-session upgrades.
  lastSeenNotificationCursor?: string | null
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
  // Resolver failure → no identity (rather than crashing the MCP child on
  // module init). Callers see this as "first run, please call join".
  let uuid: string
  try {
    uuid = resolveSessionUuid()
  } catch (err) {
    if (err instanceof MissingSessionIdError || err instanceof ClaudeHandoverPending) return null
    throw err
  }
  const p = identityPath(uuid)
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
    inner = decryptInner(raw, derivedKey(uuid))
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
  // Resolve once at entry, thread the UUID through path + key derivation,
  // so a mid-call mtime fluctuation can't split path-from-key. Throws on
  // unresolvable session — surface to caller (test-misconfig contract).
  const uuid = resolveSessionUuid()
  const p = identityPath(uuid)
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  // Preserve the notification cursor across rewrites: saveIdentity is called
  // both on first join and on JWT refresh (cursor must not regress and lose the
  // push-mode advance).
  const existingDisk = readDiskShape(p)
  const createdAt = new Date().toISOString()
  const envelope = encryptInner(
    {
      password: identity.password,
      accessJwt: identity.accessJwt,
      refreshJwt: identity.refreshJwt,
    },
    derivedKey(uuid),
  )
  const data: OnDiskShape = {
    did: identity.did,
    handle: identity.handle,
    createdAt,
    // Preserve either cursor generation across JWT refreshes. A fresh identity
    // deliberately has neither: the AppView owns sequence space and returns the
    // initial opaque baseline from registerPushTarget. Client wall clock is not
    // a valid substitute for an AppView cursor.
    lastSeenNotificationAt: existingDisk?.lastSeenNotificationAt ?? null,
    lastSeenNotificationCursor:
      existingDisk?.lastSeenNotificationCursor ?? null,
    ...envelope,
  }
  // Atomic write: tmp + rename. SIGKILL between truncate and final flush on a
  // direct writeFileSync produces a partial-JSON file; loadIdentity treats
  // parse failures as "no identity", and ADR-0014 makes that loss permanent.
  // POSIX rename(2) replaces atomically. PID suffix tolerates concurrent
  // writes from sibling children (shouldn't happen but cheap to defend).
  const tmp = `${p}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
}

// Read the OnDiskShape if present and parseable; null otherwise. Internal
// helper used by both saveIdentity (to preserve the cursor) and the cursor
// accessors below.
function readDiskShape(p: string): OnDiskShape | null {
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as OnDiskShape
  } catch {
    return null
  }
}

export type NotificationRegistrationCheckpoint =
  | { kind: 'cursor'; value: string }
  | { kind: 'since'; value: string }
  | { kind: 'none'; value: null }

// Prefer the opaque cursor, but retain the legacy ISO timestamp indefinitely:
// dormant conversations may first resume long after the seq migration. The
// AppView is the only layer that can translate that timestamp without racing
// its notification projection.
export function getNotificationRegistrationCheckpoint(): NotificationRegistrationCheckpoint {
  let uuid: string
  try {
    uuid = resolveSessionUuid()
  } catch {
    return { kind: 'none', value: null }
  }
  const disk = readDiskShape(identityPath(uuid))
  const cursor = disk?.lastSeenNotificationCursor
  if (cursor) return { kind: 'cursor', value: cursor }
  const since = disk?.lastSeenNotificationAt
  if (since) return { kind: 'since', value: since }
  return { kind: 'none', value: null }
}

function rewriteCursor(
  p: string,
  existing: OnDiskShape,
  cursor: string,
): void {
  const updated: OnDiskShape = {
    ...existing,
    lastSeenNotificationAt: null,
    lastSeenNotificationCursor: cursor,
  }
  const tmp = `${p}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
}

// Persist a delivered AppView cursor. Delivery is serial per recipient, so
// callers never complete out of order and no client-side cursor comparison is
// needed (opaque cursors must not be parsed here).
export function updateLastSeenNotificationCursor(cursor: string): void {
  let uuid: string
  try {
    uuid = resolveSessionUuid()
  } catch {
    return
  }
  const p = identityPath(uuid)
  const existing = readDiskShape(p)
  if (!existing) return
  rewriteCursor(p, existing, cursor)
}

// Normalize a first-registration or legacy timestamp checkpoint without
// regressing a cursor advanced concurrently by live delivery. `expected` is
// the exact value sent to registerPushTarget (null for a fresh identity).
export function compareAndSwapNotificationCursor(
  expected: string | null,
  cursor: string,
): boolean {
  let uuid: string
  try {
    uuid = resolveSessionUuid()
  } catch {
    return false
  }
  const p = identityPath(uuid)
  const existing = readDiskShape(p)
  if (!existing) return false
  const current =
    existing.lastSeenNotificationCursor ??
    existing.lastSeenNotificationAt ??
    null
  if (current !== expected) return false
  rewriteCursor(p, existing, cursor)
  return true
}

export function clearIdentity(): void {
  let uuid: string
  try {
    uuid = resolveSessionUuid()
  } catch {
    return
  }
  const p = identityPath(uuid)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

// Expose a pending handover instead of recommending a new join.
export function ensureSessionIdentityReady(): void { resolveSessionUuid() }
