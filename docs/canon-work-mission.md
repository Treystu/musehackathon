# CivicScope Canonical Work Backlog

**Updated:** 2026-10-20
**Purpose:** reconcile the audit, Jev-style alignment, use-case map, data-source research,
legal analysis, and existing roadmap into one executable record.

The user has authorized execution of the plans in this session. This backlog replaces
the earlier planning-first mission. docs/jev-roadmap.md remains the only source of
truth for phase status; this file tracks product and research work without closing a
roadmap row by itself.

## Decision rules

- A status becomes **complete** only after the named code, tests, scan, or source record
  provides the evidence. Planning prose alone never closes work.
- Work is ranked by user trust and value, readiness, and risk. No numeric score is
  presented because this repo has no measured scale for scoring product priorities.
- The current product is a browser-side static app. docs/PHASE_1_DECISION.md rejects
  bundled sample data. No new integration may silently introduce a Worker, backend,
  source-data bundle, key, or new scoring input.
- Candidate datasets are not approved for ingestion. Before implementation, record the
  user job, geography, vintage, methodology, attribution and reuse terms, runtime access
  or build process, and an honest context-only presentation. Check fair-housing and
  governance constraints before any candidate can affect sorting, similarity, or scores.
- NYC DOE source-terms research is complete: NYC Open Data's portal-wide policy permits
  application use without use restrictions or licensing requirements, while the specific
  directory metadata still has no named license identifier. Keep its City/DOE attribution
  and 2018–19 vintage visible, make no named-license claim, and preserve the separate
  browser-only/no-bundled-data architecture decision. Evidence and freshness implications
  are recorded in docs/data-sources-research.md.
- CIVICSCOPE-R2-SCHOOLS is **partially addressed**. A browser-readable Urban Institute
  Education Data Portal API now supplies 2019 EDFacts ACGR outcomes for nearby public
  schools with reportable values, joined by NCES school ID to 2019–20 NCES EDGE locations.
  It does not cover all school types, grades, years, or outcomes; many records are ranges
  represented by their midpoint, and suppressed/missing outcomes are omitted. NYC DOE's
  separate 2018–19 school detail remains active. Earlier ED Data Express and CRDC research
  still documents why those sources are not the implementation path. Details, terms,
  limitations, and verification are in docs/data-sources-research.md.
- No attorney has reviewed the project. The legal analysis and this design record are
  product research, not legal clearance or a complete state-by-state legal guide.

## Executed work from this audit

The rows below are implemented in this working tree. Status reflects evidence through
2026-10-20. The four targeted Census-key browser checks are verified below; unrelated
source-owner prerequisites and broader-suite coverage remain separately scoped.

