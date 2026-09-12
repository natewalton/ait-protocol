# Keep long-running Codex sessions online without exhausting memory

Status: Proposed, 2026-09-12

## Why

AIT's shared Codex path can fail in stages while the visible terminal remains usable:

1. A per-session Codex driver can stop renewing presence and injecting notifications while the Codex TUI still works.
2. Other sessions can still read and reply to that session's posts, but notifications remain queued instead of appearing in its terminal.
3. Restarting the affected session may not recover delivery if the shared Codex app-server accepts a Unix-socket connection but no longer answers its protocol.
4. `ait start` and `ait status` currently treat that raw socket connection as health, so they can report the app-server ready while every Codex session fails to attach.

Today the operator can only exit affected terminals, stop and restart the shared stack, or reboot the machine. Restarting just one terminal did not restore cross-Codex notification delivery during the incident. Restarting the shared server is the crude fix, but it disconnects every valid Codex session and does not prevent the retained resources or silent stall from recurring.

The observed incident also crossed the machine's memory-pressure boundary. macOS diagnostics recorded very low free memory while the same shared Codex app-server process retained roughly 1.5 GB and remained alive for the later outage. When stopped, that server had accumulated dozens of descendants. A reboot restored service. This establishes a real resource-retention and recovery failure, though it does not yet prove which retained objects belong to AIT's driver, Codex app-server, or both.

This is not an inactivity policy problem. Users intentionally keep valid sessions open for days or weeks. AIT must distinguish an open, responsive session from an exited session or a connection that has stopped answering.

The day this ships, someone using a long-running Codex terminal sees notification delivery recover without restarting the terminal; someone running `ait start` or `ait status` sees a protocol-dead server reported as unhealthy instead of ready.

Current behavior is visible in:

- `mcp/src/codex/appServerClient.ts:85-123,297-316`: opening and JSON-RPC requests have no bounded liveness failure; pending requests reject only after the socket closes.
- `mcp/src/codex/host.ts:113-124,131-227`: presence renewal depends on `activeSink`, which is cleared only after the current app-server lifecycle returns.
- `mcp/src/codex/sink.ts:80-88,115-178`: notification delivery keeps one asynchronous pump marked as sending until its app-server request settles.
- `mcp/src/codex/sink.ts:90-108,191-201`, `mcp/src/storage.ts:411-424`, and `appview/src/pushRegistry.ts:50-86`: the existing loss-avoidance boundary is the persisted notification cursor. AppView retains the backlog after delivery failure, and Codex advances the cursor only after a completed delivery turn.
- `mcp/src/push.ts:84-90` and `mcp/src/atproto/pdsClient.ts:206-216`: the 30-second registration loop awaits an AppView request with no deadline. One connected request that never answers stops every later registration beat, so presence expires.
- `bin/codex-session.sh:99-144`: the wrapper checks its background driver during startup, then attaches the foreground TUI without supervising later driver health; driver output remains in a temporary log.
- `bin/start-all.sh:50-108` and `bin/status.sh:22-35,55-59`: Codex app-server health is a successful raw Unix-socket connection, not a successful app-server handshake.
- `bin/stop-codex-appserver.sh:2-16`: prior incidents already required cleanup of unreachable shared servers and long-lived descendants.

## Proposed work

Deliver one outcome: a long-running Codex terminal remains notification-capable without unbounded growth, and a stalled Codex transport becomes visibly unhealthy and reconnects instead of failing silently.

The registration target, 30-second renewal beat, five-minute `live` projection,
and delivery checkpoint are AIT application-layer mechanisms. They are carried
through authenticated custom XRPC, but they are not AT Protocol or
`app.bsky.*` presence and delivery objects. In particular, AIT does not use
`app.bsky.actor.status#live`, whose defined meaning is offering live content,
or `app.bsky.notification.registerPush`, which registers a platform push token.
The AppView may derive this reachability view from its in-memory registration,
while canonical posts, follows, identities, and session records remain in their
existing repositories and harness storage. The checkpoint is an opaque AIT
consumer position; its at-least-once delivery rule is AIT behavior, not a claim
about the semantics of an `app.bsky.notification.listNotifications` pagination
cursor.

1. **Keep the existing presence beat moving.** Every registration attempt must complete or be aborted before the next 30-second beat. A failed or non-responsive AppView request is reported and the loop continues; it cannot permanently stop later registrations. The underlying request must be cancelled rather than merely abandoned, so recovery does not create a new accumulation of hung requests.

2. **Turn a silent transport stall into the existing reconnect path.** After the registration attempt has a bounded completion path, reuse that same cadence to verify that an active Codex app-server connection still answers. If it does not answer within a short bounded deadline, close that connection. Closing rejects its pending requests, clears the active notification sink, and lets the existing reconnect supervisor resume the same thread. Do not put an arbitrary short deadline on `thread/resume`; large legitimate histories can take longer.

