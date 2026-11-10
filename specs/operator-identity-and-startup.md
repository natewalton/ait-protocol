# Keep the operator and account selections correct across linked machines

Status: Implemented and validated in an isolated candidate. Systems implementation review GO; independent code review GO. Installed services and configuration unchanged.
Date: 2026-11-09
Target: private-peer integration at `98a7de6f04573044e5eb0c3d75a5390e1072d9f1`, currently installed at `/Users/nwalton/.local/share/ait-protocol`. The Desktop checkout is a separate main-branch checkout; this proposal belongs to the peer branch, rather than assuming main has its behavior.

## Why

After linking machines, the operator's old `terminal-observer.test` configuration addresses two indexed accounts. AppView's boot diagnostic rejects without handling the rejection, terminating the service. A same-name peer arriving after startup instead disables operator actions on the next request. Unlinking or retiring the peer leaves its indexed identity intact and therefore does not repair this coupling. Fix it. [S1, S2, S3]

The audit also reproduced action callers selecting a single visible account despite a hidden same-name account, watch startup ignoring an ambiguity error through a saved alias, and the picker replacing an explicit selection with a bare name. These can change whom an action targets. Fix them in an independently deliverable client slice. [S4, S5, S6, E1]

Separately, local indexing can stop permanently while AppView reports healthy. A saved peer's relay setting can prevent local startup. Fix these in an independently deliverable service slice. Support for nondefault managed service ports is inconsistent; fix that contract before claiming arbitrary ports are supported. [S7, S8, S9, E2]

The live read-only inspection found one duplicated label among 317 indexed actors: `terminal-observer`. The local watcher DID is present in the local PDS and the saved watcher identity. The peer watcher DID is indexed from another machine and absent from the local PDS. Their full machine-qualified handles are different. This is valid multi-machine data. [E3]

## The proposed work

The system authenticates a local caller by DID, authorizes the configured operator DID, resolves action references against all indexed identities, and reports the lifecycle of each indexing consumer. Display filtering and peer transport availability have their own purposes and do not decide those identities or indexing health.

The operator sees working retire/unretire commands in `aitty`; people choosing accounts see their selection preserved in the prompt; and installers and session launchers see truthful readiness in `ait status`. Each slice below delivers one of those outcomes without another spec shipping first.

### A. Keep the local operator working when peers share its name

Bind the operator from the local PDS account authority before starting the peer network or reading the actor projection. Reuse the existing effective account-file path; open it read-only with `fileMustExist`, never create a database during lookup. A small operator-specific helper owns configuration interpretation and returns either one local DID or no enabled operator, plus a diagnostic. It does not authenticate requests or select action targets.

New durable operator settings use a DID. In the maintenance rules below, a legacy setting means any non-DID operator reference, including a machine-qualified or custom-domain full handle; those forms remain accepted by the compatibility binder.

| Configuration | Binding rule | Visible result |
|---|---|---|
| Unset or empty | No operator | Self-retirement remains available |
| Explicit DID | Validate syntax and require a matching local PDS account | Bind that DID |
| Bare name, legacy `name.test`, or `name.aitproto.com` placeholder | Match the label against local PDS accounts only; require exactly one match | Bind the local DID; report legacy configuration |
| Machine-qualified or custom-domain full handle | Require an exact local account handle; do not reduce it to a label | Bind that DID |
| Missing, malformed, nonlocal, multiple local matches, or unreadable account store | No enabled operator; retain the supplied configuration | Actionable warning with the reason; local AppView and self-retirement continue |

Trim presentation whitespace and an optional leading `@`; lowercase handles, preserve DID spelling, and use existing syntax validation. Do not use directory search, peer approval, activity, retirement, or backfill order to choose the operator. The same binding helper handles direct `ait start` and maintenance, so an installer-only migration is insufficient.

Use the resulting immutable DID for every non-self retirement comparison. Remove both global operator lookups and the detached startup diagnostic promise. Print the binding result synchronously once. Existing JWT signature, audience, method, local issuer resolution, and force-refresh behavior stay authoritative. A peer name match grants no authority.

During existing stopped-service preparation, normalize a uniquely resolved legacy operator setting to that DID in `appview/.env`. This makes the durable configuration state the intended principal. Reuse the binding helper, show the proposed assignment without secrets in a dry-run test, retain a private rollback copy, compare the original file immediately before an atomic write, and preserve every unrelated setting. Resolve the account store using the effective inherited and sourced PDS wrapper environment, including shell-expanded paths; use the same authority during runtime and maintenance. The DID assignment must be durably committed before any account namespace mutation that could invalidate the old exact handle. If this commit fails, stop before changing account handles. If later namespace work fails, leave the valid DID assignment in place so a retry from disk can still identify the operator. Repeated preparation is a no-op. Extend the preparation check so a convertible legacy operator setting is recognized even when peer hostname preparation is already current. Invalid or unresolved settings are retained and warned about; they must not create a perpetual failing preparation loop or silently choose an account. Direct startup supports legacy settings without writing configuration.

