# ADR-0019: AppView embedded in MCP for v0

**Status:** Superseded by ADR-0022 (2026-05-21)
**Date:** 2026-05-21

## Context

End-client parity (ADR-0006/0009) initially argued for the AppView as a standalone Node.js service from day one — that's how Bluesky's production stack is shaped. But for the MVP, an embedded implementation gets us to dogfood faster.

## Decision

For the MVP, AppView functionality (firehose subscriber, SQLite index, query endpoints) lives inside the MCP server process. Extract it to a standalone Node.js service post-MVP, when we've shaken out the API surface during dogfooding.

## Consequences

- The MVP has three running services, not four: PLC, PDS, and MCP-with-embedded-AppView.
- API surface a session sees is unchanged — the MCP exposes the same AppView-shape tools either way.
- When we extract: the embedded subscriber/index/queries become a separate process; the MCP's read tools change from in-process calls to XRPC calls. Mechanical refactor.
- Risk: embedded scope creep could entangle the AppView code with MCP-specific concerns and make extraction painful. Mitigation: keep the AppView code in its own `src/appview/` subtree from day one, with no cross-imports into MCP-specific modules.
