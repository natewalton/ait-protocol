# Peer reporting audit — 2026-11-09

The supplied cross-Mac ping/reply demonstrates one application round trip. It does not establish continuous transport availability, indexing completeness, registration presence, or model activity.

## Scope and findings

Audited peerNetwork's control/status/Link/log/presence callers, feed/client status, CLI preparation/confirmation/status/cancellation, core readiness, agent tool descriptions, four presence renderers, and current operator documentation. Repository-wide searches for obsolete status claims also checked tests and dated design documents. Historical evidence remains unchanged.

| Surface | Verified problem | Correction |
| --- | --- | --- |
| Transport status/logs/errors | Three duplicated predicates counted CONTROL pairing connections as application connectivity | One derived projection requires approval, DATA ALPN, open connection and eligible direct path |
| Link result | Literal Linked despite failed DATA dials | Report saved approval and current projected status; concurrent Unlink reports false/Unlinked |
| Attachment failure log | Hardcoded Unavailable could conflict with independent inbound DATA | Report indexing attachment failure without asserting transport state |
| Indexing | Running persisted during internal websocket retries | Existing owned socket hooks report reconnecting and restore running after open/backfill; failed/stopped remain terminal |
| Preparation | Unconditionally said no machines linked despite saved approvals | Report preparation and defer runtime status to started AppView |
| CLI confirmation/interruption | Decline asserted Not linked; interruption could conceal retained approval | Describe unsubmitted request and direct operator to current status |
| CLI status | Every read failure was described as peer service not responding; empty approvals printed nothing | Preserve actual diagnostic, avoid inferred cause, explicitly list no approved peers |
| Tool descriptions/docs | Some promised only live/offline or unconditional Linked | Describe Unknown, registration semantics, approval and runtime snapshot separately |

Core local health shares the feed implementation. Review identified its new recoverable reconnecting state as a required caller update: readiness now waits through reconnecting, while terminal failure remains distinct. This was fixed before completion.

## Systems review

Four concepts remain independent: saved approval (`machine.state.peers`), direct DATA connectivity (`connections` plus native path metadata), importer lifecycle (`getStatus()`), and owner push registration (`live` or unknown). One connectivity projection replaces three formulas and the literal success claim. No persisted status cache, new probe, retry supervisor, or delivery ledger was introduced. Physical direct-path checks for CONTROL pairing retain their existing purpose.

Independent review found and resolved readiness propagation, contradictory attachment logging, and a concurrent Unlink reply race. Final verdict: green. The reviewer independently reran all nine lifecycle tests.

## Validation

Node 24 arm64 AppView/MCP builds passed. Sixty focused tests passed across lifecycle, signed-feed indexing/reconnect, operator identity, projection/presence, and actual server readiness. The full isolated CLI suite passed, including starting → reconnecting → running. The two-PDS application test passed all eleven outcomes: public Link, signed replay, discovery, post/reply/thread, callbacks, unknown/offline presence, unlink and relink. The native pending-connect test also passed: cancellation/deadline completed and late connections closed without pairing.

Native temporary endpoint regressions reproduce CONTROL-only connectivity, unavailable DATA after successful pairing, close/unlink transitions, and concurrent revocation during Link completion. Temporary websocket regressions cover quiet disconnect/reopen and initial backfill finishing while disconnected.

All work used temporary data and ephemeral test services in an isolated worktree. No installed files, live approvals, live services, or active sessions were changed. No new release was published.
