# Let a background Claude session react to AIT mentions

Status: native activation gap measured in the incident; supported mechanism unproved. Not build GO.
Date: 2026-11-11

## Why

The measured2.1.322 background continuation inherited AIT push mode and MCP
configuration but omitted the custom-channel launch flag. Mentions were indexed
but did not activate the worker. Identity continuity is independently useful;
it must not be presented as this activation fix.

## The proposed work

Restore automatic AIT mention/reply activation through a supported Claude
channel mechanism across /bg and attach. Prove the package/runtime behavior
before choosing a patch or a minimum version. Existing MCP initialize messages
have no observed channel activation acknowledgment; initialization and HTTP200
are not a delivery oracle. An allowed policy or server-declared capability does
not prove client opt-in. Preserve native consent and organization policy.

Prefer a native supported configuration/carryover correction to an AIT-specific
transport. If this requires upstream change, record the minimal reproduction
and proposed correction separately; do not silently add another supervisor,
terminal injection, transcript queue writes or hidden polling. Until proven,
the identity slice explicitly reports unavailable automatic delivery and keeps
mentions readable under the same DID.

## Files touched

This specification only. Count implementation paths after a supported mechanism
is established. No native fork or upstream posting is authorized by this spec.

## Out of scope

Account remapping, handover identity storage, copying credentials, live restarts,
publishing or deploying a speculative transport, and calling an emitted MCP
notification a model-consumption acknowledgment.

## Tests

Disposable native foreground session with active AIT channel -> /bg -> incoming
mention -> autonomous reply under same DID -> attach -> another mention/reply.
An operator nudge or manual listNotifications does not pass. Test approved
channel policy and refusal separately. Any actual model calls use only an
explicitly scoped disposable account/session, never the Finance session.

## Sequencing or rollout

Prove native activation, then obtain systems + independent AIT design review,
count scope, build and review. Keep this status blocked on the specific native
mechanism, not on additional ceremony. No currently green activation claim.

## What was rejected

Inferring activation from MCP handshake/HTTP200; bypassing channel consent;
relaunching or polling a user's existing session to conceal failure.

## Sources

Measured Finance process/notification thread and native fixture receipts in
/private/tmp/ait-claude-background-investigation/findings.md.
https://code.claude.com/docs/en/agent-view#what-carries-over-when-you-background
https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview
