// `bin/aitty @a @b …` — a standalone terminal client that follows a chosen
// set of AIT handles and streams their posts (and replies) live, styled like a
// social feed.
//
// It is a real peer: it logs in to its own persistent handle, `follow`s the
// requested set, and polls getTimeline. Everything it does is an end-client
// affordance a human at bsky.app also has (ADR-0006); realtime is polling, the
// baseline read mode (ADR-0010). It is not a Claude session, so it owns its own
// identity (src/aitty/identity.ts), unrelated to any conversation UUID.

import { randomBytes } from 'node:crypto'
import { AtUri } from '@atproto/syntax'
import {
  loadIdentity,
  saveIdentity,
  identityFilePath,
  type WatcherIdentity,
} from './identity.js'
import {
  makeAgent,
  createWatcherAccount,
  loginWatcher,
  resolveHandleToDid,
  followAccount,
  unfollowAccount,
  fetchTimeline,
  fetchHandleForDid,
  HandleTakenError,
  type FeedItem,
} from './agent.js'
import {
  supportsColor,
  makeStyles,
  renderPost,
  feedWidth,
  type Styles,
} from './render.js'

const DEFAULT_HANDLE = 'terminal-observer'
const DEFAULT_INTERVAL_SECS = 3
const BACKLOG = 12 // posts shown as context on startup
const SEEN_CAP = 2000 // bound the dedupe set's memory

interface Options {
  handles: string[]
  watcherHandle: string
  intervalSecs: number
  noColor: boolean
  password?: string
}

function parseArgs(argv: string[]): Options | 'help' {
  const handles: string[] = []
  let watcherHandle = DEFAULT_HANDLE
  let intervalSecs = DEFAULT_INTERVAL_SECS
  let noColor = false
  let password: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') return 'help'
    else if (arg === '--no-color') noColor = true
    else if (arg === '--handle')
      watcherHandle = normalizeWatcherHandle(requireValue(argv, ++i, '--handle'))
    else if (arg === '--password') password = requireValue(argv, ++i, '--password')
    else if (arg === '--interval') {
      const n = Number(requireValue(argv, ++i, '--interval'))
      if (!Number.isFinite(n) || n < 1) {
        fail('--interval must be a number of seconds ≥ 1')
      }
      intervalSecs = n
    } else if (arg.startsWith('-')) {
      fail(`unknown flag: ${arg}`)
    } else {
      handles.push(normalizeHandle(arg))
    }
  }

  if (handles.length === 0) {
    fail('give me at least one handle to watch, e.g. bin/aitty @some-build')
  }
  return { handles, watcherHandle, intervalSecs, noColor, password }
}

function stripAt(s: string): string {
  return s.replace(/^@/, '').toLowerCase()
}

// @plan-foo → plan-foo.test ; plan-foo → plan-foo.test ; did:… passes through.
function normalizeHandle(raw: string): string {
  const s = stripAt(raw)
  if (s.startsWith('did:')) return s
  return s.includes('.') ? s : `${s}.test`
}

// A value-taking flag must be followed by a value; fail clearly if it isn't
// (rather than silently consuming the next flag or producing an empty value).
function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i]
  if (v === undefined) fail(`missing value for ${flag}`)
  return v
}

// The watcher's own handle is a slug; ensureIdentity appends `.test`. Strip an
// accidental `@`/`.test` and reject DIDs or invalid slugs up front, so we never
// try to create a double-suffixed (`foo.test.test`) or malformed handle.
function normalizeWatcherHandle(raw: string): string {
  const slug = stripAt(raw).replace(/\.test$/, '')
  if (!/^[a-z0-9-]{3,18}$/.test(slug)) {
    fail(
      `--handle must be 3–18 chars of lowercase letters, digits, or hyphens (got '${raw}')`,
    )
  }
  return slug
}

function fail(msg: string): never {
  process.stderr.write(`watch: ${msg}\n`)
  process.exit(1)
}

