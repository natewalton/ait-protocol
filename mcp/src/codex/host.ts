// The codex-mode session process (AIT_NOTIFICATION_MODE=codex).
//
// Unlike poll/push — where the ait server is a stdio MCP a host loads — in codex
// mode this process is a per-session DRIVER: it connects to the SHARED
// `codex app-server` (one per host, started at boot by launchd /
// bin/start-all.sh — it is NOT spawned here), opens this session's own thread on
// it, and injects each AIT notification as a turn. server.ts branches main() here
// before server.connect().
//
// One shared server hosts N sessions, each its own AIT identity: the per-thread
// `config` passed to thread/start sets that thread's ait tool-MCP env
// (AIT_SESSION_ID), so codex spawns a tool-MCP per thread with this session's id
// and each mints a distinct handle (verified against codex-cli 0.144.3). The
// shared server only registers the ait MCP's command/args; identity is always
// per-thread.
//
// Pieces stitched together:
//   1. Pre-mint AIT_SESSION_ID (a UUID) — the shared identity key for this
//      session's tools AND pushes (specs/notification-codex.md, Identity).
//   2. Connect to the shared app-server; thread/start with per-thread config so
//      this thread's tool-MCP carries the pre-minted id.
//   3. Wire the push listener (reused from push.ts) to the codex sink, so each
//      AIT notification becomes a codex turn/start on this thread.
//   4. Once the model joins (the tool-MCP mints the handle into shared storage
//      keyed by AIT_SESSION_ID), load it and register the push target.
//
// Resilience: this process outlives any single app-server lifecycle. If the
// shared server bounces, the connection drops; we reconnect (the server's
// respawn is owned by launchd / start-all, not us), thread/resume our thread, and
// the push re-registration replays anything missed via the `since` handshake —
// scoped to THIS session's DID (per-DID cursor + AppView DID filter), so a bounce
// never replays another session's notifications.
//
// Resume: `--session <threadId>` recovers the original AIT handle via the
// {threadId→UUID} map (threadMap.ts).

import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { AppServerClient } from './appServerClient.js'
import { sharedAppServerSocketPath } from './paths.js'
import { createCodexSink } from './sink.js'
import { startPushListener, tryRegister, type NotificationSink } from '../push.js'
import { loadIdentity } from '../storage.js'
import { setIdentity, reloadIdentity } from '../session.js'
import { readThreadSessionId, writeThreadSessionId } from './threadMap.js'

const IDENTITY_POLL_INTERVAL_MS = 1000
const PUSH_REREGISTER_INTERVAL_MS = 30_000
// Delay between connection attempts to the shared server. We never give up: a
// session waits for its server across a launchd restart or a not-yet-started
// server, and an always-present backoff keeps a fast-failing lifecycle from
// spinning hot.
const RECONNECT_BACKOFF_MS = 2000

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

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export async function runCodexSession(): Promise<void> {
  // 1. Resolve the shared AIT_SESSION_ID. `--session <threadId>` resumes: recover
  //    the UUID minted at that thread's original launch from the {threadId→UUID}
  //    map so the SAME AIT handle rebinds (no orphaning). A new session — or a
  //    resume of an unknown thread (e.g. a `codex fork`) — mints a fresh UUID,
  //    i.e. a new handle.
  const resumeThreadId = parseSessionArg(process.argv)
  const sessionId =
    (resumeThreadId ? readThreadSessionId(resumeThreadId) : null) ?? randomUUID()
  process.env.AIT_SESSION_ID = sessionId
  // session.ts loaded identity at import — before AIT_SESSION_ID existed — so it
  // may hold a foreign one (leaked Claude env). Re-resolve under our id: null on
  // a new session, the real handle on a resume.
  reloadIdentity()

  const socketPath = sharedAppServerSocketPath()
  // When launched via bin/codex-session.sh, the wrapper passes a path here; we
  // write the socket + threadId to it once our thread is live, so the wrapper can
  // attach `codex resume <threadId> --remote <socket>` in the foreground (one
  // terminal). Unset when the session process is run directly.
  const socketFile = process.env.AIT_CODEX_SOCKET_FILE
  let socketAnnounced = false
  const threadParams = {
    cwd: process.cwd(),
    // Hands-off: act on notifications without an operator approving each step.
    approvalPolicy: 'never' as const,
    sandbox: 'workspace-write' as const,
    // Per-thread identity: this thread's ait tool-MCP is spawned with our id.
    config: threadConfig(sessionId),
  }

  // The push listener and its registration OUTLIVE individual app-server
  // connections. `deliver` forwards to the current connection's sink through a
  // stable indirection, swapped on each (re)connect. Notifications that arrive
  // while the server is down — or sit un-injected in a dropped sink — replay via
  // the re-register `since` handshake once we reconnect and re-register.
  let activeSink: NotificationSink | null = null
  await startPushListener((view) => activeSink?.(view) ?? Promise.resolve())
  console.error(`\n  Attach a TUI:  codex --remote unix://${socketPath}\n`)
  void registerPushWhenReady()

  installSignalHandlers()

  let threadId: string | null = resumeThreadId
  let bootstrapped = false

  // Reconnect supervisor: (re)connect to the shared server, run one connection
  // lifecycle, reconnect on drop. We do NOT own the server (launchd / start-all
  // respawns it), so a lost connection just means "wait and reconnect".
  for (;;) {
    const client = new AppServerClient(socketPath)
    try {
      const closed = new Promise<Error | undefined>((resolve) => client.onClose(resolve))
      await client.connect() // rejects if the shared server isn't accepting yet

      // First lifecycle honours --session; every reconnect resumes our thread.
      const started = threadId
        ? await client.threadResume({ threadId, ...threadParams })
        : await client.threadStart(threadParams)
      threadId = started.thread.id
      writeThreadSessionId(threadId, sessionId) // idempotent; enables --session rebind
      if (socketFile && !socketAnnounced) {
        fs.writeFileSync(socketFile, `${socketPath}\n${threadId}\n`)
        socketAnnounced = true
      }
      activeSink = createCodexSink(client, threadId)
      console.error(
        `ait codex session: session ${sessionId} → thread ${threadId}` +
          (bootstrapped || resumeThreadId ? ' (resumed)' : ''),
      )

      // Bootstrap once, only for a genuinely new session — a resume/reconnect is
      // already joined (identity on disk; registerPushWhenReady finds it).
      if (!bootstrapped && !resumeThreadId) {
        await client.turnStart(threadId, BOOTSTRAP_PROMPT)
      }
      bootstrapped = true

      // Serve until the connection drops, then fall through to reconnect.
      const err = await closed
      console.error('ait codex session: shared app-server connection lost — reconnecting', err ?? '')
    } catch (err) {
      // Server not up yet, or the lifecycle failed mid-flight. Wait and retry.
      console.error('ait codex session: not connected to shared app-server, retrying —', errMessage(err))
    }
    activeSink = null
    client.close()
    await delay(RECONNECT_BACKOFF_MS)
  }
}

