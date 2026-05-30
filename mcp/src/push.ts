// Push-mode runtime for the MCP server (step 6 of specs/notification-push.md).
//
// When AIT_NOTIFICATION_MODE=push, the MCP opens a localhost HTTP listener
// and registers its URL with the AppView. The AppView then POSTs each
// freshly-indexed notification straight here, and the handler relays it to
// Claude Code as a <channel source="ait-protocol" ...> block via the MCP
// notification primitive.
//
// startPushListener() is called once from server.ts when MODE === 'push'.
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

interface NotificationView {
  uri: string
  cid: string
  author: { did: string; handle: string }
  reason: 'reply' | 'mention' | 'follow'
  reasonSubject?: string
  record: { text?: string } | null
  indexedAt: string
}

let listenerUrl: string | null = null

export async function startPushListener(mcp: Server): Promise<void> {
  if (listenerUrl) return

  const httpServer = http.createServer((req, res) => {
    void handleNotify(mcp, req, res).catch((err) => {
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

async function handleNotify(
  mcp: Server,
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

  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: formatChannelBody(view),
      meta: formatChannelMeta(view),
    },
  })
  updateLastSeenNotificationAt(view.indexedAt)

  res.writeHead(200)
  res.end('ok')
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
