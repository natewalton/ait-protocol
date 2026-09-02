# Install and run AIT through one CLI

Status: reviewed, 2026-09-02.

## Why

A developer at a fresh macOS terminal currently has no supported path from the repository page to an installed AIT command. After cloning manually, they still follow eight README stages before the first project can use AIT: install and start PostgreSQL, create a database, run four package installs, run two builds, paste a 34-line environment block, start the network, probe three health endpoints, and register the MCP in a project (`README.md:13-130`, verified 2026-09-01).

The recurring path is fragmented too. Starting or stopping AIT requires a repository-relative script (`README.md:95-103`); Claude push sessions require a separate manually-created `ait-push` symlink (`README.md:142-159`); Codex sessions require `bin/codex-session.sh` from the AIT checkout (`README.md:247-251`, `bin/codex-session.sh:17-28`). The launchers correctly preserve current-directory project selection and harness-specific identity behavior, but users must remember where AIT is checked out and which script belongs to which harness (`bin/claude-session.sh:11-25`, `bin/codex-session.sh:17-28`).

The install path also has two correctness traps:

- The environment block refuses to run when any one of the four `.env` files exists (`README.md:54-93`). That protects secrets from overwrite, but makes an ordinary rerun fail instead of verifying and reusing the install.
- The required tools are discovered at different stages. `bin/start-all.sh` unconditionally starts the Codex app-server (`bin/start-all.sh:63-66`), and its wrapper is where a missing Codex CLI finally fails (`bin/run-codex-appserver.sh:30-53`). That is an active negative on a Claude-only machine. The product should require at least one supported harness, detect both before writes, and start only the installed harness integration.

Current polished developer tools converge on a small interaction pattern: Codex, Claude Code, OpenCode, Goose, and uv each put a standalone curl installer at or near the front of their setup; the installer leaves one command on `PATH`; and the next action is expressed through that command rather than another repository-relative script. AIT should match that experience without pretending its PostgreSQL, Node, and harness-specific behavior do not exist. The elegant path is one public install command, four short progress phases, one project command, and complete built-in help; internal checkout and service details appear only when recovery needs them.

There is no universal project configuration to write instead. MCP standardizes transport, while harnesses own discovery and trust: Claude project scope uses `.mcp.json` and a trust gate; AIT's Codex path uses the project as the launcher's working directory and injects a distinct AIT identity per app-server thread (`mcp/src/codex/host.ts:223-241`). The user should express “enable AIT in this project”; the AIT CLI should absorb those differences.

Verdict: fix now. The day this ships, a developer pastes one curl command from the top of the README and finishes with AIT installed, its shared stack healthy, and a durable `ait` CLI ready to enable the first project. That CLI owns project setup, service health, complete help, and Claude or Codex launch. The crude version is a shell alias for each current script plus the README commands pasted into another script. It is rejected because it starts after an unexplained checkout step, preserves unsafe reruns and late prerequisite failures, and leaves a pile of unrelated command names.

## The proposed work

