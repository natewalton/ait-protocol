# Default AIT coordination skill installation

Status: implementation candidate, 2026-09-03. Tracked by [#14](https://github.com/natewalton/ait-protocol/issues/14), following shipped [#8](https://github.com/natewalton/ait-protocol/issues/8).

## Why change it

Today the public wrapper writes `bootstrap-pending` before cloning (`install.sh:139-146`), and the private installer uses that file to decide whether to check, install, report, and finally clear skills (`bin/install.sh:436-497`). The skill script then maintains separate operation/progress/signal state for two symlinks (`bin/install-skill.sh:9-10,114-180,210-261`). A failed fresh bootstrap therefore needs durable history merely to decide whether the next run should touch two inspectable links.

Users see the defect in the terminal after a failed bootstrap: a rerun can be skill-silent or depend on the leftover marker instead of simply converging from the actual targets. The shipped implementation is also 852 lines of runtime plus dedicated tests for two links (`wc -l bin/install-skill.sh bin/ait-skill-test.sh` at `f71ac7e`).

The crude solution is the chosen one: on every machine-bootstrap invocation, run the same idempotent absent/owned/foreign link operation before fallible provisioning, unless that invocation sets `AIT_NO_SKILLS=1`. Delete bootstrap-history, progress, and signal-recovery machinery. A rerun then does what its terminal command says without remembering why it was invoked.

## User contract

The machine bootstrap installs AIT's `delivery-coordination` skill for each supported harness present on the machine. `AIT_NO_SKILLS=1` skips skill changes for that bootstrap invocation. Project-scoped `ait init` never reads or changes user-level skills.

Users can later run:

- `ait skills install` to install or verify links for detected harnesses;
- `ait skills remove` to remove only links owned by this checkout;
- `ait skills status` to inspect both targets without writing.

A later machine bootstrap applies the default again unless that invocation also sets `AIT_NO_SKILLS=1`. Start a new harness session after a change for a guaranteed result.

## Targets and ownership

- Claude: `~/.claude/skills/delivery-coordination`
- Codex: `~/.agents/skills/delivery-coordination`
- Source: `<managed-checkout>/.agents/skills/delivery-coordination`

For each harness, the implementation has three ownership states:

1. absent: install may create a non-replacing symlink;
2. owned: a symlink resolves to the exact managed source and is already ready;
3. foreign: every other file, directory, broken/cyclic link, or link to another source is preserved and reported as a conflict.

An unavailable harness is skipped and its target is not created. A foreign target for an unavailable harness does not block an available harness. With neither harness installed, explicit installation fails with both installation references.

Resolution is cycle/depth bounded. Installation requires the source `SKILL.md`, preflights present-harness conflicts before writes, uses non-replacing `ln -s`, and verifies the result. Removal works even if the source disappeared, unlinks only an owned symlink, and reports foreign targets as preserved. Operations are idempotent; interrupted or partial operations recover by running the same explicit command again.

Help succeeds without writes. Unknown or extra arguments exit `2`; ownership, source, or filesystem failures exit `1`.

## Deliberate simplicity

There is no fresh-versus-rerun marker, preference file, progress journal, lock, rollback, signal state machine, adapter registry, or project-local skill copy. Actual link ownership is the only state.

This changes one visible behavior: a machine-bootstrap rerun once again prints and applies the default skill step. A user who previously ran `ait skills remove` supplies `AIT_NO_SKILLS=1` when intentionally rerunning the machine bootstrap. `ait init`, ordinary service commands, harness launch, and `ait update` remain skill-neutral.

## Files

Six files:

1. `install.sh` stops persisting bootstrap history.
2. `bin/install.sh` invokes the same pre-provision skill step on every machine bootstrap.
3. `bin/install-skill.sh` becomes the direct three-state link operation.
4. `bin/ait-skill-test.sh` keeps outcome tests and deletes framework tests.
5. `bin/ait-test.sh` updates the public-bootstrap expectation without reducing its install coverage.
6. `specs/default-skill-install.md` records this contract.

README and `ait help` already describe default installation, opt-out, targets, lifecycle commands, and next-session behavior; their user-facing manuals stay unchanged.

## Required proof

Run `bash -n` plus the CLI and skill suites. Isolated outcome tests cover:

- help, invalid arguments, and read-only status;
- dual and single-harness install, idempotent rerun, default bootstrap, and opt-out;
- absent, owned, foreign, broken/cyclic, and missing-source states;
- absent-harness foreign targets;
- owned removal and foreign preservation;
- explicit retry after a partial operation;
- `ait init` remaining skill-neutral in the CLI suite.

The released oracle installs with Claude only, Codex only, both, and opt-out; checks resolved links and absent-harness directories; exercises install/status/remove; and proves foreign targets remain byte-identical.

## Out of scope

AIT does not install harnesses, support unverified harness locations, overwrite/adopt foreign targets, manage arbitrary skills, restart active sessions, or persist a user's desired skill state.

Rejected: keeping the pending marker only to preserve fresh-versus-rerun behavior. It makes an interrupted clone a durable product state and recreates the reconciliation problem this cleanup exists to remove. Rejected: a preference file that remembers `ait skills remove`; the user-visible `AIT_NO_SKILLS=1` invocation is sufficient and actual link ownership remains the source of truth.
