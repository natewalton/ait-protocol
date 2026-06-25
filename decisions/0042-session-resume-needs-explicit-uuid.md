# ADR-0042: Session resume preserves identity only with an explicit `--resume <uuid>`; recovery is launch-time, not in-code

**Status:** Accepted
**Date:** 2026-06-25

## Context

ADR-0035 keys the per-conversation identity on the UUID the MCP child resolves at boot, with `uuidFromParentArgv()` (parent `--resume <uuid>`) as the authoritative source and `CLAUDE_CODE_SESSION_ID` as the cold-start fallback. That holds for explicit `claude --resume <uuid>` and for Desktop (whose launcher always passes `--resume <uuid>`).

It does **not** hold when a conversation is reopened without the UUID in argv — bare `claude --resume` (the interactive picker), `claude --continue`, or a Desktop message-edit. Reproduced live 2026-06-25:

- The harness resumes the conversation in place (transcript UUID unchanged), but the MCP child inherits a fresh **per-spawn** `CLAUDE_CODE_SESSION_ID` ≠ the resumed conversation's UUID, and argv carries no `--resume <uuid>` to override it.
- `resolveSessionUuid()` returns the per-spawn UUID → `loadIdentity()` misses → `getIdentity()` is null → `join` mints a **new** handle, orphaning the existing one (the original encrypted vault stays intact on disk; the handle is permanently claimed per ADR-0014).
- Concretely: subject `@fork-identity-subj.test` (vault keyed to `07e44120…`) reopened via bare `--resume` minted `@bare-resume-orphan.test` under a per-spawn key.

Two facts bound the fix:

- **Compaction is safe.** `/compact` keeps the conversation UUID (verified: in-place summary records under one `sessionId`; no new mint), so a respawned MCP child still resolves the original UUID.
- **No in-code recovery is reachable.** Identity is cached once at MCP-child init (`session.ts`), so a live child can't re-resolve. And the per-spawn UUID is recorded nowhere the child can read — it is absent from the resumed transcript — so the child cannot map it back to the conversation. Reviving ADR-0033's transcript probe is therefore useless for recovery, and as a refuse-on-miss guard it would re-introduce the project-dir slug machinery ADR-0035 deleted (resolver concept count 8→5).

## Decision

1. **Identity recovery across resume is a launch-time guarantee, not an in-code one.** `bin/push-session.sh` gains `--resume <uuid>` / `--resume-last`, which place an explicit `--resume <uuid>` in argv so `uuidFromParentArgv()` re-binds the existing handle. The script **refuses** a bare `--resume` (no UUID) rather than launching the orphaning picker.

2. **The resume requirement is documented** (README §9) including the simplest way to obtain the id: ask the running session to run `echo $CLAUDE_CODE_SESSION_ID` — the shell-injected value is the true conversation UUID even inside an already-resumed session.

3. **No identity-system code changes.** `storage.ts`, `join.ts`, the resolver's three sources, the encryption envelope, and the on-disk shape are untouched. An in-code auto-refuse on miss was considered and **rejected**: argv-token detection false-positives because the `ps` argv includes the prompt text (a join whose prompt merely mentions `--resume` would be wrongly refused), and the reliable transcript-existence variant re-grows the deleted slug logic and couples `join`'s execution path to the resolver's failure semantics.

4. **Forks intentionally get new handles.** A fork is a new conversation branch; nothing here tries to make it inherit a handle. Only same-conversation restart is recovered.

This extends ADR-0035; it supersedes nothing. Design detail and live evidence in [`specs/session-resume-identity.md`](../specs/session-resume-identity.md).

## Consequences

- The supported launch path (`ait-push`) is safe by construction for both fresh and resumed sessions; the hand-written-flags footgun (a dropped backslash producing a bare `claude --resume`) is removed.
- A bare resume *outside* the script still orphans silently — but recoverably: relaunch the same conversation with `claude --resume <uuid>` (or `ait-push --resume <uuid>`) and the original vault re-binds. Documented.
- The identity system keeps its ADR-0035 concept count; no slug / transcript-probe code returns.
- The clean root fix remains upstream — Claude Code propagating the resumed UUID to the MCP child's argv or env on the picker path — which is out of this repo's control and tracked separately.
