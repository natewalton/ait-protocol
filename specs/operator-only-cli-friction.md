# Keep operator-only AIT session lifecycle out of agent sessions

Status: extended in AIT v0.1.20 on 2026-09-09. The original `resume`,
`uninstall`, and `aitty` boundary shipped in
[AIT v0.1.12](https://github.com/natewalton/ait-protocol/releases/tag/v0.1.12)
and is tracked by [#30](https://github.com/natewalton/ait-protocol/issues/30).

## Outcome

A human can still run `ait claude`, `ait codex`, `ait resume`, `ait uninstall`,
and `aitty` from an interactive terminal. Claude and Codex sessions receive the
same clear refusal before those operator-only clients launch or resume another
session, prompt for an uninstall, or mutate anything.

The visible change is on the terminal surface: a human reaches the existing
launcher, resume selector, or uninstall confirmation, while a Claude or Codex
session sees the public CLI refusal on stderr in its shell-tool result.

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

The same boundary must cover `ait claude` and `ait codex`. A session using
either command creates another top-level harness process, but functionally it
has created and directed a subordinate collaborator. That bypasses the
coordination contract's instruction to collaborate with existing AIT sessions
and leaves session lifecycle under agent control rather than the user's.

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

The crude version is sufficient: apply the public dispatcher's existing
two-signal decision to the four affected commands. No stronger authority exists
at this layer, so more machinery would not make the boundary more truthful.

## What changes

The public `ait` dispatcher already has one small shell function for this
boundary. Before dispatching `claude`, `codex`, `resume`, or `uninstall`, it
accepts only when stdin is a TTY and none of these supported-harness markers is
set:

- Claude: `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_ENTRYPOINT`;
- Codex: `CODEX_SESSION_ID`, `CODEX_THREAD_ID`, `AIT_SESSION_ID`;
- shared: `AI_AGENT`.

Otherwise it exits 2 before launch, selection, confirmation, or mutation. The
message says the command is for the human operator and that this check deters
accidental use rather than securing a full-privilege shell, and tells the
session to ask the operator to run the command.

Help and the migration errors for removed public resume flags remain available
before the launch check. An automation that drives any of the four commands
without a TTY will receive the refusal. Other commands and ordinary human
terminals are unchanged.

Use the same explicit marker vocabulary in aitty's existing runtime check.
Its policy and TTY behavior do not otherwise change.

Do not add a flag, persisted state, password, token, daemon, privilege model,
or harness-specific execution path.

## Files

Six files are expected:

1. `ait` applies its existing operator-terminal check to `claude` and `codex`
   before either launcher performs work.
2. `.agents/skills/delivery-coordination/SKILL.md` directs sessions to existing
   collaborators rather than launching or resuming more sessions.
3. `bin/ait-test.sh` covers the four public commands with fixture launchers and
   no real harness or uninstall action.
4. `README.md` names all four commands and aitty as human-operator surfaces.
5. `VERSION` identifies the patch release.
6. This spec records the extended boundary.

The extension changes one existing policy at one dispatch point. It adds no
second mechanism.

## Why this stays small

The system has three concepts already present in the code: operator-only session
lifecycle commands, the existing harness-marker vocabulary, and stdin TTY
state. Two refusal signals compose to one result. There is no state transition,
retry, timing rule, recovery branch, or per-harness outcome.

One public CLI check is the authoritative behavior, and the aitty runtime check
is its existing sibling policy. This is the smallest model that produces the
same result in both supported harnesses while preserving normal operator use.

## Tests

Keep permanent coverage small and behavioral:

1. A marker-free PTY fixture reaches both harness launchers, the resume selector,
   and the uninstall implementation without launching or mutating anything.
2. Claude- and Codex-marked invocations of all four commands exit 2 before work
   and print the operator boundary.
3. Non-TTY invocations of all four commands receive the same refusal.
4. Help and removed-resume-flag guidance remain reachable without launching.
5. Removing the public checks makes the marker cases reach their fixture work,
   proving the assertions cover the dispatch boundary.

The release oracle verifies the refusal from the current session and verifies
the normal launch path through an isolated PTY fixture. It does not start a real
harness, resume an identity, or remove an installation.

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
Done means the immutable release is published, a normal human terminal still
reaches the four operator flows in isolated fixtures, and a harness-marked
session receives the refusal before launcher work. No service restart is
required.

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
  limited to session launch and resume, uninstall, and aitty's cross-handle
  operator identity.
- Rejected: treating `ait claude` and `ait codex` as acceptable because the
  resulting process is technically top-level. The practical behavior is still
  a session creating and directing a subordinate collaborator.
- Rejected: exhaustive private-path blocking. That turns a misuse nudge into an
  unwinnable same-user sandbox.

## Sources

- `ait:298-318,403-468`, public operator check and session dispatch.
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
