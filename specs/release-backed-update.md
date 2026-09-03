# Simpler release-backed updates

Status: ready for implementation, 2026-09-03. Tracked by #15.

## Why change it

Today an installed user runs `ait update`; the shipped implementation verifies an immutable GitHub release and then moves the managed checkout. That user outcome is correct, but the implementation records a phase global, creates a per-run Git ref, takes before/after snapshots, reconciles child-command windows, and attempts service restoration (`bin/update.sh` at release v0.1.1:16, 40, 48-110, 229-249, 279-351). Its 1,157-line test suite is more than three times the 361-line command and tests implementation text as well as outcomes (`bin/ait-update-test.sh` at v0.1.1; `wc -l` measured 2026-09-03). Those interacting recovery paths make interruption handling harder to trust.

The crude fix is a linear update: verify one release, take one lock, stop if needed, check out, rebuild, and start if needed. That is sufficient when paired with a single explicit recovery boundary. Before a start attempt, returning to the old commit is safe to recommend; after a start attempt, persisted data may have advanced, so the only truthful advice is to fix forward.

An installed user sees the difference on an `ait update` failure: one of those two recovery messages replaces phase-dependent automatic restoration. Maintainers see executable outcome tests that can fail only when public behavior or a safety boundary changes.

Verdict: replace the shipped machinery while preserving the command, release trust checks, success output, and manuals.

## User behavior

`ait update` still advances an installer-owned checkout to the latest immutable GitHub release. It verifies the release, rebuilds AIT, and restores a previously ready stack. An already-current install is a no-op. A stopped install remains stopped.

The command retains these fail-closed checks:

- the CLI link and Git origin identify the managed checkout;
- the worktree is clean and no Git operation is active;
- the latest release is published, full, immutable, and SemVer-tagged;
- the installer asset digest matches GitHub metadata and its embedded tag and commit;
- the fetched tag, commit, and `VERSION` agree, and the target descends from the installed commit;
- no AIT harness session is using the installed MCP build;
- services are wholly ready or wholly stopped; and
- one non-waiting, process-owned lock excludes update, start, and stop races.

For a newer release the command validates those boundaries, acquires the lock, stops a ready stack, checks out the verified commit detached, records `refs/ait-release/v<VERSION>`, rebuilds, and restarts only a previously ready stack. One temporary download directory and the lock are removed by one exit trap. Environment files, databases, application data, and skill links are not rewritten.

Failures before a start attempt print exact manual commands to return to the old commit, rebuild, and optionally restart. The updater never executes those commands. Once a start attempt occurs, recovery says not to reset and to fix forward with a higher release.

`ait version` remains offline and recognizes an exact `refs/ait-release/v<VERSION>` commit. All `ait help` text and README install, update, recovery, and release manuals remain accurate.

## Release behavior

The existing manual GitHub workflow keeps its two operations. `prepare` validates and builds main, rejects an unreviewed AppView migration change, creates a draft, and uploads an installer whose embedded tag and commit bind it to the candidate. `publish` revalidates the draft and digest, publishes it, and requires the public release to be full, latest, and immutable. Published tags and assets are not moved or replaced; a bad release is corrected by a higher patch release.

## Files changed

Five files change:

1. `ait` dispatches the installed updater directly.
2. `bin/update.sh` becomes the linear updater.
3. `bin/ait-update-test.sh` becomes a concise isolated outcome suite.
4. `specs/release-backed-update.md` records this contract.
5. `README.md` uses the same pre-start/fix-forward recovery boundary.

The cumulative #13/#14/#15 release may also edit shared installer, CLI, README, and release files within those separately counted issue boundaries.

## Verification

Run:

```bash
bash -n install.sh ait bin/install.sh bin/update.sh bin/ait-update-test.sh
bin/ait-test.sh
bin/ait-skill-test.sh
bin/ait-update-test.sh
```

The update suite uses an isolated Git origin, API fixture, checkout, HOME, process table, and service shims. It covers stopped and ready updates, no-op behavior, immutable metadata and digest refusal, divergent ancestry, dirty/session/lock/partial-service refusal, pre-start manual recovery, post-start fix-forward recovery, cleanup, state-byte preservation, exact durable release identity, and public CLI dispatch. It must not call host services.

Before publication, test the generated asset and update from the previous public release in an isolated HOME. After publication, verify the public release is immutable, its asset digest and embedded identity match the reviewed commit, and the previous release updates to it.

## Out of scope

- automatic checks, channels, requested versions, downgrades, or force updates;
- updating third-party prerequisites or package-manager-owned AIT installs;
- killing or rewriting Claude or Codex sessions;
- automatic rollback after checkout; and
- a general migration framework.

## Rejected options

- Keep snapshots, phase globals, per-run refs, child-window reconciliation, and auto-restore: rejected because they create more failure states than they remove.
- Copy the updater before running it: rejected because Bash keeps the running script readable after checkout replaces its path.
- Test source strings: rejected because those assertions can pass while behavior is broken; executable fixtures cover the public outcomes.
- Update from `main` or mutable assets: rejected because they cannot provide a durable version-to-bytes mapping.
