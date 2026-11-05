# Link with connection assistance and direct data

Status: experiment implementation authorized by Nate on 2026-11-04 after independent spec GO; isolated candidate built and awaiting independent code review; no live deployment, public release or upstream posting authorized.
Date: 2026-11-04.

## Why

AIT users should exchange an invitation and approve a peer without configuring a
router where Iroh's connection assistance can establish a direct path. Application
data must nevertheless never use a relay, including when a working direct path
fails. If a direct path cannot be established, the user gets an honest failure.
This cannot guarantee connectivity across every NAT/firewall pair.

Today's private-peer build disables relays. In the isolated experiment with
@number0/iroh 1.2.0 and official iroh-relay 1.4.1, assistance established a
connection and direct transfer worked after UDP became available. Removing relay
configuration then failed to enforce the required policy: in 2/2 author runs and
2/2 independent reviewer runs, a second 262,144-byte payload arrived over the
relay after UDP was cut. This is a deliberately constructed fault, not an
estimate of how often users lose connectivity. Verdict: enforce the policy before
packet emission; do not use configuration removal or observation as enforcement.

This work delivers an experimental AIT build that Nate can use through the real
`ait link` and status entry points in two isolated installations. It includes the
native policy, Node binding, Link/status integration and a reproduced conversation,
so the consumer sees the difference in the terminal on the day this slice is
delivered. A native hook alone is not completion. Public packaging and live
deployment are excluded. The isolated native and AIT journeys have now run; executed evidence is recorded
below and in the experiment build directory. Implement AIT changes on the private-peer branch at
80bf292278ef2bfe89b985baace2f992bc735db0, in an isolated worktree; this source
checkout contains only the spec draft.

## The proposed work

Retain Iroh's authentication, encryption, rendezvous, hole punching, path
management and QUIC wire protocol. Add one concept: whether a transport path may
carry application payload. Relay paths may carry connection control; only actual
IP paths may carry application STREAM or DATAGRAM frames. This includes all AIT
HTTP, WebSocket, invitation, authentication and repository bytes transported in
those frames, even if they happen to be called an application handshake.

### Enforce the rule before transmission

Apply the payload restriction in Noq's frame scheduling and application
sendability accounting. Leave protocol control eligible, including the control
needed for direct-path discovery and recovery. Do not block the entire QUIC
Data packet-number space: it contains protocol control as well as payload.

Iroh supplies its existing path classification, rather than exposing its internal
address prefixes to Noq or AIT. Ip is payload-eligible; Relay, Mixed and Custom
are not. Mixed can fan initial packets across transports, so early payload must
also be excluded there. Cover 0-RTT, 0.5-RTT, retransmissions, loss probes,
incoming/outgoing connections, reconnects and migration. Queued application data
alone must not cause a relay transmission loop.

Expose one endpoint-level programmatic policy through Iroh and the Node builder.
The implementation may use a small synchronous eligibility hook in Noq's existing
TransportConfig; its exact signature is not part of this contract. The endpoint's
strict setting must survive per-connection transport-config overrides and builder
configuration ordering. Default upstream behavior remains unchanged when the
policy is not selected. Both endpoints of the experimental AIT build select the
policy. Configure only
the fixture-owned assistance relay through the existing programmatic network
construction path. No user-facing relay setting or production operator is added.
Retain private discovery and existing approval checks. Invitations may carry that
assistance address; a relay address is not approval and grants no peer access.

Before enabling assistance, opening peer listeners or starting stored-peer
connections, AIT must obtain confirmation from the constructed native endpoint
that strict payload policy is active. Expose a read-only endpoint query derived
from its effective native configuration, not a package version, JavaScript
constant or merely the presence of a setter. Missing query, false result or
query failure refuses peer-network startup with
`Private peer networking unavailable: this Iroh build cannot confirm direct-only application data.`
Close the newly constructed endpoint on refusal. Do not silently use stock
behavior or fall back to a weaker configuration. This verifies the supported
build/configuration contract, not the integrity of a malicious replacement
binary. Existing local-only AIT functions need not be disabled.