The first complete journey is:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/natewalton/ait-protocol/main/install.sh)"
cd /absolute/path/to/my-project
ait init
ait claude "join AIT as @my-project-spec.test and wait"
# or: ait codex "join AIT as @my-project-build.test and wait"
```

The remote `install.sh` is the only public bootstrap. It checks prerequisites, obtains AIT at `$HOME/.local/share/ait-protocol`, and invokes that checkout's private machine installer. AIT has one shared local network, so there is no local/global install mode and no `--global` flag. Machine installation provisions or verifies the stack and links the checkout's root `ait` executable at `$(brew --prefix)/bin/ait`. Project enablement is a separate command with a separate verdict.

The command surface is:

| Command | Outcome |
| --- | --- |
| `ait init` | Enable or verify AIT in the current project resolved by the rules below. |
| `ait init <path>` | Enable or verify AIT in an explicitly named project. |
| `ait start` / `ait stop` / `ait status` | Operate or inspect the shared stack through the repository's supported service scripts. |
| `ait claude [args…]` | Launch the existing Claude push session in the caller's current directory. |
| `ait codex [args…]` | Launch the existing Codex session in the caller's current directory. |
| `ait help` / `ait --help` | Show commands and examples without changing state. |
| `ait version` / `ait --version` | Show the installed checkout's exact Git revision without contacting the network. |

The root executable is a symlink-aware Bash dispatcher, available before Node dependencies are installed. Whether invoked directly or through the global link, it resolves its physical checkout before locating private scripts. It keeps install, service, and harness behavior in the existing focused scripts rather than copying their logic into the dispatcher.

### Get complete help in the CLI

Help is part of the public interface and is available after the bootstrap without a repository path. `ait help`, `ait --help`, `ait help <command>`, and `ait <command> --help` cover every public command. Every command page concisely includes its purpose, usage, arguments and options, prerequisites, files or services it may change, examples, normal result, common failure recovery, and exit behavior. Help commands are read-only, work when the AIT services are stopped, and exit zero. The CLI uses three documented exits throughout: `0` for success and help, `2` for invalid commands or arguments, and `1` for prerequisite, conflict, service, or harness failures. An unknown command prints `Run: ait help` and no unrelated suggestions.

The root dispatcher contains the canonical help text beside command dispatch. The README keeps only the curl-first quickstart, the first-project sequence, and a compact command index linked to `ait help`; it does not maintain a second full manual that can drift from the CLI.

Until AIT has a release updater, root help also documents the supported manual update sequence exactly:

```bash
ait stop
git -C "$HOME/.local/share/ait-protocol" pull --ff-only
"$HOME/.local/share/ait-protocol/bin/install.sh"
ait start
```

The private installer rebuilds the stopped checkout and normally returns with the stack healthy. The final `ait start` is deliberately idempotent: it makes the expected final state explicit and safely verifies or adopts the complete stack.

### Install AIT from one terminal command

The README begins with exactly this command:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/natewalton/ait-protocol/main/install.sh)"
```

The fetched root `install.sh` is a small delivery wrapper around the checkout's installer. The command-substitution form is part of the contract: `curl` must finish successfully before Bash receives any installer source, so a truncated download executes nothing and child commands inherit the terminal's stdin rather than the remainder of a piped script. Before writing, the wrapper verifies macOS, Git, Homebrew, Node and npm, Claude Code and Codex availability, OpenSSL, curl, the destination, and the future CLI link. Claude and Codex are independently optional, but at least one must be installed. The wrapper reports every missing required prerequisite in one stable list and exits nonzero without cloning, linking, provisioning, or starting anything. When neither harness exists, that list includes both official harness remedies. Each failure includes one concise copy-paste command and the official documentation URL:

- Homebrew: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
- Node and npm: `brew install node`
- Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
- Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`
- Git, when absent after Homebrew is available: `brew install git`

The bootstrap never executes those prerequisite installers. After the developer follows the printed remedies, rerunning the same README curl command is the complete recovery path.

When preflight passes and `$HOME/.local/share/ait-protocol` is absent, the bootstrap clones `https://github.com/natewalton/ait-protocol` there and invokes its private machine installer. An existing directory is accepted only when it is the expected AIT checkout with the expected origin and executable root CLI; the bootstrap does not pull or replace it. Any collision fails unchanged and prints the exact path. A clone or machine-install failure exits nonzero and never prints success. A successful run ends with the installed CLI path, healthy service table, and these literal next steps:

```text
cd /path/to/your/project
ait init
ait help
```

Normal output is deliberately short and phase-based: `Prerequisites`, `AIT files`, `Services`, and `CLI`, each ending in a checkmark or one actionable error. It does not expose npm sub-builds, database plumbing, adapter names, or internal script paths unless a phase fails. The success banner appears only after `ait`, `ait help`, and the real service probes succeed from the installed path.

The success result includes one plain row per supported harness. An installed harness reports `ready`; an unavailable one reports, for example, `codex   skipped (not installed)`, with no warning styling, failure exit, or launch next-step for that harness. Nothing is hidden and no unavailable platform is treated as broken.

### Install AIT on the machine

The checkout's machine installer has this contract:

