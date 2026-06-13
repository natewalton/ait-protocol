// Persistent identity for the standalone terminal watcher.
//
// Unlike the MCP server's store (src/storage.ts), this is a plain JSON file —
// no encryption, no conversation-UUID keying. The MCP encrypts because many
// Claude sessions share one machine and ADR-0007 requires that one session
// can't read another's credentials. The watcher is a single tool the user runs
// themselves; there is no co-tenant to hide from, so the credential is just
// stored at mode 0600 (owner read/write only). The PDS account password is
// auto-generated (see main.ts) and never typed by the user.
//
// One watcher account, reused across runs: the same handle keeps its follow
// graph so re-running `bin/watch.sh` with the same set is a no-op reconcile.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const STORAGE_DIR = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
  'ait-watcher',
)
const IDENTITY_PATH = path.join(STORAGE_DIR, 'identity.json')

// handle → the follow record we wrote for it. followUri is the at-uri of the
// ait.graph.follow record, needed to delete it when the handle leaves the set.
export interface FollowRecord {
  did: string
  followUri: string
}

export interface WatcherIdentity {
  did: string
  handle: string
  password: string
  createdAt: string
  follows: Record<string, FollowRecord>
}

export function identityFilePath(): string {
  return IDENTITY_PATH
}

export function loadIdentity(): WatcherIdentity | null {
  if (!fs.existsSync(IDENTITY_PATH)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8')) as WatcherIdentity
    // Tolerate a file written before `follows` existed.
    if (!raw.follows) raw.follows = {}
    return raw
  } catch {
    return null
  }
}

export function saveIdentity(identity: WatcherIdentity): void {
  fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 })
  // Atomic write: tmp + rename, so a crash mid-write can't leave a half-JSON
  // file that would orphan the handle (ADR-0014: handles never re-bind).
  const tmp = `${IDENTITY_PATH}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, IDENTITY_PATH)
}