Do not change cryptographic primitives, protocol negotiation or the relay server.
Do not add a second scheduler, queue, retry mechanism or policy framework.

The guarantee controls supported endpoints' outbound payload. A malicious remote
can send its own bytes to a relay; receive-side rejection cannot undo that and
must not be presented as prevention. Relays still observe connection metadata
and permitted control traffic. This is not metadata secrecy.

### Tell applications and people what is usable

A QUIC handshake can succeed through assistance while no direct application path
exists. Therefore a connected native connection alone is not data readiness.
Use existing path snapshots/events and connection/stream outcomes to expose the
following distinctions in the Node consumer. These are observable meanings, not
a requirement for a new status enum, durable state or terminal framework.

| Observable condition | Application behavior | Intended AIT presentation |
| --- | --- | --- |
| Establishing a connection or awaiting a direct path | No successful application result yet | `Connecting directly…` |
| Direct path available and application round trip succeeds | Link can report success | `Linked` |
| Direct path becomes unusable while assistance remains | Sync is unavailable; queued streams use existing bounded flow control and fail on closure/cancellation | `Unavailable: direct connection lost; no relay fallback.` |
| Connection closes or the Link attempt deadline expires | Surface the error; stop waiting | `Unavailable: could not establish a direct connection.` |
| Peer is explicitly unlinked | End subscriptions and refuse further peer operations | Existing `Unlinked` behavior |

Path events provide the last known path condition, not instantaneous proof of
reachability. A silent network failure may first be detected by existing QUIC
failure detection or an operation deadline. Do not promise immediate loss
notification. A path snapshot is insufficient to declare Link complete: require
an application round trip over a permitted path. Subsequent readiness is still
subject to network failure.

The current peer code has no Link operation deadline. Relay control may prevent
QUIC idle expiry even while application data cannot move. Do not use idle expiry
as the user-facing bound. Add one **30-second deadline per Link attempt**, covering
native connection establishment, waiting for direct readiness and pairing round
trip together. On expiry, stop that attempt's waits/streams and close its owned
pairing connection; do not revoke a previously approved peer, erase received
records or leave background pairing work. Ctrl-C cancels the same owned work.
Report `Unavailable: could not establish a direct connection; no relay fallback.`
If approval completed before failure, disclose that it remains approved but is
Unavailable. Reuse existing approval data; do not add partial-state persistence.
The deadline is an explicit product bound, not a measured NAT success threshold.

Use one attempt deadline and existing path events, not a second recovery loop.
Selected IP path means usable according to the transport's last observation;
otherwise show Connecting during the attempt or Unavailable for an approved peer.
A round trip is still required to report initial Link success. Measure whether
relay control keeps the filtered connection alive beyond 30 seconds in the
fixture; either result must leave the attempt bounded.

For ongoing sync, no separate per-stream watchdog is introduced. Subscriptions
are inherently long-lived. Show Unavailable when path/connection events report
loss, preserve normal flow-control bounds, and let existing feed reconnection
handle closed streams. If path information remains stale during a silent loss,
status can lag until native detection; disclose and test that limitation. Never
promise every interrupted write fails within 30 seconds: that bound is for Link.
Do not add a status registry, durable flag or continuous reachability probe.

Stream write acceptance means queued locally, not delivered remotely. Require a
receiver acknowledgment/hash for the experiment's delivery result. In this experimental AIT build,
local posts can remain locally committed while peer sync is
unavailable; do not mislabel that as peer delivery. Preserve delay-only recovery:
an ambiguous result can replay, but must never advance a repository/notification
cursor past unprocessed records. This slice does not modify those cursors.

## Files touched

Ceiling: **18 authored files across four isolated checkouts**, including this
specification. Native build outputs are generated artifacts, not authored source.
Record exact base revisions and dependency pins in the executed proof output.
The isolated fixture installs the built binding into its own module tree. Do not
commit machine-specific dependency paths, alter installed node_modules or publish
a package to make the proof work. No AIT manifest changes are needed for this
isolated delivery; production distribution is a separate adoption decision.
Do not reuse the checkout containing documentation PR n0-computer/iroh-ffi#302.

