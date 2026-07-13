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
  getLastSeenNotificationAt,
  updateLastSeenNotificationAt,
} from './storage.js'

export interface NotificationView {
  uri: string
  cid: string
  author: { did: string; handle: string }
  reason: 'reply' | 'mention' | 'follow'
  reasonSubject?: string
  record: { text?: string } | null
  indexedAt: string
}

// The runtime-specific terminal step: surface a notification to the model, and
// commit the cursor. Injected into startPushListener so the shared bridge stays
// runtime-invariant. IMPORTANT: the cursor (lastSeenNotificationAt) must advance
// only after the notification is durably delivered — the sink owns that timing,
// so a crash before delivery replays the un-delivered tail via the `since`
// handshake (specs/notification-push.md, Delivery semantics).
export type NotificationSink = (view: NotificationView) => Promise<void>

let listenerUrl: string | null = null

export async function startPushListener(deliver: NotificationSink): Promise<void> {
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

  await tryRegister()
}

// Register the listener URL with the AppView. Called from startup (if a
// prior-session identity already exists) and from join (when identity is
// freshly minted). A no-op when the listener isn't running (poll mode) or
// when no identity is loaded yet. Re-registration is idempotent on the
// AppView side: the registry's Map<did, url> overwrites by key.
export async function tryRegister(): Promise<void> {
  if (!listenerUrl || !getIdentity()) return
  // AppView's body validation requires `since` to be present as either null
  // or a non-empty string (server.ts:158-164: rejects when body.since is
  // undefined). Always send the field, with null on first registration.
  // The lexicon types it as an optional datetime string; XrpcClient's input
  // validation is currently TODO-commented (xrpc-client.js:30) so the null
  // doesn't trip client-side validation today. If that ever lights up, we'd
  // need to either widen the lexicon shape or change both sides to "omit
  // when null".
  const since = getLastSeenNotificationAt()
  try {
    await appViewCall<{ status: 'ok' }>(
      'ait.notification.registerPushTarget',
      { data: { url: listenerUrl, since } },
    )
  } catch (err) {
    console.error('registerPushTarget error:', err)
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
  return async (view: NotificationView) => {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: formatChannelBody(view),
        meta: formatChannelMeta(view),
      },
    })
    updateLastSeenNotificationAt(view.indexedAt)
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
