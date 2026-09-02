---
name: delivery-coordination
description: Coordinate critical research, engineering, data, releases, trackers, background jobs, and multi-agent work through a verified user outcome. Use for substantive multi-step delivery, persisted-data changes, deployments, AIT or other multi-session coordination, and any decision that work is done.
---

# Delivery coordination

Optimize for a truthful user outcome, not activity or procedural perfection.
Tests, commits, artifacts, receipts, and GO decisions are evidence, not the
outcome.

Use this contract proportionally. Apply every gate below to critical paths,
persisted data, collectors, multi-component changes, releases, deployments, and
completion decisions.

## Run the session test

Run these checks at the start, before review, and before completion. For critical
work, record the answers in the coordination log or delivery receipt.

### Required YES

Proceed only when every answer is **yes**:

1. Can I name one real user, the supported surface, and the change they notice?
2. Did I inspect the current source or production-shaped data directly?
3. Does this slice deliver standalone value today without another future slice?
4. Is this the crudest safe mechanism? If not, is there evidence the crude one
   fails?
5. Is one acceptance vector frozen: before/after, dependency chain, exact files,
   non-empty out of scope, production oracle, rollout, rollback, and done state?
6. Are user-visible behavior and its UI or primary consumer in the same slice?
7. Is there one write chain, one editor, one controlling reviewer, and a named
   coordinator who owns release and tracker closure?
8. If delegation helps, did I first use suitable existing peer sessions through
   AIT or the project's shared coordination channel instead of spawning a
   subagent?

If any answer is no, inspect, reslice, fold, or cut before assigning code.

### Required NO

Stop when any answer is **yes**:

1. Are we building a producer, table, framework, or abstraction with no day-one
   consumer?
2. Does value depend on another uncommitted spec or future phase?
3. Are multiple sessions editing, or multiple sessions controlling review of,
   the same decision?
4. Is another release-critical write chain touching the same source, artifact,
   deployment, or tracker item?
5. Are main or live systems being used as candidate workspaces?
6. Are synthetic or broad tests substituting for the production-shaped oracle?
7. Is anyone reviewing a moving, stale, dirty, or differently based revision?
8. Is this a third or later candidate without demonstrated convergence? The
   two-candidate checkpoint may be crossed when remaining blockers are
   code-level, independently reproduced, covered by deterministic regression
   tests, and shrinking without changing the acceptance vector. Otherwise stop
   and obtain explicit user or release-policy authority.
9. Are status, acknowledgment, receipt, or hash posts being emitted without
   changing authority, evidence, or the decision?
10. Are we waiting on external work that is safe to split and schedule?
11. Are we calling work complete while a declared outcome or cohort dimension
    remains pending?
12. Am I spawning a subagent while a suitable authorized peer session is
    available through AIT or another shared coordination channel?
13. Am I treating silence or a missing acknowledgment as inactivity, rejection,
    or authority to transfer an assigned lane?

## Write only useful specs

Treat the spec as the unit of work and use `spec-design` when available.

Before building, answer **yes** to all three:

1. Is the current user path and its concrete failure directly evidenced?
2. Is the crude solution named, and used unless evidence shows it fails?
3. Will a named user see a difference on a named surface on ship day?

Keep the spec to: **status/date -> why -> proposed outcome -> counted files ->
out of scope -> tests -> rollout -> rejected options -> sources**. Cite current
behavior with source lines, queries, or command output, including denominator and
as-of date for counts. Specify desired behavior rather than unnecessary internal
machinery. Fold or cut enablers, duplicated data, speculative future work, and
anything only its author can tell worked.

## Keep coordination minimal

Prefer existing durable peer sessions coordinated through AIT or the project's
shared channel. They preserve independent context, ownership, and audit history.
Use a spawned subagent only as a fallback when no suitable peer session is
available, the user has not requested peer/AIT coordination, and the bounded
task does not need durable cross-session ownership. Never start both for the
same lane.

- **Coordinator:** freeze scope, own sequencing, execute the approved release,
  and update the tracker.
- **Editor:** use one isolated branch; do not approve or release it.
- **Controlling reviewer:** stay read-only; reproduce the exact user/data outcome
  from the frozen revision and repeat live checks.
- Add one observer only for a real long-running job. Add red team only for a
  named adversarial risk. Do not create separate state, legacy, live, or release
  reviewers.
- Delegate release only when the coordinator lacks required access or policy
  requires it. Record the reason.

