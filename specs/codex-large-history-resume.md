# Resume very long Codex sessions

Status: Shipped in the commit containing this spec

Date: 2026-08-15

Files: 4 (`bin/codex-session.sh`, `mcp/src/codex/appServerClient.ts`, `mcp/src/codex/tuiRelay.ts`, this spec)

Upstream: [openai/codex#19837](https://github.com/openai/codex/issues/19837#issuecomment-5304695746)

## Current experience

Someone resumes an AIT-backed Codex session with
`bin/codex-session.sh --resume <thread-id>`. The driver first restores the
thread on the shared app-server (`mcp/src/codex/host.ts:149` at commit
`c2f4e6e`), then the launcher runs `codex resume <thread-id> --remote` against
that server (`bin/codex-session.sh:111` at `c2f4e6e`).

The existing 1 GiB AIT client limit lets the driver restore a large session
(`mcp/src/codex/appServerClient.ts:40` at `c2f4e6e`), but it does not change the
separate Codex TUI client. A protocol trace captured on 2026-08-15 against
codex-cli 0.147.0 showed this sequence after the driver had resumed the thread:

```text
C>S method=thread/read includeTurns=-
S>C method=response turns=0
C>S method=thread/resume
S>C method=response
C>S method=thread/read includeTurns=true
```

With a synthetic full-history response of 70 MiB, the TUI opened. At 130 MiB,
the same command exited with the production error:

```text
Error: Failed to resume session from ...jsonl: thread/read failed during TUI session lookup
```

The app-server thread remains live; only the TUI's eager transcript download
fails. The result today is that the terminal prints the error and the launcher
stops the critical session instead of opening it.

## Crude version

The crude fix is to raise AIT's WebSocket payload limit again. That cannot work:
the driver already succeeds, and the failing receiver is the independently
compiled Codex TUI. Waiting longer also cannot change a message-size rejection.

Editing, truncating, or compacting the rollout would make the message smaller,
but it would alter the history the operator explicitly needs to preserve. Plain
`codex resume` avoids the remote transport but disconnects the TUI from the
shared app-server that delivers AIT notifications.

## Smallest acceptable change

Keep the direct TUI attach as the normal path. If and only if a requested resume
returns nonzero, retry once through a local relay scoped to that thread ID. The
relay forwards the Codex protocol unchanged except for
`thread/read { includeTurns: true }` on the target thread, which becomes
`includeTurns: false`.

At that point the shared app-server has already resumed the complete thread and
the driver remains connected to it. The changed read controls only what old
turns the TUI paints; it does not write the rollout, replace the app-server
thread, or change the model's resumed context. New turns and AIT notifications
continue over the same live thread.

The relay starts only for the failed-resume recovery path, uses the same bounded
payload setting as the AIT client, and is stopped with the session driver.

## What people see

This affects an operator resuming a history large enough to exceed the remote
TUI's receive ceiling. On the terminal screen, the existing error is followed
by:

```text
codex-session: direct TUI attach failed; retrying large-history recovery.
codex-session: full model context is preserved; old turns may be omitted from the TUI display.
```

The TUI then opens on the resumed thread. Its old transcript is blank in this
recovery mode, while subsequent turns appear normally. Successful direct
attaches and all new-session launches remain unchanged.

## Failure behavior

- A relay startup failure or ten-second startup timeout exits with the original
  attach status and leaves the driver log path visible.
- An unrelated resume failure gets one recovery attempt, then returns the second
  failure; there is no retry loop and no rollout mutation.
- Reads for another thread, binary messages, malformed JSON, and every method
  other than the target thread's full-history read pass through unchanged.
- Exiting either TUI path stops the per-session relay and driver but leaves the
  shared app-server running, matching the current launcher contract.
- The missing old transcript is an explicit, accepted presentation limitation;
  silently changing or deleting model history is not accepted.

## Verification

The change is complete only when all of these pass:

1. TypeScript compilation and `bash -n bin/codex-session.sh`.
2. Focused checks prove only the exact target thread's full-history request is
   rewritten.
3. A direct TUI attach through a proxy carrying a 130 MiB response reproduces
   the exact failure above.
4. The same TUI attach through the recovery relay reaches the interactive screen
   while the synthetic upstream confirms no full-history payload was sent.
5. A normal small-thread direct attach still reaches the interactive screen
   without starting the relay.
6. The worktree diff contains only the four counted files, and the change is
   committed and pushed directly to `main` without a pull request.

## Rejected options

- Raise the AIT client limit again: wrong receiver; the TUI still fails.
- Add another launcher wait: wrong failure mode; no timeout is involved.
- Truncate, rewrite, or compact the rollout: risks the critical history.
- Always put a relay in front of every TUI: adds a process and protocol boundary
  to healthy sessions for no user benefit.
- Fall back to non-remote `codex resume`: loses the shared app-server connection
  required for AIT notification delivery.
- Wait for another Codex release: stable 0.147.0 still reproduces a bug reported
  as fixed after 0.125.0, and the operator needs to recover the session now. The
  compatibility path can be removed after an upstream release passes the 130 MiB
  reproduction.

## Out of scope

- Patching or replacing the installed Codex binary; the upstream regression is
  reported on openai/codex#19837.
- Rendering the old transcript in the fallback TUI. That requires an upstream
  paginated or lazy history API rather than one oversized WebSocket message.
- Changing, compacting, or deleting any saved rollout.
- Changing the shared app-server, AIT identity, or notification-delivery design.
- Opening a pull request in this repository.
