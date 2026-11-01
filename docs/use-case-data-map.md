# CivicScope Use Case and Data Source Map

**Updated:** 2026-10-20
This is the current user-job map. Execution status and evidence owners live in
[the canonical backlog](canon-work-mission.md); source candidates and research links live
in [data-source research](data-sources-research.md). Nothing in this map authorizes a
new source, backend, data bundle, or scoring input.

## Use cases

### UC-A — Apartment or condo shopper comparing a short list

- **Job:** enter a few ZIP codes, understand the available housing-cost figures, and compare
  them on a consistent published basis.
- **Current path:** search/geocoding, ACS area figures, affordability index with its
  components, comparison matrix, margins of error, and source/methodology details.
- **Boundary:** the national table starts in ZIP order; a reader may choose a single-figure
  sort. There is no universal best-area recommendation.
- **Open opportunity:** HUD rent benchmarks or built-environment measures could add context,
  but only after geography, freshness, license, and browser-delivery checks.

### UC-B — Buyer expanding a shortlist from one known area

- **Job:** find areas that resemble one selected ZIP according to criteria the reader sets.
- **Current path:** optional similarity panel, off by default; disclosed, adjustable equal
  starting weights and cutoff;
  complete comparable figures required; results shown alphabetically rather than by score.
- **Boundary:** protected-class proxies cannot enter the similarity weights.
- **Open opportunity:** add no source until its relevance, source compatibility, and context
  lane are demonstrated.

### UC-C — Renter returning to a shortlist over several days

- **Job:** keep a shortlist, revisit it, compare figures, and export it.
- **Current path:** saved searches and comparisons in browser storage, CSV export, and URL
  selection state.
- **Evidence:** export, saved-search, and URL-state tests. Reopen this work only on a failed
  check or a reproduced defect.

### UC-D — Local resident exploring an area

- **Job:** search a ZIP or city, understand what the map and figures describe, and inspect
  source lineage.
- **Current path:** geocoding, map, selected-area detail, guided tour, keyless sources, and
  Methodology.
- **Boundary:** figures describe statistical areas, not an individual household or property.
  National named-school outcomes are limited to public-school 2019 ACGR records with
  reportable values near the selected point; NYC also has its separate 2018–19 DOE detail.

### UC-E — Analyst or planner building a custom comparison

- **Job:** set figure filters, select areas, keep the selection, inspect measures, and export.
- **Current path:** reader-set figure bounds, selected-area comparison, CSV export, saved
  searches, and selection URLs.
- **Evidence:** figure-filter, export, saved-search, URL-state, and browser tests.

### UC-F — First-time visitor without a Census key

- **Job:** understand what works before deciding whether to provide a key.
- **Current path:** key prompt and keyless detail sources.
- **Boundary:** national ACS coverage requires a user-supplied Census API key; this limitation
  must remain visible and must not be confused with empty or absent data.

### UC-G — Journalist, planner, or advocate checking a figure

- **Job:** trace a figure to its publisher, table, vintage, uncertainty, and caveats.
- **Current path:** Methodology, source attribution, metric notices, published margins of
  error, and the audit/changelog.
- **Terms and attribution:** NYC Open Data's portal-wide policy permits application use without restrictions or licensing requirements; the directory's own metadata still has no named license identifier. Keep City/DOE attribution and the 2018–19 vintage; see [source-terms research](data-sources-research.md).

### UC-H — Resident looking for fair-housing help

- **Job:** find a federal or participating state/local agency contact.
- **Current path:** direct HUD, DOJ, and HUD FHAP agency-directory links in the notice.
- **Boundary:** the directory is a starting point, not a full state/local legal map. CivicScope
  does not determine whether conduct violated a law.

## Source-to-function map

| Source or function | What the app uses it for | Current status |
|---|---|---|
| ACS 5-year | National rent, home value, income, rent burden, household, population, and other area figures | Current; households use occupied units from B25002_002E. |
| Census TIGERweb | ZIP area lookup, geocoding, and map centroids | Current; keyless. |
| NCES EDGE | District teacher count, students per teacher, enrollment, and school count | Current; administrative district measures, not quality ratings or funding. |
| Urban Institute Education Data Portal EDFacts ACGR + NCES EDGE public-school locations | Up to eight nearest named public schools within 3 km with a reportable 2019 four-year ACGR midpoint | Current; browser-readable and keyless. Joined by NCES school ID. Only 2019 public-school cohort outcomes are covered; ranges are identified, nonreportable records are omitted, and this is not a school-quality rating. See [source research](data-sources-research.md). |
| ED Data Express FS150 + NCES EDGE public-school locations | Candidate school-level ACGR joined to public-school locations by NCES school ID | Research only: same-vintage 2022–23 join verified, but ED Data Express outcomes are offered as a filtered CSV workflow; no browser-origin query path was verified. This is not the source used by the current nationwide lane. |
| U.S. ED Civil Rights Data Collection (CRDC) | Candidate school-level enrollment, course/program access, and civil-rights context | Research only: official profile API returns school records for NCES ID `010000500871`, but its JSON responses omit CORS allow-origin and browser requests from local and published CivicScope origins fail; downloadable annual ZIPs also fail CORS and are not bundled. Context data do not replace ACGR or general achievement; see [source research](data-sources-research.md). |
| NYC DOE 2020 High School Directory through NYC Open Data | Named schools and selected enrollment, graduation, attendance data | NYC's portal-wide policy permits use without restrictions or licensing requirements; this dataset's metadata still has no named license identifier. Keep City/DOE attribution and the 2018–19 vintage; see [source-terms research](data-sources-research.md). |
| CDC PLACES | Health estimates in selected-area detail | Current; protected-class proxy metadata prevents sorting, filtering, similarity, and scoring. |
| EPA SLD / National Walkability Index | Built-environment context | Current: six curated SLD v3 measures returned for the selected ZIP's geocoded point and containing block group; historical vintage and limitations are shown, with no scoring or bundled source data. |
| HUD FMR / SAFMR | Program rent benchmark context | Candidate; deferred until current vintage, geography, direct access, and distinction from observed rents are resolved. |
| FCC Broadband Data Collection | Broadband availability context | Candidate; deferred. Current app-origin API requests fail CORS, FCC's documented summary geographies omit ZIP/ZCTA, no current as-of vintage or Fabric/reuse terms are verified, and bulk downloads cannot be bundled. Availability does not establish performance, affordability, or adoption. |
| LEHD/LODES, CBP/ZBP | Commute, job-access, and business activity context | Deferred; block processing or business measures do not directly describe household employment. |
| FEMA, USGS, NOAA, EPA environmental sources | Hazard or environmental context | Deferred; keep hazard, exposure, current condition, and insurance implications distinct. |
| SVI, CEJST/EJScreen, HUD LAI, SAIPE, HMDA, SIPP/credit, commercial ratings | Specialized context or research | Not approved for integration. Re-check fit, terms, vintage, privacy, and proxy risks before any use. |

The current source research is a candidate inventory, not an implementation order. The
ranked disposition is in the canonical backlog. The broader international-data plan stays
deferred until a target country, data budget, and architecture are selected.

## Cross-cutting rules

- Each measure needs a source, dataset/table, geography, vintage, uncertainty treatment,
  and a plain-language statement of what it does and does not measure.
- Comparison rows require matching measure, unit, publisher, dataset, table, and vintage.
- No context candidate becomes a default score, similarity weight, or figure sort without
  the governance review and regression evidence required by GOVERNANCE.md.
- No roadmap phase closes through a research note. Phase status remains in
  docs/jev-roadmap.md.
