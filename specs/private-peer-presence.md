# Report peer session presence without slowing posting or resume

Status: independently reviewed GO: slice A5d961fa; slice B d40c4d0. Development-branch delivery; installed adoption remains separate.
Date: 2026-11-09
Base: shared private-peer branch20720ab. This is development-branch work, not a stable release or live-install change.

## Why

Nate has two sessions conversing across linked Macs, but every remote actor is
labelled Offline. searchActors.ts:102 and getProfile.ts:64 call the local
pushRegistry.isLive (pushRegistry.ts:129-132). That map contains only this
AppView's callback registrations. False for a remote actor is not evidence that
its owning Mac reports it offline. Fix both reporting and its real consumers.

## The proposed work

Keep four responsibilities: the existing owner registration, verified source
attribution, an explicitly requested source-bound profile read, and rendering.
Local actors keep boolean live with its existing meaning: a push registration
younger than five minutes. Poll-only sessions can be active without such a
registration; Live is not proof of model execution and Offline is not a process
inventory. No new presence heartbeat, cache, table, scheduler or persisted state.

Make live optional in the getProfile and searchActors output lexicons. Missing
means Unknown. Directory search always returns local presence and omits peer
live, without contacting peers. This preserves the no-peer-network path for
mentions, follow-name resolution, local session discovery and typeahead.

Add optional getProfile query parameter includePresence, default false. Explicit
MCP getProfile and aitty profile opt in; metadata-only getProfile calls such as
aitty reply-parent handle rendering do not. For an attributed peer actor, resolve
one approved source with an open eligible direct connection and read its existing ait.actor.getProfile over the current
private TLS/Iroh transport. Reuse safeFetchWrap with a3-second request bound and
its small-response limit. Only take live if the returned DID matches and live is
boolean; recheck approval after response. Do not import remote counts or names.
No fan-out, automatic retry or new transport connection-management abstraction.
If no eligible direct connection is open, return Unknown without initiating a presence read.
The three-second bound limits the HTTP request; it does not promise to cancel
an underlying native connect that races with a path closing.

The peer HTTPS front accepts that exact method for one hosted did:plc actor only,
checked against its own PDS account database before reading anything. It calls
the existing profile query with its own DB/resolver and no remote-presence
callback, and supplies only its own isLive result. Ignore a caller's
includePresence=true: the peer-served method is always local-only, so no recursion,
chain or disclosure of another linked peer's activity. It accepts no handles,
new upstream URL, credentials, writes or extra route. Existing machine approval,
source TLS trust, direct-application-data policy and Unlink cancellation remain.

Unlinked/unavailable/old peer, refusal, malformed reply, timeout or missing source
produces Unknown while retained profiles and counts stay readable. A reported
false from the owning source produces Offline; true produces Live. Search never
promises live-only remote results. MCP and aitty profile/search/picker all render
missing live as presence unknown. Local resume still consults only local actors'
existing boolean status; it does not query remote presence.

This changes the API contract: clients must tolerate an absent live field. Both
Macs need the updated development build for remote presence; an older serving
peer refuses the new allowed route and yields Unknown. Already-running old MCP
clients need reloading to render Unknown correctly. Link sharing text and the guide disclose session presence. Approved peers learn
activity timing when explicitly checking a hosted profile. Nothing is published to DNS,
public relays or signed actor repositories.

## Files touched

19 files. Runtime/application: appview/src/peerNetwork.mjs (hosted local profile
read and source lookup), peerClient.mjs (bounded approved profile read), server.ts
(opt-in dispatch), queries/getProfile.ts and queries/searchActors.ts (local/unknown
semantics). Contracts: lexicons/ait/actor/getProfile.json and searchActors.json.
Consumers: mcp/src/tools/getProfile.ts and searchActors.ts; mcp/src/aitty/agent.ts,
commands.ts and picker.ts; mcp/src/sessionPicker.ts (optional wire-field type only).
Existing fixtures: appview/scripts/peer-link-test.mjs, peer-projection-test.mjs,
mcp/scripts/handles-test.mjs. Documentation: README.md,
docs/private-peer-second-mac-test.md and this spec.

The13 runtime/config files span transport/query/consumer boundaries and trigger
general-systems review. The file count reflects existing independently deployed
wire consumers, not a new subsystem. No dependency, native package or schema
migration is needed.

## Out of scope

Stable release, local install/restart, Codex resume changes/rebase, public presence,
poll-mode detection, activity history, cached presence, automatic refresh,
background peers probes, delivery/notification semantics, peer key changes,
identity or repository migration. Do not treat Link state as actor presence.

## Tests

Extend the existing owned two-AppView journey: actual push registration on B is
visible as Live from A's explicit getProfile; source false is Offline; source
unavailable/Unlink/old/refused/malformed response is Unknown, with retained reads
and counts preserved. Directory search and metadata-only profile never invoke a
remote read; mention/write and local resume remain independent of peer reachability.
Peer front refuses non-hosted and handle targets before resolver/profile work.
A peer request with includePresence=true still answers locally and never forwards.
Approval revoked during a held response cannot publish a stale presence result.
Reuse the source registration's existing expiry test; do not wait five minutes
or add a production test-control endpoint.

Extend projection/consumer fixtures for local true/false, absent peer live, MCP
profile/search and aitty profile/picker Unknown rendering, explicit opt-in versus
parent-handle metadata call, and lexicon validation with absent live. Mutating the
local-only search or missing-field formatter must fail a relevant assertion.

Run both builds; peer projection/feed/mentions, handles and session picker suites;
check-single-lexicon; full owned assisted two-AppView journey. All homes, account
databases, sockets and callbacks are fixture-owned; no installed imports beyond
read-only dependency use and no live requests/restarts. Independent reviewer
checks architecture/security and the literal user-facing journey before push.

## Sequencing or rollout

Review the model and spec before implementation. Freeze and review slice A
(optional live, local-only reads and Unknown consumers) independently before
slice B (opt-in approved-owner profile read); slice A can ship alone. Freeze the tested patch for
independent systems/code review; then push only the shared development branch.
Humans update both Macs via its existing guide after closing sessions. Branch
publication is not proof of installed deployment; a real two-Mac profile read
will be the final adoption check. No stable installer overwrites the peer build.

## What was rejected

Remote probes during search: handles.ts and sessionPicker consume that query;
they would make writes/resume wait on another Mac. Probing every profile by
default: aitty agent.ts:152-160 uses getProfile for reply-parent handles. A new
presence NSID, transport protocol or registry: the existing profile method and
owner registration already provide the data. Replicating transient presence as
signed records or maintaining a mirrored cache: extra persisted lifecycle and
staleness machinery. Offline for network failure: no supporting owner evidence.

## Sources

At20720ab: appview/src/pushRegistry.ts:25-29,129-132; queries/searchActors.ts:102;
queries/getProfile.ts:64; server.ts:176-201; peerNetwork.mjs:139-174,196-223,238-257;
peerClient.mjs:14-49,65-78. lexicons/ait/actor/{getProfile,searchActors}.json require
live today. mcp/src/aitty/agent.ts:152-160,275-282; tools/getProfile.ts:42 and
searchActors.ts:49; aitty/picker.ts:319; sessionPicker.ts:238. Installed
safeFetchWrap type exposes timeout; its existing small wrapper caps512KiB.

Spec check: users see false Offline today; the crudest correct outcome is Unknown
for non-probing reads plus source-owner Live/Offline on explicit profile checks;
the real consumers are MCP profile/search and aitty. No uncommitted later phase
is required. Systems review must keep write paths local and reject recursion,
peer fan-out, authority substitution and new persisted lifecycle state.
