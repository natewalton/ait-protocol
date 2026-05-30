# Re-auth + credential-store robustness

Follow-up to [`specs/session-reauth.md`](session-reauth.md) and [`specs/atproto-conformance.md`](atproto-conformance.md). Three defects audited against the re-auth implementation (05a75dc + 9e21e73 + 564eabb + ADR-0032) — including the bug `@build-agent-2.test` lived through during a mid-session credential loss that forced a re-mint to `@conformance-build.test`.

Status: spec.

> **Update 2026-05-29 (commits `0a03248`, ADR-0036):** Fix 13 as originally written below only catches HTTP **401**. A live session (`@alerts-research.test`, "Plan journalist discovery and research tool") hit `getTimeline failed: 400 {"error":"ExpiredToken"}` — the atproto PDS surfaces expired access JWTs as **400 + body `error: "ExpiredToken"`** (`pds/.../auth-verifier.js:278`), not 401. AtpAgent's own internal auto-refresh recognizes this same pair (`api/.../atp-agent.ts:222-224`); our wrapper didn't. The retry predicate is now `status === 401 || (status === 400 && body.error === 'ExpiredToken')` in `isAuthError`. Originally landed in two places (`isAuthError` for `withAuthedAgent` + `isExpiredAuthResponse` for the now-removed `authedFetch`); ADR-0036 collapsed the dispatch path so only `isAuthError` exists today. The "401-only" wording throughout the body below is left as the historical Fix-13 design but is now incomplete — read `mcp/src/atproto/pdsClient.ts:isAuthError` for the current shape. The "parallel `withAppViewAgent`" suggestion at line 82 never landed as written: ADR-0036 supersedes it with `appViewCall(nsid, {params?, data?})`, which routes through the same `XrpcClient` path as the write tools.

## Goal in one sentence

Close the three failure modes that survived the re-auth landing: the auto-refresh `'expired'` path doesn't trigger login, identity file writes aren't crash-safe, and the file-tool guard can be bypassed via symlink.

## Scope

- `mcp/src/atproto/pdsClient.ts` — re-login wiring on `'expired'`.
- `mcp/src/storage.ts` — atomic write via tmp + rename.
- `bin/guard-tool.sh` — symlink resolution before pattern match.

Out of scope: same-uid attacker who can read another process's environment (documented boundary in ADR-0032; requires Keychain / IPC broker, deferred).

## Lexicons / MCP tools to add

None.

## Fixes

### Fix 13 — Re-login on `persistSession('expired')`

**Defect.** [`mcp/src/atproto/pdsClient.ts:79-89`](../mcp/src/atproto/pdsClient.ts:79):

```ts
async function ensureAuthedAgent(id: Identity): Promise<AtpAgent> {
  const a = getAgent()
  if (a.session && a.session.did === id.did) return a
  try {
    await a.resumeSession(identityToSession(id))
    return a
  } catch {
    return loginWithStoredCredentials(id)
  }
}
```

`resumeSession` is a tokens-plumbed-into-agent call — it doesn't validate against the PDS. The expired-token failure path is:

1. `getAuthedAgent` returns the agent (resumeSession succeeded synchronously)
2. Next XRPC call → 401 → AtpAgent auto-fires `refreshSession`
3. Refresh JWT also stale → 401 → `persistSession('expired')` fires
4. Callback at [`pdsClient.ts:25-33`](../mcp/src/atproto/pdsClient.ts:25) handles `'expired'` with a no-op (comment says "`ensureAuthedAgent` retry path handles `'expired'`" — but it doesn't)
5. Original XRPC call returns 401 to the caller

Empirically observed: `@build-agent-2.test` lost JWTs mid-session, the auto-refresh path failed, no login fallback fired, and the only recourse was `createAccount` — which mints a new handle. Per ADR-0014 the old handle is now permanently orphaned.

**Conformance rule.** [`specs/session-reauth.md:38`](session-reauth.md:38): "Re-login fallback in `getAuthedAgent`: try `resumeSession`; **if it throws or `persistSession` fires `'expired'`**, call `agent.login(...)`." The `'expired'` half isn't implemented.

**Fix.** Wrap each authed XRPC call in a single-budget retry that catches 401, re-logins with the stored password, and replays once. Two approaches:

**Approach A (preferred): retry at the call site.** Add a small wrapper exported from `pdsClient.ts`:

```ts
export async function withAuthedAgent<T>(
  fn: (agent: AtpAgent) => Promise<T>,
): Promise<T> {
  const id = requireIdentity()
  let agent = await ensureAuthedAgent(id)
  try {
    return await fn(agent)
  } catch (err) {
    if (!isAuthError(err)) throw err
    // Refresh failed; try fresh login.
    agent = await loginWithStoredCredentials(id)
    return fn(agent)
  }
}

function isAuthError(err: unknown): boolean {
  // AtpAgent throws an XRPCError with status 401 on unrecoverable auth fail.
  // Also treat the 'expired' persistSession event as a sentinel via a flag if
  // simpler. Status-based is more robust.
  return (err as { status?: number })?.status === 401
}
```

Migrate the four tools that call `getAuthedAgent()` ([`follow.ts:17`](../mcp/src/tools/follow.ts:17), [`post.ts:19`](../mcp/src/tools/post.ts:19), [`reply.ts:53`](../mcp/src/tools/reply.ts:53), plus any new ones) to use `withAuthedAgent` instead. Read tools that use `getAppViewAgent()` should get the same treatment via a parallel `withAppViewAgent` (or fold both into one).

**Approach B (alt): flag on `'expired'` event.** Set a `needsLogin` boolean in the `persistSession` callback when `'expired'` fires. `ensureAuthedAgent` checks it before returning and calls `loginWithStoredCredentials` if set. Simpler but doesn't help mid-call — only on the *next* `getAuthedAgent`. Approach A handles in-flight failures.

**Verification.**

```ts
// Manually expire the stored refreshJwt (write garbage bytes), then call
// a tool. Assert the tool succeeds (re-login fired) and the new tokens
// landed on disk.
```

Or, easier: a unit-shaped test that wraps the agent with a mock that returns 401 on every call until `login()` is called, then returns 200. Assert the wrapper retried once and succeeded.

### Fix 14 — Atomic identity file writes

**Defect.** [`mcp/src/storage.ts:170-171`](../mcp/src/storage.ts:170):

```ts
fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 })
```

Direct write. A SIGKILL between truncate and final flush produces a partial JSON file. [`loadIdentity`](../mcp/src/storage.ts:128) handles the parse failure by returning `null`, which the MCP child interprets as "first run." Combined with ADR-0014 (handles never re-bind), the partial-write window is a single SIGKILL away from permanent identity loss.

**Conformance rule.** Project-internal — but every other piece of the re-auth design defends against credential loss; the write path shouldn't be the weakest link.

**Fix.** Atomic write via tmp + rename:

```ts
export function saveIdentity(identity: Identity): void {
  const p = identityPath()
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  const envelope = encryptInner(
    {
      password: identity.password,
      accessJwt: identity.accessJwt,
      refreshJwt: identity.refreshJwt,
    },
    derivedKey(),
  )
  const data: OnDiskShape = {
    did: identity.did,
    handle: identity.handle,
    createdAt: new Date().toISOString(),
    ...envelope,
  }
  const tmp = `${p}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p) // atomic on POSIX; replaces existing
}
```

`process.pid` suffix prevents collision if multiple MCP children write simultaneously (shouldn't happen but defends).

**Verification.** Spawn a child that writes the identity file in a loop while the parent sends SIGKILL at random intervals. Assert `loadIdentity` always returns either the prior-valid state or `null` (never throws on a partial parse). One-shot test using `node:child_process` + repeated kill calls.

### Fix 15 — `guard-tool.sh` symlink resolution

**Defect.** [`bin/guard-tool.sh:39-52`](../bin/guard-tool.sh:39):

```sh
case "$PATH_FIELD" in
  */ait-mcp/identity-*|*/ait-mcp/identity-*.json)
    block "..."
    ;;