One reviewer lease exists at a time. It begins on acceptance and ends within the
decision clock. Revoke or expire it before transfer; a late prior verdict is
advisory.

Do not infer inactivity from a missing reply. Treat a visible thinking or
working state as active. Keep editor and investigator authority until explicit
decline or unavailability, observable session loss, or a named deadline expires;
a missing post is not observable loss. If the urgent clock expires first,
schedule or stop instead of rotating roles merely to keep the clock alive.

Use one consolidated post per decision event. A normal success needs assignment,
frozen candidate, verdict, and live/closure. A second candidate may add one
candidate post and one verdict, for six posts maximum. Omit acknowledgment and
status chatter.

## Use the ship-or-schedule loop

For urgent bounded work, start a twenty-minute decision clock at assignment or
first inspection. Never pause or extend it.

1. By minute three, freeze the acceptance vector and roles.
2. Have one editor build the smallest safe slice and run the production oracle
   before broad suites or receipt polish.
3. Have the controlling reviewer test that exact revision against the same
   vector. A NO-GO may add only a demonstrated blocker.
4. Merge and release an approved slice immediately.
5. At minute twenty, choose exactly one: **ship**, **schedule**, or **stop**.

Treat two candidates for the same vector and invariant class as a decision
checkpoint, even across later clocks. Continue iterating past it when the
remaining NO-GO findings are code-level, independently reproduced, protected by
deterministic regression tests, and demonstrably converging: the blocker set is
shrinking, the acceptance vector is unchanged, and no design or scope dispute
remains. Record that evidence before reopening the editor lease. Otherwise a
second NO-GO means stop, and another same-vector attempt requires explicit user
or real release-policy authority. Do not evade the checkpoint by renaming scope,
replacing roles, or opening another branch.

## Prove the real workflow

Before GO, replay the full production shape or a byte-identical clone. Verify:

- exact identities and counts, including real legacy, duplicate, partial,
  contradictory, empty, and missing-field cases;
- one canonical identity across ingestion, reuse, retry, and completion;
- terminal state only after the required operation was observed and answered;
- distinct unknown, failed, partial, rejected, blocked, and definitive states;
- aggregate completion from every work dimension;
- idempotent retries, no unintended writes, and externally anchored trust;
- producer, artifact, API/export, UI, and other supported surfaces agree;
- removing the fix or violating an invariant makes a regression fail.

Preserve legacy bytes and source evidence. Tighten eligibility or presentation
without deleting the evidence that supported the earlier state.

## Freeze, review, and release exactly

The editor freezes one clean revision and reports its parent, revision, paths,
patch hash, artifact hashes, production results, and limitations. Any new commit
withdraws approval.

The reviewer independently verifies the exact base, clean state, boundary,
hashes, production oracle, failure modes, and user outcome. A later contradiction
withdraws GO.

Treat main and live as release destinations. Merge only the reviewed revision;
build artifacts from merged source; publish versioned output; preserve current
and rollback versions; activate through the supported route; fetch the live user
and machine surfaces; exercise rollback and forward; have the same reviewer
repeat the live checks.

## Split safe external residuals

Do not wait for user permission when unfinished external work only adds coverage
or freshness and cannot make the shipped claim false or unsafe. Split it into a
separately linked open job with owner, trigger/deadline, exact revision, retries,
terminal behavior, and observable status. Make it idempotent and fail closed.

If the residual remains part of the accepted outcome or cohort, the parent is
not done. Otherwise ship the truthful slice, disclose the caveat, and keep the
follow-up open.

## Run the done test

Mark product or tracker work complete only when every answer is **yes**:

1. Is the exact reviewed revision merged and released?
2. Did the production oracle pass on the released behavior?
3. Can the named user reach the promised surface now?
4. Do all supported human and machine surfaces agree?
5. Do current, previous, and rollback paths work when promised?
6. Did the same controlling reviewer reproduce the live result?
7. Does the tracker preserve original intent and state impact, evidence,
   tradeoffs, dependencies, and caveats truthfully?
8. Is every residual either outside the accepted slice and linked as open work,
   or fully complete?

Implementation done is not product done. A local or unserved artifact is not
shipped.

## Emit one receipt for critical work

Create the receipt outside the repository, validate it before review and again
before completion, and share its path and SHA-256:

```sh
python3 ~/.codex/skills/delivery-coordination/scripts/validate_delivery_receipt.py \
  /absolute/path/to/delivery-receipt.json
```

Use the printed `delivery-coordination-v2` contract. The receipt summarizes
evidence; it never replaces direct verification.