1. Recheck macOS, Git, Homebrew, Node, npm, Claude Code and Codex availability, OpenSSL, curl, the checkout shape, the four-file environment state, running AIT processes, and the proposed `$(brew --prefix)/bin/ait` target before writes. Require at least one of Claude or Codex. Use the same complete prerequisite report, skip rows, and remedies as the remote wrapper. Do not download or execute prerequisite installers.
2. Accept an absent command link or an existing link which resolves to this checkout's root `ait`. Refuse a regular file, directory, or link to another checkout; print the exact collision and do not replace it. Create the link only after preflight. If later provisioning fails, keep the valid link deliberately, report the incomplete stack, and print the original README curl command as the recovery.
3. Install `postgresql@17` through Homebrew only when absent, start its service idempotently, resolve clients below `$(brew --prefix postgresql@17)/bin`, and create `plc_directory` only when absent. Preserve an existing database and rows.
4. Treat `plc/.env`, `pds/.env`, `appview/.env`, and `mcp/.env` as one set. None present starts one resumable transaction: create an owner-only install-state directory containing all four staged files plus a manifest of target paths and hashes before publishing any target, then publish the staged files in one loop with owner-only permissions. Remove the transaction only after all four targets exist and match the manifest. On SIGINT or another interruption, exit nonzero and retain that state. A rerun with a partial target set resumes only when the install-state manifest is complete, every present target matches its staged hash, and every missing target still has its staged source; it publishes the missing targets without regenerating secrets. A partial set without that exact installer-owned proof, or with any mismatch, fails unchanged and lists present and missing files. All four present means preserve their bytes; a matching leftover transaction may then be cleared.
5. With no AIT service from this checkout running, run `npm ci` in `plc`, `pds`, `appview`, and `mcp`; build `appview` and `mcp`; and run `bin/check-single-lexicon.sh`. A complete healthy running stack with all dependency trees and built entry points is verified without running npm or build. A partial, unhealthy, or different-checkout service set fails before dependency writes and names the conflicting processes plus `ait stop` recovery.
6. Start the core stack through `bin/start-all.sh`: PLC, PDS, and AppView. Start the shared Codex app-server only when Codex is installed; a Claude-only machine creates no Codex socket or background process. This is automatic discovery, not a harness-selection flag.
7. Declare success only after `ait status` receives successful JSON from the three HTTP health endpoints and, when Codex is installed, connects to the Codex Unix socket. Elapsed time alone never means ready. Print the linked CLI path, checkout path, concise service and harness tables, logs on failure, `ait init`, and only the installed harness launch commands.

Re-running the README command or the installed checkout's private machine installer preserves the database and every environment-file byte, including a verified resume of an interrupted four-file publication. It verifies a complete healthy live stack without changing dependencies or builds; a stopped stack takes the clean locked install/build path and then starts.

### Enable AIT in a project

`ait init` targets the project a developer would expect rather than requiring a path they have already expressed by changing directory:

1. A positional `<path>` uses that existing directory exactly after physical-path resolution.
2. With no path, a Git worktree uses `git rev-parse --show-toplevel`, so invocation from a nested source directory selects the repository root.
3. Outside Git, walk upward from the current directory, stopping before `$HOME` and `/`, and select the nearest directory containing an existing boundary: `.mcp.json`, `.codex/config.toml`, `.claude/`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, or `Gemfile`.
4. If no boundary is found, fail before writes, show the directory inspected, and offer `ait init "$PWD"` as the explicit override. Never infer `$HOME` as a project.

The CLI prints the resolved project before mutation and verifies that the shared core stack and built MCP are ready. It does not prompt for a harness or expose harness-specific install flags. At least one supported harness was established during machine installation; each is handled directly when present:

- If Claude is installed, inspect only `mcpServers.ait-protocol` in the target `.mcp.json`. An exact entry naming `node --enable-source-maps <this-checkout>/mcp/dist/server.js` is already configured. A conflicting entry fails unchanged with expected/actual values and the native removal remedy. When absent, invoke `claude mcp add --scope project` from the target. There is no pretend dry-run: the native add is the mutation and its failure propagates. Afterward, require the exact entry and a successful `claude mcp get ait-protocol`. `Connected` and `Pending approval` are both valid configured states; the CLI never bypasses the first-session trust gate.
- If Codex is installed, create no `.codex/config.toml`. Verify the shared app-server, built MCP, and executable `bin/codex-session.sh`, then report `ready (no project file required)`. The Codex launcher already uses the caller's working directory and supplies identity per thread.
- For each missing harness, print the same plain `skipped (not installed)` row used by machine installation and omit its launch next-step. This is a successful project result when the other harness is ready.
- When both are installed, complete the Codex read-only readiness checks before asking Claude's native CLI to write, avoiding a late Codex failure after `.mcp.json` changes.

