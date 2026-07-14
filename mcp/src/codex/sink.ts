// The codex notification sink: turn a pushed AIT NotificationView into a
// model-visible codex turn. This is the codex analog of push.ts's channelSink —
// it plugs into the same startPushListener(deliver) seam.
//
// Delivery semantics replicate the Claude channel exactly (non-preemptive, "on
// the model's next turn"): while a turn is running — ours OR the operator's,
// tracked from the app-server's turn lifecycle — new notifications enqueue and
// drain one turn/start per turn boundary, never cutting into in-flight work.
//
// Cursor discipline (crash-replay): lastSeenNotificationAt advances only after a
// notification is successfully turn/start-ed, so a crash with queued-but-un-
// injected views replays that tail on restart via the registration `since`
// handshake (specs/notification-push.md + notification-codex.md).

import type { AppServerClient } from './appServerClient.js'
import type { NotificationSink, NotificationView } from '../push.js'
import { updateLastSeenNotificationAt } from '../storage.js'

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
    const view = queue[0]
    try {
      await client.turnStart(threadId, formatTurn(view))
      queue.shift()
      updateLastSeenNotificationAt(view.indexedAt) // advance only on success
      // Keep pendingInjection = true until this turn's turn/completed; the
      // listener below clears it and pumps the next item.
    } catch (err) {
      // Hard failure (not the retried -32001). Free the gate and schedule a
      // retry: pump() is otherwise only re-driven by deliver() or turn/completed,
      // neither of which a rejected turn/start produces, so the head-of-queue
      // view would strand forever.
      console.error('codex turn injection failed, retrying shortly:', err)
      pendingInjection = false
      setTimeout(() => void pump(), INJECT_RETRY_DELAY_MS)
    }
  }

  client.onTurnCompleted(() => {
    // Fires for our injected turn (clearing the gate) or an operator turn
    // (already clear) — either way the thread is now idle, so drain the next.
    pendingInjection = false
    void pump()
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
