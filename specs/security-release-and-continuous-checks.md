# Release AIT with verified security decisions and continuous checks

Status: Proposed for implementation and validation. Release remains blocked until all acceptance criteria pass. 2026-11-10.

Scope: one focused security release followed by continuous enforcement. This spec adds one file; the implementation has nine declared files, listed below. Base: private-peer `d9e43e2`; stable comparison: `ce427fb`.

## Why

AIT users need a security release they can install with preserved accounts and sessions, and a maintainer who learns when a supported release becomes vulnerable. Today the advisory gate accepts matching recorded findings, including High findings. It does not enforce current applicability, severity, expiry or deployment exposure, and nothing scans supported releases between publication events.

The 2026-11-10 lockfile audits found five unique High advisories across three packages and no Critical npm finding. Stable had 52 affected-package findings; peer had 54. These are inherited package findings, not 52 or 54 independent vulnerabilities. Shipped native dependency status is unknown.

| Current problem | Source and frequency | User consequence and verdict |
| --- | --- | --- |
| Three High Nodemailer advisories remain in PDS 0.4.226 with the 8.0.11 override | `pds/package.json:10-17`; audit command in Sources. Present in both current stable and peer locks. Exploitation in AIT has not been established. | Keep the PDS generation and test a narrow mailer upgrade. **Fix.** |
| Zod remains flagged while its CVE was rejected; bundled validators and input limits need separate analysis | `appview/src/peerClient.mjs:48-59`; primary sources below. Applies whenever the relevant local/peer parsers consume input. No exhaustion exploit was demonstrated. | A version override or existing exception cannot establish bounded processing. **Resolve the disposition and validate resource limits.** |
| Kysely's advisory requires a database behavior absent from inspected PostgreSQL/SQLite paths | Installed PLC/PDS database constructors; advisory below. Applies to both dependency graphs. | Preserve a narrowly tested non-applicability decision; do not force a database-generation upgrade to change a scanner count. **Fix the decision evidence.** |
| Existing matches ignore changed severity, paths, owner, expiry and exposure | `bin/check-advisories.sh:19-32,65-74`. Every matching advisory/package/version receives the old decision. | A future expanded exposure can inherit an obsolete decision. **Fix.** |
| Publication does not refresh the audit; peer publication is manual | `.github/workflows/release.yml:24,89,93,205-226`. Preparation audits; publish skips validation. | A disclosure after preparation can miss the publication decision. **Fix both channels.** |
| No scheduled/PR security workflow; alerts disabled | `.github` contains only `release.yml`; GitHub vulnerability-alerts API returned “Vulnerability alerts are disabled” on 2026-11-10. | Supported installed releases can drift without an actionable alert. **Fix.** |

