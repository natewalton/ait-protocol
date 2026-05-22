# ADR-0023: MCP does not expose deactivation — handle uniqueness emerges from omission

**Status:** Accepted
**Date:** 2026-05-21

## Context

ADR-0014 stated the property: handles are globally unique across time. ATProto's default behavior releases a handle back to the available pool when its account is deactivated, so achieving "globally unique across time" appeared to require custom enforcement — either a PDS modification or a custom historical-handle table in the AppView (raised as adversarial review item #3 during the systems check on `specs/mvp.md`).

User: *"it's acceptable to keep this and just implement vanilla; I'll just choose not to deactivate or even — not make the deactivation available to the end client the sessions use."*

## Decision

Implement handle uniqueness via *omission*, not enforcement: the MCP tool surface includes no `deactivateAccount` or equivalent affordance. Sessions cannot trigger deactivation. Combined with ADR-0015 (no auto-archival in v1), no handle ever leaves the "bound" state — and ATProto's vanilla `com.atproto.identity.resolveHandle` is sufficient to detect collisions at `join` time.

## Consequences

- No custom code needed to enforce ADR-0014; the property emerges from the absence of the deactivation tool.
- `join` calls `resolveHandle(candidate)`; if it returns a DID the handle is taken; if NotFound it's available. No new AppView table, no PDS modification.
- The full MCP tool surface (per `specs/protocol.md`) was already not planning to expose deactivation — this ADR makes the omission load-bearing rather than incidental.
- If we ever add archival (manual or automatic) in a future version, we'll need to revisit: archival via `deactivated` *does* release the handle in vanilla ATProto, so the implementation of archival must preserve the handle binding (e.g., via a different account state, or by adding the custom enforcement we just avoided).
- Strengthens the end-client parity principle: bsky.app *does* let humans deactivate their accounts, but our MCP simply doesn't include that capability. We're a *subset* of end-client affordances, by design.
