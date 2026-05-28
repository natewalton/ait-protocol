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
// Session UUID resolution (ADR-0033, supersedes 0032's session-key source):
//   1. process.env.AIT_MCP_TEST_SESSION_ID — test-only override for
//      runners without a transcript file (test scripts, direct CLI).
//   2. Newest-mtime *.jsonl in ~/.claude/projects/<slug>/ whose basename
//      matches the UUID shape (RFC-4122 36-char hex). Slug = realpathSync
//      of CLAUDE_PROJECT_DIR with trailing `/` stripped and `/` and `.`
//      replaced by `-`. The Claude harness writes this file at its own
//      boot under Claude Desktop 2.1.149 (verified empirically); other
//      entry points that produce the same artifact resolve through the
//      same code path.
//
// Resolution runs fresh on every public storage call — no module-level
// cache. Each public function calls resolveSessionUuid() once at entry
// and threads the UUID into derivedKey(uuid) / identityPath(uuid), so a
// mid-call mtime fluctuation can't split the file path from the encryption
// key. ADR-0032 keyed on the env var CLAUDE_CODE_SESSION_ID; verified
// empirically false under Claude Desktop 2.1.149 (harness doesn't propagate
// that var to MCP children, only to per-Bash-tool shells).
// Spec: specs/transcript-derived-session-key.md.
//
// Supersedes ADR-0030's PPID+lstart scheme too (which 0032 already did) —
// the resolved UUID is stable across harness respawns within one
// conversation because the transcript filename doesn't change.
//
// File layout:
//   $XDG_DATA_HOME/ait-mcp/identity-<sha256(uuid):16>.json
//   {
//     "did": "<plaintext, public protocol id>",
//     "handle": "<plaintext, public protocol id>",
//     "createdAt": "<plaintext, diagnostic>",
//     "ciphertext": "<base64 AES-256-GCM ct of { password, accessJwt, refreshJwt }>",
//     "nonce": "<base64 12 bytes, fresh per write>",
//     "tag": "<base64 16 bytes, GCM auth tag>"
//   }
//
// Encryption key: sha256(uuid + ":ait-mcp:v2"), where uuid is the
// resolved conversation UUID. Derived only from the resolver output —
// never written to disk. A reader who can read the file but can't see
// the transcript directory (different Unix user) gets ciphertext only.

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
    const cwd = process.env.CLAUDE_PROJECT_DIR
    const cwdDiag = cwd
      ? ` CLAUDE_PROJECT_DIR=${JSON.stringify(cwd)}` +
        (cwd.startsWith('~') ? ' (literal tilde — likely unexpanded by the caller).' : '.')
      : ' CLAUDE_PROJECT_DIR is unset.'
    super(
      'No session UUID resolvable. Neither AIT_MCP_TEST_SESSION_ID is set ' +
        'nor a Claude transcript file was found at ~/.claude/projects/<slug>/. ' +
        'Production code paths discover the UUID from the transcript file; ' +
        'test scripts and non-Claude-Code runners must set ' +
        `AIT_MCP_TEST_SESSION_ID explicitly.${cwdDiag}`,
    )
    this.name = 'MissingSessionIdError'
  }
}

// Conversation UUIDs are 36-char dash-separated lowercase hex (RFC 4122).
// Anything that does not match this shape — hidden dotfiles, editor swap
// files, sidecar artifacts, future Claude tooling — is not a session UUID
// and must not be used as an encryption key. Lowercase-only because the
// harness writes lowercase and sha256 is case-sensitive: accepting upper
// would let the same logical UUID derive two different keys.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const JSONL_EXT = '.jsonl'

// Compute the harness's per-project directory name under ~/.claude/projects/.
// Empirical rule (verified against two worktrees): replace each `/` and `.`
// with `-`. Not invertible — we only need one-way derivation from a known
// CWD. `realpathSync` normalizes symlinks (macOS `/tmp` → `/private/tmp`,
// dotfile-managed setups) and strips trailing slashes. Returns null if
// CLAUDE_PROJECT_DIR is unset or its target does not exist.
function projectSlug(): string | null {
  const cwd = process.env.CLAUDE_PROJECT_DIR
  if (!cwd) return null
  let real: string
  try {
    real = fs.realpathSync(cwd)
  } catch {
    return null
  }
  return real.replaceAll('/', '-').replaceAll('.', '-')
}

// Discover the conversation UUID by reading the newest-mtime *.jsonl in
// the harness's per-project transcript directory whose basename matches
// the UUID shape. Symlinks are rejected (lstat + isSymbolicLink) so an
// attacker who can plant a file in the projects dir can't hijack the
// resolver by pointing a UUID-named symlink at an arbitrary file.
// Returns null if the directory or any qualifying file is absent.
function uuidFromTranscript(): string | null {
  const slug = projectSlug()
  if (!slug) return null
  const dir = path.join(os.homedir(), '.claude', 'projects', slug)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  let newestUuid: string | null = null
  let newestMtime = -Infinity
  for (const name of entries) {
    if (!name.endsWith(JSONL_EXT)) continue
    const stem = name.slice(0, -JSONL_EXT.length)
    if (!UUID_SHAPE.test(stem)) continue
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(path.join(dir, name))
    } catch {
      continue
    }
    if (!stat.isFile()) continue // also rejects symlinks via lstat
    if (stat.mtimeMs > newestMtime) {
      newestMtime = stat.mtimeMs
      newestUuid = stem
    }
  }
  return newestUuid
}

// Two-step resolver: test override → transcript file. Resolved fresh per
// identity call (no module-level memoization) so a wrong first pick can't
// lock the process to the wrong UUID for its lifetime. Each public storage
// function calls this once at entry and threads the UUID through. The
// override is shape-validated the same way the transcript path is — an
// asymmetric trust gap (transcript validated, override accepted verbatim)
// would let a malformed test env var silently produce a stable-but-wrong
// identity file.
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
    // Empty / whitespace-only override → fall through to transcript fallback.
  }
  const fromTranscript = uuidFromTranscript()
  if (fromTranscript) return fromTranscript
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
