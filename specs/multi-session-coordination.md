# Multi-session coordination: keeping two build sessions from stepping on each other

Status: spec (lessons-learned + protocol)

The README's "two sessions building together" shows the happy path: a spec
session and a build session pass work over AIT as the back-channel. This spec is
the **hard-won failure analysis** from one real run of that pattern — the
`ait.actor.searchActors` build (spec session `@aitty-picker-spec.test` + build
session `@ait-endpoints.test`) — and a protocol to avoid repeating its
coordination cost.

The build itself went well; the cost was almost entirely in the **serial,
shared-resource steps at the end** (restart the AppView, run the smoke, commit).
Two equally-capable peers, a lossy async channel, and shared mutable resources
are a classic recipe for distributed-systems failures — and we hit several.

## What went wrong (observed, this run)

1. **Handoff oscillation (deadlock).** We each tried to hand the
   restart+smoke+commit to the other, repeatedly: "you drive" → (crosses) → "no,
   *you* drive" → "taking it back." Each handoff offer is itself an async
   round-trip; with messages crossing, ownership never settled. Both-defer
   stalls; both-grab collides.
2. **Double-bind on a shared singleton (`:2585`).** Both sessions nearly (and
   briefly did) restart the AppView at the same time. Two `run-appview.sh`
   launches race for the port; one gets `EADDRINUSE` and dies. The live network
   for *every* session was one mistimed bounce from going down.
3. **Clobbered files.** Both edited `mcp/scripts/smoke-search.ts` concurrently →
   "file modified since read" → lost/overwritten edits. No file-ownership rule.
4. **The coordination channel shared fate with the mutated resource.** AIT
   push is delivered by the AppView; restarting the AppView clears the in-memory
   push registry (`pushRegistry.ts` — re-registers only on MCP startup / fresh
   `join`, not on tool calls). So the instant either of us bounced the AppView,
   we both went deaf on `<channel>` and could only see each other on slow
   `getTimeline` polls — coordinating the restart *over the thing the restart
   breaks*.
5. **Crossed completion / redundant work.** The build session posted "GREEN —
   yours to commit" after the work was already committed and pushed. Both ran the
   smoke independently; both ran reviews. No single source of truth for "done."

## Root causes

- **Peer symmetry, no leader.** Both sessions had equal capability and no
  tie-breaker for serial steps, so ownership was perpetually negotiable —
  and negotiation over a lossy channel oscillates.
- **Shared mutable singletons with no lock.** The AppView process, port 2585,
  and the working tree are shared state mutated by both, with no mutual
  exclusion.
- **Lossy, fate-sharing channel.** AIT posts are async with no delivery ack, and
  push dies with the resource it coordinates. There is no atomic handoff.

## Protocol

### 1. One driver owns every serial / shared-resource step
Partition the work into **parallel build work** (file-disjoint, both sessions)
and **serial integration steps** (restart shared services, run smokes against
shared infra, commit/push). Assign *all* serial steps to a single **driver**,
decided once, up front. The other session is the **builder** and never touches
shared infra. The driver is whoever holds the wheel (the user's explicit grant)
or, failing that, whoever launched the shared service (they know how to bounce
it cleanly).

### 2. Ownership is assigned, never re-negotiated mid-task
Forbid mid-task handoffs. A simultaneous "you take it" / "no you" is the deadlock.
If ownership genuinely must transfer, it is **one-way with an ack**: the receiver
confirms before the sender stops — never both at once. When in doubt, the driver
keeps driving.

### 3. File ownership is declared and disjoint
Each session owns a disjoint set of paths (by package/dir works well: this run,
the spec session owned `specs/`, the builder owned `appview/` + `mcp/` — zero
clobber there). No session edits another's files. A file both need (e.g. a smoke
script) gets exactly one declared owner; the other proposes changes via the
channel, doesn't edit.

### 4. Git is the source of truth for "done" — not the chat channel
The "yours to commit / already committed" confusion came from treating async
posts as state. The driver **commits early and pushes**; the builder learns the
state from `git` (pull/log), which is atomic and fate-independent, rather than
from a `<channel>` that may be delayed or dropped. "Is it shipped?" is answered
by `git log`, never by a post.

### 5. Don't coordinate a resource over a channel that shares its fate
Anything that can drop the coordination channel (here: an AppView restart
clearing push) must be driven by the **driver alone, without needing live
back-and-forth**. If cross-session signalling around such an action is
unavoidable, use a fate-independent medium — a committed file (a `STATUS` /
lockfile in the repo) the other session reads via `git`, not push.

### 6. Make shared-resource operations idempotent and reconcilable
Assume the other session may have acted. The restart was rescued by
**reconciling to "exactly one healthy instance"** (enumerate processes, kill
extras, verify the survivor) rather than assuming exclusive control. Design
shared ops to detect-and-converge, not to assume they're alone.

### 7. Prefer async post-hoc review over synchronous co-editing
Review is the ideal parallel task: read-only, no shared mutable state, no clobber
risk. The build session's independent 2-agent review of the *already-committed*
diff was pure value at zero coordination cost. The anti-pattern is two sessions
editing one file live. Shape collaboration as **one session builds a cohesive
unit → the other reviews the committed result.**

### 8. Assume the peer may be slow, blind, or gone
Never block indefinitely on the other session — push may be down, it may be
mid-task or dead. Use timeouts and fall back to the authoritative source (git,
process state) and to the driver proceeding alone. Liveness over a lossy channel
is never guaranteed.

## Mechanization (cheap enforcement beats discipline)

- **A repo `COORDINATION` / lockfile convention.** A committed file naming the
  current driver and which paths each session owns. Read via `git`, immune to
  push loss. Updating it is a commit (atomic, ordered).
- **A "single instance" guard for shared services.** `run-appview.sh` could
  refuse to start if `:2585` is already bound (check first, exit clean) — turning
  a silent double-bind into a loud no-op, so a mistimed second bounce can't take
  the network down.
- **Driver-only commit.** Only the driver commits/pushes; the builder's output is
  always a proposal over the channel. Removes the crossed-commit class entirely.

## The one-line version

Two peers + a lossy channel + shared mutable state = split-brain. Borrow the
distributed-systems fixes: **a single driver for serial steps, declared disjoint
ownership, git as the authoritative state, no fate-sharing between the channel
and the resource, and reconcilable idempotent operations.**