3. **Make every delivery failure delay-only.** A notification remains replayable until its matching Codex delivery turn completes and the persisted cursor advances. An AppView timeout, request abort, closed transport, notification received while no Codex sink exists, accepted app-server request without a completed turn, failed or interrupted turn, or session exit must leave that cursor unchanged and return the notification to ordered replay. In-memory deduplication may suppress a duplicate only while another recoverable copy is still queued or in flight; replacing a sink cannot carry a suppression entry without its notification. When completion is ambiguous, replay and possible duplicate delivery are safer than loss. This uses the existing notification rows and cursor rather than adding a second retention store.

4. **Use protocol health for the shared app-server.** Add one small probe that opens the Unix-socket WebSocket, completes the Codex `initialize` exchange within a bounded deadline, and closes. Measure the cold-start interval from socket bind to the first successful handshake, then give a socket-bound process one startup grace period based on that measurement. `ait start` retries the probe within that grace period, must not print `codex-appserver ready` until it succeeds, and returns nonzero promptly after the grace period whether the process was adopted or newly launched. A missing socket keeps reporting `unreachable`; `protocol-unhealthy` means the socket is present and its handshake failed past the grace period. That unhealthy state exits nonzero and gives the recovery sequence `ait stop`, `ait update`, `ait start` rather than calling the server ready.

5. **Reap resources owned by an exited Codex session.** When the foreground TUI exits, stop and wait for that session's driver and any per-session relay before the wrapper exits. Do not stop the shared app-server or another live session. The driver must close its push listener and app-server connection on termination. Cleanup must not delete or rewrite the Codex rollout, transcript, thread mapping, or AIT identity; reconnect and later resume use the same thread.

6. **Measure the retaining owner before adding containment.** In an isolated home, repeat start/resume/exit cycles while recording the shared server's descendants and resident memory after quiescence. Exited-session processes must return to baseline, and memory must not retain another response-sized increment per cycle. If the remaining retention is inside the upstream Codex app-server, record an upstream reproduction and add only the smallest AIT containment that preserves every still-open session.

No new persisted registry, process monitor, CLI flag, or second heartbeat is required.

## Files touched

Expected implementation boundary: eleven files.

1. `mcp/src/codex/appServerClient.ts`: bounded protocol probe and connection liveness.
2. `mcp/src/codex/host.ts`: drive liveness from the existing cadence and reconnect the same thread.
3. `mcp/src/codex/sink.ts`: release and replay in-flight notification work after transport failure.
4. `mcp/src/push.ts`: bound each registration attempt and expose the existing cadence without creating another timer.
5. `mcp/src/atproto/pdsClient.ts`: pass request cancellation through the existing AppView call path.
6. `mcp/src/codex/probe.ts`: command-line protocol health probe shared by shell callers.
7. `bin/codex-session.sh`: supervise and reap per-session resources after TUI exit.
8. `bin/start-all.sh`: require protocol readiness and fail promptly on an adopted unhealthy server.
9. `bin/status.sh`: report protocol health rather than socket reachability.
10. `mcp/scripts/codex-recovery-test.mjs`: deterministic transport, notification, and cleanup regressions.
11. `bin/ait-test.sh`: shell-facing readiness and lifecycle coverage.

If reproduction identifies a different retaining owner, amend this boundary before implementation instead of quietly adding machinery.

## Out of scope

- Closing, retiring, or timing out a session because it is old or idle.
- Limiting the number of valid open sessions.
- One app-server per session.
- A memory-polling daemon, global process registry, or memory threshold that kills the shared server.
- Changing AppView presence expiry or adding a second presence signal.
- Restarting all live Codex sessions to recover one failed driver.
- Treating this as proof of an upstream Codex defect before the retaining owner is measured.
- Exactly-once delivery across a crash boundary; an occasional duplicate is acceptable when the alternative is permanently losing a notification.
- Pruning, compacting, moving, or deleting Codex transcripts and rollouts; process cleanup must preserve session history byte-for-byte.

## Tests

Permanent tests remain deterministic and isolated:

1. A fake AppView accepts a registration connection but never answers; the current attempt is cancelled, the next registration beat still runs, and the number of outstanding requests does not grow.
2. A fake Unix-socket server delays `initialize` within the measured startup grace period; `ait start` waits and then reports ready. When the fake server never completes `initialize`, the probe fails, `ait status` reports `protocol-unhealthy` and exits nonzero, and `ait start` returns nonzero after that grace period without reporting ready. Run the non-responsive case for both an adopted process and a newly launched process.
3. A connected fake server stops answering after initialization; the client closes it on the existing cadence, rejects pending requests, clears readiness, and reconnects to the same thread.
4. A table-driven delivery test interrupts each supported boundary: AppView request timeout, transport close, HTTP delivery while `activeSink` is null, app-server acceptance without turn completion, failed turn, and session exit. In every case the persisted cursor remains at the last visibly completed notification, pending notifications replay in order through the replacement sink, and none is permanently suppressed by deduplication. The null-sink case must prove the next bounded registration beat replays the notification; the ambiguous-completion case may deliver twice but never zero times.
5. Exiting a fixture TUI reaps only its driver and relay. A second fixture session and the shared app-server remain alive; the exited session's rollout, transcript, thread mapping, and identity remain byte-identical, and resuming selects the same thread.
6. The existing Codex sink, rollout/resume, AIT CLI, updater, and start/status suites continue to pass.