| Checkout | File | Purpose |
| --- | --- | --- |
| Noq | `noq-proto/src/config/transport.rs` | Existing config carries payload eligibility |
| Noq | `noq-proto/src/connection/mod.rs` | Frame emission and sendability enforce it |
| Noq | `noq-proto/src/tests/multipath.rs` | Extend existing deterministic path tests |
| Iroh | `iroh/src/endpoint.rs` | Endpoint policy, effective-policy query, override precedence and inline tests |
| Iroh | `iroh/src/endpoint/quic.rs` | Wire existing path classification into QUIC config |
| Iroh | `Cargo.toml` | Exact fork dependency patch |
| Iroh | `Cargo.lock` | Reproducible native resolution |
| Iroh FFI | `iroh-js/src/endpoint.rs` | Node builder exposure and native endpoint policy query |
| Iroh FFI | `iroh-js/index.d.ts` | Matching generated declaration/documentation |
| Iroh FFI | `Cargo.toml` | Exact Iroh/Noq fork pins at workspace root |
| Iroh FFI | `Cargo.lock` | Reproducible binding resolution |
| AIT | `appview/src/server.ts` | Export the existing main entry for programmatic fixture options; preserve realpath-guarded run-appview.sh execution and assistance-off defaults |
| AIT | `appview/src/peerNetwork.mjs` | Confirm strict native policy before startup, allow fixture assistance, readiness/status, bounded pairing and cancellation |
| AIT | `appview/src/peerCli.mjs` | Connecting, success, failure and cancellation text through existing commands |
| AIT | `appview/scripts/peer-link-test.mjs` | Extend existing two-install public CLI and conversation journey |
| AIT | `docs/proofs/assisted-direct/proof.mjs` | Owned relay/proxies, status and transfer assertions |
| AIT | `docs/proofs/assisted-direct/worker.mjs` | Consume the locally built binding on both endpoints |
| AIT | `specs/direct-data-with-assisted-connections.md` | Contract and concise executed outcome |

This crosses three native implementation layers, so the general-systems check
applies. One eligibility decision composes with existing path/frame handling;
there must be no new lifecycle engine. Surface a required file substitution or
scope expansion with concrete source evidence before implementing it. Keep
authored changes separate from unrelated dependency refreshes.

## Out of scope

- Shipping a permanent fork, npm publication, signing/native release automation,
  public release, installed checkout changes or live service changes. Experimental
  AIT integration and its terminal UI are included; production adoption requires
  the reviewed result.
- Changing AT identities, handles, PLC/PDS/AppView semantics, repository formats,
  cursors, credentials, invitation secrets/consent or Link approval rules. Carrying
  the fixture assistance address is included; it does not change trust.
- Public discovery, a new relay service/protocol, choosing a production relay
  operator, or promising universal direct reachability.
- End-user networking flags, VPN setup, domains, a connectivity dashboard,
  persistent connection state, alternate transport or application retry layer.
  The single bounded Link attempt is explicitly included.
- A broad QUIC refactor, new cryptography, platform expansion, or adding this to
  the unrelated EndpointId documentation PR.

## Tests

All network tests use owned ephemeral loopback listeners, a local official relay
and controlled UDP proxies. Restrict endpoint and relay network access to the
fixture. Isolate homes, keys and logs; never read live AIT secrets or use live
ports 2582/2583/2585, databases, session sockets or stop scripts. Cleanup closes
owned resources and terminates only recorded fixture PIDs, including on failure.

Use source-level frame/path assertions in the existing native harness to prove
payload exclusion. Total relay counters are corroboration: protocol control can
legitimately increase them. Do not claim unchanged counters are necessary.

1. UDP blocked: establish authenticated QUIC via the owned relay with application
   writes already queued. Assert zero STREAM/DATAGRAM frames scheduled to Relay
   or Mixed, including early data. The Node consumer reports connecting, not
   Linked, and its application operation has not reported success.
2. Open UDP: wait on existing path events, complete a bidirectional application
   round trip, compare hashes, and report Linked. Exercise both endpoint roles,
   stream and datagram payloads. All emitted application frames use IP paths.
