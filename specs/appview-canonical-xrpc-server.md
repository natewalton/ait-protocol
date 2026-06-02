# AppView serves XRPC via `@atproto/xrpc-server`

Symmetric follow-up to ADR-0036, which routed the MCP-side XRPC dispatch through `@atproto/xrpc`'s `XrpcClient`. This spec does the same on the server side: replace `appview/src/server.ts`'s hand-rolled `http.createServer` + NSID string switch with the canonical `@atproto/xrpc-server` `Server`. Same lexicons, same handlers, lexicon-driven routing.

Status: spec.

## Goal in one sentence

Every `ait.*` XRPC call entering the AppView is dispatched by `@atproto/xrpc-server`'s lexicon-driven router — the same library a real `app.bsky.*` AppView would use — instead of by an `if (nsid === ...)` ladder in `appview/src/server.ts`.

## Why this exists separately from ADR-0036

ADR-0036 closed the MCP side. The user's framing: *"refactor read to how we do write"* — doesn't apply literally because the AppView has no writes (writes go to the vanilla PDS via `com.atproto.repo.createRecord`; the AppView only serves four queries + one procedure). The spirit applies: use the canonical SDK on this side too. After ADR-0036 we have one dispatch surface on the client; this spec closes the matching gap on the server.

Confirmed via `grep` on the working tree:

- `appview/src/server.ts:108` — `http.createServer((req, res) => { ... })`
- `appview/src/server.ts:117-118` — hand-parsed NSID from `url.pathname.split('/')`
- `appview/src/server.ts:126,180` — `if (nsid === 'ait.notification.registerPushTarget')` and `switch (nsid) { case 'ait.feed.getAuthorFeed': ... }`
- Only import from `@atproto/xrpc-server` today: `verifyJwt` in `appview/src/xrpc/auth.ts:1` (no `createServer`, no `Server`, no `method`).

`@atproto/xrpc-server@0.7.x` is already in `appview/package.json` (since the AppView landed). Express is installed transitively. **No new top-level dependencies.**

## Diagnosis: what's wrong with the current shape

Five hand-rolled responsibilities that the canonical `Server` already does:

1. **NSID parsing.** `server.ts:115-118` splits the URL by `/`, asserts the second segment is `xrpc`, and pulls the third as the NSID. `Server` routes by NSID natively because its routes are keyed by lexicon `id`.
2. **Method dispatch (POST vs GET).** `server.ts:125 / 174` checks `req.method` and rejects with 405 if it doesn't match the endpoint shape. `Server` derives HTTP method from each lexicon def's `type` (`procedure` → POST, `query` → GET) via `getMethodSchemaHTTPMethod`.
3. **Query-param parsing + coercion.** `xrpc/params.ts:parseLimit` + each handler's `url.searchParams.get(...)` manually coerce strings to numbers. `Server` parses params per lexicon's `parameters.properties` types (integer, string, datetime, etc.) and passes them as a typed `params` field in the handler context.
4. **Body reading + JSON parsing.** `server.ts:100-106` `readBody` builds the body string by hand; `server.ts:141` JSON-parses it manually. `Server` handles body parsing via its `middleware.json` and passes parsed input as `ctx.input.body`.
5. **Error response shape.** `server.ts:74-81` hand-builds `{error: 'InvalidRequest' | 'AuthRequired' | 'InternalServerError', message}` envelopes at multiple sites. `Server` throws canonical atproto error types (`InvalidRequestError`, `AuthRequiredError`) from `@atproto/xrpc-server`; handlers return `{status, error, message}` or throw and `Server` serializes.

Two more wins from the canonical path that don't have hand-rolled equivalents today:

6. **Input shape validation.** `Server` validates input against the lexicon's `input.schema` before invoking the handler — `server.ts:139-164` does this manually only for `registerPushTarget` (the `url` is a string, the `since` is a non-empty string or null).
7. **Output shape validation.** `Server` validates handler return values against the lexicon's `output.schema`. The MCP side already validates received responses against the same schemas (ADR-0036, via `XrpcClient.assertValidXrpcOutput`); having both ends validate makes drift fail-loud on whichever side introduces it.

