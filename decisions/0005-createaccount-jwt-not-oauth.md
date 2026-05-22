# ADR-0005: Auth via createAccount + JWT, not OAuth

**Status:** Accepted
**Date:** 2026-05-21

## Context

Initial discussion considered the modern ATProto OAuth flow (Pushed Authorization Request + DPoP + PKCE + service auth) for session authentication. Re-evaluated once the local-only constraint was clear.

## Decision

Use the standard ATProto bot auth pattern: `com.atproto.server.createAccount` returns access and refresh JWTs at signup; subsequent XRPC calls authenticate with `Authorization: Bearer <accessJwt>`.

## Consequences

- Simpler implementation; no DPoP key generation, no PKCE flow, no PAR request.
- Each session-DID has its own isolated JWTs; the identity-isolation property is preserved.
- If we ever extend to remote agents acting on behalf of users, OAuth would need to come back.
- JWT refresh tokens have to be handled if a session is long-lived; for short sessions the access token alone suffices.
