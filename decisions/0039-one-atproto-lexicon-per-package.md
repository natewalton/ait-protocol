# ADR-0039: One `@atproto/lexicon` per package; align the `@atproto/*` stack by import

**Status:** Accepted
**Date:** 2026-06-06

## Context

The AppView's `node_modules` accumulated **two** copies of `@atproto/lexicon` — `0.4.14` and `0.6.2`. In 0.x semver every minor is a breaking major, so npm physically can't merge them and `npm dedupe` / `overrides` don't help. The cause was a mixed-generation manifest: `appview/package.json` pinned `@atproto/api@^0.13`, `@atproto/repo@^0.5`, `@atproto/xrpc-server@^0.7` (all → lexicon `0.4`) alongside `@atproto/sync@^0.1` (→ `0.1.40` → lexicon `0.6`). Two of those pins — `api` and `repo` — weren't even imported by `appview/src` (0 references); they were declared, never used, and frozen a generation behind the `sync` the AppView actually depends on.

Duplicate lexicon copies make `instanceof BlobRef` unreliable across the firehose boundary (the indexer already routes around this with a duck-typed `avatarCid`). It's a latent footgun, not a live bug — but the straddle would keep widening as `@atproto/*` releases move, and "which AT Protocol generation are we on?" had no single answer. The question this ADR settles: do we freeze a global AT Protocol version for all future sessions, or enforce something narrower?

Freezing exact versions is already done — `package-lock.json` pins every transitive version. Freezing a global *range* would block legitimate upgrades and doesn't even type-check against reality: the MCP and AppView are separate processes with different needs (the MCP uses `@atproto/api@0.20`; the AppView dropped `api` entirely). The thing that actually went wrong wasn't "a version drifted" — it was **two generations coexisting inside one package**. That's the invariant worth protecting.

## Decision

**Each package declares exactly the `@atproto/*` packages it imports, on one coherent release generation, such that `@atproto/lexicon` resolves to a single version.**

- **AppView** declares `@atproto/identity ^0.5`, `@atproto/lexicon ^0.7`, `@atproto/sync ^0.3`, `@atproto/syntax ^0.6`, `@atproto/xrpc-server ^0.11` — exactly its imports — and drops the unused `@atproto/api` / `@atproto/repo`. Resolves to a single `@atproto/lexicon@0.7.1`. (`@atproto/repo` ≥ 0.9 left `@atproto/lexicon` for the new `@atproto/lex-cbor` / `@atproto/lex-data` packages, so only `api` + `xrpc-server` still pull `lexicon`; with `api` dropped, `xrpc-server@0.11` is the sole consumer.)
- **MCP** is already single-copy (`@atproto/lexicon@0.7.1` via `@atproto/api@0.20`); no change.
- **We do not freeze a global AT Protocol version.** `package-lock.json` is the exact pin. Upgrades stay allowed — the rule is that an upgrade moves a *whole package's* `@atproto/*` stack to one generation at once, never one package at a time, and the invariant below must still hold afterward.

**Invariant:** `npm ls @atproto/lexicon` resolves to a single version in each package. Mechanized by `bin/check-single-lexicon.sh`, which counts the installed `@atproto/lexicon` copies per package and exits non-zero on a straddle. Run it after any `@atproto/*` dependency change. The repo has no CI today (ADR-0002, local-only), so this is a script, not a gate — honest limitation: it protects only when run. Wire it into CI if the project ever adopts one.

## Consequences

- **The straddle bug class is detectable in one command.** A second `@atproto/lexicon` copy — the exact failure this ADR responds to — fails `check-single-lexicon.sh` instead of silently degrading `instanceof` checks.
- **Upgrades stay cheap.** No global version freeze to fight; the invariant, not a pinned number, is what's enforced. The lock already gives reproducibility.
- **"Declare direct deps = direct imports" becomes the standing rule.** The straddle existed because the manifest lied about the import graph. Keeping the two aligned both fixed this and prevents the next drift — a package can't freeze a transitive it never imports if it never declares it.
- **The MCP/AppView lexicon versions may differ across packages, and that's fine.** They're separate processes that never share lexicon objects; the invariant is per-package single-copy, not repo-wide single-version.
- **The check is unenforced until run.** A future session that bumps one `@atproto/*` package and reinstalls without running the script can reintroduce a straddle. The mitigation is cultural (this ADR + the README note) plus the one-command check; a CI gate would close it fully.

## Related

- `specs/appview-single-lexicon-copy.md` — the spec this ADR captures; details the version archaeology and the `server.ts` `xrpc-server` 0.7 → 0.11 migration.
- ADR-0028 (canonical ATProto implementations) — the AppView stack now sits on the same `@atproto/*` generation a real bsky service would, end to end.
- ADR-0008 (lexicons mirror `app.bsky.*`) — `editProfile`'s write-time validation (`specs/profile.md`) runs through this single `@atproto/lexicon`; a straddle there would split which validator the write path vs. the AppView output path use.
- ADR-0002 (local-only deployment) — why enforcement is a script rather than CI.
