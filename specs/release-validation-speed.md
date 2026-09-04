# Make release validation faster without weakening it

Status: proposed for peer review, 2026-09-04. Tracked by
[#27](https://github.com/natewalton/ait-protocol/issues/27).

## Outcome

The release operator sees one complete validation pass before a draft is
created, a lockfile-keyed npm download-cache hit on later prepares, and a
publish run that verifies and publishes the inspected draft without repeating
the product suites. Release identity, ancestry, migration, immutability, and
asset-integrity refusals remain fail-closed.

The difference is visible in the GitHub Actions run summary: prepare retains
the `validate` and `release` jobs; publish skips `validate` and spends only the
few seconds needed to bind and publish the existing draft.

## Why

The release workflow currently runs all three product suites, four sequential
fresh `npm ci` commands, two TypeScript builds, syntax/version/head checks, and
the lexicon check in one macOS validation step
(`.github/workflows/release.yml:25-48`). It then runs
`bin/ait-update-test.sh` again while preparing the exact asset
(`.github/workflows/release.yml:65-81`). The repository has four independent
`package-lock.json` files and no root package or npm workspace, as shown by
`rg --files -g package-lock.json -g package.json` on 2026-09-04.

GitHub Actions run 33835696928 measured 12m52s for `validate` and 11s for the
following `release` job. The v0.1.11 publish run 33844607534 was more revealing:
its unchanged validation step took 21m30s, then the publish-side release job
took 8s. Publishing therefore repeated a full validation already completed
before the draft was created, even though the publish step separately required
the draft target to equal the current `origin/main` head and checked the draft
asset digest before changing `draft=false`
(`.github/workflows/release.yml:143-179`).

The v0.1.12 release reproduced the same waste with different network timing:
prepare run 33851440921 spent 16m13s in validation before an 18s draft job,
and publish run 33852901560 repeated validation for 5m57s before a 10s publish
job. The duration varies; the duplicated work does not.

The crude solution is the right solution:

1. use the official `actions/setup-node` npm cache keyed by all four lockfiles;
2. keep the four ordinary `npm ci` installs and every prepare-time test;
3. delete the second updater-suite invocation from the asset step; and
4. run the validation job only for `prepare`, while allowing `publish` to run
   only its existing exact-draft checks.

The repository layout does not support consolidating installs without adding a
new root workspace and dependency-management path. This spec does not create
one.

## What changes

In the `validate` job, add the official `actions/setup-node` action pinned to
commit `820762786026740c76f36085b0efc47a31fe5020` (v7.0.0), with
`node-version: 24`, `cache: npm`, and an explicit multiline
`cache-dependency-path` containing:

- `plc/package-lock.json`
- `pds/package-lock.json`
- `appview/package-lock.json`
- `mcp/package-lock.json`

The action caches npm's global package data rather than `node_modules`; its
primary key includes the lockfile hash. Keep all four `npm --prefix ... ci`
commands unchanged so a cache hit accelerates downloads without bypassing
npm's clean, lockfile-enforcing install. The cache exists only in the read-only
validate job; the write-capable release job does not install dependencies or
restore package-manager cache data.

Run `validate` only when `operation == prepare` on `main`. The `release` job
continues to depend on it, but its job condition explicitly evaluates even when
that dependency was skipped and permits:

- `prepare` only when validation succeeded; and
- `publish` when validation was skipped for that operation.

Do not add another workflow input or mode. A failed or cancelled prepare
validation must still prevent the release job.

Remove `bin/ait-update-test.sh` from `Prepare exact release asset`. The updater
suite remains in `validate`, exactly once per prepare. Keep asset generation,
placeholder refusal, shell syntax, `--verify-only`, nonempty-file check, and all
later draft/release metadata and digest checks byte-for-byte unless a necessary
condition expression names the prepare/publish split.

On publish, no product suite or dependency install runs. The existing release
job must still prove the dispatched version, current `origin/main` identity,
draft target, draft state, installer digest, post-publication tag/commit,
immutability, release URL, and published asset digest before succeeding. If
main moved after prepare, publish continues to refuse rather than revalidate or
publish a stale draft.

What intentionally changes: a publish invocation no longer provides a second
test run. Its authority comes from the successful prepare plus the existing
exact target and asset checks. A cold prepare still runs every install and may
remain network-bound; the cache improves later prepares rather than hiding a
miss.

## Files

Two files are expected:

1. `.github/workflows/release.yml` adds the official lockfile-keyed npm cache,
   runs full validation only for prepare, removes the duplicate updater-suite
   run, and preserves every release gate.
2. `specs/release-validation-speed.md` records the measured problem, the
   minimal workflow change, and the cold/warm production oracle.

No runtime, installer, updater, package manifest, lockfile, README, or product
test file changes.

## Why this stays small

The workflow has three concepts: prepare validation, npm download caching, and
publication of an exact inspected draft. Cache identity is existing lockfile
state, not new project state. Prepare and publish already exist as the two
workflow operations. The change removes duplicate execution and composes the
official cache with the current `npm ci` path.

There is no test-selection graph, workspace conversion, dependency snapshot,
custom cache script, retry, timing verdict, or second release artifact.

## Verification

Permanent verification is the workflow's own positive and negative conditions;
do not add a test suite that greps YAML text. Before release:

1. Parse the workflow YAML and inspect the exact diff to confirm every current
   identity, ancestry, migration, immutable-release, and digest assertion is
   still present.
2. Run all existing shell suites and AppView/MCP builds locally once to prove
   the workflow-only change has no runtime effect.
3. Dispatch `prepare` on clean `main`. Require all product suites to appear
   once, each of the four `npm ci` commands once, the updater suite once, a
   cache miss or hit recorded by setup-node, and an exact draft asset.
4. Record the cold-cache prepare timing. If the cache was already warm, use the
   setup-node cache log as the warm observation and record that no cold sample
   was available without deleting shared cache state.
5. To obtain a warm sample when the first run was cold, delete only the
   unpublished draft (no tag exists), dispatch the same exact prepare again,
   require a cache hit, and independently re-gate the replacement draft.
6. Publish that inspected draft. Require the validate job to be skipped, the
   release job to succeed, the published asset bytes/digest to equal the gated
   draft, and the public release to be immutable.
7. Exercise one invalid prepare input and one publish against a draft whose
   target does not equal current main; both must refuse before publication.

Record cold and warm validation durations separately and compare the warm
prepare with the v0.1.9 12m52s and v0.1.12 16m13s prepare baselines. Record
publish duration separately; comparison baselines are v0.1.11's 21m30s
validation plus 8s release job and v0.1.12's 5m57s duplicate validation plus
10s publish job.

## Out of scope

- Dropping, selecting, or sharding product coverage.
- Caching or restoring `node_modules`.
- Converting the repository to npm workspaces or adding a root package file.
- Running four installs in a custom background-process supervisor or matrix.
- Changing package manifests, lockfiles, npm versions, or runtime behavior.
- Weakening exact version/head, ancestry, migration, immutable-release,
  tag/commit/VERSION, placeholder, or digest checks.
- Adding a validate-only workflow operation solely to measure the cache.
- Optimizing local `ait update`; this issue is the GitHub release path.

## Rollout and completion

Ship the workflow change through its own normal immutable patch release. The
first prepare both validates the candidate and supplies the cold-or-warm cache
observation. If a second prepare is needed for the warm measurement, delete
only the unpublished draft and re-gate the replacement before publishing.

Done means the exact workflow revision is published, every existing product
suite ran once before its draft, no suite ran during publish, the cache key was
derived from all four lockfiles, cold/warm timings are recorded without a
timing-based correctness verdict, every release-security gate remains, and
#27 links the runs and evidence.

## Rejected options

- Rejected: cache `node_modules`. The official setup-node path deliberately
  caches global npm package data; `npm ci` remains the clean-install authority.
- Rejected: create a root npm workspace to make one install command. The four
  independent lockfiles are the current production model; changing it to speed
  CI adds a second project.
- Rejected: parallel background installs or a job matrix. They add failure and
  log coordination when the measured waste is uncached downloads and repeated
  work.
- Rejected: keep full validation on publish. Exact target and asset checks
  already refuse drift, while the second run added 21m30s to v0.1.11 publish.
- Rejected: remove integrity gates or product suites. They are the authority
  that makes the resulting release safe.
- Rejected: permanent YAML source-grep tests. They can pass while the workflow
  is behaviorally broken; the real prepare/publish oracle is decisive.

## Sources

- `.github/workflows/release.yml:25-48,65-81,143-179`, current validation,
  duplicate updater test, and publication gates inspected at
  `c49e7d18b0eb01f94f744e71b4a9328e49d2d653`.
- GitHub Actions runs
  [33835696928](https://github.com/natewalton/ait-protocol/actions/runs/33835696928),
  [33843650424](https://github.com/natewalton/ait-protocol/actions/runs/33843650424),
  [33851440921](https://github.com/natewalton/ait-protocol/actions/runs/33851440921),
  [33852901560](https://github.com/natewalton/ait-protocol/actions/runs/33852901560),
  and
  [33844607534](https://github.com/natewalton/ait-protocol/actions/runs/33844607534),
  queried with `gh run view --json jobs` on 2026-09-04.
- [actions/setup-node README](https://github.com/actions/setup-node/blob/820762786026740c76f36085b0efc47a31fe5020/README.md),
  which supports multiple `cache-dependency-path` entries and states that npm
  caching stores global package data, not `node_modules`.
- [actions/setup-node advanced usage](https://github.com/actions/setup-node/blob/820762786026740c76f36085b0efc47a31fe5020/docs/advanced-usage.md),
  official multi-lockfile npm-cache examples.
- [npm ci documentation](https://docs.npmjs.com/cli/commands/npm-ci/), which
  defines the clean, lockfile-enforcing CI install behavior retained here.
- [Issue #27](https://github.com/natewalton/ait-protocol/issues/27).
