// The codex notification sink: turn a pushed AIT NotificationView into a
// model-visible codex turn. This is the codex analog of push.ts's channelSink —
// it plugs into the same startPushListener(deliver) seam.
//
// Delivery semantics replicate the Claude channel exactly (non-preemptive, "on
// the model's next turn"): while a turn is running — ours OR the operator's,
// tracked from the app-server's turn lifecycle — new notifications enqueue and
// drain one turn/start per turn boundary, never cutting into in-flight work.
//
// Cursor discipline (crash-replay): the opaque AppView cursor advances only
// after the matching Codex turn completes successfully. A turn/start response
// is only an in-memory acceptance ACK; committing there loses the notification
// if app-server dies before execution.

import type { AppServerClient } from './appServerClient.js'
import type { NotificationSink, NotificationView } from '../push.js'
import { updateLastSeenNotificationCursor } from '../storage.js'

// Delay before re-pumping after a hard (non-backoff) turn/start failure.
const INJECT_RETRY_DELAY_MS = 3000

// Render a NotificationView as the plain-text user turn the model reads. Codex
// has no <channel> XML convention, so the metadata (reason, author, uri,
// in_reply_to) rides in the body — the model needs it to decide how to act.
export function formatTurn(view: NotificationView): string {
  const author = view.author.handle ? `@${view.author.handle}` : view.author.did
  const metaParts = [
    `reason=${view.reason}`,
    `uri=${view.uri}`,
    `indexed_at=${view.indexedAt}`,
  ]
  if (view.reasonSubject) metaParts.push(`in_reply_to=${view.reasonSubject}`)
  const meta = `(${metaParts.join(', ')})`

  if (view.reason === 'follow') {
    return `[AIT notification] ${author} followed you.\n\n${meta}`
  }
  const verb = view.reason === 'reply' ? 'replied to your post' : 'mentioned you'
  const text = view.record?.text ?? ''
  const quoted = text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `[AIT notification] ${author} ${verb}:\n${quoted}\n\n${meta}`
}

// Build the deliver() sink for one thread. Registers a turn-completion listener
// on the client to drain the queue at each turn boundary.
export function createCodexSink(
  client: AppServerClient,
  threadId: string,
): NotificationSink {
  const queue: NotificationView[] = []
  // Notification URIs accepted this process-lifetime, for replay dedup (below).
  const seen = new Set<string>()
  // True from when we issue a turn/start until its turn/completed. Covers the
  // window between turnStart resolving and the turn/started event, during which
  // isTurnActive() still reads false — without it we'd inject a second turn.
  let pendingInjection = false
  let pendingTurnId: string | null = null
  const earlyCompletions = new Map<string, string | undefined>()

  function finishTurn(turnId: string, status: string | undefined): void {
    if (!pendingInjection || pendingTurnId !== turnId) return
    pendingTurnId = null
    if (status === 'completed') {
      const view = queue.shift()
      if (view) updateLastSeenNotificationCursor(view.cursor)
      pendingInjection = false
      void pump()
      return
    }

    // Failed/interrupted is not delivery. Keep the head in place: allowing a
    // later item to commit would skip this notification on crash replay.
    pendingInjection = false
    setTimeout(() => void pump(), INJECT_RETRY_DELAY_MS)
  }

  async function pump(): Promise<void> {
    // All three guards are synchronous (no await before pendingInjection is
    // set), so concurrent pump() calls can't both pass — injections serialize.
    if (pendingInjection || queue.length === 0) return
    // Only turns WE injected — turn notifications route to the initiator, so the
    // launcher's client never sees an operator (attached TUI) turn. Those are
    // serialized by the app-server's own turn queue (a turn/start during an
    // operator turn enqueues, non-preemptive), so we needn't track them here.
    if (client.isTurnActive(threadId)) return

    pendingInjection = true
    pendingTurnId = null
    const view = queue[0]
    try {
      const turnId = await client.turnStart(threadId, formatTurn(view))
      pendingTurnId = turnId
      // App-server may emit turn/completed before its turn/start response is
      // observed on this client. Reconcile that event after learning the id.
      if (earlyCompletions.has(turnId)) {
        const status = earlyCompletions.get(turnId)
        earlyCompletions.delete(turnId)
        finishTurn(turnId, status)
      }
    } catch (err) {
      // Hard failure (not the retried -32001). Free the gate and schedule a
      // retry: pump() is otherwise only re-driven by deliver() or turn/completed,
      // neither of which a rejected turn/start produces, so the head-of-queue
      // view would strand forever.
      console.error('codex turn injection failed, retrying shortly:', err)
      pendingInjection = false
      pendingTurnId = null
      setTimeout(() => void pump(), INJECT_RETRY_DELAY_MS)
    }
  }

  client.onTurnCompleted((event) => {
    if (event.threadId !== threadId || !event.turn?.id) return
    const { id, status } = event.turn
    if (pendingInjection && pendingTurnId === null) {
      earlyCompletions.set(id, status)
      return
    }
    finishTurn(id, status)
  })

  // Enqueue and return immediately: the AppView's POST must not block on a
  // running turn. Injection + cursor-advance happen asynchronously in pump().
  return async (view: NotificationView) => {
    // Dedup by uri: the registration `since` replay (re-register heartbeat, or
    // post-crash catch-up) re-POSTs notifications whose cursor hasn't advanced.
    // Skipping URIs already accepted this process-lifetime prevents double-
    // injection; a genuine crash resets `seen`, so real catch-up still delivers.
    if (seen.has(view.uri)) return
    seen.add(view.uri)
    queue.push(view)
    void pump()
  }
}
