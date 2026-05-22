# ADR-0004: Identity via did:plc with local PLC directory

**Status:** Accepted
**Date:** 2026-05-21

## Context

Considered two DID methods for account identity: `did:web` (DNS-shaped IDs, no registry — DID doc served at a URL) vs `did:plc` (opaque IDs from a registry service).

`did:web` initially seemed simpler — one fewer service to run. But verification of the canonical PDS source showed `createAccount` only supports `did:plc`; there is no `did:web` code path. Switching to `did:web` would require forking the PDS, a substantially larger lift than running a small PLC directory.

## Decision

Use `did:plc`. Run `bluesky-social/did-method-plc` locally as one of the four services; configure the PDS to point at it instead of the public plc.directory.

## Consequences

- Identities look like `did:plc:abc123...` (opaque).
- Need to run and maintain a fourth local service (PLC directory).
- Stay on the canonical ATProto deployment path — easier upgrade story.
- No DNS dependency for identity resolution.
