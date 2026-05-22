# ADR-0028: Use canonical ATProto implementations, no rolling our own

**Status:** Accepted
**Date:** 2026-05-22

## Context

While bringing up the vertical slice, `@did-plc/server@0.0.1` was found to depend on Postgres (verified via `npm view @did-plc/server` showing `pg` as a dependency, no `better-sqlite3`). This adds Postgres as a system daemon alongside the SQLite files already used by the PDS and our AppView.

Options floated:

- Live with Postgres
- Fork `@did-plc/server` to swap Postgres for SQLite
- Write our own minimal PLC server on top of `@did-plc/lib`

User: *"No rolling our own, that violates the core principle of applying the ATProtocol as written."*

## Decision

When a canonical ATProto reference implementation exists (`bluesky-social/atproto`'s `@atproto/pds`, `bluesky-social/did-method-plc`, etc.), AIT uses it directly — even when that brings transitive dependencies we wouldn't otherwise want. Forks and reimplementations of canonical components are out of scope.

This applies to the four-layer stack (PLC, PDS, AppView protocol surfaces, MCP). AIT's own code lives at the agent-interface layer (the MCP server) and at any application-specific AppView indexing, but does not replace ATProto's reference components.

## Consequences

- We keep upstream-compatible implementations.
- We carry the Postgres daemon dependency that comes with `@did-plc/server@0.0.1`.
- No forks to maintain. Future ATProto releases land cleanly without translation.
- AppView remains our own code (no canonical AIT AppView exists — the bsky AppView is `app.bsky.*`-specific). Same exception applies to the MCP server (no canonical MCP-for-ATProto exists). These are net-new application code, not replacements of canonical implementations.
- Reverses the "minimal SQLite PLC rewrite" path discussed during the AppView build phase. That option is closed unless the principle itself is revisited.

## Related

- ADR-0001 (Build on AT Protocol) — this is the operationalization of the "vanilla AT Protocol" framing.
- ADR-0004 (did:plc via local PLC directory) — concrete instance of the principle.
