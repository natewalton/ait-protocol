# Security and advisories

AIT's session hooks are workflow guardrails, not an operating-system security
boundary. UUID-derived credential encryption does not protect credentials from
a process that can read both the UUID and the credential file under the same
Unix user. See [Architecture](architecture.md#trust-and-record-semantics) for the
scope of those controls.

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
its removal condition is met. These local-only risk decisions do not cover private-peer builds, which
require a separate review.

<!-- advisory-exceptions -->
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
