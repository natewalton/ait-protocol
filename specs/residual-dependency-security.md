# Remove remaining compatible dependency findings without interrupting sessions

Status: Implemented and independently reviewed GREEN. Node 24 consumer regressions and fresh candidate advisory gates passed for both variants during integration; required combined-head checks remain part of final delivery. No installed update or release publication is included.
Date: 2026-11-13.
Bases: main 6e5b555; peer 008900cd. Other AIT contributors may advance shared branches; reconcile onto their reviewed changes without imposing a release hold.

## Why

The released security controls remain useful, but a fresh audit must precede additional dependency work. On 2026-11-13, lock-only npm audits of five distinct locks (PLC/PDS/MCP common to both branches, two AppView graphs) found seven newly reported direct advisory objects in MCP's Hono/Node adapter graph. Existing allowed ranges admit patched releases without changing the SDK generation. Current candidates selected by the parallel release owner are Hono 4.13.18 and @hono/node-server 2.1.8. **Fix, sharing that exact reviewed lock change rather than duplicating their work.**

The pinned PDS consumes nodemailer-html-to-text's CJS `htmlToText()` API. Its older HTML converter pulls in unpatched deepmerge 4.3.1. html-to-text 10.0.1 replaces that dependency and retains the consumer API; actual PDS JSON/SMTP compatibility remains to be proven. **Fix with that narrowly tested override, not a PDS-generation upgrade.**

Two retained PDS findings need accurate exposure evidence. `@atproto/pds` 0.4.226's blob transactor imports only file-type's `fromStream`, whereas the ASF advisory's buffer-input path can rewind and loop. Isolated research using the actual authenticated upload route returned finite HTTP 500 responses for the tested malformed ASF inputs, left blob rows unchanged, and served subsequent requests. This is an existing error response, not proof that the vulnerable library is fixed. **Add a candidate-bound stream/HTTP regression and correct the disposition only after it passes.**

Elliptic's advisory concerns ECDSA signatures, while inspected PDS/AWS key-encoder consumers format public keys. **Require source and actual consumer verification before replacing the existing Low accepted-risk decision with narrowly scoped non-applicability.** Do not claim the Elliptic package is repaired or arbitrarily approve AWS configurations.

## The proposed work

1. Carry the independently reviewed MCP lock-only Hono/Node adapter patch into main as needed; retain the peer owner's existing patch. Do not change MCP SDK, AT Protocol or PLC generations, widen dependency ranges, or use `npm audit fix --force`.
2. Add an exact PDS override for html-to-text 10.0.1, regenerate its lock, install fresh dependencies, and run the existing actual PDS mailer/account/token fixture in JSON and owned loopback SMTP modes. Confirm the old deepmerge component is absent from the new graph; remove its exception only then.
3. Add one trusted PDS dependency-surface regression file, supporting the existing `--candidate <clean-root> --json` runner contract. Bind results to the exact candidate commit. It must load that candidate's installed dependencies and run only in a bounded child with temporary HOME/XDG/data, owned ephemeral loopback endpoints and an outbound network guard. Use the existing research envelope: 256 MiB old-space per fixture child, 45-second total child wall deadline, three-second HTTP request deadlines, and one MiB captured output. Run the deliberately vulnerable buffer positive control in its own child with a one-second termination deadline, never on the HTTP server event loop. No installed services, live accounts or paid inference.
4. For file-type, cover malformed ASF sizes and truncation, stream and buffer-path distinction, the actual authenticated HTTP upload route, no blob metadata/projection admission on those failures, subsequent authenticated availability, and a successful image upload with correct size/MIME/bytes. The known malformed route currently returns 500; preserve that existing behavior and do not claim a new 400 response. The PDS writes temporary blob bytes concurrently with sniffing, so metadata non-admission must not be described as zero filesystem writes. Verify removal of the whole owned fixture directory during cleanup. A bounded buffer-path positive control must establish that the underlying advisory remains real. The accepted non-applicability, if proven, is only for the inspected stream route; new buffer consumers invalidate it.
5. For Elliptic, verify the pinned PDS public-key/auth and AWS public-key formatting consumers and demonstrate public encode/verification with the vulnerable signing primitive disabled in the fixture. Assert the expected public-key outputs and that the actual consumers never call the disabled signer. Source inspection plus the candidate-bound test support only these declared paths, not a blanket library exemption.
6. Update docs/security.md after the proofs: remove fixed deepmerge, correct file-type and Elliptic decisions with precise source/evidence and explicit permanent regression IDs, and update only genuinely changed component fingerprints. Keep all existing 2026-12-10 expiries, High/Critical requirements, exposure union and unrelated decisions. No blanket waiver or invented patched version.
7. Reuse the existing checker's generic regression execution. It already validates candidate installed dependencies and accepts candidate-bound JSON checks from a named policy path. Do not relax symlink/local-link protections, installed correspondence, resource budgets, advisory freshness or native coverage.

The source checker consumes the new tests on every applicable PR/release through the policy regression entries. This is a real consumer path, not an uncalled test file. Runtime behavior changes only through the explicit dependency updates; there is no new parser shim, process supervisor or service limit.

