// The codex notification sink: turn pushed AIT NotificationViews into
// model-visible codex input. This is the codex analog of push.ts's channelSink —
// it plugs into the same startPushListener(deliver) seam.
//
// Delivery has two paths, and which one runs decides how long a notification
// waits:
//
//   idle thread   → turn/start carrying EVERY pending notification at once.
//   running turn  → turn/steer appends them to the turn already in flight, so
//                   the model reads them during that turn.
//
// Both exist because the earlier design — one turn/start per notification, and
// nothing sent while a turn ran — made arrival time depend on the length of
// whatever was already running. A 84-minute turn with a backlog behind it
// delivered its last notification 89 minutes late, and each notification then
// cost a whole model turn of its own, so the backlog drained one slow turn at a
// time. Batching removes the per-notification turn; steering removes the wait.
//
// Cursor discipline (crash-replay): the opaque AppView cursor advances only
// after the codex turn carrying a notification completes successfully. A
// turn/start or turn/steer response is only an in-memory acceptance ACK;
// committing there loses the notification if app-server dies before execution.

import type { AppServerClient } from './appServerClient.js'
import type { NotificationSink, NotificationView } from '../push.js'
import { updateLastSeenNotificationCursor } from '../storage.js'

// Delay before re-pumping after a hard (non-backoff) failure.
const INJECT_RETRY_DELAY_MS = 3000

// Most notifications carried by a single turn. A backlog of hundreds would
// otherwise build one enormous prompt; the remainder rides the next turn.
const MAX_BATCH = 20

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

// One notification reads as itself; several are numbered under a count, so the
// model can see it is catching up rather than reacting to a single event.
export function formatBatch(views: NotificationView[]): string {
  if (views.length === 1) return formatTurn(views[0])
  const header = `[AIT] ${views.length} notifications arrived:`
  const bodies = views.map((view, i) => `--- ${i + 1} of ${views.length} ---\n${formatTurn(view)}`)
  return [header, ...bodies].join('\n\n')
}

// Build the deliver() sink for one thread. Registers a turn-completion listener
// on the client to drain the queue at each turn boundary.
export function createCodexSink(
  client: AppServerClient,
  threadId: string,
): NotificationSink {
  // Notifications accepted but not yet handed to codex.
  const queue: NotificationView[] = []
  // Notification URIs accepted this process-lifetime, for replay dedup (below).
  const seen = new Set<string>()

  // True while a turn/start or turn/steer call is in flight. Only one at a time,
  // so batches never race each other onto the wire.
  let sending = false
  // Notifications handed to codex and awaiting their turn's completion. More can
  // join `views` while that same turn is still running — that is what lets a
  // second, third, … notification skip the wait rather than only the first.
  let inflight: { turnId: string; views: NotificationView[] } | null = null
  // Completions seen while `sending` was true, before we learned the turn id.
  const earlyCompletions = new Map<string, string | undefined>()

  function finishTurn(turnId: string, status: string | undefined): void {
    if (!inflight || inflight.turnId !== turnId) return
    const delivered = inflight.views
    inflight = null

    if (status === 'completed') {
      // Commit the newest cursor carried by the turn: everything up to it has
      // now been read, and the AppView delivers these in seq order per
      // recipient, so the last one is always the newest.
      const last = delivered[delivered.length - 1]
      if (last) updateLastSeenNotificationCursor(last.cursor)
      void pump()
      return
    }

    // Failed or interrupted is not delivery. Put them back at the FRONT, in
    // order: committing anything later would skip these on crash replay.
    queue.unshift(...delivered)
    setTimeout(() => void pump(), INJECT_RETRY_DELAY_MS)
  }

  // Hand pending notifications to codex. Steers into the running turn when there
  // is one — including a turn this sink already steered into, so a long turn
  // keeps taking new notifications instead of only its first — and otherwise
  // starts a turn.
  async function pump(): Promise<void> {
    // Synchronous, with no await before `sending` is set, so concurrent pump()
    // calls cannot both pass.
    if (sending || queue.length === 0) return

    const runningTurnId = client.activeTurnId(threadId)
    // A batch already awaiting completion can only take more when the turn it
    // rides is still the running one. Otherwise wait: its turn/completed both
    // commits the cursor and re-drives this.
    if (inflight && inflight.turnId !== runningTurnId) return

    const batch = queue.splice(0, MAX_BATCH)
    sending = true
    try {
      const text = formatBatch(batch)
      let turnId: string
      if (runningTurnId) {
        try {
          turnId = await client.turnSteer(threadId, runningTurnId, text)
        } catch (err) {
          // Two ways a steer fails, told apart by whether a turn is STILL
          // running. Gone: it ended mid-call, so start a turn now. Still there:
          // it is a kind that refuses steering (review, compact) — and those
          // refuse turn/start for the same reason, so retrying that here would
          // just fail twice. Wait for the turn to end instead. Neither is a drop.
          if (client.activeTurnId(threadId)) {
            console.error('codex turn refuses steering, waiting for it to end:', err)
            queue.unshift(...batch)
            setTimeout(() => void pump(), INJECT_RETRY_DELAY_MS)
            return
          }
          console.error('codex turn/steer lost its turn, starting one instead:', err)
          turnId = await client.turnStart(threadId, text)
        }
      } else {
        turnId = await client.turnStart(threadId, text)
      }

      if (inflight && inflight.turnId === turnId) inflight.views.push(...batch)
      else inflight = { turnId, views: batch }

      // App-server may emit turn/completed before its response is observed on
      // this client. Reconcile that event now the id is known, and drop the
      // rest: no completion recorded before this turn can still matter.
      const early = earlyCompletions.get(turnId)
      const hadEarly = earlyCompletions.has(turnId)
      earlyCompletions.clear()
      if (hadEarly) finishTurn(turnId, early)
    } catch (err) {
      // Hard failure (not the retried -32001). Return the batch and retry:
      // pump() is otherwise only re-driven by deliver() or turn/completed,
      // neither of which a rejected send produces, so the batch would strand.
      // A send the server accepted but answered malformed replays here, which
      // risks showing it twice — losing it would be worse.
      console.error('codex notification injection failed, retrying shortly:', err)
      queue.unshift(...batch)
      setTimeout(() => void pump(), INJECT_RETRY_DELAY_MS)
    } finally {
      sending = false
    }

    // Anything that arrived during the call, or left over past MAX_BATCH, goes
    // out now if its turn still accepts more.
    void pump()
  }

  client.onTurnCompleted((event) => {
    if (event.threadId !== threadId || !event.turn?.id) return
    const { id, status } = event.turn
    if (sending) {
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
