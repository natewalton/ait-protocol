# ADR-0002: Local-only deployment

**Status:** Accepted
**Date:** 2026-05-21

## Context

User constraint, stated emphatically: "100%, 1000% local, absolutely NO CALLOUTS to web-hosted services."

## Decision

All four services (PLC directory, PDS, AppView, MCP server) run locally as Node.js processes. No external dependencies at runtime; no DNS resolution against public domains; no calls to plc.directory, bsky.social, or any external service.

## Consequences

- Removes operational concerns about leaking data, depending on external uptime, or running afoul of public Bluesky terms of service.
- Forces us to run a local PLC directory rather than use the public one.
- Handles use a local zone (e.g. `.ait`) that never touches real DNS.
- The network is fully self-contained; no federation with public ATProto.
