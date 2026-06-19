# aitty interactive view → ink (migrate off the hand-rolled raw-mode editor)

Status: spec (proposed)

aitty's interactive mode is a **chat TUI**: a feed scrolling upward, a prompt
pinned at the bottom, and a live `@`-handle dropdown. The current implementation
hand-rolls that with raw-mode keypress handling and manual ANSI cursor math
(`mcp/src/aitty/picker.ts` + the `printAbovePrompt` redraw in `interactive.ts`).
That reinvents what a terminal-UI framework already does correctly, and it has
already produced real bugs — most recently the line-wrap cascade (fixed in
`0a46aaf` with a single-row horizontal viewport, a workaround that also caps the
input to one visible row).

This spec proposes migrating the interactive view to **[ink](https://github.com/vadimdemedes/ink)**
(React for terminals), which is the standard foundation for this exact shape.

## Why ink (and not the alternatives)

The decisive fit is **`<Static>`**: ink renders `<Static>` items once, commits
them above the live region, and never re-renders them — which *is* aitty's
append-only feed (posts scroll into native scrollback and are never redrawn).
The dynamic region below (prompt + dropdown) is the only thing ink re-renders,
and ink owns the cursor math, line wrapping, width/resize, and Unicode width
(`string-width`) — exactly the things the hand-rolled editor gets wrong.

- **`blessed` / `neo-blessed`** — full-screen alternate-buffer TUIs; they take
  over the screen and lose native scrollback. Wrong model for an append-only
  chat log.
- **`enquirer` / `@inquirer/prompts` autocomplete** — modal one-shot prompts;
  they own the terminal for a single question and don't compose with a feed
  streaming above a persistent prompt.
- **plain `readline`** — correct line editing, but no live ↑/↓ dropdown (it owns
  those keys for history); layering the picker back on top is the friction that
  caused the hand-roll in the first place.

ink is the only option whose core model (static scrollback + a small reactive
live region + `useInput`) matches aitty's interactive loop directly.

## Scope

**Migrates** (the interactive TTY view only):
- `mcp/src/aitty/interactive.ts` — `printAbovePrompt`/`emit` redraw loop and the
  `MentionPrompt` wiring become an ink render tree.
- `mcp/src/aitty/picker.ts` — the raw-mode editor + dropdown are replaced by ink
  components; the file is deleted.

**Stays untouched** (no ink dependency leaks into these):
- One-shot subcommands (`main.ts`: `post`/`reply`/`notifs`/`profile`/`thread`/
  `watch`) — plain stdout, as today. ink is interactive-mode only.
- The non-TTY / piped path — stays plain streaming (no ink when stdout isn't a TTY).
- `agent.ts` (XRPC ops incl. `fetchSearchActors`), `commands.ts` (action\*),
  `stream.ts` (poll/backlog engine), `feed.ts`/`render.ts` (post formatting),
  `identity.ts`. The feed engine keeps driving; only the *sink* changes from
  `printAbovePrompt` to React state.

## Design

Component tree (interactive mode):

```
<App>
  <Static items={posts}>            {/* committed feed → scrollback, never re-rendered */}
    {(post) => <PostView key={post.uri} post={post} n={post.n} />}
  </Static>
  <Box flexDirection="column">      {/* the only live/re-rendered region */}
    <InputLine prompt="› " />        {/* controlled text input (ink-text-input or custom) */}
    {picker.open && <Dropdown results={picker.results} selected={picker.selected} />}
  </Box>
</App>
```

- **Feed → `<Static>`.** The poll engine's `onItem` hook pushes each numbered
  post into a React store; `<Static>` commits them above the input. Native
  scrollback is preserved by construction (the whole reason `<Static>` exists).
  `PostView` renders via `<Text>`/`<Box>` (reusing `render.ts`'s highlight/relative-
  time logic, or porting it to ink `<Text>` color props).
- **Input + picker → `useInput` + a controlled value.** `useInput` handles
  printable chars, backspace, cursor, Enter, Tab, Esc, ↑/↓ — ink resolves the
  escape sequences and does the line layout/wrapping. The `@`-token detection
  (`findToken`) and the debounced `searchActors` query move into a hook; results
  feed `<Dropdown>`. ↑/↓/⏎/Tab are intercepted only while `picker.open`, exactly
  as today — but without any manual cursor math.
- **Submit.** On Enter (picker closed) the line dispatches through the existing
  `handleCommand`; results print by pushing into the same `<Static>` feed store
  (so command output and feed posts share one scrollback). The numbered-post
  index (`reply <n>`/`thread <n>`) stays.
- **Lifecycle.** `render(<App/>)` returns an ink instance; `app.waitUntilExit()`
  replaces the readline `close` plumbing. Ctrl-C / Ctrl-D and the in-flight-write
  drain on quit map to ink's exit handling + the existing `inflight` set.

## Migration plan (incremental, each step shippable)

1. **Add deps** to `mcp/package.json`: `ink`, `react`, `ink-text-input`
   (+ `@types/react`, `ink-testing-library` dev). Confirm ESM/TS config compiles
   (the package is already ESM).
2. **Port `PostView` + the feed store** behind a flag; render the live feed
   through `<Static>` while keeping the current input. Verify scrollback + the
   numbered index are unchanged.
3. **Port the input + `@` picker** to `useInput` + `<Dropdown>`, driven by
   `findToken` + `fetchSearchActors`. Delete `picker.ts`.
4. **Cut over `runInteractive`** to mount the ink app; delete `printAbovePrompt`
   and the raw-mode plumbing. Keep the non-TTY path untouched.
5. **Tests** with `ink-testing-library` (assert the rendered frame for: a streamed
   post, typing `@wa` → dropdown, accept inserts the handle, a wrapped long line,
   submit). Replaces the brittle PTY harnesses.

## Risks / trade-offs

- **New dependencies** (ink + react) in `mcp`. Footprint is interactive-mode only;
  one-shots and the MCP server tools never import ink. Acceptable for a client.
- **Bridging async → React.** The poll loop is imperative; bridge it to state via
  a tiny store/emitter the `<App>` subscribes to. Low risk, well-trodden.
- **Behaviour parity.** Must preserve: pinned prompt, streaming above, numbered
  posts + `reply <n>`/`thread <n>`, the full command set, the `@` picker UX
  (↑/↓/⏎/tab/esc), `NO_COLOR`/non-TTY fallback, Ctrl-C quit with in-flight drain.
- **Wins:** correct wrapping/cursor/resize/Unicode width for free; multi-line
  input becomes possible; testable via `ink-testing-library` instead of PTY
  byte-poking; a component model for future affordances (thread view, reactions).

## Out of scope

The one-shot subcommands and `watch` (they stay plain stdout); the push/
notification subsystem; any AppView change. This is purely the interactive
client's render + input layer.
