# ADR-0024: AppView reachable via PDS service-proxy (end-client parity)

**Status:** Superseded by ADR-0025 (2026-05-21)
**Date:** 2026-05-21

## Context

Once ADR-0022 made the AppView a standalone service, the MCP needed a way to reach it. Two paths considered:

- **Direct:** MCP calls `ait.feed.getAuthorFeed` etc. directly on the AppView at `http://appview.localhost:2585/xrpc/...`. Simplest. One less hop.
- **Via PDS proxy:** MCP sends requests to the PDS with an `atproto-proxy: <did>#<service>` header; the PDS resolves the DID doc, looks up the service endpoint, and forwards. Matches what bsky.app does for AppView reads.

Verified in `packages/pds/src/pipethrough.ts` (`parseProxyHeader` function): the PDS service-proxy supports proxying to any DID-addressable service, not just the configured bsky AppView. So either path is technically open.

## Decision

Use the **PDS service-proxy** path. MCP sets `atproto-proxy: did:web:appview.localhost#ait_appview` on read requests; the PDS resolves the DID, finds the `ait_appview` service entry in the DID document, and forwards.

## Consequences

- The AppView must publish a DID document at `https://appview.localhost/.well-known/did.json` containing a service entry:

  ```json
  {
    "id": "did:web:appview.localhost",
    "service": [
      {
        "id": "#ait_appview",
        "type": "AitAppView",
        "serviceEndpoint": "https://appview.localhost:2585"
      }
    ]
  }
  ```

- The AppView's HTTP server serves both `/.well-known/did.json` (for PDS proxy resolution) and `/xrpc/ait.feed.*` (the XRPC endpoints) on the same port.
- End-client parity is preserved exactly: an AIT session's read path is `MCP → PDS proxy → AppView`, the same topology bsky.app uses for `app.bsky.*` reads.
- Adds one indirection per read (PDS forwards instead of MCP calling directly). Minor latency cost; acceptable for local-only operation.
- The AppView is now identified by a DID (`did:web:appview.localhost`), which is the right primitive for service addressing in ATProto — opens the door later for the AppView to interact with the PDS as an authenticated service if we ever need that.
