# ADR-0037: AppView serves XRPC via the canonical `@atproto/xrpc-server`

**Status:** Accepted
**Date:** 2026-06-02

## Context

ADR-0036 closed the MCP side of the dual-dispatch deviation: every XRPC call from the MCP — read and write, bundled-lexicon and `ait.*` — now routes through `XrpcClient.call(nsid, ...)` with `lexicons/ait/**/*.json` registered on the agent's `Lexicons`. The matching gap on the AppView side stayed open: `appview/src/server.ts` ran raw `http.createServer`, parsed the NSID by `url.pathname.split('/')`, dispatched via `switch (nsid)`, and hand-built every error envelope. Five concrete hand-rolled responsibilities, all already covered by `@atproto/xrpc-server`'s `Server`:

1. NSID parsing (URL split + assert `xrpc` segment).
2. HTTP-method dispatch (GET vs POST per endpoint shape).
3. Query-param coercion (`parseLimit` + `searchParams.get` per handler).
4. Body reading + JSON parsing (`readBody` + `JSON.parse` for `registerPushTarget`).
5. Error envelope construction (`sendInvalidRequest` / `sendAuthRequired` / `sendInternal`).

Plus two not-yet-implemented wins available for free from the canonical server: lexicon-driven input validation and output validation.

`@atproto/xrpc-server@0.7.19` was already a dep (since the AppView landed for `verifyJwt`); express was reachable transitively. The carve-out at ADR-0028:29 ("MCP and AppView are net-new") covered whether those components exist — not whether they consume canonical libraries internally.

## Decision

Every `ait.*` XRPC endpoint at the AppView is dispatched by `@atproto/xrpc-server`'s `Server` — the same library a real `app.bsky.*` AppView would use — with the same `lexicons/ait/**/*.json` loaded via `appview/src/aitLexicons.ts`. There is no `http.createServer` + NSID-string-switch in the source.

Concretely:

- `appview/src/aitLexicons.ts` mirrors `mcp/src/atproto/aitLexicons.ts`: synchronous `fs.readdirSync` at module init, returns `readonly LexiconDoc[]`. Approach (A) from the spec — duplicate the ~30-line loader rather than wire a shared root module across `mcp/` and `appview/`. The same reasoning still holds: two separate `node_modules`, no workspace, and the loader is trivial.
- `createServer([...AIT_LEXICONS])` constructs a `Server` whose `router` IS the Express app (per `server.js:53-58`, `value: express()`). `xrpc.routes` is a `Router` mounted before the constructor's `/xrpc/:methodId` catchall, so `xrpc.routes.get('/xrpc/_health', ...)` matches before the catchall's `MethodNotImplementedError` fires. The whole stack listens via `xrpc.router.listen(PORT)`; the returned `http.Server` is what `SIGTERM`/`SIGINT` calls `.close()` on, preserving the supervision shape.
- The five handlers (`getAuthorFeed`, `getTimeline`, `getPostThread`, `listNotifications`, `registerPushTarget`) are now `XRPCHandler` functions that read typed `ctx.params` / `ctx.input.body` / `ctx.auth.credentials` and return `{encoding: 'application/json', body: ...}`. No `url.searchParams.get` / `parseLimit` / `readBody` / `JSON.parse` / hand-built error envelopes in the handler bodies.
- The existing `makeVerifyViewer(idResolver, ownDid)` (`appview/src/xrpc/auth.ts`) is wrapped into an `AuthVerifier` named `viewerAuth`. It resolves the route NSID via `parseReqNsid(ctx.req)` — `util.js:268` reads `originalUrl || url`, and the auth middleware runs after `createLocalsMiddleware(nsid)` so the path is intact — and binds it as the JWT's `lxm` claim. The two reads (`getTimeline`, `listNotifications`) and the one procedure (`registerPushTarget`) wire `{auth: viewerAuth, handler}` instead of a bare handler.
- `appview/src/xrpc/params.ts` is deleted. Its `parseLimit` is replaced by the lexicon's `integer / minimum: 1 / maximum: 100 / default: 50` enforced by `Server.createHandler`'s `decodeQueryParams` + `assertValidXrpcParams` (`server.js:247-249`). Its local `InvalidRequestError` is replaced by `@atproto/xrpc-server`'s exported one. `appview/src/xrpc/auth.ts` stays as the JWT-verification primitive `viewerAuth` wraps.
- `lexicons/ait/notification/registerPushTarget.json` gains `"nullable": ["since"]`. Without that key, `null` is rejected by the input validator (`lexicon/validators/complex.js:74-76` — only nulled keys listed in `def.nullable` skip validation), and the MCP-side `push.ts:tryRegister` deliberately sends `since: null` on first registration per `push.ts:71-78`. Lexicon widening is one-sided (MCP unchanged) and matches the field's documented intent ("null on first registration").
- `lexicons/ait/feed/getPostThread.json` gains `errors: [{name: "NotFound", description: "..."}]` so the customErrorName is part of the contract. The handler throws `new InvalidRequestError('post not found in this AppView', 'NotFound')` instead of writing `404 NotFound` by hand; the canonical bsky shape is 400 + `{error: "NotFound", message: "..."}`.

The AppView's dispatch surface count drops from 2 (hand-rolled HTTP + ait-only switch) to 1 (`Server` with five `method()` registrations).

## Consequences

