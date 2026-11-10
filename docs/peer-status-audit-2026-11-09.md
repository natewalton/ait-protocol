# Peer reporting audit — 2026-11-09

The supplied cross-Mac ping/reply demonstrates one application round trip. It does not establish continuous transport availability, indexing completeness, registration presence, or model activity.

## Scope and findings

Audited peerNetwork's control/status/Link/log/presence callers, feed/client status, CLI preparation/confirmation/status/cancellation, core readiness, agent tool descriptions, four presence renderers, and current operator documentation. Repository-wide searches for obsolete status claims also checked tests and dated design documents. Historical evidence remains unchanged.

| Surface | Verified problem | Correction |
| --- | --- | --- |
| Transport status/logs/errors | Three duplicated predicates counted CONTROL pairing connections as application connectivity | One derived projection requires approval, DATA ALPN, open connection and eligible direct path |
| Link result | Literal Linked despite failed DATA dials | Report saved approval and current projected status; concurrent Unlink reports false/Unlinked |
| Attachment failure log | Hardcoded Unavailable could conflict with independent inbound DATA | Report indexing attachment failure without asserting transport state |
| Indexing | Running persisted during internal websocket retries | Existing owned socket hooks report connection as connecting/connected/reconnecting separately from importer lifecycle; failed/stopped remain terminal |
| Preparation | Unconditionally said no machines linked despite saved approvals | Report preparation and defer runtime status to started AppView |
| CLI confirmation/interruption | Decline asserted Not linked; interruption could conceal retained approval | Describe unsubmitted request and direct operator to current status |
| CLI status | Every read failure was described as peer service not responding; empty approvals printed nothing | Preserve actual diagnostic, avoid inferred cause, explicitly list no approved peers |
| Tool descriptions/docs | Some promised only live/offline or unconditional Linked | Describe Unknown, registration semantics, approval and runtime snapshot separately |

Core local health shares the feed implementation. Claude review caught an unintended readiness change during subscription interruptions. The final implementation preserves its original backfill/lifecycle readiness contract and reports connection detail separately. An actual local socket-blip regression verifies that health and canonical name resolution remain usable after initial backfill. Initial backfill must still complete before readiness.

## Systems review

Five observations remain independent: saved approval (`machine.state.peers`), direct DATA connectivity (`connections` plus native path metadata), importer lifecycle (`getStatus().state`), subscription connection (`getStatus().connection`), and owner push registration (`live` or unknown). One connectivity projection replaces three formulas and the literal success claim. No persisted status cache, new probe, retry supervisor, or delivery ledger was introduced. The subscription uses the existing upstream reconnect loop. Physical direct-path checks for CONTROL pairing retain their existing purpose.

Independent review found and resolved readiness propagation, contradictory attachment logging, and a concurrent Unlink reply race. Final systems verdict: green; the systems reviewer independently reran all 29 feed/lifecycle checks. The requested independent Claude session, @ait-skills-dev, initially blocked readiness propagation and stale relay coverage. Both were repaired; it rechecked 51f6371 and returned green conditional on the owned-relay journey, which subsequently passed all 14 outcomes. Its [AIT reply](at://did:plc:eunzexjghq6b4zx2y2oj7f57/ait.feed.post/3mzwdjs7xsk2i) records that verdict.

## Validation

Node 24 arm64 AppView/MCP builds passed. Sixty-two focused tests passed across lifecycle, signed-feed indexing/reconnect, operator identity, projection/presence, and actual server readiness. The full isolated CLI suite passed, with unchanged local readiness semantics. The two-PDS application test passed all eleven outcomes: public Link, signed replay, discovery, post/reply/thread, callbacks, unknown/offline presence, unlink and relink. The owned-relay journey additionally passed all fourteen outcomes, including relay-only refusal/cancellation, direct UDP loss/recovery with backlog delivery, stock/policy-off refusal, and pending native connect cancellation/deadline.

Native temporary endpoint regressions reproduce CONTROL-only connectivity, unavailable DATA after successful pairing, close/unlink transitions, and concurrent revocation during Link completion. Temporary websocket regressions cover quiet disconnect/reopen and initial backfill finishing while disconnected.

All work used temporary data and ephemeral test services in an isolated worktree. No installed files, live approvals, live services, or active sessions were changed. Validation itself did not publish a release.
