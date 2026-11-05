# Start and stop the intended AIT services reliably

Status: Implemented for v0.1.42; independent code/systems review and isolated lifecycle tests passed.
Date: 2026-11-05

## Why

The operator reports stale service PIDs during stop and other Codex terminals
disconnecting when one session resumes. The latter incident is on another
machine; its initiating event is not confirmed from logs. Fix the reproduced
local mechanism rather than claiming the incident is fully diagnosed.

`bin/start-all.sh:141-144` and `bin/stop-all.sh:18-19` accept a live PID from a
file without verifying its service. `bin/codex-session.sh` at committed HEAD
uses only that file to decide whether to launch. `bin/run-codex-appserver.sh:28`
stops the existing server before binding. Missing bookkeeping can therefore
disconnect unrelated sessions; a reused PID can identify an unrelated process.
`bin/stop-all.sh:5` and `bin/stop-codex-appserver.sh:23` hard-code `/tmp`,
while start and session launch honor `AIT_LOG_DIR`, creating another source of
disagreement.

Verdict: fix. Starting/resuming a session must preserve other sessions, and stop
must target the actual AIT services regardless of stale bookkeeping.

## The proposed work

- Keep the existing operator workflow. Ordinary start, stop and resume recover
  stale PID caches and abandoned startup locks automatically in the same command.
  Require no new flags, manual file deletion, PID selection, cleanup commands or
  user retries for these recoverable conditions. Preserve healthy sibling sessions.
  Ask the operator to act only for a genuine ownership conflict or startup failure
  that AIT cannot safely resolve; identify the affected service and explain the
  specific problem in plain language. Internal bookkeeping repair is routine,
  not a warning the operator must investigate.
- Root safeguard: `run-codex-appserver.sh` must report an already-running owner
  and exit 0 without stopping it or unlinking its socket. A foreign checkout's
  owner is a conflict and must also remain untouched. This protects every caller;
  session-launch adoption is bookkeeping cleanup, not the sole safeguard.
- Reuse one ownership discovery helper across lifecycle entry points. For HTTP
  services, discover the expected listening port and verify the owning process
  belongs to the intended checkout/service. For Codex, discover the shared socket
  owner; before bind, use the existing exact-socket command-line discovery.
  Inspect all socket candidates rather than trusting the first lsof result:
  children can inherit descriptors. Verify the server command and exact socket,
  and that its `mcp_servers.ait.args` names this checkout's `mcp/dist/server.js`.
  The per-HOME socket alone never authorizes Desktop development code to adopt
  or terminate the installed server.
  A process merely sharing the checkout directory is insufficient evidence to
  stop it. Check the relevant executable/entry point as well. Do not introduce
  a new daemon, registry or periodic reconciliation loop.
- PID files are caches only. Start adopts a verified existing process and
  refreshes its cache. A stale or absent cache cannot authorize another launch
  or a signal. Stop discovers and verifies the process before TERM, and verifies
  identity again before escalation. Clear obsolete caches after absence/exit.
  Use the same AIT_LOG_DIR/default directory in writers and removers.
- Starting the Codex server must never stop an existing server or unlink a live
  socket. If another server already owns it, report that fact and leave it alone.
  Preserve explicit stop as the operation that shuts down the shared server and
  its owned children. Retain stale-socket recovery only after absence of the
  matching server is established. Serialize check/unlink/start and final stop
  cleanup using one per-socket kernel advisory lock, shared across checkouts.
  The lock file persists; kernel ownership ends when its holding process exits.
  Remove mkdir locks and PID-based lock-recovery heuristics. Use macOS lockf's
  inherited-fd mode so the shell holds the lock without another resident process.
  Adopt a verified live server before waiting; recheck after acquiring the lock.
  Start Codex with the lock fd closed, release the shell's lock after verified
  bind, and wait for Codex so launchd job lifetime remains correct. Forward TERM,
  INT and HUP to the child and reap it. Waiting for startup must be visible.
  Stop terminates verified owned pre-bind/server processes before acquiring the
  same lock for final recheck/unlink, so hung startup cannot deadlock explicit
  stop. A newly discovered owner is preserved.
  Bind exclusivity alone is insufficient: a competing launcher could unlink the
  winner's newly bound socket. Report a losing startup accurately and adopt the
  resulting owner where the caller waits for readiness. Add no background daemon
  or persistent service registry.
