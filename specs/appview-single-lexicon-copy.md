# AppView: one `@atproto/lexicon` copy via stack alignment

The AppView's `node_modules` carries **two** copies of `@atproto/lexicon` (`0.4.14` and `0.6.2`) because its `@atproto/*` dependencies straddle two release generations. This spec aligns the whole stack onto one generation so a single `@atproto/lexicon` (`0.7.1`) is installed — matching the MCP, which is already clean.

Status: spec.

## Goal in one sentence

`npm ls @atproto/lexicon` in `appview/` resolves to exactly one version, by upgrading the AppView's `@atproto/*` packages to one coherent generation and dropping the two it doesn't actually import.

## Why this exists

Duplicate `@atproto/lexicon` copies are why `instanceof BlobRef` is unreliable in the indexer (the firehose mints a `BlobRef` from `@atproto/sync`'s copy; code that imports `BlobRef` from a different copy fails the prototype check). The profile work already routed around this (duck-typed `avatarCid`, `CID.asCID`, validation via the agent's own `lex`), so this is **hygiene, not an active bug** — but it's a real footgun for the next contributor, and the version straddle will keep biting as `@atproto/*` moves on.

## The split (measured)

| consumer (declared in `appview/package.json`) | resolves to | `@atproto/lexicon` |
|---|---|---|
| `@atproto/api@^0.13` | `0.13.35` | **0.4.14** |
| `@atproto/repo@^0.5` | `0.5.5` | **0.4.14** |
| `@atproto/xrpc-server@^0.7` | `0.7.19` | **0.4.14** |
| `@atproto/sync@^0.1` | `0.1.40` → repo `0.8.13`, xrpc-server `0.10.22` | **0.6.2** |

`npm dedupe` can't merge `0.4`↔`0.6` (in 0.x semver every minor is a breaking major). `overrides` can't either: forcing the `0.13`-era `api`/`repo` (built for lexicon `0.4`) onto `0.6` points two-year-old code at an API two breaking-majors newer — more likely to break at runtime than fix. The MCP tree, by contrast, is already one copy (`lexicon@0.7.1` via `api@0.20.4`).

## Key findings that make this small

1. **The AppView imports nothing from `@atproto/api` or `@atproto/repo`.** A grep of `appview/src` shows direct imports only from `identity` (×10), `xrpc-server` (2 files), `sync` (2 files), `syntax` (×1), and a single `LexiconDoc` type from `lexicon`. `api` and `repo` are declared-but-unused — and their `0.4` pins are a *root cause* of the split. Dropping them is correct dependency hygiene **and** removes the `0.4` forcing.
2. **`@atproto/repo` left `@atproto/lexicon` entirely at `0.9.0`**, splitting it into `@atproto/lex-cbor` / `@atproto/lex-data`. So in the current generation only `api` and `xrpc-server` still depend on `@atproto/lexicon`. With `api` dropped, the *only* lexicon consumer is `xrpc-server@0.11` (+ our direct dep), both `^0.7.1` → they dedupe to one. `repo`/`sync` pull the `lex-*` packages (separate packages, **not** lexicon copies).
3. **The build breakage is contained to `appview/src/server.ts`.** A trial upgrade compiled with the indexer, all queries, and `xrpc/auth.ts` **unchanged** — `@atproto/sync@0.3`'s commit-event shape (`rkey`/`collection`/`did`/`record`/`uri`/`cid`) and `@atproto/identity@0.5`'s `IdResolver`/`MemoryCache`/`DidCache` and `verifyJwt` are all source-compatible. Only `xrpc-server`'s `0.7→0.11` handler/auth types moved.

## What ships

### 1. `appview/package.json` dependency rewrite

Declare exactly what the AppView imports, on the latest coherent generation:

```jsonc
"dependencies": {
  "@atproto/identity": "^0.5.0",     // IdResolver, MemoryCache, DidCache
  "@atproto/lexicon": "^0.7.1",      // LexiconDoc type (aitLexicons.ts)
  "@atproto/sync": "^0.3.1",         // Firehose, MemoryRunner, Event/Create/Update
  "@atproto/syntax": "^0.6.1",       // AtUri
  "@atproto/xrpc-server": "^0.11.1", // createServer, verifyJwt, handler/auth types
  "better-sqlite3": "^11.0.0",
  "dotenv": "^16.4.0"
}
```

Removed: `@atproto/api`, `@atproto/repo` (unused; transitively present via `sync` where needed). Added as direct deps: `@atproto/identity` and `@atproto/lexicon` (currently imported but only transitively declared). Then delete `appview/package-lock.json` + `node_modules` and reinstall for a clean resolution; commit the regenerated lock.

