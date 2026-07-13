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
  // True from when we issue a turn/start until its turn/completed. Covers the
  // window between turnStart resolving and the turn/started event, during which
  // isTurnActive() still reads false — without it we'd inject a second turn.
  let pendingInjection = false

  async function pump(): Promise<void> {
    // All three guards are synchronous (no await before pendingInjection is
    // set), so concurrent pump() calls can't both pass — injections serialize.
    if (pendingInjection || queue.length === 0) return
    if (client.isTurnActive(threadId)) return // a turn (ours or operator's) is running

    pendingInjection = true
    const view = queue[0]
    try {
      await client.turnStart(threadId, formatTurn(view))
      queue.shift()
      updateLastSeenNotificationAt(view.indexedAt) // advance only on success
      // Keep pendingInjection = true until this turn's turn/completed; the
      // listener below clears it and pumps the next item.
    } catch (err) {
      // Hard failure (not the retried -32001). Leave the view queued and free
      // the gate so the next boundary retries it.
      console.error('codex turn injection failed, will retry:', err)
      pendingInjection = false
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
    queue.push(view)
    void pump()
  }
}
