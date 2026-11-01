# Governance

CivicScope is intended to be a public utility, not anyone's personal property.
This document sets out the mechanisms meant to make that more than an intention.

## Copyright is collective, by construction

- The code is MIT licensed.
- Contributors license their contributions to the **project collectively** under
  a Contributor License Agreement, not to any individual.

The practical effect: there is no single copyright holder. If any individual
maintainer stops working on the project tomorrow, the code remains openly
licensed, freely forkable, and usable by anyone. Nobody inherits it.

**The Unlicense was explicitly considered and rejected.** It requires
surrendering attribution, which directly conflicts with the U.S. Census
Bureau's mandatory attribution requirement and the Open Database License's
share-alike obligation. A licence that makes it impossible to comply with
upstream data terms is not a maximally free licence here.

## The trademark is the only concentrated asset

The mark is held separately and is **not** granted by the MIT licence. This is
deliberate: it lets the project stay permanently open while preventing someone
from forking the code and shipping a deceptive, advertising-supported, or
steering-enabled version under the same name.

Registered defensively across more than one TLD, because a typo-squat or a
trademark dispute is more expensive than a few domains per year.

## Succession

If the project is unmaintained, the intent is that it transfers rather than
lapses:

1. **Code** — remains openly licensed and forkable immediately. No transfer
   needed, by design.
2. **Trademark** — transfers to a successor maintainer or to a
   housing-data-aligned nonprofit, by agreement among holders.
3. **Donations** — *as currently implemented, they do not have this property.*
   The live route is three direct personal accounts (PayPal, Venmo, Cash App), so
   funds are the maintainer's personal property and do not transfer with the
   trademark. The intent below is unchanged; the gap is real and is stated in
   `docs/governance.md` rather than left for a reader to discover.

   The intent: donations are held by a fiscal host rather than an individual's
   account, so that if the project goes dormant the funds remain with the
   collective or transfer alongside the trademark, never becoming someone's
   personal property. Moving to a collective is the single change that would most
   improve the stewardship position.

## Decision-making

Minor changes (a bug fix, a new data source, a copy edit) are made by maintainers
and merged normally.

Changes that alter the fair housing posture require explicit review and a
written rationale, because the constraints in the README are load-bearing
rather than incidental. That specifically includes:

- Adding a metric to either composite index
- Introducing a default metric order, composite ranking, or "best match" of places
- Any change to the suppression thresholds
- Adding advertising, referral, or any paid placement
- Any change to the licence

## Current planning posture

The single source of truth for phase status is still `docs/jev-roadmap.md`.
This file does not replace that contract.

For the current prioritized work direction, see [docs/jev-alignment-2026-10-16.md](docs/jev-alignment-2026-10-16.md).
That document is the result of an in-session Jev-style alignment pass over the
use cases, data sources, and existing functions. It is planning, not evidence,
and it does not close any roadmap row by itself.

The executable cross-plan backlog and its evidence owners live in
[docs/canon-work-mission.md](docs/canon-work-mission.md). Fair housing product
decisions are recorded in [docs/fair-housing-design-decisions.md](docs/fair-housing-design-decisions.md).

The important constraint is unchanged from below: **no roadmap row is marked
complete on the strength of planning prose.** A row is complete only when the
evidence exists and the project's own gate can see it.

## Legal review

**No attorney has reviewed this project.** An earlier version of this file said
one had, which was false, and it has been removed rather than softened. Nothing
here should be treated as legally cleared.

What exists instead is narrower and is stated so it is not mistaken for the
former:

- The constraints are enforced in code, not in a legal opinion. Metrics that
  encode or proxy a protected characteristic are marked `protectedClassProxy` and
  the engine refuses to offer them as a sort or filter control, so the rule cannot
  be forgotten inside an individual plugin. Suppression thresholds are applied
  centrally for the same reason.
- The national screen starts in ascending ZIP code order. A reader may explicitly
  sort by one published figure; the app does not create a universal place ranking
  or "best match". A Fair Housing notice with HUD and DOJ complaint routes renders
  on every screen showing neighbourhood data.
- Where a feature would rank places at all — the similarity scoring in Phase 2B —
  it ships **disabled by default**, behind a flag. When enabled, its equal starting
  weights and measured cutoff are disclosed and adjustable. Results are alphabetized,
  not ordered by score. That is a design decision about defaults, not a substitute
  for review.

**What this does not establish:** that the design complies with the Fair Housing
Act or with any state law. That determination needs a qualified lawyer, and the
project has not obtained one. If you rely on this for a decision with legal
consequences, get advice.

## Reporting a problem

- A data error: open an issue with the table ID and the query
- A privacy concern with a displayed figure: open an issue; suppression
  thresholds are treated as a security concern
- A fair housing concern: open an issue, or contact a fair housing organisation
  directly — links are provided in the app
