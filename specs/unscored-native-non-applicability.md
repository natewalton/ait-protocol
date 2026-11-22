# Review native findings without inventing a severity

Status: unpublished policy proposal; activation requires independent review and Nate's explicit decision.
Date: 2026-11-21

## Why

The fresh full peer gate reports RUSTSEC-2026-0578 against heapless 0.7.17 as unknown severity. RustSec names SortedLinkedList::zeroize, but the exact locked 0.7.17 source has no such implementation. Supported dependency updates retain that version. Current bin/check-advisories.mjs rejects unknown severity before its existing disposition model can express verified non-applicability.

## The proposed work

Keep auditing the whole native lock, including the finding and its unknown severity. Permit only a Rust non-applicable disposition bound to the exact artifact, source lock, package/path/version and advisory revision, with a fresh candidate regression and no more than 30 days of validity. Unknown severity cannot qualify as accepted risk, mitigation, an npm exception or informational maintenance.

Reuse the existing immutable-addon regression to identify the reviewed macOS ARM bytes. Keep independent source/build-feature evidence beside the policy record; symbol absence alone cannot prove that stripped code is absent. No disposition is activated before maintainer approval. The existing mail/MCP risk decisions separately require renewal for the final candidate.

## Files touched

Five files: bin/check-advisories.mjs (disposition eligibility), bin/check-advisories-test.mjs (positive and rejecting cases), bin/chrono-macos-artifact-test.mjs (separate exact-addon check), docs/security.md (rule and reviewed source evidence, then approved record), and this spec. Existing native audit coverage and workflows remain unchanged.

## Out of scope

No guessed severity, broad native acceptance, feature-filtered audit, unsupported dependency override, source patch, new native artifact, deployment or installed change. A finding whose affected code is present remains blocked.

## Tests

Run node bin/check-advisories-test.mjs. Exact reviewed non-applicability must pass; missing/failed regression, changed artifact/source/lock, changed advisory revision, expired decision, more than 30 days, informational borrowing and unknown-severity risk acceptance must fail. Run the actual addon regression; altered bytes must fail. Run the fresh complete gate with no new disposition first, then with only the independently reviewed and maintainer-approved record.

## Sequencing or rollout

Review the proof and policy code independently. Present the final candidate and the precise proposed decision to Nate before activation. Preserve the December 10 expiries. Publish only through the existing required PR and release gates after approval.

## What was rejected

Forcing heapless 0.9 violates Postcard's ^0.7 contract. Current compatible Postcard and full Cargo updates still retain 0.7. A guessed severity or treating unsoundness as informational would hide the issue. Omitting a target or feature from the audit would reduce coverage. New transport forks and binary rebuilds do not remove a function absent from the current source.

## Sources

The current gate report: /private/tmp/ait-peer6-security-before-renewal.json. Native source/build evidence: /private/tmp/ait-heapless-nonapplicability-evidence.md. Advisory: https://rustsec.org/advisories/RUSTSEC-2026-0578.html. Exact native source commit d50c2b7de23ac8872db630056897742518d9706d and source Cargo.lock are already pinned by docs/security.md.
