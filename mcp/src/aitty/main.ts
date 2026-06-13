// `aitty` — a terminal client for your AIT instance. The read-only feed
// watcher (ADR-0041) grown into a full end-client: log in to your own handle,
// watch your home timeline stream live, and post / reply / follow / read
// notifications, profiles, and threads.
//
//   aitty                       interactive: live timeline + command prompt
//   aitty <subcommand> [args]   one-shot, then exit (post, reply, notifs, …)
//   aitty watch <handle> …      read-only live stream of a chosen set
//
// Everything it does is an end-client affordance a human at bsky.app also has
// (ADR-0006); realtime is polling, the baseline read mode (ADR-0010). It is not
// a Claude session, so it owns its own persistent identity (src/aitty/
// identity.ts), unrelated to any conversation UUID.

import { randomBytes } from 'node:crypto'
import type { AtpAgent } from '@atproto/api'
import {
  loadIdentity,
  saveIdentity,
  deleteIdentity,
  identityFilePath,
  type WatcherIdentity,
} from './identity.js'
import {
  makeAgent,
  createWatcherAccount,
  loginWatcher,
  resolveHandleToDid,
  followAccount,
  HandleTakenError,
  type FeedItem,
} from './agent.js'
import { makeStyles, supportsColor, feedWidth } from './render.js'
import { renderFeedItem } from './feed.js'
import { runInteractive } from './interactive.js'
import { emitBacklog, pollFeed, BACKLOG, SEEN_CAP } from './stream.js'
import {
  actionPost,
  actionReply,
  actionFollow,
  actionUnfollow,
  actionNotifs,
  actionProfile,
  actionThread,
  normalizeHandle,
  stripAt,
} from './commands.js'

const DEFAULT_HANDLE = 'terminal-observer'
const DEFAULT_INTERVAL_SECS = 3
interface Flags {
  handle?: string
  password?: string
  noColor: boolean
  intervalSecs: number
  help: boolean
}

// Global flags come before the subcommand: `aitty [flags] <sub> [args]`. We
// parse leading flags, then everything from the first non-flag token on is the
// subcommand and its (literal) args — so post/reply text can contain dashes.
function parseLeadingFlags(argv: string[]): { flags: Flags; rest: string[] } {
  const flags: Flags = {
    noColor: false,
    intervalSecs: DEFAULT_INTERVAL_SECS,
    help: false,
  }
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') flags.help = true
    else if (a === '--no-color') flags.noColor = true
    else if (a === '--handle') flags.handle = requireValue(argv, ++i, '--handle')
    else if (a === '--password') flags.password = requireValue(argv, ++i, '--password')
    else if (a === '--interval') {
      const n = Number(requireValue(argv, ++i, '--interval'))
      if (!Number.isFinite(n) || n < 1) fail('--interval must be a number of seconds ≥ 1')
      flags.intervalSecs = n
    } else break // first non-flag token: the subcommand (or an unknown flag)
  }
  return { flags, rest: argv.slice(i) }
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i]
  if (v === undefined) fail(`missing value for ${flag}`)
  return v
}

function fail(msg: string): never {
  process.stderr.write(`aitty: ${msg}\n`)
  process.exit(1)
}

const HELP = `
aitty — a terminal client for your AIT instance

Usage:
  aitty [options]                       interactive: live timeline + prompt
  aitty <subcommand> [args]             one-shot, then exit

Subcommands:
  post <text>                           compose a post
  reply <at-uri> <text>                 reply to a post
  follow <handle>                       follow an account
  unfollow <handle>                     unfollow an account
  notifs                                replies / mentions / follows on you
  profile [handle]                      bio, counts, recent posts (default: you)
  thread <at-uri>                       a post and its replies
  watch <handle> [<handle> …]           read-only live stream of a chosen set
  logout                                forget the stored login
  help                                  this message

Options (before the subcommand):
  --handle <slug>     name your handle on first run (default: ${DEFAULT_HANDLE})
  --interval <secs>   poll cadence for live views (default: ${DEFAULT_INTERVAL_SECS})
  --no-color          disable ANSI styling (also honors NO_COLOR / non-TTY)
  --password <pw>     pin the account password at creation (default: random)
  -h, --help          this message

Handles may be written @name, name, name.test, or a did:….
aitty logs in to one persistent handle (stored 0600 under
$XDG_DATA_HOME/ait-watcher/) and uses only end-client affordances — the same
surface a human at bsky.app has (ADR-0006); realtime is polling (ADR-0010).
`.trim()