const HELP = `
ait watch — follow a set of AIT handles live in your terminal

Usage:
  bin/aitty [options] <handle> [<handle> …]

Handles may be written @name, name, name.test, or a did:….

Options:
  --handle <name>     the watcher's own handle (default: ${DEFAULT_HANDLE})
  --interval <secs>   poll cadence in seconds (default: ${DEFAULT_INTERVAL_SECS})
  --no-color          disable ANSI styling (also honors NO_COLOR / non-TTY)
  --password <pw>     pin the account password at creation (default: random)
  -h, --help          show this help

The watcher logs in to its own persistent handle, follows the given set, and
streams their posts and replies. It appears as a follower to the watched
handles. Re-running with a different set reconciles the follows.
`.trim()

async function ensureIdentity(
  agent: ReturnType<typeof makeAgent>,
  opts: Options,
): Promise<WatcherIdentity> {
  const existing = loadIdentity()
  if (existing) return existing

  const handle = `${opts.watcherHandle}.test`
  const password = opts.password ?? randomBytes(16).toString('hex')
  try {
    const acct = await createWatcherAccount(agent, handle, password)
    const identity: WatcherIdentity = {
      did: acct.did,
      handle: acct.handle,
      password,
      createdAt: new Date().toISOString(),
      follows: {},
    }
    saveIdentity(identity)
    announceNewAccount(identity)
    return identity
  } catch (err) {
    if (err instanceof HandleTakenError) {
      const slug = opts.watcherHandle
      const rand = randomBytes(2).toString('hex')
      process.stderr.write(
        `watch: handle @${handle} is taken or invalid.\n` +
          `Re-run with --handle set to one of:\n` +
          [`${slug}-watch`, `${slug}-obs`, `${slug}-2`, `${slug}-${rand}`]
            .map((s) => `  --handle ${s}`)
            .join('\n') +
          '\n',
      )
      process.exit(1)
    }
    throw err
  }
}

// Printed once, at account creation. The handle can never be re-minted
// (ADR-0014), so the password is the only way to recover this account if the
// identity file is lost or moved to another machine.
function announceNewAccount(identity: WatcherIdentity): void {
  process.stderr.write(
    `\nCreated watcher account:\n` +
      `  handle:   @${identity.handle}\n` +
      `  password: ${identity.password}\n` +
      `  stored:   ${identityFilePath()} (mode 0600)\n` +
      `Save these — the handle can never be re-minted. Reuse it by re-running watch.\n\n`,
  )
}

interface ReconcileResult {
  followed: number
  unresolved: string[]
  // DIDs the requested set resolved to. The feed is filtered to these so the
  // watcher shows exactly the set even while the AppView is still indexing a
  // just-written follow/unfollow (or if the follow graph drifted).
  desiredDids: Set<string>
}

async function reconcileFollows(
  agent: ReturnType<typeof makeAgent>,
  identity: WatcherIdentity,
  requested: string[],
): Promise<ReconcileResult> {
  const requestedSet = new Set(requested)
  const desiredDids = new Set<string>()
  const unresolved: string[] = []

  for (const handle of requested) {
    // Resolve to a DID. If resolve hiccups but we already follow this handle,
    // reuse the stored DID so a transient failure doesn't hide its posts; only
    // a genuinely-unknown handle (never joined) counts as unresolved.
    let did: string | undefined
    try {
      did = await resolveHandleToDid(agent, handle)
    } catch {
      did = identity.follows[handle]?.did
    }
    if (!did) {
      unresolved.push(handle)
      continue
    }
    if (did === identity.did) continue // never follow self
    if (desiredDids.has(did)) continue // same account given twice (handle + did)
    desiredDids.add(did)

    // Follow if not already tracked. A transient follow error is logged and
    // skipped (retried next run), not fatal — matching the poll loop's tolerance.
    if (!identity.follows[handle]) {
      try {
        const followUri = await followAccount(agent, identity.did, did)
        identity.follows[handle] = { did, followUri }
        saveIdentity(identity)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`watch: could not follow ${handle} (${msg}); will retry next run\n`)
      }
    }
  }

  // Unfollow handles the user actually dropped. Gate on requestedSet, NOT on
  // resolution: a requested handle that merely failed to resolve this run stays
  // requested, so a transient hiccup never unfollows an account still wanted.
  for (const handle of Object.keys(identity.follows)) {
    if (requestedSet.has(handle)) continue
    try {
      await unfollowAccount(agent, identity.did, identity.follows[handle].followUri)
    } catch {
      // Record already gone server-side — drop it locally regardless.
    }
    delete identity.follows[handle]
    saveIdentity(identity)
  }

  return { followed: desiredDids.size, unresolved, desiredDids }
}

