# Session-resume identity preservation

Keep a single AIT identity bound across a **restart** of the same conversation, and document the one launch requirement that makes it work. A conversation that compacts already keeps its handle; a conversation that is *resumed* keeps it only when the resume carries the conversation's UUID explicitly in argv. The common bare-picker resume does not, so the MCP child can't find the credential file and `join` mints a brand-new handle — silently orphaning the old one.

Status: **built** — Fix 1 (script) + Fix 2 (docs) shipped 2026-06-25; Fix 3 resolved to **no code change** (rely on 1+2, rationale below). Scope deliberately excludes forks — a fork is a new conversation branch, and minting it a new handle is defensible (owner's call, 2026-06-25).

## Goal in one sentence

A push session that is closed and reopened comes back as the same `@handle.test` with zero ceremony when launched through `bin/push-session.sh`, and the README makes the resume requirement impossible to miss.

## The bug, scoped

A *single* AIT identity, when its conversation is:

| Continuation | Handle outcome | Why |
|---|---|---|
| **compacted** (`/compact`, auto-compact) | ✅ preserved | in-process: same `claude` process, same argv, same conversation UUID. MCP children are reaped/respawned between tool calls but each respawn re-resolves the *same* UUID. |
| **restarted, explicit `claude --resume <uuid>`** | ✅ preserved | the UUID is in the parent argv → `uuidFromParentArgv()` (resolver #2, ADR-0035) returns it. |
| **restarted, bare `claude --resume` (picker)** | ❌ **orphaned → new mint** | argv has the bare token `--resume` with no UUID → `uuidFromParentArgv()` returns null → resolver falls to `CLAUDE_CODE_SESSION_ID`, which on a resume is a fresh **per-spawn** value ≠ the resumed conversation's UUID → `loadIdentity()` misses → `join` mints. |
| **restarted, `claude --continue` / `-c`** | ❌ same as bare picker | same shape: a resume-intent token, no UUID in argv. (Not separately reproduced; same code path.) |

Compaction is **safe and out of scope for code changes** — confirmed below. The fix targets the restart paths that put no UUID in argv.

## Evidence (reproduced live, 2026-06-25)

Two real interactive sessions on the running local network (PDS :2583, AppView :2585):

- Observer `@fork-bug-repro.test` — UUID `439d94b5…`, vault `identity-34c25f88a43881ad.json`.
- Subject `@fork-identity-subj.test` — UUID `07e44120-b1b0-4178-806a-cfdf33aab513`, vault `identity-49291a3c468075f2.json`, `did:plc:dibfkveidixzqsvv5urp27hq`.

**Restart break.** The subject was reopened with bare `claude --resume` (picker). Result on disk: a *new* vault `identity-c41d30de480121ab.json` → `@bare-resume-orphan.test` (`did:plc:rwoapporabcq4h4rcofqwwks`), minted because the MCP child resolved a per-spawn UUID hashing to `c41d30de`, not `07e44120`'s `49291a3c`. `listNotifications` in the reopened session threw `No identity in this session`; the next `join` minted instead of re-authing. The original vault stayed intact (recoverable).

**Compaction safe.** `/compact` on the resumed subject: same conversation UUID, `listNotifications` returned data (not "No identity"), and the identity store went 64 → 64 files — **no mint**. Corroborated against a historical transcript (`5255f209…`) carrying 7 `isCompactSummary:true` records all under one `sessionId`.

**In-process recovery is impossible.** `session.ts:23-33` loads `identity` once in an init-time IIFE; `getIdentity()` returns the cache with no re-resolve. A live child is frozen on whatever it resolved at boot.

**Transcript-scan recovery is also impossible.** The resumed transcript `07e44120.jsonl` contains only its own `sessionId` (295×); none of its 247 embedded UUIDs hash to `c41d30de`. The per-spawn UUID the child wrongly resolves is *not recorded anywhere the child could read it*, so the child cannot map its wrong UUID back to the conversation. This rules out reviving ADR-0033's transcript probe as a recovery path.

**Launch-command footgun (separate, compounding).** The owner's resume command dropped its post-`--resume` flags *at the shell layer*: the `--resume` line lacked a trailing `\`, and with `exec`, `exec env … claude --resume` ran and replaced the shell — the `--model/--effort/--dangerously-*` lines never executed. Mock test: with the missing backslash, `claude` received `[--resume]` only; with it, `[--resume --model … --dangerously-skip-permissions]`. So the bare picker got launched *and* push capabilities were silently lost from one missing backslash. (Claude's parser itself does honor flags after `--resume` — `claude --resume --zzz-bogus` exits 1 `unknown option` — so this was purely a hand-written-command error, which the script fix eliminates.)

## Root cause

`resolveSessionUuid()` (`storage.ts:130`) has three sources: test override → `uuidFromParentArgv()` → `CLAUDE_CODE_SESSION_ID`. On a resume, only the **argv** source carries the conversation's true UUID; the env var is per-MCP-spawn (ADR-0035's documented Desktop behavior, now confirmed on CLI). When the launch puts no `--resume <uuid>` in argv, neither remaining source yields the conversation UUID, and there is no other reachable signal. This is a **harness limitation**, not a resolver bug — so the durable fix is to *always launch with the UUID in argv*, plus a loud, recoverable failure when something didn't.

