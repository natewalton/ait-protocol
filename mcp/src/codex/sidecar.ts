// Spawn + supervise the `codex app-server` sidecar for one session.
//
// v1 slice scope: spawn on the per-session socket, wait for it to accept, and
// kill it on shutdown. Crash-respawn (restart on unexpected exit, client
// reconnect, backlog `since` replay) is deferred to post-slice — the client's
// onClose seam and this module's `child` handle are where it will hook in.

import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'

const SOCKET_WAIT_ATTEMPTS = 60
const SOCKET_WAIT_INTERVAL_MS = 100

export interface Sidecar {
  child: ChildProcess
  shutdown: () => void
}

export interface SidecarOptions {
  socketPath: string
  // Extra `codex app-server` args — the launcher passes the `-c mcp_servers.ait.*`
  // overrides that register the tool-MCP with its pre-minted AIT_SESSION_ID.
  extraArgs?: string[]
}

export async function startSidecar({
  socketPath,
  extraArgs = [],
}: SidecarOptions): Promise<Sidecar> {
  // A stale socket file from a prior run makes bind fail; the app-server's own
  // startup lock guards a genuine double-spawn on the same path.
  try {
    fs.unlinkSync(socketPath)
  } catch {
    // absent — fine
  }

  // Scrub the launcher's own AIT_* vars from the app-server's env so they can't
  // leak into child MCPs by inheritance:
  //   - AIT_SESSION_ID: the ait tool-MCP gets its pre-minted id explicitly via
  //     the `-c mcp_servers.ait.env` override; other MCPs must not see it
  //     (gap-2 containment).
  //   - AIT_NOTIFICATION_MODE: the launcher runs as `codex`, but the tool-MCP
  //     must run in `poll` mode — if it inherited `codex` it would try to be a
  //     launcher instead of a tool server.
  const env = { ...process.env }
  delete env.AIT_SESSION_ID
  delete env.AIT_NOTIFICATION_MODE

  const args = ['app-server', '--listen', `unix://${socketPath}`, ...extraArgs]
  // app-server stderr → our stderr (launcher debug log); it is not user-facing.
  const child = spawn('codex', args, { stdio: ['ignore', 'ignore', 'inherit'], env })
  // A child 'error' with no listener (ENOENT when codex isn't on PATH, EMFILE,
  // …) is a fatal uncaught exception in Node. This persistent handler keeps a
  // post-startup error from crashing the launcher; waitForSocket wires its own
  // one-shot listener to turn a startup-window error into a clean rejection.
  child.on('error', (err) => console.error('codex app-server child error:', err.message))

  await waitForSocket(socketPath, child)

  return {
    child,
    shutdown: () => {
      if (!child.killed) child.kill()
    },
  }
}

// Resolve once the socket is accepting, or reject if the app-server exits first
// or the socket never appears.
function waitForSocket(socketPath: string, child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onExit = (code: number | null) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`codex app-server exited (code ${code}) before its socket came up`))
    }
    const onError = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`failed to launch codex app-server: ${err.message}`))
    }
    child.once('exit', onExit)
    child.once('error', onError)

    let attempts = 0
    const poll = () => {
      if (settled) return
      if (fs.existsSync(socketPath)) {
        settled = true
        cleanup()
        resolve()
        return
      }
      if (++attempts >= SOCKET_WAIT_ATTEMPTS) {
        settled = true
        cleanup()
        reject(new Error(`codex app-server socket ${socketPath} did not appear in time`))
        return
      }
      setTimeout(poll, SOCKET_WAIT_INTERVAL_MS)
    }
    poll()
  })
}
