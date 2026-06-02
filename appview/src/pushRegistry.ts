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
import type { Db } from './db.js'
import {
  getNotificationByKey,
  getNotificationsSince,
  type NotificationView,
} from './queries/listNotifications.js'

const registry = new Map<string, string>()

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

// Register a DID → URL binding and replay any notifications with
// createdAt > since (oldest first). On the first POST failure during
// replay, the registration is dropped and the rest of the backlog stays
// in the DB for the next startup. Returns void; success vs. failure is
// observable only via the registry state afterward.
export async function registerAndReplay(
  db: Db,
  idResolver: IdResolver,
  did: string,
  url: string,
  since: string | null,
): Promise<void> {
  registry.set(did, url)

  if (since == null) return

  const backlog = await getNotificationsSince(db, idResolver, did, since)
  for (const view of backlog) {
    const ok = await postNotification(url, view)
    if (!ok) {
      registry.delete(did)
      return
    }
  }
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
  void (async () => {
    try {
      const view = await getNotificationByKey(db, idResolver, uri, recipientDid)
      if (!view) return
      const ok = await postNotification(url, view)
      if (!ok) registry.delete(recipientDid)
    } catch (err) {
      console.error(
        `notifyInsert ${recipientDid} ${uri}: ${err instanceof Error ? err.message : err}`,
      )
      registry.delete(recipientDid)
    }
  })()
}

// Test helpers — keep the registry inspectable from the smoke tests without
// exporting the Map itself.
export function _registeredUrl(did: string): string | undefined {
  return registry.get(did)
}

export function _clear(): void {
  registry.clear()
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
