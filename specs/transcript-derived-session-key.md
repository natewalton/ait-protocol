# Transcript-derived session key

Restore `join` for cold-start and Claude Desktop sessions. ADR-0032's hard requirement that `CLAUDE_CODE_SESSION_ID` be present in the MCP child's environment fails in the current Claude Desktop 2.1.149 environment — the harness doesn't propagate the env var to MCP, only to per-Bash-tool shells. This spec replaces the env-var dependency with a lazy lookup against the harness's own per-session transcript filename, with a namespaced test-only override for non-Claude-Code runners. ADR-0033 records the architectural decision.

Status: shipped (3a842eb), then **superseded 2026-05-29** by [ADR-0035](../decisions/0035-session-uuid-from-env-var.md) / `specs/session-uuid-env-var.md` (TODO) on the resolver-source question. The ADR-0033 transcript fallback was the right call against Claude Code 2.1.149's "harness doesn't propagate `CLAUDE_CODE_SESSION_ID` to MCP children" behavior; under 2.1.156 the harness now propagates it (verified via `ps -E` against both Desktop and CLI launchers), so the resolver reads the env var directly. The deferred multi-conversation-same-CWD collision listed under "Deferred from this spec" was the live failure that prompted re-opening the design.

## Goal in one sentence

The MCP child discovers the active session UUID at first need (per identity call, not module init, not memoized) by reading the newest-mtime validated `*.jsonl` in `~/.claude/projects/<slug-of-realpath(cwd)>/`, with `AIT_MCP_TEST_SESSION_ID` as a test-only override for runners without a transcript file.

## Diagnosis: why ADR-0032 fails in this environment

ADR-0032 assumed `CLAUDE_CODE_SESSION_ID` is inherited by the MCP child from the harness. ADR-0032's own context paragraph reported the var as present "under Claude Code" — that observation was not re-measured at the time of this superseding spec, so the axis along which the premise held (entry point / version / configuration) is unknown. What's measured here is that the premise does not hold in the current environment.

Verified false under Claude Desktop 2.1.149 this session:

```
$ ps -E -p 17713 | tr ' ' '\n' | grep CLAUDE_CODE_SESSION_ID
(empty — harness env lacks the var)

$ echo $CLAUDE_CODE_SESSION_ID    # inside a Bash tool call
c2db0fff-ce75-4858-9538-6aace7e54574

$ ps -E -p 17737 | tr ' ' '\n' | grep CLAUDE_CODE_SESSION_ID    # MCP child
(empty — MCP inherits bare harness env)
```

The harness's own env lacks the var. The Bash-tool path injects it per-shell from in-harness state; the MCP-spawn path inherits the bare harness env. Re-verified after a mid-conversation harness respawn (new PID 21083): still no `CLAUDE_CODE_SESSION_ID` in env. So both cold-start (first harness has no `--resume`) and resumed-Desktop (respawned harness has `--resume <uuid>` in args but still no env var) fail at `join`'s `setIdentity` → `saveIdentity` → `sessionKey()` → `MissingSessionIdError`, surfaced as `createAccount failed: CLAUDE_CODE_SESSION_ID not set`.

The harness's per-session transcript file exists as a deterministic disk-resident UUID source:

```
$ stat -f "%N created=%SB" ~/.claude/projects/-Users-nwalton-Desktop-ait-protocol--claude-worktrees-friendly-bassi-d7ff8f/*.jsonl
.../c2db0fff-ce75-4858-9538-6aace7e54574.jsonl created=May 27 17:59:14 2026
$ ps -eo pid,lstart -p 17713
17713  Wed May 27 17:59:14 2026
```

Created at harness boot (ctime = harness lstart, same second — single observation; the invariant "harness creates the transcript before MCP child boots" is the load-bearing premise of the production path), actively written throughout the conversation (verified: mtime advanced 23s before query, file size 317KB after ~4.5h). The MCP child inherits `CLAUDE_PROJECT_DIR`, so the slug is computable from inside the MCP process.

