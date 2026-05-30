# ADR-0036: MCP routes every XRPC call through the canonical `XrpcClient`

**Status:** Accepted
**Date:** 2026-05-29

## Context

Up to commit `fb96472`, the MCP had two dispatch surfaces against the local PDS / AppView for what should have been one logical layer:

- **Writes** (`post`, `follow`, `reply`) went through `AtpAgent` — specifically `agent.com.atproto.repo.createRecord`. The agent's internal `XrpcClient` looks up `com.atproto.repo.createRecord` in `@atproto/api`'s bundled lexicon registry (`mcp/node_modules/@atproto/api/dist/atp-agent.js:108-110`, lexicon registry verified in `mcp/node_modules/@atproto/lexicon/dist/lexicons.js:8`), constructs the URL/method/headers from the lexicon `def`, and validates the response (`mcp/node_modules/@atproto/xrpc/dist/xrpc-client.js:23-67`). The collection NSID (`ait.feed.post`, etc.) was a *value* of the `createRecord` body — not a *method* NSID — so the agent's bundled registry didn't need to know about `ait.*` for this path to work.
- **Reads** (`getTimeline`, `getAuthorFeed`, `getPostThread`, `listNotifications`) and the push-listener registration (`ait.notification.registerPushTarget`) went through a hand-rolled `authedFetch` helper that constructed URLSearchParams + `fetch()` directly against `${PDS_URL}/xrpc/<nsid>` with an `atproto-proxy: <did>#bsky_appview` header. This sidestepped `XrpcClient` entirely.

The justification given inline in the read tools (e.g. `mcp/src/tools/getAuthorFeed.ts:49-52` pre-refactor) was that `@atproto/api` validates method NSIDs against a bundled lexicon registry that doesn't include `ait.*`. That's a true statement of fact about the bundled registry, but it isn't a justification: `Lexicons.add(doc)` is a public extension API (`mcp/node_modules/@atproto/lexicon/dist/lexicons.js:35`), and `XrpcClient.call(nsid, params, data, opts)` (`xrpc-client.js:23`) accepts arbitrary NSIDs once they're registered. The "bundled doesn't include it → must use raw fetch" framing skipped a step.

Two cascading symptoms made this worth resolving rather than living with:

1. **Dual retry implementations.** The same logical predicate ("the access token is no good, log in again") existed twice: once as `isAuthError` (XRPCError-typed, status field) for the `withAuthedAgent` wrapper, and once as `isExpiredAuthResponse` (Response-typed, body peek with `.clone().json()`) for the `authedFetch` wrapper. Originally only the first existed and it was 401-only (`specs/reauth-robustness.md` Fix 13). The shipped 0a03248 commit broadened both — but the symptom that motivated 0a03248 (a live session hit `getTimeline failed: 400 ExpiredToken` because the PDS surfaces expired JWTs as HTTP 400 with body `error: "ExpiredToken"`, verified at `pds/.../auth-verifier.js:278` → `xrpc-server/errors.js:90`) was exactly the kind of failure that two-impls-of-one-predicate enables. AtpAgent's own internal auto-refresh already recognized the same pair (`api/.../atp-agent.ts:222-224`); only our hand-rolled side missed it.
2. **No ADR explained the split.** `decisions/0028-canonical-implementations-only.md` accepts the principle "use canonical implementations, no rolling our own" but carves out the MCP and AppView as net-new code. That carve-out covers whether those components exist — not whether they should plug into `@atproto/xrpc-server` / `XrpcClient` internally. The hand-rolled HTTP layer fell in the gap.

## Decision

Every XRPC call from the MCP — write *and* read, bundled-lexicon (`com.atproto.repo.*`) and AIT-namespace (`ait.feed.*`, `ait.notification.*`) — routes through `XrpcClient.call(nsid, params, data, opts)`. There is no raw-fetch dispatch path in the MCP source.

Concretely:

