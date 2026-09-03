# Single-command AIT install

Status: implementation cleanup for issue #13, based on the released install
journey. The public contract stays the same; the implementation is reduced to
one readable path per operation.
Date: 2026-09-03.

## User outcome

Today, `install.sh:157-198` delegates to `bin/install.sh`; on the base revision,
`git show f71ac7e:bin/install.sh | nl -ba` shows the persisted environment
transaction at lines 198-363 and the marker walk at lines 506-531. The public
installer therefore acquires the exact release (or the raw-main development
checkout), links the `ait` command, creates the four required environment files,
and starts the existing AIT services. Existing files, project configuration,
foreign CLI targets, and foreign service processes are preserved or refused as
before. The command surface is listed in `ait:26-35`, and
`ait init`, `ait start`, `ait stop`, `ait status`, `ait claude`, and
`ait codex` keep their documented command and manual behavior.

The crude implementation would delete the transaction code and overwrite the
four targets directly. That is insufficient because it could destroy an
existing file. Sibling temporary files and non-replacing same-directory renames
preserve every existing target. An interrupt removes files created by that
invocation; a hard crash may leave a partial set, which the next run only names.

The day-one difference is visible to anyone running a fresh or interrupted
bootstrap in the terminal: a rerun sees one concise partial-set diagnosis and a
manual recovery instead of a hidden manifest/resume transaction. `ait init` run
outside Git also uses the current directory rather than a marker discovered by
walking its parents.

## Proposed work

- Replace the persisted environment manifest, staged copies, resume states,
  interrupt hook, and hash bookkeeping with four sibling temporary files and
  sequential renames. A complete four-file set is preserved. A partial set is
  never modified: the installer names present and missing files and prints the
  established-file restore / known-fresh-delete recovery guidance.
- Outside Git, use the current directory for `ait init`; keep the explicit
  safety refusal for `$HOME` and `/`. Remove the upward marker walk.
- Keep the existing prerequisite, checkout, CLI ownership, process-boundary,
  dependency/build, database, readiness, MCP ownership, and harness checks.
- Keep one visible prerequisite/service/CLI report per public bootstrap and
  remove duplicate transaction/reporting helpers from the private installer.

## Files and boundary

Implementation and required evidence are limited to:

1. `install.sh`
2. `bin/install.sh`
3. `bin/ait-test.sh`
4. `specs/single-command-install.md`
5. `VERSION` (combined patch release: `0.1.2`)

The existing update suite derives its baseline from `git show HEAD:VERSION`,
so this patch requires no update-suite source change. The skill and update
runtimes remain owned by their separate cleanup slices.

## Safety and failure behavior

Read-only checkout, ownership, and process preflight checks run before a new
CLI link, environment file, or service mutation. A partial environment set is an operator-owned state and is
not repaired automatically. Temporary siblings are private and are removed by
normal command completion; a failed publication is detected on the next run by
the resulting partial set. Existing environment bytes and foreign integrations
are never overwritten.

## Tests and rollout

Run `bash -n` on the public/private installer and inherited service scripts,
then `bin/ait-test.sh` in isolated fixture homes. The suite must cover a fresh
install, safe rerun, partial environment refusal, Claude-only/Codex-only/dual
harness reporting, CLI ownership, nested-Git and explicit init, foreign MCP
conflict preservation, launch dispatch, event-based service readiness and
interrupt cleanup, and local-HTTP command-substitution bootstrap. The release
suite is run unchanged as the mechanical release gate because its version
fixture is already derived from the checked-out `VERSION`.

## Out of scope

No skill behavior, update state machine, new persisted state, project registry,
database deletion, service model, platform, release workflow, main branch,
tracker, or live-user changes belong to this slice.

## Rejected alternatives

Persisted manifests and resume engines make a four-file publication harder to
understand and introduce recovery state that users must trust. Marker walks
make project selection surprising outside Git. Both are unnecessary for the
existing public outcome and are intentionally deleted.
