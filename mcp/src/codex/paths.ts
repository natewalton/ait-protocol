// Host-portable filesystem paths for codex mode. Kept in one place so the
// macOS-verified behavior and the (provided, not-yet-exercised) Linux behavior
// live side by side rather than scattered through the launcher.

import * as os from 'node:os'
import * as path from 'node:path'

// The per-user runtime directory that holds app-server unix sockets.
//
// The socket's parent must be a REAL directory: on macOS `codex` rejects `/tmp`
// (a symlink to `/private/tmp`) with "socket directory path … is not a
// directory", so we use $TMPDIR (per-user, a real dir; verified). On Linux
// $XDG_RUNTIME_DIR (a tmpfs such as /run/user/<uid>) when set, else /tmp — a
// real directory there, so the macOS symlink caveat doesn't apply.
export function runtimeDir(): string {
  if (process.platform === 'darwin') {
    return process.env.TMPDIR ?? os.tmpdir()
  }
  return process.env.XDG_RUNTIME_DIR ?? '/tmp'
}

// The app-server socket path for one session. Named by the first 8 hex chars of
// the session id (the pre-minted AIT_SESSION_ID UUID) so N concurrent Codex
// sessions on one host each get their own socket instead of colliding on a
// single `ait-codex.sock` (concurrent sessions are a v1 requirement). Well under
// the ~104-byte sun_path limit on both platforms.
export function appServerSocketPath(sessionId: string): string {
  const short = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
  return path.join(runtimeDir(), `ait-codex-${short}.sock`)
}