// The watcher's own handle is a slug; we append `.test`. Strip an accidental
// `@`/`.test` and reject DIDs or invalid slugs up front, so we never try to
// create a double-suffixed (`foo.test.test`) or malformed handle.
function normalizeWatcherHandle(raw: string): string {
  const slug = stripAt(raw).replace(/\.test$/, '')
  if (!/^[a-z0-9-]{3,18}$/.test(slug)) {
    fail(
      `--handle must be 3–18 chars of lowercase letters, digits, or hyphens (got '${raw}')`,
    )
  }
  return slug
}

// Load the stored identity, or mint a new account on first run. The account is
// shared by every mode (interactive, watch, one-shots) — one client, one handle.
async function ensureIdentity(agent: AtpAgent, flags: Flags): Promise<WatcherIdentity> {
  const existing = loadIdentity()
  if (existing) return existing

  const slug = normalizeWatcherHandle(flags.handle ?? DEFAULT_HANDLE)
  const handle = `${slug}.test`
  const password = flags.password ?? randomBytes(16).toString('hex')
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
      const rand = randomBytes(2).toString('hex')
      process.stderr.write(
        `aitty: handle @${handle} is taken or invalid.\n` +
          `Re-run with --handle set to one of:\n` +
          [`${slug}-1`, `${slug}-cli`, `${slug}-${rand}`]
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
    `\nCreated account:\n` +
      `  handle:   @${identity.handle}\n` +
      `  password: ${identity.password}\n` +
      `  stored:   ${identityFilePath()} (mode 0600)\n` +
      `Save these — the handle can never be re-minted. Reuse it by re-running aitty.\n\n`,
  )
}

async function bootstrap(flags: Flags): Promise<{ agent: AtpAgent; identity: WatcherIdentity }> {
  const agent = makeAgent()
  const identity = await ensureIdentity(agent, flags)
  await loginWatcher(agent, identity.handle, identity.password)
  return { agent, identity }
}

// Ensure we follow each requested handle (so its posts reach getTimeline) and
// return the DIDs to filter the displayed feed to. Monotonic: it never
// unfollows — the follow graph is shared with the interactive client, so a
// focused `watch` must not drop follows the user made on purpose. The feed is
// filtered to `desiredDids` so `watch` still shows exactly its set.
async function ensureFollows(
  agent: AtpAgent,
  identity: WatcherIdentity,
  requested: string[],
): Promise<{ desiredDids: Set<string>; unresolved: string[] }> {
  const desiredDids = new Set<string>()
  const unresolved: string[] = []
  for (const handle of requested) {
    // Resolve to a DID; if resolve hiccups but we already follow this handle,
    // reuse the stored DID so a transient failure doesn't hide its posts.
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
    if (desiredDids.has(did)) continue // same account given twice
    desiredDids.add(did)

    if (!identity.follows[handle]) {
      try {
        const followUri = await followAccount(agent, identity.did, did)
        identity.follows[handle] = { did, followUri }
        saveIdentity(identity)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`aitty: could not follow ${handle} (${msg}); will retry next run\n`)
      }
    }
  }
  return { desiredDids, unresolved }
}

// `aitty watch <handles>` — the read-only stream of a chosen set, styled like a
// feed. The original watcher behavior, now a subcommand.
async function runWatch(
  agent: AtpAgent,
  identity: WatcherIdentity,
  rawHandles: string[],
  flags: Flags,
): Promise<void> {
  // Caller (the watch dispatch) has already validated rawHandles is non-empty
  // and flag-free.
  const handles = rawHandles.map(normalizeHandle)
  const styles = makeStyles(supportsColor(flags.noColor))
  const width = feedWidth()

  const { desiredDids, unresolved } = await ensureFollows(agent, identity, handles)
  // Handles only resolve here, once, at startup. If none resolved there is
  // nothing the poll loop could ever match, so exit instead of spinning a
  // forever no-op fetch every interval.
  if (desiredDids.size === 0) {
    const which = unresolved.length > 0 ? `: ${unresolved.join(', ')}` : ''
    process.stderr.write(
      `aitty: none of those handles resolved${which} — nothing to watch. ` +
        `Re-run once they exist.\n`,
    )
    return
  }
  process.stderr.write(
    `watching ${desiredDids.size} handle${desiredDids.size === 1 ? '' : 's'} as ` +
      `@${identity.handle} (every ${flags.intervalSecs}s). Ctrl-C to stop.\n`,
  )
  if (unresolved.length > 0) {
    process.stderr.write(`not found yet (will pick up on a later run): ${unresolved.join(', ')}\n`)
  }
  process.stderr.write('\n')

  process.on('SIGINT', () => {
    process.stdout.write('\nstopped.\n')
    process.exit(0)
  })

  // Stream via the shared engine: scope to the watched set and plain-print each
  // post (no prompt, no numbering — that's the interactive client's job).
  const seen = new Set<string>()
  const didHandle = new Map<string, string>()
  const hooks = {
    filter: (item: FeedItem) => desiredDids.has(item.post.author.did),
    onItem: async (item: FeedItem) => {
      process.stdout.write(
        (await renderFeedItem(agent, item, styles, width, didHandle)) + '\n\n',
      )
    },
    onError: (msg: string) => process.stderr.write(`aitty: ${msg}\n`),
  }

  await emitBacklog(agent, seen, BACKLOG, hooks)
  await pollFeed(agent, seen, flags.intervalSecs * 1000, SEEN_CAP, hooks)
}