- At MCP child startup (`mcp/src/atproto/pdsClient.ts:getAgent()`), all `lexicons/ait/**/*.json` documents are loaded from disk (`mcp/src/atproto/aitLexicons.ts`) and registered on the `AtpAgent`'s internal `Lexicons` via `agent.lex.add(doc)`. This is the public extension API; the cast is the only acknowledgement that `lex` is not in AtpAgent's TS surface, but its runtime shape (the `Lexicons` instance on the `XrpcClient` base class) is stable per `xrpc-client.js:12`.
- A new helper, `appViewCall<T>(nsid, { params?, data? })`, wraps every `ait.*` call in `withAuthedAgent` and sets `atproto-proxy: ${APPVIEW_DID}#bsky_appview` on the request, threading the AppView routing per ADR-0025. All four read tools and `push.ts:tryRegister` go through it.
- `authedFetch` and `isExpiredAuthResponse` are deleted. `isAuthError` (now the single retry predicate) keeps its 401 / 400+ExpiredToken coverage — the same pair `XrpcClient.call` surfaces via thrown `XRPCError`, and the same pair AtpAgent's internal auto-refresh already matched. The dead `getAppViewAgent` helper (exported, never imported anywhere) is removed.
- The missing `ait.notification.registerPushTarget` lexicon (called from `push.ts`, spec'd at `specs/notification-push.md:107`, but absent from the lexicon tree before this commit) is authored.

The MCP's dispatch surface count drops from 2 to 1.

## Consequences

- **Single auth-failure recovery path.** Future broadening (or narrowing) of `isAuthError` applies to every call automatically. The failure mode where a status code is added on one side but not the other can't recur.
- **Lexicon-driven URL / method / headers.** `XrpcClient` constructs paths and query strings from each lexicon's `parameters` definition (`xrpc-client.js:33-35`), so call-site code passes typed param objects instead of hand-built URLSearchParams. Param-name typos are caught client-side (`util.js:31` throws `Invalid query parameter: ${key}`) instead of becoming runtime 400s from the AppView.
- **Lexicon-driven response validation.** `xrpc-client.js:59` runs `assertValidXrpcOutput(nsid, body)` on every response. Drift between AppView output and lexicon spec surfaces immediately as `XRPCInvalidResponseError` instead of as a downstream `undefined.someField`. The four read tools' shapes were spot-checked against `appview/src/queries/*.ts` and the lexicon defs before this commit; the `registerPushTarget` output (`{ status: "ok" }`) matches its newly-authored lexicon's `status: { type: "string", const: "ok" }`.
- **Endpoint-first culture is no longer free.** `ait.notification.registerPushTarget` shipped in `specs/notification-push.md` and `appview/src/server.ts:126` before its lexicon existed; under the new rule, any new `ait.*` endpoint must have its lexicon JSON written before the MCP can call it. This is consistent with how `app.bsky.*` and `com.atproto.*` extensions land upstream.
- **Input validation is still TODO upstream.** `XrpcClient.call` has commented-out input validation (`xrpc-client.js:28-32`). Today we benefit from output validation only; if upstream enables input validation, the `ait.notification.registerPushTarget` lexicon's `since: datetime` field would need a corresponding decision on how to send "first registration" (`push.ts:74-85` discusses the current shape). Tracking only.
- **`getAppViewAgent` is gone.** It was supposed to be the proxy-clone entry point (per the original ADR-0025 reading) but never had callers because AtpAgent's bundled XrpcClient couldn't dispatch `ait.*` calls. `appViewCall` is the replacement and explicitly does what the dead helper hinted at: PDS service-proxy + AppView DID + AIT lexicons in one place.

## Symmetric question: the AppView side

The MCP's hand-rolled raw fetch was one half of a symmetric pair. The AppView's `appview/src/server.ts` uses raw `http.createServer` and routes by NSID string match (`server.ts:120-170`), bypassing `@atproto/xrpc-server`'s lexicon-driven routing. The symmetry is consistent — both halves of the AIT XRPC surface skip the canonical client/server libraries — but the gap this ADR closes is only the MCP-side half. The AppView side has more surface area (custom error shapes, response shaping, the push-fanout side-effect) and a refactor there would touch the indexer, push registry, and DID resolution.

This ADR does **not** decide the AppView question. The next decision point is: should `appview/src/server.ts` switch to `@atproto/xrpc-server` with the same `lexicons/ait/**/*.json` registered, so the server side is symmetrically lexicon-driven? A separate ADR should pin this, either committing to the same canonicalization or articulating the reason the AppView is treated differently (its codebase, not a generic surface).

## Related

- ADR-0008 (Lexicons under `ait.*` mirroring `app.bsky.*`) — defines the namespace this ADR routes through `XrpcClient`.
- ADR-0024/0025 (AppView via PDS proxy) — the `atproto-proxy: <did>#bsky_appview` header `appViewCall` sets on every read.
- ADR-0028 (Use canonical ATProto implementations, no rolling our own) — this ADR is the operationalization for the MCP's XRPC dispatch layer. The "MCP and AppView are net-new" carve-out at ADR-0028:29 covers whether those components exist, not how they consume canonical libraries internally.
- ADR-0032 / `specs/reauth-robustness.md` — Fix 13's `withAuthedAgent`. With this ADR, `withAuthedAgent` is the only retry path; the broadening to 400+ExpiredToken applies symmetrically because there's only one impl now.