### 2. `appview/src/server.ts` — xrpc-server `0.7 → 0.11` type migration

The runtime calls (`createXrpcServer`, `xrpc.method`, `xrpc.routes.get`, `xrpc.router.listen`, `parseReqNsid`, `AuthRequiredError`, `InvalidRequestError`) are unchanged. Only the **types** moved:

| `0.7` | `0.11` |
|---|---|
| `type XRPCHandler` | `type MethodHandler<A>` — `MethodHandler` for unauthed, `MethodHandler<ViewerAuth>` for authed routes |
| `type AuthVerifier` (no args) | the verifier takes `MethodAuthContext` (`{ params, req, res }`) and returns the `AuthResult` (`{ credentials }`); declare `ViewerAuth` above it and annotate its return |
| `(ctx.auth as ViewerAuth).credentials.did` | with `MethodHandler<ViewerAuth>`, `ctx.auth` is already typed → `ctx.auth.credentials.did`, drop the cast |
| `ctx.input?.body` (registerPushTarget) | `ctx.input` is `void \| HandlerInput`; read defensively: `(ctx.input as { body?: unknown } \| undefined)?.body` |

No change to handler bodies, query calls, the firehose wiring, or `xrpc/auth.ts` (`verifyJwt` signature is compatible).

## Build order

1. Rewrite `appview/package.json` deps (§1).
2. `rm -rf appview/node_modules appview/package-lock.json` and `npm install` (in the worktree — never through a symlink into the main checkout's `node_modules`).
3. Verify one copy: `npm ls @atproto/lexicon` → single `0.7.1`.
4. Apply the `server.ts` type migration (§2).
5. `npm run build` until clean (expected: only `server.ts` touches).
6. Runtime test (below).
7. Commit: `package.json` + `package-lock.json` + `server.ts`, as its own commit separate from the profile work.

## Test plan

Compile-clean is necessary but not sufficient — the firehose wire protocol and XRPC serving must be exercised at runtime against the live PDS/PLC:

1. Build the worktree AppView; stop the main-checkout AppView on `:2585`; start the worktree build there with a fresh `APPVIEW_DB_PATH` (the same swap used to test the profile work). Confirm the log shows `firehose subscribed` **and** `appview listening`.
2. Run `mcp/scripts/profile-test.mjs` (write → cross-session read → merge → write-gate) and `mcp/scripts/follow-timeline-test.mjs` (post → follow → getTimeline) against it — these exercise indexing (firehose/`@atproto/sync@0.3` event decode, including the `BlobRef` avatar path) and all XRPC routes (`@atproto/xrpc-server@0.11`).
3. Restore: stop the worktree AppView, restart the main one, verify `:2585` is back and pidfiles are correct.

A green run proves `sync@0.3` still decodes commits into the shape the indexer reads and `xrpc-server@0.11` serves every route the queries expose.

## Risks

- **Firehose wire incompatibility** (`sync@0.1.40` → `0.3.1`): the *types* compile, but the runtime decode of `subscribeRepos` frames is what the test in step 2 actually proves. The PDS is unchanged, and the firehose protocol is stable, so this is expected to pass — but it's the one thing only a runtime run can confirm.
- **`lex-*` churn**: `repo@0.10`/`sync@0.3` are recent; if they prove unstable, the fallback is the `lexicon@0.6` generation (`api@~0.14`, `repo@0.8.13`, `sync@0.1.40`, `xrpc-server@0.10.x`) — one copy at `0.6.2` instead of `0.7.1`, no `api`/`repo` removal. Less clean (diverges from the MCP's `0.7`), but a smaller jump if `0.7` misbehaves.

## Deferred

- Bringing the **MCP** to the exact same lexicon patch isn't needed — it's already a single clean copy (`0.7.1`), and MCP and AppView are separate processes that never share lexicon objects, so cross-package identity between them is irrelevant.
- A custom/lexicon-resolving PDS (so the PDS validates `ait.*` writes natively, retiring the client-side write-gate) is a separate, larger decision — see the profile spec's discussion of the two-layer validation model. Out of scope here.

## Architectural note

The durable lesson is **declare direct deps = direct imports**. The split existed because `appview/package.json` pinned `api`/`repo` it never imported, freezing them (and their lexicon) a generation behind the `sync` it does use. Keeping the manifest honest to the import graph both fixes this and prevents the next straddle.
