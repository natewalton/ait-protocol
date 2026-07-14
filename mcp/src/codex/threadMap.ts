// The {codex threadId → AIT_SESSION_ID} resume bridge.
//
// Identity has to be pre-minted before thread/start (Codex freezes a child MCP's
// env at spawn), so it can't be the codex threadId — which only exists after the
// thread does. The launcher therefore mints a UUID up front and records, per
// thread, which UUID it minted. On `codex-session.sh --session <threadId>` the
// launcher recovers that UUID and rebinds the same AIT handle instead of
// orphaning it (ADR-0042; the top code-review finding). codex-cli owns the
// name→threadId map; this file owns threadId→AIT-identity.
//
// Persisted 0600 in the same XDG data dir as the identity files (durable across
// reboots, unlike the runtime-dir sockets). One small file per thread — the same
// shape as the per-session identity/socket files, not a global table.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { STORAGE_DIR } from '../storage.js'

function mapPath(threadId: string): string {
  // threadId is a codex UUID; strip anything non-UUID-ish before using it as a
  // filename component (defensive — the value comes from operator argv).
  const safe = threadId.replace(/[^a-zA-Z0-9-]/g, '')
  return path.join(STORAGE_DIR, `codex-thread-${safe}.json`)
}

// The AIT_SESSION_ID minted for this thread on its original launch, or null if
// this thread has never been launched (a new session, or a `codex fork`).
export function readThreadSessionId(threadId: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(mapPath(threadId), 'utf8')) as {
      sessionId?: string
    }
    return raw.sessionId ?? null
  } catch {
    return null // absent or unparseable → treat as unknown thread
  }
}

// Record threadId → sessionId. Atomic tmp+rename so a crash mid-write can't leave
// a partial file (loss would orphan the handle on the next resume). Idempotent.
export function writeThreadSessionId(threadId: string, sessionId: string): void {
  fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 })
  const p = mapPath(threadId)
  const tmp = `${p}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({ threadId, sessionId }, null, 2), {
    mode: 0o600,
  })
  fs.renameSync(tmp, p)
}