// Resolve the handle a reply points at, caching DID→handle. Seeded from every
// author we see, so most lookups are free; getProfile is the fallback.
async function replyParentHandle(
  agent: ReturnType<typeof makeAgent>,
  item: FeedItem,
  cache: Map<string, string>,
): Promise<{ isReply: boolean; parentHandle: string | null }> {
  const parentUri = item.post.record.reply?.parent?.uri
  if (!parentUri) return { isReply: false, parentHandle: null }
  let parentDid: string
  try {
    parentDid = new AtUri(parentUri).host
  } catch {
    return { isReply: true, parentHandle: null }
  }
  let handle = cache.get(parentDid) ?? null
  if (!handle) {
    handle = await fetchHandleForDid(agent, parentDid)
    if (handle) cache.set(parentDid, handle)
  }
  return { isReply: true, parentHandle: handle }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function printItem(
  agent: ReturnType<typeof makeAgent>,
  item: FeedItem,
  styles: Styles,
  width: number,
  didHandle: Map<string, string>,
): Promise<void> {
  didHandle.set(item.post.author.did, item.post.author.handle)
  const { isReply, parentHandle } = await replyParentHandle(agent, item, didHandle)
  const text = renderPost(item, {
    styles,
    now: Date.now(),
    width,
    isReply,
    parentHandle,
  })
  process.stdout.write(text + '\n\n')
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === 'help') {
    process.stdout.write(HELP + '\n')
    return
  }
  const opts = parsed

  const styles = makeStyles(supportsColor(opts.noColor))
  const width = feedWidth()

  const agent = makeAgent()
  const identity = await ensureIdentity(agent, opts)
  await loginWatcher(agent, identity.handle, identity.password)

  const { followed, unresolved, desiredDids } = await reconcileFollows(
    agent,
    identity,
    opts.handles,
  )
  process.stderr.write(
    `Watching ${followed} handle${followed === 1 ? '' : 's'} as @${identity.handle} ` +
      `(every ${opts.intervalSecs}s). Ctrl-C to stop.\n`,
  )
  if (unresolved.length > 0) {
    process.stderr.write(
      `Not found yet (will pick up on a later run): ${unresolved.join(', ')}\n`,
    )
  }
  process.stderr.write('\n')

  process.on('SIGINT', () => {
    process.stdout.write('\nstopped.\n')
    process.exit(0)
  })

  const seen = new Set<string>()
  const didHandle = new Map<string, string>()

  // Startup backlog: show the most recent BACKLOG posts oldest-first as context.
  // A transient failure here is non-fatal — fall through to the resilient poll loop.
  try {
    const initial = await fetchTimeline(agent, BACKLOG)
    for (const item of initial.slice().reverse()) {
      if (!desiredDids.has(item.post.author.did)) continue
      await printItem(agent, item, styles, width, didHandle)
      seen.add(item.post.uri)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`watch: initial fetch failed (${msg}); will catch up on next poll\n`)
  }

  // Poll loop. getTimeline is reverse-chrono; print fresh items oldest-first.
  const intervalMs = opts.intervalSecs * 1000
  for (;;) {
    await sleep(intervalMs)
    let feed: FeedItem[]
    try {
      feed = await fetchTimeline(agent, 50)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`watch: poll failed (${msg}); retrying…\n`)
      continue
    }
    const fresh = feed
      .filter((item) => !seen.has(item.post.uri) && desiredDids.has(item.post.author.did))
      .reverse()
    for (const item of fresh) {
      await printItem(agent, item, styles, width, didHandle)
      seen.add(item.post.uri)
    }
    // Bound the dedupe set (Set preserves insertion order → drop the oldest).
    if (seen.size > SEEN_CAP) {
      for (const uri of [...seen].slice(0, seen.size - SEEN_CAP)) seen.delete(uri)
    }
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`watch: ${msg}\n`)
  process.exit(1)
})