- **Both halves of the AIT XRPC surface are lexicon-driven via canonical SDKs.** With ADR-0036 routing every MCP-side call through `XrpcClient.call` and this ADR routing every AppView-side handler through `Server.method`, the dual-dispatch deviation from ADR-0028 is closed end-to-end. The "AppView is net-new code, so it's allowed to roll its own dispatch" carve-out at ADR-0028:29 is now operationalized the same way the MCP side was: net-new code uses the canonical SDK internally; ait.* extends bsky.* via the same Lexicons-extension API.
- **Output shape validation is now on.** `Server.createHandler` runs `assertValidXrpcOutput(nsid, body)` before sending (`server.js:251-272`, default `validateResponse: true`). Drift between AppView output and lexicon spec surfaces as a 500 `InternalServerError` at the AppView instead of silently traveling to a `XRPCInvalidResponseError` at the MCP-side `XrpcClient.assertValidXrpcOutput`. Both ends now validate, so contract drift fails loud on whichever side introduces it.
- **Input shape validation is also now on.** `validateInput` runs in `Server.createHandler` (`util.js:71-121`). The `registerPushTarget` `nullable: ["since"]` lexicon edit lands because of this — without it, `since: null` from the MCP would 400 the call.
- **Wire-shape diffs from the hand-rolled server.** Four observable differences worth pinning here so future log-readers don't read them as regressions:
  1. **Unknown NSID** — was `404 {error: "NotFound", message: "no such endpoint"}` (hand-rolled `default:` arm at `server.ts:267-268`), now `501 {error: "MethodNotImplemented", message: "Method Not Implemented"}` (canonical: `server.js:catchall → MethodNotImplementedError`). `mcp/scripts/conversation-test.mjs` fix8 was updated from expecting 404 to expecting 501 — the assertion's semantic intent ("no prefix-match for `getAuthorFeedExtra`") is preserved; the status code matches what `XrpcClient` emits for any other unimplemented method.
  2. **`AuthRequired` body error name** — was `{error: "AuthRequired", ...}`, now `{error: "AuthenticationRequired", ...}`. This is `ResponseTypeNames[401]` in `@atproto/xrpc` — the canonical name. Status code stays 401. MCP-side `isAuthError` matches on `status === 401`, not the body string, so the re-auth path (ADR-0036 / `reauth-robustness.md` Fix 13) is unaffected.
  3. **`getPostThread` not-found** — was `404 {error: "NotFound", message: "post not found in this AppView"}`, now `400 {error: "NotFound", message: "post not found in this AppView"}`. The MCP-side `getPostThreadHandler` doesn't graceful-handle either status today, so no client regression. The body's `error: "NotFound"` is preserved (via `InvalidRequestError`'s second-arg `customErrorName`), and the lexicon's `errors: [{name: "NotFound"}]` makes it a declared error.
  4. **Cold-start data-completeness exposed** — when the AppView starts against an empty SQLite DB and replays the firehose from cursor 0, the PDS replays `#commit` events but does not appear to replay `#identity` events for accounts that joined before the AppView started. The actor row gets `active=1` (from `#account`) and gets touched by `ensureActor` (from indexed posts/follows) but `handle` stays NULL until a fresh `#identity` event arrives. The OLD server silently emitted `handle: ''` for the affected rows (failing the lexicon contract latently); the NEW server emits 500 `InternalServerError` (output validation rejects `handle: ''` against `format: handle`). In production this doesn't fire — the persisted DB carries all previously-resolved handles and the indexer's UPSERT preserves the `handle` column when `#account` events replay. The cold-start-from-empty-DB scenario in dev is the only place the regression is observable; tracked as a separate data-bootstrap issue, not within this ADR's scope.
- **No new top-level dependencies.** `@atproto/xrpc-server@0.7.19` and `express@4.22.2` (transitive) were already installed. `@types/express` was deliberately NOT added: the only direct express touchpoint in user code is the `_health` route handler, which uses minimal inline typing — `(_req: unknown, res: { json: (body: unknown) => void })`. The five XRPC handlers and the auth verifier only consume xrpc-server's own surface (`XRPCHandler`, `AuthVerifier`, `ctx.params/input/auth`), which falls back through `skipLibCheck: true` without needing the express typings present.
- **Five hand-rolled helpers retired.** `sendJson` / `sendInvalidRequest` / `sendAuthRequired` / `sendInternal` / `handleQuery` / `readBody` are gone from `appview/src/server.ts`. `appview/src/xrpc/params.ts` is gone. The whole `http.createServer` body — NSID parsing, method dispatch, body reading, switch-case routing — collapses into five `xrpc.method(nsid, handler)` calls.

## Related

- ADR-0036 (MCP routes every XRPC call through the canonical `XrpcClient`) — the symmetric MCP-side close. ADR-0037 is the matching AppView-side close; together they retire the dual-dispatch deviation end-to-end.
- ADR-0028 (Use canonical ATProto implementations, no rolling our own) — this ADR is the operationalization for the AppView's XRPC dispatch layer, the same way 0036 was for the MCP. The "MCP and AppView are net-new" carve-out at ADR-0028:29 covered whether the components exist, not how their dispatch layers are built.
- ADR-0008 (Lexicons under `ait.*` mirroring `app.bsky.*`) — `lexicons/ait/**/*.json` is what `createServer` is initialized with; `appview/src/aitLexicons.ts` mirrors the MCP-side loader (`mcp/src/atproto/aitLexicons.ts`).
- `specs/appview-canonical-xrpc-server.md` — the spec this ADR captures the decision-result of.