The MCP side, as of ADR-0036, has none of (1)-(7) in user code — it all comes from `XrpcClient`. After this spec lands, the AppView side has none of them either.

## What ships

### 1. Shared lexicon loader

The MCP already has `mcp/src/atproto/aitLexicons.ts` (ADR-0036) that reads `lexicons/ait/**/*.json` at module init and exports the docs as `LexiconDoc[]`. The AppView needs the same loading behavior.

Two viable approaches:

- **(A) Duplicate the ~30-line loader** in `appview/src/aitLexicons.ts`, same shape, same relative-path resolution adjusted for `appview/dist/`.
- **(B) Factor the loader into a small shared module** at the repo root (e.g., `lexicons/loader.ts`), imported by both `mcp/` and `appview/`.

Recommended: **(A)**. Reasons: the loader is small; the two packages already have separate `node_modules`; no workspace setup exists to share TS modules across `mcp/` and `appview/` cleanly; a duplicate file is cheaper than wiring up a third package for 30 LoC. Revisit if a third consumer appears.

The lexicon directory is at the repo root (`lexicons/ait/**/*.json`), one level up from both `mcp/` and `appview/`, so relative-path resolution is symmetric: `path.resolve(__dirname, '..', '..', '..', 'lexicons', 'ait')` from the `dist/` build directory works for both.

### 2. Wire `@atproto/xrpc-server`

Replace `http.createServer(...)` in `appview/src/server.ts` with:

```ts
import { createServer as createXrpcServer } from '@atproto/xrpc-server'
import express from 'express'
import { AIT_LEXICONS } from './aitLexicons.js'

// ...inside main(), after openDb / verifyViewer setup:

const xrpcServer = createXrpcServer(AIT_LEXICONS)
const app = express()
app.use(xrpcServer.router)

// Health (not an XRPC endpoint, not in any lexicon) — stays raw:
app.get('/xrpc/_health', (req, res) => res.json({ status: 'ok' }))

// All five XRPC handlers registered against the Server, lexicon-driven:
xrpcServer.method('ait.feed.getAuthorFeed', getAuthorFeedHandler)
xrpcServer.method('ait.feed.getTimeline', { auth: viewerAuth, handler: getTimelineHandler })
xrpcServer.method('ait.feed.getPostThread', getPostThreadHandler)
xrpcServer.method('ait.notification.listNotifications', { auth: viewerAuth, handler: listNotificationsHandler })
xrpcServer.method('ait.notification.registerPushTarget', { auth: viewerAuth, handler: registerPushTargetHandler })

app.listen(PORT, () => console.log(`AppView listening on :${PORT}`))
```

`xrpcServer.router` is the Express Router that `Server.method(nsid, handler)` mounts routes on; verified at `appview/node_modules/@atproto/xrpc-server/dist/server.d.ts:6-9` (`router: Express; routes: Router`). The handler signature (`XRPCHandler`) is verified at `types.d.ts:149`: `(ctx: { auth, params, input, req, res, resetRouteRateLimits }) => Promise<HandlerOutput>`.

### 3. Migrate handlers to the canonical handler shape

Each existing handler in `server.ts:180-269` becomes an `XRPCHandler` that returns `{ encoding: 'application/json', body: <result> }`. Concrete migration for one (`getAuthorFeed`):

```ts
const getAuthorFeedHandler: XRPCHandler = async (ctx) => {
  const { actor, limit, cursor } = ctx.params as {
    actor: string
    limit?: number
    cursor?: string
  }
  const result = getAuthorFeed(db, { actor, limit, cursor })
  return { encoding: 'application/json', body: result }
}
```

What disappears from the body of each handler vs the current `server.ts`:

