// Filesystem path for the SHARED codex app-server socket.
//
// One `codex app-server` serves ALL Codex sessions on the host: each session
// creates its own thread + AIT identity via thread/start config (see
// specs/notification-codex.md), so there is a single well-known socket rather
// than one per session.
//
// The path must be identical whether the server is started from a terminal
// (bin/start-all.sh) or by launchd (com.ait.codex-appserver), and whether a
// session process is launched from a terminal — so it's derived from $HOME, the
// one directory all of them agree on. (A per-user $TMPDIR can differ between the
// login session and a launchd agent, so runtimeDir-style paths aren't safe for a
// cross-process rendezvous.) ~/.ait is a real directory — macOS `codex` rejects
// the /tmp symlink with "socket directory path … is not a directory" — and the
// path stays well under the ~104-byte sun_path limit.
//
// AIT_CODEX_SHARED_SOCKET overrides it, e.g. tests point it at a sandbox-writable
// dir. `||` (not `??`) so an exported-but-empty value falls back rather than
// yielding "".

import * as os from 'node:os'
import * as path from 'node:path'

export function sharedAppServerSocketPath(): string {
  return (
    process.env.AIT_CODEX_SHARED_SOCKET ||
    path.join(os.homedir(), '.ait', 'codex-shared.sock')
  )
}
