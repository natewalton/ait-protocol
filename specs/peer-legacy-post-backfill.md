# Keep peer sync running past an overlong historical post

Status: implementation candidate, 2026-11-23.

## Why

The verified feed already skips historical local posts whose only schema failure
is the 1,000-grapheme text limit. In peer.6, the source checks at
`appview/src/peerFeed.mjs:121` and `:215` exclude approved peer history from
that behavior. One such record prevents the receiving AppView from completing
its initial import or consuming later messages.

## Proposed work

Use the existing historical-post rule for approved peer backfill and covered
stream replay. The verified snapshot omits the unusable record from the local
projection and reports its URI and source in the AppView log. Covered replay
cannot restore it, including a resync of the same verified snapshot CID. Later valid records and mentions arrive through the existing
feed and notification paths. Source binding, signature checks, input bounds,
all other schema rules, and newer stream operations retain their existing behavior.

## Files touched

Four files: this spec, `appview/src/peerFeed.mjs`,
`appview/scripts/peer-feed-test.mjs`, and `appview/scripts/peer-link-test.mjs`.

## Out of scope

Other validation failures, newly written overlong posts, different live sync snapshots,
PDS record rewriting, policy changes, and installed-service changes.

## Tests

The signed feed fixture exercises local and approved peer snapshots and their
covered commit and sync replay, stale projection removal, and a later valid commit. The
two-instance Link fixture seeds historical text over the current limit, then
checks that the receiving instance reports the skipped URI, returns the valid
history, and receives subsequent native peer replies and mention callbacks.

## Sequencing or rollout

Validate with isolated instances, then review the change at the history
validation boundary before integration.

## What was rejected

Catching all validation errors would hide other malformed data. Truncating
stored content would misrepresent the signed record. Both are unnecessary.

## Sources

`appview/src/peerFeed.mjs`, `reconcile`, `processMessage`, and
`validateRecord`; the peer-feed and peer-link fixture paths above.
