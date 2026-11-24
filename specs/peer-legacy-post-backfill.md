# Keep peer sync running past an overlong historical post

Status: implementation candidate, 2026-11-23.

## Why

The verified feed already skips historical local posts whose only schema failure
is the 1,000-grapheme text limit. In peer.6, the source checks at
`appview/src/peerFeed.mjs:121` and `:215` exclude approved peer history from
that behavior. One such record prevents the receiving AppView from completing
its initial import or consuming later messages.

## Proposed work

Use the existing historical-post rule for each actor's first verified backfill and
covered stream replay on local and approved peer feeds. A later verified
snapshot after account activation, a large commit, or cursor expiration may
still contain the old post. Carry forward an omission only if its record URI
and signed content ID match the last accepted snapshot. Log newly omitted records with source and URI. Later
valid records and mentions reach the existing feed and notification paths.

Keep source binding, signature checks, input bounds, and other schema rules in
place. New stream records and previously unseen invalid records in live
snapshots remain strict. A newly written overlong record can still stop a live
feed. This change covers historical recovery.

## Files touched

Four files: this spec, `appview/src/peerFeed.mjs`,
`appview/scripts/peer-feed-test.mjs`, and `appview/scripts/peer-link-test.mjs`.

## Out of scope

Other validation failures, newly written overlong posts, PDS record rewriting,
policy changes, and installed-service changes.

## Tests

The signed feed fixture exercises local and approved peer snapshots and their
covered commit and sync replay, account activation with a new verified revision,
stale projection removal, refusal of an unseen or changed overlong post, and a
later valid commit. The two-instance Link fixture seeds historical text over
the current limit, checks the receiving AppView log and valid history, then
reactivates the source account and verifies a later reply and mention callback.

## Sequencing or rollout

Validate with isolated instances, then review the change at the history
validation boundary before integration.

## What was rejected

Catching all validation errors would hide other malformed data. Truncating
stored content would misrepresent the signed record. Both are unnecessary.

## Sources

`appview/src/peerFeed.mjs`, `reconcile`, `processMessage`, and
`validateRecord`; the peer-feed and peer-link fixture paths above.
