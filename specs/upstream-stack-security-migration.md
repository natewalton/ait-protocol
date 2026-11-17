# Preserve AIT collaboration while updating the protocol stack

Status: Corrected on 2026-11-16: retain supported upstream upgrades only. The
MCP-wide Zod override amendment below is superseded; AIT tool schemas may use
supported Zod 4, while AT Protocol consumers retain their declared Zod 3.
Unsupported Nodemailer, html-to-text, glob and dependent minimatch overrides are
also being removed, including ones predating this stack upgrade. Passing tests
do not establish upstream support. Findings and release blockers must remain
visible; no release or installation is authorized here. Full Lex adoption is
deferred under #68. Earlier proposal details below are historical where they
conflict with this correction.
Date: 2026-11-15. Bases: main ce70eab; peer c8a5b41.

## Why

Issue #28's production High/Critical cleanup remains open. Fresh production audits on main report PLC 5 High, PDS 26, AppView 16 and MCP 5, with no Critical findings. The 52 affected-package entries inherit two direct advisory families, Zod and Kysely. Current input bounds and dialect-specific decisions remain enforced. The user authorizes migration work and extensive testing and prefers supported AT Protocol stack upgrades before custom repairs.

This slice removes the PDS's old Kysely/file-type implementations and its obsolete key-encoder/Elliptic chain through the supported PDS release, while retaining usable accounts, records and sessions. The maintainer sees those components removed or patched in the actual dependency/audit output; sessions continue through the existing join, resume, post and notification flows. Zod findings elsewhere remain explicit and keep #28 open. This is useful independently of any later Zod or PLC migration.

The current manifests pin different AT Protocol generations: PDS ^0.4.0, AppView sync ^0.3.1/xrpc-server ^0.11.1/API 0.20.4, and MCP API ^0.20.0. Published PDS 0.5.59 uses newer Kysely and file-type but still declares Zod ^3.23.8. A disposable latest-PDS resolution still reports Zod High findings. **Upgrade and verify the upstream stack first; do not represent that alone as #28 completion.**

A disposable global Zod 4.6.7 override makes MCP's package audit clean but causes the actual converter contract at mcp/src/server.ts:210 to omit tool properties. PLC's published server embeds Zod and Kysely in its bundle. **Reject scanner-only overrides and verify the actual deployed consumers and bundles.**

## The proposed work

1. Select a coherent supported upstream generation: initial exact PDS 0.5.59; AppView common 0.8.10, identity 0.5.23, lexicon 0.7.19, sync 0.4.26, syntax 0.7.7, xrpc-server 0.13.12 and API 0.32.0; MCP API 0.32.0/syntax 0.7.7 with its existing MCP SDK. Update only intended stack roots and inspect the lock graph for compatible lexicon identity and actual required Node engines. Preserve working compatible security overrides until removal is proven safe.
2. Run actual boot, account/repository and client journeys against these upstream packages. Adapt AIT to documented upstream contracts where necessary; record concrete additional files before expanding this counted scope. Do not add a generic compatibility layer or rewrite dependencies in postinstall.
3. Seed an owned old-PDS account/repository/blob fixture with 0.4.226, stop it, copy the data, and run the new PDS against the copy. Verify retained DID/handle/authentication, record URIs/CIDs, blobs, existing tokens/session behavior and subsequent writes; verify the preserved original remains usable. Use owned ephemeral listeners, no installed configuration, temporary homes and explicit outbound guards. Test migration failure and document the actual rollback boundary before proposing operator installation.
4. Preserve AppView's source ownership, bootstrap/replay ordering, account lifecycle and retained history. Preserve MCP's actual tool schemas, successful/invalid calls, push/channel notifications, cursor behavior and Claude/Codex session bindings. Main and peer retain their distinct local versus verified-feed trust and data models.
5. After upstream validation, reassess remaining advisories. If a dependency migration is still necessary, use its native supported APIs and add consumer-specific tests. A Zod migration must preserve advertised input schemas and actual ATproto parsing; a PLC change must rebuild/inspect the executed bundle. No fake package versions, renamed vulnerable code, unreviewed overrides or /v3 imports to conceal findings. Broader source/fork changes require a concrete counted amendment and independent review, not another routine version assumption.

   MCP amendment, corrected 2026-11-16: retain Zod 4.6.7 and native `z.toJSONSchema` only for AIT-owned tool schemas supported by the MCP SDK. Remove the package-wide override; AT Protocol consumers must resolve their declared Zod 3 independently. Restore their High findings in the issue and security-gap records. Tool-schema, actual client and fixed-budget regressions are still required, but cannot authorize overriding an upstream dependency contract. Full Lex migration remains deferred under #68.
