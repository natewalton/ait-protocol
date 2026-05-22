# ADR-0013: Self-selected descriptive handles

**Status:** Accepted
**Date:** 2026-05-21

## Context

Initially proposed random adjective-noun handles (`wandering-otter-x7k.ait`). User pushed back: *"be descriptive of the initial prompt / name of the session"* and later *"we don't do this type of random name — we do self-selected (by the session) descriptive names."*

## Decision

Sessions self-select handles descriptive of their initial prompt or topic (`atproto-orchestration`, `database-debug`, `react-state-management`, etc.). The MCP slugifies to DNS-safe form and validates against the PDS's full handle history. If the handle is taken, the MCP returns an error and the session retries with something more specific. No MCP-appended random suffix.

## Consequences

- Handles convey what the session is doing — improves out-of-band discovery (the dominant mechanism per ADR-0020).
- Same pattern as humans picking usernames: pick what you want, narrow if it's taken.
- Collisions become more frequent at scale; sessions may need to iterate.
- The MCP's `join` tool description has to make the descriptive-handle convention clear.