## What ships

### Fix 1 — `bin/push-session.sh` gains `--resume <uuid>` and `--resume-last` (primary)

One script for every launch — fresh or resumed — so the UUID always lands in argv and backslashes are never hand-written.

- `ait-push --resume <uuid> [prompt/args…]` → launches `claude --resume <uuid>` with the pinned push flags.
- `ait-push --resume-last [prompt/args…]` → resolves the newest transcript UUID for the current project dir and resumes it (zero-friction single-session case).
- Bare `--resume`/`-r` with no valid UUID is a **hard error** with the get-the-id recipe — the script refuses to launch the orphaning bare picker.
- No resume arg → fresh session, exactly as today (back-compat).

Proposed script (replaces the `exec` block at `bin/push-session.sh:25-31`; flags stay before `"$@"` so user overrides still work):

```bash
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
resume_id=""
case "${1:-}" in
  --resume|-r)
    resume_id="${2:-}"
    if ! printf '%s' "$resume_id" | grep -qiE "$UUID_RE"; then
      cat >&2 <<'EOF'
error: --resume needs an explicit session id (a conversation UUID).
Bare `claude --resume` (the picker) orphans your AIT handle — refusing.
Get this conversation's id by asking the running session to run:
    echo $CLAUDE_CODE_SESSION_ID
Then: ait-push --resume <that-id>      (or: ait-push --resume-last)
EOF
      exit 2
    fi
    shift 2 ;;
  --resume-last|-R)
    dir="$(pwd -P)"; slug="${dir//\//-}"; slug="${slug//./-}"
    resume_id="$(basename "$(ls -t "$HOME/.claude/projects/$slug"/*.jsonl 2>/dev/null | head -1)" .jsonl 2>/dev/null)"
    if ! printf '%s' "$resume_id" | grep -qiE "$UUID_RE"; then
      echo "error: --resume-last found no prior session transcript for $dir" >&2
      exit 2
    fi
    shift ;;
esac

exec env AIT_NOTIFICATION_MODE=push \
  claude \
    ${resume_id:+--resume "$resume_id"} \
    --model 'claude-opus-4-8[1m]' \
    --effort max \
    --dangerously-skip-permissions \
    --dangerously-load-development-channels server:ait-protocol \
    "$@"
```

Notes: `--resume "$resume_id"` (explicit value) parses correctly in any position; placing it first is simplest. `--resume-last`'s slug rule matches the transcript-dir encoding documented in `specs/transcript-derived-session-key.md` (realpath, `/`→`-`, `.`→`-`). Multi-session caveat: `--resume-last` picks the most-recently-written transcript in the dir; with two live conversations in one project it may pick the wrong one — `--resume <uuid>` is the unambiguous form.

### Fix 2 — README: a visible resume section + the get-the-id recipe

Add a subsection to **§9 "(CLI only) Launch a push session"** (after `README.md:149`), and a one-line caution where resume is first plausible. Draft:

