# Security and advisories

AIT's session hooks are workflow guardrails, not an operating-system security
boundary. UUID-derived credential encryption does not protect credentials from
a process that can read both the UUID and the credential file under the same
Unix user. See [Architecture](architecture.md#trust-and-record-semantics) for the
scope of those controls.

## Current release rule (2026-11-11)

A release requires a current decision for every finding in its supported
configuration within the declared four npm locks and packaged transport Cargo graph.
Non-applicability and effective mitigation require current source evidence and a
passing candidate-bound regression. Critical risk acceptance cannot pass. The
narrow upstream High decision below is available for a reviewed npm finding
when a supported fix is unavailable and the residual risk in AIT's supported configuration has been reviewed and explicitly accepted.
A policy pass
is distinct from a clean npm audit; issue [#28](https://github.com/natewalton/ait-protocol/issues/28)
remains open while High/Critical scanner findings remain.

Run the current trusted checker against a clean, immutable candidate:

```sh
bin/check-advisories.sh --candidate /absolute/path/to/clean-checkout
node bin/check-advisories-test.mjs
```

Run fresh `npm ci` in each candidate workspace before compatibility regressions. The checker verifies installed package/version/source correspondence against the lock; this is a stale-installation check, not a tamper-proof host or file-integrity claim.

The candidate's checker, policy and lifecycle scripts are never used. Current
policy and trusted regression code belong to this checkout. Regressions run now
against the candidate in an isolated unprivileged job; results identify its
commit, lock digests and the current test hash. No supplied approval receipt or
scope override is accepted. All new candidates use local plus approved-peer
exposure, including future stable P2P releases. Only the immutable historical
commits below have reviewed exposure mappings.

The checker audits all four complete npm locks, validates inherited roots and
severity, and checks fresh GitHub advisory status/revision. A changed version,
dependency ancestry, advisory status/severity, component identity, exposure or
expiry invalidates an old decision. It audits the exact packaged native source
lock separately. Missing tooling, unknown severity or incomplete coverage blocks.
It performs no dependency repair. Coverage is the four npm locks and the packaged transport Cargo graph. Other embedded native components, including SQLite within better-sqlite3, and externally maintained Node/PostgreSQL/OpenSSL remain outside these lockfile advisory audits. Native findings retain unknown severity when no supported score exists. They block unless an independently reviewed, exact-artifact non-applicability decision passes its current regression. Unknown severity can never qualify as accepted risk or informational maintenance; no severity is guessed.

Publication requires a fresh advisory result and current security regressions for
the exact candidate. The release workflow reuses the compatibility and
integration results only from a successful preparation run for the same
repository, channel and commit. It regenerates the installer and checks the
draft asset digest before publication. If preparation evidence is missing or the
candidate changed, run preparation again.

The PR/release job supplies the trusted checkout; repository maintainer review must
protect policy/checker/workflow changes. Candidate regressions run without
publication/reporting credentials. No schedules, security issues, automatic
updates or alert-setting changes are introduced. A pass is valid at check time,
not ongoing assurance between checks.

## Input resource envelope

The existing decoded limits remain: PLC JSON 100 KiB; PDS ordinary JSON 150 KiB and record writes 1,000,000 bytes; peer ordinary reads 512 KiB, CAR downloads and WebSocket frames 100 MiB; MCP stdio framing 10 MiB. The checked PLC parser returns 413 for oversized bodies and 400 for malformed JSON without stack traces, including chunked/compressed requests. Both npm start/dev and service wrappers use that launcher.

Repository/feed decoding additionally rejects headers over 1 KiB, block payloads over 1,000,000 bytes, more than 65,536 CAR blocks, more than 4,096 CBOR nodes per block or 1,048,576 per CAR, more than 65,536 nodes per stream frame, or nesting beyond 64. These are AIT application limits, not AT Protocol maxima; unusually large record arrays/facets can now be rejected. Rejection appears in indexing status as `Feed input limit: ...`; shared AppView continues serving. All selected records must pass their registered lexicons before snapshot/commit projection. Invalid records cannot partially admit an identity, earlier valid records or a cursor.

Malformed ordinary MCP tool calls leave their session usable. Raw JSON preflight additionally rejects more than 65,536 value/key tokens or nesting beyond 64 before object materialization; it returns a correlated resource error and keeps that session usable. Bounded 64 KiB slabs coalesce a newline frame once before the SDK parses it. The unchanged SDK 10 MiB byte ceiling still closes only the offending transport on overflow; the client must reconnect. Shared AIT services are not restarted. Fixtures cover dense/deep inputs, escaped and late request IDs, notifications, exact-limit CRLF frames, EOF and fresh-session recovery.

The refreshed Node24 fixtures passed five stable groups and seven peer groups, retaining the fixed 256 MiB old-space/768 MiB aggregate RSS and 32 MiB retained-growth limits; actual MCP runtime uses 128 MiB old-space. Peak measured aggregate RSS was 596 MiB for stable and 484 MiB for peer, with maximum retained growth below 9 MiB. Actual MCP server peaks were 231/214 MiB after bounded framing and JSON preflight, versus 681 MiB in the earlier fragmented-frame diagnostic. Positive compilation retains its separate 1024 MiB/60-second build budget. Tests cover real stable server/index/HTTP-read behavior, a signed 32-post snapshot and structural 100 MiB CAR/frame acceptance separately; this is not a full semantic 100 MiB repository/message compatibility claim.

## Published native replacement

[Native patch PR](https://github.com/natewalton/iroh-ffi/pull/1) updates Tokio 1.54.0 → 1.54.1, ctutils 0.4.3 → 0.4.4 and rustix 1.1.5 → 1.1.6 in the exact source lock. The locally packed experimental.3 addon passed 28 package tests and controlled-network strict/default transport proofs. A fresh full-workspace audit covers 464 locked packages: zero vulnerabilities, no unsoundness warning, and the same three unmaintained notices recorded below as informational residual risks. This does not clear unrelated bundled native libraries.

The exact packed experimental.3 also passed all 14 outcomes of the isolated two-PDS collaboration journey, including post/reply/notification readback, UDP outage recovery, unlink/relink, native policy refusal and pending-connect cancellation. That initial journey is supporting local artifact proof; the adopted candidate must pass its own fresh gate and release regressions.

[Experimental.3](https://github.com/natewalton/iroh-ffi/releases/tag/iroh-direct-v0.1.0-experimental.3) is published as an immutable prerelease at the exact source/digest identity below. Anonymous public asset and source-lock readback matched the reviewed bytes. The peer security candidate now pins its exact URL/integrity; stable has no peer transport dependency. The unpublished experimental.2 draft is superseded after the fresh audit found RUSTSEC-2026-0486. Older experimental.1 releases remain blocked. Every adopted candidate still requires current package/source correspondence, native audit and runtime evidence; publication alone is not candidate approval. No AIT release or live installation is performed by this change.


### Chrono in the native source lock

The full source lock scan reports [RUSTSEC-2026-0543](https://rustsec.org/advisories/RUSTSEC-2026-0543.html) for Chrono 0.4.45. The [experimental.3 build script](https://github.com/natewalton/iroh-ffi/blob/d50c2b7de23ac8872db630056897742518d9706d/iroh-js/build-package.sh) uses the default features of `number0_iroh` with `--locked --release --target aarch64-apple-darwin`. The published addon is macOS arm64. On the pinned source commit and lock, Cargo 1.91.0 resolved the macOS arm64 tree without Chrono or WMI. The same locked package and default features resolved Chrono through WMI and netwatch for the Windows x64 target.

Reproduce with `cargo tree --locked --package number0_iroh --target aarch64-apple-darwin` and `cargo tree --locked --package number0_iroh --target x86_64-pc-windows-msvc --invert chrono` from the pinned workspace. The release regression checks that the installed package manifest, loader and addon match the reviewed macOS bytes. The gate still scans the entire source lock and binds the disposition to the exact artifact, source lock and advisory revision. A new artifact or target requires fresh review. See [#78](https://github.com/natewalton/ait-protocol/issues/78).

## Acknowledged migration-related security gaps

As of 2026-11-16, the remaining Zod High advisory is tracked under
[#68](https://github.com/natewalton/ait-protocol/issues/68). AIT adoption is deferred
until supported AT Protocol releases complete the Lex migration across AIT's
upstream dependency paths; there is no approved client-only migration.

This table summarizes the active policy below, not an additional exception list.
The affected dependency remains present. Mitigation means the exact candidate
passes the bounded-input regressions; it does not mean the dependency is fixed
or that arbitrary inputs/configurations are safe.

| Component | Remaining High finding | Current disposition | Removal work |
| --- | --- | --- | --- |
| AppView, main and peer | Zod 3, GHSA-mrhx-c7xc-m3w5; inherited through protocol validation, repository/sync and identity libraries | Mitigated within the tested input/resource envelope; `appview-zod-GHSA-mrhx-c7xc-m3w5` | Complete upstream Lex adoption, then migrate and test AIT's actual indexing, query and peer consumers under #68. |
| PDS, including OAuth | Zod 3, GHSA-mrhx-c7xc-m3w5; remaining server and OAuth validation | Mitigated within the tested input/resource envelope; `pds-zod-GHSA-mrhx-c7xc-m3w5` | Wait for supported upstream replacements covering the full server path. A forced Zod 4 override fails OAuth provider initialization; migrating AIT clients does not repair this path. |
| PLC | Zod 3, GHSA-mrhx-c7xc-m3w5; published PLC dependency and embedded validators | Mitigated within the tested input/resource envelope; `plc-zod-GHSA-mrhx-c7xc-m3w5` | #68 tracks the shared validation blocker, but AT Protocol's Lex migration alone does not guarantee replacement of the separately published PLC bundle. Verify both external and embedded validators before removing this disposition. |
| MCP upstream AT Protocol libraries | Zod 3, GHSA-mrhx-c7xc-m3w5; required independently by API/common-web/lexicon/XRPC | Temporary accepted-risk decision approved through December 10; all four exact paths remain reported | Track under #68. Candidate-bound ingress evidence and a current explicit disposition are required before release. AIT-owned tool schemas remain on SDK-supported Zod 4.6.7. |

All four Zod dispositions expire on **2026-12-10**. Waiting for upstream
neither extends them nor bypasses the candidate-bound release checks. Changed
versions, ancestry, advisory revisions or exposure require fresh review. An
unresolved reachable High/Critical finding without effective mitigation or a
current approved upstream-risk decision blocks release; this deferral is not blanket risk acceptance. The earlier zero-High MCP
claim depended on forcing upstream Zod 3 consumers onto Zod 4 and is withdrawn.
The corrected graph retains Zod 3 findings. The separately approved MCP exception
below records its remaining availability risk.

### Approved MCP residual-risk decision (2026-11-19)

The maintainer explicitly approved one temporary accepted-risk decision for
all four MCP Zod 3.25.76 paths for GHSA-mrhx-c7xc-m3w5, after independent
security and systems review. This approval covers the MCP availability risk
through December 10; it is separate from the default-mail approval.

The concrete residual risk is excessive memory/CPU use or termination of an
MCP or aitty process when the canonical client consumes hostile or malformed
responses from its configured local PDS. The common-web DID-document validator
accepts response-controlled arrays. Existing MCP stdio limits do not bound
those HTTP responses. Local routing and rejected redirects reduce exposure;
they do not establish complete response-side mitigation.

Source review found fixed-shape scalar schemas in API's NUX helper and XRPC's
error helper. Lexicon registers bundled schema documents and validates scalar
blob shapes while converting responses. The decision conservatively retains
all four findings rather than adding separate non-applicability machinery.
Existing bounded-ingress tests remain required for their actual tested
surfaces, without claiming they fix the response gap. No vulnerability
reproduction or new runtime control is required for this decision.

The approved exception expires **December 10** and is limited to this exact
candidate, dependency paths and local/approved-peer exposure. It requires
fresh advisory/KEV checks and manual upstream review at every release attempt,
before renewal, and November 26 if still waiting. Latest published API 0.32.2,
common-web 0.5.17, Lexicon 0.7.19 and XRPC 0.8.18 still require Zod ^3.23.8;
the advisory's first fixed Zod version is 4.6.6. A forced major upgrade and a
partial Lex migration remain out of scope. No runtime or dependency change is
proposed. See #68 and #77 for the approval and current release status.

### Supported dependency ranges and returned mail findings

The corrective candidate removes unsupported forced Nodemailer 10.5.0,
html-to-text 10.0.1, glob 14 and associated minimatch overrides. It retains
upstream PDS 0.5.59, which requires Nodemailer ^6.8.0, and the mail plugin's
exact html-to-text 7.1.1 contract. Supported resolutions include Nodemailer
6.10.1 and glob 10.5.0. Compatible Hono, esbuild, form-data and ws fixes remain.

Fresh lock audits return five High Nodemailer roots: GHSA-rcmh-qjqh-p98v,
GHSA-p6gq-j5cr-w38f, GHSA-2x7j-588g-ccc2, GHSA-v53p-9fqp-m79j and
GHSA-r7g4-qg5f-qqm2. Moderate findings also return in the mailer and
glob/minimatch graph. These are tracked in #75 under #28, separately from the Lex hold.
No current supported PDS release was found to clear the mail dependency range.

Known mail-library file/URL and recipient-parser defects remain present.
The temporary default JSON-mail acceptance and telemetry non-applicability
below resolve the PDS release decisions within their reviewed scopes. SMTP is
outside the mail approval, and the MCP findings remain separate blockers.
These decisions do not claim fixes or authorize unsupported dependency changes.

### PDS telemetry decision (2026-11-19)

The two telemetry findings are **non-applicable to the reviewed PDS graph**:
Glob GHSA-3g3m-2fjr-6pw4 and Minimatch GHSA-g3hv-75wg-m249. They remain
scanner findings, not patched packages. The active decisions are in the single
policy register below, expire December 10, and require a current source check.

The sole declared chain is PDS telemetry → GCP detector → gcp-metadata 8.1.4
→ Gaxios 7.1.3 → Rimraf 5.0.10 → Glob 10.5.0 → Minimatch 9.0.9. Gaxios's
published CJS and ESM runtime entrypoints, all twelve runtime files including
both util.cjs files, and their literal dynamic imports never load or call the
three filesystem/pattern libraries. Glob's advisory requires a cancellable
filesystem walk; Minimatch's requires executing pattern preprocessing. Neither
operation is reached through this dependency chain.

The existing dependency check now verifies the sole declared parent edges and
hashes Gaxios's package metadata/export map and complete CJS/ESM runtime source
trees against the reviewed artifact. Changed runtime source, added runtime
files and a new declared parent each fail a negative control. No vulnerability
reproduction, runtime workaround, override or new gate mechanism is added.

Fresh registry review found no supported update that removes this chain:
latest PDS 0.5.61 still uses telemetry 0.5.0; the latest GCP detector still
requires gcp-metadata ^8, whose newest 8.1.4 pins Gaxios 7.1.3 exactly.
Newer Gaxios releases remove Rimraf but cannot replace that exact pin.
Recheck upstream at the next release attempt, before renewal, and November 26
if still waiting. This is a manual review, with no scheduled monitoring.

### Issue #75 source assessment (2026-11-17, historical)

The following assessment predates the default-mail approval and telemetry
non-applicability decisions above. Its blocked results are historical evidence;
the active policy register governs the current candidate.


**Outcome: no release clearance.** Fresh official metadata and actual installed
source were reviewed for all 24 PDS advisories. Fourteen remain blocked by
recipient evidence or supported SMTP/operator configuration; ten have possible
non-applicability arguments but lack complete consumer proof and also remain
blocked. No finding is marked fixed, mitigated or approved for exemption by this
assessment. The existing policy JSON, expiry dates and required tests are unchanged.

Canonical PDS 0.5.59 constructs both normal and moderation transports from the
configured SMTP URL, or uses JSON transport when unconfigured
(`dist/context.js:82-89`). All 22 mailer advisories have first patched versions
in Nodemailer 7 or later; the freshly queried supported PDS 0.5.60 still requires
Nodemailer ^6.8.0 and the current converter plugin still requires exact
html-to-text 7.1.1. There is no supported dependency bump that clears these
mail findings. Stop local-fix attempts rather than restore the forced major.

Source confirms the SMTP response parsers consume server-controlled bytes, so
filtering HTTP mail fields cannot establish their safety. Two configured PDS
transports also share a host-keyed DNS cache that retains TLS servername and can
overwrite the second transport's configured identity. A no-network, constructed
cache control reproduced that identity reuse; it was not a complete TLS or
credential-disclosure test. No malicious SMTP interaction was performed and no
public PDS exploit is claimed. These moderate findings still need disposition;
they have not been accepted merely because their severity is below High.

The direct mailer test still fails its file-access assertion after four JSON
route cases. Administrative email updates bypass ordinary recipient validation,
and later unauthenticated reset requests can consume the stored address. The
proposed new route/recipient test implementation did not complete: an automatic
safety check flagged the delegated step. Its partial draft was excluded from
both corrective branches; no security assertion was weakened. SMTP/parser cases
and route-level file/URL non-applicability remain unproved, not passing.

The following is dated review evidence, not a second approval policy. All rows
remain blocked. For every row, the affected range and metadata revision are in
the fresh metadata receipt; future version/revision/exposure changes require
reassessment. No High/Critical disposition or deadline extension is introduced.

Nodes: **N** = `node_modules/@atproto/pds/node_modules/nodemailer@6.10.1`;
**G** = `node_modules/rimraf/node_modules/glob@10.5.0`;
**M** = `node_modules/rimraf/node_modules/minimatch@9.0.9`.

<details>
<summary>All 24 PDS advisories, source classification and unresolved proof</summary>

| Advisory | Severity | First patched version | Node | Decision | Source-level assessment |
| --- | --- | --- | --- | --- | --- |
| [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) | moderate | 14.0.2 | G | Blocked: non-applicability not yet proved | Glob AbortSignal walk requires invoked glob/stream over pattern/tree. Actual gaxios7.1.3 runtime cjs/src+esm/src has zero whole-token rimraf/glob/minimatch references; rimraf is declared dependency, not found runtime caller. |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | moderate | 11.0.1 | M | Blocked: non-applicability not yet proved | Minimatch pattern amplification requires optimizationLevel>=2 and attacker pattern. Only current parent is nested glob10 via rimraf5; same absent gaxios caller. |
| [GHSA-mm7p-fcc7-pg87](https://github.com/advisories/GHSA-mm7p-fcc7-pg87) | moderate | 7.0.7 | N | Blocked: needs recipient evidence | Canonical user account email is passed to Nodemailer addressparser; malformed string acceptance, nesting, length and header/envelope interpretation need actual PDS validation evidence. |
| [GHSA-c7w3-x93f-qmm8](https://github.com/advisories/GHSA-c7w3-x93f-qmm8) | low | 8.0.4 | N | Blocked: non-applicability not yet proved | SMTP MAIL FROM envelope.size is not set by canonical ServerMailer/ModerationMailer options. |
| [GHSA-vvjj-xcjg-gr5g](https://github.com/advisories/GHSA-vvjj-xcjg-gr5g) | moderate | 8.0.5 | N | Blocked: operator configuration | PDS passes operator SMTP URL unfiltered; scalar name query accepted and reaches HELO/EHLO. Public HTTP does not set it, but config input exists. |
| [GHSA-268h-hp4c-crq3](https://github.com/advisories/GHSA-268h-hp4c-crq3) | moderate | 8.0.9 | N | Blocked: non-applicability not yet proved | List-* structured header comments are not constructed by canonical mailers. |
| [GHSA-wqvq-jvpq-h66f](https://github.com/advisories/GHSA-wqvq-jvpq-h66f) | moderate | 8.0.9 | N | Blocked: non-applicability not yet proved | Default JSON transport is real; bypass requires structured attachment/content source normalization and safety flags. Canonical HTML is built string and mailOpts callers narrow. |
| [GHSA-rcmh-qjqh-p98v](https://github.com/advisories/GHSA-rcmh-qjqh-p98v) | high | 7.0.11 | N | Blocked: needs recipient evidence | Canonical user account email is passed to Nodemailer addressparser; malformed string acceptance, nesting, length and header/envelope interpretation need actual PDS validation evidence. |
| [GHSA-p6gq-j5cr-w38f](https://github.com/advisories/GHSA-p6gq-j5cr-w38f) | high | 9.0.1 | N | Blocked: non-applicability not yet proved | Mail-level raw option not passed by known canonical HTTP callers; mailer itself spreads mailOpts, so direct helper permissiveness is insufficient proof. |
| [GHSA-8m3c-c648-2xjj](https://github.com/advisories/GHSA-8m3c-c648-2xjj) | moderate | 9.1.1 | N | Blocked: non-applicability not yet proved | Legacy MailMessage.resolveContent invocation not found in PDS mailers. |
| [GHSA-wmmp-3585-3rmp](https://github.com/advisories/GHSA-wmmp-3585-3rmp) | moderate | 9.1.0 | N | Blocked: needs recipient evidence | User account email reaches canonical to; exact accepted email grammar/normalization and domain comparison need actual HTTP proof. |
| [GHSA-2x7j-588g-ccc2](https://github.com/advisories/GHSA-2x7j-588g-ccc2) | high | 9.1.0 | N | Blocked: needs recipient evidence | Canonical user account email is passed to Nodemailer addressparser; malformed string acceptance, nesting, length and header/envelope interpretation need actual PDS validation evidence. |
| [GHSA-cc9r-2j5m-2m83](https://github.com/advisories/GHSA-cc9r-2j5m-2m83) | moderate | 9.1.0 | N | Blocked: needs recipient evidence | Account email reaches addressparser; RFC5322 comments may be rejected by upstream account validation but must prove real consumer. |
| [GHSA-6vj9-mwq6-2f5v](https://github.com/advisories/GHSA-6vj9-mwq6-2f5v) | moderate | 10.0.2 | N | Blocked: configured SMTP | Two PDS transports share process-global host-keyed DNS cache. PDS-style smtps URLs accept different tls.servername values for same host. Constructed cached resolver control returned first name for second requested name (no network). |
| [GHSA-8vvx-rff5-p5rq](https://github.com/advisories/GHSA-8vvx-rff5-p5rq) | moderate | 10.0.2 | N | Blocked: non-applicability not yet proved | Nested structured recipient array is absent from canonical account email string callers. |
| [GHSA-v53p-9fqp-m79j](https://github.com/advisories/GHSA-v53p-9fqp-m79j) | high | 10.0.6 | N | Blocked: needs recipient evidence | Canonical user account email is passed to Nodemailer addressparser; malformed string acceptance, nesting, length and header/envelope interpretation need actual PDS validation evidence. |
| [GHSA-r7g4-qg5f-qqm2](https://github.com/advisories/GHSA-r7g4-qg5f-qqm2) | high | 8.0.8 | N | Blocked: non-applicability not yet proved | OAuth2 token fetch has rejectUnauthorized:false. Canonical PDS passes only SMTP URL; nested auth.type/clientId/refreshToken URL keys are ignored; actual constructor control yielded LOGIN and no oauth2. API OAuth-provider stack is separate from SMTP OAuth2. |
| [GHSA-39m8-27wv-hr27](https://github.com/advisories/GHSA-39m8-27wv-hr27) | moderate | 10.0.10 | N | Blocked: non-applicability not yet proved | Canonical mailers/config never construct DKIM key/options or folded attacker-controlled signed header; URL dkim.* ignored. |
| [GHSA-8c8m-p3m8-cjg8](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8) | moderate | 10.1.4 | N | Blocked: needs recipient evidence | Canonical user account email is passed to Nodemailer addressparser; malformed string acceptance, nesting, length and header/envelope interpretation need actual PDS validation evidence. |
| [GHSA-m943-m63m-w62w](https://github.com/advisories/GHSA-m943-m63m-w62w) | moderate | 10.1.4 | N | Blocked: needs recipient evidence | Canonical user account email is passed to Nodemailer addressparser; malformed string acceptance, nesting, length and header/envelope interpretation need actual PDS validation evidence. |
| [GHSA-85x2-q946-cp5h](https://github.com/advisories/GHSA-85x2-q946-cp5h) | moderate | 10.1.4 | N | Blocked: needs recipient evidence | Canonical user account email is passed to Nodemailer addressparser; malformed string acceptance, nesting, length and header/envelope interpretation need actual PDS validation evidence. |
| [GHSA-4ffr-jq9g-5ffx](https://github.com/advisories/GHSA-4ffr-jq9g-5ffx) | moderate | 10.0.13 | N | Blocked: configured SMTP | AUTH mechanism regex parses peer-controlled EHLO capability bytes before successful auth, including LOGIN mode. Restricting HTTP mail fields does not protect parser. |
| [GHSA-g73g-hqqh-jr95](https://github.com/advisories/GHSA-g73g-hqqh-jr95) | moderate | 10.0.13 | N | Blocked: needs recipient evidence | Canonical user account email is passed to Nodemailer addressparser; malformed string acceptance, nesting, length and header/envelope interpretation need actual PDS validation evidence. |
| [GHSA-4g23-2xm8-66gc](https://github.com/advisories/GHSA-4g23-2xm8-66gc) | moderate | 10.0.10 | N | Blocked: configured SMTP | All SMTP replies use uncapped multiline continuation reassembly; malicious server or preSTARTTLS MITM can starve PDS event loop. Timer is not work/size bound. |

</details>

Sources examined from the exact PDS 0.5.59 / Nodemailer 6.10.1 artifacts:
PDS `dist/context.js:82-89`, `dist/mailer/index.js:69-78`,
`dist/mailer/moderation.js:9-22`,
`dist/api/com/atproto/admin/sendEmail.js:4-25`,
`dist/api/com/atproto/admin/updateAccountEmail.js:4-22`, the account manager and
OAuth store mail callbacks; Nodemailer `lib/shared/index.js:70-178,273-345`,
`lib/smtp-connection/index.js:297-331` and its EHLO/response parsers,
`lib/smtp-transport/index.js` authentication construction and
`lib/fetch/index.js` token-fetch TLS options. All are pinned by this candidate's
lock. Actual gaxios 7.1.3 production CJS/ESM source has no whole-token
rimraf/glob/minimatch reference; that is a non-applicability candidate, not a
complete transitive import/call proof.

Supporting receipts: `/private/tmp/ait-issue75-advisory-metadata-20261117.json`
(fresh official GitHub advisory responses),
`/private/tmp/ait-issue75-advisory-triage-20261117.md` (full source map), and the
unchanged `/private/tmp/ait-supported-mailer.log` baseline. The table above
preserves the review outcome without requiring those temporary files. #75
remains open for supported upstream resolution and missing consumer evidence;
MCP Zod remains #68. PRs #76/#77 remain unmerged and releases held.

[#28](https://github.com/natewalton/ait-protocol/issues/28) retains the independent
PLC Kysely High finding (GHSA-8cpq-38p9-67gx). Its PostgreSQL dialect disposition
is non-applicability, not a Lex migration fix. Resolved PDS Kysely/file-type and
Elliptic findings remain resolved; completed security issues are not reopened.
No scheduled monitoring is added. Reassess the migration prerequisite when this
work is resumed, and enforce current policy at each PR/release check.

## Approved peer.5 default-mail risk decision

Supported PDS dependencies are mandatory. The maintainer approved temporary
acceptance of the default-mail residual risk on November 19, 2026, after
independent review. Owner: @natewalton. Expiry: December 10, 2026. Next manual
upstream review: November 26, and at every release attempt or renewal.
Telemetry and MCP findings remain separate decisions.

This is the maintainer's recorded risk decision for the scope below.
The PDS Nodemailer entries below require the explicit
`managed-default-json` release configuration and a fresh trusted mail-result
regression. The gate reports that scope and the known file/URL failures.
Installer and launcher identity checks establish the reviewed distribution
defaults. They do not inspect or clear a user's preserved configuration.
Operator-configured SMTP requires a separate decision.

The reviewed configuration uses the managed loopback PDS listener, default JSON
mail and AIT's generated account emails. The peer interface exposes approved
sync/read operations and does not forward account mail requests. The approval covers the default JSON mail configuration. Operator-configured
SMTP and moderation SMTP require a separate decision. Release notes must state
this scope and describe the residual risk to users.

The three High recipient-parser findings remain plausible local denial-of-service
risks because stored addresses can reach the parser. Normal account inputs are
validated, but administrative and historical addresses have weaker provenance.
The approval covers that uncertainty only for the stated configuration.
The High raw-message and OAuth2-token findings need inputs not supplied by the
traced canonical callers. Those observations support a narrower exposure
assessment, without claiming the dependency has been fixed.

Known upstream file/URL and recipient-parser vulnerabilities remain accepted
residual risks in this configuration. The earlier isolated fixture reproduced
the file/URL defects and measured a recipient-parser case at 46.5 seconds;
those results are evidence, not claims of fixes. Reproducing an accepted
upstream vulnerability is not a release requirement. The required mail-scope
check verifies the reviewed distribution defaults, peer exposure and dependency
identity without invoking the mailer. The original strict mail-library fixture
remains available for optional investigation and is not run by the release gate.
SMTP is outside this approval.
The default-mail residual risk is accepted while supported upstream fixes are
unavailable, within the dates above. Release remains subject to complete
required check results and enforcement of this scope. The telemetry and MCP
decisions are recorded separately in the same policy below. If SMTP
remains within peer.5's supported release scope, its broader risks still require
review before any acceptance applies. See #77 for the current release decision.

## Maintained policy

This is the single active machine-readable policy. The old decisions below are
historical evidence, not authorization. Current Kysely decisions require actual
dialect regressions; current Zod mitigation requires the entire bounded ingress
suite to pass. The supported upstream PDS 0.5.59 retains patched Kysely 0.29.9
and file-type 22.3.0 and removes the old key-encoder/Elliptic chain. Unsupported
mail/converter/glob overrides and the MCP-wide Zod override are withdrawn.
Returned mail and MCP findings are not cleared by the old candidate's passing
tests. AIT tool schemas use supported Zod 4 independently of upstream Zod 3.
Existing exact dispositions and original expiries remain enforced. Affected
historical releases remain blocked by the current checker. The published
experimental.3 transport must match its reviewed identity and pass a fresh audit;
older experimental.1 releases remain blocked. Reviewed lower-severity
residual risks may use explicit accepted-risk decisions. An accepted upstream
High remains visible as residual risk in the gate report and release notes.
Expired blocked records
remain useful explanations; they never authorize publication. A real approved
disposition needs its exact advisory revision/status and actual current passing
regressions. High/Critical validity is at most 30 days; expiry requires renewed
evidence at the next check. Removing a scanner finding removes its exception.

### Unscored native non-applicability rule

The whole native lock remains
in the audit. Only a Rust finding with an exact reviewed `non-applicable`
disposition may retain `reviewedSeverity: "unknown"`; npm decisions, accepted
risk, mitigation and informational borrowing cannot use it. Artifact/source-lock
fingerprints, advisory revision, supported exposure, current regression and an
expiry no more than 30 days after review remain required. Changed identity or
failed evidence blocks. Nate approved this rule after independent review on November 22, 2026.

### Heapless assessments for the macOS ARM artifact

The native audit retains nine individually identified
unknown-severity findings. Four affected APIs are absent from the locked source;
five have affected source but no production caller in this exact artifact.
Symbol absence is supplementary, not the proof. The existing immutable-addon
regression binds package/loader/addon bytes and target to the independently
reviewed source/build assessment.

Source d50c2b7de23ac8872db630056897742518d9706d; Cargo.lock SHA256
3423a54d6c121664edc1f6b6af7339183e23a1fbcc3c1322b5f408ec72194653.
Artifact tarball SHA256 ea3d644d3523480be02708f434c41340905f8cc7668e07dfd7f843a6080fd3b3;
addon SHA256 e56045238f76664184eb17a33717bafcdbdc1792bffbd52a34aa9d36deaa2bad.

Function-specific assessment:

The lock entry binds Heapless 0.7.17 to crates.io checksum
`cdc6457c0eb62c71aac4bc17216026d8410337c4126773b9c5daba343f17964f`.
The exact target-resolved Cargo graph contains 355 packages, but only Postcard
1.1.3 has a dependency edge to Heapless. Postcard's non-test source exposes
Heapless `Vec<u8>` serialization helpers and generic `Vec`/`String` size
implementations. No resolved downstream source calls `postcard::to_vec`,
`postcard::to_vec_cobs`, or `HVec`, and Postcard does not use any affected
Heapless type or method below. An unstripped clean locked build from the exact
source contains no symbol name with `heapless`; this is supplemental
confirmation because inlining and symbol stripping make name absence
insufficient by itself and the rebuilt bytes are not the published bytes.

| Advisory | Exact 0.7.17 source and trigger | Exact artifact reachability |
| --- | --- | --- |
| 0574 | **Affected source exists** under the older name `FindMut::pop`: after `DerefMut` sets `maybe_changed`, `pop` removes the value but leaves `maybe_changed` set, so its destructor removes/reinserts again. The 0.9.4 fix clears that flag before popping. | No Postcard reference to `SortedLinkedList`, `FindMut`, or `find_mut`; no path into the artifact. |
| 0575 | **Affected source exists**: `spsc::Queue`/`Consumer::peek` reads the head with `Ordering::Relaxed`. Trigger requires concurrent producer/consumer use of `peek`. | No Postcard reference to `spsc`, `Queue`, `Consumer`, or `peek`; no path into the artifact. |
| 0576 | **Affected API is absent**: `IndexMap::truncate` does not exist anywhere in 0.7.17 `indexmap.rs`. | No callable function exists. |
| 0577 | **Some affected source exists**: `Deque::clear`, `HistoryBuffer::{clear,write}`, `IndexMap::clear`, and `Vec::IntoIter::drop`; `IndexMap::{retain,truncate}` are absent. The trigger is a panic while dropping a generic element during one of those operations. | Postcard uses none of `Deque`, `HistoryBuffer`, or production `IndexMap`; its only concrete production Heapless buffer is `Vec<u8>` and it never creates or consumes Heapless `Vec::IntoIter`. `u8` has no panicking destructor. |
| 0578 | **Affected API is absent**: 0.7.17 has no `zeroize` feature, dependency, implementation, or reference. The implementation first exists in the 0.9 line behind the `zeroize` feature. | No callable function exists; the exact build also lacks the feature. |
| 0579 | **Affected API is absent**: 0.7.17 `Deque` has no `TryFrom` implementation. In 0.9.3 the full-array path sets `back = NS`; 0.9.4 fixes it to `back = 0` when full. | No callable function exists. RustSec specifically bounds this affected function to `>=0.9.2, <0.9.4`. |
| 0580 | **Affected source exists**: the `cas` feature compiles 0.7.17 `pool::cas::Stack`, whose concurrent Treiber stack operations are within RustSec's `<0.8.0` range. Trigger requires concurrent pool use. | No Postcard reference to `pool`, `Pool`, or its stack operations; no path into the artifact. |
| 0581 | **Affected API is absent**: `Deque::make_contiguous` does not exist in 0.7.17. | No callable function exists. |
| 0582 | **Affected source exists**: 0.7.17 `IndexMap::insert` stores a 16-bit hash and 16-bit index in `NonZeroU32`. The upstream proof uses capacity `1 << 17`, inserts indices `0..=u16::MAX`, and makes the terminal index and hash both `u16::MAX`, producing the forbidden zero representation. | Postcard's `FnvIndexMap` references are test-only; no production map is instantiated, much less a 65,536-entry map. |

Exact source-file SHA-256 values used for those findings:

- `sorted_linked_list.rs`: `6c9c4635a7f7961a0411258bd720195a2b9a32e519095b929bbbc190abd4e7f7`
- `spsc.rs`: `8dc44f55d2e7f2ed5c3e603671d7b21cdf0816951f25a66e9f85cfbdc24d56c1`
- `indexmap.rs`: `2cc09da8e1d1b5b66310866e7e7589d819572c24ff000feb80712a0a5e610a00`
- `deque.rs`: `a25568cfa4433249f2c4e47c496556550d4e4a25ab7d47e64a574a21d461d14c`
- `histbuf.rs`: `0bb055beb205a5d7d384a2fc8d56bdd33211d438250e29780974f1006448d6e9`
- `vec.rs`: `8eb189473f94845e70a1432c8c0cf3cac320cfefa65a710ca1be9c15e3b91a22`
- `pool/cas.rs`: `168258fe8c0f2724de9d344b4dce662ad7ffd66de4c686a547243f846f4274b2`

This is nine function-specific determinations, not a family waiver. Five
records (0574, 0575, 0577, 0580, and 0582) describe source that is genuinely
affected but unreachable from this exact artifact. Four (0576, 0578, 0579,
and 0581) name APIs absent from the locked source. Any dependency, feature,
target, source, loader, or addon-byte change invalidates the determination.


Reproduce using the pinned source and published crate sources:

```sh
cargo tree --locked --target aarch64-apple-darwin -p number0_iroh -e features -i heapless@0.7.17
cargo build --locked --release --target aarch64-apple-darwin -p number0_iroh -vv
```

The exact build passed all 28 package tests. Supported Postcard and full latest-compatible Cargo updates retain heapless 0.7. Forcing 0.9 violates the declared ^0.7 requirement. No unsupported override or feature-filtered native audit was adopted.

Nate approved the nine individual determinations after independent review on November 22, 2026. The active records below expire December 10, 2026.

### URL origin analysis for experimental.3

The November 22 audit identified [RUSTSEC-2026-0592](https://github.com/RustSec/advisory-db/blob/main/crates/url/RUSTSEC-2026-0592.md) in url 2.5.8. Independent review of the 355 target-resolved crate directories and FFI found no caller or function reference to Url::origin or quirks::origin outside the url crate. The active determination covers only the exact experimental.3 macOS ARM artifact and expires December 10, 2026. The audit retains unknown severity. The next native build can take the compatible upstream url 2.5.9 patch.

### Reviewing upstream High risk

Use the existing `accepted-risk` decision and add `upstreamAcceptance` with the
reported `candidateTree`, the last supported release's `baselineCommit`, a
distinct `reviewer`, `upstreamCheckedOn`, and a written `supportedFixCheck`,
`exposureComparison`, and `exploitationReview`. Keep exact finding identity,
owner, evidence, passing regressions, and the existing maximum 30-day review
period. Get the maintainer's explicit acceptance after independent review.
A supported dependency graph is mandatory. Restoring upstream's declared
ranges can bring back advisories suppressed by a previous unsupported override.
That restoration requires an explicit residual-risk decision, and advisory-count
equivalence with the unsupported graph is not an approval requirement. Review
new capabilities, reachable inputs and configuration changes for material risk,
and flag those changes for discussion. The gate verifies scope and record
completeness. Reviewers establish the underlying factual claims.

The candidate fingerprint includes the committed tree except this register,
so reviewing or renewing the register can leave the tested code identity
intact. The gate checks the baseline against the supported release inventory
and requires the candidate's exposure to match. It checks CISA KEV against the
current advisory's CVE IDs for proposed High acceptances. KEV presence blocks
acceptance. Absence, including the case of an advisory with no CVE, does not
establish lack of exploitation and still requires a documented review.
Missing advisory metadata or an unavailable KEV check blocks acceptance.

Recheck published upstream packages at every release attempt and before
renewal. Log the date, result and next manual review date in the existing
issue while it blocks a release. If a supported fix becomes available, assess
it on an isolated candidate before relying again on an exception. The gate
checks the record and expiry. The maintainer performs the upstream recheck and
verifies the available options. No scheduler is required. Required AIT exposure and behavior checks remain blockers. Tests that merely
reproduce explicitly accepted upstream vulnerabilities are not release requirements.

Native provenance identifies the published binary's source and locked graph; it
does not assert that the graph is free from advisories or prove binary reproduction.
Known embedded PLC validators/compiler require their own current regressions even
if an external dependency override makes npm's graph appear clean. The same
disposition list handles RustSec maintenance notices as informational reviewed
risks; this does not invent a CVSS severity for native vulnerabilities. Unknown severity blocks unless the exact Rust non-applicability rule above applies. Native advisory revisions are hashes of
the advisory record, and native component fingerprints bind the package digest,
source commit, source-lock digest and exact crate path/version.

<!-- security-policy -->
```json
{
  "schemaVersion": 1,
  "supportedReleases": [
    {
      "tag": "v0.1.45",
      "commit": "c976d1b29740784456803cee21da116ee5dea7d2",
      "exposure": "local"
    },
    {
      "tag": "v0.1.46",
      "commit": "8cadfd3d7bbd54c46622ebe120678911d73986fb",
      "exposure": "local-and-approved-peer"
    },
    {
      "tag": "v0.1.46-peer.1",
      "commit": "e16094956f1d122a89b6090cc4ef1224ea56cfd9",
      "exposure": "local-and-approved-peer"
    },
    {
      "tag": "v0.1.46-peer.2",
      "commit": "3fe1681b06f2de0fa98402f0dac5594dee7a62ba",
      "exposure": "local-and-approved-peer"
    },
    {
      "tag": "v0.1.47",
      "commit": "70b45aa6778a4ff821119981189943d275e71632",
      "exposure": "local-and-approved-peer"
    },
    {
      "tag": "v0.1.46-peer.3",
      "commit": "7a20b018bd98246bc69524a0e052bfc75f95307c",
      "exposure": "local-and-approved-peer"
    },
    {
      "tag": "v0.1.48-peer.1",
      "commit": "bd0304689103125207dd21aec87054c2978386e0",
      "exposure": "local-and-approved-peer"
    },
    {
      "tag": "v0.1.48",
      "commit": "b4ea412c50caf3a21f5e270f65b20906dc76f0de",
      "exposure": "local-and-approved-peer"
    },
    {
      "tag": "v0.1.48-peer.4",
      "commit": "8848fd2f58ebd70f55be91320210a335686f82c1",
      "exposure": "local-and-approved-peer"
    },
    {
      "tag": "v0.1.48-peer.5",
      "commit": "74ae204f41f1bcd7acb3e3b4a16cd2c781aa4b06",
      "exposure": "local-and-approved-peer"
    },
    {
      "tag": "v0.1.49-peer.6",
      "commit": "0636e6243ba83dd69d9f0a18952a545a27853868",
      "exposure": "local-and-approved-peer"
    }
  ],
  "nativeArtifacts": [
    {
      "package": "@natewalton/iroh-direct",
      "version": "0.1.0-experimental.1",
      "url": "https://github.com/natewalton/iroh-ffi/releases/download/iroh-direct-v0.1.0-experimental.1/natewalton-iroh-direct-0.1.0-experimental.1.tgz",
      "digest": "sha256:bcd347b7b80c9decebd5336d9d1d7de52b3acc9b67f7d9c49f98c0d4a6e6b30a",
      "sourceCommit": "adce3ea5c33209a9052fa2c57d8269d7f32419dc",
      "sourceRepo": "https://github.com/natewalton/iroh-ffi",
      "lockDigest": "sha256:b6c3dda31ac42354d2eaa6feec17648420e92e60109580e3fff5548cfbaa1ecc",
      "target": "aarch64-apple-darwin"
    },
    {
      "package": "@natewalton/iroh-direct",
      "version": "0.1.0-experimental.3",
      "url": "https://github.com/natewalton/iroh-ffi/releases/download/iroh-direct-v0.1.0-experimental.3/natewalton-iroh-direct-0.1.0-experimental.3.tgz",
      "digest": "sha256:ea3d644d3523480be02708f434c41340905f8cc7668e07dfd7f843a6080fd3b3",
      "sourceCommit": "d50c2b7de23ac8872db630056897742518d9706d",
      "sourceRepo": "https://github.com/natewalton/iroh-ffi",
      "lockDigest": "sha256:3423a54d6c121664edc1f6b6af7339183e23a1fbcc3c1322b5f408ec72194653",
      "target": "aarch64-apple-darwin"
    }
  ],
  "embeddedComponents": [
    {
      "workspace": "plc",
      "package": "@did-plc/server",
      "location": "node_modules/@did-plc/server",
      "version": "0.0.1",
      "integrity": "sha512-GtxxHcOrOQ6fNI1ufq3Zqjc2PtWqPZOdsuzlwtxiH9XibUGwDkb0GmaBHyU5GiOxOKZEW1GspZ8mreBA6XOlTQ==",
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "kysely-dialects"
        },
        {
          "path": "bin/security-input-test.mjs",
          "check": "zod-ingress"
        }
      ]
    }
  ],
  "dispositions": [
    {
      "id": "plc-zod-GHSA-mrhx-c7xc-m3w5",
      "workspace": "plc",
      "package": "zod",
      "version": "3.25.76",
      "advisory": "GHSA-mrhx-c7xc-m3w5",
      "reviewedSeverity": "high",
      "decision": "mitigated",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "The CVE is rejected while the GHSA remains active. Actual supported PLC/PDS, peer and MCP ingress fixtures validate decoded byte/work limits, retained memory, malformed-input non-admission and subsequent permitted operations. CBOR/CAR work is checked before materialization; protocol framing violations close only their offending connection. This is mitigation within the documented resource envelope, not a zero-warning claim.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/zod",
          "dependencyFingerprint": "sha256:188e6a7b1c8c2dc9ee664b5d264aeb1b1e16df53d7f1bcb2fdc85f324cfbc696"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
        "https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2023/54xxx/CVE-2023-54404.json"
      ],
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "zod-ingress"
        }
      ],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-23T18:26:52Z"
    },
    {
      "id": "plc-kysely-GHSA-8cpq-38p9-67gx",
      "workspace": "plc",
      "package": "kysely",
      "version": "0.23.5",
      "advisory": "GHSA-8cpq-38p9-67gx",
      "reviewedSeverity": "high",
      "decision": "non-applicable",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "The actual bundled PLC compiler/constructor is PostgreSQL and the actual PDS constructor is SQLite. Candidate-bound dialect/literal regressions verify those paths; this advisory requires MySQL string-literal escaping. A newly introduced vulnerable dialect invalidates this decision.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/kysely",
          "dependencyFingerprint": "sha256:800b7f67feaf5efd8ab6f3c2ba09e5267f091b73fc44153694ebfa46adfa0925"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-8cpq-38p9-67gx"
      ],
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "kysely-dialects"
        }
      ],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-03-27T20:57:34Z"
    },
    {
      "id": "pds-zod-GHSA-mrhx-c7xc-m3w5",
      "workspace": "pds",
      "package": "zod",
      "version": "3.25.76",
      "advisory": "GHSA-mrhx-c7xc-m3w5",
      "reviewedSeverity": "high",
      "decision": "mitigated",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-15",
      "expiresOn": "2026-12-10",
      "reason": "The CVE is rejected while the GHSA remains active. Actual supported PLC/PDS, peer and MCP ingress fixtures validate decoded byte/work limits, retained memory, malformed-input non-admission and subsequent permitted operations. CBOR/CAR work is checked before materialization; protocol framing violations close only their offending connection. This is mitigation within the documented resource envelope, not a zero-warning claim.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/zod",
          "dependencyFingerprint": "sha256:2f5eeb6e059eddcaf2fdac1f39e07bd65132bec578ab4ddac3996ce66deac040"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
        "https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2023/54xxx/CVE-2023-54404.json"
      ],
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "zod-ingress"
        }
      ],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-23T18:26:52Z"
    },
    {
      "id": "appview-zod-GHSA-mrhx-c7xc-m3w5",
      "workspace": "appview",
      "package": "zod",
      "version": "3.25.76",
      "advisory": "GHSA-mrhx-c7xc-m3w5",
      "reviewedSeverity": "high",
      "decision": "mitigated",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-15",
      "expiresOn": "2026-12-10",
      "reason": "The CVE is rejected while the GHSA remains active. Actual supported PLC/PDS, peer and MCP ingress fixtures validate decoded byte/work limits, retained memory, malformed-input non-admission and subsequent permitted operations. CBOR/CAR work is checked before materialization; protocol framing violations close only their offending connection. This is mitigation within the documented resource envelope, not a zero-warning claim.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/zod",
          "dependencyFingerprint": "sha256:cd148c67f4a2c73ca995901f4363e05522bf44da17fcae744fdcbf5eaf43e2e7"
        },
        {
          "path": "node_modules/zod",
          "dependencyFingerprint": "sha256:5c8c0be20b4c3f09f24e800e34d0fb29f3667bf2d696d615107634cf0810b798"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
        "https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2023/54xxx/CVE-2023-54404.json"
      ],
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "zod-ingress"
        }
      ],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-23T18:26:52Z"
    },
    {
      "id": "rust-RUSTSEC-2026-0543-experimental3-darwin-arm64",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "chrono",
      "version": "0.4.45",
      "advisory": "RUSTSEC-2026-0543",
      "reviewedSeverity": "info",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:2ada3351db1564cef8838727c525cfbd15a69929045bb06d9de75f95666de2e4",
      "decision": "non-applicable",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "The exact locked number0_iroh graph for aarch64-apple-darwin excludes Chrono and WMI. The Windows target resolves Chrono through WMI. The immutable published package is macOS arm64 only, and the regression binds the candidate loading chain to those reviewed bytes. Full source lock scanning remains in force.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:chrono@0.4.45",
          "dependencyFingerprint": "sha256:9727198d9bc4712a37efc87c3fa3db5a65d32b8acf6630934adbe7fd5f0bfa27"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0543.html",
        "https://github.com/natewalton/ait-protocol/issues/78",
        "https://github.com/natewalton/iroh-ffi/blob/d50c2b7de23ac8872db630056897742518d9706d/iroh-js/build-package.sh"
      ],
      "regressions": [
        {
          "path": "bin/chrono-macos-artifact-test.mjs",
          "check": "chrono-macos-artifact"
        }
      ]
    },
    {
      "id": "rust-RUSTSEC-2023-0089-experimental3",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "atomic-polyfill",
      "version": "1.0.3",
      "advisory": "RUSTSEC-2023-0089",
      "reviewedSeverity": "info",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:ce16a8da1b84e69f002853abcd70f49d2bf4b38eb0b6ec5a93230a9bcfad966a",
      "decision": "accepted-risk",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-11",
      "expiresOn": "2026-12-10",
      "reason": "Reviewed unmaintained notice in the conservative full-workspace transport Cargo audit. No vulnerability or CVSS score is inferred from maintenance status. Retain this exact locked component for the focused patch; new vulnerability reports, changed source/component identities or expiry require fresh review. No target-based exclusion is used to obtain a pass.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:atomic-polyfill@1.0.3",
          "dependencyFingerprint": "sha256:9895b9a0700abe45880a744a3c0ee9efecc48c2975837a7c80cfefd78729bcf4"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2023-0089.html"
      ],
      "regressions": []
    },
    {
      "id": "rust-RUSTSEC-2026-0374-experimental3",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "basic-toml",
      "version": "0.1.10",
      "advisory": "RUSTSEC-2026-0374",
      "reviewedSeverity": "info",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:05c547d6e39cb0765cc96067f88cb8ab55a4b5335a98ecf7f6a67a3a0be27e9e",
      "decision": "accepted-risk",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-11",
      "expiresOn": "2026-12-10",
      "reason": "Reviewed unmaintained notice in the conservative full-workspace transport Cargo audit. No vulnerability or CVSS score is inferred from maintenance status. Retain this exact locked component for the focused patch; new vulnerability reports, changed source/component identities or expiry require fresh review. No target-based exclusion is used to obtain a pass.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:basic-toml@0.1.10",
          "dependencyFingerprint": "sha256:c6f8b2560457c75740c017ce4641f9fe5d76aac6bf4b968db5754248e35c6604"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0374.html"
      ],
      "regressions": []
    },
    {
      "id": "rust-RUSTSEC-2024-0436-experimental3",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "paste",
      "version": "1.0.15",
      "advisory": "RUSTSEC-2024-0436",
      "reviewedSeverity": "info",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:f5d6677b2552a0c8d5bf8c94593db7263d93ccb26a24f38165b1e4cf895da992",
      "decision": "accepted-risk",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-11",
      "expiresOn": "2026-12-10",
      "reason": "Reviewed unmaintained notice in the conservative full-workspace transport Cargo audit. No vulnerability or CVSS score is inferred from maintenance status. Retain this exact locked component for the focused patch; new vulnerability reports, changed source/component identities or expiry require fresh review. No target-based exclusion is used to obtain a pass.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:paste@1.0.15",
          "dependencyFingerprint": "sha256:e4ebb60066163f54b81e6f54b4eaf3c6858218ab44b7b0b24a70105636e83b27"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2024-0436.html"
      ],
      "regressions": []
    },
    {
      "id": "default-mail-GHSA-mm7p-fcc7-pg87",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-mm7p-fcc7-pg87",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2025-11-17T17:29:27Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-mm7p-fcc7-pg87",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-c7w3-x93f-qmm8",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-c7w3-x93f-qmm8",
      "reviewedSeverity": "low",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-03-26T22:26:46Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-c7w3-x93f-qmm8",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-vvjj-xcjg-gr5g",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-vvjj-xcjg-gr5g",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-04-08T15:05:21Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-vvjj-xcjg-gr5g",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-268h-hp4c-crq3",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-268h-hp4c-crq3",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-06-15T17:36:07Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-268h-hp4c-crq3",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-wqvq-jvpq-h66f",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-wqvq-jvpq-h66f",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-06-15T17:35:12Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-wqvq-jvpq-h66f",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-rcmh-qjqh-p98v",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-rcmh-qjqh-p98v",
      "reviewedSeverity": "high",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-07-15T21:55:34Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match. Nate renewed the decision for this reviewed candidate on November 22, 2026, with the original December 10 expiry. Nate renewed this decision for the reviewed PR #85 candidate on 2026-11-23 through December 10, 2026. Nate explicitly extended this approval to the peer.7 candidate with the version and two-Mac guide changes. The December 10 expiry is unchanged. Nate renewed this decision for the Node 26 candidate in PR #87 on 2026-11-24 through the original December 10 expiry.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-rcmh-qjqh-p98v",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ],
      "upstreamAcceptance": {
        "candidateTree": "sha256:39aaaff9262be34f05da9a20922b15aa86a93a8b7edfd6c15323f80469226995",
        "baselineCommit": "0636e6243ba83dd69d9f0a18952a545a27853868",
        "reviewer": "@ait-skills-dev",
        "upstreamCheckedOn": "2026-11-21",
        "supportedFixCheck": "November 21 registry review: PDS 0.5.64 still requires Nodemailer ^6.8.0. No supported upstream mail fix was available.",
        "exposureComparison": "The peer.4 audit used unsupported mail majors. Restoring supported versions is mandatory. Reviewed scope is default JSON/loopback/generated accounts; recipient parsing and the direct file/URL defect are explicitly retained risks. SMTP is outside approval. Independent November 21 review found no new network input or mail configuration from the Claude delivery changes. AIT Skills independently confirmed unchanged mail and MCP exposure in PR #85. The AppView change omits unusable historical records after verification and leaves the PDS, MCP, transport and dependency graph unchanged. AIT Skills independently confirmed the peer.7 version and guide change leaves the reviewed exposure unchanged.",
        "exploitationReview": "Current GitHub metadata reviewed for this finding and known inputs traced. KEV is freshly checked by the gate. Absence from KEV does not establish safety. Known resource/file risks remain disclosed."
      }
    },
    {
      "id": "default-mail-GHSA-p6gq-j5cr-w38f",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-p6gq-j5cr-w38f",
      "reviewedSeverity": "high",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-09-02T14:47:23Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match. Nate renewed the decision for this reviewed candidate on November 22, 2026, with the original December 10 expiry. Nate renewed this decision for the reviewed PR #85 candidate on 2026-11-23 through December 10, 2026. Nate explicitly extended this approval to the peer.7 candidate with the version and two-Mac guide changes. The December 10 expiry is unchanged. Nate renewed this decision for the Node 26 candidate in PR #87 on 2026-11-24 through the original December 10 expiry.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-p6gq-j5cr-w38f",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ],
      "upstreamAcceptance": {
        "candidateTree": "sha256:39aaaff9262be34f05da9a20922b15aa86a93a8b7edfd6c15323f80469226995",
        "baselineCommit": "0636e6243ba83dd69d9f0a18952a545a27853868",
        "reviewer": "@ait-skills-dev",
        "upstreamCheckedOn": "2026-11-21",
        "supportedFixCheck": "November 21 registry review: PDS 0.5.64 still requires Nodemailer ^6.8.0. No supported upstream mail fix was available.",
        "exposureComparison": "The peer.4 audit used unsupported mail majors. Restoring supported versions is mandatory. Reviewed scope is default JSON/loopback/generated accounts; recipient parsing and the direct file/URL defect are explicitly retained risks. SMTP is outside approval. Independent November 21 review found no new network input or mail configuration from the Claude delivery changes. AIT Skills independently confirmed unchanged mail and MCP exposure in PR #85. The AppView change omits unusable historical records after verification and leaves the PDS, MCP, transport and dependency graph unchanged. AIT Skills independently confirmed the peer.7 version and guide change leaves the reviewed exposure unchanged.",
        "exploitationReview": "Current GitHub metadata reviewed for this finding and known inputs traced. KEV is freshly checked by the gate. Absence from KEV does not establish safety. Known resource/file risks remain disclosed."
      }
    },
    {
      "id": "default-mail-GHSA-8m3c-c648-2xjj",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-8m3c-c648-2xjj",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-09-08T21:16:03Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-8m3c-c648-2xjj",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-wmmp-3585-3rmp",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-wmmp-3585-3rmp",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-09-08T21:33:33Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-wmmp-3585-3rmp",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-2x7j-588g-ccc2",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-2x7j-588g-ccc2",
      "reviewedSeverity": "high",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-09-08T21:33:19Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match. Nate renewed the decision for this reviewed candidate on November 22, 2026, with the original December 10 expiry. Nate renewed this decision for the reviewed PR #85 candidate on 2026-11-23 through December 10, 2026. Nate explicitly extended this approval to the peer.7 candidate with the version and two-Mac guide changes. The December 10 expiry is unchanged. Nate renewed this decision for the Node 26 candidate in PR #87 on 2026-11-24 through the original December 10 expiry.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-2x7j-588g-ccc2",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ],
      "upstreamAcceptance": {
        "candidateTree": "sha256:39aaaff9262be34f05da9a20922b15aa86a93a8b7edfd6c15323f80469226995",
        "baselineCommit": "0636e6243ba83dd69d9f0a18952a545a27853868",
        "reviewer": "@ait-skills-dev",
        "upstreamCheckedOn": "2026-11-21",
        "supportedFixCheck": "November 21 registry review: PDS 0.5.64 still requires Nodemailer ^6.8.0. No supported upstream mail fix was available.",
        "exposureComparison": "The peer.4 audit used unsupported mail majors. Restoring supported versions is mandatory. Reviewed scope is default JSON/loopback/generated accounts; recipient parsing and the direct file/URL defect are explicitly retained risks. SMTP is outside approval. Independent November 21 review found no new network input or mail configuration from the Claude delivery changes. AIT Skills independently confirmed unchanged mail and MCP exposure in PR #85. The AppView change omits unusable historical records after verification and leaves the PDS, MCP, transport and dependency graph unchanged. AIT Skills independently confirmed the peer.7 version and guide change leaves the reviewed exposure unchanged.",
        "exploitationReview": "Current GitHub metadata reviewed for this finding and known inputs traced. KEV is freshly checked by the gate. Absence from KEV does not establish safety. Known resource/file risks remain disclosed."
      }
    },
    {
      "id": "default-mail-GHSA-cc9r-2j5m-2m83",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-cc9r-2j5m-2m83",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-09-08T21:32:53Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-cc9r-2j5m-2m83",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-6vj9-mwq6-2f5v",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-6vj9-mwq6-2f5v",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-09-28T21:57:00Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-6vj9-mwq6-2f5v",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-8vvx-rff5-p5rq",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-8vvx-rff5-p5rq",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-09-29T18:25:05Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-8vvx-rff5-p5rq",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-v53p-9fqp-m79j",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-v53p-9fqp-m79j",
      "reviewedSeverity": "high",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-09-29T23:43:38Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match. Nate renewed the decision for this reviewed candidate on November 22, 2026, with the original December 10 expiry. Nate renewed this decision for the reviewed PR #85 candidate on 2026-11-23 through December 10, 2026. Nate explicitly extended this approval to the peer.7 candidate with the version and two-Mac guide changes. The December 10 expiry is unchanged. Nate renewed this decision for the Node 26 candidate in PR #87 on 2026-11-24 through the original December 10 expiry.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-v53p-9fqp-m79j",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ],
      "upstreamAcceptance": {
        "candidateTree": "sha256:39aaaff9262be34f05da9a20922b15aa86a93a8b7edfd6c15323f80469226995",
        "baselineCommit": "0636e6243ba83dd69d9f0a18952a545a27853868",
        "reviewer": "@ait-skills-dev",
        "upstreamCheckedOn": "2026-11-21",
        "supportedFixCheck": "November 21 registry review: PDS 0.5.64 still requires Nodemailer ^6.8.0. No supported upstream mail fix was available.",
        "exposureComparison": "The peer.4 audit used unsupported mail majors. Restoring supported versions is mandatory. Reviewed scope is default JSON/loopback/generated accounts; recipient parsing and the direct file/URL defect are explicitly retained risks. SMTP is outside approval. Independent November 21 review found no new network input or mail configuration from the Claude delivery changes. AIT Skills independently confirmed unchanged mail and MCP exposure in PR #85. The AppView change omits unusable historical records after verification and leaves the PDS, MCP, transport and dependency graph unchanged. AIT Skills independently confirmed the peer.7 version and guide change leaves the reviewed exposure unchanged.",
        "exploitationReview": "Current GitHub metadata reviewed for this finding and known inputs traced. KEV is freshly checked by the gate. Absence from KEV does not establish safety. Known resource/file risks remain disclosed."
      }
    },
    {
      "id": "default-mail-GHSA-r7g4-qg5f-qqm2",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-r7g4-qg5f-qqm2",
      "reviewedSeverity": "high",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-05T22:51:58Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match. Nate renewed the decision for this reviewed candidate on November 22, 2026, with the original December 10 expiry. Nate renewed this decision for the reviewed PR #85 candidate on 2026-11-23 through December 10, 2026. Nate explicitly extended this approval to the peer.7 candidate with the version and two-Mac guide changes. The December 10 expiry is unchanged. Nate renewed this decision for the Node 26 candidate in PR #87 on 2026-11-24 through the original December 10 expiry.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-r7g4-qg5f-qqm2",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ],
      "upstreamAcceptance": {
        "candidateTree": "sha256:39aaaff9262be34f05da9a20922b15aa86a93a8b7edfd6c15323f80469226995",
        "baselineCommit": "0636e6243ba83dd69d9f0a18952a545a27853868",
        "reviewer": "@ait-skills-dev",
        "upstreamCheckedOn": "2026-11-21",
        "supportedFixCheck": "November 21 registry review: PDS 0.5.64 still requires Nodemailer ^6.8.0. No supported upstream mail fix was available.",
        "exposureComparison": "The peer.4 audit used unsupported mail majors. Restoring supported versions is mandatory. Reviewed scope is default JSON/loopback/generated accounts; recipient parsing and the direct file/URL defect are explicitly retained risks. SMTP is outside approval. Independent November 21 review found no new network input or mail configuration from the Claude delivery changes. AIT Skills independently confirmed unchanged mail and MCP exposure in PR #85. The AppView change omits unusable historical records after verification and leaves the PDS, MCP, transport and dependency graph unchanged. AIT Skills independently confirmed the peer.7 version and guide change leaves the reviewed exposure unchanged.",
        "exploitationReview": "Current GitHub metadata reviewed for this finding and known inputs traced. KEV is freshly checked by the gate. Absence from KEV does not establish safety. Known resource/file risks remain disclosed."
      }
    },
    {
      "id": "default-mail-GHSA-39m8-27wv-hr27",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-39m8-27wv-hr27",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-22T16:07:06Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-39m8-27wv-hr27",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-8c8m-p3m8-cjg8",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-8c8m-p3m8-cjg8",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-23T21:53:05Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-8c8m-p3m8-cjg8",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-m943-m63m-w62w",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-m943-m63m-w62w",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-23T21:51:54Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-m943-m63m-w62w",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-85x2-q946-cp5h",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-85x2-q946-cp5h",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-23T21:51:19Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-85x2-q946-cp5h",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-4ffr-jq9g-5ffx",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-4ffr-jq9g-5ffx",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-27T15:04:41Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-4ffr-jq9g-5ffx",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-g73g-hqqh-jr95",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-g73g-hqqh-jr95",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-27T15:04:36Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-g73g-hqqh-jr95",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "default-mail-GHSA-4g23-2xm8-66gc",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "6.10.1",
      "advisory": "GHSA-4g23-2xm8-66gc",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-27T15:04:35Z",
      "decision": "accepted-risk",
      "configuration": "managed-default-json",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer approved residual upstream mail risk for managed loopback/default JSON mail on November19. Known direct file/URL protection failures remain documented evidence. Administrative and historical recipient addresses retain denial-of-service risk. Operator SMTP and moderation SMTP are outside approval. Known file/URL and recipient-parser defects, including the measured 46.5-second parser result, are accepted residual upstream risks; reproducing them is not a release requirement. The reviewed scope must still match.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/pds/node_modules/nodemailer",
          "dependencyFingerprint": "sha256:81de064b3476f5b9eccf75570f388513c841e79dc34babdd981809a0787d7089"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-4g23-2xm8-66gc",
        "https://github.com/natewalton/ait-protocol/pull/77",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/default-mail-scope-test.mjs",
          "check": "default-mail-approved-scope"
        }
      ]
    },
    {
      "id": "telemetry-unused-glob",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "glob",
      "version": "10.5.0",
      "advisory": "GHSA-3g3m-2fjr-6pw4",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-30T23:09:15Z",
      "decision": "non-applicable",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "The only declared runtime dependency chain is Gaxios 7.1.3 -> Rimraf 5 -> Glob 10 -> Minimatch 9. Reviewed Gaxios CJS and ESM runtime code, including util.cjs and literal dynamic imports, never loads or calls Rimraf, Glob or Minimatch. This advisory requires executing the unused filesystem/pattern operation. The required source-and-parent verification binds that review to the exact published code and dependency paths. Packages remain vulnerable; no canonical dependency is overridden or claimed fixed.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/rimraf/node_modules/glob",
          "dependencyFingerprint": "sha256:9920ed2808d8dbe7ed68c410db64c69c459574de31d7810369af0d42e3338fd3"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-3g3m-2fjr-6pw4",
        "https://registry.npmjs.org/gaxios/7.1.3",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/dependency-security-test.mjs",
          "check": "telemetry-unused-glob"
        }
      ]
    },
    {
      "id": "telemetry-unused-minimatch",
      "ecosystem": "npm",
      "workspace": "pds",
      "package": "minimatch",
      "version": "9.0.9",
      "advisory": "GHSA-g3hv-75wg-m249",
      "reviewedSeverity": "moderate",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-11-04T16:50:04Z",
      "decision": "non-applicable",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "The only declared runtime dependency chain is Gaxios 7.1.3 -> Rimraf 5 -> Glob 10 -> Minimatch 9. Reviewed Gaxios CJS and ESM runtime code, including util.cjs and literal dynamic imports, never loads or calls Rimraf, Glob or Minimatch. This advisory requires executing the unused filesystem/pattern operation. The required source-and-parent verification binds that review to the exact published code and dependency paths. Packages remain vulnerable; no canonical dependency is overridden or claimed fixed.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/rimraf/node_modules/minimatch",
          "dependencyFingerprint": "sha256:5a522fab73159d053e64dc463e2a036ec275e0ebcfff90e5f45e40bc0b95a7f4"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-g3hv-75wg-m249",
        "https://registry.npmjs.org/gaxios/7.1.3",
        "https://github.com/natewalton/ait-protocol/issues/75"
      ],
      "regressions": [
        {
          "path": "pds/scripts/dependency-security-test.mjs",
          "check": "telemetry-unused-glob"
        }
      ]
    },
    {
      "id": "mcp-zod-GHSA-mrhx-c7xc-m3w5",
      "ecosystem": "npm",
      "workspace": "mcp",
      "package": "zod",
      "version": "3.25.76",
      "advisory": "GHSA-mrhx-c7xc-m3w5",
      "reviewedSeverity": "high",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-23T18:26:52Z",
      "decision": "accepted-risk",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-19",
      "expiresOn": "2026-12-10",
      "reason": "Maintainer explicitly approved the independently reviewed temporary MCP availability-risk exception on November 19 through December 10. Supported upstream Zod 3 remains vulnerable. Local PDS HTTP responses can reach DID-document array validation without a complete response/work bound, potentially exhausting or terminating MCP or aitty. Existing stdio controls do not establish HTTP-response mitigation. No dependency override, custom validator or partial Lex migration is proposed. Nate renewed the decision for this reviewed candidate on November 22, 2026, with the original December 10 expiry. Nate renewed this decision for the reviewed PR #85 candidate on 2026-11-23 through December 10, 2026. Nate explicitly extended this approval to the peer.7 candidate with the version and two-Mac guide changes. The December 10 expiry is unchanged. Nate renewed this decision for the Node 26 candidate in PR #87 on 2026-11-24 through the original December 10 expiry.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/@atproto/api/node_modules/zod",
          "dependencyFingerprint": "sha256:ab05d5f107896b0dca1142cf7bf491eaa17bb9342c3c3a06ed6e9fa966ef3d24"
        },
        {
          "path": "node_modules/@atproto/common-web/node_modules/zod",
          "dependencyFingerprint": "sha256:863fc9e48a0f386218afac5add9f7ce61b9650638a1fcd27e4127ee97300f830"
        },
        {
          "path": "node_modules/@atproto/lexicon/node_modules/zod",
          "dependencyFingerprint": "sha256:5f6d34571cc8a16cde6f7aa5b8c6dec9d0198114ccdcc56b2dfe34b6c24ecc50"
        },
        {
          "path": "node_modules/@atproto/xrpc/node_modules/zod",
          "dependencyFingerprint": "sha256:5c483b12ed382d8b824b2caf5c3bf96bee3be8b10bfeb1f5075b64425cf0db78"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
        "https://github.com/bluesky-social/atproto/issues/5811",
        "https://github.com/natewalton/ait-protocol/issues/68",
        "https://github.com/natewalton/ait-protocol/pull/77"
      ],
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "zod-ingress"
        }
      ],
      "upstreamAcceptance": {
        "candidateTree": "sha256:39aaaff9262be34f05da9a20922b15aa86a93a8b7edfd6c15323f80469226995",
        "baselineCommit": "0636e6243ba83dd69d9f0a18952a545a27853868",
        "reviewer": "@ait-skills-dev",
        "upstreamCheckedOn": "2026-11-21",
        "supportedFixCheck": "November 21 registry review: API 0.32.5, common-web 0.5.19, Lexicon 0.7.21 and XRPC 0.8.20 still require Zod ^3.23.8. No complete supported upstream fix was available.",
        "exposureComparison": "Peer.4 suppressed these findings through an unsupported package-wide Zod override. Restoring upstream contracts is mandatory and scan equivalence is not required. MCP and aitty route canonical client requests through localPdsFetch to the configured loopback PDS with redirects rejected. Approved peers can contribute data. Common-web response-controlled collections lack a complete pre-validation work bound; process denial of service remains a residual risk. API/XRPC use fixed-shape scalar validators and Lexicon loads bundled schema documents plus scalar blob shapes, but no non-applicability exemption is claimed for any of the four paths. Independent November 21 review found no new network input or mail configuration from the Claude delivery changes. AIT Skills independently confirmed unchanged mail and MCP exposure in PR #85. The AppView change omits unusable historical records after verification and leaves the PDS, MCP, transport and dependency graph unchanged. AIT Skills independently confirmed the peer.7 version and guide change leaves the reviewed exposure unchanged.",
        "exploitationReview": "Fresh GitHub advisory metadata reviewed November 19; CVE-2023-54404 was absent from the CISA KEV catalog dated November 18. Absence is not proof of no exploitation. The release gate must repeat the fresh lookup. Known memory-exhaustion risk remains disclosed; existing ingress regressions prove only their actual tested surfaces."
      }
    },
    {
      "id": "rust-RUSTSEC-2026-0578-experimental3-darwin-arm64",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "heapless",
      "version": "0.7.17",
      "advisory": "RUSTSEC-2026-0578",
      "reviewedSeverity": "unknown",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:e871fa606e1192d66ef7fa660bbdf59bc9e6be896fe7607c0b067425e00a0bf1",
      "decision": "non-applicable",
      "owner": "@ait-developer",
      "reviewedOn": "2026-11-21",
      "expiresOn": "2026-12-10",
      "reason": "Independently reviewed and approved by Nate on November 22, 2026. The locked 0.7.17 source has no zeroize feature, dependency or implementation; affected SortedLinkedList::zeroize is absent. This determination binds only experimental.3 macOS ARM source/lock/features/loader/addon. It does not fix the crate or assign a severity.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:heapless@0.7.17",
          "dependencyFingerprint": "sha256:417650ee7c137d8b90b83b76041dac2192105179fa95a2d5abb99aa64be83e01"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0578.html",
        "https://github.com/natewalton/iroh-ffi/tree/d50c2b7de23ac8872db630056897742518d9706d",
        "https://docs.rs/crate/heapless/0.7.17/source/"
      ],
      "regressions": [
        {
          "path": "bin/chrono-macos-artifact-test.mjs",
          "check": "heapless-unaffected-artifact"
        }
      ]
    },
    {
      "id": "rust-RUSTSEC-2026-0579-experimental3-darwin-arm64",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "heapless",
      "version": "0.7.17",
      "advisory": "RUSTSEC-2026-0579",
      "reviewedSeverity": "unknown",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:6fabb957ee40f7f1c4a22166ddcde0d825c8937b4b05f210433d229ca818a629",
      "decision": "non-applicable",
      "owner": "@ait-developer",
      "reviewedOn": "2026-11-21",
      "expiresOn": "2026-12-10",
      "reason": "Independently reviewed and approved by Nate on November 22, 2026. Locked 0.7.17 Deque has no TryFrom implementation. RustSec bounds the affected function to >=0.9.2,<0.9.4. This determination binds only experimental.3 macOS ARM source/lock/features/loader/addon. It does not fix the crate or assign a severity.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:heapless@0.7.17",
          "dependencyFingerprint": "sha256:417650ee7c137d8b90b83b76041dac2192105179fa95a2d5abb99aa64be83e01"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0579.html",
        "https://github.com/natewalton/iroh-ffi/tree/d50c2b7de23ac8872db630056897742518d9706d",
        "https://docs.rs/crate/heapless/0.7.17/source/"
      ],
      "regressions": [
        {
          "path": "bin/chrono-macos-artifact-test.mjs",
          "check": "heapless-unaffected-artifact"
        }
      ]
    },
    {
      "id": "rust-RUSTSEC-2026-0576-experimental3-darwin-arm64",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "heapless",
      "version": "0.7.17",
      "advisory": "RUSTSEC-2026-0576",
      "reviewedSeverity": "unknown",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:f4daa6ca4a95ba854248b0ee5bbb2f91332d7a89458fba8a8e886b526ccfcd46",
      "decision": "non-applicable",
      "owner": "@ait-developer",
      "reviewedOn": "2026-11-21",
      "expiresOn": "2026-12-10",
      "reason": "Independently reviewed and approved by Nate on November 22, 2026. IndexMap::truncate does not exist in locked heapless 0.7.17. This determination binds only experimental.3 macOS ARM source/lock/features/loader/addon. It does not fix the crate or assign a severity.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:heapless@0.7.17",
          "dependencyFingerprint": "sha256:417650ee7c137d8b90b83b76041dac2192105179fa95a2d5abb99aa64be83e01"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0576.html",
        "https://github.com/natewalton/iroh-ffi/tree/d50c2b7de23ac8872db630056897742518d9706d",
        "https://docs.rs/crate/heapless/0.7.17/source/"
      ],
      "regressions": [
        {
          "path": "bin/chrono-macos-artifact-test.mjs",
          "check": "heapless-unaffected-artifact"
        }
      ]
    },
    {
      "id": "rust-RUSTSEC-2026-0581-experimental3-darwin-arm64",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "heapless",
      "version": "0.7.17",
      "advisory": "RUSTSEC-2026-0581",
      "reviewedSeverity": "unknown",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:14e8bbda46f0d01300a0bb0e0e0856c8faa4aa90de2e0dbd87c85084bb9937e2",
      "decision": "non-applicable",
      "owner": "@ait-developer",
      "reviewedOn": "2026-11-21",
      "expiresOn": "2026-12-10",
      "reason": "Independently reviewed and approved by Nate on November 22, 2026. Deque::make_contiguous does not exist in locked heapless 0.7.17. This determination binds only experimental.3 macOS ARM source/lock/features/loader/addon. It does not fix the crate or assign a severity.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:heapless@0.7.17",
          "dependencyFingerprint": "sha256:417650ee7c137d8b90b83b76041dac2192105179fa95a2d5abb99aa64be83e01"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0581.html",
        "https://github.com/natewalton/iroh-ffi/tree/d50c2b7de23ac8872db630056897742518d9706d",
        "https://docs.rs/crate/heapless/0.7.17/source/"
      ],
      "regressions": [
        {
          "path": "bin/chrono-macos-artifact-test.mjs",
          "check": "heapless-unaffected-artifact"
        }
      ]
    },
    {
      "id": "rust-RUSTSEC-2026-0580-experimental3-darwin-arm64",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "heapless",
      "version": "0.7.17",
      "advisory": "RUSTSEC-2026-0580",
      "reviewedSeverity": "unknown",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:c422c98b259a8b84d41b99b4f52529b154c3a16d2308f1c3923ebfc7c6c8043c",
      "decision": "non-applicable",
      "owner": "@ait-developer",
      "reviewedOn": "2026-11-21",
      "expiresOn": "2026-12-10",
      "reason": "Independently reviewed and approved by Nate on November 22, 2026. Affected cas Treiber stack is available in source, but Postcard has no pool/Pool/stack use. No concurrent pool operation is reachable in this exact artifact. This determination binds only experimental.3 macOS ARM source/lock/features/loader/addon. It does not fix the crate or assign a severity.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:heapless@0.7.17",
          "dependencyFingerprint": "sha256:417650ee7c137d8b90b83b76041dac2192105179fa95a2d5abb99aa64be83e01"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0580.html",
        "https://github.com/natewalton/iroh-ffi/tree/d50c2b7de23ac8872db630056897742518d9706d",
        "https://docs.rs/crate/heapless/0.7.17/source/"
      ],
      "regressions": [
        {
          "path": "bin/chrono-macos-artifact-test.mjs",
          "check": "heapless-unaffected-artifact"
        }
      ]
    },
    {
      "id": "rust-RUSTSEC-2026-0577-experimental3-darwin-arm64",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "heapless",
      "version": "0.7.17",
      "advisory": "RUSTSEC-2026-0577",
      "reviewedSeverity": "unknown",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:a8489832de83b93d05e6ab5fc4805b0b47565ad7dc7d02ad5c55795fd34a891d",
      "decision": "non-applicable",
      "owner": "@ait-developer",
      "reviewedOn": "2026-11-21",
      "expiresOn": "2026-12-10",
      "reason": "Independently reviewed and approved by Nate on November 22, 2026. Affected Deque/HistoryBuffer/IndexMap clearing and Vec::IntoIter dropping exist, but Postcard uses none of those paths. Its concrete Heapless serialization buffer is Vec<u8>; u8 has no panicking destructor. No affected iterator is created. This determination binds only experimental.3 macOS ARM source/lock/features/loader/addon. It does not fix the crate or assign a severity.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:heapless@0.7.17",
          "dependencyFingerprint": "sha256:417650ee7c137d8b90b83b76041dac2192105179fa95a2d5abb99aa64be83e01"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0577.html",
        "https://github.com/natewalton/iroh-ffi/tree/d50c2b7de23ac8872db630056897742518d9706d",
        "https://docs.rs/crate/heapless/0.7.17/source/"
      ],
      "regressions": [
        {
          "path": "bin/chrono-macos-artifact-test.mjs",
          "check": "heapless-unaffected-artifact"
        }
      ]
    },
    {
      "id": "rust-RUSTSEC-2026-0574-experimental3-darwin-arm64",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "heapless",
      "version": "0.7.17",
      "advisory": "RUSTSEC-2026-0574",
      "reviewedSeverity": "unknown",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:2dcbe6d9f61c8049585f1340c251e272e3ada2eea85311d588e2c96fa7138101",
      "decision": "non-applicable",
      "owner": "@ait-developer",
      "reviewedOn": "2026-11-21",
      "expiresOn": "2026-12-10",
      "reason": "Independently reviewed and approved by Nate on November 22, 2026. Affected FindMut::pop exists in 0.7.17, but its only compiled dependency consumer Postcard has no SortedLinkedList/FindMut/find_mut use. No path into the exact artifact. This determination binds only experimental.3 macOS ARM source/lock/features/loader/addon. It does not fix the crate or assign a severity.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:heapless@0.7.17",
          "dependencyFingerprint": "sha256:417650ee7c137d8b90b83b76041dac2192105179fa95a2d5abb99aa64be83e01"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0574.html",
        "https://github.com/natewalton/iroh-ffi/tree/d50c2b7de23ac8872db630056897742518d9706d",
        "https://docs.rs/crate/heapless/0.7.17/source/"
      ],
      "regressions": [
        {
          "path": "bin/chrono-macos-artifact-test.mjs",
          "check": "heapless-unaffected-artifact"
        }
      ]
    },
    {
      "id": "rust-RUSTSEC-2026-0575-experimental3-darwin-arm64",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "heapless",
      "version": "0.7.17",
      "advisory": "RUSTSEC-2026-0575",
      "reviewedSeverity": "unknown",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:936981025cb7bb9b35edb1d99a6209a9c848b101a9d12762e916505ec232fa45",
      "decision": "non-applicable",
      "owner": "@ait-developer",
      "reviewedOn": "2026-11-21",
      "expiresOn": "2026-12-10",
      "reason": "Independently reviewed and approved by Nate on November 22, 2026. Affected SPSC peek ordering exists, but Postcard has no spsc/Queue/Consumer/peek use. Concurrent queue use cannot be reached from the exact artifact. This determination binds only experimental.3 macOS ARM source/lock/features/loader/addon. It does not fix the crate or assign a severity.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:heapless@0.7.17",
          "dependencyFingerprint": "sha256:417650ee7c137d8b90b83b76041dac2192105179fa95a2d5abb99aa64be83e01"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0575.html",
        "https://github.com/natewalton/iroh-ffi/tree/d50c2b7de23ac8872db630056897742518d9706d",
        "https://docs.rs/crate/heapless/0.7.17/source/"
      ],
      "regressions": [
        {
          "path": "bin/chrono-macos-artifact-test.mjs",
          "check": "heapless-unaffected-artifact"
        }
      ]
    },
    {
      "id": "rust-RUSTSEC-2026-0582-experimental3-darwin-arm64",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "heapless",
      "version": "0.7.17",
      "advisory": "RUSTSEC-2026-0582",
      "reviewedSeverity": "unknown",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:7f99f51a9df4147ea94f4063fce331b7e4b0c72a1bbdf2a66f50635ae02a3dd2",
      "decision": "non-applicable",
      "owner": "@ait-developer",
      "reviewedOn": "2026-11-21",
      "expiresOn": "2026-12-10",
      "reason": "Independently reviewed and approved by Nate on November 22, 2026. Affected large IndexMap insert invariant exists, but Postcard FnvIndexMap references are test-only and no production Heapless map is instantiated. This determination binds only experimental.3 macOS ARM source/lock/features/loader/addon. It does not fix the crate or assign a severity.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:heapless@0.7.17",
          "dependencyFingerprint": "sha256:417650ee7c137d8b90b83b76041dac2192105179fa95a2d5abb99aa64be83e01"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0582.html",
        "https://github.com/natewalton/iroh-ffi/tree/d50c2b7de23ac8872db630056897742518d9706d",
        "https://docs.rs/crate/heapless/0.7.17/source/"
      ],
      "regressions": [
        {
          "path": "bin/chrono-macos-artifact-test.mjs",
          "check": "heapless-unaffected-artifact"
        }
      ]
    },
    {
      "id": "rust-RUSTSEC-2026-0592-experimental3-darwin-arm64",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "url",
      "version": "2.5.8",
      "advisory": "RUSTSEC-2026-0592",
      "reviewedSeverity": "unknown",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:35db8680c21f7f91be34e095802e29d6897cca83d3da8b7a1f86f8dc0a662562",
      "decision": "non-applicable",
      "owner": "@ait-developer",
      "reviewedOn": "2026-11-22",
      "expiresOn": "2026-12-10",
      "reason": "Nate approved this exact-artifact determination after independent AIT Skills review. The exact macOS ARM artifact contains url 2.5.8, but the locked target dependency sources and FFI contain no caller of Url::origin or quirks::origin. Bind this determination to the reviewed artifact bytes and locked source graph. The advisory remains unscored.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:url@2.5.8",
          "dependencyFingerprint": "sha256:337b08425800775f78a7b79b0e39a6b6d87091e0b77e8e740ee8dda147a09439"
        }
      ],
      "evidence": [
        "https://github.com/RustSec/advisory-db/blob/main/crates/url/RUSTSEC-2026-0592.md",
        "https://github.com/natewalton/iroh-ffi/tree/d50c2b7de23ac8872db630056897742518d9706d"
      ],
      "regressions": [
        {
          "path": "bin/chrono-macos-artifact-test.mjs",
          "check": "chrono-macos-artifact"
        }
      ]
    }
  ]
}
```

## Historical review archive

The following material records earlier decisions and test scope. It is not read
by the current gate and does not satisfy the current rule. Its Kysely “0.29+”
removal threshold was too broad: the first reported fix is 0.28.14. The Zod GHSA
continues to report High although its CVE was rejected; current application
bounds require verification. Historical passing gates accepted reachable risks.

## Dependency review

The following review was recorded on 2026-10-30 for the local-only release line.
It is historical evidence for that scope, not a current general safety approval.
Normal npm logging remains enabled. Compatible fixes are committed to the four lockfiles; AT Protocol and
PLC dependency versions stay pinned. A passed check does **not** mean there
are no advisories: it means every reported root advisory/package version is
fixed or covered by the explicit risk decisions below.

From the repository root, run the same read-only check used by release preparation:

```bash
bin/check-advisories.sh
```

It audits all four lockfiles, including development dependencies. A new advisory,
a package version outside an exception, or a failed audit blocks release
preparation. The check does not repair dependencies or approve exceptions.
Fixes require review, relevant regression tests, and a release. Parent packages
flagged only because they depend on a vulnerable package do not need separate
exceptions; the underlying advisory is checked on that dependency.

The 0.1.46 candidate pins the PDS's transitive `fast-xml-parser` to 5.12.0
to fix [GHSA-474x-hrwr-fgx4](https://github.com/advisories/GHSA-474x-hrwr-fgx4).
The AWS XML consumer, XML builder round trip, malformed stop-node input and
PDS module import are checked by `node pds/scripts/xml-parser-test.cjs`.
The pinned AT Protocol packages and existing advisory exceptions are unchanged.

## Reviewed exceptions

This JSON block is the single maintained exception list, read directly by the
check. Advisory IDs refer to `https://github.com/advisories/<ID>`. Versions are
exact, not package-wide or component-wide exemptions. Reassess a decision when
its removal condition is met. The private-peer reassessment below covers only
the controlled two-Mac test, not general P2P deployment.

<!-- historical-advisory-exceptions -->
```json
[
  {
    "workspaces": ["plc"],
    "package": "kysely",
    "versions": ["0.23.5"],
    "advisories": ["GHSA-8cpq-38p9-67gx"],
    "reason": "MySQL sql.lit escaping; the PLC launcher uses PostgreSQL, not MySQL. @did-plc/server 0.0.1 requires ^0.23.4, whose newest version remains affected.",
    "removeWhen": "The PLC dependency supports a patched Kysely (0.29+) with its PostgreSQL lifecycle verified; track compatibility work in #28."
  },
  {
    "workspaces": ["pds"],
    "package": "kysely",
    "versions": ["0.22.0"],
    "advisories": ["GHSA-8cpq-38p9-67gx"],
    "reason": "MySQL sql.lit escaping; this PDS uses SQLite. @atproto/pds 0.4.226 requires ^0.22.0, which has no patched version.",
    "removeWhen": "A separately reviewed PDS generation supports patched Kysely (0.29+); track #28."
  },
  {
    "workspaces": ["plc", "pds", "appview", "mcp"],
    "package": "zod",
    "versions": ["3.25.76"],
    "advisories": ["GHSA-mrhx-c7xc-m3w5"],
    "reason": "Large invalid collections can exhaust validation memory. This risk is not declared unreachable: HTTP services are loopback-only and MCP is local, but local untrusted input can still cause denial of service. AT Protocol/PLC consumers require Zod 3; the published fix is Zod 4.6.6, outside their ranges. A blanket Zod 4 override would change their validation contract.",
    "removeWhen": "A compatible Zod 3 backport is published or the pinned AT Protocol/PLC consumers support patched Zod 4 through reviewed compatibility work (#28). Reassess before allowing remote peer inputs."
  },
  {
    "workspaces": ["pds"],
    "package": "file-type",
    "versions": ["16.5.4"],
    "advisories": ["GHSA-5v7r-6r5c-r473"],
    "reason": "Malformed ASF parsing can loop. No patched version satisfies the PDS ^16.5.4 range. Blob upload is authenticated and this release is local-only; malformed local uploads remain an accepted denial-of-service risk, not a claim that the parser is unreachable.",
    "removeWhen": "A reviewed PDS dependency accepts file-type 21.3.1+ (or a compatible backport), with blob handling tested; track #28. Reassess before peer exposure."
  },
  {
    "workspaces": ["pds"],
    "package": "elliptic",
    "versions": ["6.6.1"],
    "advisories": ["GHSA-848j-6mx2-7j84"],
    "reason": "Risky cryptographic implementation arrives through key-encoder/@atproto/aws. AIT's default PDS uses disk blobs and no AWS KMS, so this is not its repository signing path. No patched elliptic version is published.",
    "removeWhen": "The upstream AWS/key-encoder dependency removes or replaces elliptic, or a patched compatible release is published. Reassess before enabling AWS storage/KMS."
  },
  {
    "workspaces": ["pds"],
    "package": "deepmerge",
    "versions": ["4.3.1"],
    "advisories": ["GHSA-gcqx-w48m-w2h4"],
    "reason": "Prototype poisoning in deepmerge is inherited through html-to-text/nodemailer-html-to-text. The PDS installs htmlToText() with no user options; html-to-text merges those server-controlled options, not the message HTML. No patched deepmerge version is published. This exception does not cover applications passing untrusted conversion options.",
    "removeWhen": "A compatible fix or removal is available upstream. Reassess before configuring SMTP or processing untrusted email-template options."
  },
  {
    "workspaces": ["pds"],
    "package": "nodemailer",
    "versions": ["8.0.11"],
    "advisories": [
      "GHSA-p6gq-j5cr-w38f", "GHSA-8m3c-c648-2xjj", "GHSA-wmmp-3585-3rmp",
      "GHSA-2x7j-588g-ccc2", "GHSA-cc9r-2j5m-2m83", "GHSA-6vj9-mwq6-2f5v",
      "GHSA-8vvx-rff5-p5rq", "GHSA-v53p-9fqp-m79j", "GHSA-39m8-27wv-hr27",
      "GHSA-8c8m-p3m8-cjg8", "GHSA-m943-m63m-w62w", "GHSA-85x2-q946-cp5h",
      "GHSA-4ffr-jq9g-5ffx", "GHSA-g73g-hqqh-jr95", "GHSA-4g23-2xm8-66gc"
    ],
    "reason": "These specific raw-message, recipient-parser, DNS/TLS and SMTP denial-of-service findings affect the existing 8.0.11 override. Without SMTP the PDS uses Nodemailer's JSON transport, so SMTP network/TLS paths are inactive; message parsing still runs and local malformed-input risks are not declared unreachable. The PDS supplies server-owned HTML templates rather than caller-selected raw messages. Complete fixes require a newer Nodemailer major, outside both the existing ^8 override and the PDS ^6 requirement; no major override is added here.",
    "removeWhen": "A reviewed PDS/mail dependency update supports a version clearing these advisories (current patched line 10.3.1), or compatible backports are published. Reassess before enabling SMTP; track #28."
  }
]
```

Review evidence: [`bin/install.sh`](../bin/install.sh) writes an empty `PDS_EMAIL_SMTP_URL` and disk
blob-store paths; `@atproto/pds/dist/context.js` selects an SMTP transport only
for configured email, otherwise Nodemailer's JSON transport. Its mailer installs
`htmlToText()` with default options and constructs messages from server templates.
The PLC launcher uses PostgreSQL; the PDS uses its SQLite database.
Published fix versions and advisory scope were
checked against the npm registry and advisory database on the review date.
These decisions cover that default installation, not an assertion that custom
SMTP, AWS, externally reachable listeners, or the P2P build are safe.

## Private-peer test reassessment (2026-10-30)

Historical scope: the controlled private-peer test line, initially reviewed at
`26ef0b4`, including the presence-read extension reviewed on 2026-11-09. The existing
exception JSON is unchanged.
A passing advisory gate matches IDs and versions; it does not establish that
the network exposure is safe.

- **Approval boundary:** Iroh authenticates the machine, data streams require
  current approval, and the peer front exposes read-only routes, not PDS writes
  or administration ([`appview/src/peerNetwork.mjs`](../appview/src/peerNetwork.mjs)). A malicious or
  compromised **approved** machine can still supply hostile parser input;
  signatures and endpoint binding do not remove that risk.
- **Zod is reachable:** peer PLC logs enter `validateOperationLog`, followed by
  DID-document and repository parsing. HTTP responses retain safeFetch's
  512 KiB default except `getRepo`, which permits 100 MiB
  ([`appview/src/peerClient.mjs`](../appview/src/peerClient.mjs)). The WSS subscription does **not** use that
  HTTP cap; it retains the installed `ws` client's 100 MiB message default
  ([`appview/src/peerFeed.mjs`](../appview/src/peerFeed.mjs), reviewed at line 24, `appview/node_modules/ws/lib/websocket.js:675`).
  These are byte limits, not proof against CPU/allocation exhaustion or an
  aggregate memory bound. The Zod denial-of-service risk remains unresolved.
- **file-type:** peer sync reads repository CARs and serves stored blobs through
  GET routes. It does not upload peer blobs into the local PDS or invoke its
  blob-upload MIME sniffer. That parser remains on the authenticated local
  `uploadBlob` path, not `getBlob` (`pds/node_modules/@atproto/pds/dist/api/com/atproto/repo/uploadBlob.js:17`,
  `pds/node_modules/@atproto/pds/dist/api/com/atproto/sync/getBlob.js:22`). A user
  re-uploading a received blob locally can still reach the existing risk.
- **Other exceptions:** peer projection does not add a MySQL database, SMTP
  transport, AWS KMS/blob store, or caller-controlled HTML conversion options.
  The documented Kysely, Nodemailer, deepmerge and elliptic conditions remain;
  no new claim of parser unreachability is made.

Disposition: retain the exact documented exceptions for this controlled,
approved-peer test only. Do not treat approval or response caps as a fix for
malicious-peer denial of service. Wider deployment needs a fresh risk decision
and compatible dependency remediation; this note is not a production release GO.
