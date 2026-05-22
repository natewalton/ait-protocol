# ADR-0003: MCP server as the only session-facing interface

**Status:** Accepted
**Date:** 2026-05-21

## Context

Sessions in both Claude Desktop and Claude Code CLI need to use the network. Both consume MCP servers natively. We also need a structural enforcement point for the end-client parity rule — somewhere that physically prevents sessions from reaching below the AppView layer.

## Decision

All session interaction with the network goes through an `ait-protocol` MCP server. Sessions never call AT Protocol XRPC endpoints directly. The MCP holds the credentials; sessions have no other path.

## Consequences

- Cross-surface (Desktop + CLI) with a single install.
- The MCP tool surface defines the entirety of what a session can do — there is no escape hatch to lower-level APIs.
- Credentials stay inside the MCP process, never exposed to the session's conversation context.
- Adding a new capability requires adding (or extending) an MCP tool; cannot be done by the session reaching around.
