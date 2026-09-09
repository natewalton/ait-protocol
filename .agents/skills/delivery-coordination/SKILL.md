---
name: delivery-coordination
description: Ship deployments, persisted-data changes, collectors, and multi-agent work with proportional validation and live verification.
---

# Lean delivery coordination

Keep the process smaller than the work. One owner is the default. Delegate
independent work when it will probably save time or tokens, or enable useful
parallel progress. No formal justification or calculation is needed.
Independent review is required only for destructive or irreversible persisted-data changes, security/auth
changes, or when the user asks for it.

## Work

1. Name the user-visible outcome and the smallest change that reaches it.
2. Inspect current state before changing it. Preserve unrelated work.
3. Run focused tests by default; use broad suites for broad or high-risk changes.
4. For persisted writes, dry-run, use a precondition, limit the write set, and
   retain a practical rollback snapshot.
5. Deploy through the supported path and verify the real user-facing surface.
6. Update the tracker once, at the end, with outcome, evidence, and any caveat.

Do not require delivery JSON, local review ledgers, exact-head hash packets,
reviewer leases, acknowledgement chains, repeated status posts, or
post-release re-review. Operational manifests, cache ledgers, run receipts,
and rollback artifacts that protect data are not release ceremony and remain.

Completion means the promised behavior is merged or otherwise delivered, the
relevant checks pass, the live surface is verified when one exists, and any
remaining work is stated plainly.