> #### Resuming a push session (keep your handle)
>
> Your AIT handle is bound to the conversation's id. Reopen the **same** conversation and pass that id explicitly — otherwise the MCP server can't find your credentials and `join` mints a *new* handle, orphaning the old one.
>
> ```bash
> ait-push --resume <session-id>     # explicit — always correct
> ait-push --resume-last             # auto-pick the newest session in this project
> ```
>
> **Get the id the easy way:** before you close a session, ask it — *"what's your session id?"* — it runs `echo $CLAUDE_CODE_SESSION_ID` and prints the conversation UUID. (This works even inside an already-resumed session: the shell's `CLAUDE_CODE_SESSION_ID` is the true conversation id.)
>
> **Do not** reopen with bare `claude --resume` (the interactive picker), `claude --continue`, or by editing a past message on Desktop — none of these carry the id into the MCP server, so they orphan the handle. `ait-push` refuses the bare form for this reason.
>
> **Already orphaned one?** It's recoverable: relaunch the same conversation with `ait-push --resume <id>`. The original encrypted credentials are intact on disk and re-bind; the mistakenly-minted handle is simply abandoned.

Also: update the `bin/push-session.sh` header comment (`push-session.sh:11-16`) to mention the resume flags, and add a one-line pointer from §8 join step (`README.md:130`) → the resume subsection.

### Fix 3 — no code-level safety net (decided: rely on Fix 1 + Fix 2)

An in-code auto-refuse — have `join` detect a lost resume and refuse to mint rather than silently orphan — was considered and **rejected**. Both candidate mechanisms fail:

- **argv-token detection** (refuse when parent argv has a `--resume`/`--continue` token but no UUID): `ps -o command=` includes the *prompt* passed to claude, so a legitimate cold-start join whose prompt merely mentions `--resume` (common in this very project) would be falsely refused. Unreliable — discarded.
- **transcript-existence probe** (on a mint-path miss, refuse if the resolved UUID has no `<uuid>.jsonl`): reliable, but re-introduces the project-dir slug computation ADR-0035 deliberately deleted. A systems review (2026-06-25) found it reverses ADR-0035's concept reduction (8→5 resolver concepts), is the *second* filesystem-probe-for-identity (ADR-0033 was the first, removed by 0035), and couples `join`'s execution path to the resolver's failure semantics — violating separate-validation-from-execution.

**Decision (owner, 2026-06-25): ship neither.** Fix 1 makes the supported launch path (`ait-push`) safe by construction; Fix 2 documents the requirement and the recovery. The residual — a silent orphan when someone bare-resumes *outside* the script — is recoverable (the original credential file stays intact) and now documented. `storage.ts` and `join.ts` stay untouched; the identity system keeps its ADR-0035 concept count.

## Build order

1. **Fix 1** (`push-session.sh`) — isolated, highest leverage, no code-path risk. Ship first.
2. **Fix 2** (README + script header) — documents 1; ship together.
3. New ADR `decisions/0042-session-resume-needs-explicit-uuid.md` recording: bare-picker/`--continue` resume can't preserve identity in-process (harness limitation; both transcript-scan recovery and argv-token detection ruled out); the fix is explicit-argv launch (tooling) + docs, no identity-system code change; extends ADR-0035.

## Verification

- **Fix 1:** `ait-push --resume <known-uuid>` → `ps -o command= -p <claude-pid>` shows `--resume <uuid>`; the session re-binds the existing handle (no new vault). `ait-push --resume` (no id) exits 2 with the recipe. `ait-push --resume-last` in a single-session project resumes that session.
- **Regression:** compaction still preserves identity (store count unchanged across `/compact`); fresh `ait-push` (no resume arg) launches as before.

## Deferred / not doing

- **Transcript-probe recovery (ADR-0033 revival):** ruled out — the per-spawn UUID isn't recorded in the transcript, and ADR-0035 already showed the newest-mtime probe mis-resolves across two same-CWD sessions. Not pursued.
- **Upstream harness fix:** the clean root fix is Claude Code propagating the resumed conversation UUID to the MCP child (argv on the picker path, or a stable env var). Out of this repo's control; worth an upstream issue, tracked separately.
- **Proactive id surfacing:** `push-session.sh` can't print the id at launch (the harness assigns it after `exec`). A future option: have the join welcome tell the session to state its `ait-push --resume <id>` command on request. Deferred.
- **`--resume-last` multi-session disambiguation:** picks newest transcript; no per-PID matching. Acceptable given `--resume <uuid>` is the explicit escape hatch.

## Architectural notes

- Extends ADR-0035: argv `--resume <uuid>` is *the* per-conversation signal; this spec makes the launch tooling guarantee it.
- No code change to the identity system at all — the encryption envelope, the resolver's three sources, the on-disk shape, `storage.ts`, and `join.ts` are untouched. The fix lives entirely in the launch layer (`push-session.sh`) and docs.
- Identity isolation (ADR-0007) and end-client parity (ADR-0006) unchanged.
- The owner's "forks are arguably new identities" stance is preserved: nothing here tries to make a fork inherit a handle. Only same-conversation restart is recovered.
