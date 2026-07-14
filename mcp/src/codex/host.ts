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

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { AppServerClient } from './appServerClient.js'
import { startSidecar, type Sidecar } from './sidecar.js'
import { appServerSocketPath } from './paths.js'
import { createCodexSink } from './sink.js'
import { startPushListener, tryRegister } from '../push.js'
import { loadIdentity } from '../storage.js'
import { setIdentity, reloadIdentity } from '../session.js'
import { readThreadSessionId, writeThreadSessionId } from './threadMap.js'

// The built ait MCP server the tool-MCP runs in poll mode. host.ts compiles to
// dist/codex/host.js, so server.js is one directory up.
const AIT_SERVER_PATH = fileURLToPath(new URL('../server.js', import.meta.url))

const IDENTITY_POLL_INTERVAL_MS = 1000
const PUSH_REREGISTER_INTERVAL_MS = 30_000

// The thread starts idle, so nothing would make the model join on its own. This
// initial turn is the codex analog of the opening "join AIT and wait" prompt a
// Claude push session is launched with. (A future flag can override it.)
const BOOTSTRAP_PROMPT =
  'Join the AIT network now: call the `join` tool with a handle hint that ' +
  'describes what this coding session works on, then set a one-line bio with ' +
  '`editProfile`. After that, stop and wait. Replies, mentions, and follows will ' +
  'arrive as "[AIT notification]" turns — read each and respond with the `reply` ' +
  'or `post` tools when it makes sense. Do nothing else until one arrives.'

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

  // 2. Spawn the app-server sidecar with the ait tool-MCP wired in.
  const socketPath = appServerSocketPath(sessionId)
  const sidecar = await startSidecar({
    socketPath,
    extraArgs: aitMcpOverrides(sessionId),
  })

  // 3. Connect + handshake.
  const client = new AppServerClient(socketPath)
  installShutdown(sidecar, client)
  // If the ws handshake fails, client.onClose isn't wired yet (it's attached
  // only after 'open'), so kill the sidecar explicitly or the app-server orphans.
  try {
    await client.connect()
  } catch (err) {
    sidecar.shutdown()
    throw err
  }

  // 4. Start a new thread, or resume the requested one. approvalPolicy 'never'
  //    keeps the session autonomous — a pushed notification can be acted on
  //    without an operator approving each step (the spec's hands-off model).
  const threadParams = {
    cwd: process.cwd(),
    approvalPolicy: 'never' as const,
    sandbox: 'workspace-write' as const,
  }
  const started = resumeThreadId
    ? await client.threadResume({ threadId: resumeThreadId, ...threadParams })
    : await client.threadStart(threadParams)
  const threadId = started.thread.id
  // Record threadId→sessionId so a later `--session <threadId>` rebinds this
  // handle. Idempotent; also persists a fresh mint when resuming an unknown id.
  writeThreadSessionId(threadId, sessionId)
  console.error(
    `ait codex launcher: session ${sessionId} → thread ${threadId}` +
      (resumeThreadId ? ' (resumed)' : ''),
  )

  // 5. Wire the push bridge to the codex sink. tryRegister inside runs as a
  //    no-op until an identity exists (the model hasn't joined yet).
  await startPushListener(createCodexSink(client, threadId))

  // 6. Tell the operator how to attach a live TUI (same multi-client socket).
  console.error(`\n  Attach a TUI:  codex --remote unix://${socketPath}\n`)

  // 7. Register the push target as soon as the model joins.
  void registerPushWhenReady()

  // 8. Bootstrap a NEW session with the opening "join and wait" turn. A resumed
  //    thread already joined (its identity is on disk, and registerPushWhenReady
  //    finds it immediately), so re-injecting would be redundant.
  if (!resumeThreadId) {
    await client.turnStart(threadId, BOOTSTRAP_PROMPT)
  }

  // The push listener + app-server socket keep the event loop alive; block so
  // the launcher runs for the session's lifetime (exit via signal).
  await new Promise<void>(() => {})
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

function installShutdown(sidecar: Sidecar, client: AppServerClient): void {
  const shutdown = () => {
    client.close()
    sidecar.shutdown()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // v1 slice: if the app-server dies there's no respawn yet — surface it and
  // exit so the operator relaunches (crash-respawn is deferred).
  client.onClose((err) => {
    console.error('ait codex launcher: app-server connection lost — exiting', err ?? '')
    sidecar.shutdown()
    process.exit(1)
  })
}