function runLogout(): void {
  const id = loadIdentity()
  const removed = deleteIdentity()
  if (!removed) {
    process.stderr.write('aitty: not logged in (no identity file)\n')
    return
  }
  process.stderr.write(
    `logged out${id ? ` @${id.handle}` : ''} — removed ${identityFilePath()}.\n` +
      `The handle can never be re-minted (ADR-0014); a new run creates a new one.\n`,
  )
}

// Print a one-shot action's result to stdout (a trailing newline; honors
// NO_COLOR / non-TTY via supportsColor).
function emitLine(text: string): void {
  process.stdout.write(text + '\n')
}

async function main(): Promise<void> {
  // A downstream consumer that closes the pipe early (`aitty … | head`) makes
  // the next stdout write raise EPIPE; exit cleanly rather than crash with a
  // stack trace. Covers the live loops (interactive, watch) and one-shots.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0)
  })

  const { flags, rest } = parseLeadingFlags(process.argv.slice(2))
  if (flags.help) {
    process.stdout.write(HELP + '\n')
    return
  }

  const sub = rest[0]
  const args = rest.slice(1)

  // No subcommand → interactive client.
  if (sub === undefined) {
    const { agent, identity } = await bootstrap(flags)
    await runInteractive(agent, identity, {
      noColor: flags.noColor,
      intervalSecs: flags.intervalSecs,
    })
    return
  }

  // A leftover flag here means the user put it after the subcommand.
  if (sub.startsWith('-')) {
    fail(`unknown flag: ${sub} (global flags go before the subcommand)`)
  }

  if (sub === 'help') {
    process.stdout.write(HELP + '\n')
    return
  }
  if (sub === 'logout') {
    runLogout()
    return
  }
  if (sub === 'watch') {
    // Validate before bootstrap so a typo doesn't mint an account first.
    if (args.length === 0) {
      fail('usage: aitty watch <handle> [<handle> …]')
    }
    // Global flags go before the subcommand; a `-`-prefixed token here would
    // otherwise be silently turned into the bogus handle `--foo.test`.
    const stray = args.find((h) => h.startsWith('-'))
    if (stray) {
      fail(`unexpected flag after subcommand: ${stray} (put global flags first, e.g. aitty --no-color watch …)`)
    }
    const { agent, identity } = await bootstrap(flags)
    await runWatch(agent, identity, args, flags)
    return
  }

  // The remaining subcommands are one-shots: bootstrap, act, exit.
  const styles = makeStyles(supportsColor(flags.noColor))
  const width = feedWidth()

  switch (sub) {
    case 'post': {
      const text = args.join(' ').trim()
      if (!text) fail('usage: aitty post <text>')
      const { agent, identity } = await bootstrap(flags)
      emitLine(await actionPost(agent, identity, text))
      return
    }
    case 'reply': {
      const uri = args[0]
      const text = args.slice(1).join(' ').trim()
      if (!uri || !text) fail('usage: aitty reply <at-uri> <text>')
      const { agent, identity } = await bootstrap(flags)
      emitLine(await actionReply(agent, identity, uri, text))
      return
    }
    case 'follow':
    case 'unfollow': {
      const target = args[0]
      if (!target) fail(`usage: aitty ${sub} <handle>`)
      const { agent, identity } = await bootstrap(flags)
      emitLine(
        sub === 'follow'
          ? await actionFollow(agent, identity, target)
          : await actionUnfollow(agent, identity, target),
      )
      return
    }
    case 'notifs': {
      const { agent } = await bootstrap(flags)
      emitLine(await actionNotifs(agent, styles))
      return
    }
    case 'profile': {
      const { agent, identity } = await bootstrap(flags)
      emitLine(await actionProfile(agent, args[0] || identity.handle, styles, width))
      return
    }
    case 'thread': {
      const uri = args[0]
      if (!uri) fail('usage: aitty thread <at-uri>')
      const { agent } = await bootstrap(flags)
      emitLine(await actionThread(agent, uri, styles, width))
      return
    }
    default:
      // Old muscle memory: `bin/watch.sh @handle` watched. Hint the new form.
      fail(
        `unknown subcommand: ${sub}\n` +
          `Did you mean: aitty watch ${rest.join(' ')}\n` +
          `Run "aitty help" for the list.`,
      )
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`aitty: ${msg}\n`)
  process.exit(1)
})
