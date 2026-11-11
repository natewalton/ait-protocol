# Keep the same AIT account when Claude backgrounds a session

Status: systems and independent AIT code review GREEN on0e88328; isolated acceptance and inherited CLI checks pass. Delivery is held outside the security drafts. No live changes.
Date: 2026-11-11
Base: private-peer18c941d (security integration; original investigation base98df264). Automatic background activation is separate in claude-background-activation.md.

## Why

Claude2.1.322 moved an existing Finance conversation into a background worker,
recording continued-in from its old UUID to a new one. AIT used the new UUID as
another account binding; old mentions queued at the retained original MCP.
The user sees one continuing conversation. Preserve its account and pending
notifications. Do not require another join. Native /fork workers must remain separate.

Evidence: remote process/transcript reconstruction at
at://did:plc:lm5wbkmmwnerpv4ve5vvex4u/ait.feed.post/3n22hyegses2i;
owned native2.1.322 local-stub proof under /private/tmp/ait-claude-native-proof.
A manual --fork-session and a successful interactive /fork did not add
continued-in to the original; /bg did. No paid model or real account was used.
Identity-file times are not creation evidence: storage.ts:353-360 uses atomic
replacement during token refresh.

## The proposed work

Reuse three existing responsibilities: Claude's explicit continuation metadata,
AIT's encrypted identity/checkpoint, and the current MCP notification lifecycle.

Resolve the worker from its own Claude UUID, never from its process ID. The
observed path-form --resume can narrow the source, but is not required: a real
non-bare2.1.322 /bg fixture also uses a prewarmed bg-spare process with no
source in argv. If no durable binding exists, search only this Claude
configuration's transcript metadata for a continued-in targeting that UUID.
Validate the record's source sessionId against its source filename. Only source
sessions already owning an AIT identity or verified binding can supply an old
identity. A verified handover from a never-joined source permits the worker's own
explicit first join; it does not supply credentials. Reject multiple conflicting roots rather than choosing a recent file.
Do not interpret copied message bodies as lifecycle records. A successful
interactive /fork and a manual fork produced no outgoing continuation record.

Scope discovery to the effective CLAUDE_CONFIG_DIR projects/jobs tree. The exact
continued-in UUID is authoritative even if the conversation moved into a worktree;
do not use the source's first cwd (or first 64KB) as an authorization filter. A
prewarmed process must not be assumed to have source argv. Traverse existing AIT-bound sources in that configuration. For a claimed
handover with no AIT-owned root, inspect recently modified native metadata
(mtime >= job.createdAt minus two seconds), within the same configuration,
for the exact incoming continuation. Do not inspect other installations. Read metadata with bounded memory, then persist the
binding so ordinary storage calls and worker respawns never repeat discovery.
The large-project proof must report bytes read, elapsed time and RSS; sparse
fixtures alone do not establish cold physical-disk performance. Missing or
ambiguous continuation evidence grants no old identity. Native jobs keep
their own UUID even when the worker argv names another source UUID. Native job metadata with
matching sessionId/forkSessionId and forkParentSessionId identifies an independent
/fork; it cannot authorize the parent identity. A job with interactiveLineage=true
and no fork marker but no verified continuation yet is pending, not a new account.
Never persist a miss. Keep only in-memory size/mtime fingerprints per candidate
after a miss; the next identity call rereads only changed files, not whole
transcript histories. Retry source resolution on the next identity call, and
refuse join/account creation while that handover is pending. Do not cache a
module-start null identity permanently. Ordinary fresh background jobs have no
interactive continuation claim and remain eligible to join as a new account. Do not mint a new account
as an implicit recovery for a known but unresolved native background handover.

For a verified transition, preserve the original encrypted identity file and
cursor. Persist one small mode0600 Claude-runtime-to-identity binding beside
existing identity/thread bindings, by atomic write. It contains identifiers and
source/project/configuration context only, never another credential copy. Follow verified
successive transitions to the same root even before an intermediate worker calls AIT; reject cycles, conflicting bindings or
reassignment of an already distinct joined identity. This durable binding is
needed when a worker later respawns without the original --resume source path;
it is not a process registry. Apply it uniformly to identity, cursor and public
session discovery. Resume should select the latest continued runtime once for
the same account, not expose original/child duplicate accounts.