| ID | Rank | Work and current status | Truth owner / evidence |
|---|---:|---|---|
| CS-01 | 1 | **Complete by unit, build, and targeted browser evidence.** Align the household count variable and methodology table: households are occupied housing units, ACS B25002_002E, not total units in B25001. The saved-key browser case confirmed different household counts across two ZIPs. | src/core/plugins/acs.ts; tests/metric-registry.test.ts; src/e2e/app.e2e.ts; README data table; 2026-10-20 verification record |
| CS-02 | 2 | **Complete by unit/build and targeted browser evidence.** Start the national screen in ascending ZIP order. An explicit user choice may sort by one published measure; there is no universal best-area ordering. The saved-key browser case loaded over 30,000 ZIP codes and confirmed default ZIP order; a separate targeted browser case covered local sorting and Similarity presentation. | src/core/sweep-sorting.ts; src/core/sweep-sorting.test.ts; src/ui/App.tsx; src/ui/SweepTable.tsx; src/e2e/app.e2e.ts; 2026-10-20 verification record |
| CS-03 | 3 | **Complete by unit/build and targeted browser evidence.** Add a shared comparison matrix that only combines the same measure, unit, publisher, dataset, table, and vintage across every selected area; keep margins of error beside estimates. The saved-key browser cases confirmed the comparison matrix and rendered published figures with margins of error. | src/core/comparison.ts; src/core/comparison.test.ts; src/ui/Comparison.tsx; src/e2e/app.e2e.ts; 2026-10-20 verification record |
| CS-04 | 4 | **Complete by source, build, and accessibility evidence.** Correct the Fair Housing notice, methodology and README to describe actual controls and scores, explain that school information is not inherently unlawful to publish, and link HUD/DOJ plus HUD's FHAP agency directory. | src/ui/FairHousingNotice.tsx; src/ui/Methodology.tsx; GOVERNANCE.md; README.md; docs/fair-housing-design-decisions.md; audit/civicscope-legal-analysis-2026-10-16.md |
| CS-05 | 5 | **Complete: attribution correction and source-terms review documented.** Correct NYC DOE attribution, dataset identity and geography; distinguish NYC Open Data's portal-wide no-restrictions policy from the dataset metadata's blank license identifier; retain source vintage and freshness caveats. | src/core/plugins/ny-schools.ts; tests/metric-registry.test.ts; src/ui/Methodology.tsx; README.md; docs/data-sources-research.md; official dataset metadata, FAQ, Technical Standards Manual and Terms of Use |
| CS-06 | 6 | **Complete by source/build evidence.** Describe browser storage accurately, including the key, saved comparisons/preferences, and cached public responses; explain clearing browser data. | src/ui/Methodology.tsx; privacy section in legal analysis |
| CS-07 | 7 | **Complete by unit/build and targeted browser evidence.** Correct school-data claims: NCES EDGE emits teacher count, students per teacher, enrolled students, and school count, not per-pupil spending or district funding. The targeted live browser case confirms district staffing figures render; it does not verify the separate nearby public-school ACGR lane. | src/core/plugins/schools.ts; src/ui/MapView.tsx; src/ui/Comparison.tsx; README.md; src/e2e/app.e2e.ts; 2026-10-20 verification record; legal analysis |
| CS-08 | 8 | **Complete by scans and source review.** Make all canonical planning notes point to this backlog for execution status and retain the roadmap as the phase-status authority. | README.md; GOVERNANCE.md; AGENTS.md; docs/jev-alignment-2026-10-16.md; docs/use-case-data-map.md; docs/data-sources-research.md |

## Closed research item

### Rank 1 — NYC DOE source terms

**Status: complete (2026-10-16).** Official NYC Open Data policy says portal datasets may be
used without use restrictions or licensing requirements, including in applications. The
specific `23z9-6uk9` metadata still reports null license identifier/name/URL fields; this is
not a named license, and no license name is claimed. The current app's DOE, dataset, school-
year and NYC Open Data attribution meets the documented source/version attribution intent.
The `2018-19 school year` vintage and 2019-10-23 data timestamp are historical; the City
disclaims accuracy/completeness warranties, may refresh or overwrite data at any time, and
does not retain older versions. Preserve the vintage in presentation and exports. This closes
the terms research for the existing browser API use only; no roadmap phase status, bundled
data, backend, or scoring input changes here.

