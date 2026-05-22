# ADR-0025: AppView identity via did:plc, routed through PDS's bskyAppView slot (supersedes ADR-0024)

**Status:** Accepted
**Date:** 2026-05-21

## Context

ADR-0024 proposed identifying the AppView as `did:web:appview.localhost` and resolving it via DID document fetch. Verification of `@atproto/identity`'s did:web resolver showed the HTTP-on-localhost override only matches the exact hostname `localhost`, not `*.localhost` — meaning `did:web:appview.localhost` would attempt HTTPS and fail without a cert.

Investigation of the official atproto local-dev path (`packages/dev-env/src/network.ts` and `bluesky-social/pds/service/index.js`) revealed:

- The bsky AppView in dev-env uses a deterministic-key-derived DID (matches did:plc registered via local PLC), not did:web.
- `dev-env` uses HTTP for all inter-service URLs.
- The PDS routes AppView calls via its `bskyAppView` config slot — a special-case fast path in `pipethrough.ts` that fires when the proxy header matches `<bskyAppView.did>#bsky_appview`. No DID document fetch on this path.
- The official `bluesky-social/pds` deployment repo's startup is plain Node.js (`PDS.create(cfg, secrets); pds.start()`) — Docker is packaging, not a runtime requirement.

## Decision

Identify the AppView with a **did:plc** registered via our local PLC directory on AppView startup (deterministic from a static private key stored in the AppView's env, so the DID is stable across restarts).

Configure the PDS with our AppView in its `bskyAppView` slot:

- `PDS_BSKY_APP_VIEW_URL=http://localhost:2585`
- `PDS_BSKY_APP_VIEW_DID=did:plc:<our-appview-plc-did>`

The MCP sends `atproto-proxy: did:plc:<our-appview-plc-did>#bsky_appview` on read requests; PDS's special-case fast path forwards directly to the configured URL with no DID resolution round-trip.

This supersedes ADR-0024.

## Consequences

- HTTP throughout the local stack — no TLS, no certs.
- Our AppView occupies the PDS's "bsky AppView" slot from the PDS's perspective. Practical effect: any `app.bsky.*` query (we don't serve those) would be forwarded to us and return empty/404. That's acceptable for a network with only `ait.*` records.
- The AppView code needs a small bootstrap step on startup: register its DID with the local PLC if not already registered, then load credentials and start serving.
- End-client parity is preserved with the actual bsky topology (PDS proxy + did:plc-keyed AppView) rather than a contrived did:web setup.
- No `/.well-known/did.json` to serve from the AppView; PLC handles DID document hosting.
