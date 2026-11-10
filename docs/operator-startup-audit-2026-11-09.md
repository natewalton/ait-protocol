# Operator and startup audit after linking machines

Date: 2026-11-09
Audited implementation: installed private-peer commit `98a7de6f04573044e5eb0c3d75a5390e1072d9f1`.
Status: Audit and proposed design review. No implementation, account, config, service, or deployment changes.
Proposal: [Keep the operator and account selections correct across linked machines](../specs/operator-identity-and-startup.md).

## Audit findings

The live index contains two distinct machine-qualified terminal-observer accounts, with one duplicated friendly label among 317 actors. Both are valid identities. The defects are in the consumers of names and service lifecycle, rather than duplicate local account creation.

| Finding | Impact and evidence | Verdict |
|---|---|---|
| F1. Operator authority depends on the merged display index | High. A same-name peer makes boot reject without a catch, or makes a previously working operator fail on its next third-party retirement. Retired, inactive, and unlinked retained rows preserve the ambiguity. `server.ts:227-245,377-389`; `resolveHandle.ts:19-34`; `peerNetwork.mjs:266-272`. The boot failure is observed live; changing-index consequences reproduced in memory. | Fix A: bind from local account authority; remove global operator lookup and detached diagnostic. |
| F2. Bare client references bypass hidden collisions | High. Actual `searchActors` and `resolveActor` select a listed local account when the peer namesake is retired/inactive, while the authoritative resolver rejects. Retire/unretire can choose different DIDs for the same name because they choose different suggestion scopes. `handles.ts:34-64`; `searchActors.ts:69-113`; `commands.ts:118`. | Fix B: one authoritative target resolver. |
| F3. Watch startup ignores ambiguity through saved aliases | Medium. A cached `follows['alice.test']` bypasses an authoritative 400 `AmbiguousHandle`, and actual watch main starts polling. `aitty/main.ts:281-285`. | Fix B: delete the alias fallback; explicit DIDs remain usable. |
| F4. Picker loses an explicit account choice | Medium. A machine-qualified search returning one result inserts `@alice`, discarding the selected namespace. `picker.ts:239-250`. Actual picker reproduction confirms it. | Fix B: preserve selected DID in the existing command/mention syntax. |
| F5. Failed local indexing reports healthy | High. Actual AppView main with a temporary PDS gets a listRepos 503, logs terminal indexing failure, never retries after the PDS recovers, remains alive, and serves 200 `{"status":"ok"}`. Cold startup also publishes HTTP before backfill completion, so current readiness does not imply identities are projected. `server.ts:118,141-145,373-389`; `peerFeed.mjs:131-165`. The terminal-failure case is reproduced; the cold-ordering case is source-proven. | Fix C: readiness comes from the local consumer lifecycle. |
| F6. Optional peer settings can stop local startup | High. A saved ticket containing a previously allowed relay rejects when assistance is disabled or changed. Saved attachments are awaited during startup; the error escapes main. Actual peer-network reproduction with temporary state yields `unconfigured assistance relay`. `peerNetwork.mjs:121-123,242-264,380-381`; `server.ts:71-84`. | Fix C: isolate optional attachment failures without authorizing the old relay. |
| F7. Peer transport state hides import failure | Medium. The peer consumer can terminate permanently; its rejection is swallowed by the client, while peer status checks direct connection paths only. `peerClient.mjs:89-93`; `peerFeed.mjs:150-164`; `peerNetwork.mjs:314-316`. Source-proven; a live peer importer failure was not induced. | Fix C: expose feed lifecycle alongside transport. |
| F8. Nondefault managed AppView ports can hang startup | Medium. Server accepts `APPVIEW_PORT`, but discovery/status use 2585 and the supervisor waits while the wrapper stays alive. `server.ts:35`; `lib-service-pids.sh:12`; `start-all.sh:178-199`; `status.sh:49`. Source-proven; isolated real main runs on a configured ephemeral port. Installed supervision was not invoked. | Fix C: reject unsupported managed port configuration before launch. |
| F9. Invalid operator configuration can print a success | Low. Any `did:` string passes the generic resolver, including `did:not-an-identity`; the boot diagnostic describes it as authorized. No demonstrated privilege escalation. `resolveHandle.ts:12`; `server.ts:383-388`. | Fix A: syntax and local-account validation. |
| F10. Examples and comments preserve obsolete assumptions | Low. The example recommends `terminal-observer.test`; authorization comments claim a permanent handle cache and one PDS read, although lookup scans the current projection. `appview/.env.example:20`; `server.ts:233-237`. | Fix while editing A: show a DID and explain local binding accurately. |

Paths in this table are relative to installed `appview/src`, except explicit `mcp`, `bin`, or env paths. `handles.ts` is `mcp/src/handles.ts`; `aitty/*` and `commands.ts`/`picker.ts` are under `mcp/src/aitty`. These locators refer to the audited peer commit, not the Desktop main branch.

