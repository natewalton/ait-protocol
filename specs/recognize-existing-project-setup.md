# Recognize existing AIT project setup

Status: implemented and locally validated, 2026-09-08.

## Why

An operator resuming `@ait-skills-dev.test` in the AIT repository reaches the
recorded project and is then told `error: run ait init in this project first`.
Running `ait init` also fails, calling the existing entry conflicting. The
2026-09-08 production replay returned status 1 from both paths while preserving
the `.mcp.json` SHA-256
`e47e8ea77f88c1a0e5d6592104826f22611953597e67be151c999243ed67df77`.

The entry is functional and predates the CLI. It invokes the same Node server
through `${CLAUDE_PROJECT_DIR:-/Users/nwalton/Desktop/ait-protocol}` so sessions
in this repository's Git worktrees load their corresponding MCP build
(`.mcp.json:3-12`; `specs/transcript-derived-session-key.md:64`). The CLI added a
byte-exact absolute-path check later and labels every other argument string a
conflict (`129f7b0:bin/install.sh:389-405,436-455,469-485`).

On 2026-09-08,
`rg -l 'ait-protocol' /Users/nwalton/Desktop --glob '.mcp.json'` found nine
AIT-enabled project files: eight use the accepted absolute path and one, this
repository, uses the worktree-aware form. Fix this one proven false-positive
cohort without accepting copied or arbitrary project-local server paths.

## Proposed work

Treat an AIT project entry as ready when its command and argument vector select
the current built server directly. Also treat the historical worktree-aware
argument as ready when the target project and the installed AIT checkout share
the same Git common directory. Both `ait init` and Claude launch must consume
that one readiness decision.

The existing file remains byte-identical. Missing entries remain eligible for
native creation, while malformed entries, changed commands or arguments, and a
copied worktree-aware expression in an unrelated repository remain conflicts.

## Files touched

Three files:

1. `bin/install.sh` recognizes the two proven ready configuration forms.
2. `bin/ait-test.sh` covers init, launch, byte preservation, and foreign-copy rejection.
3. `specs/recognize-existing-project-setup.md` records the boundary and evidence.

## Out of scope

- Rewriting, normalizing, or deleting any existing `.mcp.json` file.
- Accepting arbitrary environment-variable expressions or project-local servers.
- User-scope Claude configuration; AIT remains explicitly project-scoped.
- Codex launch configuration, which does not require `.mcp.json`.

## Tests

Run `bin/ait-test.sh`. Its isolated Git fixtures must prove the historical form
passes init without changing bytes, reaches the private Claude launcher, and is
rejected after being copied to an unrelated repository. Removing the compatible
form must make the regression fail.

Run the production oracle in `/Users/nwalton/Desktop/ait-protocol`: preserve the
real `.mcp.json` hash across `ait init`, require init to report AIT enabled, and
invoke `bin/install.sh --launch claude --resume not-a-uuid`. The launch must
reach the private launcher's UUID validation instead of the project-init error,
without starting a harness.

## Sequencing or rollout

Ship as a patch release after the CLI suite and production oracle pass. No
migration is needed because the correction is read-only. Rollback restores the
false rejection without modifying established project files.

## What was rejected

- Re-running native `claude mcp add`: it refuses the existing key and does not
  resolve the validator's false conflict.
- Removing and recreating the entry: it would discard the intentional worktree
  behavior and mutate a configuration that already works in Claude.
- Accepting every path containing `CLAUDE_PROJECT_DIR`: this could bless an
  unrelated project-local program as the AIT server.
- Special-casing the repository pathname alone: Git common-directory identity
  covers the root and its worktrees without hard-coding one machine path.

## Sources

- `.mcp.json:3-12`, established worktree-aware entry.
- `129f7b0:bin/install.sh:389-405,436-455,469-485`, pre-fix validation and consumers.
- `129f7b0:bin/ait-test.sh:469-557`, pre-fix project-init and launch fixtures.
- `specs/transcript-derived-session-key.md:64`, reason for the historical form.
