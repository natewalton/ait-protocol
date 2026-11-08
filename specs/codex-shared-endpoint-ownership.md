# Start and stop Codex without disrupting other sessions

Status: Approved design after synchronous shared-floor-check amendment; isolated implementation only. No live-operation approval.
Date: 2026-11-08
Tracker: https://github.com/natewalton/ait-protocol/issues/23
Baseline: source5703d80 / installed3d17fb5, AIT0.1.43; real Codex0.166.0 and0.167.0.

## Why

AIT can miss a running Codex server and accumulate startup wrappers. Current Codex publishes the requested socket as a symlink to its protected physical socket. `lib-service-pids.sh:14-15` queries the alias with lsof and gets no PID. `run-codex-appserver.sh:91-100` then waits without releasing AIT's startup lock. The independent shell fixture reproduced a waiting wrapper deleting the alias after the holder was killed, leaving the original server alive but unreachable for new sessions. Explicit stop eventually stayed stopped in 11/11 queued-wrapper trials, but killed 4-6 successive servers each time. Observed live wrappers corroborate this mechanism, not a production failure rate. Verdict: fix.

Resolving the physical socket alone fixes the reproduced discovery/adoption failure. Removing AIT's redundant lock, unlink and bind-poll machinery is the chosen simplification, not a prerequisite for that one-line correction. Both actual 0.166 and0.167 binaries provide the native bind/publication lock and refuse a competing start without changing the original owner or target.

The user should launch/resume/exit one terminal without disconnecting another, and start/stop the intended service without manual PID/socket cleanup. This is useful independently of the separate notification-recovery spec.

The release workflow currently runs CLI/uninstall/update fixtures and builds, but not the launcher suite or a real Codex endpoint contract (`.github/workflows/release.yml:51-66`). A passing one-off native journey would leave the same validation gap in future releases. Require these checks in prepare validation before publication; retain the existing release identity/security gates.

## The proposed work

- Treat the advertised and physical socket paths as one endpoint. Discover the physical owner, then reuse one exact server-command, intended-endpoint and checkout-specific MCP-entrypoint predicate. Use it in the installer too, replacing its weaker independent substring check. PID files remain caches. Preserve foreign owners and newly discovered replacements; recheck before signaling or escalation.
- Reuse native Codex bind exclusivity, stale-endpoint recovery and orderly endpoint cleanup. Delete AIT's duplicate startup lock, lock-wait/bind-poll loops and unconditional socket deletion. A competing start which loses rechecks/adopts the verified winner; it does not replace it. Do not add a registry, daemon manager or another retry loop.
- Adoption comes before checking the installed CLI's version: an existing verified responsive owner stays untouched. Before a genuinely new shared-server launch, require the selected binary to be Codex0.166.0 or newer. This is the supported floor chosen for the simplified implementation, not a claim about the earliest upstream lock release. An installed CLI version is not evidence of an already-running server's binary version.
- On an unsupported new launch, stderr reads exactly: `Codex 0.166.0 or newer is required to start AIT's shared server (found <version>). Update Codex, then run ait start.` Use `unknown` when parsing fails. Define the floor refusal once in the shared lib. Session launch and start-all call it synchronously after adoption fails and before backgrounding, so it reaches the human terminal; the wrapper also calls it for direct/launchd invocation. An unparseable version refuses as `unknown`. The launcher and `ait codex`/resume startup return1 before spawning/replacing anything; `ait start` reports the failed Codex start and returns nonzero. No Codex requirement is added to Claude-only use. README states the new-launch requirement and the existing-owner distinction.
- A wrapper forwards TERM/INT/HUP only to its own unreaped child or still-verified descendants. A losing/adopting wrapper cannot signal the winner. Explicit operator stop has separate authority to stop verified owned endpoint processes. Keep the wrapper's launchd lifetime correct by waiting/reaping its child. Do not infer abandoned sessions from age or PPID alone.
- Detach a newly backgrounded Codex wrapper into its own OS session before exec, reusing `/usr/bin/perl` and `POSIX::setsid`. Codex reinstalls HUP/INT handlers, so nohup alone leaves the shared server exposed to the first terminal's process group. Verify terminal-group HUP/INT and terminal close preserve the shared owner and sibling. No new supervisor.
- Preserve shared diagnostics; another launch/adoption must not truncate the server log or error log (`codex-session.sh:85-86`). Preserve terminal cleanup and per-session driver teardown. Run cleanup once from EXIT; retain default signal dispositions so an interrupted resume cannot continue into the large-history retry path.
- Migration uses the existing supported shutdown before replacing code, with harness sessions closed. Retire old queued wrappers through that path; do not require manual PID lists. The old stop path drains its queued starts before code replacement; the new start/stop path must then remain stopped. No hot-swap-under-old-wrappers repair is promised. Do not remove cached-child escalation merely on theory: first prove native TERM/SIGKILL and MCP-stdio cleanup while siblings survive.
- Keep status read-only and its updater-compatible row vocabulary unchanged. A stale socket with no physical holder reports unreachable, including after SIGKILL; only an occupied endpoint can be protocol-unhealthy. Reuse service_pids, and leave stale-path recovery to the next native start. It reports protocol health, not signal authority or five-minute actor presence. Ownership conflicts remain the existing explicit error in callers which adopt/signal processes, not a new `conflict` state. If the explanatory version note changes, name it as the installed CLI version; never claim that it identifies the running server. No health-triggered restart.

