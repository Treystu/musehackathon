# Fair Housing and Area-Context Design Decisions

**Recorded:** 2026-10-16
**Status:** product and governance record; not a legal opinion.

This document records how CivicScope currently handles area-level measures and user
controls. It is meant to keep interface copy, code, and future source plans aligned. It
does not say that a design is legally compliant. No attorney has reviewed CivicScope.
For dated research and legal questions, see
[the legal analysis](../audit/civicscope-legal-analysis-2026-10-16.md).

## What the product currently does

### National screen

- The screen starts in ascending ZIP code order.
- A reader can explicitly sort by one published figure. That is a measure-specific order,
  not a composite or universal judgment of which place is better.
- Figure filters only narrow the rows in response to limits the reader enters.
- The table does not use race or ethnicity as a sort, filter, score, or recommendation
  input.

### Scores and similarity

- The selected-area view displays a 0-100 affordability index. Its component measures,
  weights, exclusions, basis, and underlying figures are available to the reader. It is
  a narrow housing-cost summary, not an overall assessment of an area.
- Similar-ZIP search is off by default. When enabled it starts with equal weights and a
  measured cutoff, both disclosed and adjustable; matching areas appear alphabetically
  rather than ordered by similarity score.
- The shared comparison matrix only places measures together when every selected area
  uses the same unit, label, publisher, dataset, table, and vintage. Margins of error
  remain beside estimates.

### Protected-class proxies and demographics

- The current metric registry contains no race or ethnicity measure or map layer.
- Metrics marked protectedClassProxy can appear in area detail with their source notice,
  but the executor and allowlists exclude them from sorting, filtering, similarity, and
  composite scores.
- This is a product boundary. It does not claim that all demographic data is unlawful or
  that publishing school or crime information is inherently unlawful.

### School information

- NCES EDGE provides district-level teacher count, students per teacher, enrollment, and
  school count. These are not school-quality ratings or funding measures.
- A nationwide source adds up to eight nearest public-school 2019 four-year adjusted cohort
  graduation outcomes within 3 km, joined to 2019–20 NCES EDGE locations. The displayed
  midpoint can represent a reported range; missing or suppressed records are omitted. This
  is not a complete list of nearby schools. NYC DOE enrollment, graduation, and attendance
  remain separate 2018–19 local
  context. Neither source is converted into a school-quality rating.
- CivicScope does not combine these measures with housing costs into a “best schools for
  the price” score. The earlier 0/55 portal search documented the limits of that search,
  not proof that no future source can qualify and not a legal prohibition.
- HUD's April 24, 2026 letter says that consistent sharing of school and crime
  information without discriminatory intent is not itself an FHA violation for real
  estate professionals. This product boundary must not be described as a legal ban on
  publishing those data. The letter does not settle the law for this product or every
  jurisdiction.

## Source and access boundaries

- Every new data source needs a named user job, geographic fit, vintage, methodology,
  attribution, reuse terms, and a delivery plan that matches the browser-side architecture.
- Research candidates remain context-only unless a separate governance review explicitly
  accepts them as a sort, similarity, or index input.
- SVI, PLACES health measures, FEMA hazards, environmental-justice datasets, HUD LAI,
  walkability, and broadband availability are not default inputs to the affordability
  index or similarity.
- The NYC DOE directory metadata has no license identifier. CivicScope attributes DOE
  and has not claimed a particular license. The current API use, browser cache behavior,
  and redistribution terms remain unresolved; do not bundle or make stronger license
  claims until the relevant terms are confirmed.

## Interface commitments

- Describe figures as estimates about statistical areas, never about an individual
  household or property.
- Keep sources, table IDs, vintage, notices, and uncertainty with the figures they
  describe.
- Use the notice to state what CivicScope does and link maintained federal complaint
  and local-agency resources. HUD's Fair Housing Assistance Program directory is a
  starting point for participating agencies, not a complete legal map.
- Do not say that the product “never ranks” or “never sorts”: readers can sort individual
  measures and may opt in to alphabetical similarity results. State instead that CivicScope
  does not make a universal best-area ranking or recommend a place.
- Treat future changes to metric inputs, default ordering, suppression, or paid placement
  as governance changes that need an explicit written rationale.

## Truth owners

- Default ordering and one-measure sorts: src/core/sweep-sorting.ts,
  src/core/sweep-sorting.test.ts, src/ui/App.tsx, and src/ui/SweepTable.tsx.
- Protected-proxy boundaries: src/core/sortable-surface.ts, src/core/scoring.ts,
  plugin legal metadata, tests/test_gates.test.ts, and tests/scoring.test.ts.
- Affordability index: src/core/scoring.ts, src/ui/CompositeCard.tsx, and
  tests/scoring.test.ts.
- Similarity defaults and ordering: src/core/similarity.ts, src/ui/SimilarityPanel.tsx,
  and similarity tests.
- User-facing claims and help routes: src/ui/FairHousingNotice.tsx,
  src/ui/Methodology.tsx, and src/ui/MapView.tsx.
- NYC DOE attribution and unresolved terms: src/core/plugins/ny-schools.ts,
  src/ui/Methodology.tsx, and the linked legal analysis.

## Primary references

- [HUD Fair Housing Assistance Program agencies](https://www.hud.gov/stat/fheo/partners-agencies)
- [HUD April 24, 2026 letter on sharing school and crime information](https://www.hud.gov/news/hud-no-26-028)
- [NYC Open Data dataset metadata for 23z9-6uk9](https://data.cityofnewyork.us/api/views/23z9-6uk9.json)
- [NYC Open Data terms](https://data.cityofnewyork.us/stories/s/k9k7-3cje)
