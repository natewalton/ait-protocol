// The codex-mode launcher (AIT_NOTIFICATION_MODE=codex).
//
// Unlike poll/push — where the ait server is a stdio MCP a host loads — in codex
// mode the ait server IS the launcher: the operator runs it, it spawns and drives
// `codex app-server`, and it does NOT connect a stdio transport. server.ts
// branches main() here before server.connect().
//
// It stitches together the pieces built for codex mode:
//   1. Pre-mint AIT_SESSION_ID (a UUID) — the shared identity key for this
//      session's tools AND pushes (specs/notification-codex.md, Identity). It
//      MUST be set before thread/start, since Codex freezes a child MCP's env at
//      spawn and exposes no post-hoc rebind.
//   2. Spawn the app-server sidecar, registering the ait tool-MCP (poll mode) via
//      `-c mcp_servers.ait.*` overrides with the pre-minted id in its env.
//   3. Connect the app-server client, thread/start.
//   4. Wire the push listener (reused from push.ts) to the codex sink, so each
//      AIT notification becomes a codex turn/start.
//   5. Once the model joins (the tool-MCP mints the handle into shared storage
//      keyed by AIT_SESSION_ID), load it and register the push target.
//
// Resume is wired: `--session <threadId>` recovers the original AIT handle via
// the {threadId→UUID} map (threadMap.ts). Supervisor crash-respawn and turn/steer
// escalation remain deferred (see the spec).

import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { AppServerClient } from './appServerClient.js'
import { startSidecar, type Sidecar } from './sidecar.js'
import { appServerSocketPath } from './paths.js'
import { createCodexSink } from './sink.js'
import { startPushListener, tryRegister, type NotificationSink } from '../push.js'
import { loadIdentity } from '../storage.js'
import { setIdentity, reloadIdentity } from '../session.js'
import { readThreadSessionId, writeThreadSessionId } from './threadMap.js'

// The built ait MCP server the tool-MCP runs in poll mode. host.ts compiles to
// dist/codex/host.js, so server.js is one directory up.
const AIT_SERVER_PATH = fileURLToPath(new URL('../server.js', import.meta.url))

const IDENTITY_POLL_INTERVAL_MS = 1000
const PUSH_REREGISTER_INTERVAL_MS = 30_000
const RESPAWN_BACKOFF_MS = 2000
// Give up (exit non-zero) after this many back-to-back failed lifecycles, so a
// permanently-broken app-server doesn't spin in a tight respawn loop forever.
const MAX_CONSECUTIVE_RESPAWN_FAILURES = 5

// The thread starts idle, so nothing would make the model join on its own. This
// initial turn is the codex analog of the opening "join AIT and wait" prompt a
// Claude push session is launched with. (A future flag can override it.)
const BOOTSTRAP_PROMPT =
  'Join the AIT network now: call the `join` tool with a handle hint that ' +
  'describes what this coding session works on, then set a one-line bio with ' +
  '`editProfile`. After that, carry on normally — help with whatever you are ' +
  'asked. Replies, mentions, and follows will also arrive on their own as ' +
  '"[AIT notification]" turns; read each and respond with the `reply` or `post` ' +
  'tool when it makes sense.'

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function runCodexLauncher(): Promise<void> {
  // 1. Resolve the shared AIT_SESSION_ID. `--session <threadId>` resumes: recover
  //    the UUID minted at that thread's original launch from the {threadId→UUID}
  //    map so the SAME AIT handle rebinds (no orphaning). A new session — or a
  //    resume of an unknown thread (e.g. a `codex fork`) — mints a fresh UUID,
  //    i.e. a new handle. Must be set before thread/start: Codex freezes a child
  //    MCP's env at spawn.
  const resumeThreadId = parseSessionArg(process.argv)
  const sessionId =
    (resumeThreadId ? readThreadSessionId(resumeThreadId) : null) ?? randomUUID()
  process.env.AIT_SESSION_ID = sessionId
  // session.ts loaded identity at import — before AIT_SESSION_ID existed — so it
  // may hold a foreign one (leaked Claude env). Re-resolve under our id: null on
  // a new session, the real handle on a resume.
  reloadIdentity()

  const socketPath = appServerSocketPath(sessionId)
  // When launched via bin/codex-session.sh, the wrapper passes a path here; the
  // launcher writes the socket to it once the app-server is accepting, so the
  // wrapper can attach `codex --remote` in the foreground (one terminal, no
  // separate attach step). Unset when the launcher is run directly.
  const socketFile = process.env.AIT_CODEX_SOCKET_FILE
  let socketAnnounced = false
  const threadParams = {
    cwd: process.cwd(),
    // Hands-off: act on notifications without an operator approving each step.
    approvalPolicy: 'never' as const,
    sandbox: 'workspace-write' as const,
  }

  // The push listener and its registration OUTLIVE individual app-server
  // lifecycles. `deliver` forwards to the current lifecycle's sink through a
  // stable indirection, swapped on each (re)spawn. Notifications that arrive
  // while the app-server is down — or sit un-injected in a dropped sink — replay
  // via the re-register `since` handshake once the next lifecycle registers.
  let activeSink: NotificationSink | null = null
  await startPushListener((view) => activeSink?.(view) ?? Promise.resolve())
  console.error(`\n  Attach a TUI:  codex --remote unix://${socketPath}\n`)
  void registerPushWhenReady()

  // Supervisor: (re)spawn the app-server, run one lifecycle, respawn on crash. A
  // killed app-server re-creates the socket; its own startup lock guards a
  // double-spawn on the same path.
  let sidecar: Sidecar | null = null
  installSignalHandlers(() => sidecar)

  let threadId: string | null = resumeThreadId
  let bootstrapped = false
  let failures = 0

  for (;;) {
    try {
      sidecar = await startSidecar({ socketPath, extraArgs: aitMcpOverrides(sessionId) })
      const client = new AppServerClient(socketPath)
      const closed = new Promise<Error | undefined>((resolve) => client.onClose(resolve))
      await client.connect()

      // First lifecycle honours --session; every respawn resumes the known thread.
      const started = threadId
        ? await client.threadResume({ threadId, ...threadParams })
        : await client.threadStart(threadParams)
      threadId = started.thread.id
      writeThreadSessionId(threadId, sessionId) // idempotent; enables --session rebind
      // Announce the socket + threadId (once) now that a thread is live, so
      // bin/codex-session.sh can `codex resume <threadId> --remote <socket>`
      // straight into THIS thread in the foreground (not a picker or fresh one).
      if (socketFile && !socketAnnounced) {
        fs.writeFileSync(socketFile, `${socketPath}\n${threadId}\n`)
        socketAnnounced = true
      }
      activeSink = createCodexSink(client, threadId)
      console.error(
        `ait codex launcher: session ${sessionId} → thread ${threadId}` +
          (bootstrapped || resumeThreadId ? ' (resumed)' : ''),
      )

      // Bootstrap once, only for a genuinely new session — a resume/respawn is
      // already joined (identity on disk; registerPushWhenReady finds it).
      if (!bootstrapped && !resumeThreadId) {
        await client.turnStart(threadId, BOOTSTRAP_PROMPT)
      }
      bootstrapped = true
      failures = 0

      // Serve until the app-server connection drops, then fall through to respawn.
      const err = await closed
      console.error('ait codex launcher: app-server connection lost — respawning', err ?? '')
    } catch (err) {
      console.error('ait codex launcher: app-server lifecycle failed — respawning', err)
      if (++failures >= MAX_CONSECUTIVE_RESPAWN_FAILURES) {
        console.error(`ait codex launcher: ${failures} consecutive failures — giving up`)
        sidecar?.shutdown()
        process.exit(1)
      }
    }
    activeSink = null
    sidecar?.shutdown()
    await delay(RESPAWN_BACKOFF_MS)
  }
}

