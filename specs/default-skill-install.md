# Install AIT coordination skills with the machine bootstrap

Status: frozen correction candidate, 2026-09-02. Tracked by [#8](https://github.com/natewalton/ait-protocol/issues/8); implement after [#6](https://github.com/natewalton/ait-protocol/issues/6) and before #7 to avoid shared-file overlap.

## Why

AIT already ships its delivery-coordination skill, but the machine install path is separate and optional. A developer must find a later README section and run `bin/install-skill.sh` from the checkout (`README.md:132-138`, inspected 2026-09-02). That is easy to miss even though the skill contains the session, review, release, and done-state contract AIT work relies on.

The current script also makes assumptions the public bootstrap should not inherit. It creates both `~/.claude/skills/delivery-coordination` and `~/.agents/skills/delivery-coordination` without checking whether Claude or Codex is installed (`bin/install-skill.sh:12-39`). Installation uses `ln -sfn`, so it silently repoints any existing symlink. Removal deletes any symlink at either target without proving it resolves to this checkout's skill (`bin/install-skill.sh:22-28`). A machine-wide default must fail closed around another tool or checkout's user configuration.

Verdict: fix after the base CLI ships. A fresh standard AIT bootstrap should install the coordination skill for each supported harness actually present on the machine. A developer whose policy forbids user-level skill links should have one visible pre-write opt-out, `AIT_NO_SKILLS=1`. Later changes should be explicit, inspectable, and reversible through `ait skills install|remove|status`. `ait init` must remain project enablement only.

The crude solution is the chosen one: keep one repository skill source and the existing symlink script, add direct Claude/Codex availability branches and exact ownership checks, call it once from a fresh machine bootstrap, and dispatch three CLI verbs. An adapter registry, persisted preference, lock subsystem, or harness-specific project flags add no current value.

## The proposed work

The ordinary public bootstrap stays unchanged. On a fresh machine it installs the skill by default. The uncommon policy opt-out composes with the same command:

```bash
AIT_NO_SKILLS=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/natewalton/ait-protocol/main/install.sh)"
```

`AIT_NO_SKILLS` is the bootstrap's only skill option. The only accepted value is `1`; any other non-empty value fails in prerequisite preflight before checkout, service, skill, or harness configuration writes. This environment option is not a general CLI flag and is not read by `ait init`, `ait start`, harness launch, or `ait update`.

### Keep the common install automatic

The remote wrapper invokes default skill installation only when that invocation successfully creates the managed checkout. The private installer detects Claude and Codex directly with their native executables. It never asks the user to select a harness and never creates another harness's configuration directory.

For a fresh managed checkout:

- No option installs the skill for every detected harness.
- `AIT_NO_SKILLS=1` writes no skill target and reports `skills   skipped (AIT_NO_SKILLS=1)`.
- A target collision is part of preflight when the default is enabled. The installer changes nothing and prints the exact path plus two recoveries: move the existing target aside and rerun, or rerun with `AIT_NO_SKILLS=1` to preserve it.

A bootstrap rerun against an existing managed checkout never installs, removes, repairs, or reports skills, regardless of whether that installation predates this feature. It prints the ordinary #6 rerun result and points `ait skills install|remove|status` users to the explicit lifecycle commands in help. This makes a fresh bootstrap the only default-on event and prevents a later installer rerun from changing established machine-wide agent behavior.

The fresh-install success summary has one short skills row after the harness rows:

```text
skills   ready (claude, codex)
skills   ready (claude)
skills   skipped (AIT_NO_SKILLS=1)
```

### Change or inspect the choice directly

The installed CLI adds:

| Command | Result |
| --- | --- |
| `ait skills install` | Install or verify the managed link for each detected harness. |
| `ait skills remove` | Remove only managed links. |
| `ait skills status` | Classify both harness targets without changing anything. |

`ait help skills`, `ait skills --help`, and each subcommand's `--help` include usage, the two user-level targets, collision behavior, discovery timing, examples, recovery, and exits. Unknown or extra arguments exit `2`; successful help and lifecycle operations exit `0`; collision, source, filesystem, or verification failures exit `1`.

`ait skills install` performs complete preflight before writes. It requires the managed source `.agents/skills/delivery-coordination/SKILL.md`, detects installed harnesses, and classifies each applicable target. An absent target is installable; a symlink resolving to this managed source is already ready; every regular file, directory, broken symlink, or link to another source is a conflict and is preserved. With no installed supported harness, it fails and prints both harness installation remedies instead of creating directories nobody uses. After preflight, it creates only missing parent directories and non-replacing symlinks, verifies every applicable resolved target, and prints one result row per harness. If another process creates a target after preflight, the non-replacing link operation fails instead of overwriting it. If a filesystem failure or signal interrupts target creation, it exits nonzero, lists the exact completed and missing links, and prints `ait skills install` as the idempotent resume; it never prints a ready row for an incomplete operation.

`ait skills remove` first classifies both targets. Immediately before each unlink it revalidates that the target is a symlink whose fully resolved destination is the exact managed skill source. It never removes a regular file, directory, broken link, or link to another checkout. Foreign targets are reported as preserved. It removes the managed links and verifies they are absent. If a filesystem failure or signal interrupts removal, it exits nonzero, lists the remaining managed links, and prints `ait skills remove` as the idempotent resume. Repeating a complete remove is successful and unchanged.

`ait skills status` is read-only and works while AIT services are stopped. It derives one stable row for each harness target solely from harness presence and resolved link ownership:

- `ready` when the harness exists and the link resolves to the managed source;
- `ready (harness not installed)` when an exact managed link remains after that harness is removed;
- `not installed` when the harness exists and the target is absent;
- `conflict (<resolved-or-literal-path>)` for a non-owned target;
- `skipped (harness not installed)` when the harness executable is unavailable and the target is absent;
- `conflict (target exists; harness not installed)` when an unavailable harness has a non-owned target.

Every successful install, remove, or bootstrap result says: `Start a new harness session for a guaranteed result.` Claude and Codex may discover a changed user skill sooner, but AIT does not promise identical live-reload timing across harnesses or rewrite an already-loaded instruction body. Symlinks point into the managed checkout, so accepted source updates change skill content without replacing the link. The release updater in #7 preserves link bytes and does not run a skill lifecycle operation.

`ait init` never reads, writes, installs, removes, or reports machine-wide skills. Its target is a project; user-level skill lifecycle remains a machine operation.

## Files touched

Six implementation files:

1. `install.sh` validates the bootstrap-only opt-out and invokes default skill setup only after creating a fresh managed checkout.
2. `ait` adds `skills` dispatch and complete help without changing `init`.
3. `bin/install.sh` preflights and invokes the skill lifecycle during fresh machine bootstrap only.
4. `bin/install-skill.sh` gains detected-harness targeting, exact ownership checks, status, and idempotent install/remove operations.
5. `bin/ait-skill-test.sh` isolates home, PATH, source, target, collision, interruption, and harness fixtures.
6. `README.md` states the default, shows the one-line opt-out and lifecycle commands, and removes the separate manual-install step from the common journey.

No package manifest, lockfile, application source, service script, environment template, database, project MCP configuration, release workflow, updater, or vendored skill-content changes.

## Out of scope

- Installing Claude, Codex, or any other harness. AIT diagnoses absent supported harnesses; their publishers own installation.
- Supporting Cursor, VS Code, Goose, Gemini, or another skill-discovery location. Each needs direct detection, path, load, removal, and production verification before support.
- Installing project-local skill copies or links. The machine bootstrap manages only the exact user-level target for each detected harness.
- Adding skill flags to `ait init`, changing `.agents/skills` or `.claude/skills` in a target project, or coupling project MCP trust to skill installation.
- Managing arbitrary skills, versions, registries, marketplaces, or remote skill sources. This slice has one source already shipped in AIT and one direct consumer command.
- Overwriting, deleting, adopting, or automatically migrating another checkout's link, a real directory, a broken link, or another file at either target.
- Reloading or restarting active Claude or Codex sessions.
- Changing the contents of the delivery-coordination skill itself.
- Making the release updater install or remove skill links. The symlink follows the managed source; lifecycle choice remains explicit after bootstrap.

## Tests

Run from the frozen implementation revision:

```bash
bash -n install.sh ait bin/install.sh bin/install-skill.sh bin/ait-skill-test.sh
bin/ait-test.sh
bin/ait-skill-test.sh
```

`bin/ait-skill-test.sh` uses a temporary checkout, home, PATH, state directory, and command shims. It fails if a case reaches the operator's actual skills, config, state, checkout, services, or sessions. It covers:

- help agreement and usage exits for `ait skills`, `install`, `remove`, and `status`, with no writes from help or status;
- fresh default Claude-only, Codex-only, and dual-harness installs creating only detected-harness directories and exact managed links;
- fresh `AIT_NO_SKILLS=1`, invalid option values, and bootstrap reruns that leave every target unchanged;
- absent, exact managed, foreign symlink, broken symlink, real file, real directory, missing source, read-only parent, and partial-operation failure states with complete preflight and preserved foreign bytes;
- partial link install/remove, idempotent resume, interruption, and target creation or replacement races that preserve non-owned paths;
- repeated install and remove idempotency, newly added harness reconciliation through explicit install, and removal proving exact resolved ownership before unlink;
- stable status rows for every harness and target combination;
- next-session guarantee on every mutation, harness-specific earlier discovery where supported, and source-content change appearing through the unchanged managed link;
- `ait init`, start/stop/status, harness launch, a bootstrap rerun, and a release-style rebuild leaving target hashes unchanged.

The production oracle starts with a clean macOS user or disposable VM and runs the standard public bootstrap with Claude only, Codex only, and both. For each, inspect the printed skills row, target paths, resolved source, permissions, and missing-harness directory absence; start a new installed-harness session and prove it loads the delivery-coordination skill. Repeat a fresh install with `AIT_NO_SKILLS=1`, prove no target exists and a new session does not load the global skill, then run install, status, remove, and status again and verify each next-session result.

Create one unrelated real directory and one symlink to a different checkout at the target paths in an isolated user. Prove the standard bootstrap and explicit install preserve them byte-for-byte and print both safe recoveries; prove the opt-out bootstrap succeeds without touching them; prove remove never unlinks them. Run `ait init` and a bootstrap rerun between every state and require all target hashes to remain unchanged. The controlling reviewer repeats the released default, opt-out, conflict, reversal, and next-session checks.

## Sequencing or rollout

Implement after #6 is released and closed. Because this spec overlaps `install.sh`, `ait`, `bin/install.sh`, and `README.md` with #7, land and release #8 first. The #7 updater then treats links as preserved machine state and its regression test locks that invariant. Neither issue may edit the shared files while the other has a frozen review lease.

Freeze one clean revision and have one read-only reviewer verify the parent, file and patch hashes, all fixture states, ownership failures, and production-shaped next-session behavior. Merge only the approved revision, rerun the suite from `main`, exercise the public bootstrap default and opt-out, and have the same reviewer repeat the live result before closing #8.

Accepted implementation deviation: collision classification remains delegated
to the private installer after a fresh checkout is created. The durable
bootstrap-pending marker makes both move-aside and `AIT_NO_SKILLS=1` reruns
converge, without duplicating collision classification in the public wrapper.

Existing #6 installations retain their target bytes on every bootstrap rerun and can opt in explicitly with `ait skills install`. Fresh installations default on unless the bootstrap carries `AIT_NO_SKILLS=1`. No existing target is automatically adopted or removed. Rollback restores the prior source revision and leaves target bytes unchanged; exact managed links continue to point at the restored skill source.

## What was rejected

- **Keep skills as a later optional README step:** rejected because the standard AIT work contract remains easy to miss and the user explicitly chose default installation with a simple opt-out.
- **Make skills opt-in through `ait skills install`:** rejected because it preserves the current fragmented common path. Explicit install remains the recovery for legacy installs and later reversal, not the fresh default.
- **Add `--no-skills` after `ait init`:** rejected because project enablement and user-level agent behavior have different targets and trust boundaries. Init changes only the selected project.
- **Add a general bootstrap flag parser:** rejected because there is one uncommon policy choice and the safe curl command has no natural argument position. One validated environment value composes without changing the common command.
- **Install both harness targets unconditionally:** rejected because creating an absent platform's user configuration implies integration the machine does not have.
- **Persist enabled/disabled preference:** rejected because fresh bootstrap behavior needs only its one invocation's option, while later explicit commands can classify actual state from resolved link ownership. Persisting desired state creates migration, reconciliation, and locking machinery without improving the two symlinks' safety.
- **Silently repoint an old or foreign symlink:** rejected because symlink type does not prove ownership. The installer names the collision and gives a move-aside or opt-out recovery.
- **Let remove delete any symlink at the name:** rejected because the current script can delete another checkout's configuration. Removal requires the fully resolved exact managed source.
- **Copy skill files instead of linking:** rejected because copies become stale on accepted source updates and need a second version lifecycle. An owned symlink keeps one source of truth.
- **Package only the Codex side as a plugin:** rejected because AIT is installing one open-format skill for two harnesses with different plugin systems. Both officially support the direct user-level skill path and Codex follows symlinked skill directories; a harness-specific package would reintroduce separate user workflows.
- **Build a harness adapter registry:** rejected because there are two measured targets and direct availability branches are smaller, clearer, and independently testable.
- **Reload active sessions automatically:** rejected because harnesses own their loaded instruction lifecycle. A precise next-start notice is truthful and non-destructive.

## Sources

- `README.md:132-138`, inspected 2026-09-02: global skill installation is a separate optional checkout-relative command after project setup.
- `bin/install-skill.sh:1-15,32-44`, inspected 2026-09-02: the script targets both Claude and Codex directories unconditionally and uses repository symlinks so source updates flow through.
- `bin/install-skill.sh:22-28`, inspected 2026-09-02: removal currently deletes any symlink at either path without verifying its destination.
- `bin/install-skill.sh:32-39`, inspected 2026-09-02: install refuses only a real directory and uses `ln -sfn`, which repoints an existing symlink regardless of ownership.
- Operator direction in this design session on 2026-09-02: the standard machine bootstrap installs skills, the uncommon path uses a simple opt-out, and project init remains a separate operation.
- Controlling review on 2026-09-02 (`at://did:plc:eunzexjghq6b4zx2y2oj7f57/ait.feed.post/3muj4l3h45d27`): preserve default-on plus `AIT_NO_SKILLS=1`, derive lifecycle state from exact link ownership, and cut the preference file and skill-operation lock.
- [uv installer options](https://docs.astral.sh/uv/reference/installer/), inspected 2026-09-02: uncommon curl-installer policy choices are expressed through environment variables rather than expanding the common command.
- [Claude Code skills](https://code.claude.com/docs/en/slash-commands), inspected 2026-09-02: `~/.claude/skills/<name>/SKILL.md` is the personal cross-project location; skill-directory changes can be detected live, while creating a previously absent top-level skills directory requires restart.
- [Official OpenAI Codex skills](https://developers.openai.com/codex/skills/), inspected 2026-09-02: `$HOME/.agents/skills` is the user location across repositories, Codex follows symlinked skill directories, and a restart is the fallback when a change is not detected automatically.
