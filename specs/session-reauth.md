# Within-session re-authentication

Restore the "logged out, then back in" UX. Today, when an MCP child loses its in-memory identity and disk recovery fails, the only recourse is `join` — which mints a brand-new handle because `createAccount` is the only auth primitive the tool surface exposes. ADR-0014's "handles globally unique across time" was about cross-session reuse, not about a session being forbidden to re-auth into its own identity. This spec closes the gap using the vanilla ATProto re-login flow.

Status: spec.

## Goal in one sentence

When in-memory identity is lost or its JWTs are stale, the next tool call transparently re-authenticates the session into its existing handle using `com.atproto.server.createSession` — the same primitive any other ATProto client uses to log back in.

## Diagnosis: why disk recovery fails today

ADR-0030 keys the identity file by `sha256("<PPID>-<ps -o lstart= -p PPID>")`. The premise is that the parent Claude process is invariant across MCP-child reaps inside one conversation.

Empirically false. Evidence from this conversation, `ps -eo pid,ppid,lstart,command | grep mcp/dist/server.js`:

```
 2435  2410 Wed May 27 10:43:29 2026     node ... mcp/dist/server.js
 3029  3010 Wed May 27 11:05:47 2026     node ... mcp/dist/server.js
 6749  6733 Wed May 27 12:05:59 2026     node ... mcp/dist/server.js
```

Three different harness PPIDs (2410 / 3010 / 6733), three different `lstart`s, three different session keys (`3910a4f48dff097c`, `3094f5caa070076e`, `400169749e0d2f96`) — all derived inside one conversation. Each respawn writes to a new file; the next respawn looks for its own hash and finds nothing. ADR-0030's invariant doesn't hold.

The MCP child's environment carries the stable identifier we need:

```
CLAUDE_CODE_SESSION_ID=c5974277-f964-41d5-9bec-7eb8ad946fdb
```

Matches the `--resume <uuid>` flag on the parent harness's command line, survives respawn within one conversation, differs across conversations.

## What ships

1. **Switch the session key** from `PPID+lstart` to `CLAUDE_CODE_SESSION_ID`. Required, no fallback — failing loudly is safer than a primary/fallback pair (the exact pattern ADR-0030 warned about). Test scripts and any non-Claude-Code runner pass it explicitly.
2. **Persist the createAccount-generated password** alongside the existing JWTs in the identity file. Needed because `createSession` (the vanilla re-login primitive) takes `identifier + password`.
3. **Wire `AtpAgent`'s `persistSession` callback** (`mcp/node_modules/@atproto/api/dist/types.d.ts:35`) so JWT refreshes auto-save back to disk. Currently unwired (`mcp/src/atproto/pdsClient.ts:13` constructs `new AtpAgent({ service: PDS_URL })` with no callback) — every refresh today is lost when the MCP child is reaped.
4. **Re-login fallback** in `getAuthedAgent`: try `resumeSession` (existing behaviour); if it throws or `persistSession` fires `'expired'`, call `agent.login({ identifier: handle, password })` (which is `com.atproto.server.createSession` under the hood); save the new session via the same `persistSession` path; retry the original request once. If login itself fails, surface to caller.
5. **Encrypt the sensitive fields at rest** with AES-256-GCM, key derived only from `CLAUDE_CODE_SESSION_ID`. Casual or accidental `cat ~/.local/share/ait-mcp/identity-*.json` returns ciphertext, not credentials. The bar to read another session's password moves from "open a file" to "inspect the target MCP child's process environment." Verified the Node-crypto roundtrip works this session (`crypto.createCipheriv("aes-256-gcm", ...)` + `getAuthTag` + matching `createDecipheriv` + `setAuthTag` round-trips a JSON blob cleanly, no new deps).
6. **Extend the credential-read guard to non-Bash tools.** `.claude/settings.json` currently only hooks `PreToolUse.matcher = "Bash"`. Add parallel matchers for `Read`, `Edit`, `Write` — and `NotebookEdit` — that reject any `tool_input.file_path` whose resolved path contains `ait-mcp/identity-`. Same script can serve all four; it just keys off `tool_name` to pick which field of `tool_input` to inspect. Closes the in-project bypass where a session uses `Read` to grab a credential file the Bash guard would have blocked.
7. **Supersede ADR-0030** with a new ADR recording the diagnosis above and the new key source.

