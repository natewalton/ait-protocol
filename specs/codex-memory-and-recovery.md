# Keep long-running Codex sessions online without exhausting memory

Status: Proposed — 2026-09-12

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
- `bin/codex-session.sh:99-144`: the wrapper checks its background driver during startup, then attaches the foreground TUI without supervising later driver health; driver output remains in a temporary log.
- `bin/start-all.sh:50-108` and `bin/status.sh:22-35,55-59`: Codex app-server health is a successful raw Unix-socket connection, not a successful app-server handshake.
- `bin/stop-codex-appserver.sh:2-16`: prior incidents already required cleanup of unreachable shared servers and long-lived descendants.

## Proposed work

Deliver one outcome: a long-running Codex terminal remains notification-capable without unbounded growth, and a stalled Codex transport becomes visibly unhealthy and reconnects instead of failing silently.

1. **Use protocol health for the shared app-server.** Add one small probe that opens the Unix-socket WebSocket, completes the Codex `initialize` exchange within a bounded deadline, and closes. `ait start` must not print `codex-appserver ready` until this succeeds. `ait status` must report a protocol-unhealthy server separately from a missing socket.

2. **Turn a silent transport stall into the existing reconnect path.** Reuse the existing 30-second registration cadence to verify that an active Codex app-server connection still answers. If it does not answer within a short bounded deadline, close that connection. Closing rejects its pending requests, clears the active notification sink, and lets the existing reconnect supervisor resume the same thread. Do not put an arbitrary short deadline on `thread/resume`; large legitimate histories can take longer.

3. **Make notification retry state releasable.** When the client closes, an in-flight sink request must reject, return its batch to the queue, and release the `sending` state. Re-registration after reconnect then replays from the committed cursor. The AppView must not advance a cursor merely because it accepted the HTTP delivery.

4. **Reap resources owned by an exited Codex session.** When the foreground TUI exits, stop and wait for that session's driver and any per-session relay before the wrapper exits. Do not stop the shared app-server or another live session. The driver must close its push listener and app-server connection on termination.

5. **Measure the retaining owner before adding containment.** In an isolated home, repeat start/resume/exit cycles while recording the shared server's descendants and resident memory after quiescence. Exited-session processes must return to baseline, and memory must not retain another response-sized increment per cycle. If the remaining retention is inside the upstream Codex app-server, record an upstream reproduction and add only the smallest AIT containment that preserves every still-open session.

No new persisted registry, process monitor, CLI flag, or second heartbeat is required.

## Files touched

Expected implementation boundary: ten files.

1. `mcp/src/codex/appServerClient.ts` — bounded protocol probe and connection liveness.
2. `mcp/src/codex/host.ts` — drive liveness from the existing cadence and reconnect the same thread.
3. `mcp/src/codex/sink.ts` — release and replay in-flight notification work after transport failure.
4. `mcp/src/push.ts` — expose the existing cadence without creating another timer.
5. `mcp/src/codex/probe.ts` — command-line protocol health probe shared by shell callers.
6. `bin/codex-session.sh` — supervise and reap per-session resources after TUI exit.
7. `bin/start-all.sh` — require protocol readiness before reporting ready.
8. `bin/status.sh` — report protocol health rather than socket reachability.
9. `mcp/scripts/codex-recovery-test.mjs` — deterministic transport, notification, and cleanup regressions.
10. `bin/ait-test.sh` — shell-facing readiness and lifecycle coverage.

If reproduction identifies a different retaining owner, amend this boundary before implementation instead of quietly adding machinery.

## Out of scope

- Closing, retiring, or timing out a session because it is old or idle.
- Limiting the number of valid open sessions.
- One app-server per session.
- A memory-polling daemon, global process registry, or memory threshold that kills the shared server.
- Changing AppView presence expiry or adding a second presence signal.
- Restarting all live Codex sessions to recover one failed driver.
- Treating this as proof of an upstream Codex defect before the retaining owner is measured.

## Tests

Permanent tests remain deterministic and isolated:

1. A fake Unix-socket server accepts connections but never completes `initialize`; the protocol probe fails, `ait status` reports protocol-unhealthy, and `ait start` never reports ready.
2. A connected fake server stops answering after initialization; the client closes it on the existing cadence, rejects pending requests, clears readiness, and reconnects to the same thread.
3. A notification is accepted while its app-server request is stalled; after reconnect it is retried exactly from the last committed cursor and reaches the replacement sink.
4. Exiting a fixture TUI reaps only its driver and relay. A second fixture session and the shared app-server remain alive.
5. The existing Codex sink, rollout/resume, AIT CLI, and start/status suites continue to pass.

One-off release evidence, not a permanent timing-sensitive suite:

1. Run repeated new-session and resume/exit cycles in an isolated home; publish the commands, process tables, and child-count and resident-memory series before and after quiescence so another person can inspect the result.
2. Keep a separate long-lived session open throughout and prove it is neither closed nor detached.
3. Stall and restore the shared protocol path, then verify presence returns and bidirectional Codex mention/reply notifications reach both visible terminals without restarting them.
4. Verify Claude notification delivery throughout to confirm the change remains isolated to the Codex path.

## Sequencing and rollout

1. Reproduce the retained-resource curve and stalled-protocol state with fixtures before changing production behavior.
2. Add protocol readiness and transport recovery.
3. Add per-session cleanup and repeat the resource curve.
4. Run the focused and inherited suites.
5. Release normally, update an isolated prior-version install, and run the one-off two-session oracle.
6. Keep the issue open if exited-session resources or per-cycle memory remain retained; do not ship a socket-only recovery as a complete memory fix.

## What was rejected

- **Assume sleep or inactivity is the root cause:** sleep may trigger a stall, but normal idle sessions have remained live for days and the permanent failure requires a missing recovery boundary.
- **Restart the shared app-server whenever one session looks offline:** this disrupts unrelated live sessions and hides the retaining owner.
- **Add short timeouts to every JSON-RPC method:** a large `thread/resume` can legitimately take longer; health should test transport responsiveness, not impose one latency budget on all work.
- **Kill the server at a memory threshold:** this converts retention into user-visible data loss and can terminate valid long-running work.
- **Rely on raw socket reachability:** the incident demonstrated that an accepting socket can still be protocol-dead.

## Sources

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