## Boundaries that held

JWT verification uses the local resolver, preserves audience and method binding, and refreshes keys through the upstream verifier. In an isolated signed-token check, a peer issuer absent from the local authority was rejected. Matching a display name alone did not establish operator privilege. `server.ts:87-90`, `xrpc/auth.ts:12-35`.

Watcher bootstrap logs in with the saved DID and checks the returned DID before updating its handle. MCP reauthentication likewise logs in by stored DID and checks the result. These paths already avoid peer-name collisions; keep them. `mcp/src/aitty/main.ts:248-259`, `mcp/src/atproto/pdsClient.ts:97-111`.

The generic server resolver deliberately keeps retired/inactive actors in collision detection and rejects duplicate exact claims. Do not weaken it to compensate for the operator config. The local client bypass, not the server's rejection, is the defect. `resolveHandle.ts:6-34`, `appview/scripts/peer-projection-test.mjs:211-274`.

The startup fixture stopped normally with SIGTERM and exit 0. No independent shutdown defect was reproduced. Partial-initialization cleanup is an acceptance requirement for the newly isolated attachment boundary, not a claim that every existing startup path leaks.

## Scope and evidence

The inspection followed all seven production AppView `resolveActorToDid` calls: six in `server.ts` and one in `queries/getRecord.ts`. Two are operator-config consumers. It followed all twelve production MCP `resolveActor` call sites across mentions, tools, watcher startup, commands, and agent methods, plus `actorLookup`, PDS proxy parameter conversion, watcher/MCP storage and reauthentication.

Startup coverage included `main`, verified local/peer feed consumers, peer client/network attachment and status, preparation checks and writes, `run-appview.sh`, `start-all.sh`, `status.sh`, installer, updater, process discovery, and the AppView launchd template. Launchd's KeepAlive can repeat F1 as a restart loop; it is an amplifier of that configuration defect rather than a separate cause.

This is exhaustive over the operator/name-resolution/startup call graph inspected at this commit. It is not a claim that all peer transport, protocol, dependencies, or repository behavior has been exhaustively tested. The proposal's acceptance matrix includes unimplemented scenarios explicitly marked as proposed.

Retained reproductions, all isolated from installed env/data and fixed live services:

- `/private/tmp/ait-client-identity-audit-20261109/reproduce.mjs` and `results.txt`: actual compiled client, in-memory actor search, actual picker, actual watch entry with fake transport and temporary XDG identity.
- `/private/tmp/ait-startup-audit-proof.mjs` and `.json`: actual compiled AppView main with temporary database/env, ephemeral loopback fake PDS, and temporary machine identities. Also the saved-relay rejection.
- In-memory operator/auth checks: collision appears after adding a peer; survives activity/retirement/unlink-state changes; explicit DID remains stable; malformed DID passthrough and peer-token rejection. Source and results were inspected during the audit; these checks were not retained as a standalone harness.

Existing focused checks on the unchanged target all passed:

| Command in its package directory | Result | Receipt |
|---|---|---|
| `node --import tsx scripts/peer-projection-test.mjs` in appview | 18/18 pass | `/private/tmp/ait-operator-audit-projection-tests.log` |
| `node --import tsx scripts/peer-feed-test.mjs` in appview | 12/12 pass | `/private/tmp/ait-operator-audit-feed-tests.log` |
| `node scripts/handles-test.mjs` in mcp | All consumer checks pass | `/private/tmp/ait-operator-audit-handle-tests.log` |

The passing tests validate existing narrower contracts. The reproductions identify missing composed journeys; none is evidence of an implemented fix.

## Systems review of the proposal

Trigger: more than three source/runtime-config files across authorization, persistence, clients, and service lifecycle. Reviewed with `general-systems/SKILL.md` after drafting the full proposed solution.

**System sentence:** a local caller authenticates by DID, the configured local operator authorizes retirement, a projection resolves account references, and each feed consumer reports whether indexing is working.

Four core concepts come directly from the inspected code: principal (`payload.iss`, `viewer` and `operatorDid`); account reference (`actor`, `did`, `claimedHandle`, `label`); projection visibility (`active`, `retiredAt`, `retiredOnly`); consumer lifecycle (`running`, the subscription iterator, abort controller and returned promise). Transport/approval (`source`, `state.peers`, direct paths) is an existing fifth concept at the optional peer boundary. Its state is not interchangeable with the consumer lifecycle. This is five concepts with explicit composition, rather than new mode flags joining their responsibilities.

An AST inspection counted conditional constructs in the current identity callers:

| Function | If statements | Ternary expressions | Catch clauses |
|---|---:|---:|---:|
| `resolveActorToDid` | 2 | 1 | 0 |
| `resolveActor` | 6 | 0 | 1 |
| `ensureFollows` | 6 | 1 | 2 |
| Picker `accept` | 1 | 2 | 0 |