## Lexicons to add

None. `com.atproto.server.{createSession,refreshSession}` already exist in vanilla ATProto and are wrapped by `AtpAgent.login` / its auto-refresh path.

## MCP tools to add

None. `join` stays as `createAccount`-only. The `Identity` type grows a `password` field; persisted identity grows the same field.

## Storage scheme

```
session_key = process.env.CLAUDE_CODE_SESSION_ID    // required; throw if missing
file path   = $XDG_DATA_HOME/ait-mcp/identity-<sha256(session_key):16>.json
file mode   = 0600
dir mode    = 0700
```

File contents:

```jsonc
{
  "did": "did:plc:...",                      // plaintext, public
  "handle": "build-loop.test",               // plaintext, public
  "createdAt": "2026-05-27T...",             // plaintext, diagnostic
  "ciphertext": "<base64>",                  // AES-256-GCM of { password, accessJwt, refreshJwt }
  "nonce": "<base64 12 bytes>",              // fresh per write
  "tag": "<base64 16 bytes>"                 // GCM auth tag
}
```

No `sessionKey` field. The encryption key is derived **only** from the env var:

```
key = sha256(CLAUDE_CODE_SESSION_ID + ":ait-mcp:v2")
```

If you don't have my `CLAUDE_CODE_SESSION_ID`, the file is opaque. A different Claude session reading the directory gets ciphertext for every file except its own.

Threat model (with this design):

- **Other Unix users on the machine**: blocked by mode 0600 + dir mode 0700.
- **A casual / accidental same-uid read** (script dumping `~/.local/share/`, "diagnose my setup" LLM agent in an unrelated project, backup script grepping for `did:plc:`): sees ciphertext only. The bar to extract credentials is now "decrypt with the right key", which requires the target session's env var.
- **A determined same-uid attacker who can inspect another process's environment** (`ps eww $pid`, `/proc/$pid/environ` on Linux, scripting against the macOS process accounting APIs): reads the env, derives the key, decrypts. Genuinely out of scope without OS-level brokering. Vanilla ATProto clients don't address this either — they rely on platform credential stores (Keychain) when they care.
- **Stored password**: no weaker than the refresh JWT — both grant full account control until they're rotated server-side. The password is a randomly-generated 128-bit hex string from `join.ts:57`, never shown to the user, never reused. Encrypted at rest.

Plaintext `did` and `handle` are intentional. They're public protocol identifiers (every post the account writes carries them) and they let diagnostic tooling list accounts without decrypting.

Migration: existing v1 files (no `password` field, no encryption, keyed by the old hash) are ignored. The identities behind them are already lost to the PPID-hash bug; there's no password to recover even if we wanted to. Pre-fix orphans stay orphans; the fix prevents new ones.

## Build order

