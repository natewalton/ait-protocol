# Systems implementation review

Verdict: GO for systems architecture after the effective-account-authority correction. This is an implementation review, not authorization to install, switch the live checkout, restart services, or change authentication/configuration.

Reviewed 2026-11-09 in `/private/tmp/ait-operator-startup-20261109` against `98a7de6`. Read delivery-coordination, general-systems, spec-design, project AGENTS, developing-alongside-installed-AIT, full proposal, and production files described below. No source or live state was changed. Temporary reproduction databases were deleted.

## Resolved finding

### Runtime operator binding previously read a different account authority from the actual PDS

`appview/src/server.ts:89` uses `installationPaths(repo).accountFile`. `appview/src/peerPrepare.mjs:15-22` computes that path from dotenv-parsed `pds/.env` alone. The actual supported PDS wrapper (`bin/run-pds.sh:5-8`) inherits its caller's environment, then sources `.env`; `pds/launcher.js:20-22` passes `readEnv()` into `envToCfg()`. An inherited `PDS_ACCOUNT_DB_LOCATION` survives when that key is absent from `.env`, while `installationPaths` ignores it. Shell expansion in sourced assignments is another instance of the same disagreement.

Two isolated source-level reproductions ran in this review:

1. With file `PDS_DATA_DIRECTORY=.pds` and inherited `PDS_ACCOUNT_DB_LOCATION=<fixture>/actual-account.sqlite`, actual `@atproto/pds` `envToCfg(readEnv()).db.accountDbLoc` selected `actual-account.sqlite`; `installationPaths` selected `<fixture>/pds/.pds/account.sqlite`.
2. With distinct temporary databases, default store `operator.test -> did:plc:aaaaaaaaaaaaaaaaaaaaaaaa` and actual inherited store `operator.test -> did:plc:bbbbbbbbbbbbbbbbbbbbbbbb`, `resolveLocalOperator(installationPaths(root).accountFile,'operator.test')` bound A and printed that it was bound to the local PDS account. The PDS effective configuration selected the B store.

If the unused default database is missing, startup disables the valid operator; if it remains from an earlier installation, startup canonizes a different principal than the hosted PDS account. Request JWT verification remains local-PLC-only, so this is not evidence that a remote token bypasses verification, but the local principal binding claim is false and stale local accounts can be selected.

Fix the common effective-account-store boundary rather than teaching authorization about another fallback. Runtime binding must use the same effective path as the PDS it authenticates against. Keep stopped-service preparation's intended installation-file isolation explicit; do not silently change its store while fixing runtime inheritance. Reuse the resulting authority path for hosted-account checks too. A deliberately narrower supported configuration is acceptable only if rejected before startup with public guidance, rather than silently binding a different store. Add one literal wrapper/environment fixture comparing PDS effective configuration and operator binding, covering inherited account override and sourced path expansion. This is a correctness issue, not merely missing coverage.

## Architecture assessment of the rest

The system binds one local operator DID, resolves submitted account references through the full verified projection, preserves picker choices as DIDs, and derives local/peer index readiness from the feed owner's lifecycle.

Systems trigger: the change spans authentication, projection consumers, persistence maintenance, client targeting, and shell lifecycle. The proposal's original 25-file estimate is already stale because implementation adds tests and uses an MJS helper; recount in final delivery documentation.

Five core concepts compose without a new registry: (1) local PDS principal (`operator.did`), (2) explicit DID versus shorthand/exact reference, (3) full indexed actor projection versus suggestion visibility, (4) feed-owned lifecycle (`starting/running/failed/stopped`, terminal `error`), and (5) service/resource ownership. Configuration plan/original/updated/backup are write preconditions and rollback data, not another identity model. Existing per-peer sources hold optional-attachment errors rather than adding persisted trust state.

