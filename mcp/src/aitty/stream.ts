// The live feed engine shared by the interactive client (interactive.ts) and
// the `watch` subcommand (main.ts): poll getTimeline on an interval and surface
// fresh items oldest-first, deduped against a caller-owned `seen` set. The two
// surfaces differ only in the per-item hook (interactive numbers each post and
// pins a prompt below the stream; watch plain-prints a filtered set) and the
// optional filter — so everything else (fetch, dedupe, reverse, backlog,
// seen-cap eviction, per-tick error handling) lives here once.

import type { AtpAgent } from '@atproto/api'
import { fetchTimeline, type FeedItem } from './agent.js'

export const BACKLOG = 12 // posts shown as context on startup
export const SEEN_CAP = 2000 // bound the dedupe set's memory

export interface FeedHooks {
  // Keep only matching items (default: all). `watch` uses this to scope the
  // stream to its chosen set of authors.
  filter?: (item: FeedItem) => boolean
  // Render/emit one fresh item. Awaited so emits stay strictly ordered.
  onItem: (item: FeedItem) => Promise<void>
  // Report a transient poll failure (interactive dims it above the prompt;
  // watch writes it to stderr).
  onError?: (message: string) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Emit the fresh (unseen, filtered) items from a fetched batch oldest-first,
// marking each seen. getTimeline is reverse-chronological, so we reverse.
async function emitFresh(
  items: FeedItem[],
  seen: Set<string>,
  hooks: FeedHooks,
): Promise<void> {
  const fresh = items
    .filter((i) => !seen.has(i.post.uri) && (hooks.filter ? hooks.filter(i) : true))
    .reverse()
  for (const item of fresh) {
    await hooks.onItem(item)
    seen.add(item.post.uri)
  }
}

// Startup context: emit the most recent `backlog` items. A transient failure
// here is non-fatal — the poll loop catches up on the next tick.
export async function emitBacklog(
  agent: AtpAgent,
  seen: Set<string>,
  backlog: number,
  hooks: FeedHooks,
): Promise<void> {
  try {
    const initial = await fetchTimeline(agent, backlog)
    await emitFresh(initial, seen, hooks)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `aitty: initial fetch failed (${msg}); will catch up on next poll\n`,
    )
  }
}

// Poll forever: every `intervalMs`, emit fresh items, then bound `seen` at
// `seenCap`. One try per tick — a transient failure (network, or a render
// hiccup) reports via onError and waits for the next tick rather than rejecting
// out of the loop.
export async function pollFeed(
  agent: AtpAgent,
  seen: Set<string>,
  intervalMs: number,
  seenCap: number,
  hooks: FeedHooks,
): Promise<void> {
  for (;;) {
    await sleep(intervalMs)
    try {
      const feed = await fetchTimeline(agent, 50)
      await emitFresh(feed, seen, hooks)
      if (seen.size > seenCap) {
        for (const uri of [...seen].slice(0, seen.size - seenCap)) seen.delete(uri)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      hooks.onError?.(`poll failed (${msg}); retrying`)
    }
  }
}