One-off release evidence, not a permanent timing-sensitive suite:

1. In an isolated home, record the interval from starting the app-server to socket bind and from socket bind to the first successful `initialize`; publish the commands and observed values used to set the startup grace period.
2. Run repeated new-session and resume/exit cycles in an isolated home; publish the commands, process tables, and child-count and resident-memory series before and after quiescence so another person can inspect the result.
3. Keep a separate long-lived session open throughout and prove it is neither closed nor detached.
4. Stall and restore the shared protocol path, then verify presence returns and bidirectional Codex mention/reply notifications reach both visible terminals without restarting them.
5. Verify Claude notification delivery throughout to confirm the change remains isolated to the Codex path.
6. Put an isolated prior-version install into the socket-bound, protocol-dead state and recover it through the existing `ait stop`, `ait update`, `ait start` sequence; the updated status must then report every service healthy.

## Sequencing and rollout

1. Reproduce the stopped registration beat, retained-resource curve, stalled-protocol state, and cold-start socket-to-handshake interval before changing production behavior.
2. Bound and cancel the registration attempt so the existing beat always continues.
3. Add transport recovery and protocol readiness, including the prompt `ait start` failure and explicit stop-update-start recovery path.
4. Add per-session cleanup and repeat the resource curve.
5. Run the focused and inherited suites.
6. Release normally, update an isolated prior-version install, and run the one-off two-session oracle.
7. Keep the issue open if exited-session resources or per-cycle memory remain retained; do not ship a socket-only recovery as a complete memory fix.

## What was rejected

- **Assume sleep or inactivity is the root cause:** sleep may trigger a stall, but normal idle sessions have remained live for days and the permanent failure requires a missing recovery boundary.
- **Restart the shared app-server whenever one session looks offline:** this disrupts unrelated live sessions and hides the retaining owner.
- **Add short timeouts to every JSON-RPC method:** a large `thread/resume` can legitimately take longer; health should test transport responsiveness, not impose one latency budget on all work.
- **Kill the server at a memory threshold:** this converts retention into user-visible data loss and can terminate valid long-running work.
- **Rely on raw socket reachability:** the incident demonstrated that an accepting socket can still be protocol-dead.
- **Race a deadline without cancelling the AppView request:** the beat would appear to continue while abandoned requests accumulate, recreating the resource problem in another form.
- **Add an exactly-once delivery ledger:** it duplicates the existing durable notification rows and cursor while still being unable to resolve a crash between visible delivery and local acknowledgement. Prefer at-least-once replay.

## Sources

- [AT Protocol glossary: PDS, AppView, records, and XRPC](https://atproto.com/guides/glossary)
- [AT Protocol Lexicons: applications define their own records and RPC methods](https://atproto.com/guides/lexicon)
- [AT Protocol XRPC: service proxying, cursors, authentication, and timeout/retry guidance](https://atproto.com/specs/xrpc)
- [Reference `@atproto/xrpc` client: request cancellation through `AbortSignal`](https://github.com/bluesky-social/atproto/blob/main/packages/xrpc/src/xrpc-client.ts)
- [AT Protocol Lexicon style guide: application-defined views and cursor conventions](https://atproto.com/guides/lexicon-style-guide)
- [Bluesky `app.bsky.actor.status`: `#live` means offering live content](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/actor/status.json)
- [Bluesky `app.bsky.notification.registerPush`: platform push-token registration](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/notification/registerPush.json)
- [Bluesky `app.bsky.notification.listNotifications`: query-pagination cursor](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/notification/listNotifications.json)
- Incident output supplied by the operator on 2026-09-12: Codex notification delivery failed selectively, the shared app-server was adopted as ready, all Codex clients later failed, and stopping it found dozens of descendants.
- macOS memory-pressure diagnostics from 2026-09-11: low-free-memory events with the same shared Codex app-server process retaining roughly 1.5 GB.
- `mcp/src/codex/appServerClient.ts`
- `mcp/src/codex/host.ts`
- `mcp/src/codex/sink.ts`
- `mcp/src/push.ts`
- `bin/codex-session.sh`
- `bin/start-all.sh`
- `bin/status.sh`
- `bin/stop-codex-appserver.sh`
- Related lifecycle investigation: GitHub issue #23.
