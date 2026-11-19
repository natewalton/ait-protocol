# Release AIT with supported upstream dependencies

Status: advisory-gate implementation prepared for independent review, 2026-11-19. The PDS mailer remains a required test. No finding is accepted by this spec.

## Why

AIT ships the published AT Protocol packages that support its workflows. The [previous gate](../bin/check-advisories.mjs#L217-L226) rejects acceptance of any High or Critical finding, even when the supported upstream graph has no fix. The [release workflow](../.github/workflows/release.yml#L141-L146) also stops on the first failed mailer test before evaluating findings. Peer.5 shows how those two rules independently block an AppView fix. AIT needs a decision it can make while the upstream packages remain within their maintained dependency ranges.

## Proposed release rule

**Ship a supported candidate when every required check passes or produces a known upstream result with an approved, current decision in the existing security register.**

1. **Fix what AIT can fix.** Check supported upstream versions first. Adopt a compatible fix once verified. Block AIT regressions and new or materially expanded exposure to unresolved High or Critical risk. Compare actual behavior and exposure with the last release to inform the decision. A previous release using unsupported dependency overrides cannot establish the required dependency baseline. Restoring declared ranges is mandatory, and the resulting findings receive a residual-risk decision. Preserve upstream package ranges. No forced upgrades, replacement validation or mail code, or maintained forks.
2. **Use the existing decision register.** Classify each finding as fixed, non-applicable, mitigated, accepted risk, or blocked. Fixed findings leave the active register once the scanner confirms their removal. Non-applicability and mitigation still require evidence for the exact path. An upstream High finding without a supported fix may be accepted temporarily if its residual risk in the supported configuration is understood and the maintainer approves after independent review. A finding restored by removal of an unsupported override follows this same process. Material changes in reachable inputs or capabilities must be flagged for discussion. Keep the current 30-day maximum for High decisions, with no automatic renewal. Unresolved or potentially reachable Critical findings, applicable findings under active exploitation, unknown severity or incomplete scan coverage, and unexplained failures stay blocking. Record uncertainty conservatively. Upstream ownership alone is insufficient.
3. **Keep required test results separate until complete.** Future work may apply the same decision to known upstream test results once all required cases produce results. Every required check still runs. A test that observes a reviewed upstream failure must report the exact result as an accepted finding and link its register entry. Match the named check and result, candidate and dependency identity, advisory revision, exposure, owner and expiry. Timeout, crash, missing result, changed failure and failure of another assertion all block. Run any other required cases that the named failure previously prevented from running. The workflow may publish only if every observed result is accounted for. Show accepted findings and supported exposure in the gate result and release notes.

**Recheck upstream while we wait.** Check for a supported fix at release preparation and before renewing any exception. For an issue that is actively blocking a release, record the last upstream check and the next manual review date in its existing issue. Use a published candidate or new advisory evidence as a reason to check sooner. The review checks published packages and their dependency ranges, since a source commit alone cannot unblock an AIT upgrade. This needs no scheduled job or separate tracker.

Use one register in `docs/security.md`, one approval path and the existing advisory status values. Treat the scan and test as two sources of evidence for a release decision. Keep the scan complete, even when a finding qualifies for acceptance. Evidence attaches to exact applicable paths and never carries over automatically to a changed artifact or advisory.

## Candidate walk-through

| Item | Result under the proposed rule |
| --- | --- |
| AppView startup | The candidate's 47 focused tests passed. Keep this user-facing check required. |
| Chrono, [#78](https://github.com/natewalton/ait-protocol/issues/78) | The existing macOS arm64 non-applicability decision already fits. Check the artifact and expiry as usual. |
| PDS mail and telemetry, [#75](https://github.com/natewalton/ait-protocol/issues/75) | Compare the exact candidate with published peer.4, including supported SMTP configurations. Review the five High and 19 other advisory entries. Account for the specific failing mailer result and verify the other required cases run. Describe and discuss material runtime exposure changes. Restored advisories alone do not reject the supported graph. |
| MCP Zod, [#68](https://github.com/natewalton/ait-protocol/issues/68) | Compare the four affected paths with peer.4. Use existing evidence for a proven non-applicability or mitigation. An independently reviewed residual risk decision is a separate possibility where existing evidence describes impact and exposure. Do not call the stdin tests proof for HTTP replies. Full Lex adoption remains deferred. |

Peer.5 would be eligible only after the comparison and specific decisions are reviewed. None is granted here. If runtime exposure changes materially or evidence remains insufficient, flag the exact issue for the maintainer. The previous unsupported overrides are not an eligible fallback.

## Implementation and verification

This slice updates six files: this specification, `docs/security.md`, `bin/check-advisories.mjs`, `bin/check-advisories-test.mjs`, `.github/workflows/release.yml`, and `bin/security-workflow-test.mjs`. The advisory gate reports the decision and the release workflow verifies a disclosure in the release notes. The mailer suite remains required and its known failure still blocks peer.5.

Verify with the advisory gate and extracted workflow tests. A reviewed exact High finding can qualify. An expired approval, changed advisory or candidate, failed regression, matching CISA KEV entry, Critical accepted risk, or missing release disclosure blocks. Run the trusted gate on fresh immutable worktrees for the supported baseline and candidate. Test staged release preparation end to end before requesting any publication approval.

## Out of scope

Changing upstream dependencies or runtime controls, waiving reports, skipping required test cases, broad or permanent exemptions, scheduled monitoring, merging the corrective branches, and publishing peer.5. Keep the existing hold during review.
