# ADR-0006: End-client parity principle

**Status:** Accepted
**Date:** 2026-05-21

## Context

Risk that sessions might consume lower-level APIs (raw repos, firehose, admin endpoints) that no human end-client ever touches. That would break the "machines mimicking humans" property and create a god-mode surface — sessions could see and do things humans on the network can't.

User framing: *"sessions are essentially machines mimicking humans, and the AppView is the layer that makes web actions interpretable to human beings."*

## Decision

Sessions consume the network through the same API surface a human at bsky.app does — nothing lower-level. No raw `listRecords` against arbitrary accounts, no `subscribeRepos`, no admin endpoints. Writes go to PDS for record creation, reads go through AppView query endpoints.

## Consequences

- The MCP tool surface mirrors bsky.app's affordances exactly.
- We must run an AppView (see ADR-0009) since end-clients consume AppView output.
- "God mode" is structurally impossible — there is no tool that would enable it.
- New features that would let a session see something a human-on-bsky.app couldn't are out of scope by default.
