# ADR-0032: Identity persistence keyed by CLAUDE_CODE_SESSION_ID (supersedes ADR-0030)

**Status:** Accepted
**Date:** 2026-05-27

## Context

ADR-0030 keyed the persisted identity file by `sha256("<PPID>-<ps -o lstart= -p PPID>")`, on the premise that the parent Claude process is invariant across MCP-child reaps inside one conversation. Premise was empirically false.

In a single conversation observed via `ps -eo pid,ppid,lstart,command | grep mcp/dist/server.js`, the harness PPID was rebuilt three times — `2410` / `3010` / `6733` — each with a different `lstart`. The hash function therefore produced three different keys (`3910a4f48dff097c`, `3094f5caa070076e`, `400169749e0d2f96`), one identity file per key, and the live MCP child only loaded the file matching its current PPID+lstart. Every harness respawn looked like "first launch" to a freshly-spawned MCP, even though the user was mid-conversation. Combined with ADR-0014 (handles never re-bind), the result was permanently orphaned identities at every respawn.

The MCP child's environment carries a stable identifier: `CLAUDE_CODE_SESSION_ID`, the UUID matching the `--resume <uuid>` argument on the parent harness's command line. It persists across harness respawns within one conversation and differs across conversations.

A secondary problem ADR-0030 didn't address: any process running as the same Unix user could `cat ~/.local/share/ait-mcp/identity-*.json` and read every session's JWTs in plaintext. Mode `0600` blocks other Unix users but does nothing for parallel Claude sessions, dotfile scripts, or curious LLM agents in unrelated projects on the same machine. The threat ADR-0007 warned about ("no session acts as another") was reachable through a one-line file read.

## Decision

1. **Session key = `CLAUDE_CODE_SESSION_ID`.** Required, no fallback. If unset (non-Claude-Code runner), `loadIdentity` returns `null` and `saveIdentity` throws. Test runners must set it explicitly. ADR-0030's "no UUID parsing, no fallback" principle is preserved — one scheme, deterministic — only the source of the key changes.

2. **Encrypted credential envelope.** Sensitive fields (`password`, `accessJwt`, `refreshJwt`) live inside an AES-256-GCM ciphertext. Encryption key = `sha256(CLAUDE_CODE_SESSION_ID + ":ait-mcp:v2")`, derived only from the env var — never written to disk. The plaintext outer envelope carries `did`, `handle`, `createdAt` (public protocol identifiers + a diagnostic timestamp). Fresh 12-byte nonce per write.

3. **Persisted password enables re-login.** The createAccount-generated 128-bit hex password is stored inside the encrypted envelope. When refresh fails, `getAuthedAgent` calls `agent.login({ identifier: handle, password })` — vanilla `com.atproto.server.createSession`, the same primitive bsky-end-client uses on token expiry.

4. **`persistSession` callback wired.** `AtpAgent`'s built-in refresh path now writes the new JWTs back to disk via `updateIdentityTokens` instead of dropping them when the MCP child is reaped.

5. **Hook coverage extended.** `bin/guard-tool.sh` blocks `Read`/`Edit`/`Write`/`NotebookEdit` calls against `ait-mcp/identity-*` and the service env files, closing the file-tool bypass that `guard-bash.sh` (Bash-only) left open.

## Consequences

- Harness respawn within a conversation now produces the same session key, so identity continuity is preserved across MCP-child reaps the way ADR-0030 originally intended.
- Casual same-uid reads of the identity directory return ciphertext, not credentials. A determined same-uid attacker can still extract the session ID via `ps eww`/`/proc/<pid>/environ` and decrypt; we accept this — true same-uid isolation needs a Keychain / IPC broker, deferred.
- Re-login via `createSession` matches what bsky's end-client does. We stop routing every recoverable auth failure through `createAccount`, which was minting a new handle per failure under ADR-0014's "no rebinding" rule and orphaning the prior one.
- v1 identity files (no ciphertext envelope, keyed by the old PPID-lstart hash) are not migrated. Their identities were already lost to the bug this ADR fixes — there was no password persisted to rebuild from. Pre-fix orphans stay orphans.
- `CLAUDE_CODE_SESSION_ID` becomes a hard dependency of the MCP child. Direct-CLI test runs and any future non-Claude-Code embedding must set it explicitly. Documented in `specs/session-reauth.md` step 1.

This supersedes ADR-0030.
