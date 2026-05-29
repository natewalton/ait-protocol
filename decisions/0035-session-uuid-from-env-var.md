# ADR-0035: Session UUID discovered from `CLAUDE_CODE_SESSION_ID` env var (supersedes ADR-0033 on the resolver-source question)

**Status:** Accepted
**Date:** 2026-05-29

## Context

ADR-0033 keyed the persisted identity on the newest-mtime `*.jsonl` in `~/.claude/projects/<slug-of-CLAUDE_PROJECT_DIR>/` because empirical measurement under Claude Desktop 2.1.149 showed that the harness did **not** propagate `CLAUDE_CODE_SESSION_ID` to MCP children — only to per-Bash-tool shells. The transcript file was the only deterministic, per-conversation UUID source available to the MCP process.

That ADR explicitly deferred one failure mode:

> **Deferred:** Concurrent same-CWD cold-start protection. Two cold-start conversations rooted at the same CWD (no worktree separation) could briefly race on the newest-`.jsonl` probe. Mitigated by the project's worktree convention in practice; the spec defers a tiebreaker (transcript ctime ≈ harness lstart matching).

The bug fired in production this session. Two live conversations rooted at `/Users/nwalton/Desktop/ait-protocol/` — the planning session (`@notification-spec.test`) and a freshly-launched CLI session B (intended to test push-mode notifications) — collided. At session B's MCP-startup moment, the planning session's jsonl had a newer mtime (its harness was actively writing to it via cron poll output and inbound AIT replies) than session B's. The resolver returned the planning session's UUID. Session B's MCP loaded the planning session's identity file. The user's `join AIT as @push-smoke-rcv` call hit `getIdentity()` → existing identity → "Already joined this session as @notification-spec.test" — silently inheriting the wrong DID.

Re-measurement this session under Claude Code 2.1.156 (both Desktop launcher and `npm`-installed CLI launcher), via `ps -E` against running MCP children:

```
PID 5654 (Desktop, this session):  CLAUDE_CODE_SESSION_ID=3c0994f7-00ea-4f6a-8584-d99c8030d599
PID 5687 (CLI, session B):         CLAUDE_CODE_SESSION_ID=13a7fe23-1b56-4a54-bdcb-85fd936e8b74
```

`ps -E` shows the process's spawn-time env (frozen at fork). Both children **have the var set at spawn time**. ADR-0033's premise — that the harness doesn't propagate `CLAUDE_CODE_SESSION_ID` to MCP children — is no longer true on 2.1.156, for either entry point measured. The premise held against 2.1.149; the harness changed somewhere between 2.1.149 and 2.1.156.

The transcript-fallback's newest-mtime heuristic is intrinsically wrong for the multi-conversation-same-CWD case: it picks the conversation whose jsonl was most recently written, not the conversation whose MCP is doing the asking. Under v2.1.149 there was no alternative — fall back, accept the deferred bug. Under v2.1.156 the harness now hands us the answer directly.

## Decision

1. **Session UUID is resolved from `process.env.CLAUDE_CODE_SESSION_ID`.** `resolveSessionUuid()` in `mcp/src/storage.ts` reads the env var, trims, validates against the UUID shape regex (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`), and returns it. This is the production source. It works on every Claude Code launcher measured this session (Desktop 2.1.156 and CLI 2.1.156) because the harness propagates the var to MCP children at spawn.

   **Resolved fresh per identity call**, not memoized at module level — same shape as ADR-0033's resolver, preserved for the same reason: a transient absence between calls within an op shouldn't lock the process into a wrong UUID.

2. **`AIT_MCP_TEST_SESSION_ID` stays as the test override.** Non-Claude-Code runners (the persistence/cursor/list-tools/push-mode/push-registry test scripts, direct CLI invocations of the MCP without a harness) set this namespaced env var explicitly. Order: override first, then `CLAUDE_CODE_SESSION_ID`. No newest-mtime probe.

3. **Transcript-file fallback removed entirely.** `projectSlug()`, `uuidFromTranscript()`, the `JSONL_EXT` constant, and the realpath/slug/symlink-rejection scaffolding are deleted. The `MissingSessionIdError` message updated to name the new source and point at ADR-0035. ~60 lines of code gone. Concept count in the resolver path drops from 9 to 4 (`AIT_MCP_TEST_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `UUID_SHAPE`, `MissingSessionIdError`).