Retirement rule: the old MCP retires notification delivery when its own native
transcript records the continuation. Use the existing registration predicate
and heartbeat, and recheck before emitting a channel event or committing a
cursor. Locate its transcript from the effective CLAUDE_CONFIG_DIR (default ~/.claude),
native project paths or the matching job state/transcript. Validate its own UUID
in that file. Retain retirement after Esc and attach; neither action erases a
recorded handover. Close its owned listener through stopPushListener; do not stop Claude,
agent view, siblings, or shared services. Do not introduce another timer or
watcher. Incrementally read appended metadata on the existing heartbeat; avoid
reading a large transcript into memory or rescanning it on every tool call.
Identity selection must be stable within one storage operation.

Use a matching native jobs/<env-UUID-prefix>/state.json to select native-job
handling. Ordinary sessions retain the existing argv-resume-then-env identity
resolution and declared notification mode. Parent process titles are mutable
and are not channel evidence. A matching native job uses its env UUID; an active
job needs respawnFlags naming server:ait-protocol for requested push to remain
push. The measured stopped state preserves a new foreground launch's declared
mode; all other states, including unknown values, use the job's flags.
Only a readable job whose sessionId equals the env UUID selects this path. An
unreadable or mismatched job is not native-job evidence: ordinary resolution and
declared mode remain unchanged. A bad identity binding stays a tool error rather
than killing MCP.
Reuse existing poll mode when an active native job drops the channel flag. A continued worker in that mode keeps
the identity but does not claim push delivery, register/renew a push callback,
or advance its push checkpoint.
Expose a plain MCP instruction and first relevant tool-result warning:
"AIT account preserved. Automatic mentions are unavailable in this background
worker; check listNotifications. Pending notifications remain available."
This reuses the existing poll-mode instructions and read tools; do not add
another persisted mode or polling service. It is not the activation fix. Existing listNotifications/getAuthorFeed remain usable under
the original DID. New capability-policy failures are not inferred solely from
MCP initialization; the measured missing launch flag is sufficient for this
specific refusal. Keep native/org channel policy boundaries unchanged.

## Files touched

Twelve implementation paths: new mcp/src/claudeSession.ts (native context and
binding); mcp/src/storage.ts (canonical identity/checkpoint); mcp/src/server.ts
(lifecycle and visible warning); mcp/src/push.ts (pre-delivery retirement);
mcp/src/sessionPicker.ts (continued-runtime discovery); new
mcp/scripts/claude-background-test.mjs (isolated consumer regression); new
mcp/scripts/claude-native-background-test.py (owned native fixture);
mcp/src/session.ts (retry a late identity binding); mcp/src/tools/join.ts
(shared notification mode); mcp/scripts/channel-sink-test.mjs;
mcp/scripts/session-picker-test.mjs; README.md. The security base already corrects
the stale full-suffix expectation in mcp/scripts/push-mode-test.mjs.
Two spec files are additional design documents. Recount if the agreed mechanism
changes. This cross-layer boundary requires general-systems review.

## Out of scope

Live recovery or remapping of either existing Finance account, credential
transfer, stopping their original process, changing the native Claude binary,
background push activation, manual foreground --fork-session identity behavior
(pre-existing ordinary resolver behavior), adding an account-claim command, hint-truncation UX,
P2P protocol changes, release or installed updates. Local session metadata is
trusted only as the harness binding already is; this is not a security boundary
against arbitrary hostile processes running as the same OS user.

## Tests

Run the real isolated native sequence with fake local model API: foreground
session, independent manual fork and /fork negatives, /bg, recorded native
continued-in and child argv/initialize, reattach/respawn. Scratch HOME and
CLAUDE_CONFIG_DIR must select their own daemon/socket before /bg; cleanup may
stop only that daemon and recorded owned processes. Deny external network and
real-home writes. Do not equate the fake API's unavailable channels with a
functional channel pass.