- `url.searchParams.get('actor')` + null check → `ctx.params.actor` (lexicon enforces `required: ["actor"]`).
- `parseLimit(...)` → `ctx.params.limit` (lexicon's `integer / minimum: 1 / maximum: 100 / default: 50` is enforced by `Server`).
- `sendJson(res, 200, result)` → `return { encoding: 'application/json', body: result }`.
- `try/catch → sendInternal` → throw; `Server` returns 500 via its default error handler. Specific errors (e.g. `getPostThread` 404 on missing thread) throw `InvalidRequestError` or its siblings, exported by `@atproto/xrpc-server`.

The five handlers to migrate:

| NSID | Current site | Auth required? |
|---|---|---|
| `ait.feed.getAuthorFeed` | `server.ts:181-197` | No (public posts) |
| `ait.feed.getTimeline` | `server.ts:199-218` | Yes — viewer DID |
| `ait.feed.getPostThread` | `server.ts:220-237` | No (public thread) |
| `ait.notification.listNotifications` | `server.ts:239-261` | Yes — viewer DID |
| `ait.notification.registerPushTarget` | `server.ts:126-168` | Yes — viewer DID |

### 4. Reuse the existing viewer auth

Today `appview/src/xrpc/auth.ts:9-30` exports `makeVerifyViewer(idResolver, ownDid)` returning a `VerifyViewer` that takes `(authHeader, lxm)` and returns the viewer DID (or null). `xrpc-server`'s `AuthVerifier` shape (`types.d.ts:161`) is `(ctx: { req, res }) => Promise<AuthOutput>`, where `AuthOutput` is `HandlerAuth | HandlerError` and `HandlerAuth` is `{ credentials: any, artifacts?: any }`.

Wrap the existing `verifyViewer` into an `AuthVerifier`:

```ts
const viewerAuth: AuthVerifier = async ({ req }) => {
  // lxm = the requested NSID — Server passes the route's nsid via req.url
  // (verified at xrpc-server's createHandler implementation).
  const lxm = parseReqNsid(req)
  const viewer = await verifyViewer(req.headers.authorization, lxm)
  if (!viewer) {
    throw new AuthRequiredError(`${lxm} requires an authenticated caller`)
  }
  return { credentials: { did: viewer } }
}
```

Then in handlers that need it:

```ts
const getTimelineHandler: XRPCHandler = async (ctx) => {
  const viewer = (ctx.auth as { credentials: { did: string } }).credentials.did
  // ... call getTimeline(db, { viewer, limit, cursor })
}
```

`parseReqNsid` is exported from `@atproto/xrpc-server` (`index.d.ts:7`) — confirms canonical access to the route's NSID inside an auth verifier.

### 5. Keep what isn't XRPC

These are not lexicon-driven endpoints and shouldn't move to `Server.method`:

- **`GET /xrpc/_health`** — health probe. Wire as a plain Express route on the same `app` (example shown in step 2).
- **PDS firehose subscription** (`Firehose` in `server.ts:42-60`) — internal, runs alongside the HTTP listener.
- **The push-fanout side effect** in `appview/src/indexer.ts:insertNotification` — internal call into `pushRegistry`, not an XRPC handler.
- **The MCP-side push-receiver listener** (`mcp/src/push.ts:startPushListener`) — receives notifications POST'd by the AppView. These webhooks are not part of any `ait.*` lexicon and are not XRPC. Stays raw `http.createServer`.

### 6. Delete what's superseded

After all five handlers are migrated and the smoke tests pass, remove from `appview/src/server.ts`:

- The `http.createServer` block (`server.ts:108-289`).
- `sendJson` / `sendInvalidRequest` / `sendAuthRequired` / `sendInternal` / `handleQuery` / `readBody` helpers (`server.ts:65-106`) — `Server` provides equivalents.
- `appview/src/xrpc/params.ts:parseLimit` — Server's lexicon-driven param coercion replaces it. (`InvalidRequestError` stays — it's exported from `@atproto/xrpc-server` directly.)

`appview/src/xrpc/auth.ts:makeVerifyViewer` stays — wrapped by `viewerAuth` per step 4.

## Verification

1. **Existing smoke tests pass without modification.** The AIT MCP side already validates response shapes against the lexicons (ADR-0036). If the AppView's output shape drifts, `mcp/scripts/conversation-test.mjs` and `mcp/scripts/persistence-test.mjs` should both fail at the client's `assertValidXrpcOutput`. Run both end-to-end against the migrated AppView; both should pass.

2. **Wire-level error envelopes match canonical atproto.** Quick check: hit each endpoint with a missing required param (e.g. `GET /xrpc/ait.feed.getAuthorFeed` with no `actor`); response should be `400 {"error":"InvalidRequest","message":"..."}` — same shape as the current `sendInvalidRequest`, just emitted by `Server` instead of by hand.

