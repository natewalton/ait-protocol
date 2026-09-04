# Keep operator-only AIT commands out of agent sessions

Status: shipped in [AIT v0.1.12](https://github.com/natewalton/ait-protocol/releases/tag/v0.1.12),
2026-09-04. Tracked by [#30](https://github.com/natewalton/ait-protocol/issues/30).

## Outcome

A human can still run `ait resume`, `ait uninstall`, and `aitty` from an
interactive terminal. Claude and Codex sessions receive the same clear refusal
before those operator-only clients select another session, prompt for an
uninstall, or mutate anything.

The visible change is on the terminal surface: a human sees the existing resume
selector or uninstall confirmation, while a Claude or Codex session sees the
public CLI refusal on stderr in its shell-tool result.

This is intentional friction against accidental identity borrowing or machine
administration. It is not a security boundary against a process that already
has the user's terminal and filesystem privileges.

## Why

`ait resume` selects a stopped AIT-bound Claude or Codex conversation and
launches its harness with that conversation's exact resume identifier
(`ait:377-395`). It does not transfer an AIT identity, but an agent shell can
currently invoke it and start another conversation under that conversation's
existing identity.

`ait uninstall` is also an operator command. Its private implementation checks
ownership and active sessions and requires the literal confirmation
`uninstall AIT` (`bin/uninstall.sh:27-79`), but an agent should be refused by
the public CLI before it reaches those steps.

AIT already uses the appropriate control for the comparable `aitty` operator
client. `refuseWhenDrivenByAnAgent()` refuses known harness markers or stdin
without a TTY, explains the boundary, and explicitly calls itself a deterrent
rather than a hard sandbox (`mcp/src/aitty/main.ts:96-142`,
`docs/aitty.md:126-141`).

The current Codex tool shell was measured with `CODEX_SESSION_ID`,
`CODEX_THREAD_ID`, and `AI_AGENT` set. The existing aitty marker list includes
Claude markers, `AI_AGENT`, and `AIT_SESSION_ID`, but not the two explicit
Codex markers (`mcp/src/aitty/main.ts:99-105`). The public CLI has no equivalent
operator-terminal check.

The crude version is sufficient: copy aitty's two-signal decision into the
public shell dispatcher for the two affected commands and add the missing Codex
marker names to aitty. No stronger authority exists at this layer, so more
machinery would not make the boundary more truthful.

## What changes

Add one small shell function in the public `ait` dispatcher. Before dispatching
`resume` or `uninstall`, it accepts only when stdin is a TTY and none of these
supported-harness markers is set:

- Claude: `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_ENTRYPOINT`;
- Codex: `CODEX_SESSION_ID`, `CODEX_THREAD_ID`, `AIT_SESSION_ID`;
- shared: `AI_AGENT`.

Otherwise it exits 2 before selection, launch, confirmation, or mutation. The
message says the command is for the human operator and that this check deters
accidental use rather than securing a full-privilege shell. For `resume`, it
also tells the session to ask the operator to run the command. For `uninstall`,
it tells the session to ask the operator to confirm and run it.

An existing automation that drives `ait resume` or `ait uninstall` without a
TTY will stop working and receive that refusal. This is intentional: both
commands require a human choice or confirmation. Other commands and ordinary
human terminals are unchanged.

Use the same explicit marker vocabulary in aitty's existing runtime check.
Its policy and TTY behavior do not otherwise change.

Do not add a flag, persisted state, password, token, daemon, privilege model,
or harness-specific execution path.

## Files

Five files are expected:

1. `ait` adds the operator-terminal check and calls it only for `resume` and
   `uninstall` before either command performs work.
2. `mcp/src/aitty/main.ts` adds the explicit Codex marker names to the existing
   runtime policy.
3. `bin/ait-test.sh` covers public CLI behavior without launching or
   uninstalling anything.
4. `bin/ait-uninstall-test.sh` exercises uninstall implementation behavior by
   calling `bin/uninstall.sh` directly instead of routing its piped confirmation
   fixtures through the now-interactive public command.
5. `README.md` names `resume`, `uninstall`, and aitty as human-operator
   surfaces and accurately describes the check as friction, not security.

The five-file spread reflects three existing consumers in two languages plus
their behavioral tests and public documentation. It introduces one policy, not
five mechanisms.

## Why this stays small

The system has three concepts already present in the code: the two
operator-only commands, the existing harness-marker vocabulary, and stdin TTY
state. Two refusal signals compose to one result. There is no state transition,
retry, timing rule, recovery branch, or per-harness outcome.

One public CLI check is the authoritative behavior, and the aitty runtime check
is its existing sibling policy. This is the smallest model that produces the
same result in both supported harnesses while preserving normal operator use.

## Tests

Keep permanent coverage small and behavioral:

1. A PTY fixture created with macOS `script -q /dev/null`, with the listed
   harness markers removed through `env -u`, reaches the public resume selector
   and uninstall confirmation, then cancels without launching or mutating.
2. Claude-marked invocations of both commands exit 2 before the selector or
   prompt and print the operator boundary.
3. Codex-marked invocations of both commands have the same exit and ordering.
4. A non-TTY invocation with no marker is refused, matching aitty.
5. Existing aitty runtime tests pass with explicit Claude and Codex markers.
6. The uninstall suite still covers confirmation, cancellation, ownership, and
   cleanup through `bin/uninstall.sh` without bypassing the public CLI in
   production.
7. Removing the public CLI check makes the Claude and Codex cases fail.

The release oracle runs both commands from a normal terminal far enough to see
the selector or confirmation, then cancels. One real Claude session and one
real Codex session each attempt both commands and receive the refusal. No
identity is resumed and no installation is removed during the oracle.

## Out of scope

- Preventing deliberate bypass by a process with the user's Unix privileges.
- Adding sudo, another OS account, entitlements, authentication prompts,
  passwords, capability tokens, or a policy daemon.
- Blocking private launcher scripts or client imports exhaustively.
- Changing MCP `join` or `retire`; those remain scoped to the calling session.
- Blocking ordinary session-safe commands such as `status`.
- Deleting, transferring, rebinding, or permanently retiring identities or
  handles.
- Treating harness environment variables as credentials.

## Rollout and completion

Ship as a normal patch release. No migration or service restart is required.
Done means the immutable release is installed, a normal human terminal still
reaches both operator flows, real Claude and Codex sessions receive the same
refusal before work, aitty's existing protection still works, the controlling
reviewer verifies the released behavior, and #30 links the evidence.

## Rejected options

- Rejected: a password, signed token, privilege daemon, or OS authorization
  flow. It adds machinery without constraining an already trusted process.
- Rejected: Claude-only hooks. They do not cover Codex; the public CLI is the
  common point.
- Rejected: duplicating the public check in the Claude Bash hook. That hook is
  configured only in this repository and its message lands on the same tool
  result as the public CLI refusal; it adds a regex without another user
  outcome.
- Rejected: blocking every management command. The demonstrated concern is
  limited to resume, uninstall, and aitty's cross-handle operator identity.
- Rejected: exhaustive private-path blocking. That turns a misuse nudge into an
  unwinnable same-user sandbox.

## Sources

- `ait:377-404`, public resume and uninstall dispatch.
- `bin/uninstall.sh:27-79`, ownership, active-session, and confirmation checks.
- `mcp/src/aitty/main.ts:96-142`, existing marker and TTY refusal.
- `docs/aitty.md:126-141`, the nudge-not-wall contract.
- `bin/ait-uninstall-test.sh:103-107,142`, existing confirmation fixtures that
  currently reach uninstall through piped or redirected stdin.
- [Issue #30](https://github.com/natewalton/ait-protocol/issues/30) and operator
  direction on 2026-09-04: reuse the working aitty/Claude friction model, cover
  Claude and Codex equally, and do not pretend to sandbox a full-privilege
  terminal process.
- A 2026-09-04 `env` probe in a Codex tool shell reported
  `CODEX_SESSION_ID`, `CODEX_THREAD_ID`, and `AI_AGENT` as set; values were not
  read or recorded.
