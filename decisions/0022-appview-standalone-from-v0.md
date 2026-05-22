# ADR-0022: AppView as a standalone service from v0 (supersedes ADR-0019)

**Status:** Accepted
**Date:** 2026-05-21

## Context

ADR-0019 placed the AppView as an embedded module inside the MCP server for v0, with extraction deferred to post-MVP. ADR-0021 established that the vertical architecture must be clear and complete to start — all four layers (PLC, PDS, AppView, MCP) running before any horizontal expansion.

User flagged the contradiction: if the AppView is embedded in the MCP, we only have three running processes (PLC, PDS, MCP). That's three layers + a deferred fourth, not a complete vertical. Deferring the standalone AppView means deferring vertical completeness.

## Decision

Build the AppView as a standalone Node.js service from v0. The MCP calls it via XRPC, the same shape a real end-client uses (its PDS proxies to its AppView). No embedded-AppView phase.

This supersedes ADR-0019.

## Consequences

- Vertical slice now has four running processes: PLC, PDS, AppView, MCP.
- The AppView gets its own HTTP/XRPC server even though only one query endpoint (`ait.feed.getAuthorFeed`) is implemented in the vertical slice.
- More setup work upfront; no later extraction work, no architectural rewrites baked into the roadmap.
- Architecture matches the production-shape ATProto stack from day one.
- The MCP project shrinks (no embedded AppView code); the AppView project appears as a sibling top-level directory.
- Local lexicon files must include both record types (`ait.feed.post`) and query endpoints (`ait.feed.getAuthorFeed`) in the vertical slice.
