# ADR-0035: Session UUID resolved from parent claude `--resume` argv (supersedes ADR-0033)

**Status:** Accepted
**Date:** 2026-05-29

## Context

ADR-0033 keyed the persisted identity on the newest-mtime `*.jsonl` in `~/.claude/projects/<slug-of-CLAUDE_PROJECT_DIR>/` because Claude Code 2.1.149's harness didn't propagate `CLAUDE_CODE_SESSION_ID` to MCP children. That ADR explicitly deferred:

> **Deferred:** Concurrent same-CWD cold-start protection. Two cold-start conversations rooted at the same CWD (no worktree separation) could briefly race on the newest-`.jsonl` probe. Mitigated by the project's worktree convention in practice; the spec defers a tiebreaker (transcript ctime ≈ harness lstart matching).

The bug fired this session. Two live Desktop conversations rooted at `/Users/nwalton/Desktop/ait-protocol/` — a planning session (`@notification-spec.test`) and a freshly-launched CLI session B — collided on the resolver. At B's MCP-startup moment, the planning session's jsonl had the newer mtime (its harness was being actively written via cron poll output + inbound AIT replies), so the resolver picked the planning session's UUID, decrypted its identity, and treated B as `@notification-spec.test`. The user had to manually exit B; the worktree convention was the only thing that had been mitigating the deferred bug for previous Desktop launches in this project, and B violated it by running in main.

A first attempt (the now-reverted env-var-only resolver) read `CLAUDE_CODE_SESSION_ID` as the per-conversation key. `ps -E` against running MCP children showed the var IS propagated under Claude Code 2.1.156:

```
PID 8690 (Desktop): CLAUDE_CODE_SESSION_ID=3c0994f7-... (pre-restart) → 06509308-... (post-restart)
PID 7669 (CLI):     CLAUDE_CODE_SESSION_ID=13ea7899-... (matches its 13ea7899-….jsonl transcript)
```

But the empirical reading was incomplete. On Desktop, `CLAUDE_CODE_SESSION_ID` is **per-MCP-spawn**, not per-conversation — it changes on every Desktop restart while the conversation's transcript UUID (`a2671c7e-…`) stays constant. Keying identity on the env var lost the identity file on every restart and orphaned the handle (forbidden by ADR-0014). Reverted at `5bcb195`.

This ADR uses the right signal. The Desktop launcher (re)spawns claude with `--resume <conversation-UUID>` on its argv when resuming a conversation:

```
PID 8683 (my Desktop claude, post-restart):
  ... --resume a2671c7e-5ef1-4ec4-8f06-9a064def95c6 ...

PID 8911 (spec session's Desktop claude, post-restart):
  ... --resume 1b030b9c-61ee-4b35-9049-8a6653313199 ...
```

Both UUIDs match their conversation's transcript jsonl in the project dir. The launcher's `--resume` flag IS the per-conversation identifier — and unlike `CLAUDE_CODE_SESSION_ID`, it survives MCP-child respawns because the harness was *given* it by the launcher and keeps it on the command line for its full lifetime.

The MCP child can read its parent claude's argv via `ps -o command= -p <ppid>`. The CLI cold-start case (no `--resume` because the conversation is brand-new) is covered by `CLAUDE_CODE_SESSION_ID`, which in that case equals the freshly-created transcript UUID.

## Decision

1. **Session UUID is resolved from the parent claude process's argv when `--resume <UUID>` is present** — the resumed-conversation case. `uuidFromParentArgv()` in `mcp/src/storage.ts` runs `execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)])`, regex-matches `/--resume\s+([0-9a-f]{8}-…)/i`, validates with `UUID_SHAPE`, returns the UUID or null. This is the production source for Desktop sessions and any harness that respawns with `--resume`.

2. **`CLAUDE_CODE_SESSION_ID` env var is the cold-start source.** When the harness launches fresh (no `--resume`), the var it propagates to the MCP child equals the new transcript UUID. The resolver consults it after `uuidFromParentArgv()` returns null.

3. **`AIT_MCP_TEST_SESSION_ID` stays as the test override** — checked first, unchanged.

4. **Transcript-file resolver removed entirely.** `projectSlug()`, `uuidFromTranscript()`, the `JSONL_EXT` constant, the realpath/slug derivation, the symlink-rejection logic, the per-call `readdirSync + N statSync` are all deleted. The newest-mtime probe is the bug — it picks the wrong conversation whenever two live conversations share a project dir, and the worktree convention isn't a reliable mitigation. The two production sources above are authoritative per-conversation signals; nothing to fall back to.

5. **Cross-platform note.** `ps -o command= -p <pid>` is POSIX and works identically on macOS and Linux. `execFileSync` avoids shell interpolation; the only inputs are a literal program name and a numeric PID. No untrusted data flows through the spawn.

