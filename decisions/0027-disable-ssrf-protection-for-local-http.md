# ADR-0027: `PDS_DISABLE_SSRF_PROTECTION=true` for local HTTP upstreams

**Status:** Accepted
**Date:** 2026-05-22

## Context

ADR-0024/0025 had the MCP routing reads via the PDS service-proxy (`atproto-proxy: <did>#bsky_appview` header). With the AppView configured at `http://127.0.0.1:2585` and the proxy path empirically exercised, the PDS returned:

```
{"error":"UpstreamFailure","message":"Upstream service unreachable"}
```

PDS log surfaced the actual cause: `"Forbidden protocol \"http:\""`. Source trace led to `@atproto/pds/dist/context.js`:

```ts
const safeFetch = safeFetchWrap({
  allowIpHost: false,
  allowImplicitRedirect: false,
  ssrfProtection: !cfg.fetch.disableSsrfProtection,
  ...
})
```

`safeFetchWrap` from `@atproto-labs/fetch-node` enforces SSRF protections by default — non-HTTPS, IP-host upstreams, and similar patterns are blocked. The env switch to disable it is `PDS_DISABLE_SSRF_PROTECTION` (found in `packages/pds/src/config/env.ts`).

## Decision

Set `PDS_DISABLE_SSRF_PROTECTION=true` in the local PDS env. This is required for the AppView at `http://127.0.0.1:2585` to be reachable from the PDS proxy.

## Consequences

- The flag is `true` only for local development. In any deployed instance it would stay default (false) and the AppView would be served over HTTPS at a normal hostname.
- Local AppView URL must use `127.0.0.1` rather than `localhost` to avoid IPv6 resolution issues observed during testing.
- Decision is reversible: if we ever set up self-signed TLS for the AppView, we can drop this flag.
- Verified: with this flag set, `curl http://localhost:2583/xrpc/ait.feed.getAuthorFeed?actor=did:plc:...` with `atproto-proxy: did:plc:aitappview000000000001#bsky_appview` returned the indexed post via the PDS, demonstrating end-client-parity proxy path works end-to-end.