A passing result means **no unresolved, reachable High/Critical issue within the declared coverage**, with source-backed non-applicability or verified mitigation where appropriate. It does not mean zero npm warnings. Issue [#28](https://github.com/natewalton/ait-protocol/issues/28)'s clean High/Critical audit goal stays open while those findings remain.

## Proposed work

### A. Deliver the focused security release

Preserve the current PDS generation, database format, account DIDs, stored repositories, session bindings, native direct-only transport policy and supported runtime requirements. Deliver the fixes and required evidence through the existing peer prerelease channel. Common fixes can be applied to stable independently; this spec does not promote P2P to main or change the stable updater channel.

**Mailer.** Use Nodemailer **10.5.0** as the initial exact candidate override. Recheck the advisory database before implementation; reject a candidate with a new applicable High/Critical finding. The metadata-only model resolved successfully and removed the three High mail advisories, but no installation or compatibility result is implied. Test the actual PDS mailer and its HTML-to-text plugin, both default JSON transport and an isolated loopback SMTP sink. Exercise account confirmation, reset, update/deletion, PLC-signature and admin/moderation messages, recipient parsing and Unicode, plugin callbacks and output. Do not send mail to users or external recipients. Keep `@atproto/pds` on the existing generation.

**Kysely.** Verify the actual deployed PostgreSQL/SQLite constructors, including PLC's embedded compiler. Record the advisory's MySQL prerequisite, the supported paths and their regression. The first reported patch is **0.28.14**, correcting the old “0.29+” condition. An external override does not replace bundled code. If supported behavior introduces the vulnerable dialect/path, this disposition fails and that candidate blocks.

**Zod and input resources.** Keep the official CVE rejection and continuing GHSA visible. Neither record alone proves application safety. No blanket v4 override: AT/PLC consumers retain v3 contracts, PLC embeds validators, and AIT's schema converter uses v3 internals.

Start the implementation with the real ingress fixtures: PLC HTTP JSON, PDS JSON/record writes, peer log/profile responses, peer CAR/MST parsing, WebSocket subscription messages and MCP stdio framing. Verify whether existing limits constrain decoded content before expensive validation; include chunked/compressed input, invalid collections within the byte limit, malformed CAR/MST structures and concurrent requests. A signature failure must not be mistaken for a parsing resource bound.

For each ingress, the test fixture must publish concrete byte/work/in-flight limits and a finite parent timeout and child memory limit. Establish and commit those values against valid representative fixtures **before accepting an adversarial result**; do not recalibrate them automatically to make the candidate pass. Required outcomes: valid supported workloads still complete; rejected inputs do not terminate the service, admit identity/projection writes, cause continuing memory growth, or prevent a subsequent health/read request. Capture peak RSS and response latency. A small standalone validator benchmark is supporting evidence only.

If current bounds fail, amend the counted file list with the actual ingress/control changes and their tests before editing those runtime files. This is not permission to waive a failing result. No candidate can pass on “test not implemented,” “limit inherited,” “trusted peer,” or an unmeasured resource budget. Source-backed advisory disagreement is recorded in the decision; effective bounds must be verified wherever that decision depends on them.

**Native transport.** Audit the exact shipped source lock for `@natewalton/iroh-direct@0.1.0-experimental.1`: binding commit `adce3ea5c33209a9052fa2c57d8269d7f32419dc`, root `Cargo.lock`, package SHA-256 `bcd347b7b80c9decebd5336d9d1d7de52b3acc9b67f7d9c49f98c0d4a6e6b30a`. Include the actual Darwin arm64 build/feature paths and deployed code; label unused platform/build entries accurately. Missing tooling, unresolved provenance or incomplete native data blocks a release-wide pass. Any native remediation found necessary requires an explicit scope/test amendment, including direct-only transport regressions, before that candidate can ship. Never substitute an unrelated local build's lockfile.

### B. Make the release decision enforceable

Retain **four concepts**: candidate, finding, disposition and current verification. Extend the existing checker and `docs/security.md` policy. Do not add a status registry, capability registry, separate receipt database or a bypassing “accept risk” switch.

- **Candidate:** verified commit, four npm locks and shipped native artifact/source identities. `bin/check-advisories.sh --candidate <checkout>` reads candidate data, while policy and checker code come from the checker's own trusted current checkout. It never executes the candidate's older checker or lifecycle scripts. Dirty or moving release candidates fail; test-created temporary fixtures are explicitly controlled by the test harness.
- **Finding:** workspace, package, advisory ID, exact installed version, current severity, vulnerable lock location/parent chain and relevant embedded/native component. Validate the full audit response, including inherited references and severities. Unknown schemas/severities, missing roots, inherited cycles, malformed reports, subprocess timeout or registry failure block. Results must not change candidate dependencies or locks.
- **Disposition:** source-backed non-applicability or verified effective mitigation, reviewed severity, exact paths/components, applicable exposure, a named owner, review date, expiry and regression/evidence locator. No reachable accepted-risk waiver can satisfy the High/Critical rule. A rejected CVE alone does not override a continuing GHSA; preserve both and justify the application decision. A fixed finding leaves the exception set after the fresh graph no longer contains it.
- **Current verification:** fresh npm/native results plus the applicable compatibility/resource regressions. Ordinary workflow logs and artifacts retain the results. Do not call an old preparation scan current at publication time.

**Exposure does not equal release channel.** All new stable and peer candidates use the conservative union of supported local and approved-peer exposure. There is no caller-supplied `--scope` override, source-string grep or inference that “stable” means local-only. Only explicitly reviewed historical releases may have narrower exposure, mapped to their immutable commits in current policy. New independent local-only packaging is outside this spec.

Migrate the existing exception rows rather than grandfathering them. Give High/Critical exceptions at most **30 days** before evidence review; a shorter review period is allowed. Version, advisory severity/status, path, embedded/native source identity, supported exposure or expiry changes invalidate the old decision until reviewed. Bind each verification to the candidate commit, affected component identity, test revision and result; a passing test of HEAD cannot authorize an older supported tag. Run candidate-applicable regressions in a disposable isolated checkout with no reporting or publication credentials. A fixed evidence URL with no verified regression does not establish mitigation. Preserve the current rule that newly discovered lower-severity findings also need review.

The checker prints separate scanner totals and release-policy results. Example meanings:

```text
BLOCKED: high nodemailer ... no current applicable disposition
BLOCKED: native audit coverage incomplete for <artifact digest>
PASS: 0 unresolved release blockers; <n> scanner findings remain under current dispositions
```

A pass must identify the candidate, coverage and expiring decisions. It must not say “no vulnerabilities” when findings remain.

### C. Keep supported releases under review

Use the same checker and policy at three decision points:

1. **Pull requests:** required checks for dependency, input/exposure, native component, checker/policy and release-workflow changes. Use read-only unprivileged PR jobs, including fork PRs; do not use `pull_request_target` to execute submitted code with secrets. Security policy/workflow edits need maintainer review. Repository rules make the check required.
2. **Immediately before publishing:** stable and peer publication both depend on a fresh check of the exact draft commit and artifact identities. Preserve immutable asset/digest verification. A new advisory after preparation blocks publication, including an already-created draft. Provide the peer channel a supported checked publication path with `prerelease: true` and `latest: false`; stable remains full SemVer. Direct API publication outside that path does not qualify as compliant. Administrator credentials can bypass repository automation; do not represent CI as an account-security boundary.
3. **Daily supported-tag scan:** trusted checker/policy from the default branch checks clean, immutable target checkouts. Audit current stable and peer releases, including previously deployed peer builds until explicitly retired. Initial inventory: stable `v0.1.45` at `c976d1b29740784456803cee21da116ee5dea7d2`, peer.1 at `e16094956f1d122a89b6090cc4ef1224ea56cfd9`, peer.2 at `3fe1681b06f2de0fa98402f0dac5594dee7a62ba`. Verify each tag/commit before scanning. Historical local-only scope applies only to the explicitly mapped stable commit. An older release is not removed merely because HEAD passes.

Keep supported tags/commits, historical mappings and native source/artifact identity in versioned policy data in `docs/security.md`, separate from disposition entries. Unknown target identity fails. Scans use the current trusted policy, not the policy in the old tag. Land the shared checker, policy, tests and workflows on `main` as well as the peer branch; scheduling is not active merely because the workflow exists on the peer branch. Verify a default-branch scheduled/manual run against both channel inventories before declaring monitoring delivered. This does not require merging P2P runtime code. Enable GitHub vulnerability alerts; version-update bots are optional and do not replace these checks.

One scheduled workflow reports scan failure, expired decisions and incomplete coverage to a named maintainer through a deduplicated security issue containing affected supported tags, evidence and next action. Do not create an issue on every successful run or repeat the same alert each day. Use issue-write permission only in the trusted reporting job; scans need read access. Initial accountable maintainer: repository owner `@natewalton`, until reassigned explicitly. Critical triage target: the same workday; High: two business days. New publication blocks immediately regardless of the response target.

For an affected supported release, the maintainer must provide a patch/effective mitigation through that release's supported update route or explicitly retire support and notify affected users. Do not alter live installations automatically. A source-branch fix without an adoptable release and recovery instructions does not finish the remediation.

## Files touched

**Specification:** this file only. **Declared implementation: nine files.**

| File | Outcome |
| --- | --- |
| `pds/package.json` | Reviewed exact mailer candidate, existing PDS generation |
| `pds/package-lock.json` | Reproducible resolved candidate |
| `pds/scripts/mailer-security-test.mjs` (new) | Actual PDS mail composition/transport compatibility and security fixtures |
| `bin/security-input-test.mjs` (new) | Real ingress/resource and database-scope fixtures in isolated processes |
| `bin/check-advisories.sh` | One policy evaluator for candidate npm/native findings |
| `bin/check-advisories-test.mjs` (new) | Fail-closed policy/candidate fixtures |
| `docs/security.md` | Current dispositions, evidence, owners/expiry, supported targets/native provenance and operating procedure |
| `.github/workflows/release.yml` | Fresh checked publication for stable and peer with artifact verification |
| `.github/workflows/security.yml` (new) | Required PR checks and daily supported-tag monitoring/reporting |

This crosses dependency, runtime-validation and CI/release boundaries and requires systems and independent security review. Runtime input-control files or native fixes are not pre-approved as a vague open-ended list: the validation stage must name and count the actual changes here before implementation, with no release permitted while those findings remain unresolved. Repository alert/rules/maintainer assignment are settings changes with verified readback, not extra code files.

## Out of scope

- Blanket PDS/PLC/AT generation upgrades, a forced Zod4 migration, or claiming a zero-High npm graph through exceptions. Issue #28 remains distinct.
- Stable P2P promotion, a new public service, payload relay fallback, new runtime permissions, identity/schema migration or automatic installed updates.
- A new audit/capability registry, monitoring dashboard, bespoke evidence database or automatic dependency repair.
- Claiming certification or complete security from a scanner pass. Externally maintained Node/PostgreSQL/OpenSSL remain explicit prerequisites; they are not covered by four npm locks.
- Implementing or publishing as part of spec authoring. Runtime changes, settings, notifications and releases remain unperformed at this stage.

## Tests

Commands below are **implementation acceptance commands**, not claims that new tests already exist or pass. Install/build in isolated checkouts with Node24 and fixture homes/ports, following [development alongside installed AIT](../docs/developing-alongside-installed-ait.md). No fixture can signal installed processes, use their credentials/data, send external mail, or run real update/stop scripts without shims.

```sh
node pds/scripts/mailer-security-test.mjs
node bin/security-input-test.mjs
node bin/check-advisories-test.mjs
bin/check-advisories.sh --candidate "$CANDIDATE_CHECKOUT"
```

| Acceptance journey | Required result |
| --- | --- |
| PDS fixture requests account/security email → actual PDS mailer/plugin → JSON or local SMTP capture | Expected recipient/template/text/token behavior, no real mail delivery; unsafe raw/URL/file behavior rejected where exercised; malformed cases are bounded; account/session behavior preserved. All three High mail roots absent from fresh candidate audit. |
| Actual local/peer ingress → decode/validate → identity/projection admission | Below/above-limit and concurrent cases meet committed budgets; invalid data is rejected before admission; a subsequent permitted call succeeds. Positive workloads retain their required behavior. |
| Kysely supported runtime construction → database operation | Actual PLC/PDS use PostgreSQL/SQLite; a fixture introducing the advisory's vulnerable dialect/path invalidates the disposition. Embedded implementations are included. |
| Candidate → fresh audit → policy → publication attempt | New High/Critical, changed severity/status/path/component, expiry, unknown scope/severity, missing owner, missing evidence or incomplete native coverage block before release mutation. A legitimate current disposition passes with scanner counts still visible. |
| Invalid audit/native source | Cyclic/missing inherited roots, malformed/incomplete JSON, unsupported schema, network timeout/outage, wrong artifact/source-lock digest and unresolved native applicability fail closed without changing candidate locks. |
| Prepare succeeds → advisory changes → publish | Publication is blocked and draft retained for repair; old scan cannot authorize it. Future stable candidates receive peer exposure rules. |
| Supported immutable tag → current trusted checker → scheduled failure → reporting | Old tag's permissive policy is not executed; named maintainer receives one updated actionable issue with affected tags, without duplicates or success spam. Wrong tag/commit or absent current policy blocks. |
| Native finding for unused target/build path | Explicit current applicability evidence tied to the actual packaged build; no blanket “all Rust clean” claim. Missing audit tooling remains a blocker. |

Retain relevant existing checks: isolated CLI/install/update/uninstall tests, startup/operator tests, authenticated peer projection/feed tests, real two-PDS post/reply/notification/unlink/relink, native policy-off refusal and pending-connect cancellation. Run the full contract when dependency/control changes affect it; do not mirror implementation with redundant fixtures.

**Completion evidence:** exact candidate/artifact identities; fresh npm and native findings/dispositions; passing actual mail/resource/integration regressions; publication through the checked path; a safe, observed supported-tag monitoring/reporting fixture; verified repository alert/rule settings; and an adoptable release with installation/recovery notes. A real scheduled failure need not be manufactured: demonstrate reporting with a controlled, clearly labelled fixture issue or a real finding, without fabricating a vulnerability or contacting unrelated recipients.

## Sequencing or rollout

1. **Bounded validation:** reproduce the current inventory, inspect deployed bundles, establish ingress test budgets/valid fixtures, and audit the exact native lock. Update this counted scope with concrete controls/fixes if any required bound fails or native blocker is found. Publish no security-readiness claim from the small research probes.
2. **Focused release:** implement/test the mailer candidate and necessary controls; record current Kysely/Zod decisions; enforce fresh publication checks and peer artifact handling. Independent review covers the actual changed runtime/security boundary. Verify the real released surface through an authorized maintenance window, preserving sessions and state. Scheduling infrastructure is not a prerequisite for this patch's user value.
3. **Continuous enforcement:** activate required PR checks, alerts and supported-tag daily scans/reporting. This independently prevents unsafe publication and alerts maintainers even while remediation is open. No valid current decision means a blocked release, not an automatic extension. The overall spec is complete only when both the adoptable patch and ongoing checks are delivered.

Deploy first through the existing peer prerelease channel; do not silently publish a stable P2P release. Common mail/policy fixes may be delivered on stable without unrelated peer code. No release numbering is reserved by this spec. Rollback of code must preserve any advanced persisted state; dependency testing uses disposable copies until authorized installation.

## What was rejected

- A single `--audit-level=high` switch: current matching exceptions, embedded code, exposure and publication timing still determine the outcome.
- A global Zod4/Kysely override or `npm audit fix --force`: metadata resolution does not establish actual bundle or runtime compatibility.
- “SMTP disabled,” “approved peer,” signatures or CVE rejection as a complete safety proof.
- Severity-only zeroing, renamed packages to suppress alerts, permanent exceptions, broad accepted-risk waivers and scope overrides to pass the gate.
- Treating branch/version labels as exposure or adding an audit-only capability descriptor. Use conservative new-candidate rules and immutable historical mappings.
- Running an old tag's checker/policy, scanning HEAD alone, or relying on preparation's old audit for publication.
- Building a monitoring service or automating live upgrades. One checker, current policy and ordinary GitHub workflow output/issues reach the required consumers.

## Sources

Verified 2026-11-10; recheck external advisory/package data during implementation:

- Current gate: [`bin/check-advisories.sh`](../bin/check-advisories.sh), especially lines 19-32,39-50,65-82; current publication: [release workflow](../.github/workflows/release.yml), lines 24,89,93,205-226.
- Current mailer override: [`pds/package.json`](../pds/package.json):10-17; pinned PDS `@atproto/pds@0.4.226` packaged `dist/context.js:70-75`, `dist/mailer/index.js:9,44-55`. Default JSON transport still composes messages. Primary package metadata: [PDS](https://registry.npmjs.org/@atproto/pds), [Nodemailer](https://registry.npmjs.org/nodemailer).
- Peer ingress: [`peerClient.mjs`](../appview/src/peerClient.mjs):48-59,70-74; [`peerFeed.mjs`](../appview/src/peerFeed.mjs):27-47,79,112,134; default peer startup: [`server.ts`](../appview/src/server.ts):93-106.
- [Zod GHSA](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [official rejected CVE record](https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2023/54xxx/CVE-2023-54404.json), [bounded-v4 change](https://github.com/colinhacks/zod/pull/6652), [v3 maintenance/bundling discussion](https://github.com/colinhacks/zod/issues/6653).
- [Kysely GHSA](https://github.com/advisories/GHSA-8cpq-38p9-67gx); PLC `@did-plc/server@0.0.1` published `dist/bin.js` contains its compiler and constructs PostgresDialect; PDS `dist/db/db.js:27` constructs SqliteDialect.
- Nodemailer: [raw options](https://github.com/advisories/GHSA-p6gq-j5cr-w38f), [address lists](https://github.com/advisories/GHSA-2x7j-588g-ccc2), [fallback parsing](https://github.com/advisories/GHSA-v53p-9fqp-m79j), [10.5.0 release](https://github.com/nodemailer/nodemailer/releases/tag/v10.5.0).
- Native [immutable release](https://github.com/natewalton/iroh-ffi/releases/tag/iroh-direct-v0.1.0-experimental.1), [source lock](https://github.com/natewalton/iroh-ffi/blob/adce3ea5c33209a9052fa2c57d8269d7f32419dc/Cargo.lock), [locked build script](https://github.com/natewalton/iroh-ffi/blob/adce3ea5c33209a9052fa2c57d8269d7f32419dc/iroh-js/build-package.sh).
- Reproduction: in each `plc`, `pds`, `appview`, `mcp` workspace run `npm audit --json --package-lock-only --include=dev --include=optional --include=peer`. The 2026-11-10 results were stable High 5/27/15/5 and peer 5/27/17/5, Critical 0 in all eight. Temporary metadata-only models held PDS 0.4.226 or 0.5.55 with Nodemailer10.5.0: three High mail roots disappeared, while Zod remained. No model established runtime compatibility.
- Existing clean-audit outcome: [issue #28](https://github.com/natewalton/ait-protocol/issues/28). Research artefacts supplement this spec; they are not required inputs to its acceptance tests.