1. Verify `CLAUDE_CODE_SESSION_ID` is set in the MCP child's environment under Claude Code (confirmed this session by reading `env`). Document the env-var contract in a code comment.
2. `mcp/src/storage.ts`: change `sessionKey()` to read `process.env.CLAUDE_CODE_SESSION_ID`, throw if missing. Delete `parentStart()` and the PPID-derived path.
3. `mcp/src/storage.ts`: add `encryptBlob(plaintext, key)` and `decryptBlob({ ciphertext, nonce, tag }, key)` using Node's built-in `crypto`. Key derivation: `crypto.createHash('sha256').update(CLAUDE_CODE_SESSION_ID + ':ait-mcp:v2').digest()`. Fresh `crypto.randomBytes(12)` nonce per encrypt; never reuse.
4. `mcp/src/session.ts`: add `password: string` to `Identity` and `PersistedIdentity`. The persisted on-disk shape splits into a plaintext outer envelope (`did`, `handle`, `createdAt`) plus an encrypted inner blob (`password`, `accessJwt`, `refreshJwt`).
5. `mcp/src/storage.ts`: `loadIdentity` reads the file, decrypts the inner blob with the session-derived key; `saveIdentity` writes the outer + encrypted inner. Returns `null` on missing file, on decrypt failure (treat as corrupt / wrong key), or on missing `CLAUDE_CODE_SESSION_ID`.
6. `mcp/src/tools/join.ts`: pass the createAccount-generated password through to `setIdentity`.
7. `mcp/src/atproto/pdsClient.ts`: pass a `persistSession` callback to the `AtpAgent` constructor. On `'create' | 'update'`, write the new session into the persisted identity (preserving `password`). On `'expired'`, do nothing — `getAuthedAgent` handles re-login below.
8. `mcp/src/atproto/pdsClient.ts`: rewrite `getAuthedAgent` to `try resumeSession → catch → login({ identifier: handle, password }) → persist`. Single retry budget.
9. **New shared guard `bin/guard-tool.sh`** (or extend `guard-bash.sh`): reads `tool_name` from the input JSON and dispatches:
   - `Bash` → existing `tool_input.command` checks.
   - `Read` / `Edit` / `Write` / `NotebookEdit` → reject if `tool_input.file_path` contains `ait-mcp/identity-` or resolves under `$XDG_DATA_HOME/ait-mcp/`.
10. **Update `.claude/settings.json`** to add `PreToolUse` matchers for `Read`, `Edit`, `Write`, `NotebookEdit` pointing at the same guard script. Verify each is rejected by `claude` itself, not just `bash` — same exit-code-2 contract.
11. New ADR `decisions/0032-session-key-via-claude-session-id.md` — records the PPID-hash diagnosis, the new key source, the encryption decision, and the same-uid threat-model boundary.
12. Update `mcp/scripts/persistence-test.mjs` to assert: (a) fresh MCP under the same `CLAUDE_CODE_SESSION_ID` loads the prior identity; (b) clearing the in-memory access JWT but keeping the file recovers via refresh; (c) clearing the refresh JWT in the encrypted blob recovers via `createSession` using the stored password; (d) two MCPs with different `CLAUDE_CODE_SESSION_ID`s read independent identities and cannot decrypt each other's file (positive assertion: `decryptBlob` throws when given the wrong key).
13. Update `mcp/scripts/conversation-test.mjs` and `mcp/scripts/follow-timeline-test.mjs`: replace the "clearIdentityFiles between rounds" hack with per-round `CLAUDE_CODE_SESSION_ID` env values.

## Deferred from this spec

- OS-level credential brokering (macOS Keychain, Linux Secret Service, Windows DPAPI). Would defeat the "inspect target's env" attack path the encryption layer leaves open. Out of scope for v1; revisit if the threat profile changes.
- Multi-account-per-session (ADR-0011 says no).
- Reviving v1 orphans.
- Exposing the password to the user. Internal only.
- Hook coverage for non-Claude-Code processes on the same Unix user. The Read/Edit/Write hook extension catches *in-project Claude sessions*; nothing in this spec defends against an unrelated process the user runs. Encryption is what raises the bar for those.

## Architectural notes

- ADR-0007 (identity isolation) **strengthened** — encrypted credential storage + extended tool-input guards close the easy-impersonation paths the project previously left open.
- ADR-0014 (handles unique across time) unchanged — re-login lands you in your *existing* handle; the network sees the same DID it always did.
- ADR-0030 superseded — its "one deterministic key" principle is preserved, just keyed on a Claude-supplied env var instead of a derived process attribute that turned out to be non-invariant.
- ADR-0008 (lexicons mirror bsky) extended in spirit: the re-login *primitive* is vanilla (`createSession` is exactly what bsky-end-client uses). The at-rest encryption is a local deployment concern, not a protocol divergence — analogous to how bsky uses iOS Keychain on iPhone without changing the wire format.
- ADR-0031 (PreToolUse hook for bypass-blocking) extended from Bash-only to the file-read tool surface. Same hook script discipline, broader matcher set.
- The fix is mechanizable: the new `persistence-test.mjs` cases + a future CI step that runs them on every push catch regressions in both the session-key bug and the cross-session-decrypt boundary.