3. Cut UDP while a stream has queued/in-flight data. Relay control remains
   possible but carries zero application frames, including retransmits and loss
   probes. The consumer sees pending/unavailable followed by recovery or closure,
   never successful delivery of the unsent remainder. Separately keep UDP blocked
   for an entire Link attempt: it terminates after its single 30-second deadline
   even with relay control active. Test cancellation and cleanup at the same wait.
   Native deterministic tests exercise deadline logic without repeated wall waits;
   the real public CLI journey must include one actual bounded attempt.
4. Restore UDP while the native connection remains open: existing path recovery
   delivers queued stream bytes with the expected hash. Also exercise expiry and explicit
   reconnect with no duplicate-as-success or silent loss claim. Datagrams retain
   their normal unreliable semantics; do not promise datagram replay.
5. Exercise path migration and reconnect; endpoint policy survives a custom
   per-connection transport config and builder ordering. Test the default policy
   separately: normal relay fallback still works.
6. Revert the scheduling restriction while leaving the fixture unchanged. It must
   fail the frame/path assertion or reproduce the original post-cut payload
   delivery through the relay. Removing the sendability restriction must fail a
   deterministic native regression if it causes the predicted empty-packet/spin
   behavior; do not assert that prediction without observing it.
7. Check blocked-path saturation using existing flow-control bounds and the
   deterministic native harness: no new unbounded buffering or continuous
   application-driven transmission work.
8. Extend the existing isolated AIT journey: generate invitation with public
   `ait link`, approve on the second fixture installation, observe Connecting,
   complete pairing and report Linked only after the direct round trip. Post and
   reply using the real AIT write path and verify the peer's thread projection.
   Cut direct UDP, observe Unavailable after native detection, write locally and
   confirm it is not claimed as peer delivery. Restore connectivity and verify
   retained/backlogged records arrive using existing feed/cursor behavior, then
   unlink. Confirm both shells' status, no DNS discovery and no relay payload.
   Repeat the strict public Link/conversation/unlink journey in 20 fresh fixtures,
   with successful cleanup in every run. Run the dedicated deadline, cancellation,
   loss/recovery and refusal controls at least once; separately repeat the native
   forced-loss/reconnect journey 20 times, capturing worker exit resources.
   Report these denominators separately, rather than claiming every fault control
   was repeated 20 times.
9. Run the modified AIT peer subsystem with stock @number0/iroh 1.2.0. It must
   refuse startup/Link with the explicit policy error before listening for peers,
   dialing stored peers or exchanging application bytes. Repeat with the fork's
   policy disabled: its native query reports false and startup also refuses.
   The strict fork reports true; configuration overrides cannot change that
   guarantee. Verify refused endpoints and owned resources are closed. These
   assertions extend the existing peer-link fixture, not a new compatibility
   layer or package-name check.

Commands, to be implemented using these test-name prefixes/modes:

```sh
# Noq checkout: the new tests and inherited multipath behavior
cargo test -p noq-proto direct_application_data
cargo test -p noq-proto multipath
# Iroh checkout: configuration and endpoint-role integration
cargo test -p iroh direct_application_data
# FFI checkout: build the actual Node native module, not the installed binary
npm --prefix iroh-js run build
npm --prefix iroh-js test
# AIT checkout: explicit locally built binding and owned official relay paths
IROH_BINDING=/absolute/path/to/fork/iroh-js/index.js \
IROH_RELAY_BIN=/absolute/path/to/official/iroh-relay \
node docs/proofs/assisted-direct/proof.mjs strict
# Same fixture, default upstream behavior as positive fallback control
IROH_BINDING=/absolute/path/to/fork/iroh-js/index.js \
IROH_RELAY_BIN=/absolute/path/to/official/iroh-relay \
node docs/proofs/assisted-direct/proof.mjs control
# Experimental AIT worktree with the fork module installed in fixture scope
npm --prefix appview run build
IROH_RELAY_BIN=/absolute/path/to/official/iroh-relay \
IROH_STOCK_BINDING=/absolute/path/to/stock/iroh/index.js \
node appview/scripts/peer-link-test.mjs
# Repeat the actual public Link/conversation core without repeating every fault
IROH_RELAY_BIN=/absolute/path/to/official/iroh-relay \
node appview/scripts/peer-link-test.mjs --repeat-core
```