## Files touched

Fourteen paths, including this spec and the three-file RCA prevention amendment; runtime scope is unchanged:
1. `bin/lib-service-pids.sh`: common endpoint/ownership predicate and shutdown verification.
2. `bin/run-codex-appserver.sh`: native startup reuse, version refusal, child-only authority.
3. `bin/stop-codex-appserver.sh`: verified explicit stop and native socket cleanup.
4. `bin/codex-session.sh`: adoption, logs and per-session teardown.
5. `bin/start-all.sh`: startup/adoption outcomes and existing protocol probe.
6. `bin/install.sh`: reuse the same ownership predicate, not a second substring rule.
7. `bin/status.sh`: reuse physical-holder discovery for stale-endpoint absence and clarify CLI-version wording; no new states or repair.
8. `README.md`: supported launch floor and ordinary user recovery.
9. `bin/ait-test.sh`: isolated CLI, installer, status/update and sibling boundaries.
10. `bin/run-codex-appserver-test.sh`: aliases, competing starts and signal authority.
11. `specs/codex-shared-endpoint-ownership.md`.
12. `.github/workflows/release.yml`: require launcher, driver and pinned real-binary checks after the MCP build.
13. `mcp/scripts/codex-rollout-resume-test.mjs`: reuse the existing real-binary harness for a bounded endpoint-only contract.
14. `bin/codex-native-contract-test.sh`: fetch official version/checksum-pinned binaries and run that contract.

## Out of scope