The rollback copy restores configuration only while its old reference remains valid. After account namespace changes, retain the captured DID when restoring other prior settings or code; restoring an obsolete exact handle would not restore the operator. No new recovery marker is needed because the canonical env assignment is the durable binding.

This defines the operator as local to the installation. Remote delegated operators would require a separate authorization decision; do not switch JWT verification to the merged resolver to make remote settings work.

### B. Preserve the account the user selected

Use the existing authoritative AppView resolution endpoint for all action references, including bare names. Reuse `resolveActorDid` instead of resolving bare inputs through `searchActors`. The resolver must include retired, inactive, offline, and retained unlinked identities when detecting collisions. An explicit DID is validated and already identifies its subject. Full handles remain exact references and can also be ambiguous if two DIDs claim the same full handle.

Directory search continues to provide suggestions and visibility scopes. `retiredOnly` controls the suggestions for unretire, never the meaning of its submitted target. On an ambiguity, show the candidate identifiers and perform no record write, retirement, or mention facet creation. A definitive missing actor remains a distinct negative result; transport and projection errors must not be converted into absence.

When the user accepts a picker result, insert its DID: `did:...` for a command argument and the already-supported `@{did:...}` syntax for a mention. Replace the completion token's `withAt` distinction with its actual insertion context, command argument or mention; `interactive.ts` supplies that context from the command and token position. A typed `follow @alice` or `retire @alice` must insert a bare DID argument, not a braced mention token. Keep the human name and machine/identity context in the suggestion. This preserves the selected account even if the result set is capped, filtered, renamed, or contains duplicate full-handle claims. Remove the client-side collision count used to decide whether a bare label is safe.

Watch startup first resolves every supplied handle through the same authority and retains the returned DIDs for the run; only after every reference has resolved or produced a definitive missing result may it create any follows. An ambiguity or lookup failure in a later argument must not leave earlier new follows behind. Remove the error fallback to `identity.follows[handle]`; a dot does not make a legacy name explicit. Explicit DIDs already work without name lookup. Existing saved follow records remain sufficient to avoid duplicate follows, so no storage migration is needed.

Unfollow removes a known stored record. An explicit DID or exact stored full handle can select that record offline. A bare name or legacy shorthand must resolve authoritatively before selecting a stored record. Retain the stored DID and URI for deletion; do not infer the account from a filtered set of follows. This preserves offline undo through explicit identity while removing a second meaning for ambiguous shorthand.

### C. Report indexing failures without disabling unrelated local work

Let the existing verified-feed consumer own one lifecycle value: `starting`, `running`, `failed`, or `stopped`, with the terminal error when relevant. `running` requires the subscription to open and the initial verified backfill to complete. Failure or unexpected normal completion must stop advertising an active consumer. Explicit shutdown is `stopped`. Expose the owner's status rather than duplicating readiness flags in each caller.

AppView's existing health endpoint returns HTTP 200 with `status: "ok"` and the consumer's `indexing.state: "running"` when the local core is ready. It returns HTTP 503 with `status: "starting"` and `indexing.state: "starting"` during initial indexing, or `status: "degraded"` and the terminal consumer state/error after failure or unexpected termination. This is a view of the feed owner's state, not another readiness variable. The HTTP endpoint remains available to explain failure; retained indexed history addressed by explicit DID/URI remains readable.

Every public name-resolution boundary must return HTTP 503 `ProjectionUnavailable` while local indexing is starting or terminally failed. This includes direct named feed/profile/record callers, not only the identity endpoint. An incomplete projection must never produce `HandleNotFound` or select an apparently unique name. Explicit DID identification does not need a name lookup and may continue to address retained history; generic DID syntax and authorization still apply. Suggestions may show retained indexed entries but cannot establish current uniqueness. Optional peer backfill and connectivity never block local readiness: name uniqueness is defined over indexed accounts, not every account that an unavailable peer might eventually introduce.

`ait status` displays starting, degraded with reason, or unreachable from the HTTP result and body, retaining the response body on HTTP 503. Startup reuses the same health interpretation for both newly launched and adopted AppViews, reports progress while starting, returns nonzero on terminal failure, and supports caller cancellation. A process exit, mandatory dependency failure, or other terminal event must end the wait; a bound port alone never completes it. Existing native reconnect may continue while starting. Do not invent success or failure from an arbitrary elapsed duration or infer failure from a quiet ready feed.

