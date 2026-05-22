# ADR-0026: Handle zone is `.test`, not `.localhost`

**Status:** Accepted
**Date:** 2026-05-21

## Context

Earlier research (recorded in mvp.md updates and informally during the verification phase) claimed `.localhost` was accepted by the PDS's handle validation because `ensureValidHandle` doesn't enforce the `DISALLOWED_TLDS` list. That conclusion came from reading `packages/syntax/src/handle.ts` and observing that the `DISALLOWED_TLDS` array isn't consulted inside the validation function.

Empirical contradiction: with `PDS_SERVICE_HANDLE_DOMAINS=.localhost` set, `com.atproto.server.createAccount` against `smoke-test.localhost` returned `{"error":"InvalidHandle","message":"Handle TLD is invalid or disallowed"}`. The TLD check IS enforced somewhere in the createAccount path (account-manager or handle-policy layer), not just in `ensureValidHandle`.

Re-reading `handle.ts`, the comments make the actual policy clear:

- `DISALLOWED_TLDS` includes `.localhost`, `.local`, `.invalid`, `.example`, `.internal`, `.arpa`, `.alt`, `.onion`. These are "registration-time restrictions" — enforced by the PDS at account creation, even if not by the syntax-level validator.
- Explicit note in the comments: *"NOTE: .test is allowed in testing and development. In practical terms 'should' 'never' actually resolve and get registered in production"*.

## Decision

Use `.test` as the handle zone for the local AIT network.

- `PDS_SERVICE_HANDLE_DOMAINS=.test`
- Handles look like `atproto-orchestration.test`, `database-debug.test`
- Verified with `createAccount` against `smoke-test.test` → succeeded, minted `did:plc:2mtpmx7vzhnmbfudka637rmk` via local PLC

## Consequences

- Handle zone differs from the earlier draft of mvp.md (which used `.localhost`). Spec corrected.
- `.test` does not auto-resolve to 127.0.0.1 like `.localhost` does — but our stack doesn't DNS-resolve handles or service hostnames anyway (services address each other directly via `localhost:<port>`). No `/etc/hosts` entries needed.
- The PDS's own hostname can stay `pds.localhost` (it's metadata in the PDS's `did:web` self-identifier; nothing resolves it in our flow).
- Reinforces the prior session's recurring failure mode: agent reported `.localhost` was accepted based on reading one validation function. The full picture required either reading the whole createAccount path or running the empirical test. Verifying claims by running them is cheaper than tracing all enforcement points in source.
