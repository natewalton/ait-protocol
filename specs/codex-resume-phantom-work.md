# Codex resumes show no phantom work

Status: validated candidate, 2026-09-01.

## Why

An AIT developer who resumes a Codex session through `bin/codex-session.sh --resume` can see a permanent `Working…` line after the real turn has completed. Escape cannot stop it because the app-server is already idle. The line therefore makes an idle session look busy and prevents the developer from trusting the primary status surface.

There are two bounded triggers. First, commit `c767a5e` seeded a new paginated thread with `thread/inject_items` only to make its rollout attachable (`c767a5e:mcp/src/codex/host.ts:175-190`). In the reported Codex 0.152 rollout that seed produced one `turn_context` with id `auto-compact-0` and no completing turn. A real 0.152 app-server probe reproduced the orphan, and a remote-TUI probe showed that the server could report `activeTurn: null` while history still rendered `Working`.

Second, a clean one-record legacy rollout reproduced the same false status on an immediate cold resume. The driver received an idle `thread/resume` response and exposed the socket while `mcpServerStatus/list` still reported `codex_apps: starting`. The TUI then joined partway through the startup-notification round. The rollout remained clean and both `thread/read` and the TUI's own `thread/resume` response were idle, so history contamination cannot explain this trigger.

The affected persisted cohort is bounded: the 2026-09-01 AIT thread inventory returned 12 paginated bindings, all created between 16:49 and 17:22 local time; ten were launcher tests, one was never attached, and two belonged to this implementation session. They will start fresh rather than gain a migration subsystem.

Verdict: fix now. This is a false status on the normal AIT path, not cosmetic background activity.

The crude version is to remove `thread/inject_items` and rely on `thread/name/set`. That fails on Codex 0.152's default paginated mode because no attachable rollout is written. Pinning legacy history fixes that half, but still exposes a clean cold resume during MCP startup. The complete small fix therefore combines a legacy name seed for new sessions with protocol-reported readiness before TUI attach.

## The proposed work

For a new AIT thread, pass `historyMode: "legacy"` to `thread/start`, then call `thread/name/set`. On Codex 0.152 this creates the attachable, `session_meta`-only rollout without a model turn or synthetic turn context.

Do not rewrite, fork, alias, or delete the measured paginated cohort. Those two-hours-old sessions start fresh after release. In particular, the current implementation session must not use its old `01a05ed8`/`01a05ed9` resume target as proof of this fix; validation creates a clean post-fix session.

Before writing the socket announcement consumed by `bin/codex-session.sh`, call `mcpServerStatus/list`. For exactly the runtimes reported as `notStarted` or `starting`, wait for `mcpServer/startupStatus/updated` to report `ready`, `failed`, or `cancelled`. A connection loss fails the wait into the existing reconnect supervisor. There is no deadline, sleep, or retry count in the readiness decision; an older app-server may bypass the gate only by explicitly returning method-not-found.

The user-visible after-state is a newly launched clean AIT Codex TUI, and later resumes of that clean session, with an idle prompt and no persistent `Working` line. The release handoff explicitly directs operators of the 12 bounded c767a5e sessions to start fresh.

## Files touched

Six files:

1. `mcp/src/codex/appServerTypes.ts` adds the Codex 0.152 history-mode and MCP-readiness subset.
2. `mcp/src/codex/appServerClient.ts` removes the rollout-seeding inject helper and implements event-driven MCP readiness.
3. `mcp/src/codex/host.ts` creates clean legacy rollouts and gates socket publication.
4. `mcp/scripts/codex-rollout-resume-test.mjs` exercises rollout and readiness contracts against the installed app-server in an isolated Codex home.
5. `specs/notification-codex.md` corrects the two stale inject-seed descriptions in the existing architecture record.
6. `specs/codex-resume-phantom-work.md` defines this correction and its acceptance evidence.

## Out of scope

- Editing Codex JSONL or SQLite history in place.
- Automatically migrating, aliasing, or preserving resume support for the 12 bounded c767a5e sessions.
- Hiding all historical turns in the TUI relay.
- Status shown while a fully observed MCP startup or model turn is genuinely active.
- Deleting or archiving existing contaminated threads.

## Tests

- `npm run build` passes.
- `node scripts/codex-rollout-resume-test.mjs` holds a deterministic test MCP inside `initialize`, proves readiness remains unsettled, releases it by process signal, and requires the app-server's terminal startup event to settle the gate.
- `node scripts/codex-rollout-resume-test.mjs` proves that a legacy name seed creates one `session_meta` record, resumes successfully, and has zero `auto-compact-0` contexts.
- The same regression reproduces the prior paginated inject seed and its orphan context without adding a migration path.
- The production oracle cold-resumes a clean legacy seed while `codex_apps` is initially `starting`; the driver must print its protocol-settled evidence before the real Codex 0.152 TUI attaches, and the idle TUI must not show `Working`.

## Sequencing or rollout

Build and run the isolated regression, freeze one commit, obtain a read-only peer verdict, merge that exact commit to `main`, and rebuild `mcp/dist`. AIT Codex drivers load the change when restarted. Operators of the 12 measured paginated sessions start fresh; clean post-release sessions resume normally. Code rollback is the prior commit, and no existing history is mutated by this release.

## What was rejected

- Keep `thread/inject_items`: rejected because a Codex 0.152 rollout and TUI reproduced the same orphaned context class previously seen on 0.144.4 (commit `82baf14`).
- Run a no-op model turn: rejected because it consumes usage, creates output, and changes bare-launch behavior.
- Rewrite the rollout file: rejected because the app-server may retain an open writer and persisted user history must remain unchanged.
- Fork and alias the measured c767a5e cohort: rejected after inventory showed only 12 two-hours-old bindings, mostly launcher tests; the migration added about 150 lines and two persisted fields for sessions that can start fresh.
- Hide history in the TUI relay: rejected because it would remove useful transcript context.
- Change only the rollout seed: rejected because it leaves the independent cold-resume readiness trigger.
- Add a fixed delay, deadline, or retry budget before attach: rejected because elapsed time is not thread or MCP state. Readiness comes only from the app-server snapshot, terminal startup events, or connection closure.

## Sources

- Regression source: `c767a5e:mcp/src/codex/host.ts:175-190` and `c767a5e:mcp/src/codex/appServerClient.ts:167-173`.
- Prior root-cause evidence: commit `82baf14`.
- Installed Codex 0.152 schema: `codex app-server generate-json-schema --experimental --out <dir>`; inspect `ThreadStartParams.historyMode`, `ListMcpServerStatusResponse`, and `McpServerStatusUpdatedNotification`.
- 2026-09-01 command results: `codex --version` returned `codex-cli 0.152.0`; the isolated readiness barrier remained closed until its real terminal event; the legacy-name probe returned one rollout record and zero `auto-compact-0` contexts; the paginated-inject probe returned one such context; the AIT binding inventory returned 12 affected sessions created from 16:49 through 17:22 local time.
- Official Codex App Server protocol: <https://learn.chatgpt.com/docs/app-server> (`thread/start`, `thread/resume`, `thread/inject_items`, and MCP server status notifications).
