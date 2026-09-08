# Return the terminal after cancelling resume

Status: implemented and locally validated, 2026-09-08.

## Why

An AIT operator pressing `Ctrl-C` at the `ait resume` picker in Terminal sees the
cancellation message and a new zsh prompt, but Terminal still reports a running
process when the window is closed. A production-shaped PTY replay on 2026-09-08
ran the installed selector from `/Users/nwalton/Desktop/lawsuits`, sent `Ctrl-C`,
waited for the zsh prompt, then ran
`ps -axo pid,ppid,pgid,state,command | grep sessionPicker`. It returned
`node /Users/nwalton/Desktop/ait-protocol/mcp/dist/sessionPicker.js`, proving the
selector was still alive after control appeared to return.

The released public command runs the interactive selector inside Bash command
substitution (`8791a3a:ait:415`). Bash therefore collects the machine-readable
selection through a subshell that receives the same terminal `SIGINT`; the outer
zsh can resume while the selector is still handling cancellation. GNU Bash
documents both the subshell boundary created by command substitution and the
special signal behavior of a non-interactive shell waiting for a foreground
command.

## Proposed work

Use the crude shell-native fix: run the interactive selector as the foreground
command, make the Bash wrapper catch `SIGINT` while it waits, redirect only the
selector's machine-readable stdout to a temporary file, and read that file only
after the selector finishes. The child retains normal `SIGINT` delivery; the
wrapper propagates its status after cleanup. `Ctrl-C` must print the cancellation
result, exit with status 130, leave no selector process alive, and return a usable
shell prompt. EOF and ordinary selection retain their existing statuses and output.

## Files touched

Three files:

1. `ait` waits for the foreground selector under a scoped interrupt trap and captures its stdout safely.
2. `mcp/scripts/session-picker-test.mjs` proves a PTY cancellation finishes before the parent shell prompt and leaves no selector child alive.
3. `specs/resume-cancellation-exit.md` records the behavior and evidence.

## Out of scope

- Harness shutdown after a session has been selected and launched.
- Session discovery, presence checks, table rendering, or resume eligibility.
- Changing the selector's prompt, discovery, or signal behavior.

## Tests

Run `npm --prefix mcp run build`, `node mcp/scripts/session-picker-test.mjs`, and
`bin/ait-test.sh`. Replay the installed `ait resume` command in a real zsh PTY,
press `Ctrl-C`, and verify no `sessionPicker.js` process remains after the prompt.

## Sequencing or rollout

Ship as a patch release after the focused and CLI suites pass. No migration is
needed. Rollback restores the prior selector and its known orphan-process bug.

## What was rejected

- An `ait` shell signal trap without removing command substitution: the nested
  subshell would still own the selector and its captured output.
- Calling `process.exit()` in the selector signal handler: it can abandon
  buffered output and still leaves an interactive program inside a subshell.
- Releasing or destroying stdin: negative-control testing showed the full-path
  regression still passed without that change, so it did not establish causality.
- A timeout or delayed kill: timing does not establish lifecycle correctness.

## Sources

- Node.js Process documentation, signal events:
  https://nodejs.org/api/process.html#signal-events
- Node.js Readline documentation, stdin process lifetime:
  https://nodejs.org/api/readline.html#readline
- GNU Bash manual, signals while waiting for foreground commands:
  https://www.gnu.org/software/bash/manual/html_node/Signals.html
- GNU Bash manual, command substitution:
  https://www.gnu.org/software/bash/manual/html_node/Command-Substitution.html