## Files touched

Specification: this file. **Five implementation files:**

- `mcp/package-lock.json`: carry only the peer release owner's reviewed Hono/adapter updates where not already present.
- `pds/package.json`: exact HTML converter override.
- `pds/package-lock.json`: new converter graph and removal of old deepmerge.
- `pds/scripts/dependency-security-test.mjs` (new): candidate-bound PDS stream/blob/public-key consumer regressions.
- `docs/security.md`: remove the fixed finding and bind accurate remaining dispositions to verified source paths and regressions.

The existing mailer fixture and current CI/checker are consumers, not implementation targets. Expand this count before changing another file. A fixture failure requiring a product-code change needs a scope/design amendment before implementation.

## Out of scope

- Installing on either laptop, restarting shared services, changing session identities, or interrupting active harnesses.
- Publishing an AIT or native release under this implementation step. An adoptable release is a later delivery step coordinated with current release owners.
- Forcing Zod 4, a Kysely/database-generation migration, a PDS upgrade or native maintenance dependency rewrites solely to remove scanner counts. Their existing exact decisions remain enforced and warnings remain visible.
- New runtime file-type bridges, vendored fake patched versions, postinstall rewriting of upstream packages, symlink exceptions or advisory suppression.
- Scheduled monitoring, update bots, automatic alert issues, or changing either contributor's unrelated continuity/join work.

## Tests

Planned acceptance, not results already claimed:

- Fresh `npm ci` of all candidate workspaces in isolated checkouts, then AppView/MCP builds. Installed dependency identity validation must pass unchanged.
- `node pds/scripts/mailer-security-test.mjs`: all existing JSON/SMTP/account/token cases pass against the new HTML converter; no external recipient or network access.
- `node pds/scripts/dependency-security-test.mjs --candidate <clean-candidate> --json`: file-type and Elliptic checks pass, report the exact candidate commit, and terminate within fixed fixture budgets. Malformed HTTP uploads must finish and a later valid upload must succeed. Disabled-signing mutations must not affect public-key consumer operations; a signing-positive control must fail as intended.
- Existing MCP build, list-tools, push, channel and Codex sink/driver checks pass with the updated lock. Reconcile the parallel owner's successful tests and rerun the common required gates on final combined heads.
- `bin/check-advisories.sh --candidate <clean-candidate>`: fresh npm/native coverage and all policy regressions complete with no unresolved release blockers. Raw audit warnings for unpatched packages remain visible.
- Removing a new policy regression or presenting a different candidate/consumer must fail its non-applicability check. Do not extend an expiry or a resource budget to make a test pass.

## Sequencing or rollout

Review the scope and actual consumer assumptions before implementation. Prepare and test in isolated main/peer branches. Let other contributors release their green work; do not impose a coordination freeze. Integrate common changes through normal required checks on both branches, preserving their new shared heads. Update #28 with shipped predecessor work, this patch's tested outcome and unresolved dependency findings. Keep it open while its package-level High/Critical cleanup goal remains unmet.

The repository-control work under #29 is independent: enable GitHub-managed secret scanning and push protection, preserve required Security checks on both branches, verify initial alert metadata without exposing credentials, and remove the old scheduled-CodeQL/update-bot scope. It needs no installed update and is not a prerequisite for the dependency patch. Its before/after API configuration and independent review are recorded in #29 when complete.

## What was rejected

- A major parser override or compatibility bridge before measuring the actual deployed stream consumer: the observed PDS path rejects the malformed input, while the buffer positive control remains vulnerable.
- Replacing a Low signing risk with blanket non-applicability without consumer tests: public-only source evidence must be paired with actual candidate-bound execution and an effective disabled-signing control.
- Dropping strict installed-dependency identity checks to accommodate a local package link: would weaken a released security contract for an unnecessary adapter.
- A broad AT Protocol upgrade or force-fix: much larger account/repository/runtime compatibility risk than the compatible updates and narrowly tested decisions here.
- Treating existing native maintenance notices as new vulnerabilities, extending expiry dates, or hiding warnings to claim a clean scanner result.

## Sources

- Fresh lock-only audit JSON under `/private/tmp/ait-residual-evidence-20261113/audit-*.json`, 2026-11-13; includes dev/optional/peer coverage and keeps inherited counts separate from unique advisories.
- PDS 0.4.226 installed consumer `dist/actor-store/blob/transactor.js:3-4,40-58,261-264`; actual research fixture `/private/tmp/ait-residual-evidence-20261113/pds-blob-probe.mjs` and its log. Permanent tests must repeat against fresh candidate installs, not rely on this research installation.
- PDS `dist/auth-verifier.js` and @atproto/aws `dist/kms.js`: actual key-encoder consumers; package source inspection to be repeated by the permanent fixture/reviewer.
- [file-type advisory and first patched release](https://github.com/advisories/GHSA-5v7r-6r5c-r473).
- [Elliptic signature advisory with no published patch](https://github.com/advisories/GHSA-848j-6mx2-7j84).
- [deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
- `bin/check-advisories.mjs:91-139,151-173,237-268`: strict installed correspondence, ancestry fingerprints and generic candidate-bound regression contract.
