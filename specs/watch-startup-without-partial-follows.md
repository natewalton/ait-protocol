# Resolve a watch request before adding follows

Status: Implemented in the main integration candidate. Node 24 build, actual watch consumer regression and independent systems/spec/code review passed.
Date: 2026-11-14.

## Why

`aitty watch A B` currently resolves and follows each name in sequence (`mcp/src/aitty/main.ts:262-308`). If B's lookup fails, the command exits after creating A's follow. The user sees a failed watch with an unexpected persistent follow. Fix this shared main defect; peer already separates resolution from follow writes.

## The proposed work

Resolve the complete requested set before creating any follows. Retain main's definitive-unknown reporting, explicit stored-reference fallback, self/duplicate filtering and existing follow-write failure behavior. This prevents lookup failures from leaving new follows; it does not make multiple remote follow writes transactional. The existing CLI error is the user-facing result.

Systems review: the existing requested actors, resolved actors and stored follows are sufficient. Move the write phase after the resolution phase; add no retry, rollback or ownership machinery. Keep main and peer resolution policies distinct where their single-machine and multi-machine directories differ.

## Files touched

Five implementation files plus this specification: `mcp/src/aitty/main.ts`, `mcp/scripts/handles-test.mjs`, `.github/workflows/security.yml`, `.github/workflows/release.yml`, `docs/aitty.md`. The workflows run the shared consumer regression on both variants.

## Out of scope

No P2P resolver/picker syntax migration, identity changes, atomic multi-follow transaction, new retries, release publication or live session operations.

## Tests

Build MCP, then run `node mcp/scripts/handles-test.mjs`. The actual compiled watch entry point uses an isolated identity and fixture-only agent. A valid first target followed by transport failure or ambiguity must exit before any follow write or timeline read and preserve stored follows. Positive cases retain unknown-name reporting, explicit cached fallback, and duplicate/self filtering. Parent deadlines bound all children.

## Sequencing or rollout

Review and test on main, integrate through required checks, then retain equivalent peer behavior during the forward merge. Independent review precedes final integration.

## What was rejected

Undoing earlier remote writes adds failure-prone rollback when resolving first avoids the writes entirely. Copying the peer resolver would introduce unrelated multi-machine semantics.

## Sources

`mcp/src/aitty/main.ts:262-308`, `mcp/src/handles.ts:15-67`, `mcp/scripts/handles-test.mjs` actual watch fixture; peer `mcp/src/aitty/main.ts` two-pass implementation at `397b44b`.
