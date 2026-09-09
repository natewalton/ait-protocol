---
name: delivery-coordination
description: Coordinate shared delivery with bounded authority, proportional process, supported-path evidence, material communication, and strict isolation. Use for multi-session work, handoffs, reviews, releases, live or user-state operations, and completion decisions.
---

# Delivery coordination

Coordination is how every participating session works, not a formal role. Keep
the process smaller than the work. A session joins multi-session work only when
its artifact or decision boundary is distinct from work already assigned in the
available request or handoff. Do not poll to reconfirm it. Only one session
controls each shared artifact or decision at a time.

When AIT is available, coordinate with other sessions through AIT rather than
spawning local subagents.

Collaboration has the highest value when another session can:

- advance an independent workstream in parallel
- divide a large, divisible workload into non-overlapping batches
- investigate an upstream unknown before dependent work reaches it
- provide the single independent review justified by a high-risk change

Use collaboration when one of these benefits is likely to exceed its
coordination overhead in elapsed time or total tokens. Parallel work continues
only while the lanes remain independent.

Keep answers private unless they change shared work or the user asks. Do not
repeat a check while its answer and the work remain unchanged.

## 1. Protect state and authority

Use before joining shared work or running anything that can reach live or user
state, and immediately after a boundary failure.

**Does another session control this artifact or decision?**
   - **Yes:** Send one message naming the overlap and proposing distinct
     boundaries. Continue in a separate lane, or yield for the reply when none
     exists. Do not poll.
   - **No:** Proceed within the stated boundary.


**Can anything reachable from this work touch live or user state outside the
authorized boundary?**
   - **Yes:** Isolate or replace every reachable dependency and check again. If
     that is not possible, do not run it; state the concrete blocker.
   - **No:** Run it. Unexpected live state aborts the operation rather than
     becoming a warning.

**Did an isolation or authority boundary fail?**
   - **Yes:** Stop further mutation. State the exact action, affected state,
     recovery, and remaining risk; perform only authorized recovery.
   - **No:** Continue without an incident post.

When review is required, one session controls the verdict. Independent review
is required only for destructive or irreversible persisted-data changes,
security or authentication changes, or when the user asks for it.

## 2. Control scope and process

Use before adding scope, adding a coordination, review, test, or release step,
or preparing a third technical candidate.

**Is added scope supported by a reproduced user-path failure, an accepted
high-severity risk, or the user's direction?**
   - **Yes:** Name the changed boundary and add the smallest effective work.
   - **No:** Keep it out of active scope and continue. Record it once for later
     only when useful.

**Does this added step protect a named requirement or concrete risk?**
   - **Yes:** Use the smallest version that provides the needed evidence.
   - **No:** Remove it and continue. Do not substitute receipts, hashes, source
     greps, duplicate suites, or repeated verdicts for useful evidence.

**Is this the third technical candidate for the same requirement?**
   - **Yes:** Do not patch again yet. Compare the failed assumptions, simplify
     the scope or design, and communicate the new approach before editing.
   - **No:** Continue. Bookkeeping-only corrections are not candidates and do
     not reopen technical review.

Preserve practical rollback artifacts that protect data; do not turn them into
release ceremony.

## 3. Prove and finish

Use after changing behavior and before claiming completion.

**Did this change materially alter a supported user path?**
   - **Yes:** Exercise that path once through its real consumer. Repeat only for
     new behavior or a newly demonstrated risk.
   - **No:** Run focused checks for the changed behavior.

**Is the requested result delivered, with applicable checks passing and any
changed live surface verified?**
   - **Yes:** Claim completion and update the tracker once when one exists.
     State unfinished work plainly.
   - **No:** Take or activate the next concrete action. A candidate, verdict,
     receipt, test run, or draft release is not completion.

## 4. Communicate material changes

Use before sending a coordination message.

**Will this message change authority, evidence, risk, a blocker, or the next
action?**
   - **Yes:** Send one compact message that includes the resulting action.
   - **No:** Do not send it. Continue working or yield. Never acknowledge an
     acknowledgment or poll a working push channel.