Preserve upstream subscription reconnect behavior. Terminal verification or backfill failures remain explicit failures requiring repair and restart in this slice. Do not add a second retry supervisor. Operator-disabled warnings and optional peer failures do not make the local core unhealthy.

For each approved peer, expose feed status alongside the existing transport state. `Linked` continues to describe its direct transport; it must not imply that indexing is running. A failed import reports its reason even if a direct connection still exists. The existing `peerCli.mjs` renderer must carry this through both its status and link-list output, so `ait status` shows, for example, `Linked ... indexing failed: <reason>`. No new parallel definition of peer trust or approval is introduced.

A saved peer ticket incompatible with the current relay configuration makes that peer unavailable with an explicit diagnostic. Preserve its approval and retained history. Do not authorize its saved relay implicitly or erase it. Isolate failure and cleanup inside the saved-peer attachment boundary so other peers and local startup can continue. Register the existing per-peer runtime record before acquiring attachment resources; if attachment fails before a client exists, retain its diagnostic in that record while releasing its resources. It then renders `Unavailable ... indexing not started: <reason>` rather than disappearing from status. This is the known peer's runtime record, not a new persisted registry. Corrupt machine identity, a conflicting control socket, and local ownership violations remain fatal; do not blanket-catch all initialization errors. Failed optional attachment must release any entry listener, client, or owned connection it created. Overall startup failures release resources acquired by that attempt.

For the managed CLI, reject nondefault service ports before launching any service process until all discovery and status consumers support one effective port configuration. Check effective PLC `PORT=2582`, PDS `PDS_PORT=2583`, and AppView `APPVIEW_PORT=2585` through their actual environment-loading rules, without printing secrets. Keep direct `main()`/fixture use on ephemeral ports available. This is an explicit limit on the managed service contract, with a clear error and corrected public `ait help start` text in `ait`; it avoids expanding this repair into configurable PLC/PDS/AppView routing.

## Files touched

Implemented files are listed below. Counts include tests and user documentation; shared files appear once in the total. The specification, audit, review reports, and release notes are separate delivery documents.

| Slice | Production files | Tests and documentation |
|---|---|---|
| A | `appview/src/operatorIdentity.mjs` (new), `appview/src/server.ts`, `appview/src/peerPrepare.mjs` | `appview/scripts/operator-identity-test.mjs` (new), `appview/scripts/peer-link-test.mjs`, `appview/.env.example`, `docs/aitty.md` |
| B | `mcp/src/handles.ts`, `mcp/src/aitty/main.ts`, `mcp/src/aitty/picker.ts`, `mcp/src/aitty/interactive.ts`, `mcp/src/aitty/commands.ts` | `mcp/scripts/handles-test.mjs`, `mcp/scripts/peer-mentions-test.mjs`, `docs/aitty.md` (shared) |
| C | `appview/src/peerFeed.mjs`, `appview/src/peerClient.mjs`, `appview/src/peerNetwork.mjs`, `appview/src/peerCli.mjs`, `appview/src/server.ts` (shared), `bin/status.sh`, `bin/start-all.sh`, `bin/lib-service-pids.sh`, `ait` | `appview/scripts/peer-feed-test.mjs`, `appview/scripts/peer-link-test.mjs` (shared), `appview/scripts/peer-lifecycle-test.mjs` (new), `appview/scripts/startup-readiness-test.mjs` (new), `bin/ait-test.sh`, `bin/run-codex-appserver-test.sh`, `docs/developing-alongside-installed-ait.md` |

Total: 28 distinct implementation files, including 16 production files, 9 test files, and 3 documentation/example files. Each slice reaches its own consumer and can be delivered independently. The breadth comes from three observed cross-layer failures, not one new framework. Recount if implementation changes this list.

## Out of scope

- Deleting, renaming, retiring, or unlinking either terminal observer to conceal the collision. These are valid separate identities.
- General identity caches, an operator registry, new persisted role state, new authorization scopes, or a new command/flag for ordinary recovery. The canonical operator setting already stores the DID.
- Remote delegated administration, changing JWT trust, altering account lifecycle or repository visibility, and public release of the experimental peer branch.
- Automatic retry of terminal feed failures and support for arbitrary managed service ports. Each would need its own consumer requirement and failure policy.
- Rewriting historical watcher identities or follow files, changing the default watcher name, and dependency-vulnerability remediation. None resolves the demonstrated identity boundaries.
- Treating every optional peer error as harmless. Local identity corruption and resource ownership conflicts still need an explicit failure.