A project rerun preserves unrelated `.mcp.json` entries and an exact AIT entry, repeats consumer-visible health and harness checks, and returns the same summary.

### Operate AIT and launch sessions

`ait start`, `ait stop`, and `ait status` are thin dispatchers. Start retains current process adoption and duplicate prevention; stop retains current port/socket ownership checks; status is read-only and shows the same three HTTP probes plus `running`, `unreachable`, or `skipped (not installed)` for the Codex app-server. `bin/start-all.sh` calls the same status script so installation and daily operation cannot disagree about health.

`ait claude` and `ait codex` preserve the caller's working directory, reject an unhealthy core stack with `run: ait start`, verify the selected native CLI exists, and then `exec` the existing launcher with every remaining argument unchanged. `ait claude` also requires `claude mcp get ait-protocol` to find the current project's configured entry; pending trust remains valid. Because dispatch uses `exec`, the harness owns the terminal, exit status, and signals exactly as it does under direct launcher invocation. The launchers' user-facing examples and errors change to the canonical `ait claude` / `ait codex` spelling while direct script invocation remains supported for development.

The CLI does not auto-start a stopped stack when launching a harness. Starting background services is a distinct user action, and the one-line recovery is visible.

## Files touched

Nine implementation files:

1. `install.sh` is the curl-delivered prerequisite, checkout-acquisition, and handoff wrapper.
2. `ait` is the checkout-root, symlink-aware Bash CLI, command dispatcher, and canonical help surface.
3. `bin/ait-test.sh` covers bootstrap fixtures, CLI parsing, complete help, root discovery, dispatch, and install behavior without touching live state.
4. `bin/install.sh` contains private machine and project install operations called by the bootstrap and CLI.
5. `bin/status.sh` owns the read-only service probes used by the CLI and supervisor.
6. `bin/start-all.sh` delegates its final health table to `bin/status.sh`, always starts the three core services, and starts the Codex app-server only when Codex is installed.
7. `bin/claude-session.sh` renders CLI-native launch and recovery examples while retaining session behavior.
8. `bin/codex-session.sh` renders CLI-native launch and recovery examples while retaining session behavior.
9. `README.md` puts the curl command first, shows the three-line first-project journey, points to CLI help, and keeps manual commands as diagnosis/reference.

No package manifest, lockfile, application source, environment template, service wrapper, database schema, lexicon, or launchd template changes.

## Out of scope

- Automatically installing Git, Homebrew, Node, Claude Code, or Codex. The bootstrap diagnoses them and gives official copy-paste remedies, but the developer decides whether to run each third-party installer.
- Pulling updates into an existing managed checkout, publishing an npm package or Homebrew formula, producing a signed release artifact, or adding an auto-updater. The first slice installs the repository's current `main` checkout and reuses it unchanged on a rerun.
- Linux, Windows, containers, remote deployment, or more project-boundary markers than the explicit list above.
- Configuring Cursor, VS Code, Goose, Gemini, or another harness. Each requires measured project configuration, trust, launch, and production verification before support.
- Installing the delivery-coordination skill globally or changing `.agents/skills` / `.claude/skills` in the target project.
- Merging `aitty`'s human end-client commands into `ait`.
- User-scope MCP configuration, a static Codex project MCP entry, or bypassing Claude's trust approval.
- Persistent launchd installation by default. `bin/install-services.sh` remains an explicit higher-commitment path.
- Destructive database/environment repair, uninstall, or removal of another checkout's command link.
- Updating dependencies or builds underneath running sessions.
- Auto-starting services as a side effect of `ait claude` or `ait codex`.

## Tests

`bin/ait-test.sh` runs against a temporary checkout, home, project set, Homebrew prefix, and command shims. It fails if any case reaches the operator's real environment files, database, ports, PID files, socket, command directory, or harness config. It covers:

- help and invalid command/option paths make no changes and return stable usage exits; root help includes the exact stop, fast-forward pull, private-installer, and idempotent start update sequence;
- root help lists every public command once; `ait help <command>` and `ait <command> --help` agree for `init`, `start`, `stop`, `status`, `claude`, `codex`, `help`, and `version`; every page includes usage, arguments/options, prerequisites, side effects, examples, normal result, recovery, and exit behavior;
- `ait version` and `ait --version` agree on the installed checkout's exact revision, make no network call, and work while every service is stopped;
- the fetched bootstrap's fresh install, exact-checkout rerun, destination collision, clone failure, and private-installer failure preserve the declared boundaries and only the successful path prints the next project commands; an HTTP fixture that truncates the script after a syntactically valid write-capable prefix proves no prefix executes, while a successful installer child reads a sentinel from the caller's stdin rather than installer source;
- direct root and globally linked invocations resolve the same checkout, including paths with spaces and relative symlink targets;
- install preflight reports every missing required prerequisite before writes in the declared stable order, with the exact official command and URL for Git, Homebrew, Node/npm, Claude Code, and Codex; Claude-only and Codex-only installs succeed with one ready and one plain skipped row, while neither-harness fails with both remedies; an absent/exact command link is accepted and any other target is preserved with a collision error;
- a failure after linking leaves the valid command usable for a nonzero rerun and never prints a healthy stack;
- fresh, healthy-rerun, conflicting partial-env, conflicting-process, database, npm, build, lexicon, HTTP, and socket cases implement the machine install contract; interruption before each of the four environment publishes leaves no false success, and the next invocation resumes from the exact staged manifest, preserves already-published hashes, and removes transaction state only after all four targets match;
- Claude-only, Codex-only, and dual-harness machine and project paths expose the exact ready/skipped rows, start no unavailable harness process, and offer only valid launch next-steps; an explicitly selected missing launcher still fails with its specific install remedy;
- `ait init` from a Git subdirectory chooses the worktree root; outside Git it chooses the nearest listed marker; it stops before home/root; an unrecognized location fails before writes; an explicit path is used exactly;
- Claude absent/exact/conflicting/add-failure/add-success cases preserve unrelated entries and accept native `get` output reporting either connected or pending approval;
- project installation creates no Codex project file and, when both harnesses exist, completes Codex readiness before Claude mutation;
- repeat `ait init` leaves complete `.mcp.json` and environment hashes unchanged;
- `ait start`, `stop`, and `status` call the intended repository scripts and propagate their exits;
- `ait claude` and `ait codex` preserve cwd, arguments, exit status, and environment; unhealthy stack and missing native CLI fail before launcher execution; Claude pending approval may launch;
- bare and named/ID resume forms reach the existing launchers unchanged.

Run:

```bash
bash -n install.sh ait bin/ait-test.sh bin/install.sh bin/status.sh bin/start-all.sh bin/claude-session.sh bin/codex-session.sh
bin/ait-test.sh
```

The production oracle is a clean macOS user or disposable macOS VM with the declared prerequisites, no AIT checkout, and a separate Git target containing one unrelated MCP entry. Paste the README curl command into the terminal twice; both runs succeed, `ait --help` works from an unrelated directory, and the second run preserves database rows and environment hashes. From a nested target directory, run `ait init` twice and confirm it chooses the Git root and preserves the complete second-run `.mcp.json` hash. Run this journey with Claude only, Codex only, and both installed; verify exact ready/skipped rows, no unavailable-harness process or configuration, and only valid launch next-steps. In the dual case, accept Claude's normal pending trust state, call a read-only AIT tool through `ait claude`, and launch two `ait codex` sessions with distinct AIT identities. Stop, inspect nonzero/unreachable status, start, and inspect healthy status again. In isolated fixtures, remove each required prerequisite one at a time and together, and remove both harnesses, to prove the complete remedy list appears before any write.

## Sequencing or rollout

Implement and validate in an isolated worktree. Freeze one clean revision and have one read-only reviewer replay the curl-shaped bootstrap through a local HTTP endpoint, project-root discovery, safe rerun, complete help, pending Claude approval, and both launcher commands from that revision. Merge the approved revision to `main`, rebuild from merged source, rerun the fixture suite, then paste the exact public raw-GitHub command from a clean terminal and repeat the production smoke. The public curl path cannot be declared shipped until the merged `main` script itself has been fetched and exercised.