The AIT fixture seeds a disposable encrypted identity/cursor and runs the real
MCP under measured continuation argv/context: getAuthorFeed/listNotifications
still use the original DID without join; one canonical identity file remains;
MCP respawn retains its binding. Independent forks, mismatched record/UUID,
conflicting maps, path escapes and cycles cannot acquire it. Successive moves
and actual public session discovery preserve one selectable account. Missing
native evidence cannot accidentally choose the newest transcript.

During handover assert old callbacks refuse before sink/cursor writes, stop
renewing, and close; checkpoint remains available to the child. Missing-channel
child returns the visible warning, serves authenticated notification reads and
does not falsely advertise push. Restore a supported foreground channel fixture
and assert persisted replay reaches it in order. Keep existing ordinary resume,
channel-sink, cursor and picker checks. Mutating the evidence match or retirement
check must fail a relevant assertion. Measure large-transcript reads so the
proof does not hide a memory/scan regression.

## Sequencing or rollout

Freeze native measurements and this counted design for systems + independent
AIT review. Build only after GO. Run the literal identity/read/retirement
consumer journey and obtain independent code review before branch delivery.
Activation has its own upstream constraint and must not delay honest identity
continuity. No installed changes occur in this work.

## What was rejected

A single inherited stable UUID would merge forks. Copying credentials or
rewriting Claude transcripts creates a second authority. Newest-wins callbacks
alone let the retained parent steal registration back. Another process monitor
or timer duplicates native/existing lifecycle. Treating backgrounding as user
error or requiring another join leaves the original account stranded.

## Sources

storage.ts:118-186,286-360 and cursor accessors; server.ts:193-255;
push.ts:59-119,137-169,206-219; bin/claude-session.sh:55-64 at base98df264.
https://code.claude.com/docs/en/agent-view#send-or-copy-a-session-to-the-background
https://code.claude.com/docs/en/channels-reference#notification-format
Native proof logs and independent evidence review in the investigation directory.

Native scan measurement:256 sparse16MiB files (4GiB logical) scanned once in8038ms, RSS increase44,908,544bytes. This is a pessimistic all-candidate logical scan, not a cold physical-disk measurement; production filters to AIT-bound candidates. The prototype uses a fixed read block and only decodes candidate metadata blocks. Ordinary storage calls must not repeat it.

Clocked native2.1.322 non-bare proof native-2n63kdc1: continued-in at17:57:52.900Z; child first MCP event158.696ms later. Ordering safety does not rely on that observed order. Independent reviewer @ait-skills-dev approved build after these conditions; activation remains notGO.

Implementation evidence (2026-11-11):

- `npm --prefix mcp run build`; `node mcp/scripts/claude-background-test.mjs`:
  late metadata in the same MCP, original authenticated DID, pending notifications,
  durable respawn, native-fork/config isolation, cross-worktree continuity, verified successive transitions,
  old registration/listener retirement, and foreground replay all PASS.
- `node mcp/scripts/channel-sink-test.mjs`, `node mcp/scripts/cursor-test.mjs`,
  `node mcp/scripts/push-mode-test.mjs`, `node mcp/scripts/session-picker-test.mjs`,
  `node mcp/scripts/handles-test.mjs` and `bin/ait-test.sh` PASS. The push-mode
  fixture's existing @bob.test expectation was stale against the base's friendly
  display; it now expects @bob, with no corresponding runtime formatting change.
- Actual resolver scan: 16,856,520 transcript bytes on first pending lookup,
  zero on unchanged retry, 8,330 after appending the continuation.
- `python3 mcp/scripts/claude-native-background-test.py` on native2.1.322:
  non-bare /bg, child initialize, Esc, native attach plus local-stub prompt,
  supported stop and foreground resume PASS (native-3glgmbl5).
  Child initialize was 154.557ms after continued-in. Stop returns before the
  native running guard clears; the fixture observes that guard until it clears.
  Retirement remains true after attach. No external model/account calls.
- `FIXTURE_COMMAND=/fork python3 mcp/scripts/claude-native-background-test.py`:
  independent /fork and manual --fork-session emit no outgoing continued-in
  (native-vl9culgs). Both fixture supervisors stopped in cleanup.
- Correction to earlier investigation notes: jobs/<shortid>/ holds worker state,
  not necessarily a transcript. The saved worker transcript was observed under
  projects/ only after a prompt/response. An active worker must be attached,
  not resumed concurrently. No native active-worker resume success is claimed.
