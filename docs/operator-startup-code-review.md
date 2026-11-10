# Independent implementation review

Verdict: GO for the operator/startup repair against private-peer baseline `98a7de6`, with no remaining blocking implementation defect found. This verdict permits release preparation within the already authorized scope; it does not approve public promotion of the experimental peer branch, installation, a restart, live configuration writes, or a claim of installed recovery.

Reviewed 2026-11-09 in `/private/tmp/ait-operator-startup-20261109`. I did not author the implementation and made no source changes. I read project instructions, developing-alongside-installed guidance, delivery-coordination, general-systems, spec-design, the full proposal, production diffs and the complete identity/server/feed/client modules plus the relevant network, maintenance, CLI, and client caller paths. Tests below use temporary databases/state and loopback endpoints; no installed services, auth, messages, or configuration were changed.

## Authorization and durable configuration

`operatorIdentity.mjs:11` binds the configured reference against only the read-only existing local PDS actor store, including DID validation, exact full-handle matching, and uniqueness for compatibility shorthand. Missing/invalid/nonlocal/ambiguous stores or settings disable third-party authority with diagnostics. Neither peer approval nor projection ordering selects the operator. `server.ts:89-112` captures this immutable DID before peer startup and retains the local resolver for JWT verification. The existing JWT verifier still binds signature, audience, and method and propagates force-refresh to that resolver. The retirement handler compares authenticated viewer DID to the bound operator DID; self-retirement stays available.

I checked the corrected authority boundary against the actual PDS launcher, `bin/run-pds.sh`, and upstream `readEnv/envToCfg`: `installationPaths` now captures the effective inherited plus sourced shell environment, from PDS cwd, instead of interpreting shell assignments as dotenv literals. Its use of positional arguments and internal JSON does not interpolate actor input or expose credentials in error messages. The sourced file is existing trusted executable local configuration; arbitrary malicious commands in that file would already execute in the PDS wrapper. The focused test exercises a different stale store versus inherited actual store, file precedence, HOME expansion and sanitized errors. The returned account path is also reused for peer hosted-account checks.

`applyOperatorPreparation` uses an original-content plan, checks ownership/regular file, preserves unrelated parsed dotenv settings, creates a private fsynced rollback copy, writes a private synced temporary file, rechecks original inode/content immediately before atomic rename, then syncs the directory. It runs at `peerPrepare.mjs:108` before machine/account namespace mutations. The canonical DID therefore survives a later rename failure and a retry from disk; preparation detection recognizes convertible legacy config even when namespace prep is current. Existing stopped-service exclusion remains the required execution boundary. The rollback warning in the proposal is appropriate: after renames, restoring an obsolete exact handle alone cannot restore authority.

## Targeting and retained data

`handles.ts` resolves all submitted names through the existing authoritative AppView endpoint; explicit DIDs are validated offline. The underlying projection resolver includes retained and retired actors rather than applying directory visibility. Watch startup resolves the entire requested set before follow writes (`aitty/main.ts:265`); only definitive missing results are collected, while ambiguity/outage aborts. Picker selection inserts its DID in argument or braced-mention syntax using actual command context, so capped/filtered suggestions cannot rewrite the identity. Unfollow retains the stored DID and record URI for explicit offline undo and makes shorthand pass authoritative resolution first.

`server.ts:151` provides one public named-reference gate, used by identity, record, author feed, profile and retirement boundaries. Starting/failed projection returns 503 ProjectionUnavailable rather than incomplete uniqueness or absence. Explicit DID/URI reads continue to reach retained history. The operator principal never changes when the projection is empty, rebuilt, or gains a namesake.

## Lifecycle, optional peers, and CLI

`createVerifiedFeed` owns starting/running/failed/stopped and the terminal reason. Running requires the stream to open and initial verified backfill to complete. A quiet ready stream remains running; unexpected completion fails. Shutdown aborts pending repository HTTP reads and subscription cleanup; terminal failures do not acquire a competing retry supervisor.

