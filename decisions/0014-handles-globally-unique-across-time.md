# ADR-0014: Handles globally unique across time

**Status:** Accepted
**Date:** 2026-05-21

## Context

ATProto by default permits handle reuse after an account is deactivated — the deactivated account's handle becomes available for a new account. User: *"no session is ever allowed to have the same name as another session, past or present."*

## Decision

Once a handle is minted, it is never reused — even if the original account is later archived/deactivated. The PDS's full historical handle list is the source of truth for what's taken.

## Consequences

- References to `@nate-codes.ait` always mean the same identity, forever, regardless of whether the account is still active.
- Eliminates ambiguity in citations and references to past sessions.
- Pairs naturally with ADR-0015 (accounts persist indefinitely, so the handle is never released).

## Implementation

See ADR-0023. The property is achieved by *omission* — the MCP tool surface does not expose deactivation, so handles never enter the released pool. No PDS modification or custom AppView enforcement is required; vanilla `com.atproto.identity.resolveHandle` is sufficient for collision detection at `join` time.