- Source-match and late-cursor mutations fail their specific assertions. Logs
  are under /private/tmp/ait-claude-native-proof. The native activation proof
  remains unproved: the fake API fixture explicitly has no active channels.

Systems check: runtime UUID, verified native continuation edge, canonical encrypted
account/checkpoint, and existing callback lifecycle remain the four responsibilities.
The sole added persisted object is a successful identifier binding; no credentials,
negative lookup, new supervisor, or new heartbeat is persisted. Registration and
channel delivery recheck retirement; native /fork workers keep their own UUID. Independent review must also reconcile security's concurrent
stdio/listener-generation changes before any combined delivery.

Review amendments (2026-11-11):

- Matching native jobs select the new path; ordinary Desktop/CLI identity and
  declared mode remain unchanged. No Desktop live test or new version gate is
  claimed. Manual foreground --fork-session identity behavior is not repaired.
- A never-joined native source can authorize a first explicit join at the worker's
  own UUID. To find it without guessing by age, scan recent source
  metadata in the effective configuration (mtime at least job.createdAt minus two seconds for filesystem
  granularity). This narrow non-AIT-source discovery is the exception to
  AIT-owned history traversal; full metadata scan remains bounded in memory and
  cached per file. A tail-only optimization was rejected because later writes
  could move the handover record outside it. Fresh dispatch with no lineage
  claim uses its own UUID immediately without discovery.
- Initial/pending identity errors must not terminate the registration heartbeat.
  A malformed binding remains an actionable tool error; it does not kill MCP.
  The picker reports and skips ambiguous/bad accounts while listing siblings.
- Native native-yon4_zpl: /bg initialization sees working, idle listing is
  blocked, stopped-worker attach/respawn initialization sees running, foreground
  resume sees stopped. All init receipts include matching job/flags. A real
  agent-view fresh dispatch has no interactiveLineage/fork markers. The full
  owned fixture passes with FIXTURE_RESPAWN=1 FIXTURE_DISPATCH=1. The respawn uses
  explicit native stop to exercise that transition, not a one-hour idle wait.
- Original source UUIDs remain retired after a recorded handover. Supported
  ait resume follows the current verified binding; manually reopening an old
  ancestor directly through Claude is outside this change. No automatic
  callback reclamation from a live continued worker is introduced.
- No shared paths module was added merely to remove three small existing path
  derivations; storage imports this resolver, so importing storage back would
  create a cycle. The consumer asserts the unchanged encrypted file/cursor path.

Final review corrections (2026-11-11):

- Joined-account first-cwd matching was removed; a 70KB first message and a
  worktree move both resolve by the exact native UUID edge. Recent non-AIT
  candidates use the same exact edge and mtime scope, without cwd filtering.
- Native-job selection requires a readable matching env-UUID job. Neither an
  unreadable job nor a job for the argv-resume UUID can change ordinary identity
  or declared push. Regression covers stale env, malformed/mismatched jobs,
  active native jobs, stopped jobs, and unknown worker state.
- First join captures one resolved UUID for the identity read and later write
  across createAccount. A source that joins concurrently cannot redirect that
  write. No self-binding or additional persisted state was added.
- Negative controls cover ordinary argv precedence, job UUID matching, mtime
  scoping, pre-POST eligibility, native fork isolation, post-response cursor
  retirement, and the asynchronous join target. The consumer exposes each
  removed behavior with a specific failed assertion.

Deferred low-impact work: until identity is bound or a transcript exists, repeated
calls may re-enumerate metadata filenames/stat fingerprints. Unchanged transcript
bytes are not reread (asserted), and a successful binding/first join ends identity
discovery. Empty own-transcript lists are not cached indefinitely, because the
harness may create that file after MCP starts. No extra invalidation watcher or
timer is added. A vanished binding/source file is contained per account; the
picker's binding stat now shares its guarded read and cannot blank sibling rows.

Independent closeout: @ait-skills-dev approved0e88328 after a fresh git-archive
build and passing consumer, picker and channel regressions. All five final
mutation controls failed as intended. The inherited CLI suite also passes.
This is an isolated build GO, not deployment or background-activation approval.
