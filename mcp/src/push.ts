// Push delivery bridge for the MCP server (step 6 of specs/notification-push.md).
//
// When AIT_NOTIFICATION_MODE=push, the MCP opens a localhost HTTP listener and
// registers its URL with the AppView. The AppView then POSTs each freshly-
// indexed notification straight here. The listener bind, registration + `since`
// replay, and NotificationView parse are runtime-invariant; the terminal step —
// how a notification becomes model-visible, and when the cursor commits — is an
// injected deliver() sink. The Claude push path passes channelSink(), which
// emits a <channel source="ait-protocol" ...> block via the MCP notification
// primitive; codex mode (specs/notification-codex.md) passes a sink that turns
// each notification into a codex turn/start. Same bridge, different sink.
//
// startPushListener(deliver) is called once from server.ts when MODE === 'push'.
// tryRegister() is also called from the join tool after setIdentity, so a
// brand-new session (no identity at MCP startup) registers as soon as one
// is minted. Both calls are safe in poll mode — tryRegister early-exits
// when the listener isn't running.

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { appViewCall } from './atproto/pdsClient.js'
import { getIdentity } from './session.js'
import {
  compareAndSwapNotificationCursor,
  getNotificationRegistrationCheckpoint,
  updateLastSeenNotificationCursor,
} from './storage.js'

export interface NotificationView {
  uri: string
  cid: string
  author: { did: string; handle: string }
  reason: 'reply' | 'mention' | 'follow'
  reasonSubject?: string
  record: { text?: string } | null
  indexedAt: string
  cursor: string
}

// Surfaces a notification to the model and commits the cursor. The sink owns
// commit timing: the cursor must advance only after that runtime's delivery
// signal, so a crash before delivery replays the tail on re-registration.
export type NotificationSink = (view: NotificationView) => Promise<void>

const REREGISTER_INTERVAL_MS = 30_000
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

let listenerUrl: string | null = null
let registerInFlight: Promise<void> | null = null

export async function startPushListener(
  deliver: NotificationSink,
  canRegister: () => boolean = () => true,
): Promise<void> {
  if (listenerUrl) return

  const httpServer = http.createServer((req, res) => {
    void handleNotify(deliver, req, res).catch((err) => {
      console.error('notify handler error:', err)
      if (!res.headersSent) {
        res.writeHead(500)
        res.end()
      }
    })
  })

  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', resolve),
  )
  const addr = httpServer.address() as AddressInfo
  listenerUrl = `http://127.0.0.1:${addr.port}/notify`
  // Visible on the MCP's stderr (Claude Code's debug log) so a paired-up
  // smoke test or operator can find the ephemeral port without spelunking
  // /proc or lsof. Harmless in production — stderr isn't user-facing.
  console.error(`ait push listener: ${listenerUrl}`)

  if (canRegister()) await tryRegister(canRegister)

  // AppView registrations are in-memory and are deleted on restart or one
  // failed POST. Reassert for the listener lifetime; tryRegister coalesces a
  // beat with any startup/join registration already in flight.
  void (async () => {
    for (;;) {
      await delay(REREGISTER_INTERVAL_MS)
      if (canRegister()) await tryRegister(canRegister)
    }
  })()
}

// Register the listener URL with the AppView. Called from startup (if a
// prior-session identity already exists) and from join (when identity is
// freshly minted). A no-op when the listener isn't running (poll mode) or
// when no identity is loaded yet. Re-registration is idempotent on the
// AppView side: the registry's Map<did, url> overwrites by key.
export async function tryRegister(canRegister: () => boolean = () => true): Promise<void> {
  if (!canRegister()) return
  if (!listenerUrl || !getIdentity()) return
  if (registerInFlight) return registerInFlight
  registerInFlight = (async () => {
    const checkpoint = getNotificationRegistrationCheckpoint()
    const data: { url: string; cursor?: string; since?: string } = {
      url: listenerUrl as string,
    }
    if (checkpoint.kind === 'cursor') data.cursor = checkpoint.value
    if (checkpoint.kind === 'since') data.since = checkpoint.value
    try {
      const result = await appViewCall<{ status: 'ok'; cursor: string }>(
        'ait.notification.registerPushTarget',
        { data },
      )
      // AppView returns the normalized starting cursor: for legacy `since` this
      // is its loss-safe seq predecessor; for a fresh identity it is the initial
      // baseline. Do not overwrite a cursor advanced by concurrent live delivery.
      compareAndSwapNotificationCursor(checkpoint.value, result.cursor)
    } catch (err) {
      console.error('registerPushTarget error:', err)
    }
  })()
  try {
    await registerInFlight
  } finally {
    registerInFlight = null
  }
}

// Shared bridge: validate the request, parse the NotificationView, hand it to
// the injected sink. The sink owns model-surfacing and cursor-commit timing.
async function handleNotify(
  deliver: NotificationSink,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/notify') {
    res.writeHead(404)
    res.end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  const view = JSON.parse(
    Buffer.concat(chunks).toString('utf8'),
  ) as NotificationView

  await deliver(view)

  res.writeHead(200)
  res.end('ok')
}

// The Claude push sink: emit the notification as a <channel> block via the MCP
// notification primitive, then advance the cursor. This is today's handleNotify
// terminal behavior, moved intact — the cursor advances synchronously right
// after the channel is emitted, exactly as before.
export function channelSink(mcp: Server): NotificationSink {
  const seen = new Set<string>()
  return async (view: NotificationView) => {
    if (seen.has(view.uri)) return
    seen.add(view.uri)
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: formatChannelBody(view),
          meta: formatChannelMeta(view),
        },
      })
      updateLastSeenNotificationCursor(view.cursor)
    } catch (err) {
      // A failed sink call makes /notify return 500 and AppView drop the
      // registration. Let heartbeat replay retry in this same process.
      seen.delete(view.uri)
      throw err
    }
  }
}

function formatChannelBody(n: NotificationView): string {
  if (n.reason === 'follow') return 'followed you'
  return n.record?.text ?? ''
}

function formatChannelMeta(n: NotificationView): Record<string, string> {
  const meta: Record<string, string> = {
    reason: n.reason,
    author: n.author.handle ? `@${n.author.handle}` : n.author.did,
    indexed_at: n.indexedAt,
    uri: n.uri,
  }
  if (n.reasonSubject) meta.in_reply_to = n.reasonSubject
  return meta
}
