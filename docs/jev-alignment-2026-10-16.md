# CivicScope — Jev Alignment Pass (prioritized work plan)

Kind of review: in-session Jev-style alignment of use cases, data sources, and functions.

Sources read in order: [docs/use-case-data-map.md](docs/use-case-data-map.md), [docs/data-sources-research.md](docs/data-sources-research.md), [docs/jev-roadmap.md](docs/jev-roadmap.md), [README.md](README.md), [GOVERNANCE.md](GOVERNANCE.md), [AGENTS.md](AGENTS.md).

Status: **planning, not a completion-gate row.** This is the answer to the user's
"flush out all use cases, align with Jev, map to functions, get a prioritized plan in
canonical planning." It does not close anything in `docs/jev-roadmap.md` by itself.

---

## Part 1 — Use-case completeness audit

### UC-A — short-list apartment/condo shopper
- **Does the build satisfy the job?** Not yet. The search path, ACS cards, composite,
  affordability, and comparison table exist, but the real job is "compare a few places and
  understand why they differ," and the product can still read like a wall of figures with
  explanation bolted on.
- **Smallest thing that would make it real:** a comparison view that explains the difference
  between the selected places, not only lists numbers; figure blurbs that are actually read;
  and one or two honest context layers that answer the housing-cost/rent-benchmark question
  a shopper is really asking.
- **Overstated?** No, but the use-case note is too soft on the real blocker, which is
  explanation and trust, not missing figure cards.

### UC-B — buyer using "similar areas" from one ZIP
- **Does the build satisfy the job?** Partially. Similarity exists, but a buyer wants to know
  why places were offered and whether the match is about the things they care about. The
  current UI can feel like a black box with sliders.
- **Smallest thing:** plain-language similarity levers, the origin's own figures shown beside
  the match, and default weights that are explainable without asking the user to read
  implementation notes.
- **Overstated?** Slightly. The note understates that explainability is the real gap, not the
  existence of similarity.

### UC-C — week-over-week renter
- **Does the build satisfy the job?** Mostly, modulo lifecycle rigor. Saved searches,
  persistence, and export are the real job, and those exist.
- **Smallest thing:** export that matches what is shown, saved-search lifecycle that behaves
  obviously, and cross-session state that behaves like the user expects.
- **Overstated?** No.

### UC-D — curious local
- **Does the build satisfy the job?** Partially. Guided tour, state filter, geography plugin,
  and key prompt exist, but a curious local is the user most likely to misread the site if
  place labels, framing, or geocoding hygiene are off.
- **Smallest thing:** correct and consistent place labeling, clean geocoding discipline, and
  framing that says plainly what ACS estimates are and are not.
- **Overstated?** No. This is one of the cases where small correctness gaps become big trust
  gaps.

### UC-E — power-user analyst
- **Does the build satisfy the job?** Fairly well, modulo filter semantics and round-tripping.
- **Smallest thing:** filters that behave obviously, export that matches the visible set, and
  URL state that round-trips comparison selections.
- **Overstated?** No.

### UC-F — keyless first-timer
- **Does the build satisfy the job?** Partially. The key prompt and keyless path exist, but the
  real job is honest onboarding: what can I see without a key, what can I not, and is it worth
  pasting one?
- **Smallest thing:** a prompt and keyless experience that are honest about coverage and useful
  enough that the user is not just deciding whether to leave.
- **Overstated?** No.

### UC-G — journalist / planner / advocacy reader
- **Does the build satisfy the job?** Partially. Methodology, attribution, and the fair housing
  notice exist, but this is the reader most likely to evaluate whether the tool is suitable for
  citation or policy discussion.
- **Smallest thing:** methodology that actually answers "where did this number come from,"
  complete attribution, and a defensible "what we do not have" list.
- **Overstated?** No.

### Overall use-case verdict
All seven use cases are real. None is fully satisfied on its own terms. The ones worth spending
attention on first are UC-A, UC-D, and UC-F, because those are where trust is made or lost
fastest. UC-B is the one most likely to become a differentiator if it is made explainable.
UC-C and UC-E are mostly correctness and finish, not new sources. UC-G is mostly honesty and
documentation.

