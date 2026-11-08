# Recover Codex notifications without runaway retries

Status: Approved by independent spec/systems review, 2026-11-08; isolated implementation only. No live-operation approval.
Date: 2026-11-08
Tracker: https://github.com/natewalton/ait-protocol/issues/23
Baseline: source5703d80 / installed3d17fb5; their `mcp/src/codex` trees are identical.

## Why

A failed Codex notification injection schedules a retry, then immediately calls the same pump again. A bounded closed-client reproduction produced 1,000 retries and timers in10ms. Dropping the old sink reference on reconnect does not retire captured work. A synthetic late-completion callback after close retained one listener and overwrote a newer checkpoint with an old one; this is not evidence of a received post-close wire event. Verdict: fix.

The real driver also passes no deadline to socket/initialize startup. An owned server accepted initialize without replying: the driver remained alive with one request and no reconnect after6.5s; source shows no expiry. A first-resume draining response exits1 instead of retrying. Both defects predate the inspected Codex updates. Verdict: fix.

Both real0.166/0.167 binaries otherwise pass driver start/resume, permissions/model-switch/MCP-readiness and rollout tests. Existing recovery/sink/cursor/predicate suites pass but do not establish old-sink retirement or the production startup deadline. Notification delivery should recover through the same session without runaway resources, cursor loss or manual terminal restart. This value does not depend on the separate shell endpoint fix.

## The proposed work

Reuse the existing connection lifetime, retry delay and durable notification checkpoint.

- The same client's existing close event retires its sink: no new injection, cursor commit, completion callback or retry timer belongs to a closed connection. Clear pending requests/listeners at that boundary. Do not add an exported disposal supervisor or preserve a second in-memory backlog across reconnects.
- Make the existing retry delay effective while the connection is live. Remove the rejection fall-through which immediately re-pumps. On close, leave uncompleted deliveries in durable replay rather than repeatedly calling a dead client. Keep successful batching, steering and early-completion reconciliation.
- A cursor advances only when the live connection receives a matching successful completion for the notification-bearing turn. A retired sink cannot overwrite the replacement connection's cursor. Ambiguous completion may produce a duplicate after recovery; never permanently lose a notification or let old dedupe suppress replay.
- Use the existing connect deadline for socket/initialize startup and the existing reconnection loop after expiry. Reuse the current heartbeat for established-connection protocol checks. No second timer, liveness monitor or short total deadline on legitimate large-history thread loading/MCP initialization.
- Preserve JSON-RPC error data. Official0.166/0.167 `server_draining_error()` returns `code:-32600`, message `Server is draining; retry after reconnecting`, and `data:{reason:"serverShuttingDown"}`. Retry that code plus structured reason by closing/reconnecting and resuming the same thread. Do not retry all -32600 errors or match only English text. Missing/archived/corrupt thread errors retain actionable failure, and permissions/model-choice checks remain intact.
- The user sees the existing reconnect/progress messages for transient startup loss/draining, with the same thread/identity after recovery. Permanent errors still fail with their specific message. Notification display/body semantics and actor-presence expiry do not change. Exiting one driver ends its renewals and connection-local work without stopping the shared server or siblings.

## Files touched

Seven paths including this spec and the shared release-gate amendment:
1. `mcp/src/codex/appServerClient.ts`: error data, effective startup deadline and close-owned listeners.
2. `mcp/src/codex/host.ts`: existing startup/recovery paths and narrow shutdown handling.
3. `mcp/src/codex/sink.ts`: live retry backoff and close-owned retirement.
4. `mcp/scripts/codex-recovery-test.mjs`: actual driver startup, error classification and replay.
5. `mcp/scripts/codex-sink-test.mjs`: bounded failure, close and late-completion assertions.
6. `specs/codex-session-recovery.md`.
7. `.github/workflows/release.yml`: run the existing sink/recovery suites after the MCP build as part of the same prepare validation job.

The existing RpcResponse type already supports optional error data. Preserve the existing rollout, cursor and predicate suites as inherited checks; amend scope only if a concrete consumer gap needs another path.

## Out of scope

No shell startup, socket ownership, launchd, version floor, new CLI/flag, new supervisor/registry, persistent backlog, new heartbeat or shared-server restart. No transcript/rollout/map/identity rewriting, age-based retirement or process-name cleanup. No claim of exactly-once model execution across crashes. No live installed/source build or restart during implementation.