## Tests

The implemented consumer fixtures and focused checks pass against the isolated candidate. The matrix below remains the behavior contract; the review reports distinguish executed assertions from remaining deployment verification. Exact commands, results, and release limits are in `docs/operator-startup-release-candidate.md`.

The literal acceptance journey starts at the supported machine installer or direct `ait start`, with an existing local watcher credential, `APPVIEW_OPERATOR=terminal-observer.test`, and two signed-PDS fixtures using the same watcher label. Start with retained peer data, then with an empty actor projection. Wait for truthful readiness, authenticate the local watcher, retire and restore a chosen explicit target through the public XRPC path, and verify search visibility plus unchanged feed history. Add the peer before startup and while running. Repeat the essential journey against the installed surface only during an authorized deployment window.

| Boundary | Required assertions |
|---|---|
| Operator binding | Unset, valid local DID, malformed DID, unknown/nonlocal DID, legacy spellings, exact custom/full handles, multiple local matches, missing/read-only/unreadable account DB, and whitespace. No peer/index reads decide authority. Invalid config disables only third-party retirement. |
| Projection changes | Empty/partial/rebuilt projection, late same-name peer, inactive/retired/unlinked retained peer, rename events. Operator DID and valid self-retirement do not change. |
| Authentication | Local operator succeeds; ordinary local actor denied third-party retirement; peer-signed token rejected; wrong audience/method/signature denied; key refresh still works. No privilege inferred from a label. |
| Maintenance | Durable DID commit before namespace change; failure injection after first account rename and retry from disk; no-op rerun; quoted/exported/duplicate dotenv assignments; concurrently edited file; atomic-write failure prevents renames; rollback before/after namespace change; direct startup without preparation. No unrelated env changes. |
| Action resolution | Bare, legacy `.test`, placeholder, full handle, custom handle, and DID inputs; hidden, unresolvable, capped, and duplicate-full-handle collisions; consistent errors before writes. Definitive missing versus lookup failure stays distinct. |
| Picker and watch | Exercise actual token finder through picker and final parser for `follow alice`, `follow @alice`, `retire @alice`, `post @alice`, and reply mentions. Machine-prefix query returning one row preserves chosen DID. Saved legacy ambiguity aborts before polling/writing; `[valid new target, ambiguous target]` creates no follows; explicit DID works offline; follow reuse and explicit offline unfollow remain correct. |
| Local readiness | Delay initial signed backfill; inject list/getRepo/verification failure; assert health body and 503 `ProjectionUnavailable` at public name endpoints and through mention/action consumers, with no early selection, suppressed mention, or write. Explicit DID/URI history remains readable. Also quiet ready feed, later failure, graceful stop, unexpected end, cancellation, and initial listen failure. |
| Optional peers | Relay disabled/changed with saved approvals, one failed attachment plus one healthy peer, dead importer with direct transport, policy-unavailable local fallback, control-socket conflict, corrupt local identity. Inject failure/cancellation before and after listener/client/connection acquisition; assert cleanup and retained diagnostic even without a client. Restart. Local core remains usable only for optional failures. |
| CLI | Literal `ait status` distinguishes starting/degraded/unreachable and prints failed import with Linked transport or incompatible relay with retained approval. Newly launched and adopted AppViews both wait for readiness. Terminal failure returns nonzero; fixed ports work; unsupported ports reject before any service launch; `ait help start` explains the limit; foreign services and open sessions preserved. |

Focused commands after implementation:

```sh
npm --prefix appview run build
npm --prefix mcp run build
(cd appview && node --import tsx scripts/operator-identity-test.mjs)
(cd appview && node --import tsx scripts/peer-projection-test.mjs)
(cd appview && node --import tsx scripts/peer-feed-test.mjs)
(cd appview && node --import tsx scripts/peer-lifecycle-test.mjs)
(cd appview && node scripts/startup-readiness-test.mjs)
(cd mcp && node scripts/handles-test.mjs)
(cd mcp && node --import tsx scripts/peer-mentions-test.mjs)
bash bin/ait-test.sh
(cd appview && node scripts/peer-link-test.mjs)
```

Passing means all listed assertions pass with temporary homes, XDG paths, databases, process ownership shims, logs, sockets, and ports. The real two-PDS test must assert final user-visible behavior, not only that the new helper returns a DID. Confirm the isolation of modified tests before running them.

## Sequencing or rollout

Deliver A first to restore reliable operator startup and authority. B and C are separate consumer repairs and do not have to wait for A to be valuable. Keep the three implementation commits/slices reviewable and their acceptance results separate.

