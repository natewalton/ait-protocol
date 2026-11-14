# Keep operator authority local and reject unsupported startup ports

Status: isolated extraction; independent review GREEN with diagnostic wording corrected.
Date: 2026-11-14

## Why

Main's server.ts:189-194 resolves APPVIEW_OPERATOR through the PDS on request,
while the peer branch already binds it to a unique local PDS account at boot.
Use that local principal model on main too. A bad or nonlocal setting disables
third-party retirement with a diagnostic; self-retirement remains available.

Managed discovery uses fixed ports (bin/lib-service-pids.sh:8-12), but main's
start-all.sh loads no port preflight. Reject an unsupported effective configuration
before any service launch rather than launching services the CLI cannot discover.

Main's CLI help still places shell comments in the update recipe (ait:48-56),
and README/installation/operations link to an older peer release although
v0.1.48-peer.1 is published. Fix those copied-command and navigation defects.

## The proposed work

Reuse the peer's read-only local-account binding, resolving the PDS account file
with the actual wrapper's inherited/sourced environment and working directory.
Bind once at AppView startup. No configuration/identity migration is included.
Reuse peer managed-port preflight for PLC 2582, PDS 2583 and AppView 2585, before
start-all launches children. Direct service fixtures retain ephemeral ports.
Move CLI help comments into prose and link stable docs to the published peer tag.
Keep main's Node20/platform requirements and existing local feed.

## Files touched

Sixteen including integration validation: appview/src/operatorIdentity.mjs, appview/src/server.ts,
appview/.env.example, appview/scripts/operator-identity-test.mjs,
bin/lib-service-pids.sh, bin/start-all.sh, bin/managed-ports-test.mjs, ait,
docs/aitty.md, docs/developing-alongside-installed-ait.md, README.md,
docs/installation.md, docs/operations.md, this spec, and the security/release workflows. Those two workflows run the operator and managed-port consumer fixtures on both variants. Four runtime files plus
CLI/config span authority and managed startup; tests and docs accompany each.

## Out of scope

Peer transport, naming projection, presence and platform requirements; continuity
(General's lane); security dependency changes (integration owner's lane); env or
identity rewrites; and truthful backfill-complete readiness on main. Main's local
feed has no completion barrier, so copying peer readiness would make a false claim.
No shared branch writes, release or installed service changes are authorized here.

## Tests

npm --prefix appview ci --no-audit; npm --prefix appview run build;
node appview/scripts/operator-identity-test.mjs; node bin/managed-ports-test.mjs;
bash bin/ait-test.sh. Operator fixture runs compiled AppView with temporary stores,
loopback PDS/PLC/WebSocket and signed service JWTs: the selected local operator
can retire another actor, a namesake resolved by the PDS cannot, and self-retirement
still works. Missing/invalid/ambiguous account bindings fail closed without writes.
Managed CLI fixtures assert nondefault sourced/inherited ports refuse before child
launch, default configuration works, and direct fixture ports remain possible.

## Sequencing or rollout

Independent review then hand the isolated candidate to the integration owner.
Forward merge must preserve peer operator preparation and its verified-feed path;
main retains localFeed.mjs. Required security checks stay enabled.

## What was rejected

Whole peer cherry-pick: imports private transport and namespace migration into main.
Health states without a backfill barrier: misrepresents local readiness. Automatic
operator env migration: unnecessary on stable and adds persisted writes. Copying
Apple-Silicon/Node24 prerelease requirements: not main's tested contract.

## Sources

origin/main 6e5b555; peer bd03046. peer operatorIdentity.mjs:11-50 and
peerPrepare.mjs:17-43 supply binding/environment semantics; peer
lib-service-pids.sh:33-67 supplies managed port checks. Main localFeed.mjs has
subscription reconnect/cursor behavior and no snapshot completion signal.

Spec check: current behavior can bind administration through lazy name resolution
or launch undiscoverable ports; the crude fix is local principal binding and
preflight using existing config; users see safe retirement/startup and correct
released guide links. Questions 4-13 have no outstanding defect for this slice.