## Tests

In isolated temporary HOME/CODEX_HOME/XDG, run `npm --prefix mcp run build`, `node mcp/scripts/codex-sink-test.mjs`, `node mcp/scripts/codex-recovery-test.mjs`, plus the existing cursor/predicate/real-binary rollout tests. Do not repeat the unbounded memory probe.

The existing release prepare job must invoke the sink/recovery suites after building MCP. One-off local evidence is not a substitute for this required consumer. Keep current release identity/security gates and the publish path unchanged; do not add another approval or release stage.

1. Enter through the real production driver. An owned fake app-server accepts but never answers initialize: the existing bounded request timeout closes it and reconnects; a delayed valid handshake succeeds. The wrapper's long-history wait remains unchanged.
2. Deliver a notification through the driver's push HTTP listener, fail injection/connection, reconnect and replay from the persisted checkpoint, then complete the replacement turn. The model-visible notification and final cursor are the consumer assertions. Test accepted-but-uncompleted, failed/interrupted turn, unavailable sink, HTTP failure, transport close and exit. No model inference is required; fixture protocol completion is explicit.
3. A rejected injection has no immediate retry spin and retries only on the existing delay while live. Close during send/backoff: zero further injects/old commits, no retained retry timer or completion listener. Advance a replacement checkpoint then invoke a synthetic late old completion: it stays unchanged. Restore fall-through/remove retirement in a scratch mutation and assert failure.
4. Exact upstream draining code/data produces reconnect plus same-thread resume. Missing rollout, arbitrary -32600, archived/corrupt history and contract refusal do not become endless retry. If a notification-bearing turn fails during a rejected steer, the replacement batch preserves old-before-new order and cannot commit past the old notification, whether its first start is accepted or rejected. Preserve permission and model switches.
5. Repeat failure/recovery at bounded event-controlled boundaries: pending owned requests/listeners/timers return to baseline, durable checkpoint only advances for completed delivery, dedupe does not suppress replacement replay. Preserve per-session identity/thread-map/rollout artifacts. Separate real-binary tests still pass0.166 and0.167 start/resume/MCP readiness; they do not replace the HTTP-to-cursor journey.

## Sequencing or rollout

General-dev owns this isolated implementation; Skills-dev independently reviews; Developer integrates and coordinates release. Green spec review precedes implementation. Run targeted and integrated recovery tests plus inherited checks, obtain green independent code/systems review, then deliver through the normal release process. This spec can ship independently of the shell fix. Deployment verification uses an operator-approved upgrade with sessions closed; release publication alone is not an installed fix.

## What was rejected

- Keeping sink/recovery checks outside release validation: their existing scripts can run directly after the existing MCP build, so no additional release stage or review process is needed.
- Blanket -32600 retry or message-only matching: confuses permanent failures with upstream's structured transient response.
- A new exported sink supervisor, lifetime registry or second heartbeat: the existing client's close event and persisted checkpoint already provide the boundaries.
- Carrying old queues/dedupe across connections: retains failed work and competes with durable replay.
- An ever-shorter wrapper timeout or killing the shared server: can interrupt valid long histories and healthy siblings.
- Claiming a synthetic late-callback proof is an observed wire race or that passing old tests proves retirement: evidence must match the claim.

## Sources

Read at the stated baselines: `mcp/src/codex/host.ts:165,191-193,250-276`; `mcp/src/codex/sink.ts:92-109,164-190`; `mcp/src/codex/appServerClient.ts:89,124-127,314-337,401`; `mcp/src/codex/appServerTypes.ts:185-188`; `mcp/src/push.ts:86-129`; `mcp/src/server.ts:247-265`.

[Official0.166 error shape](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/error_code.rs) and [official0.167 shape](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server/src/error_code.rs), inspected locally and identical. Reproductions and limits: `/private/tmp/ait-codex-166-167-review/findings.md`, `audit-{sink-spin,host-stall,draining,late-completion}.{mjs,log}`, `results.json`, `rollout-{166,167}.log`. Initial draining fixture used a different data shape; implementation regression must use the actual `data.reason` above.
