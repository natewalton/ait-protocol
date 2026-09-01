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
// Resume: `--resume <threadId>` (or the legacy `--session` alias) recovers the
// original AIT handle via the {threadId→UUID} map (threadMap.ts).

import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { AppServerClient } from './appServerClient.js'
import type { InjectItem } from './appServerTypes.js'
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

// "This thread does not exist" from thread/resume. The app-server answers a
// missing rollout with InvalidRequest (-32600) and a message naming the id;
// the code alone is too broad, so both are required.
function isUnknownThread(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('-32600') && /no rollout found/i.test(message)
}

// The display name given to a new session's thread on start (the TUI picker
// title). The on-disk rollout is persisted separately by ROLLOUT_SEED_ITEMS.
const CODEX_THREAD_NAME = 'AIT codex session'
// The one item injected into a new thread to persist its rollout. Model-visible
// for the thread's whole life, so it states one fact and asks for nothing.
const ROLLOUT_SEED_ITEMS: InjectItem[] = [
  {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'Thread opened by the AIT launcher (bin/codex-session.sh).' }],
  },
]

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export async function runCodexSession(): Promise<void> {
  // 1. Resolve the shared AIT_SESSION_ID. `--resume <threadId>` resumes: recover
  //    the UUID minted at that thread's original launch from the {threadId→UUID}
  //    map so the SAME AIT handle rebinds (no orphaning). A new session — or a
  //    resume of an unknown thread (e.g. a `codex fork`) — mints a fresh UUID,
  //    i.e. a new handle.
  const resumeThreadId = parseSessionArg(process.argv)
  // Optional opening turn — mirrors claude-session.sh. A bare launch injects
  // NOTHING (the operator joins by typing `join …` in the attached TUI); an
  // opening prompt passed as an arg — `codex-session.sh "join AIT as @foo and
  // wait"` — is injected as the first turn for a hands-off/autonomous session.
  // Nothing forces a join either way: registerPushWhenReady just waits for one.
  const openingPrompt = parseOpeningPrompt(process.argv)
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
    // Hands-off and unrestricted: AIT sessions are autonomous collaborators,
    // so let Codex write Git metadata, bind loopback listeners, and use the
    // network without pausing for operator approval. Only launch this wrapper
    // in a repository/environment the operator trusts.
    approvalPolicy: 'never' as const,
    sandbox: 'danger-full-access' as const,
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
  let openingTurnDone = false

  // Reconnect supervisor: (re)connect to the shared server, run one connection
  // lifecycle, reconnect on drop. We do NOT own the server (launchd / start-all
  // respawns it), so a lost connection just means "wait and reconnect".
  for (;;) {
    const client = new AppServerClient(socketPath)
    try {
      const closed = new Promise<Error | undefined>((resolve) => client.onClose(resolve))
      await client.connect() // rejects if the shared server isn't accepting yet

      // First lifecycle honours --resume; every reconnect resumes our thread.
      // A resume target that does not exist is permanent — the reconnect loop
      // below would otherwise retry it forever, reporting "not connected to
      // shared app-server" every two seconds while the real fault is the id the
      // operator typed. Fail fast on the first attempt instead, and only there:
      // once we have run a lifecycle, the same error means the rollout vanished
      // under a live session, which reconnecting can still recover from.
      const firstAttempt = !openingTurnDone && threadId === resumeThreadId
      let started
      if (threadId) {
        try {
          started = await client.threadResume({ threadId, ...threadParams })
        } catch (err) {
          if (firstAttempt && isUnknownThread(err)) {
            console.error(
              `ait codex session: no codex thread ${threadId}. Check the id, or ` +
                `launch without --resume to start a new session.`,
            )
            process.exit(1)
          }
          throw err
        }
      } else {
        started = await client.threadStart(threadParams)
      }
      threadId = started.thread.id
      writeThreadSessionId(threadId, sessionId) // idempotent; enables --session rebind
      // New session: create the on-disk rollout the TUI attaches to (a bare
      // thread/start writes none) — BEFORE announcing, so the wrapper's `codex
      // resume <threadId>` finds a rollout. thread/name/set used to be enough;
      // codex-cli 0.152 (paginated history) records the name in its state DB
      // without writing the rollout, and the TUI then fails to resume with
      // "missing source rollout". thread/inject_items with one developer note is
      // the lightest write that still persists it, and runs no model turn. (On
      // 0.144.4 inject left a dangling `auto-compact-0` turn_context that the TUI
      // showed as a phantom "Working" spinner; verified gone on 0.152.) No
      // orientation is injected: the operator controls how the session engages —
      // joining by typing in the TUI — rather than the model being auto-oriented
      // on attach. (The per-thread ait tool-MCP runs poll mode, which ships no
      // `instructions`, so there's no MCP-level orientation either.)
      if (!openingTurnDone && !resumeThreadId) {
        try {
          await client.setName(threadId, CODEX_THREAD_NAME)
          await client.injectItems(threadId, ROLLOUT_SEED_ITEMS)
        } catch (err) {
          // The seed did not land, so this thread has no rollout. Forget it: the
          // retry below would otherwise thread/resume a rollout-less id forever
          // ("no rollout found") instead of starting a fresh thread.
          threadId = null
          throw err
        }
      }
      if (socketFile && !socketAnnounced) {
        fs.writeFileSync(socketFile, `${socketPath}\n${threadId}\n`)
        socketAnnounced = true
      }
      activeSink = createCodexSink(client, threadId)
      console.error(
        `ait codex session: session ${sessionId} → thread ${threadId}` +
          (openingTurnDone || resumeThreadId ? ' (resumed)' : ''),
      )

      // Inject the opening prompt once, only for a genuinely new session that was
      // given one — a resume/reconnect is already going, and a bare launch leaves
      // the operator to drive from the TUI.
      if (!openingTurnDone && !resumeThreadId && openingPrompt) {
        await client.turnStart(threadId, openingPrompt)
      }
      openingTurnDone = true

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

// The resume target — a codex threadId from `--resume <threadId>` (with
// `--session` retained as an alias). Absent means a new session. Mirrors `codex
// resume <id>`; `codex fork` yields a new threadId (absent from the map → a
// fresh handle).
function parseSessionArg(argv: string[]): string | null {
  const i = argv.findIndex((arg) => arg === '--resume' || arg === '--session')
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}

// The opening prompt — the positional args (everything that isn't a resume
// selector), joined. Null when none were passed, so a bare launch injects no turn
// and the operator drives from the TUI.
function parseOpeningPrompt(argv: string[]): string | null {
  const args = argv.slice(2) // drop node + script path
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' || args[i] === '--session') {
      i++ // skip the flag AND its value
      continue
    }
    positional.push(args[i])
  }
  const prompt = positional.join(' ').trim()
  return prompt.length > 0 ? prompt : null
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