The README promotes the CLI flow and keeps current manual steps immediately below it for diagnosis. No existing installation or project is migrated automatically. The old `ait-push` link and direct launcher paths remain functional but are no longer canonical.

Rollback is the prior commit plus `ait stop`. Do not delete databases, environment files, dependencies, or project configuration automatically. If the reviewed command link remains after code rollback, it points at the restored checkout; if the root `ait` target no longer exists, report the explicit link-removal command rather than deleting it as part of rollback.

## What was rejected

- **Put the CLI under `bin/`:** rejected because `ait` is the product entry point and must be obvious in a fresh checkout. Private implementation scripts stay under `bin/`; the public bootstrap lives at the root.
- **Require a checkout before installation:** rejected because it makes the user solve acquisition and path management before the promised installer exists. The public curl command owns the managed checkout.
- **Automatically run third-party prerequisite installers:** rejected because Homebrew, Node, Claude Code, and Codex have separate publishers, trust boundaries, and authentication. AIT reports every missing prerequisite at once with its official one-line remedy, then lets the developer decide what to execute.
- **Add local/global machine modes:** rejected because the AIT network is one shared machine service. Project enablement is a different operation with its own command and verdict.
- **Name project setup `ait project install`:** rejected because the machine is already installed and the user is standing inside the project. The idiomatic first-project action is the shorter `ait init`; an explicit path still handles another project.
- **Require a path for every `ait init`:** rejected because changing directory already expresses the target. The no-path command resolves a safe project boundary; a positional path remains available for another project.
- **Always use the literal current directory:** rejected because running from `src/` should configure the project root. Git's worktree root is authoritative; the bounded marker fallback handles non-Git projects without wandering into home.
- **Silently treat an unrecognized or empty directory as a project:** rejected because creating harness config there is surprising. The error gives an explicit path override.
- **Expose harness-specific project-install flags:** rejected because enablement intent is project-level. Harness names belong on launch commands, where the user is genuinely choosing an agent.
- **Require both Claude and Codex:** rejected because either harness reaches the AIT network independently. Requiring a second vendor's CLI and, on Claude-only machines, a permanent unused Codex app-server is an active negative; one direct availability conditional delivers more value without a mode framework.
- **Build an adapter registry or generalized framework for two harnesses:** rejected because direct Claude and Codex branches are smaller and easier to verify. Agent-neutral UX does not require framework machinery.
- **Prove `claude mcp add` through a read-only capability probe:** rejected because the installed command exposes no dry-run. Inspect conflicts first, let the native add apply, and verify exact state afterward.
- **Require Claude to report `Connected` immediately:** rejected because an untrusted project validly reports `Pending approval`; configuration is complete even though the user trust gate has not fired.
- **Hand-edit `.mcp.json`:** rejected because Claude's native command preserves unrelated entries and owns its canonical file shape.
- **Write one universal MCP config or a Codex project entry:** rejected because transport is standard but discovery, trust, and AIT's Codex identity path are not.
- **Duplicate launcher behavior inside `ait`:** rejected because resume identity and notification delivery already live in tested harness-specific launchers. The CLI is a thin `exec` boundary.
- **Keep separate global links for `ait-push` and Codex:** rejected because one `ait` command can expose both without asking users to remember checkout paths or unrelated executable names.
- **Auto-start the stack during harness launch:** rejected because a foreground agent command should not silently create background services. `ait start` is short and explicit.
- **Package the first slice with Homebrew or npm:** rejected because those systems install versioned artifacts, while AIT currently runs and updates from a checkout. The safe checkout link solves today's path problem without inventing release lifecycle.
- **Print every npm, database, and service substep during a normal install:** rejected because internal activity is not the user's decision surface. Four stable phases provide orientation; detailed commands and logs appear only under the failed phase.
- **Add `--dry-run`, JSON output, shell completions, or an updater now:** rejected because no current consumer needs them to install a project, verify state, or launch a harness.

## Sources