Peer transport status and feed status remain separate through the actual status/link renderer. `peerNetwork.mjs:277` registers optional attachment state before listener/client acquisition, retains a failed attachment diagnostic and approval, and closes acquired resources. Local ownership/socket conflicts remain fatal. I inspected native connect continuation handling: link cancellation checks the aborted attempt after native connect returns before pairing, closes acquired connections, and stops watchers; data attachment cancellation is checked by the disconnected signal before bridging. Overall startup cleanup closes sources, sockets, endpoint, tracked work, and listeners. The actual-main failed-listen and SIGTERM tests passed.

Managed startup uses one health interpreter that retains HTTP 503 bodies, distinguishes starting/degraded/unreachable, and waits for indexing for both newly launched and adopted AppViews. It independently rechecks listener ownership before readiness. Process exit and mandatory-dependency failure terminate the readiness wait; adopted services are preserved. Preflight rejects unsupported effective PLC/PDS/AppView ports before service launches, following wrapper sourcing for PLC/PDS and inherited-wins dotenv for AppView. Direct fixture ports remain supported.

## Validation provenance

Executed independently in this review after inspecting fixture isolation:

- `node --import tsx scripts/operator-identity-test.mjs`: 9 passed.
- `node --import tsx scripts/peer-lifecycle-test.mjs`: 6 passed.
- `node scripts/startup-readiness-test.mjs`: 5 passed, actual compiled main with temporary state and loopback PDS/PLC.
- `node --import tsx scripts/peer-feed-test.mjs`: 17 passed.
- `node scripts/handles-test.mjs`: passed.
- `node --import tsx scripts/peer-mentions-test.mjs`: passed.

A first plain-node invocation of peer-mentions failed TypeScript .js import resolution; rerunning with its documented `--import tsx` invocation passed. This was a test invocation correction, not an implementation failure.

Inspected the parent's final logs and real two-PDS fixture source, but did not independently rerun that longer integration: `/private/tmp/ait-operator-final-peer-link.log` records 11 passing outcomes, including same-name watchers, public retirement/search/history, self-only authorization, namespace retry, retained Unlink history and replay. Parent-reported full CLI/build/projection results are additional evidence, distinct from this review's own test executions. No installed-surface test was performed.

## Release boundary and documentation

`git diff --stat main...98a7de6` shows the preexisting baseline itself differs from stable main across 70 files, with roughly 10,000 added lines, including peer transport, installation/maintenance paths, schema and experimental native dependency. `appview/package.json` already pins `iroh-direct-v0.1.0-experimental.1` before this repair. This focused repair review does not establish platform support or authorize promoting that broader branch as the next public stable release. Existing public main release gates still apply.

The proposal's status and test prose still describe an unimplemented proposal and a 25-file estimate. The current worktree has 23 tracked modifications plus 7 untracked additions, including proposal/audit material. Update the delivery record to accurately distinguish implemented/tested work, release preparation, and deployment. This is documentation reconciliation, not a residual code/auth/persistence blocker.

GO for the reviewed repair. Live recovery remains unverified until a separately authorized deployment repeats the installed XRPC journey and verifies checkout/process ownership.

## Launcher fixture isolation correction

GO persists after inspecting the narrow `bin/run-codex-appserver-test.sh` change. The copied managed startup now probes HTTP readiness, while this preexisting test intentionally creates only ephemeral raw TCP listeners and maps their ownership through its lsof shim. The added executable curl shim is installed in the already prepended temporary shim directory before the copied `start-all.sh` is invoked. It returns the explicit HTTP 200 plus running-index JSON protocol for the health parser and successful fixture output for other dependency probes. Thus this launcher ownership test does not send new readiness probes to installed fixed-port services. Actual readiness behavior remains exercised separately by the dedicated CLI and real-main tests; the shim does not substitute for those tests. Production code is unchanged by this correction.

I inspected the current final launcher log after the correction: it progresses through foreign ownership/decoy safety, signal/TERM cleanup, stale endpoint handling, own prebind stop and the final npm-shim adoption/child-reaping assertion. I did not rerun the launcher suite myself, and process exit success remains for the parent to confirm. The explicit-stock-package policy control is also a parent-run final release check, not a result established by this reviewer. Proposal implementation status/count reconciliation is reported by the parent; it does not alter the code verdict above.
