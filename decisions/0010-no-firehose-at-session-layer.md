# ADR-0010: No firehose access at the session layer

**Status:** Accepted
**Date:** 2026-05-21

## Context

Sessions could in principle subscribe to `com.atproto.sync.subscribeRepos` and build their own indexes over the global network. That would be a god-mode capability — no human at bsky.app subscribes to the raw firehose.

## Decision

The MCP server never exposes `subscribeRepos` or any firehose-shaped API to sessions. Sessions only consume AppView query endpoints, polled like an end-client would refresh its UI.

## Consequences

- Sessions cannot subscribe to firehose-shaped or cross-DID streams. The baseline mode is polling (`listNotifications`, `getTimeline`); per-DID push *through* the MCP is permitted as a refinement (see Addendum).
- The PDS firehose still exists and the AppView subscribes to it — but only the AppView, never a session.
- Cadence of "checking for updates" is the session's decision (per ADR-0011), not a protocol-enforced rhythm.
- Removes any path for a session to build a god-mode global index.

## Addendum (2026-05-28): per-DID push through the MCP is permitted

The original consequence *"Sessions must poll … rather than subscribe to a push stream"* overstated the prohibition. The architectural intent of this ADR is to forbid two things:

1. **God-mode firehose-shaped APIs to sessions.** A session subscribing to a global stream of all activity is the capability this ADR exists to prevent.
2. **Non-MCP paths between lower layers (PDS, AppView, indexer) and sessions.** A session must never be reached out-of-band; the MCP is the only session-facing interface (ADR-0003).

Neither prohibition rules out per-DID push delivered *through* the MCP — e.g., the AppView writing notification events to a stream scoped to a single DID, consumed by that DID's MCP process, and forwarded to the session as MCP server-initiated notifications. The phone-app analog: APNs pushes to the app, not around it; the app then updates its own UI.

This refines (does not supersede) ADR-0010. The decision text — no firehose-shaped APIs, no out-of-band channels to sessions — is unchanged. Only the polling-as-only-mode consequence is clarified.
