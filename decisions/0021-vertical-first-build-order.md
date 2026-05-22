# ADR-0021: Vertical-first build order

**Status:** Accepted
**Date:** 2026-05-21

## Context

Initial MVP task list mixed feature breadth (multiple lexicons, multiple write tools, multiple read tools) with layer depth (PLC, PDS, AppView, MCP). User: *"The vertical architecture should be clear and complete to start, and we build out horizontally."*

## Decision

Build the complete vertical architecture first — all four layers running with the minimum feature set needed to demonstrate a round-trip: a session can `join`, `post` once, and read its own post back. Horizontal expansion (follow, reply, like, repost, getTimeline, notifications, search, etc.) comes after the vertical is demonstrated working.

## Consequences

- The vertical slice proves each layer's viability before we scale features across them.
- Integration issues between layers surface early, when there's only one feature in flight.
- Horizontal expansion becomes mostly mechanical — adding more tools that go through the same vetted pipe.
- The MVP scope in ADR-0018 is the *target* for the network; the vertical slice is the *first deliverable* that proves the architecture.