6. **Cost.** One `ps` shell call per `loadIdentity` / `saveIdentity` / `clearIdentity` invocation — same shape as ADR-0033's per-call `readdirSync`. Negligible for an op that fires on join, MCP boot, and JWT refresh only.

7. **`persistence-test.mjs` Round 6 retargeted.** The previous Round 6 (under ADR-0033) built a fake transcript file and asserted the identity file was keyed by it. The new Round 6 sets `CLAUDE_CODE_SESSION_ID` to a known UUID directly and asserts the identity file is keyed by it (the persistence-test's node process is the parent — its argv has no `--resume`, so the resolver falls through to the env var, exercising the cold-start path end-to-end). Rounds 1–5 already scrub `CLAUDE_PROJECT_DIR` and set `AIT_MCP_TEST_SESSION_ID` explicitly — unchanged. Round 6 also scrubs `CLAUDE_PROJECT_DIR` so a future regression that restored the transcript-fallback would fail loud instead of silently passing against the developer's live conversation UUID.

8. **Encryption envelope and on-disk shape unchanged.** Session UUID still derives the encryption key (`sha256(uuid + ":ait-mcp:v2")`) and the filename hash (`sha256(uuid):16`). Identity files written under ADR-0032 / 0033 remain decryptable under 0035 because the UUID for any given conversation hasn't changed — only the discovery path has. Identity continuity across MCP-child reaps is preserved.

9. **Hook coverage from ADR-0031 / 0032 stays.** Read/Edit/Write/NotebookEdit guards against `ait-mcp/identity-*` are orthogonal to session-key derivation.

## Consequences

- The multi-conversation-same-CWD collision deferred in ADR-0033 is closed. Each Claude Code conversation's MCP child has its own parent claude process with its own `--resume <UUID>` argv; two conversations in the same project dir resolve to different UUIDs deterministically. The worktree convention is no longer load-bearing for identity isolation.
- The Desktop-restart identity-loss bug from the reverted env-var-only ADR is also closed. `--resume` survives MCP-child respawns because the launcher keeps it on the harness's command line; the env var doesn't (it's per-spawn on Desktop).
- The newest-mtime heuristic, slug encoding, per-call `readdirSync`, symlink rejection, and transcript-dir mode-0700 dependency are all gone. ~60 lines of code deleted. Resolver concept count drops from 8 to 5.
- New dependency: the resolver shells out to `ps`. On any system where `ps -o command= -p <pid>` doesn't work as expected (very unusual), the resolver falls through to `CLAUDE_CODE_SESSION_ID`; if that's also unset, throws `MissingSessionIdError`. `AIT_MCP_TEST_SESSION_ID` is the escape hatch.
- The stale-env-var failure mode is **further reduced**. The primary signal is the harness's own launch flag, which can't be polluted by a parent process leaking a dead conversation's env var.
- Minimum Claude Code version assumption: the harness either uses `--resume <UUID>` on the launcher command line (resume case, verified for Desktop 2.1.156) or propagates `CLAUDE_CODE_SESSION_ID` to MCP children at spawn (cold-start case, verified for CLI 2.1.156). Older versions that satisfy neither are not supported; the test override is available.
- ADR-0033's transcript-file resolver remains valid as design history. The newest-mtime heuristic was the right call against 2.1.149 (no env var, no observable `--resume` argv path explored at the time) and the deferred collision was acceptable given the worktree convention. 0035 supersedes it on the resolver-source question now that the authoritative parent-argv signal is empirically reachable.
- ADR-0030's "one deterministic key per conversation" principle is preserved — the resolver returns exactly one UUID per call, sourced from the harness's own per-conversation signal.
- Vendor coupling shrinks: parse one harness CLI flag (`--resume`) and read one env var (`CLAUDE_CODE_SESSION_ID`), instead of inferring a slug encoding and probing a transcript directory.

This supersedes ADR-0033 on the question of session-key source. ADR-0032's encryption design, persistence behavior, and re-login flow stay accepted.

## Empirical record

`ps` against the running MCP children's parent claude processes, this session:

| MCP PID | Parent claude PID | Parent argv contains | Transcript jsonl in project dir | Match? |
|---|---|---|---|---|
| 8690 | 8683 (Desktop) | `--resume a2671c7e-5ef1-4ec4-8f06-9a064def95c6` | `a2671c7e-….jsonl` | ✓ |
| 8931 | 8911 (Desktop) | `--resume 1b030b9c-61ee-4b35-9049-8a6653313199` | `1b030b9c-….jsonl` | ✓ |
| 7669 | 7659 (CLI) | (no `--resume`; cold-start) | `13ea7899-….jsonl` (CLAUDE_CODE_SESSION_ID=13ea7899-…) | ✓ via env |

`lsof -p <claude-pid>` returned no jsonl files for any of the parent processes — the transcripts are opened in append+close mode, not held open. File-descriptor sniffing was considered and rejected for that reason; argv parsing is the working signal.