6. Remove dispositions only when their packages or vulnerable consumer paths are actually gone. Add any changed graph fingerprint only after the existing fixed-budget ingress and dialect regressions pass. Do not extend deadlines or suppress remaining findings. Add the real persistence-upgrade fixture to required PR/release checks so future stack changes cannot bypass it.

## Files touched

Implementation scope: **29 files across both variants**, plus this specification. Main retains its local feed; peer retains the verified feed instead:

- appview/package.json and appview/package-lock.json (2): coherent upstream client/indexer stack.
- mcp/package.json and mcp/package-lock.json (2): upstream client stack.
- mcp/src/server.ts and mcp/scripts/list-tools-test.mjs (2): replace the obsolete converter with official Zod 4 conversion and verify the actual advertised tool arguments, bounds and invalid-call recovery through MCP using an owned test home.
- mcp/scripts/stack-migration-test.mjs (1 new): actual two-session MCP → owned PLC/PDS → AppView indexing/read/notification journey, including supported records, invalid writes and identity persistence. No installed services or data.
- pds/package.json and pds/package-lock.json (2): upstream PDS stack.
- pds/scripts/mailer-security-test.mjs and pds/scripts/dependency-security-test.mjs (2): actual updated consumers, unchanged isolation and resource limits.
- pds/scripts/xml-parser-test.cjs (1): exercise the new upstream AWS XML parser after its removed fast-xml-parser dependency, preserving actual parser rejection/availability checks.
- pds/scripts/upgrade-compatibility-test.mjs (1 new): old-data upgrade and rollback boundary.
- appview/src/localFeed.mjs (1): convert upstream sync's raw IPLD record representation with the official lexicon serializer before the existing full-commit validation. The actual avatar journey reproduced rejection of a valid typed blob; bootstrap already uses that upstream conversion through jsonToLex.
- appview/scripts/startup-readiness-test.mjs (1): preserve full startup/account/push assertions and include actual response/server diagnostics when new upstream behavior fails them.
- appview/src/identityFetch.ts, appview/src/server.ts and appview/scripts/identity-fetch-test.mjs (3): configure the upstream safe-fetch wrapper for the operator-selected PLC origin only. The new identity resolver blocks HTTP/private origins by default; preserve that default for other identity URLs, forbid trusted-origin redirects, and verify actual allowed/denied network requests and response bounds.
- bin/install.sh, bin/ait-test.sh and README.md (3): enforce and document Node 22.19+ on stable, required by the new upstream fetch-node undici_v8 dependency. Peer retains its existing Node 24 requirement.
- docs/security.md (1): accurate current component provenance and proven remaining decisions.
- docs/operations.md (1): Node requirement and verified pre-upgrade-copy recovery boundaries for the PDS schema migration.
- AGENTS.md (1): make the user's upstream-first dependency maintenance preference part of the project instructions consumed by future development sessions.
- .github/workflows/security.yml and .github/workflows/release.yml (2): required persistence-upgrade execution.
- bin/security-workflow-test.mjs (1): prevent omission of the upgrade journey.

Peer integration adds two existing files before implementation: `appview/src/peerFeed.mjs` converts authenticated raw IPLD records with official `ipldToLex` before complete-record validation and projection; `appview/scripts/peer-link-test.mjs` extends the actual two-PDS/native-approved journey through real MCP SDK stdio clients and the compiled MCP server, including avatar upload, peer profile projection, approved-native owner byte readback and read-modify-write preservation. Local JWT authority and approved-source verification remain separate from display resolution. Peer-specific manifests preserve the experimental.3 transport and Node 24 floor.

