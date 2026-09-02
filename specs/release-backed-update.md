# Update AIT only from published releases

Status: frozen correction candidate, 2026-09-02. Tracked by [#7](https://github.com/natewalton/ait-protocol/issues/7); implement after [#6](https://github.com/natewalton/ait-protocol/issues/6) and [#8](https://github.com/natewalton/ait-protocol/issues/8). The candidate boundary includes the inherited `bin/ait-test.sh` help assertion and this spec so the safe development-checkout recovery guidance is tested and documented without retaining the obsolete managed-root pull command. The previous spec hash was `3030382b55e19103b0829d1c07903373e5313e0f89391c26734a22619d77ac29`; the corrected candidate hash is recorded in the delivery receipt.

## Why

An installed AIT user currently updates through six operator-facing steps: exit every AIT harness session, pull the checkout, rebuild MCP and AppView, stop and start the stack, then relaunch the sessions (`README.md:253-268`, inspected 2026-09-02). That path follows whatever is on `main`, not a version the project deliberately published. It has no stable version, human release notes, promotion gate, exact update target, or installed update command. A successful pull can still leave old built output or live MCP children running old code.

The repository has no release boundary today. On 2026-09-02, `git ls-remote --tags origin` returned no tags, GitHub's latest-release endpoint returned 404, and an authenticated repository-settings probe reported immutable releases disabled. The settings endpoint requires authentication; installed clients do not use it. The repository is public, so they can read published release metadata, including the release object's `immutable` field, without a token. Its GitHub Actions default token permission is already read-only.

Source rollback alone is not truthful for every future change. AppView startup currently contains migrations which drop a column and rebuild a table (`appview/src/db.ts:104-158`). A release gate must stop ordinary publication when that migration surface changes without a separately reviewed data-migration and recovery design, and updater recovery must distinguish failure before AppView starts from failure after it may have changed persisted data.

Verdict: fix after the base CLI in #6 ships. An installed developer should run `ait update` and receive only an explicitly published, immutable, newer AIT release. A release operator should prepare a tested draft, inspect its notes and installer asset on GitHub, then publish it through a second explicit action. The crude safe implementation is a temporary updater copy, one exact release lookup and tag fetch, clean-state and active-session refusal, the existing private rebuild, prior service-state restoration, and exact manual recovery if a post-checkout step fails. Automatic rollback, multiple channels, and a release framework are not required.

## The proposed work

The public surfaces become:

```text
ait version
AIT 0.1.0 (0123456789ab)

ait update
Check      v0.1.0 -> v0.1.1
Download   verified immutable release v0.1.1
Rebuild    complete
Services   ready
Updated AIT 0.1.0 -> 0.1.1
Release notes: https://github.com/natewalton/ait-protocol/releases/tag/v0.1.1
```

`ait update` takes no version, channel, force, downgrade, or configuration option. `ait update --help` describes what it changes, the refusal states below, the stable release source, session requirement, recovery, and exits. `ait version` remains read-only and offline. It prints the semantic version, short commit, and `development` when the checkout is not an exact published-release commit.

### Publish one immutable release at a time

`VERSION` contains one stable SemVer value without the `v` prefix. A full release tag is exactly `v<VERSION>`.

GitHub immutable releases must be enabled before the first draft is prepared. The repository Actions default token permission remains read-only. The release workflow grants only `contents: write` to its release job, grants every other permission `none`, uses no personal token or repository secret, and pins every referenced action to a reviewed full commit SHA. It has one non-canceling release concurrency group so two publications cannot overlap.

The workflow is manual and has two operations, `prepare` and `publish`, plus a required SemVer input. It accepts only `refs/heads/main`; it passes the validated input through an environment variable rather than interpolating untrusted input into generated shell. Both operations fail unless `VERSION`, the requested version, and the proposed tag agree.

`prepare` performs this complete gate before it writes GitHub release state:

1. Require a clean checkout at the exact current `origin/main`, no existing tag or release with the requested name, and either no prior release or an immutable latest full release whose tag and commit are ancestors of the candidate.
2. After the first release, refuse a candidate whose diff from the prior full release changes `appview/src/db.ts`. The failure says that AppView's migration surface requires a separate reviewed data-migration, backup, fix-forward, and recovery design before publication. This conservative gate may be narrowed only by that design; a release operator cannot waive it with workflow input.
3. Run the repository syntax, install fixture, update fixture, build, lexicon, and production-shaped prior-release-to-candidate checks named below. For the first release, replace the prior-release update with the fresh-install oracle.
4. Generate a temporary `install.sh` release asset from the root template by replacing its release-tag and full-commit placeholders. Verify no placeholder remains, run `bash -n`, and replay it through the local install fixture. The source template is not itself the public curl target.
5. Create a draft GitHub Release targeted at the exact candidate commit, generate notes from the previous full release, upload only the generated `install.sh`, and require GitHub's reported SHA-256 asset digest to match the local file. Print the draft URL for human inspection.

`publish` is a separate manual workflow run after the operator inspects the draft title, generated notes, tag, target commit, and installer asset. It requires the draft target still to equal current `origin/main`, reruns the candidate tests, regenerates the installer and matches its digest to the draft asset, then publishes the draft as the latest full release. It immediately requires the public API to report the expected tag, `draft:false`, `prerelease:false`, `immutable:true`, the exact release URL, and the expected installer digest. A mismatch is a failed release, not a warning.

A failed prepare or publish run preserves its logs and any draft for inspection. It never publishes a partially uploaded release. The operator may delete a failed draft and its unpublished tag with the exact recovery command printed by the workflow, then prepare again. Once published, a release tag and asset are never moved, replaced, deleted, or reused. A bad published release is corrected by a higher patch release which reverts or fixes the code; setting an older release as latest is not a supported rollback because installed clients reject downgrades.

### Install the exact latest release

After the first release, the README public bootstrap becomes:

```bash
/bin/bash -c "$(curl -fsSL https://github.com/natewalton/ait-protocol/releases/latest/download/install.sh)"
```

GitHub redirects that stable URL to the `install.sh` asset on the latest full release. The generated asset embeds its exact tag and full commit. It retains #6's full-download-before-execution, prerequisite, collision, environment, build, health, and rerun contract plus #8's fresh-bootstrap `AIT_NO_SKILLS=1` validation and default skill behavior. When it creates the managed checkout, it fetches only the embedded tag from the expected HTTPS origin, requires the peeled tag commit to equal the embedded commit, and checks out that commit detached. It never resolves or checks out raw `main`.

The bootstrap refuses an existing managed checkout at another commit and prints `ait update` when that command exists. `ait update` treats a clean #6 or #8 managed checkout with no `VERSION` file as a pre-release install: it verifies the checkout identity and applies the same descendant-only update contract directly to the first immutable release. No manual adoption sequence is required.

### Resolve and apply one exact update

`ait update` runs only for the installer-owned checkout at `$HOME/.local/share/ait-protocol`. A development checkout, another origin, or a package-manager-owned future installation fails unchanged and names its own update owner.

The command has this contract:

1. Copy `bin/update.sh` to a private temporary file and execute that copy with the resolved managed path. Fast-forwarding the checkout therefore cannot replace unread updater source. Remove the copy on every terminal exit.
2. Call the public GitHub latest-release API once with the pinned API-version header. Require a full SemVer tag, `draft:false`, `prerelease:false`, and `immutable:true`. A network, API, rate-limit, JSON, or metadata error changes nothing and prints the GitHub release page plus retry guidance.
3. Fetch only that exact tag from the verified HTTPS origin into an AIT-owned temporary ref. Peel it to one commit; require its `VERSION` to match the tag and its commit to descend from the installed commit. An installation with no `VERSION` file is eligible only when it otherwise matches the #6/#8 managed-checkout contract and the first released commit descends from its installed commit. A same version and commit is an up-to-date success with no lock, npm, service, or session disruption. A lower/equal different version or divergent target fails unchanged.
4. When a newer target exists, require a clean managed worktree with no Git operation in progress, all environment files present, and services either fully ready or fully stopped. Refuse while any process executes this checkout's `mcp/dist/server.js`; list each PID and ask the user to exit those AIT Claude or Codex sessions. Never terminate a harness session.
5. Acquire one atomic, non-waiting update lock under the managed state directory. `ait start`, `ait stop`, and another `ait update` refuse while it exists; internal updater calls use the service scripts directly. The lock records the updater PID, is removed by its exit trap, and never uses elapsed time, sleeps, or retry counts as a state verdict. A leftover lock fails closed and prints its PID plus the exact remove-and-retry command only when that PID is no longer alive.
6. Record the old version state, commit, environment hashes, and whether the complete stack was ready or stopped. Revalidate the exact target, clean worktree, active-session absence, and service state under the lock. Stop a ready stack through the supported stop script, then check out the already-fetched descendant commit detached. There is no second network resolution between validation and checkout.
7. Run the target private installer in rebuild-only mode: `npm ci` for the four locked packages, AppView and MCP builds, and the lexicon check. It preserves every environment byte, database row, and skill-link target and does not start services, run a skill lifecycle operation, or update third-party tools. Restore the recorded service state, requiring the three HTTP probes and the conditional Codex socket when the prior stack was ready; keep it stopped when it was stopped.
8. Declare success only when `ait version` reports the target version and commit, environment and skill-link hashes are unchanged, built entry points exist, and the prior service state is restored. Remove the temporary fetch ref and update lock, then print the version transition, service table using #6's `ready`/`skipped` vocabulary, and release-notes URL.

Failures before checkout preserve source and service state. If stopping succeeded but checkout did not, restore a previously ready stack. A failure or SIGINT after checkout leaves services stopped and retains logs; it does not guess at automatic rollback. The still-running temporary updater prints `RECOVERY REQUIRED`, old and target versions and commits, the failed phase, log paths, and one recovery branch based on emitted service state rather than time or retries.

If the target AppView never started, persisted-data migrations could not run. Print these commands with exact resolved values:

```bash
git -C "$HOME/.local/share/ait-protocol" reset --hard <old-commit>
"$HOME/.local/share/ait-protocol/bin/install.sh" --rebuild-only
ait start  # printed only when the old stack was running
```

Those commands are safe only because preflight proved the managed checkout installer-clean and records the exact old commit. The command never executes the destructive reset automatically. After recovery, `ait version`, environment hashes, and the prior service verdict must match before the incident is closed.

If target AppView startup reached its ready event before a later Services phase failed, do not print or recommend `git reset --hard`: AppView may already have changed persistent data. Keep the target checkout and services stopped, print `Do not reset; persisted data may have advanced`, and direct the operator to preserve the logs and fix forward with the next higher patch release. The updater never infers this boundary from elapsed time, a timeout, or retry count.

## Files touched

Nine paths are in candidate A: eight implementation files and this spec. README remains the held candidate-B child and is not activated until v0.1.0 is published.

1. `VERSION` is the one-line stable semantic version used by the release, CLI, installer asset, and updater.
2. `install.sh` becomes the release-installer template with exact tag and commit placeholders.
3. `ait` adds `update` dispatch/help, release-aware `version`, and update-lock refusal for start/stop.
4. `bin/install.sh` adds the private rebuild-only path used by update without provisioning or starting services.
5. `bin/update.sh` owns latest-release resolution, exact tag verification, update, state restoration, and recovery output.
6. `bin/ait-update-test.sh` provides isolated release API, Git origin, managed checkout, process, service, and failure fixtures.
7. `.github/workflows/release.yml` prepares and publishes tested immutable releases with least privilege and serialized execution.
8. `bin/ait-test.sh` verifies the complete safe development-checkout sequence and rejects the obsolete managed-root pull form.
9. `specs/release-backed-update.md` records the release/update contract and this boundary correction.

The repository immutable-releases setting changes from disabled to enabled before the first draft. The existing read-only default `GITHUB_TOKEN` permission is verified and retained. No package manifest, lockfile, application source, schema, environment template, skill, project configuration, or service supervisor file changes.

## Out of scope

- Automatic, background, launch-time, or unrelated-command update checks. A developer explicitly runs `ait update`.
- Prerelease, beta, nightly, or latest/stable channel selection; requested versions; downgrades; alternate remotes; or force-updates.
- Updating Homebrew, Node, PostgreSQL, Claude Code, Codex, or any software AIT does not publish. The updater also does not install or remove skill links; it preserves #8's links while their source content advances with the managed checkout.
- Package-manager-owned AIT installs. A future Homebrew or npm distribution must defer to that manager rather than mutating its files.
- Automatic source/build rollback. The first updater keeps deterministic manual recovery because releases are gated before publication and persistent state makes guessed rollback unsafe.
- Persistent-data migration releases. A change to AppView's migration surface needs a separate backup, fix-forward, and recovery design before it can become the latest full release.
- TUF, a non-GitHub signing root, mirrored release infrastructure, or requiring end users to install `gh`. GitHub immutable-release attestations strengthen the existing GitHub trust boundary; the installer and updater use curl, Git, and the public API.
- Killing, restarting, or rewriting active Claude or Codex sessions.
- Deleting or repointing a published immutable release, tag, or asset.

## Tests

Run from the frozen implementation revision:

```bash
bash -n install.sh ait bin/ait-test.sh bin/install.sh bin/update.sh bin/ait-update-test.sh
test "$(cat VERSION)" = "0.1.0"
bin/ait-test.sh
bin/ait-update-test.sh
```

The frozen candidate A boundary contains the nine paths listed above; candidate B contains only `README.md` and remains held for post-publication activation. The additional test/spec paths correct the inherited help-test boundary so the tested operator guidance and the frozen contract agree.

`bin/ait-update-test.sh` uses a temporary public-API fixture, Git origin, managed checkout, home, services, process table, and command shims. It cannot reach the operator's real checkout, GitHub releases, environment files, database, ports, PID files, socket, or sessions. It covers:

- offline version/help and exact release, development, malformed-version, and wrong-tag states;
- API failure, rate limit, invalid JSON, draft, prerelease, mutable release, malformed tag, missing tag, tag/version mismatch, non-descendant, and downgrade with zero local mutation;
- clean up-to-date behavior with live harness sessions and no lock, fetch, npm, stop, build, or start action;
- wrong path, link, origin, dirty/untracked state, Git operation, partial/foreign services, active MCP children, live update owner, and stale lock recovery;
- release-specific installer generation with no remaining placeholder, embedded tag/commit identity, truncation safety, syntax, fresh exact-tag checkout, rerun, and moving-latest race resistance;
- ready and stopped prior releases plus a clean pre-release #6/#8 checkout updating to one exact newer local release while preserving environment hashes, skill-link hashes, and persistent-data sentinel rows and restoring the recorded service state;
- a target appearing after the API response is deferred, proving one frozen target per invocation;
- failures and SIGINT before stop, after stop, after checkout, during dependency install, build, lexicon, AppView start, later service start, and health; pre-checkout failures restore state, post-checkout failures leave services stopped, pre-AppView failures print exact reset recovery, and post-AppView failures require fix-forward without a reset command;
- replay of the pre-AppView printed recovery commands restoring the old version, builds, hashes, sentinel rows, and ready/stopped verdict;
- release workflow static assertions for manual prepare/publish modes, serialized non-canceling concurrency, default-deny permissions, job-only `contents: write`, full-SHA action pins, validated input transport, exact-main gate, migration-surface refusal, draft-first publication, digest check, and immutable/latest post-publish verification.

The production-shaped pre-release oracle starts from the previously published immutable release on a clean macOS user or disposable VM. Preserve sentinel database rows, all environment hashes, and present and absent skill-link fixtures. Test the public API up-to-date path, then point only the test fixture at the exact candidate release and exercise stopped and running updates, active-session refusal, one pre-AppView failed build plus the printed recovery, one post-AppView service failure plus the fix-forward refusal, and success through a read-only AIT call from each installed harness. The first release substitutes a fresh install through its generated asset and a direct update from a clean #6/#8 pre-release checkout.

The published oracle runs immediately after release: fetch the public latest endpoint, require the exact immutable version and asset digest, execute the public latest-installer command on a clean target, run `ait update` as an up-to-date no-op, and repeat one read-only AIT call. The controlling reviewer repeats these live checks from the same published release.

## Sequencing or rollout

Implement only after #6 and #8 are released and their trackers are closed. This sequence lets the lower-risk skill slice land first and prevents concurrent edits to `install.sh`, `ait`, `bin/install.sh`, and `README.md`. Freeze one clean update revision and have one read-only reviewer verify the exact commit, file and patch hashes, local release fixture, update/recovery oracle, skill-link preservation, and workflow permissions. Merge the approved revision to `main` without publishing it as an AIT release yet.

Enable immutable releases and verify the repository Actions default remains read-only. Run the workflow `prepare` operation for `v0.1.0`; inspect the draft target, generated notes, installer asset, digest, and successful run. Run `publish`, then verify the immutable badge, latest API, asset digest, tag commit, public installer, up-to-date update command, and direct update of a clean #6/#8 pre-release checkout. Only then replace the README raw-main curl command and close #7.

For every later release, the order is fixed: merge reviewed source, run the production-shaped previous-release-to-candidate and recovery oracle, prepare the draft, inspect it, publish it, then repeat the public latest/install/update checks. Publication is the promotion event; a commit on `main` is not an update.

If the first or a later published release is bad, stop recommending new installs, fix or revert on `main`, pass the same gates, and publish a higher patch version. Do not mutate the published tag/asset or point latest backward. Existing installations remain on their current immutable release until they explicitly update.

## What was rejected

- **Keep updating from `main`:** rejected because a branch head is a development state, not a deliberate user promotion with a version, notes, immutable target, or release gate.
- **Use `git pull && bin/install.sh`:** rejected because Git configuration can select an unintended upstream, the running script can replace unread source, active MCP children retain old code, and failures have no frozen target or exact recovery record.
- **Publish on every push to `main`:** rejected because merging code and promoting an installed release are different decisions. Manual prepare and publish operations keep the human release boundary visible.
- **Publish immediately in one workflow run:** rejected because GitHub recommends drafting, attaching all assets, then publishing; the second operation gives the operator a real notes, target, and digest inspection point.
- **Use mutable tags or replace an asset in place:** rejected because an updater needs a durable version-to-bytes mapping. GitHub immutable releases lock both and create a release attestation.
- **Download GitHub's generated source archive as the install artifact:** rejected because GitHub's verification command does not cover generated source archives and the archive cannot embed the exact release identity before executing. The small attached installer is digest-addressed release content and fetches the exact tag.
- **Require `gh` on every developer machine:** rejected because the public release and metadata are readable without authentication. `gh` belongs only to GitHub's workflow/operator verification surface.
- **Add automatic rollback:** rejected for the first updater because current startup can make one-way persistent changes. Publication gates reduce the failure probability; the updater preserves evidence and prints an exact installer-clean recovery instead of claiming unsafe automation.
- **Add automatic checks, channels, version selection, or downgrades:** rejected because one explicit latest-full-release command is the current user need. Extra policy has no committed consumer.
- **Update third-party prerequisites:** rejected because their publishers and package managers own those trust and lifecycle decisions.
- **Use a manually bumped compatibility epoch:** rejected because it protects recovery only when a human remembers to bump it. The release workflow instead refuses any post-first-release change to AppView's migration surface until a separate reviewed migration design changes the gate and recovery contract.

## Sources

- `README.md:253-268`, inspected 2026-09-02: current updates require exiting sessions, pulling, rebuilding MCP and AppView, restarting services, and relaunching sessions.
- `appview/src/db.ts:104-158`, inspected 2026-09-02: startup migration code drops a column and rebuilds a table, so source-only rollback cannot cover arbitrary releases.
- Repository probes on 2026-09-02: `git ls-remote --tags origin` returned no tags; public `GET /repos/natewalton/ait-protocol/releases/latest` returned 404; authenticated `GET /repos/natewalton/ait-protocol/immutable-releases` returned `enabled:false` while the same settings endpoint returned 401 without a token; Actions default workflow permission returned `read`.
- Controlling review on 2026-09-02 (`at://did:plc:eunzexjghq6b4zx2y2oj7f57/ait.feed.post/3muj4l7cyyd27`): accept the immutable release design; treat no-`VERSION` managed checkouts as pre-release installs, replace the manual compatibility epoch with a migration-surface publication gate, and forbid source reset after target AppView starts.
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases), inspected 2026-09-02: publication locks the associated tag and assets and creates a release attestation; GitHub recommends draft, attach all assets, then publish.
- [GitHub release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release), inspected 2026-09-02: the public latest endpoint returns the latest published full release, excludes drafts and prereleases, and exposes release/tag/asset metadata including asset digests.
- [GitHub release integrity verification](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity), inspected 2026-09-02: `gh release verify` and `gh release verify-asset` verify immutable releases and attached assets; generated source archives are explicitly excluded from asset verification.
- [GitHub generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes), inspected 2026-09-02: notes can be generated from the previous tag and inspected before publication.
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use), inspected 2026-09-02: use least-privilege tokens, pass untrusted values without shell interpolation, and pin referenced actions to full commit SHAs.
- [GitHub workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions), inspected 2026-09-02: unspecified permissions become `none` when explicit permissions are declared.
- [GitHub Actions concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency), inspected 2026-09-02: workflows otherwise run concurrently; a concurrency group serializes release mutation.
- [uv upgrading](https://docs.astral.sh/uv/getting-started/installation/#upgrading-uv), [Claude Code updates](https://code.claude.com/docs/en/setup), [OpenCode upgrade](https://dev.opencode.ai/docs/cli/#upgrade), and [Rustup self-update](https://rust-lang.github.io/rustup/basics.html#keeping-rustup-up-to-date), inspected 2026-09-02: installer-owned tools expose an explicit self-update command, while package-manager-owned installs defer to that manager.
- [Git `pull --ff-only`](https://git-scm.com/docs/git-pull), inspected 2026-09-02: fast-forward-only history refuses divergence; AIT applies the same ancestry condition to an exact immutable release tag without following a branch head.
