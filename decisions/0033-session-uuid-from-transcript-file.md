# ADR-0033: Session UUID discovered from harness transcript file (supersedes ADR-0032)

**Status:** Superseded by [ADR-0035](0035-session-uuid-from-env-var.md) on the resolver-source question (2026-05-29). The premise that the harness doesn't propagate `CLAUDE_CODE_SESSION_ID` to MCP children held against Claude Code 2.1.149 but no longer holds against 2.1.156 (verified via `ps -E` against both Desktop and CLI launchers). The transcript-file resolver also produced a multi-conversation-same-CWD collision deferred in this ADR — closed in 0035 by reading the now-propagated env var directly. Encryption envelope and persistence behavior stay as accepted here.
**Date:** 2026-05-27

## Context

ADR-0032 keyed the persisted identity on `process.env.CLAUDE_CODE_SESSION_ID` and required the env var at the moment of `saveIdentity` (and accepted its absence at `loadIdentity` as "first run"). The premise was that the Claude Code harness propagates this env var into its child MCP processes. ADR-0032's own context paragraph asserts the env var is present in the MCP child's env "under Claude Code"; that assertion was not re-measured at the time of this superseding ADR, so the exact axis along which the premise held (entry point / version / configuration) is unknown.

The premise does not hold in the current environment. Verified empirically this session under Claude Desktop 2.1.149 via `ps -E -p <harness-pid>`:

```
CLAUDE_AGENT_SDK_VERSION=0.3.149
CLAUDE_CODE_DISABLE_CRON=
CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES=false
CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL=true
CLAUDE_CODE_ENTRYPOINT=claude-desktop
CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1
CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1
CLAUDE_PROJECT_DIR=/Users/nwalton/Desktop/ait-protocol/.claude/worktrees/friendly-bassi-d7ff8f
```

No `CLAUDE_CODE_SESSION_ID`. The Bash-tool spawn path injects it per-shell from in-harness state; the MCP-child spawn path inherits the bare harness env. So MCP children under Claude Desktop never see the var, and `join` fails at `saveIdentity` with `MissingSessionIdError`, surfaced as `createAccount failed: CLAUDE_CODE_SESSION_ID not set`. Both cold-start (no `--resume` on harness command line) and resumed-Desktop sessions fail for the same root cause: the harness's per-conversation UUID is not propagated to MCP via env.

The harness publishes the UUID to disk as a side effect of its own transcript logging:

```
~/.claude/projects/<slug-of-cwd>/<conversation-uuid>.jsonl
```

Slug = `CLAUDE_PROJECT_DIR` with `/` and `.` replaced by `-` (verified empirically against two worktrees this session). File is created at harness boot (ctime = harness lstart, same second) and appended throughout the conversation. The MCP child inherits `CLAUDE_PROJECT_DIR`, so the slug is computable from inside the MCP process. Newest-mtime `.jsonl` in that directory is the active conversation.

Identity-resolution asymmetry between `join` and other calls (the observation ADR-0032 missed): the first `join` mints a fresh identity, so there is no prior state to be continuous with and no session key is needed at call entry. Session-key resolution is only needed at the moment of persistence (write to disk after `join`, or load on a respawned MCP child's first authed call). All those moments happen after the harness has already created the `.jsonl`.

## Decision

1. **Session UUID is discovered lazily from the harness's transcript filename.** `resolveSessionUuid()` reads the newest-mtime `*.jsonl` in `~/.claude/projects/<slug-of-CLAUDE_PROJECT_DIR>/`, validates that the basename matches the UUID shape (`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`) and that the entry is a regular file, and returns the validated filename without extension. Slug = `fs.realpathSync(CLAUDE_PROJECT_DIR)` with trailing `/` stripped, then `/` and `.` replaced by `-`. This is the only production source; it works in every real environment we've measured (Claude Desktop 2.1.149 cold-start, Desktop resumed, MCP-child respawn) because the harness creates the transcript file at its own boot.

   **Resolved fresh per identity call**, not memoized at module level. Each public storage function (`loadIdentity`, `saveIdentity`, `clearIdentity`) calls `resolveSessionUuid()` once at entry and passes the UUID into `derivedKey(uuid)` and `identityPath(uuid)`, eliminating the within-call race window where two `sessionKey()` calls could resolve to different UUIDs if mtime fluctuated between them. The cost is one `readdirSync` + N `statSync` (N = `.jsonl` files in the project's transcript dir, bounded by conversation count) per identity op, fired on join, MCP boot, and JWT refresh only — negligible.

2. **Test-only override via `AIT_MCP_TEST_SESSION_ID`.** Non-Claude-Code runners (test scripts, direct CLI invocations of the MCP without a harness) have no transcript file to fall back on. They set this namespaced env var explicitly. Production code reads `AIT_MCP_TEST_SESSION_ID` only as a first-check override; the previously-used `CLAUDE_CODE_SESSION_ID` read is removed entirely. The new name makes the contract honest — production stops depending on a Claude-Code-platform-namespaced var the platform doesn't actually set in the MCP child's env.

3. **No env-var requirement at MCP boot or at any production persistence call.** `saveIdentity` no longer rejects on missing env; it calls the resolver. `loadIdentity` already returns null on resolver failure (ADR-0032's graceful path) and that stays. The throw only fires for test runners that forgot to set the test override.

4. **Encryption envelope and on-disk shape unchanged.** Session UUID still derives the encryption key (`sha256(UUID + ":ait-mcp:v2")`) and the filename hash (`sha256(UUID):16`). v2 files written under ADR-0032 remain decryptable under ADR-0033 because the UUID is the same — only the discovery path changes.

5. **Hook coverage from ADR-0032 stays.** Read/Edit/Write/NotebookEdit guards against `ait-mcp/identity-*` are orthogonal to session-key derivation; ADR-0031 / 0032's security boundary is untouched.

## Consequences

- Cold-start and Desktop-resumed `join` calls both succeed without any env-var dependency in production (verified under Claude Desktop 2.1.149). Any entry point that produces the same `~/.claude/projects/<slug>/<uuid>.jsonl` artifact resolves through the same code path; entry points that don't ship the transcript file rely on the `AIT_MCP_TEST_SESSION_ID` override.
- Identity continuity across MCP-child reaps is preserved exactly as ADR-0032 intended — the UUID source differs, but the resolved value is the same per conversation.
- The hard dependency on `CLAUDE_CODE_SESSION_ID` is lifted in production and renamed for tests. Existing test scripts that exported `CLAUDE_CODE_SESSION_ID` rename to `AIT_MCP_TEST_SESSION_ID` — one-line change per script.
- **The stale-env-var failure mode is closed.** No parent-process env can pollute the resolver, because production code never reads a user-visible env var for the UUID. Same class of orphaning bug ADR-0030 had, foreclosed at a different vector.
- Concurrent cold-start sessions rooted at the same CWD (without worktree separation) could briefly race on the newest-`.jsonl` probe. Mitigated by the project's worktree convention in practice; the spec defers a tiebreaker (transcript ctime ≈ harness lstart matching).
- The transcript file is mode 0600 inside a 0700 directory (verified). Adding it as a UUID source does not weaken ADR-0007's identity-isolation boundary — same-uid attackers could already list session UUIDs from that directory.
- Vendor coupling reduces to one undocumented harness convention (the transcript path/slug encoding) instead of two (would-have-been: that path plus the `--resume` flag name).

This supersedes ADR-0032 on the question of session-key source. The encryption design, persistence behavior, re-login flow, and hook coverage from ADR-0032 stay accepted.
