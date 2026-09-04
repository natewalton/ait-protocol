# Let users restart a recently closed session immediately

**Status:** Proposed, 2026-09-04  
**Tracker:** [#31](https://github.com/natewalton/ait-protocol/issues/31)

## Why

`ait resume` currently uses AppView presence as an absolute exclusion. AppView
marks a handle live for five minutes after its latest registration
(`appview/src/pushRegistry.ts:28-31,129-132`), while each reachable MCP renews
every 30 seconds (`mcp/src/push.ts:46,81-89`). The picker separates every local
session into live or offline sets and refuses an exact live match
(`mcp/src/sessionPicker.ts:224-264,380-405`).

That is conservative after a crash, but it also blocks a normal operator action:
exit a session so a new MCP build or harness version loads, then immediately
resume that same conversation. The operator sees “not resumable” and must wait
up to five minutes even though they know they just closed it. Issue #31 records
this observed workflow and the requested confirmation model.

The fix is to keep presence conservative while treating it as advisory for one
unambiguous, exact, human-initiated resume. `ait resume` is already restricted to
an unmarked human terminal before discovery or launch (`ait:295-316,390-404`),
so its existing confirmation channel is the appropriate authority boundary.

## Proposed work

Keep the five-minute presence window, 30-second renewal, normal table, hidden-live
count, ordering, and partial search behavior unchanged.

When an exact handle, Claude conversation UUID, or Codex thread ID resolves to
exactly one session which AppView reports live, do not claim that it is
definitively open. Print:

```text
@handle checked in within the last five minutes and may still be open.
Resume it anyway? [y/N]
```

Only `y` or `yes`, case-insensitively, selects that exact session. Empty input,
EOF, `Ctrl-C`, and every other answer cancel without launching a harness and
report that resume was cancelled. An exact query which maps to more than one
session remains ambiguous and launches nothing. Exact offline matches continue
to select immediately without confirmation.

A partial query never overrides presence. It searches only the offline set as it
does today, even if it happens to narrow to one live session. With no query, live
sessions remain hidden from the table and counted in the existing footer.

Update `ait help resume` and the README’s resume guidance so users can discover
the recently-live confirmation and understand that its default is safe.

This is one existing presence decision with a human override. It adds no state,
timer, liveness probe, unregister operation, retry, flag, or harness-specific
branch.

## Files touched

Four implementation and user-facing files:

1. `mcp/src/sessionPicker.ts`: prompt and exact-match selection behavior.
2. `mcp/scripts/session-picker-test.mjs`: deterministic selection regressions.
3. `ait`: `ait help resume` text.
4. `README.md`: operator guidance.

This spec is a fifth changed path in the spec commit only; the implementation
must leave it unchanged.

## Out of scope

- Changing the five-minute presence lease or 30-second renewal cadence.
- Adding explicit unregister-on-exit behavior for Claude or Codex.
- Probing the old MCP callback to decide whether a session is still running.
- Adding a force flag, configuration setting, persisted override, or automatic
  resume after a delay.
- Showing live sessions in the ordinary no-query table or allowing partial
  searches to bypass the guard.
- Changing harness resume commands, AIT identities, or the operator-only command
  boundary.

## Tests

Extend `mcp/scripts/session-picker-test.mjs` and run it after rebuilding MCP:

1. The no-query table still excludes live sessions and prints the hidden count.
2. An exact offline handle and each harness’s exact identifier select immediately
   without a confirmation prompt.
3. An exact live handle, Claude UUID, and Codex thread ID each print the
   recently-live warning. `y` and mixed-case `yes` select only that row.
4. Empty input, `n`, arbitrary text, EOF, and `Ctrl-C` cancel a recently-live
   selection and emit no launcher selection.
5. A partial query which matches a live session does not prompt or select it.
6. Duplicate exact handles remain ambiguous across the live and offline sets.
7. An unavailable AppView still refuses all selection without offering an
   override.
8. Removing the confirmation path makes the focused regression fail.

Run `bin/ait-test.sh` to prove public dispatch, help, operator-only refusal,
ordinary selection, and both launcher shims remain intact. Run both suites in the
foreground and as synchronized background jobs; neither may touch live sessions
or services.

The production oracle uses one controlled Claude session and one controlled
Codex session. For each: record its handle and identifier, exit normally, run
`ait resume <exact-identifier>` before the five-minute lease expires, confirm
`yes`, and verify that the original conversation, project, and AIT handle return
without another `join`. Repeat once with `n` and verify no harness launches. A
currently open session is never used for the confirming leg.

## Rollout

Ship one patch release after exact-revision review and both harness oracles pass.
No migration or service restart is required; the MCP build carries the selector
change and existing installations receive it through `ait update`. Rollback is
the prior release and restores the absolute live-session refusal without changing
any session, identity, or presence data.

Done means a user can deliberately close and immediately resume a known Claude
or Codex conversation through the released CLI, the default-no path launches
nothing, normal live-session filtering remains unchanged, and the controlling
reviewer reproduces the released result.

## What was rejected

- **Shorten the presence lease:** makes ordinary presence less tolerant of
  delayed heartbeats while still imposing a wait.
- **Unregister on session exit:** adds lifecycle messages and race handling for a
  workflow already authorized by a human confirmation; crashes still need expiry.
- **Probe the callback before resume:** creates a second liveness system and adds
  network timing to a local selection decision.
- **Add `--force`:** another public option for a decision the existing human
  prompt can express more safely and clearly.
- **Show every live session:** reverses the table behavior users requested and
  increases the chance of resuming a genuinely open conversation.

## Sources

- `appview/src/pushRegistry.ts:28-31,129-132`: current presence lease.
- `mcp/src/push.ts:46,81-89`: current renewal loop.
- `mcp/src/sessionPicker.ts:224-264,380-405`: live partition and refusal.
- `ait:148-166,295-316,390-404`: resume help, human-only boundary, and dispatch.
- `mcp/scripts/session-picker-test.mjs:205-219`: current live-session regression.
- `specs/resume-session-by-handle.md:61-82,193-201`: shipped resume contract and
  five-minute post-exit limitation.
- [Issue #31](https://github.com/natewalton/ait-protocol/issues/31): operator
  report and agreed outcome.
