# AIT uninstall removes the machine installation

Status: implementation candidate, 2026-09-03. Tracked by
[#11](https://github.com/natewalton/ait-protocol/issues/11).

## Why

The published installer creates one managed checkout, a command link, optional
skill links, local service data, identities, state, sockets, logs, and optional
launchd agents. At the frozen parent, the CLI has install, update, and
component-level skill commands but no command that removes the machine
installation (`1c93deb:ait:18-37,253-372`). A standalone-install user therefore
has no supported terminal flow: they must discover internal paths and scripts
and cannot know which project state those scripts cannot locate.

Verdict: add a normal uninstall command now. The crude solution is sufficient
and is the chosen design: compose the three existing removal scripts, delete
the fixed AIT-owned paths, and delete the checkout last after one concrete
warning and confirmation. It does not retain a backup under another name. The
installed user sees and controls this directly in the `ait uninstall` terminal
flow on release day.

## The proposed work

`ait uninstall` is available only from the published installer-owned checkout
and its exact CLI link. Before any write it refuses an active update or a Node
MCP child using that checkout. A stale update lock does not block deletion and
a dirty managed checkout is included in the user's deletion decision.

The warning names the managed checkout, generated environment files and local
PDS/AppView data, the local `plc_directory` database, AIT identities, state,
sockets, PID/log files, CLI and skill links, and four `com.ait.*` launchd agents.
It also names what remains: project `.mcp.json` entries and shared prerequisites,
including PostgreSQL itself and unrelated databases. The literal input
`uninstall AIT` is required; EOF, any other input, or an interrupt cancels before
mutation.

After confirmation the command composes the existing launchd, service, and
skill removal scripts, deletes the dedicated database and fixed AIT paths plus
the exact owned CLI link, and deletes the checkout last. The entire body is
already loaded in one shell function, so no temporary self-copy or retained
state is needed. A child failure stops the sequence and prints the remaining
fixed targets plus either the still-available command or the public reinstall
command.

The system has four concepts: installer ownership, active-operation/session
exclusion, explicit confirmation, and sequential cleanup. The independent
general-systems review returned `CLEAR` after removing service-state classes,
database-provenance machinery, rollback/staging, a temporary self-copy, and
launchd path inspection.

## Files touched

Nine files:

- `ait`: public help and dispatch.
- `bin/uninstall.sh`: the one uninstall path.
- `bin/install.sh`: share its existing PostgreSQL client resolution and expose
  the fixed `plc_directory` removal step; no provenance or discovery state.
- `bin/ait-uninstall-test.sh`: isolated behavior checks.
- `bin/ait-update-test.sh`: derive release-fixture tags from `VERSION`; the
  inherited suite otherwise treats v0.1.0 as both current and next at v0.1.1.
- `.github/workflows/release.yml`: release gate for the new command.
- `README.md`: user-facing uninstall manual.
- `specs/uninstall.md`: this acceptance vector.
- `VERSION`: release 0.1.1.

## Out of scope

No backup, archive, recovery slot, retained uninstall metadata, database
discovery or provenance framework, project registry or home scan, prerequisite
removal, development/package-manager uninstall, per-service choices, or
generalized cleanup framework. Simplification of the existing installer, skill
manager, and updater is separate follow-up work after this release.

## Tests

`bin/ait-uninstall-test.sh` checks help and invalid arguments; EOF, wrong input,
interrupt, and exact confirmation; managed versus development/foreign
ownership; active sessions and live/stale update locks; stopped and partial
service cleanup through the same path; owned and foreign CLI, skill, and
launchd targets; deletion of `plc_directory` while an unrelated database remains;
exact path deletion and preservation; and truthful residue after a post-confirm
child failure. It runs in the foreground and when backgrounded with `wait`
without reaching the live host. Removing the confirmation, session, or
release-ownership check must make its corresponding negative proof fail.

The inherited CLI, skill, and update suites must also pass from the frozen
revision. The update-suite correction changes fixture expectations only; it
does not alter updater behavior or add a runtime concept.

## Sequencing and rollout

Freeze one clean candidate based on `1c93deb`, obtain one controlling read-only
reviewer `CLEAR` and GO, merge and push only that revision, then prepare and
publish immutable v0.1.1. In an isolated home, install public v0.1.0, update to
v0.1.1, create representative AIT and preserved external state, confirm the
uninstall, and verify both absence and preservation. The same reviewer repeats
the public oracle before #11 closes.

Rollback is a higher patch release. A published immutable tag or installer
asset is never moved or deleted.

## What was rejected

- Moving deleted data to an archive or recovery slot: rejected because a normal
  uninstall removes what the installer added after informed confirmation.
- Removing PostgreSQL itself or unrelated databases: rejected because they are
  shared prerequisites, while `plc_directory` is AIT's dedicated local database.
- Scanning the home directory for project entries: rejected because v0.1.0 did
  not record initialized roots; the manual per-project command is truthful.
- Temporary self-copy: rejected because the script body is loaded before the
  checkout is deleted last.
- Service-state restoration, rollback, retries, and durable uninstall state:
  rejected because every confirmed uninstall follows one cleanup path.

## Sources

- `install.sh:6-21,139-198`: managed checkout, installer state, and public
  recovery command created by the published bootstrap.
- `bin/install.sh:426-493`: CLI, services, skills, and first-project next step.
- `bin/uninstall-services.sh:1-12`: the existing four-agent launchd cleanup.
- `bin/stop-all.sh:1-45`: the supported service cleanup.
- `bin/install-skill.sh:153-216,253-256`: exact-owned skill removal.
- `mcp/src/storage.ts:77-82` and `mcp/src/aitty/identity.ts:17-22`: the two AIT
  identity directories.
- `bin/codex-session.sh:58-94` and `bin/start-all.sh:118-172`: fixed AIT socket,
  PID, and log paths.
