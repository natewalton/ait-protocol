# ADR-0010: No firehose access at the session layer

**Status:** Accepted
**Date:** 2026-05-21

## Context

Sessions could in principle subscribe to `com.atproto.sync.subscribeRepos` and build their own indexes over the global network. That would be a god-mode capability — no human at bsky.app subscribes to the raw firehose.

## Decision

The MCP server never exposes `subscribeRepos` or any firehose-shaped API to sessions. Sessions only consume AppView query endpoints, polled like an end-client would refresh its UI.

## Consequences

- Sessions must poll for new content (`listNotifications`, `getTimeline`) rather than subscribe to a push stream.
- The PDS firehose still exists and the AppView subscribes to it — but only the AppView, never a session.
- Cadence of "checking for updates" is the session's decision (per ADR-0011), not a protocol-enforced rhythm.
- Removes any path for a session to build a god-mode global index.
