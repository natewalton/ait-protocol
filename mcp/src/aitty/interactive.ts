// The interactive client: log in, show the home timeline streaming live with
// each post numbered, and accept commands at a prompt pinned below the stream.
// This is the default `aitty` (no subcommand) experience.
//
// The one non-trivial bit is keeping the prompt below the live feed (see the
// spec section of the same name): on each incoming line we wipe the prompt
// line, write the post straight to the stream (never rl.write(), which replays
// into the input buffer — nodejs/node#12933), then redraw the prompt with the
// in-progress input preserved. All of it gated on stdout being a TTY; piped,
// it falls back to plain streaming with no prompt.

import * as readline from 'node:readline'
import type { AtpAgent } from '@atproto/api'
import { fetchTimeline, type FeedItem } from './agent.js'
import type { WatcherIdentity } from './identity.js'
import { makeStyles, feedWidth, supportsColor } from './render.js'
import { renderFeedItem } from './feed.js'
import {
  actionPost,
  actionReply,
  actionFollow,
  actionUnfollow,
  actionNotifs,
  actionProfile,
  actionThread,
} from './commands.js'

const BACKLOG = 12 // posts shown as context on startup
const SEEN_CAP = 2000 // bound the dedupe set's memory
const INDEX_CAP = 1000 // bound the n→uri map (old numbers have scrolled away)

export interface InteractiveOpts {
  noColor: boolean
  intervalSecs: number
}

const HELP = [
  'commands (alias):',
  '  post <text>          (p)  compose a post',
  '  reply <n> <text>     (r)  reply to printed post #n',
  '  follow <handle>      (f)  follow an account',
  '  unfollow <handle>         unfollow an account',
  '  notifs               (n)  replies / mentions / follows on you',
  '  profile [handle]     (u)  bio, counts, recent posts (default: you)',
  '  thread <n>           (t)  the thread for printed post #n',
  '  help                 (?)  this list',
  '  quit                 (q)  exit',
].join('\n')

