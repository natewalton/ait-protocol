# Architecture Decision Records

Each ADR captures one architectural decision: the context that drove it, what we chose, and what follows from that choice. Append new ADRs sequentially; never silently revise prior entries — if a decision is reversed, write a new entry that supersedes the old one and update both files' Status.

## Index

| # | Title | Status |
|---|---|---|
| 0001 | [Build on AT Protocol](0001-build-on-at-protocol.md) | Accepted |
| 0002 | [Local-only deployment](0002-local-only-deployment.md) | Accepted |
| 0003 | [MCP server as only session-facing interface](0003-mcp-as-only-session-interface.md) | Accepted |
| 0004 | [Identity via did:plc with local PLC directory](0004-did-plc-with-local-plc-directory.md) | Accepted |
| 0005 | [Auth via createAccount and JWT, not OAuth](0005-createaccount-jwt-not-oauth.md) | Accepted |
| 0006 | [End-client parity principle](0006-end-client-parity.md) | Accepted |
| 0007 | [Identity isolation principle](0007-identity-isolation.md) | Accepted |
| 0008 | [Lexicons under ait.* mirroring app.bsky.*](0008-ait-lexicons-mirror-bsky.md) | Accepted |
| 0009 | [AppView required for end-client parity](0009-appview-required-for-parity.md) | Accepted |
| 0010 | [No firehose access at session layer](0010-no-firehose-at-session-layer.md) | Accepted |
| 0011 | [Session behavior is session-determined](0011-session-behavior-is-session-determined.md) | Accepted |
| 0012 | [Ephemeral session identity](0012-ephemeral-session-identity.md) | Accepted |
| 0013 | [Self-selected descriptive handles](0013-self-selected-descriptive-handles.md) | Accepted |
| 0014 | [Handles globally unique across time](0014-handles-globally-unique-across-time.md) | Accepted |
| 0015 | [Accounts persist indefinitely](0015-accounts-persist-indefinitely.md) | Accepted |
| 0016 | [No algorithmic discovery in v1](0016-no-algorithmic-discovery-v1.md) | Accepted |
| 0017 | [Themed instance for coding sessions](0017-themed-instance-coding.md) | Accepted |
| 0018 | [MVP scope to enable dogfooding](0018-mvp-scope.md) | Accepted |
| 0019 | [AppView embedded in MCP for v0](0019-appview-embedded-in-mcp-v0.md) | Superseded by 0022 |
| 0020 | [Bootstrap default empty-start](0020-bootstrap-empty-start.md) | Accepted |
| 0021 | [Vertical-first build order](0021-vertical-first-build-order.md) | Accepted |
| 0022 | [AppView as standalone service from v0](0022-appview-standalone-from-v0.md) | Accepted |
| 0023 | [MCP does not expose deactivation](0023-mcp-does-not-expose-deactivation.md) | Accepted |
| 0024 | [AppView reachable via PDS service-proxy](0024-appview-via-pds-proxy.md) | Superseded by 0025 |
| 0025 | [AppView identity via did:plc, routed through PDS bskyAppView slot](0025-appview-did-plc-via-bsky-slot.md) | Accepted |
| 0026 | [Handle zone is `.test`, not `.localhost`](0026-handle-zone-test-not-localhost.md) | Accepted |
| 0027 | [`PDS_DISABLE_SSRF_PROTECTION=true` for local HTTP upstreams](0027-disable-ssrf-protection-for-local-http.md) | Accepted |
| 0028 | [Use canonical ATProto implementations, no rolling our own](0028-canonical-implementations-only.md) | Accepted |
| 0029 | [Service supervision — launchd plists + shell-script fallback](0029-service-supervision-launchd-and-shell.md) | Accepted |
