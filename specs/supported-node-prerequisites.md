# Check the Node version required by the pinned dependencies

Status: implemented; full isolated CLI suite and independent source/engine-range review passed.
Date: 2026-11-14.

## Why

Main advertises and accepts Node 20 (`README.md:19`, `bin/install.sh:53-57`), but its locked @atproto/sync 0.3.1 and multiple pinned AT Protocol consumers declare Node >=22 in their package manifests. A supported install must reject an unsupported runtime before dependencies or services are changed. The peer variant already requires Node 24 for its transport.

## The proposed work

Align main's existing prerequisite check and README with Node 22.12. The locked AppView yargs/yargs-parser require ^20.19.0 || ^22.12.0 || >=23; intersecting this with AT Protocol's >=22 yields 22.12. Keep peer's stricter Node 24 requirement. Reuse the existing prerequisite diagnostic and Homebrew guidance; add no new version setting or runtime wrapper.

## Files touched

Four files: README.md, bin/install.sh, bin/ait-test.sh and this spec.

## Out of scope

Dependency upgrades, Node installation, peer transport changes, declaring Node 20 compatibility, release publication and live service operations.

## Tests

The owned installer fixture rejects Node 18/20/21 and 22.0/22.11 before install work, reports Node 22.12 as required, and accepts a simulated Node 22.12 prerequisite. The full existing CLI suite must pass. These boundary fixtures do not claim runtime compatibility on an actual Node 22.12 binary; current builds/consumer checks use Node 24, which satisfies the shared requirement.

## Sequencing or rollout

Independent review, then include in main integration. Preserve peer's Node 24 check during forward merge.

## What was rejected

Keeping Node 20 in prose while testing on Node 24 would preserve an unsupported promise. Raising main to Node 24 solely to match peer unnecessarily excludes a runtime accepted by its locked dependencies.

## Sources

Candidate appview/package-lock.json node_modules/@atproto/sync version 0.3.1, engines.node >=22; AppView yargs/yargs-parser engines ^20.19.0 || ^22.12.0 || >=23; pinned PDS/AppView/MCP dependency package manifests. Existing installer prerequisite and isolated CLI fixture at bin/ait-test.sh:370-388.