**Evidence:** [NYC dataset metadata](https://data.cityofnewyork.us/api/views/23z9-6uk9.json),
[dataset page](https://data.cityofnewyork.us/Education/2020-DOE-High-School-Directory/23z9-6uk9),
[NYC Open Data FAQ](https://www.nyc.gov/opendata/get-started/FAQs), [Technical Standards
Manual](https://opendata.cityofnewyork.us/wp-content/uploads/NYC_OpenData_TechnicalStandardsManual.pdf),
[portal Terms of Use](https://data.cityofnewyork.us/stories/s/Terms-of-Use/k9k7-3cje), and
[City metadata/citation guidance](https://cityofnewyork.github.io/opendatatsm/citystandards.html).
The research note records what each source establishes and the freshness/cache implications.

## Ranked backlog and scoped outcomes

### Rank 2 — Keep the existing product understandable

**Status: implemented for the scoped CS-02 through CS-07 backlog items listed above.**
Evidence remains limited to the source, unit, build, accessibility, and targeted browser
checks named in those rows; detailed Census-key browser scope and results are recorded
below.
`CIVICSCOPE-R2-SCHOOLS` remains **partially addressed** with the source and coverage limits
recorded above.

**Open validation follow-up - broader live E2E suite:** the verification record below
does not establish full browser-suite coverage. Run and reconcile the remaining live E2E
files in a separately scoped pass before claiming full browser-suite coverage.

**Blocked validation - real Windows unsafe-ACL refusal:** unit tests reject an
Everyone ACE through the policy predicate, but do not exercise Windows ACL retrieval and
refusal through `loadCensusKeyFromScmorc`. The required real-fixture proof remains
blocked; see the verification record below for the exact execution limit. When an
environment permits the fixture, assert the loader refuses before populating
`CENSUS_KEY`; use only a temporary synthetic key, never the saved real key.

**Completed focused parser check:** `src/core/census-key-loader.test.ts` now asserts that
the parsed key equals the supplied synthetic value. The focused test and full verification
passed; this does not change loader scope or roadmap status.

**Resolved scope decisions:** the change is limited to loading an existing `.scmorc` key
for the targeted Census browser run. The separate key-entry script was removed, as were
the auto-load hooks from `tools/audit-all-data.mjs`, `tools/probe-moe-cost.mjs`, and
`vitest.live.config.ts`. Those tools retain their existing explicit `CENSUS_KEY`
environment-variable behavior. Removing the live-config hook also removes its
import-time credential read and environment mutation. No verification is claimed or
required for the removed hooks.

**Jev cross-check - priority and completeness only, not evidence:** TypeSafe `jev-1.13.0`
selected scope reconciliation before verification of retained paths (Choice probability
0.81; confidence 0.75) and classified the live-config import-time credential effect as a
distinct tracked action (probability 0.99; confidence 0.98). A broader aggregate
completeness prompt fell out of pack and was discarded. These judgments help prioritize
and check the action list; repository evidence remains authoritative, and no roadmap status
or verification claim changes from model output.

**Partial validation - runner failure cleanup:** the simplified runner's first attempt
failed after preview startup because PowerShell argument passing changed the JSON test-title
list. The run exited nonzero, and a process check afterward found no preview or Vitest
process. The successful rerun also left no preview process or temporary log directory.
Build/browser failure and interrupt cleanup have not both been exercised; keep this follow-up
open until those paths are verified.

**Completed maintenance follow-up - runner simplification:** the runner now has one
preview/loader/Vitest path, checks each selected test exactly once, and redacts the loaded
key from captured output. Removed the extra title-JSON substitution and asynchronous output
plumbing; the verified success path remains intact.

The seven-use-case review found that explanation and trust matter before adding more
measures.

**Evidence owner:** methodology and comparison UI; unit and browser tests named above;
docs/fair-housing-design-decisions.md.

### Rank 3 — EPA Smart Location Database / National Walkability Index context lane

**Status: complete for the scoped outcome (2026-10-16).** One browser request now
returns six EPA SLD v3 measures for the selected ZIP's Census-geocoded point: the existing
`NatWalkInd` plus `D1A`, `D2B_E5MIXA`, `D3B`, `D4A`, and `D5AR`. The cards show each field,
unit, release and field-input vintages, block-group geography, and its limits. Matching
measures can appear in the existing same-source comparison matrix; EPA values are not
sortable and do not enter similarity or composite scores. This meets the planned small set
of named SLD measures. The wider 90-plus-indicator catalog and the
separate Access to Jobs and Workers Via Transit tool are explicitly outside this Rank 3
outcome, not remaining planned work. EPA details, sources, freshness, coverage, and the
scope decision are recorded in docs/data-sources-research.md. The live `94103` browser
flow returned all six measures for block group `060750178022`; focused tests cover fields,
sentinels, formatting, ambiguity, and the context-only boundary. No key, Worker, bundled
source data, sorting input, similarity input, or composite input was added.

**Evidence owner:** docs/data-sources-research.md, docs/PHASE_1_DECISION.md, source
metadata, `src/core/plugins/epa-nwi.ts`, `tests/epa-nwi.test.ts`, and the live browser
detail cards.

**Structure note:** `src/core/plugin-catalog.ts` owns registered sources and derives the
automatic drilldown IDs from the source objects. The query hook owns request orchestration
and state. `src/ui/metric-format.ts` owns unit formatting, display validity, and absence
labels shared by cards, comparison, the country table, and formatter tests. `MetricCard.tsx`
owns card rendering and interaction; `SweepTable.tsx` owns the virtualized window and keeps
its country-sweep "not yet imported" state distinct from a source-reported absence.

### Rank 4 — HUD Fair Market Rent / Small Area FMR benchmark

**Status: open with access and geography blockers.** HUD's FMR API requires a registered
HUD User account and bearer token. A Chromium request from the app origin confirmed that
the API permits CORS and the `Authorization` header, but an invalid-token request returned
401 and no valid HUD token is available here. The public FY2027 lookup filters and SAFMR
workbook returned an empty 202 response with an AWS WAF challenge when fetched from the app
origin. HUD's API takes a county FIPS or metro-area identifier; metro SAFMR responses contain
ZIP rows, but the current location feed resolves a Census ZCTA point and has no verified
ZCTA-to-HUD-area/ZIP crosswalk. Keep the lane open: do not ship a county/metro fallback as a
ZIP SAFMR. HUD publishes FY2027 schedules, while an official exception list keeps FY2026
effective in some areas; any future result must pin and display its fiscal year and area.
Label the measure as a HUD program benchmark, distinguish it from ACS rent estimates and
asking rents, and include HUD's required API notice if the API is used.

**Evidence owner:** docs/data-sources-research.md and HUD API/source documentation; the
Rank 4 context-lane design remains deferred until access and the geography join are proven.

### Rank 5 — Power-user lifecycle and correctness

**Status:** existing paths and tests cover CSV export, saved-search storage/lifecycle,
figure filters, and URL selection state. Reopen only when the verification run fails or a
concrete user-facing defect is reproduced; do not add duplicate functionality to satisfy
an old planning note.

**Evidence owner:** tests/export.test.ts, saved-search tests, tests/figure-filters.test.ts,
tests/url-state.test.ts, and current browser tests.

### Rank 6 — FCC Broadband Data Collection context

**Status: open with access, geography, vintage, and terms blockers.** FCC guidance says an
FCC user account enables the Public Data API; its current help materials describe API calls
for downloading BDC data and fixed CSV/mobile GIS products. The current map's documented
summary geographies do not include ZIP/ZCTA. Fixed records are location-point availability
keyed to FCC Fabric locations, not CivicScope ZCTAs. From the local app origin, Chromium's
request to the FCC data-list route failed CORS; the unauthenticated direct request returned
401, and an Origin-bearing request returned 403 without CORS headers. No authenticated
response or current data vintage was verified. A ZCTA join would need a supported source
geography or licensed Fabric-derived location attributes; no reuse terms for that path have
been cleared. Availability is not internet performance, affordability, or adoption. Keep
open; do not bundle the bulk files or equate this with ACS no-subscription.

**Evidence owner:** docs/data-sources-research.md records the official-source review and
app-origin probe. Any future integration needs a source-specific test and attribution/terms
record before this status can change.

### Rank 7 — Maintain protected-class and context-only boundaries

**Status:** ongoing constraint, not a feature request. Health and other protected-class
proxy measures may appear in detail but must remain outside sort/filter/similarity/index
inputs unless an explicit governance review changes that boundary. Hazard, vulnerability,
environmental justice, school, and connectivity measures must not become a composite or
similarity input by accident.

**Evidence owner:** src/core/sortable-surface.ts, src/core/scoring.ts, plugin metadata,
tests/test_gates.test.ts, tests/scoring.test.ts, and the fair-housing design record.

## Source-to-use-case disposition

| Candidate | Best-fit use cases | Disposition |
|---|---|---|
| EPA SLD / Walkability Index | UC-A short list, UC-B similar areas, UC-D local context | Six curated SLD v3 fields are live in keyless, block-group point context; browser-verified and excluded from sorting, similarity, and composites. The broader 90-plus-field catalog is outside the scoped outcome. |
| HUD FMR / SAFMR / income limits | UC-A and UC-C renters; UC-F keyless visitor (not met) | Rank 4 open: API CORS is verified but a valid registered HUD token and ZCTA-to-HUD-area/ZIP join are not; public FY2027 lookup/XLSX fetches are challenged from the app origin. |
| FCC BDC | UC-A, UC-B, UC-D connectivity context | Rank 6 open: the app-origin API request is blocked by CORS, the direct unauthenticated request is 401, documented geographies do not include ZIP/ZCTA, and Fabric-based joining/reuse terms are unresolved; bulk availability is not performance, price, or adoption. |
| LEHD/LODES | UC-A/UC-B commute and job access | Deferred: block-level files and geography processing need an architecture case. |
| Census CBP/ZBP | UC-D/UC-G local economic context | Deferred: business counts are not household employment or income. |
| FEMA NRI/NFHL; USGS/NOAA | UC-A/UC-D hazard context | Deferred: hazard and insurance implications need separate, clear framing. |
| EPA AirData, TRI, Superfund, impaired waters | UC-D local environmental context | Deferred: current conditions versus site/proximity records must remain distinct. |
| SVI, PLACES, CEJST/EJScreen, HUD LAI | UC-D/UC-G context | Not scoring/similarity inputs. Re-check vintage, status, reuse terms and proxy risks before any context display. |
| HMDA, SAIPE, SIPP/credit panels, Walk Score, GreatSchools/Niche | Specialized or commercial use cases | Out of near-term scope; geography, privacy, price, or reuse terms do not fit the current core without a separate case. |
| FHFA HPI, BLS QCEW, USDA rural/food access, ENERGY STAR | UC-D/UC-G context | Deferred; no canonical user job currently justifies adding them. |

The broader country-selection and international architecture proposal in
docs/worldwide-data-plan.md remains deferred until the maintainer selects a target
country, data budget, and architecture. The plan does not authorize code changes by itself.

## Use-case coverage

- **UC-A — short-list shopper:** search, ACS measures, affordability index, and same-source
  comparison matrix exist. New housing-cost/context measures remain deferred.
- **UC-B — similar-area explorer:** optional reader-weighted similarity is off by default,
  excludes protected proxies, requires comparable figures, and shows results alphabetically.
- **UC-C — returning renter:** saved comparisons, CSV export, and browser persistence exist;
  their tests are the truth owners.
- **UC-D — curious local:** search, ZIP map, detail, and source methodology exist; source
  coverage and school data limitations must stay explicit.
- **UC-E — analyst/power user:** figure filters, export, selection URL state, and saved
  comparisons exist; do not claim a current gap without a failing test or reproduced issue.
- **UC-F — visitor without a Census key:** key prompt and keyless drilldown sources exist;
  national ACS coverage still requires a user-supplied key.
- **UC-G — journalist/planner:** source, vintage, uncertainty, and methodology are exposed;
  the NYC dataset-specific license identifier remains absent, and no attorney has reviewed
  the project.
- **UC-H — resident seeking fair-housing help:** HUD and DOJ routes plus HUD's FHAP agency
  directory are available. CivicScope does not provide a jurisdiction-by-jurisdiction legal
  guide or decide whether conduct violated a law.

## Roadmap and verification record

- CIVICSCOPE-R2-SCHOOLS is **partially addressed** by the nationwide 2019 EDFacts/NCES
  lane described above. The API's browser access and terms were checked; deterministic
  source and production-browser fixtures verify the school-ID join, displayed midpoint
  and source range, and retained NYC DOE results. The item remains partial because the
  implemented source shows at most eight nearest reportable 2019 public-school four-year
  ACGR values within 3 km of the selected point, not all nearby schools, grades, vintages,
  or outcome types. The 2022–23 ED
  Data Express result is still a filtered CSV workflow with no verified app-origin query
  path; the CRDC findings below remain specific to that research-only source.
- The official [CRDC download page](https://ocrdata.ed.gov/data) lists 2023–24 and 2021–22
  files, and the U.S. Department of Education says its 2021–22 collection covered virtually
  every public school ([collection overview](https://www.ed.gov/laws-and-policy/civil-rights-laws/civil-rights-data-collection-crdc/civil-rights-data/civil-rights-data-collection-crdc-2021-22-school-year)).
  In the CRDC first-party page context, `SurveyYearsList` mapped keys 12 and 11 to 2023–24
  and 2021–22. `SchoolSearch` returned Albertville High School, NCES ID `010000500871`,
  for both vintages, with CRDC school ID `273110`; `EntityMeasures` returned HTTP 200 JSON.
  Those API responses lacked `Access-Control-Allow-Origin`. From the live local app origin,
  `SurveyYearsList`, `SchoolSearch`, `GetSchoolProfile`, `EntityMeasures`, and
  `GetEnrollmentData` fetches failed with `TypeError: Failed to fetch`; `HEAD` to the official
  2023–24 and 2021–22 ZIP files failed the same way. Repeating the five 2023–24 API calls
  and both ZIP `HEAD` requests from the published CivicScope page (`https://civicscope.pages.dev`,
  HTTP 200) produced the same fetch failures. The 2023–24 ZIP was 99,570,187 bytes.
  This verifies nationwide school-ID-addressable civil-rights/opportunity context, not a
  cross-origin product endpoint or a replacement for the implemented ACGR lane. No CRDC
  implementation or bundled data was added.
- The four targeted Census-key national-sweep, household, published-figure/MOE, and
  ordering/Similarity browser cases passed on 2026-10-20 using the saved local key path;
  see the verification record below. This does not claim that the complete E2E suite or
  every Census-dependent path passed.
- HUD and FCC source lanes remain **open** for the account/session and direct browser-path
  blockers recorded above. EPA Rank 3 is complete for its six-field scope; the broader SLD
  catalog is explicitly outside that outcome.
- Every other roadmap status remains controlled by docs/jev-roadmap.md and its evidence.
- The verification record below is the single detailed source for Census-key browser
  scope and results.

**Verification record (2026-10-20):** after narrowing the loader change,
`npm run verify` passed TypeScript, all 30 test files (363 tests), and the production build.
`node tools/emoji-scan.mjs .` reported 0 emoji in
130 scanned files; `node tools/mojibake-scan.mjs .` reported 0 findings in 147 scanned
files. `git diff --check` passed. The focused
`npx vitest run src/core/census-key-loader.test.ts` also passed all five policy tests,
including exact equality with the synthetic parsed key, rejection of an ACL-shaped fixture that grants access to another SID, and
rejection when the ACL check observes a different file identity. A disposable on-disk
unsafe-ACL probe was declined by the local command policy, so this record does not claim
that a real Windows file with a broad ACL was loaded and rejected. The real saved-key smoke
path passed without printing the key. The targeted runner built the production app, then ran only these
four browser cases: “loads a national set of ZIP codes
in one request,” “shows household counts that differ between ZIP codes,” “renders real
published figures with their margin of error,” and “keeps ZIP order by default, sorts
locally, and renders Similarity matches without metric values.” All four passed exactly
once; zero failed and zero skipped; the runner exited 0. The temporary preview process and
its log directory were removed. The key value was not printed, placed in command arguments,
or copied to another file. Auxiliary all-data audit, MOE probe, and live Vitest paths were
not run and retain explicit environment-key handling. This record does not claim a
full-suite E2E pass or close the separate school-breadth, HUD, or FCC items.

**Historical verification record (2026-10-16):** `npm run verify` passed: 24 test files, 333 tests,
and production build. `node tools/emoji-scan.mjs .` reported 0 emoji in 117 scanned files;
`node tools/mojibake-scan.mjs .` reported 0 findings in 134 scanned files. Against the
local preview, app shell, city search, guided-tour, and axe accessibility E2E files passed.
The complete live E2E run was stopped after three minutes before URL-state/live-geocoding
files completed; no failure was observed before stopping. Census-key national-sweep,
comparison, and similarity browser assertions were skipped because no Census key was
configured. The NYC source-terms research is complete and documented; no roadmap status is
changed by this backlog.

**Historical verification snapshot (2026-10-16, before the EPA Rank 3 update):** `npm run verify` passed: TypeScript build, 25 test
files, 338 tests, and production build. `node tools/emoji-scan.mjs .` found 0 emoji in
119 scanned files; `node tools/mojibake-scan.mjs .` found 0 findings in 136 scanned files.
In the running local browser preview, ZIP `94103` produced the EPA NWI card, and expanding
its source detail showed value `14.5`, block group `060750178022`, vintage, citation, and
point-geography limitations. Census-key sweep, comparison, and similarity checks remain
unrun because no user key is available. At this snapshot only the NYC terms item was
closed; the subsequent EPA Rank 3 update below records its later closure.

**EPA Rank 3 verification update (2026-10-16):** `npm run verify` passed TypeScript,
all 25 test files / 339 tests, and the production build. `node tools/emoji-scan.mjs .`
reported 0 emoji in 119 scanned files; `node tools/mojibake-scan.mjs .` reported 0 findings
in 136 scanned files. The focused EPA suite covers its one-request field list, six parsed
measures, metric formatting and individual source vintages, missing and ambiguous results,
EPA sentinels, malformed values, and the context-only boundary. In the live browser preview,
ZIP `94103` issued one successful HTTP 200 request to EPA's SLD v3 layer 1 query service and
showed all six measures for block group `060750178022`; expanded details showed the field
ID, release vintage, field-specific input years, point geography, and caveats. A fresh
lookup of `10001` also issued the direct six-field query and returned HTTP 200. The six
measures remain context-only, absent from sorting, similarity, and composites; matching
values are available in the existing same-source comparison matrix. No key, Worker, or
bundled EPA data was added. This closes Rank 3's scoped outcome only; Census-key
verification, broader nationwide school outcomes, HUD, and FCC retain their recorded
limits. CIVICSCOPE-R2-SCHOOLS is now marked partially addressed in the roadmap.
