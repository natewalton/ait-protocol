# Keep `ait resume` from flooding local services

Status: ready to build
Date: 2026-09-07

## Why

`ait resume` checks presence once per discovered handle and starts every check at
the same time (`mcp/src/sessionPicker.ts:224-253`). Each AppView actor search
hydrates every listed actor (`appview/src/queries/searchActors.ts:40-96`). On
this machine, 42 discovered sessions and 264 listed actors therefore produce up
to 11,088 overlapping identity resolutions when AppView's identity cache is
cold or stale. A controlled call-count reproduction produced exactly 11,088.

The user observed the resume table complete and the following core-health gate
fail twice about a minute apart. The same PLC, PDS, and AppView processes stayed
alive and later passed 60 consecutive health checks without a restart. The
fan-out is a supported-path load spike immediately before that gate.

Verdict: fix it.

## The proposed work

Check the existing unique handles one at a time. Preserve the same AppView
endpoint, results, ordering, live-session filtering, and failure behavior.
Serial execution lets the first search populate AppView's existing identity
cache before the next search begins.

## Files touched

Three files:

1. `mcp/src/sessionPicker.ts`: serialize the existing live-handle searches.
2. `mcp/scripts/session-picker-test.mjs`: prove that presence requests do not
   overlap and that selection behavior is unchanged.
3. `specs/resume-presence-fanout.md`: this contract.

## Out of scope

- No retry, connection cap, new cache, new endpoint, batch API, or health-check
  change.
- No AppView directory-search redesign.
- No change to the five-minute presence window or resume confirmation.
- No attempt to tune operating-system socket limits.

## Tests

- `npm --prefix mcp run build`
- `node mcp/scripts/session-picker-test.mjs`
- The focused fixture delays each AppView response long enough to observe
  overlap and records a peak of one in-flight presence request.
- Reverting only the serialization must make that focused assertion fail.

## Sequencing or rollout

Release through the normal versioned installer. From the released checkout,
run `ait resume` against the real local records, cancel at the prompt, and
confirm `ait status` remains healthy immediately afterward.

## What was rejected

- Retrying health checks: masks the load spike and cannot explain it.
- Raising connection limits: increases the permitted blast rather than removing
  duplicated work.
- A new batch-presence endpoint: unnecessary while sequential use of the
  existing endpoint is fast after the first cache fill.
- Persisting another identity cache: duplicates AppView state.

## Sources

- `mcp/src/sessionPicker.ts:224-253`
- `appview/src/queries/searchActors.ts:40-96`
- `appview/node_modules/@atproto/identity/src/did/memory-cache.ts:9-39`
- Read-only AppView query on 2026-09-07: 264 listed active actors.
- Controlled reproduction on 2026-09-07: 42 concurrent searches produced
  11,088 identity-resolution calls.