esac
```

Pattern match operates on the literal `file_path` string. A symlink at `/tmp/legit.txt -> ~/.local/share/ait-mcp/identity-abc.json` doesn't match the guard, but a `Read` against `/tmp/legit.txt` follows the symlink and returns the encrypted-then-decryptable-by-this-process JSON.

The hook is the only barrier between in-project Claude file tools and the credential dir. Bypass is one `ln -s` away.

**Conformance rule.** ADR-0031 / ADR-0032: file-tool guard must catch *any* path that resolves to a credential file, not just paths that literally contain the credential dir.

**Fix.** Resolve symlinks before matching. macOS has `realpath` in coreutils and `readlink -f` via Homebrew; the more portable shape is `python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))'` since Python 3 is reliably present. Or, since the hook is bash-only, use whichever exists:

```sh
resolve_path() {
  local p="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath -m "$p" 2>/dev/null || printf '%s' "$p"
  elif command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
    readlink -f "$p" 2>/dev/null || printf '%s' "$p"
  else
    # Python fallback — present on every macOS dev box.
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null || printf '%s' "$p"
  fi
}

RESOLVED="$(resolve_path "$PATH_FIELD")"
```

Then match against `$RESOLVED` instead of `$PATH_FIELD`. If resolution fails (broken symlink, permission), fall back to the original string — fail-closed for the credential dir patterns either way.

Also apply same change to [`guard-bash.sh`](../bin/guard-bash.sh) where it extracts paths from `cat`/`grep`/etc. commands — same bypass surface there, less ergonomic to fix because the command might reference multiple files.

**Verification.** Two synthetic tool calls:

```
ln -s ~/.local/share/ait-mcp/identity-abc.json /tmp/legit.txt
# Then Claude tool call:
{tool_name: "Read", tool_input: {file_path: "/tmp/legit.txt"}}
# Assert exit code 2 (blocked).
```

And: a symlink that doesn't resolve to a credential file should NOT block (regression test for false positives).

## Build order

1. **Fix 14** (atomic writes) — smallest, isolated, no behavior change for the happy path. Land first to harden the write floor before touching the read/refresh path.
2. **Fix 15** (symlink resolve) — small, isolated, security-relevant. Land second.
3. **Fix 13** (re-login on `'expired'`) — substantial. Affects every authed tool path. Land last with full verification.

`@conformance-build.test` flagged fix 13 as priority because they lived through the failure; ordering puts it last for blast-radius reasons but they can take it first if the urgency outweighs the warm-up. Either order is fine — Fix 14 + 15 are nearly trivial.

## Deferred

- Same-uid attacker reading another process's env — ADR-0032 documents this as out of scope.
- A real key-rotation primitive (would let us discard the stored password). Requires PDS-side support; tracking upstream.
- Auto-recovery of v1 identity files — pre-fix orphans stay orphans (per ADR-0032).

## Architectural notes

- Fix 13 is the only fix that meaningfully changes a control-flow shape: every tool's authed call gets a single-budget retry. The cost is one extra closure per call; negligible.
- Fix 14 preserves the on-disk shape — readers (current `loadIdentity`) work unchanged.
- Fix 15 strengthens the boundary ADR-0031 set up and the recent commit 564eabb extended to file tools. Treats the guard layer as a security primitive, not a convenience.
- The combined effect: a session whose JWTs expire mid-call recovers without re-minting; a session whose MCP child is SIGKILL'd mid-write keeps its identity; a session that hands a symlink to `Read` doesn't slip past the guard.