export async function runInteractive(
  agent: AtpAgent,
  identity: WatcherIdentity,
  opts: InteractiveOpts,
): Promise<void> {
  const styles = makeStyles(supportsColor(opts.noColor))
  const width = feedWidth()
  const isTTY = Boolean(process.stdout.isTTY)
  const intervalMs = opts.intervalSecs * 1000

  const didHandle = new Map<string, string>() // author DID → handle, render cache
  const seen = new Set<string>() // post uris already shown (dedupe)
  const index = new Map<number, string>() // printed [n] → post uri
  let counter = 0
  let rl: readline.Interface | null = null

  // Write a block above the pinned prompt. Before the prompt exists (backlog)
  // or when piped, this is a plain write; with the prompt up, wipe-write-redraw.
  function printAbovePrompt(text: string): void {
    if (isTTY && rl) {
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
      process.stdout.write(text + '\n\n')
      rl.prompt(true)
    } else {
      process.stdout.write(text + '\n\n')
    }
  }

  function warn(s: string): void {
    printAbovePrompt(styles.dim(s))
  }

  async function emit(item: FeedItem): Promise<void> {
    const n = ++counter
    index.set(n, item.post.uri)
    if (index.size > INDEX_CAP) index.delete(n - INDEX_CAP)
    seen.add(item.post.uri)
    const body = await renderFeedItem(agent, item, styles, width, didHandle)
    printAbovePrompt(`[${n}] ${body}`)
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // getTimeline is reverse-chrono; print fresh items oldest-first. The home
  // timeline already scopes to who you follow, so there's no set filter here
  // (that's the watch subcommand's job).
  async function pollLoop(): Promise<void> {
    for (;;) {
      await sleep(intervalMs)
      // One try around fetch + render: a transient failure (network, or a write
      // that races a tear-down) warns and waits for the next tick rather than
      // rejecting out of this fire-and-forgotten loop.
      try {
        const feed = await fetchTimeline(agent, 50)
        const fresh = feed.filter((i) => !seen.has(i.post.uri)).reverse()
        for (const item of fresh) await emit(item)
        if (seen.size > SEEN_CAP) {
          for (const uri of [...seen].slice(0, seen.size - SEEN_CAP)) seen.delete(uri)
        }
      } catch (err) {
        warn(`(poll failed: ${err instanceof Error ? err.message : String(err)}; retrying)`)
      }
    }
  }

  async function handleCommand(raw: string): Promise<void> {
    const line = raw.trim()
    if (line === '') return
    const m = line.match(/^(\S+)\s*([\s\S]*)$/)
    if (!m) return
    const cmd = m[1].toLowerCase()
    const rest = m[2]
    try {
      switch (cmd) {
        case 'post':
        case 'p':
          if (!rest.trim()) return warn('usage: post <text>')
          return printAbovePrompt(await actionPost(agent, identity, rest))
        case 'reply':
        case 'r': {
          const rm = rest.match(/^(\d+)\s+([\s\S]+)$/)
          if (!rm) return warn('usage: reply <n> <text>')
          const uri = index.get(Number(rm[1]))
          if (!uri) return warn(`no post #${rm[1]} in view`)
          return printAbovePrompt(await actionReply(agent, identity, uri, rm[2]))
        }
        case 'follow':
        case 'f':
          if (!rest.trim()) return warn('usage: follow <handle>')
          return printAbovePrompt(await actionFollow(agent, identity, rest.trim()))
        case 'unfollow':
          if (!rest.trim()) return warn('usage: unfollow <handle>')
          return printAbovePrompt(await actionUnfollow(agent, identity, rest.trim()))
        case 'notifs':
        case 'n':
          return printAbovePrompt(await actionNotifs(agent, styles))
        case 'profile':
        case 'u':
          return printAbovePrompt(
            await actionProfile(agent, rest.trim() || identity.handle, styles, width),
          )
        case 'thread':
        case 't': {
          const arg = rest.trim()
          if (!/^\d+$/.test(arg)) return warn('usage: thread <n>')
          const uri = index.get(Number(arg))
          if (!uri) return warn(`no post #${arg} in view`)
          return printAbovePrompt(await actionThread(agent, uri, styles, width))
        }
        case 'help':
        case '?':
          return printAbovePrompt(HELP)
        case 'quit':
        case 'q':
          if (rl) rl.close()
          return
        default:
          return warn(`unknown command: ${cmd} — type "help"`)
      }
    } catch (err) {
      warn(`error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Status to stderr so a piped stdout stays a clean feed.
  process.stderr.write(
    `aitty — @${identity.handle}. ` +
      (isTTY ? 'type "help" for commands, "quit" to exit.\n\n' : '(piped: streaming)\n\n'),
  )

  // Startup backlog: most recent BACKLOG posts, oldest-first, numbered. A
  // transient failure here is non-fatal — the poll loop catches up.
  try {
    const initial = await fetchTimeline(agent, BACKLOG)
    for (const item of initial.slice().reverse()) await emit(item)
  } catch (err) {
    process.stderr.write(
      `aitty: initial fetch failed (${err instanceof Error ? err.message : String(err)}); ` +
        'will catch up on next poll\n',
    )
  }

  // Non-TTY: no prompt, just stream (so `| cat` and piping work).
  if (!isTTY) {
    await pollLoop()
    return
  }

  // In-flight commands, so a quit mid-write waits for the post/reply to land
  // rather than process.exit abandoning the network call.
  const inflight = new Set<Promise<void>>()

  rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.setPrompt(styles.dim('› '))
  rl.on('line', (line) => {
    if (line.trim() === '') {
      rl?.prompt()
      return
    }
    // No prompt() here: handleCommand always ends by printing (which redraws the
    // prompt) or by closing on quit, so re-prompting would double-draw.
    const p = handleCommand(line)
    inflight.add(p)
    void p.finally(() => inflight.delete(p))
  })
  rl.on('SIGINT', () => rl?.close())
  rl.on('close', async () => {
    await Promise.allSettled([...inflight])
    process.stdout.write('\nbye.\n')
    process.exit(0)
  })
  rl.prompt()
  // Concurrent with the command loop; never resolves. A throw that escapes the
  // loop's own try shouldn't become a silent unhandled rejection.
  void pollLoop().catch((err) => {
    process.stderr.write(
      `aitty: poll loop stopped (${err instanceof Error ? err.message : String(err)})\n`,
    )
    process.exit(1)
  })
}