- Notification sink/driver retries are a separate standalone spec in this issue.
- No new daemon/HOME split, package/updater manager, supervisor, process registry, heartbeat or historical artifact migration.
- No launchd KeepAlive/adoption/stop policy change. It is pre-existing, no AIT job is loaded on the inspected live host, and loading a test job would use the real GUI domain. Track it separately in [#38](https://github.com/natewalton/ait-protocol/issues/38). `ait stop` alone does not unload launchd jobs; configured installations use the existing uninstall-services workflow when an operator intends to unload jobs. Do not claim that auto-restart semantics are repaired here.
- No live restarts, source/installed builds, broad process kills, rollout/transcript/map/identity deletion or unrelated P2P changes during development.

## Tests

Run `bash bin/run-codex-appserver-test.sh` and `bash bin/ait-test.sh` using owned temporary HOME/CODEX_HOME, sockets, logs, PID stores and command shims; no installed services or real launchctl jobs.

The literal journey is AIT launch/resume of two fixture sessions on one real0.166/0.167 server: corrupt/remove the PID cache, launch again, retain the same verified owner and working sibling, leave no queued launcher/held AIT startup lock, close one terminal, verify the other and server respond, then explicit stop/start and resume the same saved session. Retain canonical artifacts byte-for-byte at quiescent boundaries.

Cover physical and advertised paths, missing/dangling/stale aliases, live foreign sockets/checkouts, concurrent starts, a losing wrapper receiving TERM, wrapper death before/after native bind, and start-stop-start. Reverting physical-owner discovery fails adoption. Restoring winner-wide signal forwarding fails sibling preservation. Exercise unsupported and unparseable versions through public `ait codex` and `ait start`, not only the redirected wrapper: exact refusal reaches terminal stderr/nonzero with no driver/background launcher started; a healthy existing owner is adopted even if a different/older CLI is on PATH; Claude-only still works. Assert prior shared logs remain present. Status/update fixture assertions retain the existing parsing contract.

Migration starts with the actual old wrapper state in an owned fixture. The supported shutdown drains it without manual cleanup and preserves foreign processes. Test native parent TERM/SIGKILL before deleting raw descendant escalation; no invented PID-retention scenario substitutes for a real owned child. Do not infer a production memory curve or real launchd behavior from these cases.

Prepare validation must run the existing launcher/sink/recovery suites after the MCP build, plus the real endpoint contract on pinned official Codex 0.166 and 0.167 downloads verified by SHA-256. The contract exercises the candidate's ownership consumer, duplicate refusal without replacing the owner, SIGKILL stale recovery and TERM cleanup. It must fail when physical-owner discovery is reverted. Use isolated homes/sockets and recorded fixture PIDs, no authentication or model turn. These are additions to the existing validation job, not another release stage or native daemon manager.

## Sequencing or rollout

Developer owns the shell implementation; Skills-dev independently reviews it. General-dev maintains the shared tracker/specs and the separate driver lane. Review this spec, implement isolated, run the integrated journey, then obtain green independent code/systems review. It has no delivery dependency on the driver fix. Release and installed update remain separately coordinated; active sessions close before an authorized upgrade. No publication by itself restarts or updates the installed development copy.

Before the first old-updater crossing, README and release notes require Codex users to check `codex --version` and upgrade to 0.166+ before `ait update`. Target updater code cannot preflight an already-running old updater: `bin/update.sh:149-155` stops the old stack, replaces code, then starts the target. If that start fails specifically on the Codex prerequisite, the remedy is upgrade Codex then `ait start`, not necessarily a higher AIT patch. Do not generalize this remedy to unrelated rebuild or persisted-data failures. Claude-only use has no Codex prerequisite; no shadow updater or new metadata framework is added.

## What was rejected

- Leaving native checks as one-off artifacts: future prepare runs could again pass without exercising the real ownership consumer. Add the bounded check to the existing job; another release stage would duplicate that job's decision.
- Treating the realpath-only correction as insufficient: it fixes the measured hot path. The broader deletions are selected because native Codex already supplies those functions and deletion removes extra wrapper authority/churn.
- Keeping two startup implementations for old Codex: retain fewer mechanisms with an explicit tested new-launch floor.
- Switching to Codex's daemon subcommand: it lacks the same endpoint option and expands HOME/settings/updater scope.
- A new status enum or launchd policy patch: unnecessary coupling to update parsing or untested live job semantics.
- PID existence, process-name-wide cleanup, shared endpoint alone, or cached-child PIDs as signal authority: cannot preserve foreign owners and active siblings.

## Sources

Read at the stated baseline: `bin/lib-service-pids.sh:13-22,109-128`; `bin/run-codex-appserver.sh:27-50,75-100`; `bin/stop-codex-appserver.sh:11-33`; `bin/codex-session.sh:80-87,126-143`; `bin/install.sh:122-133`; `bin/status.sh:63-79`; `bin/update.sh:71-79`.

Official source [0.166 endpoint](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-transport/src/transport/unix_socket.rs) and [0.167 endpoint](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-transport/src/transport/unix_socket.rs): inspected files byte-identical; native kernel lock spans physical bind and alias publication. Actual competing-start proofs: `/private/tmp/ait-codex-166-167-review/native-socket-166.{py,json}` and `/private/tmp/ait-shared-server-systems-review/native-socket-proof.{py,json}`. Independent shell review: `/private/tmp/ait-shell-lifecycle-review.md`. Native two-thread proofs for both versions: `/private/tmp/ait-codex-166-167-review/native-session-release.mjs`, `native-release-{166,167}.log`; sibling survives, final subscribers unload, both synthetic MCP children exit, both rollout hashes unchanged, no inference. Identity/map and wrapper-signal coverage remains acceptance work, not a claimed pass from those native proofs.
