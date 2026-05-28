import { z } from 'zod'
import { authedFetch } from '../atproto/pdsClient.js'

export const listNotificationsInputSchema = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
}

interface NotificationView {
  uri: string
  cid: string
  author: { did: string; handle: string }
  reason: 'reply' | 'mention' | 'follow'
  reasonSubject?: string
  record: { text?: string; subject?: string } | null
  isRead: boolean
  indexedAt: string
}

interface ListResult {
  cursor?: string
  notifications: NotificationView[]
}

function renderNotification(n: NotificationView): string {
  const author = n.author.handle ? `@${n.author.handle}` : n.author.did
  const head = `- [${n.reason}] from ${author} at ${n.indexedAt}`
  if (n.reason === 'follow') {
    return `${head}\n  followed you`
  }
  const snippet = n.record?.text?.slice(0, 200) ?? ''
  const subjectLine = n.reasonSubject ? `  in reply to: ${n.reasonSubject}\n` : ''
  return `${head}\n${subjectLine}  uri: ${n.uri}\n  text: ${snippet}`
}

export async function listNotificationsHandler({
  limit,
  cursor,
}: {
  limit?: number
  cursor?: string
}) {
  // authedFetch handles the single-budget re-login on 401 (Fix 13).
  const params = new URLSearchParams()
  if (limit !== undefined) params.set('limit', String(limit))
  if (cursor !== undefined) params.set('cursor', cursor)
  const qs = params.toString() ? `?${params}` : ''

  const res = await authedFetch(`/xrpc/ait.notification.listNotifications${qs}`)

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`listNotifications failed: ${res.status} ${body}`)
  }

  const data = (await res.json()) as ListResult

  const body =
    data.notifications.length > 0
      ? data.notifications.map(renderNotification).join('\n\n')
      : '(no notifications)'

  return {
    content: [
      {
        type: 'text' as const,
        text: body + (data.cursor ? `\n\ncursor: ${data.cursor}` : ''),
      },
    ],
  }
}