Source-backed branch census (regex `if` tokens / `catch` tokens; not a claim that every branch is a domain exception): operatorIdentity 8/4; peerFeed 15/3; peerNetwork 46/18; server 29/10; handles 1/0; commands 9/1; start-all 23/1; lib-service-pids 10/2. These large raw counts include existing protocol dispatch, validation and cleanup. The meaningful new policy exceptions are localized: exact/legacy/DID operator forms in one binder; only native-policy-unavailable allows local fallback; saved attachment failures retain approval and diagnostics; explicit stored unfollow works offline. They do not require interacting caller flags. No retry supervisor or cache alias layer was introduced.

`resolvePublicActor` has five awaited public boundary callers: identity lookup, record lookup, author feed, profile, retirement. Each gates named references on the same feed state; explicit DID syntax is checked separately. Full resolver scans include retained/retired actors. The client uses the authoritative resolver instead of directory result counts. Watch pre-resolves the entire requested set before writes. Picker inserts DID argument or braced DID mention from actual command context. Offline unfollow retains a known stored DID/record URI. These reach real production callers and are not dormant helpers.

Operator persistence plans from original dotenv content, verifies unrelated parsed keys, creates a private synced rollback copy, compares original content/inode immediately before rename, fsyncs the directory, and commits the DID before machine/account renames. Later namespace failure therefore leaves the operator principal available to a disk-based retry. No second completion marker is needed.

Feed lifecycle is owned by createVerifiedFeed; callers expose its status, not duplicate booleans. Startup requires stream open plus verified backfill, unexpected normal completion becomes failed, shutdown aborts pending HTTP readers. HTTP readiness and managed CLI reuse one interpretation; HTTP 503 bodies survive curl. Newly launched and adopted AppViews both wait for running indexing; port ownership is independently rechecked. Mandatory-dependency checks and process exit terminate post-bind readiness waits. Peer transport and indexing remain separate, with actual CLI status/link renderers carrying both.

Optional saved peer attachments register runtime state before acquiring entry/client resources and isolate failures inside that boundary; command-socket conflicts and corrupt local identity remain fatal. Overall startup cleanup attempts owned resources. Existing reconnect behavior remains upstream. Main owns failed-listen cleanup and binds HTTP loopback.

## Limits and validation provenance

This review executed only the temporary effective-path/PDS-config and two-database reproductions plus source inspection/census. The parent reports real two-PDS acceptance and CLI suites passed; that evidence is independent of this review's executions and does not cover the confirmed environment mismatch. The lifecycle/readiness test scripts were read for isolation and assertions, including real-main temporary loopback fixtures, but were not rerun by this reviewer while the parent was reinstalling dependencies. No installed-surface claim is made.

## Narrow correction re-review

The corrected `installationPaths` now captures inherited PDS settings plus `.env` assignments using `/bin/bash`, PDS cwd, `set -euo pipefail`, `set -a`, and `source`, matching the actual service wrapper. It returns internal `PDS_*` JSON through the current Node executable, suppresses sourced stdout/stderr, and exposes only a sanitized load failure. AppView directory calculation follows inherited-wins dotenv semantics. `readInstallationEnv` then supplies the same captured PDS configuration to preparation. This removes the divergent authority interpretation rather than adding an authorization fallback, registry, retry, or second parser.

Trust scope: sourcing this file executes trusted local shell configuration. The existing PDS wrapper already executes precisely that configuration. The helper itself writes no configuration or account data, but arbitrary commands authored inside a shell `.env` can have their own effects; this is existing executable-configuration trust, not a claim that shell sourcing is intrinsically read-only. No network input or actor reference is interpolated into the shell program; directory and Node path are positional arguments. Under the documented trusted service configuration, this is a proportionate reuse of existing semantics. No concrete remaining blocker was found.

This reviewer reran the original two-database temporary reproduction after correction: with stale default DID A and actual inherited store DID B, `actualStoreSelected` was true and bound DID was B. This reviewer also executed `node --import tsx scripts/operator-identity-test.mjs` from appview: 9 passed, 0 failed. That regression covers inherited location, sourced HOME expansion/file override, inherited AppView projection location, sanitized config errors, and existing binding/maintenance cases. The temporary reproduction removed its own files. No live files or services were accessed.

GO for systems architecture. Independent review and the parent integration matrix still govern release preparation; this verdict is not an installed-surface verification or deployment authorization.