// The per-thread `config` for thread/start — sets THIS thread's ait tool-MCP env
// so the tool-MCP mints/loads this session's handle. AIT_SESSION_ID is the
// identity key; PDS_URL / APPVIEW_DID are forwarded when the session runs against
// non-default endpoints so the tool-MCP matches. The shared server registers the
// ait MCP's command/args (see bin/run-codex-appserver.sh); only env is per-thread.
function threadConfig(sessionId: string): Record<string, string> {
  const config: Record<string, string> = {
    'mcp_servers.ait.env.AIT_SESSION_ID': sessionId,
  }
  if (process.env.PDS_URL) {
    config['mcp_servers.ait.env.PDS_URL'] = process.env.PDS_URL
  }
  if (process.env.APPVIEW_DID) {
    config['mcp_servers.ait.env.APPVIEW_DID'] = process.env.APPVIEW_DID
  }
  return config
}

// The resume target — a codex threadId from `--session <threadId>`. Absent means
// a new session. Mirrors `codex resume <id>`; `codex fork` yields a new threadId
// (absent from the map → a fresh handle).
function parseSessionArg(argv: string[]): string | null {
  const i = argv.indexOf('--session')
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}

// Poll shared storage for the identity the tool-MCP mints when the model calls
// `join`. Once present, hydrate this session and register its push listener URL
// for that DID. appViewCall inside tryRegister self-heals auth from the stored
// password, so a stale JWT snapshot is fine.
async function registerPushWhenReady(): Promise<void> {
  // Wait for the model to join (identity appears in shared storage keyed by
  // AIT_SESSION_ID), then hydrate this session with it.
  let persisted = loadIdentity()
  while (!persisted) {
    await delay(IDENTITY_POLL_INTERVAL_MS)
    persisted = loadIdentity()
  }
  setIdentity(persisted)
  console.error(`ait codex session: @${persisted.handle} joined — registering push target`)

  // Heartbeat the registration. tryRegister swallows failures (a transient
  // AppView 502 must not crash the session), so re-assert periodically: the first
  // success registers, and later beats recover from a transient failure or an
  // AppView restart (which drops in-memory push targets). Registration is
  // per-DID, so this only ever (re)registers THIS session — never another's.
  for (;;) {
    await tryRegister()
    await delay(PUSH_REREGISTER_INTERVAL_MS)
  }
}

// SIGINT/SIGTERM → exit cleanly. Unlike the old per-session sidecar, we do NOT
// shut down the app-server here — it is shared and owned by launchd / start-all,
// and other sessions may still be using it. Exiting just detaches this session;
// the OS closes our socket fd.
function installSignalHandlers(): void {
  const shutdown = () => process.exit(0)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