The most important correction in this pass: the existing notes imply the biggest gap is "missing
data sources." It is not. The biggest gap is that the tool already fetches and renders a lot, but
still does not always help a human understand what they are looking at. That is a product and
explanation gap, not a coverage gap.

---

## Part 2 — Data-source triage

### The smallest credible set that would actually strengthen the top use cases
If the goal is to strengthen UC-A, UC-B, UC-D, and UC-F together, the smallest credible set is
not "add every interesting federal dataset." It is:

1. **EPA Smart Location Database, selectively.**
   - Use a small number of named underlying measures rather than a single "walkability" badge.
   - Geography is block group, mapped to ZCTA context.
   - Vintage is 2021 release, 2019 block groups. Say so.
   - Reuse and provenance: EPA describes SLD v3 as publicly available and its web services as
     available for public web mapping. The [Data.gov SLD record](https://catalog.data.gov/dataset/smart-location-database)
     lists CC0 1.0, but its catalog last-updated field is 2013, before EPA's 2021 v3 release.
     Keep the EPA citation as provenance; do not infer a separate legal conclusion from stale
     catalog metadata. See the canonical [source research](data-sources-research.md).
   - Why: answers "what is this place physically like" without pretending to be a steering
     verdict.

2. **HUD Fair Market Rents and Small Area FMRs, where they cover the area.**
   - Geography: FMR is metro/county; SAFMR is ZIP-level within metros.
   - Access: HUD User API requires an account and Bearer token; published limit is 60
     queries/minute. SAFMR ZIP rows are available by API in applicable metros, not only by file.
   - Current data: FY 2026 and FY 2027 FMRs both appear on HUD's FMR page; FY 2026 income limits
     are current. Do not claim a single universal "current year" without saying which dataset.
   - License posture: HUD User API requires attribution — "This product uses the HUD User Data API
     but is not endorsed or certified by HUD User." Do not modify or misrepresent HUD content as
     HUD content.
   - Why: this is the one enrichment that most directly answers a real short-list question: "how
     does local rent benchmark here compare to the ACS median I am looking at."

3. **FCC Broadband Data Collection, as reported availability.**
   - Geography: location/BSL-based for fixed; modeled coverage for mobile; summaries by state,
     county, CBSA, place, Tribal area, and so on.
   - Posture: public availability data, but the FCC says the map shows availability, not
     performance, affordability, or adoption.
   - Why: broadband is now a real housing-decision fact for many people, and ACS already has a
     households-without-broadband variable, so the tool should be able to talk about connectivity
     coherently rather than leaving it as a silent gap.

That is the smallest credible set: three sources, three context lanes, all explainable and none
a ranking input.

### The sources that should stay out for now
- **HUD Location Affordability Index.** Modeled, profile-dependent, built from 2012–2016 ACS in
  v3. Too dated and too easy to misread as a live cost estimate. Leave out unless there is a
  specific framed-benchmark use with a very clear vintage warning.
- **EPA Access to Jobs and Workers Via Transit.** Still exists, but the downloadable vintage is
  from 2014 based on 2012/2013 transit inputs. Too old to present as a current transit-access fact
  without heavy framing, and coverage is incomplete. Leave out or treat only as a clearly dated
  historical access reference.
- **CEJST and EJScreen as live federal screening tools.** Neither is currently a live federal tool.
  EJScreen was removed from EPA's site on 2025-02-05. The federal CEJST was unavailable on the
  White House site as of 2025-01-22; the latest release referenced is CEJST 2.0, December 2024.
  Archives and reconstructions exist, but they are not the live federal tools. If used at all, they
  are archived context with prominent version and vintage, not current screening products.
- **CDC/ATSDR SVI and CDC PLACES health measures inside any scoring or recommendation path.** Both
  are useful context, but both carry high misuse risk if a user reads them as neighborhood quality.
  SVI is for identifying communities that may need support in emergencies. PLACES health measures
  are model-based small-area estimates. Both belong in a context lane, if anywhere, not in
  similarity or composite.
- **FEMA National Risk Index inside any "is this place good" path.** Useful hazard context at
  county and tract, current release December 2025 v1.20, with an ArcGIS tract service and downloads.
  But the reuse terms require citation, version, retrieval date, and a non-endorsement statement,
  and prohibit using the data to decide an individual's rights or benefits. That is exactly the kind
  of layer that should be area context only.

### The one or two sources most likely to be misused without discipline
1. **EPA National Walkability Index as a single "walkability" badge.** It is a relative ranking of
   block groups, not a sidewalk or safety inspection. If you add the composite rank as one number,
   users will read it as a verdict. If you add a few underlying measures and label them, it can be
   informative.
2. **HUD FMR/SAFMR as "market rent."** FMR is a program benchmark, not asking rent, and SAFMR is
   not universal ZIP-level market data. If you present it without that framing, a renter or buyer can
   misread it in exactly the way that creates false confidence.

### Do I disagree with the current tiering?
Only on emphasis. The research notes are good. The main disagreement is that they still lean toward
"a lot of sources is the answer." For CivicScope's actual posture, the answer is "a few explainable
context layers and a lot of discipline." That reframes the research note's Tier A slightly: not every
Tier A source should be added, and some Tier A sources are only worth adding if they can live in a
honest context lane.

---

## Part 3 — Function coherence

### Where each recommended source should live
- **EPA SLD selected measures** → context-only lane on the area read, with a small set of explainable
  component measures. Not in the composite. Not in similarity unless a buyer/renter trait is clearly
  defensible, and even then only with a context label.
- **HUD FMR / SAFMR** → rent-benchmark context lane, separate from ACS rent. If a comparison view
  ever shows it, it must compare FMR to ACS rent explicitly as "benchmark vs. estimate," not as "two
  rents."
- **FCC BDC availability** → connectivity context lane. ACS already has
  households-without-broadband, so this should be reconciled with that figure rather than presented as
  a disconnected second opinion.

### What existing functions would need to change to receive them cohesively
- **The figure-card / context-lane architecture.** CivicScope already has a notion of figures and
  derived figures. A context lane needs a first-class home so a layer can be "informative but not a
  score input." The cleanest path is a separate rendering and explanation path for context layers, not
  sneaking them into the same card stream as ACS estimates.
- **The composite rules.** Nothing from the recommended enrichment set should enter either composite
  index without an explicit documented decision and the existing fair-housing review gate. The project's
  own governance already says adding a metric to either index requires review. That rule should be treated
  as load-bearing, not paperwork.
- **The similarity metric set.** Similarity is the most plausible place for a trait like walkability or
  commute access to show up later, but only if the trait is explainable and the default weights are
  defensible. If the trait cannot be explained in plain language, it does not belong there yet.
- **The export column list.** If a context layer is visible to the user, the export should be able to
  include it or explicitly exclude it with a reason. An export that silently omits a visible layer is the
  kind of small inconsistency that erodes trust for UC-C and UC-E.
- **The methodology page.** Every added layer needs geography, vintage, provenance, and a framing note.
  If the methodology page cannot say that, the layer is not ready.
- **The key prompt and credential discipline.** HUD FMR/SAFMR is token-gated, so it cannot be added as
  if it were keyless. It either goes through the existing key discipline or it does not ship as a default
  path. That is an architectural decision, not a plugin detail.

### What cannot live cohesively yet
- Any source that wants to be a ranking input without a defensible plain-language trait.
- Any source whose vintage or coverage would have to be hidden to feel "current."
- Any source that would need a server Worker, new secret storage, or a large build-time spatial pipeline
  before it can be shown honestly.

---

## Part 4 — Honesty audit

### The biggest remaining "looks stronger than it is" risk
The site can already fetch a lot of numbers and render them in a polished map and table. The risk is
that a user reads "more figures" as "more understanding." The largest remaining gap is explanation: a
user can see a number and still not know what it is, what it is not, or why one area differs from another.

### The biggest remaining "looks useful but is hard to use correctly" risk
Similarity is the most likely candidate. It already exists. If it is left as a black box with sliders,
it can look like an authoritative "similar places" engine when it is really a user-configured distance
computation over a chosen set of traits. The risk is not that similarity exists; it is that it is easier
to misuse than to understand.

A close second is any future rent-benchmark layer. If HUD FMR/SAFMR is presented without explicit
"benchmark vs. estimate" framing, users can treat a program benchmark as a market fact.

### Any roadmap or audit claim ahead of evidence
Do not promote enrichment to "complete" in the roadmap until the layer actually exists in the product,
is explained in the methodology, and is checked by the existing gate. The current roadmap already has the
right posture here: rows are edited only after the evidence exists, and the completion gate takes its status
from code and measurement, not from planning prose. This plan should inherit that discipline.

One honesty note that belongs in canonical planning: the `docs/jev-roadmap.md` note about JEV-COMPLETION
scoring 0 is accurate and should stay honest. The repo cannot be scored by a Harness contract that belongs
to a different project. The honest substitute is the repo's own gate: `npm run gate`, and the deterministic
layer under it.

---

## Part 5 — Prioritized work plan

Ranked by real user value and trust, not by how interesting the data source is.

### 1. Fix the trust gap that matters most first
- **Goal:** make sure the ACS household figure the user sees is the household figure the user means.
- **What changes:** the README variable table already reflects the correction to `B25002_002E` for
  households, with `B25001` noted as total housing units including vacant. Confirm whether the app's
  variable mapping, labels, and any derived figures that depend on households already match that
  correction; if not, that is the actual bug, not the README.
- **Success looks like:** a user comparing areas does not leave with an occupancy or household count that
  is silently the wrong concept.
- **Type:** code + docs.
- **Dependency:** none. First because it can silently make the whole site less trustworthy.

### 2. Make the existing site explain itself before adding more data
- **Goal:** make UC-A and UC-D feel trustworthy with the data already present.
- **What changes:**
  - figure blurbs that say what each number is and is not
  - a comparison view that explains why two areas differ, not only what they are
  - similarity explainability: plain-language levers, origin figures beside matches, defensible default
    weights
  - guided tour and key prompt that are honest about coverage
- **Success looks like:** a short-list shopper and a curious local can understand the readout without
  outside help.
- **Type:** mostly UI copy and small UX changes; some may need tests if they affect behavior.
- **Dependency:** item 1 is more important, but this can proceed in parallel once the household-concept
  question is settled.

### 3. Add one honest context lane, not many
- **Goal:** give UC-A, UC-B, and UC-D one genuinely useful extra lens that does not pretend to be a ranking.
- **What changes:** add a small, explainable context lane. The strongest starting candidate is a few named
  EPA Smart Location Database measures, with the 2021 / 2019-block-group vintage stated plainly and the
  measures described individually rather than as a single walkability verdict.
- **Success looks like:** a user can see "this is what the built environment here looks like" without the
  tool sounding like it is grading neighborhoods.
- **Type:** research + build + methodology + gate check.
- **Dependency:** item 2, because a context lane that arrives before the site can explain itself will be
  read as more authoritative than it is.

### 4. Add a rent-benchmark context lane only if it can be framed honestly
- **Goal:** let UC-A and UC-F compare ACS rent to a local program benchmark without confusing the two.
- **What changes:** HUD FMR/SAFMR behind the existing credential discipline, presented as a labeled
  benchmark lane, with SAFMR coverage limits and the FY year stated, and with explicit wording that FMR is
  not asking rent.
- **Success looks like:** a renter can see both the ACS estimate and the HUD benchmark and know which is
  which.
- **Type:** research + architecture decision + build + methodology + gate check.
- **Dependency:** item 3's context-lane pattern, because this should reuse the same context-lane discipline
  rather than inventing a special case.

### 5. Finish the small correctness and lifecycle gaps that power users feel
- **Goal:** make UC-C and UC-E trust the tool on repeat use.
- **What changes:** export columns match what is shown, saved-search lifecycle is obvious, URL state
  round-trips comparison selections, and filter semantics are readable.
- **Success looks like:** a returning user does not lose their shortlist, export, or filter state in ways
  that feel broken.
- **Type:** mostly code, some tests.
- **Dependency:** independent of the data-source work, but lower priority than trust repair.

### 6. Add connectivity context only as a coherent lane, not a dangling fact
- **Goal:** let a user see broadband context without pretending ACS and FCC say the same thing.
- **What changes:** FCC BDC availability shown as connectivity context, reconciled with the ACS
  households-without-broadband figure already present, with the as-of date and the "availability is not
  performance or adopted service" caveat.
- **Success looks like:** a user can talk about connectivity sensibly rather than seeing two unrelated
  numbers.
- **Type:** research + build + methodology.
- **Dependency:** item 3, because it should reuse the same context-lane discipline.

### 7. Hold the high-risk layers out of scoring until there is a real reason
- **Goal:** avoid turning CivicScope into a steering-prone "best neighborhood" tool by accident.
- **What changes:** keep SVI, PLACES health measures, FEMA NRI, CEJST/EJScreen archives, and any
  walkability composite out of composite and similarity unless a specific use case earns them with a clear
  context-only lane and a fair-housing review.
- **Success looks like:** the tool gets more useful without becoming easier to misuse.
- **Type:** governance + docs + review discipline.
- **Dependency:** this is a constraint on every other item, not a separate feature.

---

## What this plan deliberately does not say
- It does not claim CivicScope is incomplete because it lacks a long list of federal datasets. It is not.
  The current dataset list is already strong for the core job.
- It does not recommend adding CDC SVI, CDC PLACES health measures, FEMA NRI, or archived CEJST/EJScreen
  into scoring or similarity. It recommends treating them, if ever added, as context only, with the reuse
  terms and caveats intact.
- It does not pretend HUD LAI or EPA Access to Jobs Via Transit are current. It says they are either dated
  or coverage-limited and should not be presented as live facts without heavy framing.
- It does not assert there is any external critique of the CivicScope housing tool that should drive the
  plan. The accessible CivicScope site by that name is a different product, and the honest conclusion is
  that the plan should be judged against this repo, not against a phantom review.

---

## How to trace this into canonical planning
- If an item is done and measured, it can become a roadmap row or an audit update.
- If an item is still a hypothesis, it stays in this plan as a hypothesis.
- If an item changes the fair housing posture, it goes through the governance review rule before it is
  treated as done: adding a metric to either composite index, introducing a default ranking or "best match,"
  changing suppression thresholds, adding advertising or paid placement, or changing the license.
- The completion gate's status comes from code and evidence. This document is planning, not evidence.

---

## Live scoring note for this pass
This is not a completion-gate score. It is a judgment pass done in session.

What is strong, with evidence:
- sweep, cache, data integrity, map, rate limits, self-heal, accessibility posture, and a
  fair-housing-aware design enforced in code.

What is not yet strong enough for the real jobs:
- explanation and trust for UC-A and UC-D,
- similarity explainability for UC-B,
- honest keyless onboarding for UC-F,
- methodology completeness and attribution rigor for UC-G,
- and a coherent context-lane architecture for any future enrichment.

The original planning posture was that the engine is ahead of the experience. A narrow six-field EPA
context lane has since landed with field-level vintage and geography caveats. The next move should follow
the still-open canonical backlog and measured user needs; this does not authorize a broader SLD catalog or
another data lane by itself.

---

End of plan.

## Execution reconciliation — 2026-10-16

The user asked to pick up the plans, audit them against the repo, and execute the
canonical work. The current status and evidence owners are now maintained in
[docs/canon-work-mission.md](canon-work-mission.md); this original plan remains the
reasoning and priority record.

- **Rank 1, household trust:** the primary ACS variable was correct, but the methodology
  table lookup still named B25001. Both now point to B25002, occupied housing units;
  an explicit registry assertion protects the distinction.
- **Rank 2, explainability:** the national screen now starts in ZIP order; one-figure
  sorts are explicit; selected areas share a comparison matrix only when source/table/
  vintage match; similarity remains optional and alphabetized, with labeled origin and
  match figures and its equal starting weights/cutoff disclosed.
- **Rank 3, EPA SLD:** complete for the six-field direct-browser, point-context outcome
  recorded in [the canonical backlog](canon-work-mission.md). The no-bundled-data boundary
  remains in force; the broader SLD catalog is outside that outcome. **Ranks 4 and 6, HUD/FCC,**
  remain open with the access and geography blockers recorded in the canonical backlog.
- **Rank 5, power-user correctness:** existing export, saved-search, filter, and URL-state
  paths have dedicated tests. Reopen only on a failing check or reproduced defect.
- **Rank 7, protected-proxy boundaries:** remains an ongoing constraint enforced by
  metric allowlists, scoring checks, and plugin metadata.
- **School-source correction:** the named-school source is NYC DOE, not a statewide New
  York data feed. NCES EDGE reports district staffing/enrollment, not funding or
  per-pupil spending. The 0/55 source search keeps CIVICSCOPE-R2-SCHOOLS open; it does
  not prove that no future source can qualify.
- **NYC source terms:** the portal-wide policy permits use without use restrictions or
  licensing requirements; the specific dataset metadata still has no named license
  identifier. Keep NYC/DOE attribution and the 2018–19 vintage, and do not claim a named
  dataset license. The source research records the policy and freshness evidence.

**Earlier verification (before the EPA follow-up):** `npm run verify` passed with 333 tests
and a production build; both required scans reported zero findings. The app shell,
city-search, tour, and axe browser checks passed against the local preview. The full live
browser run did not finish within three minutes, and national-sweep assertions were skipped
without a Census key. The later 339-test verification, updated scans, and EPA live-path
proof are recorded in the canonical backlog. No roadmap phase status was changed.

## Canonical planning reconciliation — 2026-10-20

### TypeSafe/Jev review

I read the Typesafe AI skill and its live documentation index/API contract, then sent the
planning set (`docs/original-request.txt`, the canonical backlog, roadmap, this alignment
record, use-case map, data-source research, fair-housing decisions, worldwide-data plan,
`GOVERNANCE.md`, and `README.md`) to `jev-latest` with the current repository evidence.
The API resolved the alias to `jev-1.13.0`. The local key was read in memory from the
existing user-level Jev configuration and was never printed or added to repository data.
This was a typed judgment request: Jev supplied probabilities and a 0–3 Score, not a prose
audit or authority to change roadmap status.

For the first request, the Noul probabilities refer to the named condition being true:

| Judgment | Probability | Interpretation |
|---|---:|---|
| Stale open/unrun claims | 0.67 | Current evidence contradicts at least one scoped open claim. |
| A required action is missing | 0.75 | The canonical set may omit a material actionable item. |
| Unsupported completion claim | 0.46 | Jev did not strongly resolve whether any completion is overbroad. |
| NYC terms map is stale | 0.81 | The use-case map should distinguish portal policy from the blank dataset license field. |
| School phase should remain partial | 0.97 | Broader school outcomes are not covered by the implemented lane. |
| HUD/FCC immediately actionable | 0.04 | The documented credentials, access, geography, and terms prerequisites remain blockers. |
| Worldwide expansion or legal review is active work | 0.10 | Keep expansion deferred and legal-review status disclosed unless an owner initiates it. |
| A power-user lifecycle gap is demonstrated | 0.06 | No current defect is evidenced in the tested export/search/filter/URL paths. |

Jev's register-completeness Score was **1.25/3**, with confidence 0 and probabilities
0.38/0.18/0.26/0.18 across Score levels 0–3. Treat this as a low-confidence warning
about the pre-edit document snapshot, not a measured quality score. A follow-up Choice
judgment selected `broader_e2e_scope` with confidence 0.81 (probability 0.84) as the most
material remaining record to preserve; see the [canonical verification record](canon-work-mission.md#L303)
for the evidence and scoped follow-ups.

### Evidence-led reconciliation

The repository evidence, not the model output, determines the status updates in
[the canonical backlog](canon-work-mission.md):

- Census-key scope, verification outcomes, and remaining follow-ups are in the
  [canonical backlog](canon-work-mission.md#L303); this alignment record preserves Jev's
  planning cross-check without duplicating those details.
- The use-case map's NYC terms line was stale: source research already established that
  NYC Open Data's portal-wide policy permits application use, while this dataset's
  metadata has no named license identifier. The map now preserves both facts and the
  attribution/vintage requirement.
- `CIVICSCOPE-R2-SCHOOLS` stays partially addressed. The current nearby-school lane is
  2019 public-school ACGR with limits on type, geography, vintage, and reportable records;
  the research-only alternatives lack a verified browser delivery path. No roadmap phase
  was closed by this pass.
- HUD/FCC remain gated by the documented external prerequisites. Worldwide expansion
  remains a maintainer decision. No attorney review is claimed. Power-user work stays
  closed absent a reproducible failure.

The response used **43,903 input tokens and 182 output tokens** for the full planning-set
review; the focused follow-up used 890 input and 94 output tokens. Because Jev's output is
typed and its confidence on the overall Score was zero, the repository sources and direct
test results remain the completion evidence.
