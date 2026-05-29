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
// Session UUID resolution (ADR-0035, supersedes 0033's newest-mtime probe):
//   1. process.env.AIT_MCP_TEST_SESSION_ID — test-only override for
//      runners without a Claude Code harness (test scripts, direct CLI).
//   2. uuidFromParentArgv() — parse the parent claude process's argv via
//      `ps -o command= -p <ppid>` for `--resume <UUID>`. The harness
//      passes its own conversation UUID through this flag on resume; it
//      is the authoritative per-conversation identifier (verified via
//      `ps` against both Desktop and CLI harnesses).
//   3. process.env.CLAUDE_CODE_SESSION_ID — cold-start case: when the
//      harness launched fresh (no --resume), the env var it propagates
//      to the MCP child equals the new transcript UUID (verified via
//      `ps -E` against the CLI launcher; also true for Desktop's first
//      conversation in a project).
//
// ADR-0033's newest-mtime *.jsonl probe was the right call against
// Claude Code 2.1.149's "harness doesn't propagate CLAUDE_CODE_SESSION_ID
// to MCP children" behavior, but produced a multi-conversation-same-CWD
// collision the ADR explicitly deferred: when two live conversations
// share a project dir, the resolver picks whichever jsonl was most
// recently written, not the conversation that just spawned this MCP
// child. The parent-argv signal is authoritative — the harness knows
// which conversation it's resuming because the launcher passed
// `--resume <UUID>` on its command line.
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
//     "lastSeenNotificationAt": "<plaintext ISO ts | null>",
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
import { execFileSync } from 'node:child_process'
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
      'No session UUID resolvable. AIT_MCP_TEST_SESSION_ID is not set, ' +
        "the parent claude process's argv has no --resume <UUID>, and " +
        "CLAUDE_CODE_SESSION_ID is not in the MCP child's environment. " +
        'Production code paths get the UUID from the harness (--resume on ' +
        'resume, env var on cold-start; see ADR-0035). Test scripts and ' +
        'non-Claude-Code runners must set AIT_MCP_TEST_SESSION_ID explicitly.',
    )
    this.name = 'MissingSessionIdError'
  }
}

// Conversation UUIDs are 36-char dash-separated lowercase hex (RFC 4122).
// Lowercase-only because sha256 is case-sensitive: accepting upper would
// let the same logical UUID derive two different encryption keys.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Re-pattern: same shape as UUID_SHAPE but with capturing group, for
// extracting the UUID following a `--resume` token in argv.
const RESUME_UUID_RE =
  /--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

// Read the parent claude process's command-line argv via `ps` and extract
// the UUID following `--resume`. This is the authoritative signal for
// resumed conversations (Desktop, and any harness that respawns with
// --resume) because the launcher passed the conversation's UUID to the
// new claude process directly. Returns null on any failure (no parent
// PID, ps fails, no --resume in argv). `execFileSync` avoids shell
// interpolation; argv flows through directly.
function uuidFromParentArgv(): string | null {
  const ppid = process.ppid
  if (!ppid || ppid === 1) return null
  let argv: string
  try {
    argv = execFileSync('ps', ['-o', 'command=', '-p', String(ppid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  const match = RESUME_UUID_RE.exec(argv)
  if (!match) return null
  const uuid = match[1].toLowerCase()
  return UUID_SHAPE.test(uuid) ? uuid : null
}

// Three-source resolver. Each source serves a distinct case (not
// tier-hedging): test override for headless runners, parent argv for
// resumed conversations, env var for cold-start. Resolved fresh per
// identity call (no module-level memoization). Override is
// shape-validated the same way the production sources are — an
// asymmetric trust gap would let a malformed value silently produce a
// stable-but-wrong identity file.
function resolveSessionUuid(): string {
  const rawOverride = process.env.AIT_MCP_TEST_SESSION_ID
  if (rawOverride !== undefined) {
    const override = rawOverride.trim()
    if (UUID_SHAPE.test(override)) return override
    if (override.length > 0) {
      throw new Error(
        `AIT_MCP_TEST_SESSION_ID is set but does not match the UUID shape ` +
          `(RFC 4122 lowercase 36-char hex). Got: ${JSON.stringify(rawOverride)}.`,
      )
    }
    // Empty / whitespace-only override → fall through to production sources.
  }
  const fromArgv = uuidFromParentArgv()
  if (fromArgv) return fromArgv
  const fromEnv = process.env.CLAUDE_CODE_SESSION_ID
  if (fromEnv) {
    const trimmed = fromEnv.trim()
    if (UUID_SHAPE.test(trimmed)) return trimmed
  }
  throw new MissingSessionIdError()
}

function derivedKey(uuid: string): Buffer {
  return createHash('sha256').update(uuid + KEY_SALT).digest()
}

function identityPath(uuid: string): string {
  const hash = createHash('sha256').update(uuid).digest('hex').slice(0, 16)
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
  lastSeenNotificationAt?: string | null
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
    if (err instanceof MissingSessionIdError) return null
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
  // both on first join (cursor starts null) and on JWT refresh (cursor must
  // not regress to null and lose the push-mode advance).
  const existingCursor = readDiskShape(p)?.lastSeenNotificationAt ?? null
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
    createdAt: new Date().toISOString(),
    lastSeenNotificationAt: existingCursor,
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

// Notification cursor: advanced once per channel event emitted in push mode
// (per specs/notification-push.md). Returns null when no identity file exists
// yet or the field has never been set.
export function getLastSeenNotificationAt(): string | null {
  let uuid: string
  try {
    uuid = resolveSessionUuid()
  } catch {
    return null
  }
  return readDiskShape(identityPath(uuid))?.lastSeenNotificationAt ?? null
}

// Atomic rewrite of just the cursor field. No-op if the identity file is
// absent (nothing to attach a cursor to — caller should only call this after
// identity exists). Monotonic: a same-or-older `at` is dropped so two
// concurrent push handlers whose awaits resolve out of arrival order can't
// regress the cursor and cause the next replay to redeliver the newer event.
// Resolver failures (transient missing transcript, etc.) swallow silently —
// surfacing a 500 from the push handler would cause the AppView to drop the
// registration entirely, which is worse than missing one cursor advance.
// Reuses the same tmp+rename pattern as saveIdentity so a SIGKILL mid-write
// doesn't leave a partial file.
export function updateLastSeenNotificationAt(at: string): void {
  let uuid: string
  try {
    uuid = resolveSessionUuid()
  } catch {
    return
  }
  const p = identityPath(uuid)
  const existing = readDiskShape(p)
  if (!existing) return
  if (
    existing.lastSeenNotificationAt &&
    existing.lastSeenNotificationAt >= at
  ) {
    return
  }
  const updated: OnDiskShape = { ...existing, lastSeenNotificationAt: at }
  const tmp = `${p}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
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