Product source or additional tests required by concrete upstream incompatibilities must be enumerated here before editing. The PLC lane is initially read-only upstream-artifact research, not permission to introduce a parallel PLC implementation.

## Out of scope

Installing either laptop, restarting shared services, reading/copying live account databases, publishing packages/releases, changing current release channels, adding scheduled monitoring, and promoting peer trust/schema changes into main. No new runtime abstraction or limit increase is proposed. Existing advertised viewer-PDS avatar URLs for foreign DIDs are a separate routing defect: this slice proves profile/CID projection and the already approved native owner blob read, not that advertised URL delivery. The advertised URL defect is tracked separately in issue #66. No new blob gateway is introduced. A completed upstream migration that still has High findings is progress; #28 remains open until its stated outcome is met.

## Tests

Acceptance criteria, not results already claimed:

- Fresh Node 24 npm ci and AppView/MCP builds; strict installed correspondence and single lexicon per process.
- Fresh four-workspace production and complete-lock audits plus packaged native audit, with no unresolved reachable High/Critical release blockers. Keep #28's separate zero-production-High/Critical result visible and do not equate it with mitigated release eligibility.
- Actual old-PDS account/repository/blob data copied into new-PDS startup, successful login/read/write after migration, old copy preservation and failure recovery. No installed paths or fixed service ports.
- Existing PDS JSON/SMTP/account/token/blob consumer checks, malformed input non-admission and subsequent availability, under existing fixed budgets.
- Existing operator/readiness/managed ports, local bootstrap and signed peer snapshot/lifecycle/mentions; actual two-PDS post/reply/notification/unlink/relink and direct-only transport controls on the peer variant.
- Actual MCP list-tools schema properties/constraints, successful/invalid tool calls, push/channel notifications and cursor replay, Claude continuity, session picker and Codex writer/recovery/native contracts.
- Required hosted checks, systems review and independent security/migration review on combined candidates. Release preparation/publication and operator installation remain separate actions.

## Sequencing or rollout

Use isolated main/PDS/PLC worktrees. Upgrade supported upstream roots before custom migration work; prefer removing obsolete adapters over adding compatibility modes. Integrate proven common changes into main and peer without rewriting published ancestry. No live installation is needed for implementation or review. Before a release containing persistence changes, provide verified recovery instructions based on disposable old/new database tests. Update issue #28 once with the delivered outcome and explicit remaining work.

## What was rejected

- Hand-maintained dependency fixes before checking current AT Protocol releases: contrary to the user's preference and increases ownership unnecessarily.
- Lock-only/global Zod 4 overrides as completion: measured tool-schema loss and unexamined bundled consumers.
- Substituting zod/v3 from a v4 package: old array parsing behavior remains despite changed package metadata.
- External PLC Kysely override: cannot replace the bundled implementation.
- Claiming npm resolution or a successful build proves database/account compatibility.
- Weakening candidate identity, fixed resource limits, trust separation or expiry checks to make a new graph pass.

## Sources

- Fresh 2026-11-15 audits and probes: /private/tmp/ait-28-feasibility-evidence/review.md and its adjacent JSON; issue #28 comment6900651054. These are research evidence, not required runtime inputs.
- Current actual callers: plc/launcher.js:5,35-36; pds/launcher.js:7-13,23; appview/src/localFeed.mjs:5-10; appview/src/pushRegistry.ts:14-15; mcp/src/server.ts:11-12,210; mcp/src/atproto/pdsClient.ts.
- Official registry metadata: https://registry.npmjs.org/@atproto/pds/0.5.59 ; https://registry.npmjs.org/@atproto/api/0.32.0 ; https://registry.npmjs.org/@atproto/sync/0.4.26 ; https://registry.npmjs.org/@did-plc/server/0.0.1 .
- https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 ; https://github.com/colinhacks/zod/issues/6653 ; https://github.com/advisories/GHSA-8cpq-38p9-67gx ; https://zod.dev/json-schema .
