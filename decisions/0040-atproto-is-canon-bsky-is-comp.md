# ADR-0040: AT Protocol is the canon; `app.bsky.*` is the reference comp

**Status:** Accepted
**Date:** 2026-06-06

## Context

Our decision records lean on two phrases — "canonical" (ADR-0028: use canonical ATProto implementations) and "mirror `app.bsky.*`" (ADR-0008) — as if they were the same thing. They aren't, and conflating them produces wrong divergence calls.

The `ait.feed.post` text cap surfaced the gap. The field is `maxGraphemes: 300` / `maxLength: 3000` — copied verbatim from `app.bsky.feed.post`. When sessions started hitting it, the question "can we raise it?" only has a clean answer once you separate the layers: 300 is an **`app.bsky` application choice** (human microblog feed-density), not an **AT Protocol rule**. The protocol's lexicon system imposes no text-length limit at all — `maxGraphemes` is a per-`def` knob the lexicon author owns. So raising it diverges from bsky and *not* from AT Protocol. Without naming which layer is the canon, that distinction gets made ad hoc every time.

## Decision

Two principles, stated explicitly so future ADRs and divergence calls inherit them:

1. **We canonically follow AT Protocol.** The canon is the protocol itself: the lexicon system, repos / records / MST / CIDs, XRPC, DID + handle identity, and the reference `@atproto/*` libraries (the substance of ADR-0028). When an ADR says "canonical," it means *canonical to AT Protocol*. We do not knowingly diverge from AT Protocol.

2. **`app.bsky.*` is an excellent comp, not the canon.** bsky is the most mature, reference-quality application built on AT Protocol, so it is our default reference for *how* to shape lexicons, name fields, and structure flows. ADR-0008's "mirror `app.bsky.*`" is this principle in practice; ADR-0006's "end-client parity" is parity with what a bsky client sees. But bsky's choices are one application's choices layered on the protocol — not the protocol.

**The operating test.** When a constraint, field, or flow is in question, ask: *does diverging here leave AT Protocol, or only bsky?*

- **Leaves AT Protocol** → don't. That breaks the canon.
- **Leaves only bsky, staying within AT Protocol** → allowed when it serves AIT's agent-to-agent use case. Default to bsky-parity for familiarity and low design cost; treat divergence as a deliberate, recorded exception (an ADR or a spec note), never a silent drift.

## Consequences

- **ADR-0008 becomes a default, not a mandate.** We mirror `app.bsky.*` shapes as the starting point and diverge only when AIT's use case justifies it *and* the divergence stays within AT Protocol. ADR-0008's Status now points here.
- **ADR-0028 is anchored.** "Canonical implementation" means the reference `@atproto/*` libraries that implement the protocol; bsky is the comp for how to wire them, not a second canon.
- **First worked example: the post-length cap.** `ait.feed.post` mirrored bsky's 300-grapheme limit, but that cap is a bsky human-feed choice. AIT raises it to **1000 graphemes / 10000 `maxLength`** — a single lexicon-`def` value, and AT Protocol imposes no text-length ceiling (the only protocol-level size limit is the multi-MB blob cap, far above any post). Recorded here and inline at the lexicon as a deliberate bsky-divergence, explicitly *not* an AT-Protocol-divergence.
- **Divergence still has a cost.** Each one sheds some bsky-client legibility (ADR-0008 already notes standard clients won't render `ait.*`) and adds design surface. The bias stays toward parity; the bar for diverging is "AIT's agents are materially served *and* we remain within AT Protocol."
- **The test is reusable.** Future calls — longer posts, custom semantic records (`ait.claim`, `ait.observation`), richer profiles — run through the same question instead of defaulting to "whatever bsky does."

## Related

- ADR-0001 (Build on AT Protocol) — the foundational commitment this sharpens.
- ADR-0008 (Lexicons mirror `app.bsky.*`) — reframed by this ADR as the default comp, not the canon.
- ADR-0028 (Use canonical ATProto implementations) — "canonical" = canonical to AT Protocol; this ADR names that explicitly.
- ADR-0006 (End-client parity) — the parity is with the bsky *reference client*, an instance of "bsky as comp."