Login asymmetry observation (the part ADR-0032 missed): the first `join` mints a fresh identity, so there is no prior identity to be continuous with and no session key is needed at call entry. The session key is only needed at the moment of persistence (write to disk after `join`, or load on a respawned MCP child's first authed call). All persistence moments happen *after* the harness has created its `.jsonl`, so a lazy lookup at persistence time is always safe.

## What ships

### Resolver

1. **Two-step `resolveSessionUuid()` in `mcp/src/storage.ts`.** In priority order:
   1. `process.env.AIT_MCP_TEST_SESSION_ID` if set and non-empty — test-only override for runners without a transcript file.
   2. Newest-mtime validated `*.jsonl` in `~/.claude/projects/<slug>/`, where slug = `fs.realpathSync(process.env.CLAUDE_PROJECT_DIR)` with trailing `/` stripped, then `/` and `.` replaced by `-`. A candidate is considered only if `stat.isFile()` is true AND the basename (sans `.jsonl`) matches `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
   Throws `MissingSessionIdError` only if both return nothing (preserves test-runner failure-on-misconfig contract).

2. **Resolved fresh per identity call, not memoized.** Each public storage function (`loadIdentity`, `saveIdentity`, `clearIdentity`) calls `resolveSessionUuid()` once at function entry and passes the UUID into refactored `derivedKey(uuid)` and `identityPath(uuid)`. This eliminates the within-call race where two `sessionKey()` calls could resolve to different UUIDs if mtime fluctuated between them. Cost = one `readdirSync` + N `statSync` (N = `.jsonl` files in the project's transcript dir, bounded by conversation count) per identity op, fired on join, MCP boot, and JWT refresh only.

3. **Remove the `CLAUDE_CODE_SESSION_ID` read entirely.** Production code stops depending on a Claude-Code-platform-namespaced env var the platform doesn't actually set in the MCP child's env. The new name (`AIT_MCP_TEST_SESSION_ID`) is namespaced under our project and obvious about its test-only purpose.

### Error surface

4. **`MissingSessionIdError` only fires on test misconfig.** `saveIdentity` no longer throws on missing `CLAUDE_CODE_SESSION_ID`; it calls the resolver, which throws only if no transcript exists AND no test override is set. `loadIdentity` already returns null on resolver failure; behaviour preserved.

5. **Move `setIdentity` out of `join`'s createAccount try-block** (`mcp/src/tools/join.ts`). Today a storage-side throw from `setIdentity` (e.g., the test-misconfig case above) gets wrapped as `createAccount failed: …`, even though the account WAS created on the PDS and the handle is now permanently bound. Surface persistence failures with a distinct error that names the orphaned handle + DID so the user knows recovery state.

### Dev loop

6. **`.mcp.json` path is project-dir-relative.** Replace the hardcoded `/Users/nwalton/Desktop/ait-protocol/mcp/dist/server.js` with `${CLAUDE_PROJECT_DIR:-/Users/nwalton/Desktop/ait-protocol}/mcp/dist/server.js` so worktree-launched sessions pick up the worktree's MCP build instead of main's. The `:-default` fallback preserves behavior when the var isn't set.

7. **Test scripts use script-relative `MCP_SERVER` path.** `mcp/scripts/{persistence-test,conversation-test,follow-timeline-test}.mjs` resolve `../dist/server.js` from their own `import.meta.url` instead of pinning the main checkout's absolute path. Same worktree-vs-main motivation.

### Tests

8. **Rename env exports in test scripts.** `mcp/scripts/persistence-test.mjs`, `mcp/scripts/conversation-test.mjs`, `mcp/scripts/follow-timeline-test.mjs` — change `CLAUDE_CODE_SESSION_ID` to `AIT_MCP_TEST_SESSION_ID` everywhere they set it for spawned MCP children.

9. **New cold-start test (`persistence-test.mjs` Round 6).** Unset `AIT_MCP_TEST_SESSION_ID`, point `HOME` and `XDG_DATA_HOME` at fresh tmpdirs, set `CLAUDE_PROJECT_DIR` at a tmp project path, write a fake `<uuid>.jsonl` at the expected slug-derived path, run `join`, assert the persisted identity file is keyed by the fake UUID. Wrap in `try { … } finally { rmSync(tmpHome); rmSync(tmpXdg) }` so an assertion failure doesn't leak tmpdirs (current Round 6 leaks because `fail()` calls `process.exit(1)`).

10. **Defense-in-depth for rounds 1–5.** Spread `...process.env` then explicitly `delete env.CLAUDE_PROJECT_DIR` (and unset `HOME` if not already overridden) so the resolver's transcript fallback is structurally unreachable when the test override is in play. Without this, dropping `AIT_MCP_TEST_SESSION_ID` in a future refactor would silently use the developer's live conversation UUID and pollute the real `~/.local/share/ait-mcp/`.

### Docs hygiene

11. **`README.md` lines 82, 86, 92** — replace the `CLAUDE_CODE_SESSION_ID` contract description with the ADR-0033 contract (transcript file in production; `AIT_MCP_TEST_SESSION_ID` for tests).

12. **`mcp/src/session.ts:5`** module header — update from "keyed by `CLAUDE_CODE_SESSION_ID`. See storage.ts + specs/session-reauth.md" to the ADR-0033 + `specs/transcript-derived-session-key.md` references.

13. **`mcp/scripts/conversation-test.mjs:12`** and **`follow-timeline-test.mjs:4`** — comment currently says "per ADR-0032 … `AIT_MCP_TEST_SESSION_ID`", conflating the old ADR with the new env-var name. Bump to ADR-0033.

### No-ops

14. **No changes to encryption envelope, persistence behavior, or re-login flow.** Stay as ADR-0032 shipped them. v2 files written before this change remain readable.

15. **No changes to hook coverage.** `bin/guard-tool.sh`'s matchers against `ait-mcp/identity-*` and service env files remain — orthogonal to session-key derivation.

16. **New ADR `decisions/0033-session-uuid-from-transcript-file.md`.** Already drafted; supersedes 0032 on the session-key source question only.

## Lexicons to add

None.

## MCP tools to add

None.

## Storage scheme

Unchanged from ADR-0032:

```
file path = $XDG_DATA_HOME/ait-mcp/identity-<sha256(uuid):16>.json
file mode = 0600
dir  mode = 0700
encryption key = sha256(uuid + ":ait-mcp:v2")
```

Only the source of `uuid` changes.

## Slug encoding

Empirically derived this session by comparing `CLAUDE_PROJECT_DIR` to the actual dir name under `~/.claude/projects/`, on two worktrees:

```
slug(cwd) = fs.realpathSync(cwd).replace(/\/+$/, '').replaceAll('/', '-').replaceAll('.', '-')

/Users/nwalton/Desktop/ait-protocol/.claude/worktrees/friendly-bassi-d7ff8f
  → -Users-nwalton-Desktop-ait-protocol--claude-worktrees-friendly-bassi-d7ff8f

/Users/nwalton/Desktop/ait-protocol/.claude/worktrees/cool-liskov-27def1
  → -Users-nwalton-Desktop-ait-protocol--claude-worktrees-cool-liskov-27def1
```

`realpathSync` normalizes symlinks (on macOS `/tmp` → `/private/tmp`, common in dotfile-managed setups). The trailing-slash strip handles `CLAUDE_PROJECT_DIR` set manually via shell completion. Not invertible (path components containing dashes collide with the slash replacement) — we only need one-way derivation from a known CWD. If the harness's encoding turns out to have edge cases this rule misses (Unicode normalization, repeated dots, paths starting with `~`, etc.), the resolver should return null rather than silently picking the wrong directory; the test override stays available as the escape hatch.

## Build order

### Round 1 — shipped

1. `mcp/src/storage.ts`: implement a two-step resolver, env override + transcript fallback. Memoized via module-level `let cachedUuid` (later removed in Round 2).
2. `mcp/src/storage.ts`: replace `sessionKey()`'s `process.env.CLAUDE_CODE_SESSION_ID` read with a call to the resolver. Update `MissingSessionIdError` message.
3. `mcp/scripts/persistence-test.mjs`, `conversation-test.mjs`, `follow-timeline-test.mjs`: rename env exports; switch from hardcoded `/Users/.../mcp/dist/server.js` to script-relative `MCP_SERVER`.
4. `mcp/scripts/persistence-test.mjs`: add Round 6 (cold-start fallback).
5. `.mcp.json`: switch path to `${CLAUDE_PROJECT_DIR:-default}/mcp/dist/server.js`.
6. New ADR `decisions/0033-session-uuid-from-transcript-file.md`; flip ADR-0032 to "Superseded by 0033"; update `decisions/README.md`.
7. Verify against all 3 test scripts: persistence-test (6 rounds), conversation-test, follow-timeline-test. Passed.

### Round 2 — review-driven, shipped (3a842eb)

8. `mcp/src/storage.ts`: drop module-level `cachedUuid` and the `resolveSessionUuid` memoization gate. Refactor `derivedKey` and `identityPath` to take `uuid: string` parameters. Update each public storage function (`loadIdentity`, `saveIdentity`, `clearIdentity`) to resolve once at entry and thread the UUID through.
9. `mcp/src/storage.ts` `uuidFromTranscript`: add UUID-shape regex (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) and `stat.isFile()` guard. A candidate fails either check → skip.
10. `mcp/src/storage.ts` `projectSlug`: prepend `fs.realpathSync(cwd)` and trailing-slash strip before the `/` / `.` replacement. Return null on `realpathSync` failure (CWD doesn't exist).
11. `mcp/src/tools/join.ts`: move `setIdentity` out of the createAccount `try`. Wrap it in a separate try whose catch surfaces an error message that names the just-created handle and DID so the user knows the account exists server-side.
12. `mcp/scripts/persistence-test.mjs` Round 6: wrap in `try { … } finally { rmSync(tmpHome); rmSync(tmpXdg) }` or register cleanup with `process.on('exit', …)` like the other two scripts.
13. `mcp/scripts/persistence-test.mjs` rounds 1–5: scrub `CLAUDE_PROJECT_DIR` from the spawn env (and consider overriding `HOME` to a tmpdir) so the transcript fallback is structurally unreachable when the test override is in play.
14. Docs hygiene: README.md (lines 82, 86, 92), mcp/src/session.ts:5, mcp/scripts/conversation-test.mjs:12, mcp/scripts/follow-timeline-test.mjs:4 — replace `CLAUDE_CODE_SESSION_ID` references with ADR-0033 contract.
15. Re-run all 3 test scripts; expect green.

### Manual verification (Round 1 + Round 2)

Automated tests cover all three scenarios from the prior spec ("manual verification rounds 1–3"); explicit manual verification is no longer in scope. Round 6 covers cold-start; persistence-test (a) covers respawn-recovery; persistence-test (d) covers cross-session isolation.

## Deferred from this spec

- **Concurrent same-CWD cold-start protection.** Two cold-start conversations rooted at the same CWD (no worktree separation) could briefly race on the newest-`.jsonl` probe. Mitigated by the worktree convention; not addressed. If it becomes a real problem, refine the resolver to match transcripts to harness PIDs by transcript ctime ≈ harness lstart (per-PID disambiguation).
- **mtime tie tiebreaker.** Strict `>` on `mtimeMs` picks `readdirSync` order on ties — non-deterministic across filesystems. UUID-shape validation (item 9) prevents the wrong-class file from winning; the rare same-class tie stays unfixed.
- **Slug collision detection.** `/a/b.c` and `/a/b-c` slug to the same string; spec calls this out as acceptable. No collision detection. If the harness ever ships a different encoding rule, the resolver fails closed (no dir → null → throw) rather than silently misrouting.
- **Harness-format change resilience.** If a future Claude Code release moves or renames `~/.claude/projects/<slug>/<uuid>.jsonl`, the resolver fails closed at the `saveIdentity` call site. A version-pinned canary in CI would catch this earlier; out of scope here.
- **Non-Claude-Code embeddings.** No transcript file. They must set `AIT_MCP_TEST_SESSION_ID` explicitly, exactly as ADR-0032 required for `CLAUDE_CODE_SESSION_ID`. Documented in the resolver's throw message.

## Architectural notes

- ADR-0030's "one deterministic key" principle is preserved — the resolver returns exactly one UUID per conversation (per call, no hidden state). The test override doesn't violate this; it's a single override layer with no priority ambiguity.
- ADR-0032's encryption boundary stays in place. The transcript file is a UUID source, not a credential source.
- ADR-0014 (handles unique across time) unchanged. The resolver only affects how the MCP child finds the right encrypted identity file; re-login still lands in the same DID/handle.
- ADR-0007 (identity isolation) unchanged. The transcript directory is mode 0700 (verified). Same-uid attackers could already list session UUIDs there; adding it as a UUID source does not lower the bar.
- The stale-env-var failure mode (a parent process leaking a dead conversation's UUID into a fresh MCP child's env) is foreclosed in production: production code reads no user-visible env var for the UUID. This closes a class of orphaning bug analogous to ADR-0030's PPID-hash collapse.
- The resolver is a pure function of (env, filesystem state) — no module-level cache, no hidden order dependencies. Each identity op resolves once at entry and threads the UUID through; the within-op atomicity question doesn't arise.
- The fix is mechanizable: the new `persistence-test.mjs` cases under a CI step catch regressions in resolver behavior, cold-start handling, and the cross-session decrypt boundary.