3. **Auth-required endpoints reject unauthenticated calls.** `curl /xrpc/ait.feed.getTimeline` with no `Authorization` → `401 AuthRequired`. Test pre-refactor and post-refactor — same behavior.

4. **Health endpoint still responds.** `curl /xrpc/_health` → `200 {"status":"ok"}`.

5. **Server starts cleanly** with `bin/start-all.sh`; firehose subscription begins indexing as before.

## Open questions for the building session

These need a decision during the build, not pre-decided here:

1. **Express vs `xrpcServer.router` on a bare `http.Server`.** `Server.router` is an Express app; mounting on `express()` is the obvious path. But `http.createServer` can host an Express router directly (`http.createServer(app)`) if there's a reason to keep the underlying `http.Server` reference (e.g., to graceful-shutdown the same way the current code does). Pick whichever matches the existing supervision shape.

2. **How `parseReqNsid` resolves the NSID inside an `AuthVerifier`.** The auth verifier runs before the handler is dispatched, so `req.url` should still carry the path. `parseReqNsid` is exported from `@atproto/xrpc-server` (`index.d.ts:7`) — verify its signature and that it returns the correct NSID at auth-verify time. If it doesn't, fall back to parsing `req.url` directly (the path is `/xrpc/<nsid>`).

3. **The `Server`'s default error handler.** Throwing `InvalidRequestError` / `AuthRequiredError` from a handler should produce the same error envelopes the current code sends by hand. Confirm by smoke; if shapes differ from what the MCP-side `XRPCError` expects, register a custom error handler on the Express app to canonicalize.

4. **`getPostThread`'s 404-not-found-in-this-AppView path.** Currently `server.ts:228-233` sends a `404 NotFound` when the thread isn't indexed. The canonical atproto error class for "not found" is `InvalidRequestError` (with error code `NotFound` per body convention) or just throwing a custom error. Pick one consistent with what real bsky AppViews do.

5. **`registerPushTarget`'s `since` field.** `mcp/src/push.ts:67-86` (post-ADR-0036) sends `since: <iso-string | null>`. The lexicon types `since` as an optional `string / format: datetime`. `Server`'s input validation may reject `null` against a non-nullable string schema — TODO check. If so, either widen the lexicon, change MCP to omit `since` when null, or carve out an exception. The MCP-side note at `mcp/src/push.ts:71-78` flags this tension; resolving it here is fine.

## Out of scope

- Refactoring the indexer (`appview/src/indexer.ts`). It doesn't touch XRPC.
- Replacing the firehose `Subscription` shape — that's already canonical (`@atproto/sync`).
- Adding rate limiting via `Server`'s built-in `RateLimiterI` — punt to a separate spec when there's a reason.
- Removing the MCP-side push-receiver `http.createServer` (`mcp/src/push.ts`). It serves the AppView's notification webhook, which is not an XRPC endpoint and is not in any lexicon.

## Pre-impl gates

Before writing code, the building session should:

1. **Read ADR-0036 and `mcp/src/atproto/aitLexicons.ts`.** The MCP-side pattern is the template for what the AppView side becomes.
2. **Read `appview/src/server.ts` end-to-end.** All five existing handlers + the body-reading, JSON-parsing, auth-checking machinery. Knowing what's there before deleting it.
3. **Verify `appview/node_modules/@atproto/xrpc-server/dist/server.d.ts` matches this spec.** If the API has moved (the spec verified against 0.7.x), confirm the migration shape still applies.
4. **Confirm `express` is reachable as a transitive install** without a top-level `dependencies` add. If it isn't, decide whether to add it as a direct dep (recommended) or pull it through a different code path.

## After the build

Add an ADR (next number, 0037) following the same arc as ADR-0036: state the deviation, state the canonical path, state that both sides of the AIT XRPC surface (MCP client + AppView server) are now lexicon-driven via the canonical atproto SDKs. Reference ADR-0028 ("use canonical implementations") explicitly — this spec completes the operationalization for the XRPC dispatch layer on both sides.
