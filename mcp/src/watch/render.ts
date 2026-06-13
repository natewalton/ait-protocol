// Terminal rendering for the watcher's feed. Append-only streaming output
// (chat / `tail -f` style), not a full-screen TUI — keeps native scrollback.
//
// Design follows clig.dev and no-color.org: color is opt-out and semantic, on
// the 4-bit ANSI palette so it adapts to the user's light/dark theme; we never
// rely on color alone (the `@` stays on mentions, `↳` marks replies, the body
// is indented); important fields (the author) are emphasized, the timestamp is
// dimmed.

import type { FeedItem } from './agent.js'

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  underline: '\x1b[4m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
}

// Color only when stdout is an interactive terminal and the user hasn't opted
// out (NO_COLOR, TERM=dumb, or --no-color). Piping to a file or `| cat` yields
// clean plain text.
export function supportsColor(noColorFlag: boolean): boolean {
  if (noColorFlag) return false
  if (!process.stdout.isTTY) return false
  if (process.env.NO_COLOR) return false
  if (process.env.TERM === 'dumb') return false
  return true
}

export interface Styles {
  dim: (s: string) => string
  handle: (s: string) => string
  mention: (s: string) => string
  url: (s: string) => string
  hashtag: (s: string) => string
}

export function makeStyles(color: boolean): Styles {
  const wrap = (...codes: string[]) => (s: string) =>
    color ? codes.join('') + s + ANSI.reset : s
  return {
    dim: wrap(ANSI.dim),
    handle: wrap(ANSI.bold, ANSI.cyan),
    mention: wrap(ANSI.bold, ANSI.magenta),
    url: wrap(ANSI.underline, ANSI.blue),
    hashtag: wrap(ANSI.yellow),
  }
}

export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(then).toISOString().slice(0, 10)
}

// Word-wrap to `width`, preserving the post's own newlines. Tokens longer than
// width (e.g. a long URL) are left to overflow rather than hard-broken.
function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/ +/)) {
      if (line === '') {
        line = word
      } else if (line.length + 1 + word.length <= width) {
        line += ' ' + word
      } else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

// Hashtags allow hyphens (AIT handles/topics are hyphen-heavy, e.g. #some-feature).
const TOKEN_RE = /(https?:\/\/\S+)|(@[a-zA-Z0-9][a-zA-Z0-9._-]*)|(#[a-zA-Z0-9_][a-zA-Z0-9_-]*)/g

// Style @mentions, URLs, and #hashtags inline. Applied per already-wrapped line
// so the styling never throws off width math.
function highlight(line: string, styles: Styles): string {
  return line.replace(TOKEN_RE, (match, urlTok, mentionTok, hashTok) => {
    if (urlTok) return styles.url(match)
    if (mentionTok) return styles.mention(match)
    if (hashTok) return styles.hashtag(match)
    return match
  })
}

export interface RenderOptions {
  styles: Styles
  now: number
  width: number
  // Handle of the post this one replies to, if known. null/undefined → the
  // post isn't a reply, or the parent couldn't be resolved.
  parentHandle?: string | null
  isReply: boolean
}

// One post, ready to print. Caller adds a blank line between posts.
export function renderPost(item: FeedItem, opts: RenderOptions): string {
  const { styles, now, width, parentHandle, isReply } = opts
  const post = item.post
  const handle = post.author.handle ?? post.author.did

  const rel = relativeTime(post.record.createdAt ?? post.indexedAt, now)
  const metaBits = [rel]
  if (isReply) {
    metaBits.push(parentHandle ? `↳ replying to @${parentHandle}` : '↳ reply')
  }
  const meta = metaBits.filter(Boolean).join(' · ')
  const header =
    styles.handle(`@${handle}`) + (meta ? '  ' + styles.dim(`· ${meta}`) : '')

  const bodyWidth = Math.max(20, width - 2)
  const body = wrapText(post.record.text ?? '', bodyWidth)
    .map((line) => '  ' + highlight(line, styles))
    .join('\n')

  return body ? `${header}\n${body}` : header
}

export function feedWidth(): number {
  return Math.min(process.stdout.columns || 80, 80)
}
