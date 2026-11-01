# Phase 1 decision: no bundled sample data

**Date:** 2026-10-05
**Supersedes:** the sample-data component of `docs/PR_PHASE_1_SCOPE.md` (P1.2,
700 LoC, "55 ZIPs bundled, one batched Census ACS request") and the `Sample Data`
sections of `docs/EXECUTION_READY.md` and `docs/OPUS_REMEDIATION_APPLIED.md`.

## The decision

**The platform ships no data.** A visitor supplies their own free Census key, and
every figure in the application is fetched from the publisher by their own browser
at the moment they ask for it. Nothing is bundled, cached in the repository, or
served from our own storage.

## Why the plan's proposal was rejected

The plan proposed baking 55 real areas into the repository so a first-time visitor
would see figures without adding a key. It is a reasonable feature and it was
rejected on three grounds, in increasing order of weight.

**It would contradict the project's central claim.** `docs/governance.md` states
that the product holds no copy of the data, that every figure can be independently
re-fetched from the publisher to check it, and that a fork "is a working copy of
the whole product". A committed ACS snapshot is a copy of the data on one fixed
vintage. It is the one artefact in the repository that cannot be re-verified
against its source without a separate build step, and it is the only figure set a
reader would see that the reader could not check for themselves.

**It would go stale silently.** The committed file would carry a vintage label
(2023 5-year) and would be indistinguishable, to a reader who did not look, from a
current figure. The app already goes to real trouble to prevent exactly this: a
label saying "Loaded from this browser's local cache. Figures come from the
American Community Survey 2023 5-year release and update annually" exists because a
stale number that looks current is the failure this project treats as worst. A
sample file frozen at whatever vintage it was baked at adds the same failure to
the first thing a new visitor sees.

**It would not have solved the problem it was aimed at, as thoroughly as
assumed.** The stated goal was to remove the key wall for a first-time visitor. The
survey ZIP codes already work with no key at all: `geocode.ts` resolves a ZIP
code keylessly through TIGERweb, and the drilldown plugins for CDC PLACES, NCES and
the per-state school sources are keyless. So the wall applies to the *country-wide
screen*, not to the application. Bundling 55 areas would have shown a visitor a
table of 55 rows while the 33,791 they came to look at stayed behind the key, which
is arguably a worse first impression than an honest explanation: it makes a
boundary look like a limit of the data rather than a limit of the free tier.

## What replaces it

The key wall is a documentation problem, so it is treated as one:

1. **A guided tour** (`src/ui/GuidedTour.tsx`) on first visit, which says what the
   tool does, why a key is needed, and what the key can and cannot see.
2. **The key prompt states the free-tier boundary explicitly** rather than
   describing the screen as merely "locked" — the country-wide screen needs a key,
   single-area lookup does not.
3. **No bundled figures anywhere.** Nothing in the repository is a copy of a
   publisher's output.

## Removed from scope

`tools/gen-sample-data.mjs` was written and then deleted rather than committed. A
generator for data the project will not ship is dead code that would read as an
outstanding task.

The January refresh workflow in the plan existed only to keep the baked sample
current. With no baked sample there is nothing to refresh, so the workflow is
withdrawn — which also means the plan's request for `contents: write` and
`pull-requests: write` in CI never arises. The repository keeps its read-only
least-privilege posture, which `docs/CLA.md` and `.github/workflows/ci.yml` both
currently rely on.

## What still needs the maintainer

Nothing. This decision removes a dependency rather than adding one. It also removes
the only part of Phase 1 that would have needed a credential to build.