// The interactive prompt's input layer: a small raw-mode single-line editor
// with an inline @-mention picker (a Slack-style dropdown that filters the AIT
// directory as you type, navigated with ↑/↓ and accepted with Enter/Tab).
//
// Why not readline: readline hardwires ↑/↓ to history, Tab to its completer,
// and Enter to submit, with no clean way to repurpose them while a dropdown is
// open. So we own the keys directly — `readline.emitKeypressEvents` still does
// the escape-sequence decoding (we get {name,ctrl,…}), we just don't use its
// line Interface.
//
// Rendering stays append-only (no alternate screen, native scrollback intact).
// The input region — the prompt line plus the dropdown below it — is always
// pinned at the bottom; feed posts are printed above it via printAbove(). Every
// cursor move is RELATIVE (up N rows, absolute column), so drawing the dropdown
// at the bottom of the screen (which scrolls the terminal) doesn't desync us:
// the scroll moves cursor and prompt together, and "up N" still lands home.
//
// Single-row input is assumed (prompt + line ≤ terminal width); AIT commands and
// handles are short. A line longer than the width wraps and the redraw math can
// smear — an accepted v1 limitation, not a correctness risk for the data.

import * as readline from 'node:readline'
import type { Styles } from './render.js'
import type { ActorBasic } from './agent.js'

const CSI = '\x1b['
const PROMPT = '› '
const PROMPT_WIDTH = 2 // visible width of PROMPT
const MAX_ROWS = 6 // dropdown rows shown at once

// The token under the cursor that the picker completes. `start` is the index in
// the line where replacement begins; `query` is what we search for; `withAt`
// records whether to prefix the inserted handle with '@'. Returned by the
// caller-supplied finder so command-specific knowledge stays out of here.
export interface CompletionToken {
  start: number
  query: string
  withAt: boolean
}

export interface MentionPromptOptions {
  styles: Styles
  // Find the completable token at the cursor, or null if none. Pure function of
  // (line, cursor) — see interactive.ts for the @-mention / handle-arg rules.
  findToken: (line: string, cursor: number) => CompletionToken | null
  // Directory search for the dropdown (ait.actor.searchActors). Should resolve
  // to [] rather than throw; the picker treats a rejection as "no matches".
  search: (query: string) => Promise<ActorBasic[]>
  onLine: (line: string) => void // a submitted (Enter) line
  onClose: () => void // Ctrl-C on an empty prompt, or Ctrl-D
}

export class MentionPrompt {
  private line = ''
  private cursor = 0 // index into line, 0..line.length

  // Picker state. `open` gates whether the dropdown shows and steals ↑/↓/Enter;
  // `searching` distinguishes an in-flight query from a resolved-empty result.
  private open = false
  private searching = false
  private results: ActorBasic[] = []
  private selected = 0
  private activeQuery = '' // the query the current `results` are for
  private queryToken = 0 // bumped per search; late responses with a stale token are dropped

  private readonly styles: Styles
  private readonly findToken: MentionPromptOptions['findToken']
  private readonly search: MentionPromptOptions['search']
  private readonly onLine: MentionPromptOptions['onLine']
  private readonly onClose: MentionPromptOptions['onClose']
  private readonly onKeypress = (str: string | undefined, key: KeyEvent): void =>
    this.handleKey(str, key)

  constructor(opts: MentionPromptOptions) {
    this.styles = opts.styles
    this.findToken = opts.findToken
    this.search = opts.search
    this.onLine = opts.onLine
    this.onClose = opts.onClose
  }

  start(): void {
    readline.emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.on('keypress', this.onKeypress)
    process.stdin.resume()
    this.render()
  }

  close(): void {
    process.stdin.off('keypress', this.onKeypress)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    // Drop the dropdown and leave the cursor on a fresh line below the prompt.
    this.closePicker()
    process.stdout.write('\n')
  }

  // Print a block above the pinned prompt (a feed post, a warning, a command
  // result). Clears the input region, writes the text into the scrollback, then
  // redraws the prompt + dropdown at the new bottom.
  printAbove(text: string): void {
    process.stdout.write('\r' + CSI + '0J') // erase prompt row + dropdown below
    process.stdout.write(text + '\n\n')
    this.render()
  }

  // --- input -----------------------------------------------------------------

  private handleKey(str: string | undefined, key: KeyEvent): void {
    if (!key) return

    // Ctrl-C: dismiss the picker if open, otherwise quit. Ctrl-D: quit on empty.
    if (key.ctrl && key.name === 'c') {
      if (this.open) return this.closePickerAndRender()
      return this.onClose()
    }
    if (key.ctrl && key.name === 'd') {
      if (this.line === '') return this.onClose()
      return
    }

    switch (key.name) {
      case 'return':
      case 'enter': // some terminals/pastes send LF (\n) for Enter, not CR
        return this.onReturn()
      case 'tab':
        if (this.open && this.results.length > 0) return this.accept()
        return // no readline-style completion fallthrough; the picker is it
      case 'escape':
        if (this.open) return this.closePickerAndRender()
        return
      case 'up':
        if (this.open) return this.move(-1)
        return
      case 'down':
        if (this.open) return this.move(1)
        return
      case 'left':
        if (this.cursor > 0) this.cursor--
        return this.afterEdit()
      case 'right':
        if (this.cursor < this.line.length) this.cursor++
        return this.afterEdit()
      case 'home':
        this.cursor = 0
        return this.afterEdit()
      case 'end':
        this.cursor = this.line.length
        return this.afterEdit()
      case 'backspace':
        if (this.cursor > 0) {
          this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor)
          this.cursor--
        }
        return this.afterEdit()
    }