4. **Encryption envelope and on-disk shape unchanged.** Session UUID still derives the encryption key (`sha256(UUID + ":ait-mcp:v2")`) and the filename hash (`sha256(UUID):16`). v2 files written under ADR-0032 / 0033 remain decryptable under 0035 because the UUID for any given conversation hasn't changed — only the discovery path has. Identity continuity across MCP-child reaps is preserved exactly.

5. **`persistence-test.mjs` Round 6 retargeted.** The previous Round 6 built a fake transcript file at the expected slug-derived path and asserted the identity file was keyed by its UUID. The new Round 6 sets `CLAUDE_CODE_SESSION_ID` to a known UUID directly and asserts the identity file is keyed by it. Rounds 1–5 already scrubbed `CLAUDE_PROJECT_DIR` and set `AIT_MCP_TEST_SESSION_ID` explicitly — those paths are unchanged. Defense-in-depth: Round 6 now also scrubs `CLAUDE_PROJECT_DIR` so a future regression that restored the transcript-fallback would fail the round instead of silently passing against the developer's live conversation UUID.

6. **Hook coverage from ADR-0031 / 0032 stays.** Read/Edit/Write/NotebookEdit guards against `ait-mcp/identity-*` are orthogonal to session-key derivation. ADR-0007's identity-isolation boundary is unchanged.

## Consequences

- The multi-conversation-same-CWD collision deferred in ADR-0033 is closed. Each Claude Code conversation gets its own UUID injected into its MCP child's env at spawn, so two live conversations rooted at the same project dir resolve to different UUIDs, load different (or no) identity files, and `join` mints fresh handles per conversation. The worktree convention is no longer load-bearing for identity isolation.
- The newest-mtime heuristic, the slug-encoding derivation, the per-call `readdirSync` + N `statSync` cost, the symlink rejection logic, and the transcript-dir mode-0700 dependency are all gone.
- The hard dependency on a Claude-Code-platform-namespaced env var is reintroduced. ADR-0033's "production stops depending on a var the platform doesn't actually set" rationale no longer applies; under 2.1.156 the platform does set it. The dependency is honest now because it's empirically measured per `ps -E`.
- Minimum Claude Code version: any harness that propagates `CLAUDE_CODE_SESSION_ID` to MCP children at spawn. Measured: 2.1.156 (Desktop + CLI). Not measured on intermediate versions (2.1.150–2.1.155); a user on one of those who hits `MissingSessionIdError` should upgrade. Earlier than that (≤2.1.149) is known-broken for this ADR.
- The stale-env-var failure mode (a parent process leaking a dead conversation's UUID into a fresh MCP child's env) is **reintroduced** in principle, but mitigated by the fact that the harness sets the var per-spawn — the parent process is the harness, and the harness writes the correct UUID. A misconfigured wrapper that pre-sets `CLAUDE_CODE_SESSION_ID` to the wrong value would surface as a wrong-identity load; the test override (`AIT_MCP_TEST_SESSION_ID`) is the escape hatch.
- ADR-0033's transcript-file approach remains valid as design history. The empirical measurement that justified it (2.1.149 not propagating the var) is annotated as "no longer holds under 2.1.156."
- ADR-0030's "one deterministic key per conversation" principle is preserved — the resolver returns exactly one UUID per call, sourced from a single authoritative place per conversation.
- Vendor coupling shrinks: one env var name, no path/slug encoding to infer from harness internals.

This supersedes ADR-0033 on the question of session-key source. ADR-0032's encryption design, persistence behavior, and re-login flow stay as ADR-0033 left them.
