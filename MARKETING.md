# Liar's Ledger - Revised Positioning Copy
(Draft for review - replaces the earlier version that didn't yet account for Pro's AI features)

---

## Core tagline (unchanged - still accurate)

**We don't pick sides. We pick votes.**

---

## Revised body copy

The free Ledger is non-partisan by design. It shows how officials voted -
sponsored bills, cosponsored bills, roll-call votes, interest group
ratings - linked directly back to congress.gov and VoteSmart. No
commentary. No ranking. No spin. If it's not in the official record, it's
not in the Ledger.

**Pro adds one thing on top: AI-assisted analysis**, clearly separated from
the sourced record. When a claim doesn't match an official's vote
history, Pro can summarize the article and show whether the record
supports, contradicts, or is mixed on that specific claim - with an
explanation, every time, so you can check the reasoning yourself instead
of taking our word for it. This layer is generated, not sourced, and we
say so on every verdict. The free Ledger underneath it never changes.

**Open source.** Every line of code that touches a vote - detection
rules, source matching, record delivery - is public on GitHub. Anyone
can audit how we pull data, not just trust that we did it right.

**Source-of-truth for the record itself.** Votes, sponsorships, and
ratings come from congress.gov and VoteSmart, with a direct link back to
the original source on every entry. The AI analysis in Pro is built on
top of that record - it doesn't replace it, and it's never presented as
if it were sourced fact.

---

## Section-by-section, for a "How it works" or "Trust" page

### Non-partisan by construction
The Ledger itself - bills, votes, ratings - has no editorial layer. We
don't decide who's right. Pro's AI verdicts are a separate, opt-in layer
built on top of the record, always labeled as AI-generated, never mixed
into the sourced data itself.

### Open source
Every line of code that touches a vote is public and auditable on
GitHub. [Insert repo link.]

### Source-of-truth for the record
We link directly to congress.gov and VoteSmart on every entry. If a fact
isn't in one of those sources, it's not presented as a fact in the
Ledger - full stop, regardless of tier.

---

## What changed from the original, and why

1. **"Does not editorialize... no editorial layer... the record is the
   record"** - removed as a blanket claim covering the whole product,
   since Pro's AI claim-verdict feature is a real editorial/analytical
   layer (an LLM judging "supports/contradicts/mixed"). Replaced with a
   scoped claim: the *sourced record* (free tier) has no editorial layer;
   Pro adds a clearly-labeled AI layer on top of it, not inside it.

2. **"It shows how officials voted, linked back to congress.gov, house.gov,
   and senate.gov"** - house.gov/senate.gov removed; nothing in the
   current codebase actually links there. Congress.gov and VoteSmart
   added, since those are the two sources the product actually cites
   today. (GovTrack also feeds roll-call data server-side, but isn't
   surfaced as an outbound citation link the way congress.gov/VoteSmart
   are - worth deciding if that should also be named explicitly, or kept
   as an implementation detail.)

3. **"If it is not in the official record, it is not in the ledger"** -
   kept, but now scoped explicitly to the sourced data, with an explicit
   carve-out naming the AI layer as the one place this absolute claim
   doesn't apply (since it's generated, not retrieved) - said openly
   rather than left for someone to notice the contradiction themselves.

4. **Open source claim** - kept as-is, confirmed accurate. Added a
   concrete call-to-action (link to repo) since an unlinked "we're open
   source" claim invites the question "okay, where?"