// Per-DID push registry for the notification-push spec.
//
// MCPs running in `push` mode call ait.notification.registerPushTarget at
// startup with a localhost callback URL. The AppView records the URL,
// replays any notifications written while the MCP was detached, and POSTs
// each subsequent insertNotification fire-and-forget to the registered URL.
// On any POST failure the registration is dropped — the next MCP startup
// re-registers with a fresh cursor.
//
// State is in-memory only. AppView restart clears the registry; MCPs
// re-register on their next tool call or scheduled heartbeat.

import type { IdResolver } from '@atproto/identity'
import { createDeferrable } from '@atproto/common'
import { MemoryRunner } from '@atproto/sync'
import type { Db } from './db.js'
import {
  getNotificationByKey,
  getNotificationsAfterSeq,
  type NotificationView,
} from './queries/listNotifications.js'

const registry = new Map<string, string>()
// Separate from the firehose runner: firehose partitions by author DID, while
// delivery partitions by recipient DID. addTask gives each recipient one
// ordered stream without hand-rolling a keyed queue.
const deliveryRunner = new MemoryRunner()

const PUSH_TIMEOUT_MS = 5_000

// Localhost-only by design (spec): the MCP listener binds 127.0.0.1:0, so
// the AppView never POSTs across the network. Hostnames like 'localhost' or
// '[::1]' are rejected to keep the rule mechanical rather than DNS-dependent.
export function isValidPushUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return url.protocol === 'http:' && url.hostname === '127.0.0.1'
}

// Register a DID → URL binding and replay notifications after the opaque
// cursor's decoded seq (oldest first). On the first POST failure during
// replay, the registration is dropped and the rest of the backlog stays
// in the DB for the next startup. Returns void; success vs. failure is
// observable only via the registry state afterward.
export async function registerAndReplay(
  db: Db,
  idResolver: IdResolver,
  did: string,
  url: string,
  afterSeq: number,
): Promise<void> {
  // Enqueue replay before publishing the registration, but gate its DB query
  // until afterward. An insert before registry.set is visible to the deferred
  // query; an insert after it queues behind this task. There is no cutover gap.
  const gate = createDeferrable()
  const replay = deliveryRunner.addTask(did, async () => {
    await gate.complete
    const backlog = await getNotificationsAfterSeq(
      db,
      idResolver,
      did,
      afterSeq,
    )
    for (const view of backlog) {
      // A newer registration supersedes this replay task.
      if (registry.get(did) !== url) return
      const ok = await postNotification(url, view)
      if (!ok) {
        if (registry.get(did) === url) registry.delete(did)
        return
      }
    }
  })
  registry.set(did, url)
  gate.resolve()
  await replay
}

// Fire-and-forget push for a single freshly-inserted notification. Called
// from the indexer right after insertNotification's row write. Cheap no-op
// if the recipient has no live registration. On POST failure (or a thrown
// hydration error — getNotificationByKey now hits IdResolver and can
// reject), drops the registration so subsequent events for the same DID
// don't retry into a dead URL.
export function notifyInsert(
  db: Db,
  idResolver: IdResolver,
  recipientDid: string,
  uri: string,
): void {
  const url = registry.get(recipientDid)
  if (!url) return
  void deliveryRunner.addTask(recipientDid, async () => {
    // Registration may have been replaced while this task waited in line.
    if (registry.get(recipientDid) !== url) return
    try {
      const view = await getNotificationByKey(db, idResolver, uri, recipientDid)
      if (!view) return
      const ok = await postNotification(url, view)
      if (!ok && registry.get(recipientDid) === url) {
        registry.delete(recipientDid)
      }
    } catch (err) {
      console.error(
        `notifyInsert ${recipientDid} ${uri}: ${err instanceof Error ? err.message : err}`,
      )
      if (registry.get(recipientDid) === url) registry.delete(recipientDid)
    }
  })
}

// Test helpers — keep the registry inspectable from the smoke tests without
// exporting the Map itself.
export function _registeredUrl(did: string): string | undefined {
  return registry.get(did)
}

export function _clear(): void {
  registry.clear()
}

export async function _processAll(): Promise<void> {
  await deliveryRunner.processAll()
}

async function postNotification(
  url: string,
  view: NotificationView,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(view),
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
