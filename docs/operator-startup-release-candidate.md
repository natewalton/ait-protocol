# Operator and startup repair candidate

Status: Implementation complete; systems and independent code reviews GO. Prepared for the private-peer integration branch. No stable release, installation, or service restart performed.
Date: 2026-11-09
Candidate branch: `fix/operator-startup-multimachine`
Base: `build/private-peer-integration` at `98a7de6f04573044e5eb0c3d75a5390e1072d9f1`.

## Release notes

AppView keeps the local operator working when linked machines use the same
watcher name. It binds authority to one validated local PDS account DID before
peer startup, rather than resolving the operator through the merged directory.
Invalid configuration disables only third-party retirement with a diagnostic.
Self-retirement and JWT signature, audience, method, and local issuer checks
retain their existing boundaries.

Stopped-service preparation converts a resolvable operator handle to its DID
before renaming account namespaces. It preserves unrelated settings and a
private rollback copy. Runtime and preparation use the PDS wrapper's effective
account store, including inherited settings and shell-expanded paths. The local
PDS env file remains trusted executable configuration, as it is in the existing
service wrapper; errors do not print its credentials.

Account actions use one authoritative name resolver. Retired or inactive
namesakes cannot disappear from ambiguity checks. Picker selections retain
their DIDs, watch resolves all targets before adding follows, and saved aliases
cannot bypass an ambiguity error. Explicit stored follow records can still be
removed offline.

Startup waits for initial local indexing for both new and adopted AppViews.
Status distinguishes starting, degraded indexing, and unreachable HTTP. Named
actor requests return `ProjectionUnavailable` when the local projection is not
ready; retained explicit DID/URI history remains addressable. Peer status shows
indexing separately from transport, and incompatible saved peer relay settings
leave that peer unavailable without disabling the local core. Managed service
ports are explicitly limited to 2582/2583/2585 before any service launch.

## Validation

All four packages were installed from their unchanged lockfiles into the isolated
checkout with `npm ci --prefer-offline --no-audit`. Both TypeScript builds pass.
Local validation used Node.js 25.7.0 on macOS arm64. Hosted Node.js 24 validation
has not been run for this candidate.

| Check | Result |
|---|---|
| Local operator identity and durable env conversion | 9/9 pass |
| Actual AppView main, public name gates, signed auth, explicit history, cancellation, and listen-failure cleanup | 5/5 pass |
| Actor projection and collision rules | 18/18 pass |
| Feed lifecycle, reconnect, and cancellation | 17/17 pass |
| Peer attachment lifecycle and actual CLI rendering | 6/6 pass |
| Duplicate follow projection | 4/4 pass |
| Client handles, picker, multi-target watch, and peer mentions | Pass |
| Public CLI/installer, including new/adopted readiness and effective-port preflight | Pass |
| Update / uninstall | 28 / 10 cases pass |
| Shared Codex launcher and ownership regressions | Pass; fixture explicitly shims the new HTTP readiness probes |
| Real pinned Codex 0.166.0 and 0.167.0 endpoint contracts | Pass, without model calls |
| Codex sink / recovery / session picker | Pass |
| Two real signed PDSs plus temporary Postgres | 11 end-to-end outcomes pass |
| Real stock Iroh and policy-disabled controls | Both refuse peer startup as required |
| Pending native connect cancellation/deadline and late connection cleanup | Pass |
| Single lexicon / advisory gate | Pass; zero unreviewed advisory instances |
| Whitespace / shell syntax | Pass |

The two-PDS fixture includes same-named watcher accounts, a crash after the first
real namespace rename and a retry from disk, authenticated retire/restore,
ordinary self-retirement and third-party refusal, preserved feed history,
retained collisions on direct legacy-config restart, Unlink/relink, and callback
delivery. The main fixture additionally rejects wrong signatures, audience,
method, and peer issuers. No real-user account, authentication, transcript,
installed database, or model turn was used.

Focused commands:

```sh
npm --prefix appview run build
npm --prefix mcp run build
(cd appview && node scripts/operator-identity-test.mjs)
(cd appview && node scripts/startup-readiness-test.mjs)
(cd appview && node --import tsx scripts/peer-projection-test.mjs)
(cd appview && node --import tsx scripts/peer-feed-test.mjs)
(cd appview && node --import tsx scripts/peer-lifecycle-test.mjs)
(cd mcp && node scripts/handles-test.mjs)
(cd mcp && node --import tsx scripts/peer-mentions-test.mjs)
bash bin/ait-test.sh
bash bin/ait-update-test.sh
bash bin/ait-uninstall-test.sh
bash bin/run-codex-appserver-test.sh
node appview/scripts/peer-link-test.mjs
# The policy control needs a separately installed real @number0/iroh@1.2.0:
IROH_STOCK_BINDING=/path/to/@number0/iroh/index.js node appview/scripts/peer-link-test.mjs --policy-controls
node appview/scripts/peer-link-test.mjs --connect-bound
bash bin/check-single-lexicon.sh
bash bin/check-advisories.sh
```

## Review and release scope

[Systems implementation review](operator-startup-systems-review.md) and
[independent code review](operator-startup-code-review.md) are both GO. The
systems review found and verified the correction for a stale account-store
binding. Independent review separately reran the focused auth, lifecycle,
readiness, targeting, and mention suites. Its final narrow check confirmed the
affected launcher fixture's readiness probes are isolated.

The draft PR targets the existing private-peer integration branch. This repair
changes no dependency lockfile, advisory exception, or AppView schema relative to
that branch. It introduces no role registry, alias cache, retry supervisor, or
automatic restart of installed services.

The current public immutable release is v0.1.45 at
`c976d1b29740784456803cee21da116ee5dea7d2`; its release notes explicitly exclude
P2P. The private-peer base already differs from that stable release across 70
files and includes an experimental Darwin-arm64-only native package and an
AppView schema change. Those are existing branch differences, not part of this
repair's authorization review. Public stable promotion requires its own scope,
platform, migration/recovery review, and hosted release gates. The main-only
release workflow and its schema gate have not been weakened. No public tag,
draft stable release, or installer purporting to belong to a stable tag is
created by this preparation.

## Adoption and rollback

Deployment remains a separate action. Before adopting a peer-branch candidate,
recheck installed checkout identity, active sessions, service ownership, and
configuration preconditions using the existing branch upgrade instructions.
The reviewed local tests do not establish installed recovery. The installed
AppView remains in its previously failed state until adoption is authorized.

Retain the prior code revision and the private operator-env backup. After a
namespace mutation, preserve the canonical operator DID when restoring other
settings or code: restoring an obsolete full handle alone does not restore the
operator. This patch does not delete accounts, indexed peer history, approvals,
repositories, or session data.