Pass means the native frame invariants and literal Node/AIT journeys above hold, the
default control succeeds, the mutation fails, and all owned resources are gone.
Record actual commands, native/tool versions, source revisions, repeat counts,
payload hashes and failure output. Do not substitute source greps for behavior.

## Sequencing or rollout

1. Independently review this spec for enforceability, simplicity and status
   semantics. Before native implementation, seek upstream guidance using the
   already-drafted `upstream-question.md`: an existing supported API could
   eliminate the fork. Posting to upstream requires Nate's explicit authorization;
   this spec does not authorize that message or any live adoption. If upstream
   has no suitable API or Nate chooses to proceed without waiting, use this bounded
   experimental implementation. Nate explicitly authorized building the experiment
   after spec GO; no upstream message has been posted. Do not make an unanswered
   message an idle loop.
2. First build Noq, Iroh and the Node binding and run the native/Node portions of
   tests 1-7, including frame/path exclusion, default/mutation controls, effective
   policy reporting and the relay-alive observation. Do not start edits to
   peerNetwork, peerCli or peer-link-test until those checks pass. The AIT-specific
   30-second deadline assertions in test 3 run after that gate with tests 8-9.
   If native enforcement fails, stop before AIT integration. Pin dependency
   resolution and use the same local module on both endpoints. Keep the existing
   live/private-peer build unchanged.
3. Run the Node and actual AIT journeys, negatives, repeats and relevant inherited
   tests. Send one concrete handoff to the collaborating reviewer with results and limits.
4. Decide whether to adopt, seek upstream inclusion or reject the patch. A passing
   loopback proof establishes enforcement under tested transitions, not real
   cross-internet NAT success. A later explicitly authorized two-Mac internet
   test must prove the same Link/status/transfer behavior before production.
   This spec delivers the working isolated experimental journey itself, not
   production deployment or a promise that NAT traversal succeeds everywhere.

## What was rejected

- `removeRelay` after direct selection: the independent counterexample shows
  application fallback remains possible.
- Waiting for a selected IP path before writing and then closing the relay path:
  current public Path APIs do not expose that close operation; connect-side gating
  omits accepted connections and later recovery. Dropping the coordination path
  also discards the assistance we want to retain. A supported upstream API with a
  proven hard bound should replace this fork if one exists.
- Closing when a watcher reports relay selection: detects a change after the
  scheduling decision and may allow payload to escape first.
- Dropping every QUIC Data-space packet on a relay: also blocks control needed
  for assistance and recovery.
- Endpoint restart choreography, new policy engines and retry
  timers: add lifecycle machinery without enforcing the packet invariant.
- Declaring a handshake or accepted write to mean Linked/delivered: gives the
  user a success signal while the only usable path may be a forbidden relay.
- Weakening the direct-data policy for seamless fallback: contradicts the user's
  explicit requirement.

## Sources

Inspected 2026-11-04. Paths are relative to the named upstream checkout/revision.