That is 22 branch constructs in four functions, excluding boolean subexpressions. Branch count is not a correctness score. The decision-changing evidence is that three different caller rules infer identity from a dot, visible search results, or a saved alias, while server resolution uses the unfiltered index. The operator adds a fourth misuse by turning display lookup into authority. There are multiple kinds of exceptions at one boundary, so this review requires correcting that boundary rather than adding more caller exceptions.

The proposal removes the directory-based bare selector, dotted fallback, picker collision recount, per-request operator lookup, and detached operator diagnostic. It retains the existing authoritative resolver and DID syntax. An operator-specific binder has a different authority source and purpose; it does not become a `localOnly` switch on the generic target resolver.

**1. Symptom or model?** Model. Catching the boot rejection would leave changing operator authority and client misselection. The proposal makes local authority independent of display data and makes all action callers honor one targeting rule.

**2. Can existing concepts absorb the change?** Yes. Operator DID remains in its existing env setting; saved follows already carry DID and record URI; the existing endpoint resolves names; the existing feed owns its promise and cancellation. Only feed lifecycle becomes observable, because its failure was already real but hidden. No new identity table, alias cache, or supervisor is warranted.

**3. Would these concepts exist in a new system?** Yes. Stable principal, reference resolution, visibility, lifecycle, and approval/transport are independently needed. A separate boolean for every caller's readiness, alias confidence, or collision scope would fail this test and is excluded.

**4. Can the full behavior be explained in one sentence?** Yes, as above. Legacy config interpretation is confined to the local authority boundary; ordinary targeting does not acquire its exceptions.

**Friction checks:** the revised proposal spans 28 implementation files because it covers three independently visible outcomes. Slice A has three production files, B five, and C nine including one shared file. C crosses feed owner, peer owner, HTTP, and CLI and therefore deserves particular review: each changed layer consumes the same feed lifecycle rather than inventing a state machine. Existing shared `status.sh` remains the health consumer, and `peerCli.mjs` carries peer lifecycle information to its actual terminal output. If implementation adds a new registry, recovery mode, retry loop, persisted readiness record, or per-caller shadow flag, stop and reduce it.

**Timing and failure checks:** operator binding precedes network awaits and needs no backfill. The canonical DID env assignment commits before namespace mutation, so a crash and disk-only retry retain its identity. Core readiness waits for subscription plus initial backfill; public named callers return `ProjectionUnavailable` while local projection is incomplete or failed. Explicit DID/URI history remains usable. Optional peer failure reports its own reason even without a client and cannot change local identity. Quiet feeds remain healthy; terminal errors become explicit. Newly launched and adopted services both use readiness; cancellation and ownership conflicts still have failure paths. Updating an env setting is a maintenance write with a snapshot and precondition, not a startup side effect.

**Representation checks:** the existing picker token conflates mention syntax with `@`-prefixed command arguments. Replace `withAt` with actual insertion context rather than adding an exception around DID strings. The selected DID then reaches the command/mention parser literally. Watch resolves all references before executing follow writes, so a later ambiguity needs neither rollback nor another persisted state.

**Spec-design check:** questions 1-3 have concrete answers: current retire/start/watch behavior fails as reproduced; the small version reuses local account authority, the target resolver and feed owner; the affected users see retire/unretire, picker/watch and `ait status` behavior. Questions 4-13 identify no unresolved design defect in this draft: slices are independently useful, source claims have locators, tests start at public consumer entries, changes include terminal/UI feedback, no future registry or retry service is specified, and rejected alternatives have reasons. This is a proposal verdict, not implementation validation.

Systems verdict after revising the independently identified gaps: the abstraction addresses the measured causes. The additions complete missing consumers and ordering requirements; they do not add a role registry, alias cache, or retry supervisor. Independent re-review subsequently returned GO for the proposal.

## Independent review

Round 1: BLOCK. The independent reviewer agreed with the authority/reference/visibility/lifecycle separation but found five missing requirements: unavailable projection gating for names, real picker insertion context, rendered peer status, durable DID commit before account rename, and public port help. The proposal was revised to address all five, plus adopted-service readiness, multi-target watch ordering, and failed-attachment diagnostics. See the [independent report](operator-startup-independent-review.md) for source evidence.

Round 2: GO for the complete revised proposal. The independent reviewer re-read the design and source and found no residual design blockers. All five findings and the additional acceptance requirements were addressed. Remaining implementation risks are enumerated in the report: every public name boundary, effective env/account paths, disk-only crash recovery, cancellation and partial cleanup, ownership and adopted-service readiness, and literal consumer tests. No implementation or deployment result is implied by either design review.

Implementation outcome: the isolated candidate subsequently passed systems and independent code review. See [systems implementation review](operator-startup-systems-review.md), [independent code review](operator-startup-code-review.md), and [release preparation](operator-startup-release-candidate.md). The proposal review history above remains distinct from implemented validation.