    // Ctrl-a / Ctrl-e as home/end (common shell muscle memory).
    if (key.ctrl && key.name === 'a') {
      this.cursor = 0
      return this.afterEdit()
    }
    if (key.ctrl && key.name === 'e') {
      this.cursor = this.line.length
      return this.afterEdit()
    }

    // A printable character (not a control/meta chord). Insert at the cursor.
    if (str && !key.ctrl && !key.meta && str >= ' ') {
      this.line = this.line.slice(0, this.cursor) + str + this.line.slice(this.cursor)
      this.cursor += str.length
      return this.afterEdit()
    }
  }

  private onReturn(): void {
    if (this.open && this.results.length > 0) return this.accept()
    const submitted = this.line
    // Echo the submitted line into scrollback (clearing any dropdown first), so
    // the conversation keeps a record of what you typed; then reset and hand
    // off. The command printAbove()s its result above the fresh prompt.
    process.stdout.write('\r' + CSI + '0J' + this.styles.dim(PROMPT) + submitted + '\n')
    this.line = ''
    this.cursor = 0
    this.closePicker()
    this.render()
    this.onLine(submitted)
  }

  // Recompute the active token after any line edit and refresh the picker.
  private afterEdit(): void {
    const token = this.findToken(this.line, this.cursor)
    if (!token || token.query.length === 0) {
      this.closePicker()
      return this.render()
    }
    if (token.query !== this.activeQuery || !this.open) {
      this.runSearch(token)
    }
    this.render()
  }

  private runSearch(token: CompletionToken): void {
    this.open = true
    this.searching = true
    this.activeQuery = token.query
    const myToken = ++this.queryToken
    void this.search(token.query).then((actors) => {
      if (myToken !== this.queryToken) return // a newer keystroke superseded this
      this.searching = false
      this.results = actors
      this.selected = 0
      this.render()
    })
  }

  private move(delta: number): void {
    if (this.results.length === 0) return
    this.selected =
      (this.selected + delta + this.results.length) % this.results.length
    this.render()
  }

  // Replace the active token with the selected handle, then drop the picker.
  private accept(): void {
    const token = this.findToken(this.line, this.cursor)
    const choice = this.results[this.selected]
    if (!token || !choice) return this.closePickerAndRender()
    const insert = (token.withAt ? '@' : '') + choice.handle + ' '
    this.line = this.line.slice(0, token.start) + insert + this.line.slice(this.cursor)
    this.cursor = token.start + insert.length
    this.closePicker()
    this.render()
  }

  private closePicker(): void {
    this.open = false
    this.searching = false
    this.results = []
    this.selected = 0
    this.activeQuery = ''
    this.queryToken++ // invalidate any in-flight search
  }

  private closePickerAndRender(): void {
    this.closePicker()
    this.render()
  }

  // --- rendering -------------------------------------------------------------

  // Redraw the input region in place. Invariant on entry AND exit: the terminal
  // cursor sits on the prompt row. So: return to column 0, clear that row and
  // everything below (the old dropdown), draw the prompt + line, draw the
  // dropdown beneath, then move back up to the prompt row and out to the edit
  // column.
  private render(): void {
    let out = '\r' + CSI + '0J'
    out += this.styles.dim(PROMPT) + this.line

    const rows = this.open ? this.dropdownRows() : []
    for (const row of rows) out += '\n' + row
    if (rows.length > 0) out += CSI + rows.length + 'A' // back up to the prompt row

    const col = PROMPT_WIDTH + this.cursor + 1 // 1-based terminal column
    out += CSI + col + 'G'
    process.stdout.write(out)
  }

  private dropdownRows(): string[] {
    const dim = this.styles.dim
    if (this.results.length === 0) {
      return [
        dim(
          this.searching
            ? `  (searching "${this.activeQuery}"…)`
            : `  (no matches for "${this.activeQuery}")`,
        ),
      ]
    }
    const shown = this.results.slice(0, MAX_ROWS)
    const rows = shown.map((actor, i) => {
      const handle = '@' + actor.handle
      const name = actor.displayName ? '  ' + actor.displayName : ''
      const label = handle + name
      // Selected row: a ›-marker + emphasized handle. Others: dim, indented.
      return i === this.selected
        ? this.styles.mention('› ' + label)
        : dim('  ' + label)
    })
    if (this.results.length > MAX_ROWS) {
      rows.push(dim(`  …+${this.results.length - MAX_ROWS} more`))
    }
    return rows
  }
}

// The shape readline's keypress events hand us (a subset of the `Key` type).
interface KeyEvent {
  name?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}