- `README.md:13-130`, inspected 2026-09-01: current machine and project setup sequence.
- `README.md:142-177`, inspected 2026-09-01: manual Claude launcher link and resume commands.
- `README.md:247-251` and `README.md:324-342`, inspected 2026-09-01: current harness-specific notification and Codex launcher path.
- `bin/start-all.sh:16-105`, `bin/stop-all.sh:7-50`, and `bin/lib-service-pids.sh:1-42`, inspected 2026-09-01: process ownership, adoption, readiness, health, and stop behavior the CLI preserves.
- `bin/claude-session.sh:11-25,73-149`, inspected 2026-09-01: cwd selection, argument forwarding, and resume identity behavior.
- `bin/codex-session.sh:17-28,51-125`, inspected 2026-09-01: cwd selection, build/app-server prerequisites, argument forwarding, and TUI attachment.
- `mcp/src/codex/host.ts:223-241`, inspected 2026-09-01: per-thread AIT MCP identity configuration.
- Operator correction recorded on 2026-09-02 (`at://did:plc:eunzexjghq6b4zx2y2oj7f57/ait.feed.post/3muj2ra22ds27` and wording clarification `at://did:plc:eunzexjghq6b4zx2y2oj7f57/ait.feed.post/3muj2roeo4s27`): Claude and Codex are independently optional; an unavailable harness is a visible plain skipped row, not a hidden condition or failure, and a Claude-only install must not run an unused Codex app-server.
- Installed Claude CLI probe on 2026-09-01: `claude mcp add --help` has no dry-run; `claude mcp get ait-protocol` exits zero with `Pending approval` before project trust and `Connected` after approval.
- Throwaway-project probe on 2026-09-01: `claude mcp add --scope project` preserved an unrelated entry, wrote the canonical AIT entry, and refused a duplicate name unchanged.
- [npm CLI directories](https://docs.npmjs.com/cli-commands/npm/), inspected 2026-09-01: local operations default to the current project while broader global scope is explicit; AIT uses that locality convention within the project command rather than inventing an install mode for its shared stack.
- [Git `rev-parse` documentation](https://git-scm.com/docs/git-rev-parse.html), inspected 2026-09-01: `--show-toplevel` returns the absolute worktree root and fails outside a worktree.
- [Model Context Protocol stdio transport](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports), inspected 2026-09-01: clients launch local stdio servers; the protocol defines no universal client configuration file.
- [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp), inspected 2026-09-01: project scope writes `.mcp.json` and retains a user approval gate.
- [Official OpenAI Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), inspected 2026-09-01: Codex supports its own global and trusted-project configuration, distinct from AIT's dynamic app-server path.
- [Docker MCP Toolkit client verification](https://docs.docker.com/ai/mcp-catalog-and-toolkit/get-started/), inspected 2026-09-01: one tool presents client-specific verification for Claude, Codex, and other MCP clients instead of treating a shared config write as universal readiness.
- [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook), inspected 2026-09-01: Homebrew formulae install versioned kegs and link declared executables into the prefix; AIT has no versioned CLI artifact yet, so a formula is premature.
- [Homebrew installation](https://brew.sh/), [Node formula](https://formulae.brew.sh/formula/node), and [Git formula](https://formulae.brew.sh/formula/git), inspected 2026-09-01: the exact prerequisite recovery commands printed by AIT.
- [Claude Code installation](https://code.claude.com/docs/en/getting-started), inspected 2026-09-01: the recommended macOS/Linux native curl installer, installation verification, and read-only `claude doctor` recovery pattern.
- [Official OpenAI Codex CLI](https://learn.chatgpt.com/docs/codex/cli), inspected 2026-09-01: the standalone macOS/Linux curl installer, immediate `codex` next step, and CLI-first help surface.
- [OpenCode installation](https://opencode.ai/docs/), [Goose quickstart](https://block-goose.mintlify.app/), and [uv installation](https://docs.astral.sh/uv/getting-started/installation/), inspected 2026-09-01: current developer tools lead with a standalone curl command, install one command on `PATH`, and hand off subsequent work to that CLI.
- [npm clean install documentation](https://docs.npmjs.com/cli/commands/npm-ci/), inspected 2026-09-01: `npm ci` consumes locks without rewriting them and removes existing dependency trees, which is why a healthy live install is verified rather than refreshed.