- [Noq 1.4.0 source](https://github.com/n0-computer/noq/blob/34f75c49f93de5e2ff943483cabc5b6d0c5df918/noq-proto/src/connection/mod.rs):
  `scheduling_info` :1174-1253, DATAGRAM :6525-6545, STREAM :6583-6592,
  `can_send_1rtt` :6977-7005. `spaces.rs:148-167,632-680` separates pending control.
- [Iroh v1.4.1 mapped addresses](https://github.com/n0-computer/iroh/blob/v1.4.1/iroh/src/socket/mapped_addrs.rs):84-125
  classifies Ip/Relay/Mixed/Custom and explains mixed initial destinations.
- [Iroh v1.4.1 endpoint](https://github.com/n0-computer/iroh/blob/v1.4.1/iroh/src/endpoint.rs):1146-1158,1805-1816
  selects the per-connection transport config over the endpoint default.
  `endpoint/quic.rs:130-165` carries the native config.
- Iroh FFI source 46ae9a2b632c4ad507abdf3c8e898726667cf79b:
  `iroh-js/src/endpoint.rs:24-140` builder mapping;
  `iroh-js/package.json` supplies the native build/test commands;
  root and JS Cargo manifests require Rust 1.91. No Rust build was executed for
  the original source audit. Use a separate fork checkout, not that documentation branch.
- AIT private-peer revision 80bf292278ef2bfe89b985baace2f992bc735db0:
  `appview/src/peerNetwork.mjs:23-37,179-186,241-270` rejects relay invitations,
  checks paths and reports any unclosed peer connection as Linked;
  `appview/src/peerCli.mjs:10-29,31-58` has no local-request deadline. A current
  `rg 'timeout|setTimeout'` over peerNetwork/peerCli/peerFeed at that base found none. The
  existing `appview/scripts/peer-link-test.mjs:158-176` drives public Link through
  a PTY. These are the concrete UI/deadline integration gaps included here.
  `server.ts:67-72` hard-codes network construction and the original main is
  unexported. The reviewer accepted the eighteenth-file amendment so the fixture
  can supply its relay without source rewriting or a new environment setting.
- Local experimental evidence:
  `/private/tmp/ait-relay-policy-20261104/findings.md`, `proof.mjs`, `worker.mjs`,
  `run-hEvUaW/result.json`, `run-dIBKch/result.json`, `run-cOeexh/result.json`.
  These are scratch evidence, not durable dependencies: preserve fixture source
  in the two listed AIT proof files and record the executed result in this spec.
- [Independent reproduction in AIT](at://did:plc:eunzexjghq6b4zx2y2oj7f57/ait.feed.post/3mzjh4haa2c2p):
  default control 1/1 pass; relay removal 2/2 policy counterexamples; cleanup clean.


Executed author evidence, 2026-11-04 (independent code verdict still pending):

- Build directory `/private/tmp/ait-assisted-direct-build-20261104`; macOS arm64,
  Node 25.7.0, task-local Rust 1.91.0, debug Node native module. No public package
  or live installation was changed.
- Native source commits: Noq `4bf2d57f26c2a6551056cc03102383b99567b507`,
  Iroh `15df5a58882d61ebdde30a49ca4b3bf6ca3f7bdc`,
  FFI `fdef2d5d125ebe34d31084b15f30c5c49fb0c9eb`.
  Their relative workspace patches resolve the frozen sibling checkouts;
  production package pins/publication remain excluded.
- Noq library tests: 449/449, including both new policy tests. Removing the two
  payload-eligibility decisions fails both focused tests; restoring them passes.
  Iroh policy tests: 2/2, including real relay-only connections with custom client
  and accept-side config overrides. FFI tests: 28/28 with loopback-only networking.
- Strict Node journey: 20/20 initial runs, plus the final resource-instrumented
  repeats reported in `node-resource-repeats.json`. Worker exit evidence includes
  effective endpoint closure and `process.getActiveResourcesInfo()`; stdio pipes
  are allowed, owned UDP/listener/timer resources are not. The default control
  succeeds by relaying payload after the UDP cut. Relay-only control stayed live
  beyond 30 seconds without delivering queued application payload.
- The real AIT assisted fault journey passes all nine reported outcomes, including
  the 30-second bound, Ctrl-C, loss/recovery, original record/thread agreement and
  both actual stock-binding and native-policy-off refusals. The direct-only
  inherited journey passes seven outcomes. Core assisted public Link/conversation
  repeats are recorded separately in `ait-final-repeats.json`; they do not repeat
  every timeout/negative case. The inherited AIT CLI suite passes.
- Recovery uses Iroh's existing 60-second upgrade interval; restoring the same
  route is not promised instantaneous. An early test's 20-second restoration
  window was too short and failed; that evidence is retained. Fixture setup
  failures and corrected notification/stock-module substitution controls are
  development runs, not passing policy evidence. Earlier fixture journals moved
  unchanged to `build-directory/evidence/`; their embedded original paths are
  historical locations.
- This establishes the tested local transport policy and AIT integration. It is
  not a cross-internet connectivity-rate result, optimized release-binary proof,
  production packaging validation or release authorization.