- A foreign process holding an expected resource produces a clear conflict,
  not "not running" followed by a duplicate start or a successful stop claim.
- Keep status read-only and preserve its health meanings and updater-compatible
  output. Ownership answers which process; health probes answer whether it works.
  Do not repair PID files from status or add health-triggered restarts.
- Messages distinguish "adopted existing service", "stopped service", and
  "resource owned by another process". Remove the misleading "has no pidfile"
  message when a file actually exists but is stale.

## Files touched

Eight implementation/test paths plus this spec (nine total):

1. `bin/lib-service-pids.sh`: shared discovery and ownership verification.
2. `bin/start-all.sh`: authoritative discovery/adoption and startup results.
3. `bin/stop-all.sh`: verified stop and cache cleanup.
4. `bin/codex-session.sh`: preserve shared server during session launch/resume.
5. `bin/run-codex-appserver.sh`: remove implicit server replacement.
6. `bin/stop-codex-appserver.sh`: verified targets and consistent cache directory.
7. `bin/ait-test.sh`: isolated lifecycle regressions.
8. `bin/run-codex-appserver-test.sh`: isolated launcher coverage.

`bin/status.sh` is inspected for compatibility; no change is planned.

## Out of scope

Terminal escape/mouse cleanup is an existing separate local patch and is not
part of this specification. Preserve it while editing the overlapping files.
No model, notification, identity, transcript, database, installation or public
CLI flag changes. No migration to a new supervisor. No live service operations
or restart of the operator's sessions during development/tests.

## Tests

Run `bash bin/ait-test.sh` and `bash bin/run-codex-appserver-test.sh` with
fixture-local launchers, sockets, PID directories and discovery shims.

The supported journey is: launch a fixture service, corrupt/remove its PID cache,
start/resume again, verify the same server and sibling session remain alive,
then stop and verify only the intended service and owned children exit.

Cover absent cache, dead saved PID, saved PID naming a live unrelated process,
and correct cache; exercise real fixture port/socket ownership. A foreign owner
must survive both start and stop attempts. Verify custom AIT_LOG_DIR cleanup,
stale socket recovery, repeated stop, and two competing Codex launches retaining
one owner without calling the stop helper. Preserve updater status parsing and
existing startup-health failures. Check both normal TERM and escalation targets.
For each recoverable-cache/lock case, assert that the original command completes
without operator input or a second invocation, and that output requests no manual
cleanup. Exercise start, stop, start to prove startup locks release or recover
through the normal lifecycle. A real conflict must produce a concise diagnosis
and leave the foreign process untouched.
Revert the ownership-first decision in an isolated copy and show the stale/live
decoy assertion fails. Tests must never inspect or signal the installed stack.
Exercise wrapper TERM/INT/HUP, wrapper death before bind, cross-checkout startup
races, and start racing final stop cleanup. Each case preserves foreign
processes and completes through normal commands after an interrupted startup.
Use controlled fixture events to arrange the interleavings.

## Sequencing or rollout

Obtain @ait-skills-dev.test review of this spec, implement in the source checkout,
run focused isolated tests, then request independent code/systems review because
the change selects processes to terminate. Release only after green review.
Publication does not update the installed checkout or restart sessions. Verify
deployed behavior later through an operator-approved update; report that boundary
honestly rather than restarting the live stack to obtain evidence.
After each correction round, rerun affected edge-case tests and review the full
implementation with general-systems. Consolidate superseded branches, mechanisms
and comments before the next review. Release requires behavior tests and
independent code/systems review to pass on the integrated candidate.

## What was rejected

- More PID metadata or a background repair loop: another state system to drift.
- PID existence alone: establishes liveness, not service identity.
- Removing all PID files immediately: unnecessary compatibility churn; caches
  may remain as long as they authorize nothing.
- Automatic restart on unhealthy probes: destroys unrelated sessions and expands
  this fix into recovery policy.

## Sources

`bin/lib-service-pids.sh:15-50`; `bin/start-all.sh:139-187`;
`bin/stop-all.sh:15-49`; `bin/run-codex-appserver.sh:21-28`;
`bin/stop-codex-appserver.sh:23-81`; committed `bin/codex-session.sh:77-85`.
The local missing-cache adoption regression in `bin/ait-test.sh` passes after
the targeted session-launch patch; the broader lifecycle work is not implemented.
