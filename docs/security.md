# Security and advisories

AIT's session hooks are workflow guardrails, not an operating-system security
boundary. UUID-derived credential encryption does not protect credentials from
a process that can read both the UUID and the credential file under the same
Unix user. See [Architecture](architecture.md#trust-and-record-semantics) for the
scope of those controls.

## Current release rule (2026-11-10)

This branch contains the shared gate and mailer/PLC fixes without P2P runtime promotion. The peer ingress results below apply to the separate private-peer security candidate. Stable AppView still uses its earlier Firehose path; these results do not clear it. Its release remains blocked until candidate-specific AppView ingress verification and any necessary controls are provided. No stable release is proposed by this common-controls change.

A release requires no unresolved reachable High/Critical finding in its supported
configuration within the declared four npm locks and packaged transport Cargo graph. Non-applicability and effective
mitigation require current source evidence and a passing candidate-bound
regression. Reachable High/Critical risk acceptance cannot pass. A policy pass
is distinct from a clean npm audit; issue [#28](https://github.com/natewalton/ait-protocol/issues/28)
remains open while High/Critical scanner findings remain.

Run the current trusted checker against a clean, immutable candidate:

```sh
bin/check-advisories.sh --candidate /absolute/path/to/clean-checkout
node bin/check-advisories-test.mjs
```

Run fresh `npm ci` in each candidate workspace before compatibility regressions. The checker verifies installed package/version/source correspondence against the lock; this is a stale-installation check, not a tamper-proof host or file-integrity claim.

The candidate's checker, policy and lifecycle scripts are never used. Current
policy and trusted regression code belong to this checkout. Regressions run now
against the candidate in an isolated unprivileged job; results identify its
commit, lock digests and the current test hash. No supplied approval receipt or
scope override is accepted. All new candidates use local plus approved-peer
exposure, including future stable P2P releases. Only the immutable historical
commits below have reviewed exposure mappings.

The checker audits all four complete npm locks, validates inherited roots and
severity, and checks fresh GitHub advisory status/revision. A changed version,
dependency ancestry, advisory status/severity, component identity, exposure or
expiry invalidates an old decision. It audits the exact packaged native source
lock separately. Missing tooling, unknown severity or incomplete coverage blocks.
It performs no dependency repair. Coverage is the four npm locks and the packaged transport Cargo graph. Other embedded native components, including SQLite within better-sqlite3, and externally maintained Node/PostgreSQL/OpenSSL remain outside these lockfile advisory audits. Native vulnerabilities with unknown or unsupported scoring block rather than receiving a guessed severity.

Publication requires a fresh result for the exact candidate and artifact. The
PR/release job supplies the trusted checkout; repository maintainer review must
protect policy/checker/workflow changes. Candidate regressions run without
publication/reporting credentials. No schedules, security issues, automatic
updates or alert-setting changes are introduced. A pass is valid at check time,
not ongoing assurance between checks.

## Private-peer candidate input envelope

This section describes the reviewed private-peer candidate, including its structural limits and admission checks. Those AppView changes are not implemented on `main`; the shared gate does not clear stable from this evidence.

The existing decoded limits remain: PLC JSON 100 KiB; PDS ordinary JSON 150 KiB and record writes 1,000,000 bytes; peer ordinary reads 512 KiB, CAR downloads and WebSocket frames 100 MiB; MCP stdio framing 10 MiB. The checked PLC parser returns 413 for oversized bodies and 400 for malformed JSON without stack traces, including chunked/compressed requests. Both npm start/dev and service wrappers use that launcher.

Repository/feed decoding additionally rejects headers over 1 KiB, block payloads over 1,000,000 bytes, more than 65,536 CAR blocks, more than 4,096 CBOR nodes per block or 1,048,576 per CAR, more than 65,536 nodes per stream frame, or nesting beyond 64. These are AIT application limits, not AT Protocol maxima; unusually large record arrays/facets can now be rejected. Rejection appears in indexing status as `Peer input limit: ...`; shared AppView continues serving. All selected records must pass their registered lexicons before snapshot/commit projection. Invalid records cannot partially admit an identity, earlier valid records or a cursor.

Malformed ordinary MCP tool calls leave their session usable. An oversized stdio frame closes only the offending transport; the client must reconnect. This does not restart shared AIT services. Fixtures verify fresh-session recovery.

The bounded Node24 fixtures passed all seven ingress/database groups, with fixed 256 MiB old-space/768 MiB aggregate RSS and 32 MiB retained-growth limits; actual MCP runtime uses 128 MiB old-space. Positive compilation uses its separate 1024 MiB/60-second build budget. Largest observed retained growth was below 5 MiB and aggregate MCP RSS was 722 MiB. Tests cover a signed 32-post snapshot and structural 100 MiB CAR/frame acceptance separately; this is not a full semantic 100 MiB repository/message compatibility claim.

## Prepared native replacement

[Native patch PR](https://github.com/natewalton/iroh-ffi/pull/1) updates Tokio 1.54.0 → 1.54.1 and ctutils 0.4.3 → 0.4.4 in the exact source lock. The locally packed experimental.2 addon passed 28 package tests plus controlled-network strict/default transport proofs. Its full-workspace RustSec audit reports zero vulnerabilities and three unmaintained notices, recorded below as informational residual risks. This does not clear unrelated bundled native libraries.

The replacement artifact is **not published or adopted**. The current experimental.1 dependency is still blocked by RUSTSEC-2026-0384/0385. The experimental.2 policy identity below authorizes neither a substituted tarball nor an unpublished download: the checker must retrieve and verify the exact bytes/source lock, and installed dependency correspondence must hold before regression evidence can apply. No release or live installation is performed by these changes.

## Maintained policy

This is the single active machine-readable policy. The old decisions below are
historical evidence, not authorization. Current Kysely decisions require actual dialect regressions; current Zod mitigation requires the entire bounded ingress suite to pass. Historical Nodemailer findings remain blocked and disappear from the upgraded graph. The published native transport remains blocked until its patched replacement is published and adopted. Reviewed lower-severity
residual risks may use explicit accepted-risk decisions; they are not mitigations. Expired blocked records
remain useful explanations; they never authorize publication. A real approved
disposition needs its exact advisory revision/status and actual current passing
regressions. High/Critical validity is at most 30 days; expiry requires renewed
evidence at the next check. Removing a scanner finding removes its exception.

Native provenance identifies the published binary's source and locked graph; it
does not assert that the graph is free from advisories or prove binary reproduction.
Known embedded PLC validators/compiler require their own current regressions even
if an external dependency override makes npm's graph appear clean. The same
disposition list handles RustSec maintenance notices as informational reviewed
risks; this does not invent a CVSS severity for native vulnerabilities. An unknown
vulnerability severity remains blocked. Native advisory revisions are hashes of
the advisory record, and native component fingerprints bind the package digest,
source commit, source-lock digest and exact crate path/version.

<!-- security-policy -->
```json
{
  "schemaVersion": 1,
  "supportedReleases": [
    {
      "tag": "v0.1.45",
      "commit": "c976d1b29740784456803cee21da116ee5dea7d2",
      "exposure": "local"
    },
    {
      "tag": "v0.1.46",
      "commit": "8cadfd3d7bbd54c46622ebe120678911d73986fb",
      "exposure": "local-and-approved-peer"
    },
    {
      "tag": "v0.1.46-peer.1",
      "commit": "e16094956f1d122a89b6090cc4ef1224ea56cfd9",
      "exposure": "local-and-approved-peer"
    },
    {
      "tag": "v0.1.46-peer.2",
      "commit": "3fe1681b06f2de0fa98402f0dac5594dee7a62ba",
      "exposure": "local-and-approved-peer"
    }
  ],
  "nativeArtifacts": [
    {
      "package": "@natewalton/iroh-direct",
      "version": "0.1.0-experimental.1",
      "url": "https://github.com/natewalton/iroh-ffi/releases/download/iroh-direct-v0.1.0-experimental.1/natewalton-iroh-direct-0.1.0-experimental.1.tgz",
      "digest": "sha256:bcd347b7b80c9decebd5336d9d1d7de52b3acc9b67f7d9c49f98c0d4a6e6b30a",
      "sourceCommit": "adce3ea5c33209a9052fa2c57d8269d7f32419dc",
      "sourceRepo": "https://github.com/natewalton/iroh-ffi",
      "lockDigest": "sha256:b6c3dda31ac42354d2eaa6feec17648420e92e60109580e3fff5548cfbaa1ecc",
      "target": "aarch64-apple-darwin"
    },
    {
      "package": "@natewalton/iroh-direct",
      "version": "0.1.0-experimental.2",
      "url": "https://github.com/natewalton/iroh-ffi/releases/download/iroh-direct-v0.1.0-experimental.2/natewalton-iroh-direct-0.1.0-experimental.2.tgz",
      "digest": "sha256:1dd9be3d211ba4926858d956e349dd9be52d4df1f0e08bcbd6b082b30268a1d7",
      "sourceCommit": "90b4158edca03ac90d9a940d01d7003d756c6874",
      "sourceRepo": "https://github.com/natewalton/iroh-ffi",
      "lockDigest": "sha256:9f9b2b2d61028170494e8a5ae7d7ae512e5a1e9ba59b438cef53fba0d05c8c9d",
      "target": "aarch64-apple-darwin"
    }
  ],
  "embeddedComponents": [
    {
      "workspace": "plc",
      "package": "@did-plc/server",
      "location": "node_modules/@did-plc/server",
      "version": "0.0.1",
      "integrity": "sha512-GtxxHcOrOQ6fNI1ufq3Zqjc2PtWqPZOdsuzlwtxiH9XibUGwDkb0GmaBHyU5GiOxOKZEW1GspZ8mreBA6XOlTQ==",
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "kysely-dialects"
        },
        {
          "path": "bin/security-input-test.mjs",
          "check": "zod-ingress"
        }
      ]
    }
  ],
  "dispositions": [
    {
      "id": "plc-zod-GHSA-mrhx-c7xc-m3w5",
      "workspace": "plc",
      "package": "zod",
      "version": "3.25.76",
      "advisory": "GHSA-mrhx-c7xc-m3w5",
      "reviewedSeverity": "high",
      "decision": "mitigated",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "The CVE is rejected while the GHSA remains active. Actual supported PLC/PDS, peer and MCP ingress fixtures validate decoded byte/work limits, retained memory, malformed-input non-admission and subsequent permitted operations. CBOR/CAR work is checked before materialization; protocol framing violations close only their offending connection. This is mitigation within the documented resource envelope, not a zero-warning claim.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/zod",
          "dependencyFingerprint": "sha256:188e6a7b1c8c2dc9ee664b5d264aeb1b1e16df53d7f1bcb2fdc85f324cfbc696"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
        "https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2023/54xxx/CVE-2023-54404.json"
      ],
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "zod-ingress"
        }
      ],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-23T18:26:52Z"
    },
    {
      "id": "plc-kysely-GHSA-8cpq-38p9-67gx",
      "workspace": "plc",
      "package": "kysely",
      "version": "0.23.5",
      "advisory": "GHSA-8cpq-38p9-67gx",
      "reviewedSeverity": "high",
      "decision": "non-applicable",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "The actual bundled PLC compiler/constructor is PostgreSQL and the actual PDS constructor is SQLite. Candidate-bound dialect/literal regressions verify those paths; this advisory requires MySQL string-literal escaping. A newly introduced vulnerable dialect invalidates this decision.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/kysely",
          "dependencyFingerprint": "sha256:800b7f67feaf5efd8ab6f3c2ba09e5267f091b73fc44153694ebfa46adfa0925"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-8cpq-38p9-67gx"
      ],
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "kysely-dialects"
        }
      ],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-03-27T20:57:34Z"
    },
    {
      "id": "pds-zod-GHSA-mrhx-c7xc-m3w5",
      "workspace": "pds",
      "package": "zod",
      "version": "3.25.76",
      "advisory": "GHSA-mrhx-c7xc-m3w5",
      "reviewedSeverity": "high",
      "decision": "mitigated",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "The CVE is rejected while the GHSA remains active. Actual supported PLC/PDS, peer and MCP ingress fixtures validate decoded byte/work limits, retained memory, malformed-input non-admission and subsequent permitted operations. CBOR/CAR work is checked before materialization; protocol framing violations close only their offending connection. This is mitigation within the documented resource envelope, not a zero-warning claim.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/zod",
          "dependencyFingerprint": "sha256:8b75411079ea90c2899f00079c5974f8be1c1eb9f9453c1ebad58eaadc88a87e"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
        "https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2023/54xxx/CVE-2023-54404.json"
      ],
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "zod-ingress"
        }
      ],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-23T18:26:52Z"
    },
    {
      "id": "pds-elliptic-GHSA-848j-6mx2-7j84",
      "workspace": "pds",
      "package": "elliptic",
      "version": "6.6.1",
      "advisory": "GHSA-848j-6mx2-7j84",
      "reviewedSeverity": "low",
      "decision": "accepted-risk",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "Reviewed Low residual cryptographic implementation risk through @atproto/aws/key-encoder. Inspected PDS chooses disk blobs unless AWS is configured; no claim that arbitrary AWS/KMS configurations are safe. This lower-severity risk acceptance is not a High/Critical mitigation.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/elliptic",
          "dependencyFingerprint": "sha256:9500fe8825871be72395fbe243f77880f44d84831d3e1d9d9d2de4b525298707"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-848j-6mx2-7j84",
        "https://registry.npmjs.org/@atproto/pds/-/pds-0.4.226.tgz"
      ],
      "regressions": [],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-01-09T20:19:43Z"
    },
    {
      "id": "pds-file-type-GHSA-5v7r-6r5c-r473",
      "workspace": "pds",
      "package": "file-type",
      "version": "16.5.4",
      "advisory": "GHSA-5v7r-6r5c-r473",
      "reviewedSeverity": "moderate",
      "decision": "accepted-risk",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "Reviewed Moderate residual denial-of-service risk: malformed ASF upload can loop on the authenticated PDS blob-upload path. Authentication and peer GET-only routes do not fix the parser; no claim of unreachability or effective mitigation. Upgrade/backport remains required to eliminate this lower-severity finding.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/file-type",
          "dependencyFingerprint": "sha256:4f1b67495ea6f8eefcfcc9a0b9c76932268e85a2f6a4c9b26cebd507e18d796e"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-5v7r-6r5c-r473",
        "https://registry.npmjs.org/@atproto/pds/-/pds-0.4.226.tgz"
      ],
      "regressions": [],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-03-10T23:57:11Z"
    },
    {
      "id": "pds-kysely-GHSA-8cpq-38p9-67gx",
      "workspace": "pds",
      "package": "kysely",
      "version": "0.22.0",
      "advisory": "GHSA-8cpq-38p9-67gx",
      "reviewedSeverity": "high",
      "decision": "non-applicable",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "The actual bundled PLC compiler/constructor is PostgreSQL and the actual PDS constructor is SQLite. Candidate-bound dialect/literal regressions verify those paths; this advisory requires MySQL string-literal escaping. A newly introduced vulnerable dialect invalidates this decision.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/kysely",
          "dependencyFingerprint": "sha256:d19fd8397492b511b8e3734f7ffdce9ded46f945234e6029bd0dc0c7bef9b47c"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-8cpq-38p9-67gx"
      ],
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "kysely-dialects"
        }
      ],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-03-27T20:57:34Z"
    },
    {
      "id": "pds-nodemailer-GHSA-p6gq-j5cr-w38f",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-p6gq-j5cr-w38f",
      "reviewedSeverity": "high",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-p6gq-j5cr-w38f"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-8m3c-c648-2xjj",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-8m3c-c648-2xjj",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-8m3c-c648-2xjj"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-wmmp-3585-3rmp",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-wmmp-3585-3rmp",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-wmmp-3585-3rmp"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-2x7j-588g-ccc2",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-2x7j-588g-ccc2",
      "reviewedSeverity": "high",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-2x7j-588g-ccc2"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-cc9r-2j5m-2m83",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-cc9r-2j5m-2m83",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-cc9r-2j5m-2m83"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-6vj9-mwq6-2f5v",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-6vj9-mwq6-2f5v",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-6vj9-mwq6-2f5v"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-8vvx-rff5-p5rq",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-8vvx-rff5-p5rq",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-8vvx-rff5-p5rq"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-v53p-9fqp-m79j",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-v53p-9fqp-m79j",
      "reviewedSeverity": "high",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-v53p-9fqp-m79j"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-39m8-27wv-hr27",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-39m8-27wv-hr27",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-39m8-27wv-hr27"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-8c8m-p3m8-cjg8",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-8c8m-p3m8-cjg8",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-8c8m-p3m8-cjg8"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-m943-m63m-w62w",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-m943-m63m-w62w",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-m943-m63m-w62w"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-85x2-q946-cp5h",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-85x2-q946-cp5h",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-85x2-q946-cp5h"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-4ffr-jq9g-5ffx",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-4ffr-jq9g-5ffx",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-4ffr-jq9g-5ffx"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-g73g-hqqh-jr95",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-g73g-hqqh-jr95",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-g73g-hqqh-jr95"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-nodemailer-GHSA-4g23-2xm8-66gc",
      "workspace": "pds",
      "package": "nodemailer",
      "version": "10.5.0",
      "advisory": "GHSA-4g23-2xm8-66gc",
      "reviewedSeverity": "moderate",
      "decision": "blocked",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-11-10",
      "reason": "Historical mailer risk acceptance is not carried forward. Upgrade the exact candidate and pass actual PDS mail regressions; no reachable High acceptance qualifies.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/nodemailer",
          "dependencyFingerprint": "sha256:29c03ce5aedf170300b66e7cd57773a8ce45f413bb3ac909d8e334326ebab755"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-4g23-2xm8-66gc"
      ],
      "regressions": [],
      "ecosystem": "npm"
    },
    {
      "id": "pds-deepmerge-GHSA-gcqx-w48m-w2h4",
      "workspace": "pds",
      "package": "deepmerge",
      "version": "4.3.1",
      "advisory": "GHSA-gcqx-w48m-w2h4",
      "reviewedSeverity": "low",
      "decision": "accepted-risk",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "Reviewed Low prototype-poisoning residual risk through html-to-text/nodemailer-html-to-text. Inspected PDS calls htmlToText() with default server-owned options; this is not approval for untrusted conversion options or a claim that deepmerge itself is fixed.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/deepmerge",
          "dependencyFingerprint": "sha256:26cfac064156182927a61369f9fe39720580ac5b31d971cc8386f1c696c4609e"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-gcqx-w48m-w2h4",
        "https://registry.npmjs.org/@atproto/pds/-/pds-0.4.226.tgz"
      ],
      "regressions": [],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-27T21:34:58Z"
    },
    {
      "id": "appview-zod-GHSA-mrhx-c7xc-m3w5",
      "workspace": "appview",
      "package": "zod",
      "version": "3.25.76",
      "advisory": "GHSA-mrhx-c7xc-m3w5",
      "reviewedSeverity": "high",
      "decision": "mitigated",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "The CVE is rejected while the GHSA remains active. Actual supported PLC/PDS, peer and MCP ingress fixtures validate decoded byte/work limits, retained memory, malformed-input non-admission and subsequent permitted operations. CBOR/CAR work is checked before materialization; protocol framing violations close only their offending connection. This is mitigation within the documented resource envelope, not a zero-warning claim.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/zod",
          "dependencyFingerprint": "sha256:5962dc6fa177d99ed869e9b35f4a3f379b54117d45529fda45b5713e29726b21"
        },
        {
          "path": "node_modules/zod",
          "dependencyFingerprint": "sha256:d7174b627f2c72db399a2aa7aca9e2a8021cf3561b30ee37e70b7b4eac3aa276"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
        "https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2023/54xxx/CVE-2023-54404.json"
      ],
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "zod-ingress"
        }
      ],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-23T18:26:52Z"
    },
    {
      "id": "mcp-zod-GHSA-mrhx-c7xc-m3w5",
      "workspace": "mcp",
      "package": "zod",
      "version": "3.25.76",
      "advisory": "GHSA-mrhx-c7xc-m3w5",
      "reviewedSeverity": "high",
      "decision": "mitigated",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "The CVE is rejected while the GHSA remains active. Actual supported PLC/PDS, peer and MCP ingress fixtures validate decoded byte/work limits, retained memory, malformed-input non-admission and subsequent permitted operations. CBOR/CAR work is checked before materialization; protocol framing violations close only their offending connection. This is mitigation within the documented resource envelope, not a zero-warning claim.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "node_modules/zod",
          "dependencyFingerprint": "sha256:6f576426aff391e2396813a47aea0aca2406125f6fdd2cb0fd78bcd447ac1bb9"
        }
      ],
      "evidence": [
        "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
        "https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2023/54xxx/CVE-2023-54404.json"
      ],
      "regressions": [
        {
          "path": "bin/security-input-test.mjs",
          "check": "zod-ingress"
        }
      ],
      "ecosystem": "npm",
      "advisoryStatus": "active",
      "advisoryRevision": "2026-10-23T18:26:52Z"
    },
    {
      "id": "rust-RUSTSEC-2023-0089-experimental2",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "atomic-polyfill",
      "version": "1.0.3",
      "advisory": "RUSTSEC-2023-0089",
      "reviewedSeverity": "info",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:ce16a8da1b84e69f002853abcd70f49d2bf4b38eb0b6ec5a93230a9bcfad966a",
      "decision": "accepted-risk",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "Reviewed unmaintained notice in the conservative full-workspace transport Cargo audit. No vulnerability or CVSS score is inferred from maintenance status. Retain this exact locked component for the focused patch; new vulnerability reports, changed source/component identities or expiry require fresh review. No target-based exclusion is used to obtain a pass.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:atomic-polyfill@1.0.3",
          "dependencyFingerprint": "sha256:b014bc156595b4eb22c5847add316bd428719d14c0fb2c06b333016de2caa927"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2023-0089.html"
      ],
      "regressions": []
    },
    {
      "id": "rust-RUSTSEC-2026-0374-experimental2",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "basic-toml",
      "version": "0.1.10",
      "advisory": "RUSTSEC-2026-0374",
      "reviewedSeverity": "info",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:05c547d6e39cb0765cc96067f88cb8ab55a4b5335a98ecf7f6a67a3a0be27e9e",
      "decision": "accepted-risk",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "Reviewed unmaintained notice in the conservative full-workspace transport Cargo audit. No vulnerability or CVSS score is inferred from maintenance status. Retain this exact locked component for the focused patch; new vulnerability reports, changed source/component identities or expiry require fresh review. No target-based exclusion is used to obtain a pass.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:basic-toml@0.1.10",
          "dependencyFingerprint": "sha256:fe5bad8107d6dac4a61eecc2ace96bea81352c5ffbff47322621167440cb203a"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2026-0374.html"
      ],
      "regressions": []
    },
    {
      "id": "rust-RUSTSEC-2024-0436-experimental2",
      "ecosystem": "rust",
      "workspace": "appview",
      "package": "paste",
      "version": "1.0.15",
      "advisory": "RUSTSEC-2024-0436",
      "reviewedSeverity": "info",
      "advisoryStatus": "active",
      "advisoryRevision": "sha256:f5d6677b2552a0c8d5bf8c94593db7263d93ccb26a24f38165b1e4cf895da992",
      "decision": "accepted-risk",
      "owner": "@natewalton",
      "reviewedOn": "2026-11-10",
      "expiresOn": "2026-12-10",
      "reason": "Reviewed unmaintained notice in the conservative full-workspace transport Cargo audit. No vulnerability or CVSS score is inferred from maintenance status. Retain this exact locked component for the focused patch; new vulnerability reports, changed source/component identities or expiry require fresh review. No target-based exclusion is used to obtain a pass.",
      "exposures": [
        "local-and-approved-peer"
      ],
      "components": [
        {
          "path": "appview/node_modules/@natewalton/iroh-direct/Cargo.lock:paste@1.0.15",
          "dependencyFingerprint": "sha256:1571b4dd1d9121e05b0b2ce84e1c41ef5ea61ad46547aeb2ea332626873f0a22"
        }
      ],
      "evidence": [
        "https://rustsec.org/advisories/RUSTSEC-2024-0436.html"
      ],
      "regressions": []
    }
  ]
}
```

## Historical review archive

The following material records earlier decisions and test scope. It is not read
by the current gate and does not satisfy the current rule. Its Kysely “0.29+”
removal threshold was too broad: the first reported fix is 0.28.14. The Zod GHSA
continues to report High although its CVE was rejected; current application
bounds require verification. Historical passing gates accepted reachable risks.

## Dependency review

The following review was recorded on 2026-10-30 for the local-only release line.
It is historical evidence for that scope, not a current general safety approval.
Normal npm logging remains enabled. Compatible fixes are committed to the four lockfiles; AT Protocol and
PLC dependency versions stay pinned. A passed check does **not** mean there
are no advisories: it means every reported root advisory/package version is
fixed or covered by the explicit risk decisions below.

From the repository root, run the same read-only check used by release preparation:

```bash
bin/check-advisories.sh
```

It audits all four lockfiles, including development dependencies. A new advisory,
a package version outside an exception, or a failed audit blocks release
preparation. The check does not repair dependencies or approve exceptions.
Fixes require review, relevant regression tests, and a release. Parent packages
flagged only because they depend on a vulnerable package do not need separate
exceptions; the underlying advisory is checked on that dependency.

The 0.1.46 candidate pins the PDS's transitive `fast-xml-parser` to 5.12.0
to fix [GHSA-474x-hrwr-fgx4](https://github.com/advisories/GHSA-474x-hrwr-fgx4).
The AWS XML consumer, XML builder round trip, malformed stop-node input and
PDS module import are checked by `node pds/scripts/xml-parser-test.cjs`.
The pinned AT Protocol packages and existing advisory exceptions are unchanged.

## Reviewed exceptions

This JSON block is the single maintained exception list, read directly by the
check. Advisory IDs refer to `https://github.com/advisories/<ID>`. Versions are
exact, not package-wide or component-wide exemptions. Reassess a decision when
its removal condition is met. The private-peer reassessment below covers only
the controlled two-Mac test, not general P2P deployment.

<!-- historical-advisory-exceptions -->
```json
[
  {
    "workspaces": ["plc"],
    "package": "kysely",
    "versions": ["0.23.5"],
    "advisories": ["GHSA-8cpq-38p9-67gx"],
    "reason": "MySQL sql.lit escaping; the PLC launcher uses PostgreSQL, not MySQL. @did-plc/server 0.0.1 requires ^0.23.4, whose newest version remains affected.",
    "removeWhen": "The PLC dependency supports a patched Kysely (0.29+) with its PostgreSQL lifecycle verified; track compatibility work in #28."
  },
  {
    "workspaces": ["pds"],
    "package": "kysely",
    "versions": ["0.22.0"],
    "advisories": ["GHSA-8cpq-38p9-67gx"],
    "reason": "MySQL sql.lit escaping; this PDS uses SQLite. @atproto/pds 0.4.226 requires ^0.22.0, which has no patched version.",
    "removeWhen": "A separately reviewed PDS generation supports patched Kysely (0.29+); track #28."
  },
  {
    "workspaces": ["plc", "pds", "appview", "mcp"],
    "package": "zod",
    "versions": ["3.25.76"],
    "advisories": ["GHSA-mrhx-c7xc-m3w5"],
    "reason": "Large invalid collections can exhaust validation memory. This risk is not declared unreachable: HTTP services are loopback-only and MCP is local, but local untrusted input can still cause denial of service. AT Protocol/PLC consumers require Zod 3; the published fix is Zod 4.6.6, outside their ranges. A blanket Zod 4 override would change their validation contract.",
    "removeWhen": "A compatible Zod 3 backport is published or the pinned AT Protocol/PLC consumers support patched Zod 4 through reviewed compatibility work (#28). Reassess before allowing remote peer inputs."
  },
  {
    "workspaces": ["pds"],
    "package": "file-type",
    "versions": ["16.5.4"],
    "advisories": ["GHSA-5v7r-6r5c-r473"],
    "reason": "Malformed ASF parsing can loop. No patched version satisfies the PDS ^16.5.4 range. Blob upload is authenticated and this release is local-only; malformed local uploads remain an accepted denial-of-service risk, not a claim that the parser is unreachable.",
    "removeWhen": "A reviewed PDS dependency accepts file-type 21.3.1+ (or a compatible backport), with blob handling tested; track #28. Reassess before peer exposure."
  },
  {
    "workspaces": ["pds"],
    "package": "elliptic",
    "versions": ["6.6.1"],
    "advisories": ["GHSA-848j-6mx2-7j84"],
    "reason": "Risky cryptographic implementation arrives through key-encoder/@atproto/aws. AIT's default PDS uses disk blobs and no AWS KMS, so this is not its repository signing path. No patched elliptic version is published.",
    "removeWhen": "The upstream AWS/key-encoder dependency removes or replaces elliptic, or a patched compatible release is published. Reassess before enabling AWS storage/KMS."
  },
  {
    "workspaces": ["pds"],
    "package": "deepmerge",
    "versions": ["4.3.1"],
    "advisories": ["GHSA-gcqx-w48m-w2h4"],
    "reason": "Prototype poisoning in deepmerge is inherited through html-to-text/nodemailer-html-to-text. The PDS installs htmlToText() with no user options; html-to-text merges those server-controlled options, not the message HTML. No patched deepmerge version is published. This exception does not cover applications passing untrusted conversion options.",
    "removeWhen": "A compatible fix or removal is available upstream. Reassess before configuring SMTP or processing untrusted email-template options."
  },
  {
    "workspaces": ["pds"],
    "package": "nodemailer",
    "versions": ["8.0.11"],
    "advisories": [
      "GHSA-p6gq-j5cr-w38f", "GHSA-8m3c-c648-2xjj", "GHSA-wmmp-3585-3rmp",
      "GHSA-2x7j-588g-ccc2", "GHSA-cc9r-2j5m-2m83", "GHSA-6vj9-mwq6-2f5v",
      "GHSA-8vvx-rff5-p5rq", "GHSA-v53p-9fqp-m79j", "GHSA-39m8-27wv-hr27",
      "GHSA-8c8m-p3m8-cjg8", "GHSA-m943-m63m-w62w", "GHSA-85x2-q946-cp5h",
      "GHSA-4ffr-jq9g-5ffx", "GHSA-g73g-hqqh-jr95", "GHSA-4g23-2xm8-66gc"
    ],
    "reason": "These specific raw-message, recipient-parser, DNS/TLS and SMTP denial-of-service findings affect the existing 8.0.11 override. Without SMTP the PDS uses Nodemailer's JSON transport, so SMTP network/TLS paths are inactive; message parsing still runs and local malformed-input risks are not declared unreachable. The PDS supplies server-owned HTML templates rather than caller-selected raw messages. Complete fixes require a newer Nodemailer major, outside both the existing ^8 override and the PDS ^6 requirement; no major override is added here.",
    "removeWhen": "A reviewed PDS/mail dependency update supports a version clearing these advisories (current patched line 10.3.1), or compatible backports are published. Reassess before enabling SMTP; track #28."
  }
]
```

Review evidence: [`bin/install.sh`](../bin/install.sh) writes an empty `PDS_EMAIL_SMTP_URL` and disk
blob-store paths; `@atproto/pds/dist/context.js` selects an SMTP transport only
for configured email, otherwise Nodemailer's JSON transport. Its mailer installs
`htmlToText()` with default options and constructs messages from server templates.
The PLC launcher uses PostgreSQL; the PDS uses its SQLite database.
Published fix versions and advisory scope were
checked against the npm registry and advisory database on the review date.
These decisions cover that default installation, not an assertion that custom
SMTP, AWS, externally reachable listeners, or the P2P build are safe.

## Private-peer test reassessment (2026-10-30)

Historical scope: the controlled private-peer test line, initially reviewed at
`26ef0b4`, including the presence-read extension reviewed on 2026-11-09. The existing
exception JSON is unchanged.
A passing advisory gate matches IDs and versions; it does not establish that
the network exposure is safe.

- **Approval boundary:** Iroh authenticates the machine, data streams require
  current approval, and the peer front exposes read-only routes, not PDS writes
  or administration ([`appview/src/peerNetwork.mjs`](https://github.com/natewalton/ait-protocol/blob/b112595/appview/src/peerNetwork.mjs)). A malicious or
  compromised **approved** machine can still supply hostile parser input;
  signatures and endpoint binding do not remove that risk.
- **Zod is reachable:** peer PLC logs enter `validateOperationLog`, followed by
  DID-document and repository parsing. HTTP responses retain safeFetch's
  512 KiB default except `getRepo`, which permits 100 MiB
  ([`appview/src/peerClient.mjs`](https://github.com/natewalton/ait-protocol/blob/b112595/appview/src/peerClient.mjs)). The WSS subscription does **not** use that
  HTTP cap; it retains the installed `ws` client's 100 MiB message default
  ([`appview/src/peerFeed.mjs`](https://github.com/natewalton/ait-protocol/blob/b112595/appview/src/peerFeed.mjs), reviewed at line 24, `appview/node_modules/ws/lib/websocket.js:675`).
  These are byte limits, not proof against CPU/allocation exhaustion or an
  aggregate memory bound. The Zod denial-of-service risk remains unresolved.
- **file-type:** peer sync reads repository CARs and serves stored blobs through
  GET routes. It does not upload peer blobs into the local PDS or invoke its
  blob-upload MIME sniffer. That parser remains on the authenticated local
  `uploadBlob` path, not `getBlob` (`pds/node_modules/@atproto/pds/dist/api/com/atproto/repo/uploadBlob.js:17`,
  `pds/node_modules/@atproto/pds/dist/api/com/atproto/sync/getBlob.js:22`). A user
  re-uploading a received blob locally can still reach the existing risk.
- **Other exceptions:** peer projection does not add a MySQL database, SMTP
  transport, AWS KMS/blob store, or caller-controlled HTML conversion options.
  The documented Kysely, Nodemailer, deepmerge and elliptic conditions remain;
  no new claim of parser unreachability is made.

Disposition: retain the exact documented exceptions for this controlled,
approved-peer test only. Do not treat approval or response caps as a fix for
malicious-peer denial of service. Wider deployment needs a fresh risk decision
and compatible dependency remediation; this note is not a production release GO.