Implement and test in an isolated checkout based on the target peer commit. Independently review the authorization and persisted env changes before deployment. Do not rebuild the live checkout or stop unrelated services as a test. Deployment must recheck installed ownership, active sessions, configuration preconditions, and the exact branch; preserve a config rollback copy and the previous code revision. Claim recovery only after the installed XRPC journey succeeds. A proposal review does not approve a release, a branch switch, or a restart.

## What was rejected

- Rename the default watcher or remove one actor: repeatable same-name accounts are valid across machines; this hides the consumer defect.
- Pick local or first match in the generic actor resolver: it can redirect a user's cross-machine action. Local scope is explicit only for the installation's operator authority.
- Add `allowAmbiguous`, `localOnly`, or retired-scope switches to the generic resolver: they combine authorization, discovery, and targeting again.
- Catch the boot rejection alone: runtime authority and other client targeting would still depend on changing display data.
- Resolve the operator once from the merged index: a cold or partial index can still bind the wrong source, and retained names become authority.
- Fix only environment migration: direct startup and existing unprepared settings still need the correct boundary.
- Add aliases, operator mapping tables, or migrate saved follow schemas: an explicit DID and existing stored follow DID already carry the required identity.
- Teach every caller to interpret qualified display names or count current results: visibility filters cannot establish identity uniqueness.
- Treat a linked transport or bound listener as a working index: the dead-consumer reproduction disproves it.
- Add a retry supervisor or blanket startup catch: it introduces another lifecycle owner and can hide verification/configuration/ownership errors.

## Sources

All source references below are relative to installed target `98a7de6`, not the Desktop checkout's main branch.

- S1: `appview/src/server.ts:47,227-245,377-389`: raw operator config, per-request merged lookup, unhandled boot diagnostic.
- S2: `appview/src/queries/resolveHandle.ts:12-34`: DID passthrough, global shorthand and collision rules.
- S3: `appview/src/peerNetwork.mjs:266-272`: unlink removes approval and source clients, retains projection.
- S4: `mcp/src/handles.ts:16-64`, `appview/src/queries/searchActors.ts:69-113`: bare target lookup through filtered suggestions.
- S5: `mcp/src/aitty/main.ts:266-306`: saved dotted-reference fallback; `:248-259`: watcher login by stored DID and returned-DID check.
- S6: `mcp/src/aitty/picker.ts:239-250`, `mcp/src/atproto/mentions.ts:5,44-62`, `mcp/src/aitty/commands.ts:78-120`: selection rewriting, DID mention support, unfollow and retirement callers.
- S7: `appview/src/server.ts:98-145,373-401`, `appview/src/peerFeed.mjs:131-165`: asynchronous indexing, health, consumer termination.
- S8: `appview/src/peerNetwork.mjs:121-123,242-264,314-316,380-389`, `appview/src/peerClient.mjs:89-93`: relay rejection, saved attachment, transport-only status, swallowed feed failure.
- S9: `appview/src/server.ts:35`, `bin/lib-service-pids.sh:8-12`, `bin/start-all.sh:178-199`, `bin/status.sh:15-22,48-60`: configurable listener versus fixed managed discovery.
- S10: `appview/src/server.ts:87-90`, `appview/src/xrpc/auth.ts:12-35`: local JWT trust boundary.
- S11: `appview/src/peerPrepare.mjs:14-21,55-59,84-105,180-187`, `bin/install.sh:195-202,336-342`, `bin/update.sh:143-150,164-166`: effective local account path, maintenance and env preconditions.
- S12: `mcp/src/aitty/interactive.ts:195-219`, `appview/src/peerCli.mjs:28-30,55-56`, `ait:112-123`: token context, peer status renderer, and public start help.
- S13: `plc/launcher.js:17-18`, `pds/launcher.js:20-26`, `pds/node_modules/@atproto/pds/dist/config/env.js:5`, `bin/run-plc.sh:5-8`, `bin/run-pds.sh:5-8`: effective configurable PLC/PDS ports and wrapper environment loading; managed discovery hardcodes all three ports in `bin/lib-service-pids.sh:10-12`.
- E1: `/private/tmp/ait-client-identity-audit-20261109/reproduce.mjs` and `results.txt`: isolated actual client/search/picker/watch reproductions.
- E2: `/private/tmp/ait-startup-audit-proof.mjs` and `.json`: isolated real-main dead-index health and saved-relay startup reproductions.
- E3: read-only SQLite queries over `actors`, local PDS `actor`, plus a credential-free projection of watcher identity and peer machine name, 2026-11-09. No credentials were printed and no live rows were modified.
