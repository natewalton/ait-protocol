# Resume sessions by their friendly names

Status: approved for implementation by operator request, 2026-11-02.

## Why

`ait resume @braze-pm.test` reports no match after its stored identity gained
the machine-qualified aitproto.com handle. The session still exists.
At parent 772b633, `mcp/src/sessionPicker.ts:263-270` compares only the literal
stored handle and session ID; `chooseSession` hides live sessions from partial
search. A read-only replay returned `no resumable AIT session matched`.

## The proposed work

Treat a bare label as an exact friendly-name query, for example
`ait resume @braze-pm`.
Use the existing display-name normalization. Preserve literal full-handle and
ID matching, count all live/offline matches before selecting, and keep the
default-no confirmation for a live match. Do not rewrite identity files.

## Files touched

Three files: this spec, `mcp/src/sessionPicker.ts`, and
`mcp/scripts/session-picker-test.mjs`.

## Out of scope

Backward-compatibility aliases, identity migration, service restarts, remote session launch,
and changes to partial searches or the five-minute presence lease.

## Tests

Build MCP and run its session-picker test. Exercise migrated stored identities
for both harnesses, bare/current names, live confirmation, offline direct
selection, and same-label ambiguity. Reverting the matching change must fail.
Read-only replay of `ait resume @braze-pm` must reach the live confirmation and
cancel without launching a harness.

## Sequencing or rollout

Review the isolated patch, add it to the private-peer branch, and apply only
the selector correction to the installed development checkout. No service
restart or account/data change is required.

## What was rejected

Rewriting identities or storing aliases adds state for a read-time name match.
Treating every full handle as a label would ignore its machine qualification.

## Sources

Installed selector reproduction on 2026-11-02; existing
`mcp/src/atproto/actorLookup.ts:4-7` defines friendly labels.
