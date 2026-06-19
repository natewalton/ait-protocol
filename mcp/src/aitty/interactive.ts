// The interactive client: log in, show the home timeline streaming live with
// each post numbered, and accept commands at a prompt pinned below the stream.
// This is the default `aitty` (no subcommand) experience.
//
// The one non-trivial bit is the input layer (picker.ts): a raw-mode line
// editor with an inline @-mention picker (a live handle dropdown backed by
// ait.actor.searchActors), keeping the prompt + dropdown pinned below the live
// feed. Feed posts print above it via printAbovePrompt → MentionPrompt.printAbove.
// All gated on stdout being a TTY; piped, it falls back to plain streaming.

import type { AtpAgent } from '@atproto/api'
import { type FeedItem, fetchSearchActors } from './agent.js'
import type { WatcherIdentity } from './identity.js'
import { makeStyles, feedWidth, supportsColor } from './render.js'
import { renderFeedItem } from './feed.js'
import { emitBacklog, pollFeed, BACKLOG, SEEN_CAP } from './stream.js'
import { MentionPrompt, type CompletionToken } from './picker.js'
import {
  actionPost,
  actionReply,
  actionFollow,
  actionUnfollow,
  actionNotifs,
  actionProfile,
  actionThread,
  stripAt,
} from './commands.js'

const INDEX_CAP = 1000 // bound the n→uri map (old numbers have scrolled away)

// Picker targets: commands whose argument is a handle (the whole token is the
// query), and commands whose free text carries @mentions (the query starts at
// the `@`). Keys match the command names + aliases handled below.
const HANDLE_ARG_CMDS = new Set(['follow', 'f', 'unfollow', 'profile', 'u'])
const MENTION_CMDS = new Set(['post', 'p', 'reply', 'r'])

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
  '',
  '  @ opens a live handle picker — ↑/↓ choose, ⏎/tab insert, esc dismiss',
  '  (handle args of follow/unfollow/profile pick too)',
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
  let prompt: MentionPrompt | null = null

  // Write a block above the pinned prompt. Before the prompt exists (backlog)
  // or when piped, this is a plain write; with the prompt up, the editor clears
  // its region, writes the block into scrollback, and redraws below it.
  function printAbovePrompt(text: string): void {
    if (isTTY && prompt) prompt.printAbove(text)
    else process.stdout.write(text + '\n\n')
  }

  function warn(s: string): void {
    printAbovePrompt(styles.dim(s))
  }

  async function emit(item: FeedItem): Promise<void> {
    const n = ++counter
    index.set(n, item.post.uri)
    if (index.size > INDEX_CAP) index.delete(n - INDEX_CAP)
    const body = await renderFeedItem(agent, item, styles, width, didHandle)
    printAbovePrompt(`[${n}] ${body}`)
  }

  // The shared feed engine owns the poll loop, dedupe (`seen`), and backlog;
  // interactive just numbers each post. The home timeline already scopes to who
  // you follow, so no filter here (that's the watch subcommand's job).
  const hooks = { onItem: emit, onError: warn }

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
          requestQuit()
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

  // Startup backlog (numbered), via the shared engine.
  await emitBacklog(agent, seen, BACKLOG, hooks)

  // Non-TTY: no prompt, just stream (so `| cat` and piping work).
  if (!isTTY) {
    await pollFeed(agent, seen, intervalMs, SEEN_CAP, hooks)
    return
  }

  // The token the picker completes at the cursor: an `@mention` (in post/reply
  // text, or a follow/unfollow/profile handle arg written @foo), or the bare
  // handle arg of follow/unfollow/profile. null when the cursor isn't on one
  // (e.g. still typing the command). `query` drives ait.actor.searchActors.
  function findToken(line: string, cursor: number): CompletionToken | null {
    const head = line.slice(0, cursor)
    const word = (head.match(/\S*$/) ?? [''])[0] // token ending at the cursor
    const start = cursor - word.length
    const lead = line.replace(/^\s+/, '')
    const firstSpace = lead.search(/\s/)
    if (firstSpace === -1) return null // still typing the command itself
    const cmd = lead.slice(0, firstSpace).toLowerCase()

    if (word.startsWith('@')) {
      if (MENTION_CMDS.has(cmd) || HANDLE_ARG_CMDS.has(cmd)) {
        return { start, query: stripAt(word), withAt: true }
      }
      return null
    }
    if (HANDLE_ARG_CMDS.has(cmd)) {
      return { start, query: word.toLowerCase(), withAt: false }
    }
    return null
  }

  // In-flight commands, so a quit mid-write waits for the post/reply to land
  // rather than process.exit abandoning the network call.
  const inflight = new Set<Promise<void>>()

  // Close the prompt, drain in-flight writes, exit. The drain runs in a detached
  // async IIFE so it never awaits the `quit` command's own promise (which is in
  // `inflight` and would otherwise deadlock waiting on itself).
  let quitting = false
  function requestQuit(): void {
    if (quitting) return
    quitting = true
    prompt?.close()
    void (async () => {
      await Promise.allSettled([...inflight])
      process.stdout.write('bye.\n')
      process.exit(0)
    })()
  }

  prompt = new MentionPrompt({
    styles,
    findToken,
    // searchActors is a localhost end-client read; a failure (e.g. mid-restart)
    // becomes an empty result so the picker degrades quietly rather than throws.
    search: (query) => fetchSearchActors(agent, query, 12).catch(() => []),
    onLine: (line) => {
      const p = handleCommand(line)
      inflight.add(p)
      void p.finally(() => inflight.delete(p))
    },
    onClose: requestQuit,
  })
  prompt.start()
  // Concurrent with the command loop; never resolves. A throw that escapes the
  // loop's own try shouldn't become a silent unhandled rejection.
  void pollFeed(agent, seen, intervalMs, SEEN_CAP, hooks).catch((err) => {
    process.stderr.write(
      `aitty: poll loop stopped (${err instanceof Error ? err.message : String(err)})\n`,
    )
    process.exit(1)
  })
}