// The `-c` overrides that register the ait tool-MCP (poll mode) on the spawned
// app-server, carrying the pre-minted AIT_SESSION_ID in its env — set BEFORE
// thread/start so the frozen-at-spawn env already holds it. Scoped to the ait
// server only (not the app-server subtree). PDS_URL / APPVIEW_DID are forwarded
// when the launcher runs against non-default endpoints so the tool-MCP matches.
function aitMcpOverrides(sessionId: string): string[] {
  const args = [
    '-c', 'mcp_servers.ait.command=node',
    '-c', `mcp_servers.ait.args=${JSON.stringify([AIT_SERVER_PATH])}`,
    '-c', `mcp_servers.ait.env.AIT_SESSION_ID=${sessionId}`,
  ]
  if (process.env.PDS_URL) {
    args.push('-c', `mcp_servers.ait.env.PDS_URL=${process.env.PDS_URL}`)
  }
  if (process.env.APPVIEW_DID) {
    args.push('-c', `mcp_servers.ait.env.APPVIEW_DID=${process.env.APPVIEW_DID}`)
  }
  return args
}

// The resume target — a codex threadId from `--session <threadId>`. Absent means
// a new session. Mirrors `codex resume <id>`; `codex fork` yields a new threadId
// (absent from the map → a fresh handle).
function parseSessionArg(argv: string[]): string | null {
  const i = argv.indexOf('--session')
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}

// Poll shared storage for the identity the tool-MCP mints when the model calls
// `join`. Once present, hydrate the launcher's session and register its push
// listener URL for that DID. appViewCall inside tryRegister self-heals auth from
// the stored password, so a stale JWT snapshot is fine.
async function registerPushWhenReady(): Promise<void> {
  // Wait for the model to join (identity appears in shared storage keyed by
  // AIT_SESSION_ID), then hydrate the launcher's session with it.
  let persisted = loadIdentity()
  while (!persisted) {
    await delay(IDENTITY_POLL_INTERVAL_MS)
    persisted = loadIdentity()
  }
  setIdentity(persisted)
  console.error(`ait codex launcher: @${persisted.handle} joined — registering push target`)

  // Heartbeat the registration. tryRegister swallows failures (a transient
  // AppView 502 must not crash the launcher), so re-assert periodically: the
  // first success registers, and later beats recover from a transient failure or
  // an AppView restart (which drops in-memory push targets). Idempotent on the
  // AppView side (Map<did,url> overwrite by key).
  for (;;) {
    await tryRegister()
    await delay(PUSH_REREGISTER_INTERVAL_MS)
  }
}

// SIGINT/SIGTERM → kill the current sidecar and exit cleanly. Installed once; the
// getter returns whichever sidecar the supervisor loop currently holds.
function installSignalHandlers(getSidecar: () => Sidecar | null): void {
  const shutdown = () => {
    getSidecar()?.shutdown()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
