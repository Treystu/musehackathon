/**
 * ANSWER LAYER — the typed staged flow behind an Ask answer
 * (owner directive, 2026-11-02: "a question must pull up a composed
 * ANSWER, not just a table").
 *
 * Pipeline, in order; each stage is a pure function except research,
 * which calls the provider the caller injects:
 *
 *   parse    — the existing intent route's output (ValidatedIntent),
 *              re-gated here by the validator's intentGate so a
 *              proxy/school/health filter can never reach the screen
 *              even if a caller skips the route's own checks.
 *   screen   — deterministic, over rows the caller already loaded
 *              (AreaRow[], the sweep's shape). Narrows to the places
 *              whose KNOWN Census values meet the intent's filters,
 *              inside the intent's geography. No model is involved.
 *   research — the existing Responses-API research logic
 *              (MuseProvider.research, citation-gated in the
 *              provider), run over ONLY the screened subset, against
 *              the criteria Census cannot serve (schools, amenities,
 *              character). Skipped when the caller supplies no
 *              research query or the screen is empty.
 *   compose  — builds the ComposedAnswer below. A researched claim
 *              with no citation is dropped here, by construction,
 *              and the drop is recorded on the answer.
 *   verify   — fail-closed stage gate. Every figure on the answer
 *              must equal its screened row's value and margin exactly;
 *              every surviving claim must cite a source carried on
 *              the answer; the composed summary and claim texts must
 *              pass the validator (numeral provenance + the rescoped
 *              banned-construction scan, criteria-grounded context).
 *              Any failure withholds the whole answer: a partly
 *              verified answer is not an answer.
 *
 * THE TYPE CONTRACT (what the UI consumes; UI work is a later stage):
 *
 *   ComposedAnswer {
 *     status: 'verified' | 'withheld' | 'blocked' | 'empty' | 'flexible'
 *       verified — passed verify; safe to render as an answer.
 *       withheld — composed but failed verify; `failures` names why.
 *       blocked  — parse gate refused the intent; `failures` names why.
 *       empty    — the screen found no place meeting the criteria.
 *       flexible — the research-mismatch terminal (noCensusMatch),
 *         completed by the UI runner's flexible lane under the
 *         evidence-class validator (core/ai/flexible.ts); the
 *         completion rides on `flexible`, never on `places`.
 *     stage: the last stage reached ('parse' | 'screen' | 'research'
 *            | 'compose' | 'verify').
 *     criteria: the Census criteria the screen applied, verbatim from
 *       the intent (ScreenCriterion[]), plus `droppedCriteria` for
 *       intent filters the screening surface cannot express.
 *     places: AnswerPlace[] — the specific places that meet the
 *       Census criteria. Each carries its deciding figures:
 *         figures: { key, value, marginOfError?, distanceToBound? }[]
 *       value/marginOfError are copied from the screened row, never
 *       computed; distanceToBound is code-computed headroom against
 *       the stated bound (value - bound for a minimum, bound - value
 *       for a maximum), so it is positive exactly when the bound is
 *       met. Researched claims attributed to the place (its name or
 *       ZIP appears in the claim text) ride on the place; claims
 *       attributed to no screened place ride on `generalClaims`.
 *     sources: every source the surviving claims cite.
 *     summary: one deterministic, numeral-free sentence naming the
 *       outcome (numeral-free so the figure validator judges it
 *       against the answer's figures without a ZIP or count ever
 *       reading as an invented numeral — figures live in `figures`,
 *       structured, not in prose).
 *     droppedClaims: claims compose dropped (uncited), kept as a
 *       count + texts so the drop is auditable, never silent.
 *     failures: verify/parse failure details, when withheld/blocked.
 *   }
 *
 * CRITERIA THE INTENT SCHEMA CAN AND CANNOT EXPRESS (measured against
 * intent-schema.ts, not assumed): thresholds arrive ONLY as
 * intent.filters[] entries { metricKey, op: 'gt'|'lt'|'eq_range',
 * value } over FILTER_LEGAL_KEYS, and the screening surface (the same
 * conversion App.executeIntent applies) expresses exactly: a maximum
 * (op 'lt' or 'eq_range') for median_gross_rent,
 * median_rent_burden_pct, median_home_value and
 * median_household_income, and a minimum (op 'gt') for households.
 * Everything else the schema admits is reported, not invented:
 *   - op 'gt' on a non-households key, and op 'lt'/'eq_range' on
 *     households: droppedCriteria, reason 'bound_not_expressible'.
 *   - intent.metricKeys with no filter: a measure to SHOW, not a
 *     bound; it narrows nothing (the national screen's posture).
 *   - There is NO range pair: 'eq_range' carries ONE value, which the
 *     surface reads as a maximum. A question stating a two-sided
 *     range ("rent between 1000 and 1500") can only be expressed if
 *     the parse emits two filters on the key, and the schema's
 *     validateIntent does not forbid that — screenScreenCriteria
 *     would apply both only if both are expressible, and a lower
 *     bound on rent is not, so the lower half lands in
 *     droppedCriteria rather than being silently honoured.
 *   - Geography: a 5-digit geography matches a row's ZCTA directly.
 *     Any other geography ("Hilo, HI", "HI") is resolved to ZCTAs by
 *     the CALLER (the place index owns that mapping; App resolves the
 *     same way) and passed in as `geographyZctas`. Without it, a
 *     non-ZIP geography is reported in `unresolvedGeographies` and
 *     does not narrow the screen — never guessed.
 *   - Non-Census criteria (schools, amenities, character) have NO
 *     intent field at all: they reach research only as the caller's
 *     `researchQuery` text. The intent schema cannot carry them, and
 *     this module does not invent a field for them.
 *
 * CRITERIA DECOMPOSITION (generalization, owner directive 2026-11-02:
 * arbitrary multi-criteria cross-referenced questions — "best schools
 * AND fewest fast food restaurants"). The decomposition is explicit
 * in the types below, not in the intent schema:
 *   - Census-servable criteria travel as the intent's filters /
 *     metricKeys / geographies, converted by screenCriteriaFromIntent.
 *   - Externally-researched criteria travel as ResearchCriterion[]
 *     on the pipeline input and on the answer, derived from the
 *     reader's question text by decomposeResearchCriteria (a lexical
 *     catalog over the words the reader used: schools, fast food,
 *     restaurants, coffee, groceries, safety, amenities). Each
 *     criterion gets its own research pass over the same provider
 *     seam. When the catalog matches nothing, the question's outside
 *     criteria are carried as ONE combined criterion — the parse
 *     cannot separate what it has no field for, and this module says
 *     so rather than pretending a split.
 *   - Each stated criterion ends with a CriterionEvidence entry:
 *     met (figures or cited claims shown), partially_measured (a
 *     cited source speaks qualitatively to a count-seeking criterion
 *     — "few fast-food outlets" stays qualitative and never becomes
 *     a count), or not_measurable (no available source serves it).
 *     A partially servable question therefore still answers, stating
 *     what was established and what could not be.
 *
 * BOTH NARROWING DIRECTIONS:
 *   - Screen-first: Census criteria exist — screen, then research
 *     only the surviving subset, capped at
 *     SCREENED_RESEARCH_CANDIDATE_CAP places; when the cap binds the
 *     answer discloses it (candidateCapApplied) and the card renders
 *     the disclosure as one quiet line.
 *   - Research-first: the question carries external criteria and
 *     no Census bound, plus optionally a geography bound — and,
 *     since P3b cure 1, a retained Census measure when no geography
 *     bounds the screen (the measure is pulled onto the named
 *     places, never used to re-screen them). Research runs first,
 *     candidate place names
 *     are extracted from the cited findings through the injectable
 *     candidateExtractor seam, candidates resolve deterministically
 *     (candidateResolver, or an exact row-name match), unresolvable
 *     names are reported in unresolvedCandidates and never guessed,
 *     and the screen then runs in pull mode over the candidate rows
 *     to attach their Census figures. Compose joins both sides at
 *     the geography the question asked.
 *   - Top-N: a count in the reader's words ("top five places",
 *     requestedCountFromQuery) bounds the research-first compose at
 *     the asked count and is stamped on the answer
 *     (requestedCount), so the card states the shortfall when fewer
 *     places ground than were asked for — a grounded partial answer
 *     with the gap named, never a silently shorter list (owner
 *     repro, 2026-11-02: "find the top five places that have the
 *     best schools but also the least average cost of living").
 */
import {
  aggregateRowsToCounties,
  classifyMetricKey,
  type CountyAssignment,
} from '../county-aggregate'
import { STATE_NAME_BY_CODE } from '../sweep/states'
import type { FlexibleAnswer } from './flexible'
import { METRIC_DEFS_BY_KEY } from '../civicscope-registry'
import type { AreaRow } from '../plugins/acs'
import type { IntentMode, MuseProvider, ResearchResult, ValidatedIntent } from './provider'
import {
  createValidator,
  findBannedConstruction,
  intentGate,
  type FigureForValidation,
} from './validator'
import {
  deriveBreadthPlaces,
  deriveInterimPlaces,
  estimateRemainingMs,
  type BreadthLabels,
  type BreadthPlace,
  type BreadthStanding,
  type RunProgressSnapshot,
} from './run-progress'

/* ------------------------------------------------------------------ */
/* Stage types                                                         */
/* ------------------------------------------------------------------ */

export type AnswerStage = 'parse' | 'screen' | 'research' | 'compose' | 'verify'

export type AnswerStatus = 'verified' | 'withheld' | 'blocked' | 'empty' | 'flexible'

/** One Census criterion the screen applied, derived from an intent filter. */
export interface ScreenCriterion {
  metricKey: string
  /** 'atMost' = the row's value must be <= value; 'atLeast' = >= value. */
  bound: 'atMost' | 'atLeast'
  value: number
  /** The intent op this was converted from, kept for audit. */
  intentOp: 'gt' | 'lt' | 'eq_range'
}

/** An intent filter the screening surface cannot express, reported whole. */
export interface DroppedCriterion {
  metricKey: string
  intentOp: 'gt' | 'lt' | 'eq_range'
  value: number
  reason: 'bound_not_expressible'
}

export interface AnswerFigure {
  key: string
  value: number
  marginOfError?: number
  /** Headroom against the stated bound; present only for filter keys. */
  distanceToBound?: number
  /**
   * True when the margin is the county aggregation's
   * population-weighted RMS approximation (county-aggregate.ts), not
   * a publisher margin. The card labels it as an approximation
   * wherever it is shown; a figure without this flag carries the
   * margin exactly as published or as standard sum propagation.
   */
  marginApproximate?: boolean
}

export interface ResearchedClaim {
  text: string
  /** URLs from the research result's source list. Empty = uncited. */
  sourceUrls: string[]
}

export interface AnswerPlace {
  zcta: string
  name: string
  figures: AnswerFigure[]
  claims: ResearchedClaim[]
  /**
   * County answers only: the member ZCTAs this county aggregate was
   * formed from. Present exactly when the place is a county; the
   * card shows the member count in place of a ZCTA, and `zcta`
   * carries the synthetic county key, never a real ZCTA.
   */
  memberZctas?: string[]
}

export interface AnswerSource {
  title: string
  url: string
}

/**
 * One externally-researched criterion, decomposed from the reader's
 * question text (see the header: the intent schema has no field for
 * these, so they travel beside the intent, never inside it).
 */
export interface ResearchCriterion {
  /** Catalog id ('schools', 'fast_food', ...), or 'combined'. */
  id: string
  /** Reader-facing label, from the catalog or the question's own words. */
  label: string
  /** The question text this criterion was decomposed from. */
  text: string
  /**
   * True when the criterion asks for a count or density ("fewest
   * fast food restaurants"). A qualitative cited claim can only ever
   * partially measure such a criterion — it is never upgraded to a
   * count the source did not publish.
   */
  quantitative: boolean
  /**
   * Decomposition onto an EXISTING Census metric (P3 step 3): when
   * present, this criterion is served by the named metric's figures
   * on each place — assessed on the card like any Census criterion —
   * not by web research. Decomposition tries the metric registry
   * before a criterion is ever declared external: "good internet
   * access" is no_internet_access (battery C5), and "cost of living"
   * is read on the headline cost measure, median gross rent (A2/B3).
   */
  decomposedMetricKey?: string
  /**
   * The criterion's poles, as parsed (breadth mode, 2026-11-03):
   * the characterization vocabulary a sourced claim must carry to
   * characterize a place on this criterion, and the plain-words
   * labels for the standing classes those characterizations
   * produce. Attached by decomposition (polesForCriterionText /
   * the catalog loop below) — never by a consumer — so every layer
   * reads the same poles. Absent when decomposition cannot name
   * the criterion's poles; such a criterion cannot carry a
   * breadth standing, by the honesty rule that a standing exists
   * only where the criterion as parsed names what would count.
   */
  poles?: CriterionPoles
}

/**
 * A researched criterion's poles (breadth mode): how a sourced
 * claim characterizes a place on the criterion. 'terms' mode — a
 * characterization criterion (politics, a superlative residue):
 * the claim must carry a pole term, because for this class a
 * bare mention characterizes nothing ("Fort Worth hosts a stock
 * show" says nothing about its politics). 'keywords' mode — a
 * catalog criterion: the catalog keyword test itself
 * (claimServesCriterion) is the characterization, and direction
 * comes from the FM-4 against markers. Labels are reader-facing
 * and composed here, from the criterion as parsed — the politics
 * pair names its own leaning words; every other criterion reads
 * its classes against its own label on the surface.
 */
export interface CriterionPoles {
  mode: 'terms' | 'keywords'
  positiveTerms: readonly string[]
  negativeTerms: readonly string[]
  positiveLabel: string
  negativeLabel: string
  mixedLabel: string
  /** The dimension's plain title when the poles name one ('Political leaning'). */
  title?: string
}

export type CriterionEvidenceStatus = 'met' | 'partially_measured' | 'not_measurable'

/**
 * The no-place lookup outcome's detail text (Lane A10 FM-18),
 * shared verbatim: criterionEvidenceFor stamps it on a researched
 * criterion whose material produced no shown place, and the UI
 * runner matches on it to restamp those entries when the flexible
 * completion completes the answer (Lane completion K0, 2026-11-03
 * — the wording states the outcome without presenting the Census
 * match as the reason the question went unanswered, per the
 * owner's no-loophole directive).
 */
export const NO_PLACE_LOOKUP_DETAIL =
  'Research returned material for this, but it produced no place that could be shown here.'

/**
 * Per-criterion evidence: what serves each stated criterion, honestly labelled.
 *
 * The stored `criterion` value is an identifier, not display text: a
 * Census entry carries its metric key (median_gross_rent) and a
 * researched entry carries its catalog label (School quality) —
 * measured consumers match on the stored value as a key
 * (spoken-answer.ts looks a Census criterion's verified figure up by
 * `f.key === evidence.criterion`, and answer-runner.ts matches the
 * proximity entry by its research label), so the key is never
 * rewritten here. Reader-facing seams map it through
 * criterionDisplayLabel instead: the AnswerCard evidence list and
 * the compose summary's prose below (defect F-B-ANSWER-CARD,
 * 2026-11-02: the card rendered the raw key verbatim).
 */
export interface CriterionEvidence {
  criterion: string
  kind: 'census' | 'research'
  status: CriterionEvidenceStatus
  /** One factual sentence; numeral-free so it never reads as a figure. */
  detail: string
  sourceUrls: string[]
}

/**
 * The geography level an answer is composed at.
 *
 * COUNTY FINDING (measured 2026-11-02 against the shipped data):
 * county-level answers were NOT derivable from what shipped then.
 * The place index (public/map/zcta-places.json, decoded by
 * src/core/zcta-place-index.ts) is ZCTA-level: it carries a county
 * name only as the fallback record for the 4,983 ZCTAs with no
 * incorporated place (kind 'K' in the generator,
 * tools/gen-zcta-city-mapping.mjs) — for every other ZCTA the county
 * was fetched at generation time (the Census 2020 ZCTA-to-county
 * relationship file, tab20_zcta520_county20_natl.txt) and discarded
 * in favour of the city.
 *
 * COUNTY CURE (2026-11-02, Jev-gated semantics): the crosswalk now
 * ships as a build-time artefact (public/map/zcta-counties.json,
 * decoded by src/core/zcta-county-index.ts): one county per ZCTA by
 * largest land overlap, the generator's existing rule, for all
 * 33,791 ZCTAs. When the caller supplies that crosswalk
 * (AnswerPipelineInput.countyAssignments), a county request is
 * composed at county level: the screen bounds first (a state bound
 * narrows the rows), then screened rows aggregate to their counties
 * under src/core/county-aggregate.ts — counts summed with
 * root-sum-of-squares margins, rates/means/medians as
 * population-weighted means with population-weighted
 * root-mean-square margins labelled approximations, anything else
 * reported not measurable. Without a crosswalk, 'county' remains a
 * level an answer can REQUEST and must report as unsupported
 * (unsupportedGeography + a not_measurable evidence entry), never a
 * level approximated from fallback names.
 */
export type AnswerGeographyLevel = 'zcta' | 'place' | 'state' | 'county' | 'national'

export interface ComposedAnswer {
  status: AnswerStatus
  stage: AnswerStage
  criteria: ScreenCriterion[]
  droppedCriteria: DroppedCriterion[]
  unresolvedGeographies: string[]
  screenedCount: number
  places: AnswerPlace[]
  generalClaims: ResearchedClaim[]
  sources: AnswerSource[]
  summary: string
  droppedClaims: ResearchedClaim[]
  failures: string[]
  /** The researched criteria decomposed from the question, in catalog order. */
  researchCriteria: ResearchCriterion[]
  /** One evidence entry per stated criterion (Census and researched). */
  criterionEvidence: CriterionEvidence[]
  /** The candidate cap that bounds a research pass (named constant below). */
  candidateCap: number
  /** True when the cap bound the candidate set a research pass saw. */
  candidateCapApplied: boolean
  /** Research-first candidate names that resolved to no ZCTA, dropped and counted here. */
  unresolvedCandidates: string[]
  /**
   * Research-first candidates the cited research itself describes
   * as NOT meeting the stated criteria (Lane A9 FM-4): resolved and
   * figured, but every claim serving a criterion carries a
   * direction-against marker, so they are excluded from the ranked
   * places and named here as considered-and-not-meeting. Absent on
   * screen-first answers (their places are the screen's, and
   * research decorates them; it does not un-elect them).
   */
  consideredNotMeeting?: string[]
  /**
   * Research-first candidates that RESOLVED to Census places
   * outside the geography the question asks about (Lane A10
   * FM-15): resolution is national, so a Michigan question's
   * research can name Ford, KS and resolve it exactly — the
   * binding at materialization refuses it a card and records it
   * here, so the refusal is disclosed rather than silent. Absent
   * when no bound applied or every resolved candidate was in-bound.
   * Distinct from unresolvedCandidates: these names DID match
   * Census data, in a geography the reader did not ask about.
   */
  outOfBoundCandidates?: string[]
  /**
   * Research-first candidate names that matched no Census data AND
   * carry an explicit state suffix contradicting the question's
   * state bound (Lane completion K3): "Tazewell, WA" on a
   * Virginia-bound question. They are partitioned out of
   * unresolvedCandidates at materialization so the card accounts
   * them as outside-the-asked-state names rather than printing
   * them as ordinary unmatched in-bound candidates. Absent when no
   * name contradicts, or when the bound carries no state set.
   */
  outOfStateCandidates?: string[]
  /**
   * Count of candidate-shaped tokens the extraction gate refused
   * as sentence fragments rather than names (Lane A10 FM-14):
   * capitalized prose tokens ("Initial", "January-April",
   * "BeerAdvocate") that no place name in the loaded data uses as
   * a component word. They are counted here so the card can count
   * them (FM-17) without printing them — printing them as names
   * was the sheet-A failure. Absent when none were counted.
   */
  unmatchedFragmentCount?: number
  geographyLevel: AnswerGeographyLevel
  /** A requested geography level the shipped data cannot serve ('county'), or null. */
  unsupportedGeography: string | null
  /**
   * The place count a top-N question asked for ("top five places"),
   * parsed from the reader's words by requestedCountFromQuery, or
   * null when the question named no count. The card compares it
   * against places.length and states any shortfall: a top-N ask
   * that grounds fewer places than asked must say so on the card
   * rather than letting a shorter list read as the full answer.
   * Carried as a structured field, never in the summary prose —
   * the card renders both numbers from data, the same way it
   * renders the candidate-cap overflow line.
   */
  requestedCount?: number | null
  /**
   * The county assignment + aggregation rule, stated on the answer
   * whenever a county answer was composed from the crosswalk
   * (COUNTY_AGGREGATION_METHOD), or null for non-county answers and
   * for county requests the crosswalk could not serve.
   */
  countyMethod: string | null
  /**
   * Counties dropped from a county answer because the deciding
   * figure could not be aggregated for them (county-aggregate.ts
   * reported it not measurable), named so the drop is disclosed
   * rather than silent.
   */
  notMeasurableCounties: string[]
  /**
   * Geography readings the resolution layer made and the card must
   * disclose in its own words: a region name read as the Census
   * region of that name, a region this tool does not serve at region
   * level. Carried verbatim from the caller's resolution result
   * (answer-runner.ts) so the card and the resolution can never
   * disagree about what a geography was read as — the views-layer
   * contradiction class (battery D1/C: a "could not be resolved"
   * line beside a resolved card) is what a second, divergent
   * reading produces.
   */
  geographyDisclosures: string[]
  /**
   * The state-aggregation rule, stated on the answer whenever a
   * state named as a comparison/aggregate geography was composed as
   * one state-average place (STATE_AGGREGATION_METHOD), or null.
   */
  stateMethod: string | null
  /**
   * The conversational stack's verification record (plan C5/C4),
   * stamped by the UI runner — core compose never sets it. `wonder`
   * is the bottom bookend's label: user-visible copy may claim Wonder
   * verification only for 'verified' or 'concerns'; 'not-run' (any
   * failure) shows nothing about Wonder. `jev` records whether the
   * J-LOOP evaluation ran and how many patch rounds it used; absent
   * or 'not-run' means no Jev claim is made anywhere.
   */
  verification?: {
    wonder: 'verified' | 'concerns' | 'not-run'
    wonderConcerns?: string[]
    jev: { roundsUsed: number; passed: boolean } | 'not-run'
    planObjections?: string[]
  }
  /** The one-line refinement note a landed decision's re-run carries (plan C7). */
  refinementNote?: string
  /** Per-stage timings in milliseconds, collected by the runner (plan C12). */
  timings?: Record<string, number>
  /**
   * A decision-modal proposal the runner's branch evaluation produced
   * for this answer (plan C7): the surface renders it as an overlay;
   * the pipeline never waited on it. Absent = no interjection.
   */
  decisionProposal?: {
    branch: string
    criterionId: string
    questionText: string
    options: { id: string; label: string }[]
    dismissLabel: string
  }
  /**
   * The research-mismatch marker (flexible completion lane,
   * 2026-11-02): true exactly when this answer is the research-first
   * terminal where the research stage succeeded and named places
   * for the stated criteria but no named place resolved to a Census
   * place in the loaded data — status 'empty', the summary carrying
   * the not-matched note, no card. The UI runner reads this marker
   * (never the summary text) to decide the fall-through: the
   * flexible lane completes the request from the research and the
   * model's knowledge under machine-checked evidence labels
   * (core/ai/flexible.ts). A screen-first 'empty' — the Census
   * screen itself found no matching place — never carries the
   * marker: that is a data answer, not a mismatch.
   */
  noCensusMatch?: boolean
  /**
   * The flexible completion itself, stamped by the UI runner when
   * the fall-through ran and its draft passed the extended
   * validator (core/ai/flexible.ts verifyFlexibleAnswer). Present
   * exactly when status is 'flexible'. Core compose never sets it —
   * the completion is a model answer on the runner's hourglass
   * seams, not a pipeline stage.
   */
  flexible?: FlexibleAnswer
  /**
   * Research-first only: every candidate name the extraction stage
   * pulled from the research findings, in mention order — resolved
   * and unresolved alike. unresolvedCandidates above is the subset
   * that resolved to nothing; a name can also resolve through the
   * caller's index yet contribute no place because none of its
   * ZCTAs is among the loaded rows, and such a name is still a
   * place the research named. The flexible lane's provenance check
   * reads this full set: a draft place may claim research_named
   * exactly when its name is here.
   */
  researchNamedPlaces?: string[]
  /**
   * Labels of researched criteria whose research pass failed while
   * sibling passes returned material (partial tolerance in
   * researchPerCriterion, 2026-11-02), carried from the research
   * stage's record so the run's outcome states the partial failure
   * rather than reading as a complete research result. The failed
   * criteria are accounted in criterionEvidence with the failure
   * stated. Absent when every pass returned (or no research ran).
   */
  researchFailures?: readonly string[]
  /**
   * The breadth record (breadth mode, 2026-11-03): present exactly
   * when this answer terminated a breadth run — a set-shaped
   * researched question over one state. The terminal breadth map
   * and the assessed-counts line read it; it carries the FULL
   * display set with per-place standings (assessed and unassessed
   * alike), so the map's denominator and the strip's counts are
   * the answer's own numbers, never a rendering's recount.
   */
  breadth?: BreadthAnswer
}

/**
 * A breadth run's terminal record: the display set (every distinct
 * place in the bound geography's loaded rows), each place's
 * standing derived from sourced claims, and the run's measured
 * retrieval time. Standings carry their claims so the map's click
 * detail can show the evidence behind any place's color.
 */
export interface BreadthAnswer {
  /** The bound geography's plain name ('Texas'). */
  geographyLabel: string
  /** The criterion the standings characterize (its title or label). */
  criterionLabel: string
  labels: BreadthLabels
  displayTotal: number
  assessedCount: number
  /** Measured milliseconds from the breadth phase's start to its terminal. */
  elapsedMs: number
  standings: BreadthPlace[]
}

/**
 * The county rule, stated wherever a county answer is shown or
 * described (the composed answer, the card, and Methodology copy
 * carry the same statement). Numeral-free, like the summaries, so
 * no figure on the answer can be mistaken for part of the rule.
 */
export const COUNTY_AGGREGATION_METHOD =
  'Each ZIP area is assigned to the county it overlaps most by land area. ' +
  'County counts are sums of their ZIP areas, with margins combined from the member margins. ' +
  'Other county figures are population-weighted averages of their ZIP areas, and their margins ' +
  'are population-weighted approximations, not official Census county margins.'

/**
 * The state rule, stated wherever a state-average place is shown.
 * A state named as a comparison geography (battery C6: "96720 vs the
 * Hawaii state average") is composed as ONE aggregate place over
 * every ZIP area in the state, under the same aggregation rules as a
 * county — counts summed, other figures population-weighted — never
 * as the first place whose name shares the state's name (Hawaiian
 * Acres is a place in Hawaii, not the state average). Numeral-free,
 * like the county rule, for the same reason.
 */
export const STATE_AGGREGATION_METHOD =
  'A state average here is formed from every ZIP area in the state: counts are sums of their ' +
  'ZIP areas, and other figures are population-weighted averages of their ZIP areas, with ' +
  'margins that are population-weighted approximations, not official Census state margins.'

/**
 * One state named as an aggregate/comparison geography, resolved by
 * the caller: the member ZCTAs the state place aggregates over.
 * Supplied through the pipeline input by the UI runner, which owns
 * place-index resolution; the pipeline owns the aggregation.
 */
export interface StateAggregateGeography {
  /** The geography as the intent named it, e.g. `Hawaii`. */
  geography: string
  /** Display label for the aggregate place, e.g. `Hawaii`. */
  label: string
  /** Postal code, e.g. `HI`. */
  state: string
  /** Every ZCTA the caller resolved to the state. */
  zctas: readonly string[]
}

/**
 * How many candidate places one research pass may cover. Research is
 * the metered, slow stage; the card itself shows at most this many
 * places before deferring to the screening table (AnswerCard's
 * ANSWER_CARD_PLACE_LIMIT is the same number, deliberately — a place
 * the card cannot show should not spend a research pass). When a screen
 * leaves more survivors than this, research covers the first cap-many
 * in screen order and the answer discloses the cap. This number is also the research request's places ceiling (RESEARCH_PLACES_LIMIT in meta-client.ts, which the route validates against): when the two diverged — cap 10, route 8 — every full screen's research pass was refused as a shape error and recorded as a lookup that "did not return" (measured 2026-11-02); a test pins cap <= limit.
 */
export const SCREENED_RESEARCH_CANDIDATE_CAP = 10

/**
 * How many display-set places one breadth assessment pass carries
 * (breadth mode, 2026-11-03). The batch rides the research
 * request's places roster, so this number must never exceed the
 * route's roster ceiling (RESEARCH_PLACES_LIMIT in meta-client.ts,
 * raised to 50 for these rosters in the same build): the
 * research-places-shape tests pin batch <= limit, so the two
 * cannot drift into the 2026-11-02 shape-refusal class. At 50,
 * the largest display set in the shipped index (Texas, 1,282
 * distinct places) takes 26 passes.
 */
export const BREADTH_BATCH_SIZE = 50

/**
 * How many breadth roster batches may be in flight at once
 * (breadth concurrency, 2026-11-03 — the follow-up the breadth
 * build's gate dossier named, ordered by the owner the same day:
 * "Ship as is then optimize so it doesn't take so long!").
 * Measured datum: the first live full-Texas breadth run (1,282
 * places, 27 sequential batches) took about 50 minutes of wall
 * time, ~111 s per batch — sequential order was never the
 * constraint's purpose, only snapshot ordering and breaker
 * discipline, and both survive concurrency when results APPLY
 * in roster order (see the batch loop): the pool changes when
 * calls happen, never how many (27 total, exactly one attempt
 * per batch) or what a merged prefix means. The bound is 6:
 * at the measured per-batch latency it projects a full-Texas
 * run into the ~10-minute class, and six simultaneous research
 * calls is the instantaneous load of roughly six simultaneous
 * visitors, which the deployment already carries in aggregate
 * by design. Larger bounds buy minutes against a thinner
 * margin when a failure burst meets the shared breaker (5
 * consecutive failures -> 30 s cooldown, global across
 * visitors); 4 projected ~13 minutes and missed the class.
 * Design gate: Jev proceed / destructive 0.10 / advances 0.96,
 * PROCEED under Jev gate policy v1.
 */
export const BREADTH_BATCH_CONCURRENCY = 6

/* ------------------------------------------------------------------ */
/* Stage 2: screen                                                     */
/* ------------------------------------------------------------------ */

/**
 * Convert intent filters to screen criteria using exactly the
 * conversion the Ask execution path already applies (App.tsx
 * executeIntent): a maximum for the cost/income measures, a minimum
 * for households. Unexpressible bounds are reported, never widened.
 */
export function screenCriteriaFromIntent(intent: ValidatedIntent): {
  criteria: ScreenCriterion[]
  dropped: DroppedCriterion[]
} {
  const criteria: ScreenCriterion[] = []
  const dropped: DroppedCriterion[] = []
  for (const filter of intent.filters) {
    if (filter.metricKey === 'households') {
      if (filter.op === 'gt') {
        criteria.push({
          metricKey: filter.metricKey,
          bound: 'atLeast',
          value: filter.value,
          intentOp: filter.op,
        })
      } else {
        dropped.push({ metricKey: filter.metricKey, intentOp: filter.op, value: filter.value, reason: 'bound_not_expressible' })
      }
    } else if (filter.op === 'lt' || filter.op === 'eq_range') {
      criteria.push({
        metricKey: filter.metricKey,
        bound: 'atMost',
        value: filter.value,
        intentOp: filter.op,
      })
    } else {
      dropped.push({ metricKey: filter.metricKey, intentOp: filter.op, value: filter.value, reason: 'bound_not_expressible' })
    }
  }
  return { criteria, dropped }
}

export interface ScreenResult {
  criteria: ScreenCriterion[]
  droppedCriteria: DroppedCriterion[]
  unresolvedGeographies: string[]
  /** Rows in scope before criteria were applied. */
  inScopeCount: number
  rows: AreaRow[]
}

/**
 * The deterministic screen: geography first, then criteria. A row
 * with no published value for a criterion key is excluded — an area
 * with no rent figure is not an answer to "rent under the bound"
 * (the same rule applyFigureFilters documents). A row must meet
 * EVERY criterion to survive.
 */
export function screenRows(
  intent: ValidatedIntent,
  rows: readonly AreaRow[],
  geographyZctas?: ReadonlySet<string>,
  rankDirection: RankDirection = 'ascending',
): ScreenResult {
  const { criteria, dropped } = screenCriteriaFromIntent(intent)

  const zipGeographies = new Set(
    intent.geographies.map((g) => g.trim()).filter((g) => /^\d{5}$/.test(g)),
  )
  const unresolvedGeographies = intent.geographies.filter(
    (g) => !/^\d{5}$/.test(g.trim()) && !(geographyZctas && geographyZctas.size > 0),
  )

  let inScope = [...rows]
  if (zipGeographies.size > 0 || (geographyZctas && geographyZctas.size > 0)) {
    inScope = inScope.filter(
      (row) => zipGeographies.has(row.zcta) || (geographyZctas?.has(row.zcta) ?? false),
    )
  }

  const screened = inScope.filter((row) =>
    criteria.every((c) => {
      const v = row.metrics[c.metricKey]
      if (v === null || v === undefined || !Number.isFinite(v)) return false
      return c.bound === 'atMost' ? v <= c.value : v >= c.value
    }),
  )
  // The national screen (a placeless sweep with a measure and no
  // bound — national-screen.ts) has no criterion to order by, and its
  // sort IS the request: executeIntent sorts the screening table by
  // the named measure, lowest first. The pipeline applies the same
  // order here, so the composed answer names the lowest-figure places
  // first instead of whatever order the rows happened to load in
  // (owner live failure, 2026-11-02: "What's the cheapest place to
  // live" must lead with the cheapest place by median gross rent).
  // Rows with no published figure for the measure sort last — a
  // missing figure is not the cheapest — and the ZCTA breaks ties so
  // the order is deterministic. Bounded screens keep their load
  // order; the card orders those by their first criterion.
  // The same sort serves the geography-bounded superlative
  // (generalization, 2026-11-02: "cheapest place to live in Texas"):
  // the rows reaching this point are already narrowed to the named
  // geography, and a bound-less sweep over them is the bounded
  // screen — its sort is the request, exactly as placeless. The
  // national-screen tests pinned the old placeless-only condition;
  // the bounded case was the live-ask residual item 4 closes.
  if (
    intent.mode === 'sweep_filter' &&
    criteria.length === 0 &&
    intent.metricKeys.length > 0
  ) {
    const sortKey = intent.metricKeys[0]!
    // The direction is the caller's reading of the reader's words
    // (rankDirectionFromQuery): ascending is the shipped default,
    // and a descending superlative ("oldest", "highest", "largest")
    // runs the same sort the other way. Cure round 3, 2026-11-03:
    // the ascending-only sort answered the oldest-population
    // question youngest-first on the live path, because a
    // clarification completion rebuilds the intent without the
    // question's direction and this sort was the only order left.
    screened.sort((a, b) => {
      const av = a.metrics[sortKey]
      const bv = b.metrics[sortKey]
      const aKnown = typeof av === 'number' && Number.isFinite(av)
      const bKnown = typeof bv === 'number' && Number.isFinite(bv)
      if (aKnown && bKnown) {
        return (
          (rankDirection === 'descending' ? bv - av : av - bv) || a.zcta.localeCompare(b.zcta)
        )
      }
      if (aKnown) return -1
      if (bKnown) return 1
      return a.zcta.localeCompare(b.zcta)
    })
  }
  return {
    criteria,
    droppedCriteria: dropped,
    unresolvedGeographies,
    inScopeCount: inScope.length,
    rows: screened,
  }
}

/** The deciding figures for one screened row, copied — never computed —
 * except distanceToBound, which is code arithmetic against the bound. */
export function figuresForRow(
  row: AreaRow,
  intent: ValidatedIntent,
  criteria: readonly ScreenCriterion[],
): AnswerFigure[] {
  const keys: string[] = []
  for (const key of [...intent.metricKeys, ...criteria.map((c) => c.metricKey)]) {
    if (!keys.includes(key)) keys.push(key)
  }
  const figures: AnswerFigure[] = []
  for (const key of keys) {
    const value = row.metrics[key]
    if (value === null || value === undefined || !Number.isFinite(value)) continue
    const figure: AnswerFigure = { key, value }
    const moe = row.moes[key]
    if (moe !== null && moe !== undefined && Number.isFinite(moe)) {
      figure.marginOfError = moe
    }
    const criterion = criteria.find((c) => c.metricKey === key)
    if (criterion) {
      figure.distanceToBound =
        criterion.bound === 'atMost' ? criterion.value - value : value - criterion.value
    }
    figures.push(figure)
  }
  return figures
}

/* ------------------------------------------------------------------ */
/* Criteria decomposition                                              */
/* ------------------------------------------------------------------ */

/**
 * A stated salary: a dollar figure beside a salary-context word, in
 * either order (P3b cure 3, battery A4). Shared by the decomposition
 * catalog's salary entry and AskPanel's needsResearch arm, so the
 * two layers can never drift into seeing different salaries — the
 * drift between layers is the seam family this battery keeps
 * finding. A bare income measure ("median household income") and a
 * bound on another measure ("home value under $250,000") carry no
 * salary-context word beside the figure and never match.
 */
export const SALARY_FIGURE_RE =
  /\$\s?\d[\d,]*(?:\.\d+)?\s?k?\b[^.!?]{0,30}?\b(?:salary|income|a year|per year|annually)\b|\b(?:salary|income)\b[^.!?]{0,30}?\$\s?\d/i

/**
 * The external-criterion catalog, in decomposition order. Patterns
 * match the reader's own words; `keywords` are what a cited claim
 * must mention for the criterion's evidence to count as served.
 * Fast food precedes restaurants so "fast food restaurants" is one
 * criterion, not two.
 */
export const RESEARCH_CRITERION_CATALOG: readonly {
  id: string
  label: string
  pattern: RegExp
  keywords: readonly string[]
  /** Decomposition onto an existing Census metric (see ResearchCriterion). */
  decomposedMetricKey?: string
}[] = [
  { id: 'schools', label: 'School quality', pattern: /\bschools?\b|\beducation\b/i, keywords: ['school'] },
  { id: 'fast_food', label: 'Fast food restaurants', pattern: /fast[-\s]?food/i, keywords: ['fast-food', 'fast food'] },
  // The lookbehind keeps "fast food restaurants" to the fast-food
  // criterion above: the same words are one criterion, not two.
  { id: 'restaurants', label: 'Restaurants', pattern: /(?<!fast[-\s]food\s)\brestaurants?\b/i, keywords: ['restaurant'] },
  { id: 'coffee', label: 'Coffee nearby', pattern: /\bstarbucks\b|\bcoffee shops?\b|\bcoffee\b/i, keywords: ['starbucks', 'coffee'] },
  { id: 'groceries', label: 'Groceries', pattern: /\bgrocer(?:y|ies)\b|\bsupermarkets?\b/i, keywords: ['grocer', 'supermarket'] },
  // Superlative-form tolerance (P3 step 1, battery B5): the stem
  // pattern saf\w* matches safe / safety / safest alike — the shipped
  // whole-word \bsafe\b matched none of the superlative forms.
  { id: 'safety', label: 'Safety', pattern: /\bsaf\w*\b|\bcrime\b|\bdangerous\b/i, keywords: ['saf', 'crime'] },
  { id: 'walkability', label: 'Walkability', pattern: /\bwalkable\b|\bwalkability\b/i, keywords: ['walkab'] },
  { id: 'amenities', label: 'Amenities', pattern: /\bgyms?\b|\bnightlife\b|\bplaygrounds?\b|\bhospitals?\b|\btransit\b|\bairports?\b|\blibrar(?:y|ies)\b|\bparks?\b/i, keywords: ['gym', 'nightlife', 'playground', 'hospital', 'transit', 'airport', 'librar', 'park'] },
  // Lexical trigger gap (P3 step 3, battery D2): "farmers markets"
  // matched neither the research trigger nor this catalog, so the
  // criterion was silently dropped beside a "meet all" summary.
  { id: 'farmers_markets', label: 'Farmers markets', pattern: /farmers?\s+markets?/i, keywords: ['farmers market', 'farmers'] },
  // A3's "warm": a stated criterion with no slot in any layer
  // disappeared entirely; climate is research-servable and now has one.
  { id: 'climate', label: 'Warm climate', pattern: /\bwarm\b|\bclimate\b|\bsunny\b/i, keywords: ['warm', 'climate', 'weather', 'sunny'] },
  // Nature (owner live failure, 2026-11-03: "what city in Colorado
  // has the best nature and the lowest cost of living?"): the
  // question's lead criterion had no entry here, no arm in
  // AskPanel's research trigger, and — because cost of living DID
  // match — not even the combined fallback below carried it: it
  // vanished from every layer and the answer was a whole-state rent
  // sort with no nature line at all. Nature and the outdoors are
  // research-servable like schools or climate, and now have a slot.
  { id: 'nature', label: 'Nature and outdoors', pattern: /\bnature\b|\boutdoors?\b|\bscenery\b|\bscenic\b|\bgreenery\b|\bgreen spaces?\b|\bnatural beauty\b|\bwilderness\b/i, keywords: ['nature', 'outdoor', 'scenic', 'trail', 'forest', 'wilderness', 'national park', 'state park', 'mountain'] },
  // Crowding (FM-9 coverage round 2, 2026-11-03): "most crowded
  // housing" decomposed to NOTHING and never engaged research,
  // because the superlative-phrase claim rule reads any phrase
  // containing a measure head word ("housing") as a Census-measure
  // reading and swallows the criterion word. Crowding is one of the
  // four demographic figures the owner's 2026-11-03 ruling keeps
  // display-only with research-first superlatives, so this entry
  // carries NO decomposedMetricKey: the criterion is researched
  // (research names the places; average_household_size only ever
  // displays), never figure-assessed or figure-ranked.
  { id: 'crowding', label: 'Crowded housing', pattern: /\bcrowd(?:ed|ing)?\b|\bovercrowd\w*\b/i, keywords: ['crowded', 'overcrowded', 'cramped'] },
  // Demographic superlatives (FM-9 live cure, 2026-11-03): poverty
  // and attainment are two of the four figures the owner's ruling
  // keeps display-only with research-first superlatives, but no
  // catalog entry claimed them — "most poverty" read as a Census
  // measure head, decomposition returned nothing, and the question
  // stranded in clarification on the live build while its bounded
  // FM-9 siblings handed off. The patterns are superlative-bound on
  // purpose: an ordinary figure lookup ("how many people are below
  // the poverty line in 78701?") states no superlative and keeps
  // its Census path; a superlative over the figure is the
  // research-first shape, so these entries carry NO
  // decomposedMetricKey — research names the places and the figure
  // only ever displays. (Broadband's entry above keeps its
  // decomposedMetricKey: that exception is shipped and stated.)
  { id: 'poverty', label: 'Poverty', pattern: /\b(?:most|highest|greatest|largest|worst|lowest|least|deepest)\b[^.!?]{0,48}\b(?:poverty|poor)\b|\bpoorest\b/i, keywords: ['poverty', 'poor'] },
  { id: 'attainment', label: 'Educational attainment', pattern: /\b(?:most|highest|greatest|largest)\b[^.!?]{0,48}\b(?:college graduates|bachelor'?s degrees?|degree holders|educational attainment)\b|\bmost educated\b/i, keywords: ['college graduates', 'bachelor', 'educational attainment', 'educated'] },
  // Current-events arm (P3 step 7, battery E4): news phrasing is a
  // research criterion, so the pipeline researches it with citations
  // instead of the question stranding in clarification.
  { id: 'current_events', label: 'Current events', pattern: /\bnews\b|\bcurrent events\b|\bheadlines?\b/i, keywords: ['news', 'announced', 'reported', 'this week'] },
  // Decomposed onto existing Census metrics (P3 step 3): these two
  // entries never take a research pass — the metric serves them.
  { id: 'internet', label: 'Internet access', pattern: /\binternet\b|\bbroadband\b/i, keywords: [], decomposedMetricKey: 'no_internet_access' },
  { id: 'cost_of_living', label: 'Cost of living', pattern: /\bcost of living\b/i, keywords: [], decomposedMetricKey: 'median_gross_rent' },
  // Salary accounting (P3b cure 3, battery A4): a stated salary had
  // no entry here, no arm in needsResearch, and no completion path
  // for a lookup parse, so it vanished and the question dead-ended
  // in clarification. The pattern (SALARY_FIGURE_RE, shared with
  // the needsResearch arm in AskPanel) requires a stated dollar
  // figure beside a salary-context word, so a home-value bound
  // ("under $250,000") or a bare income measure never matches. The
  // criterion is research-class, so the question hands off and
  // researches like any other outside-Census criterion; the
  // ACCOUNTING is special-cased in criterionEvidenceFor, which
  // records it with the reader's figure and the rent anchor
  // derived from it visible (see salaryAnchorFor there) instead of
  // letting a cited guide's prose label it measured.
  {
    id: 'salary',
    label: 'Affordability on the stated income',
    pattern: SALARY_FIGURE_RE,
    keywords: [],
  },
]

const COUNT_SEEKING_RE = /\bfewest\b|\bleast\b|\bnumber of\b|\bcount\b|\bdensity\b|\bhow many\b/i

/**
 * Superlative phrases in the reader's words ("best nature",
 * "quietest streets", "least average cost"): a phrase like this is
 * how a criterion is stated, so decomposition checks each one for a
 * claimant before it lets a partially-matching question through
 * (see hasUnclaimedCriterionPhrase).
 */
const CRITERION_SUPERLATIVE_RE =
  /\b(?:best|worst|most|least|fewest|greatest|finest|largest|smallest|highest|lowest|quietest|prettiest|nicest|cheapest|safest|warmest|coldest|strongest)\s+([a-z]+(?:\s[a-z]+)?)/gi

/**
 * Head words that make a superlative phrase a Census-measure reading
 * ("lowest rent", "highest median income") rather than an
 * outside-Census criterion, and the words of the ranking frame
 * itself ("best places", "cheapest city") — the superlative ranges
 * over the places, it does not state a criterion about them.
 */
const MEASURE_HEAD_WORDS: ReadonlySet<string> = new Set([
  'average', 'rent', 'rents', 'income', 'incomes', 'home', 'homes', 'house', 'housing',
  'cost', 'costs', 'price', 'prices', 'value', 'values', 'median', 'household',
  'households', 'population', 'tax', 'taxes', 'salary', 'wage', 'wages',
  'unemployment', 'poverty', 'commute', 'age', 'debt', 'expense', 'expenses',
  'rate', 'rates', 'spending', 'insurance', 'mortgage', 'tuition',
])
const PLACE_FRAME_WORDS: ReadonlySet<string> = new Set([
  'place', 'places', 'city', 'cities', 'town', 'towns', 'area', 'areas', 'county',
  'counties', 'state', 'states', 'zip', 'neighbourhood', 'neighborhood',
  'neighbourhoods', 'neighborhoods', 'community', 'communities', 'region',
  'regions', 'location', 'locations', 'spot', 'spots',
])

/**
 * Whether the question states a superlative criterion that neither a
 * matched catalog entry nor a Census measure claims. The combined
 * fallback in decomposeResearchCriteria used to fire only when
 * NOTHING matched, so a question whose listed criteria matched and
 * whose unlisted criterion did not ("best schools and the quietest
 * streets") lost the unlisted criterion without a line anywhere —
 * the silent-drop family the battery keeps finding (farmers markets
 * D2, warm A3, salary A4, nature 2026-11-03). A phrase is claimed
 * when its head is a measure word or the ranking frame, or when a
 * matched entry's own pattern reads it ("best schools" is the
 * schools entry's phrase, not a residue).
 */
export function hasUnclaimedCriterionPhrase(
  queryText: string,
  matched: readonly ResearchCriterion[],
): boolean {
  const matchedEntries = RESEARCH_CRITERION_CATALOG.filter((entry) =>
    matched.some((criterion) => criterion.id === entry.id),
  )
  for (const match of queryText.matchAll(CRITERION_SUPERLATIVE_RE)) {
    const phrase = (match[1] ?? '').toLowerCase()
    const words = phrase.split(/\s+/).filter((w) => w.length > 0)
    if (words.length === 0) continue
    if (PLACE_FRAME_WORDS.has(words[0]!)) continue
    if (words.some((w) => MEASURE_HEAD_WORDS.has(w))) continue
    if (matchedEntries.some((entry) => entry.pattern.test(phrase))) continue
    return true
  }
  return false
}

/**
 * Words that carry the question's scaffolding rather than a
 * criterion: question words, auxiliaries, articles, prepositions,
 * and the verbs of asking. A segment reduced to these alone states
 * no criterion (see unclaimedCriterionSegments).
 */
const SEGMENT_SCAFFOLD_WORDS: ReadonlySet<string> = new Set([
  'what', 'which', 'where', 'who', 'whom', 'is', 'are', 'was', 'were', 'has', 'have', 'had',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'i', 'me', 'my', 'we', 'you', 'your',
  'the', 'a', 'an', 'in', 'of', 'for', 'to', 'on', 'at', 'by', 'from', 'there', 'it', 'its',
  'and', 'or', 'than', 'then', 'so', 'with', 'without', 'about', 'into', 'over', 'under',
  'near', 'nearby', 'around', 'per', 'that', 'this', 'any', 'some', 'all', 'get', 'find',
  'show', 'give', 'list', 'tell', 'please', 'look', 'looking', 'want', 'need', 'like',
  // "Compare" and the number words are scaffolding too: "compare
  // two places" states no criterion at all (it clarifies), and
  // counting its verb or its count as residue would engage
  // research on a question with nothing to research (measured:
  // the indicator-lifecycle clarification pin, Lane A9 FM-2).
  'compare', 'comparing',
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'first', 'second', 'third',
])

/** Whether one superlative phrase is claimed (measure head, ranking
 * frame, or a matched catalog entry's own phrase) — the per-phrase
 * half of hasUnclaimedCriterionPhrase, shared with the segment scan. */
function superlativePhraseClaimed(
  phrase: string,
  matchedEntries: readonly (typeof RESEARCH_CRITERION_CATALOG)[number][],
): boolean {
  const words = phrase.toLowerCase().split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return true
  if (PLACE_FRAME_WORDS.has(words[0]!)) return true
  if (words.some((w) => MEASURE_HEAD_WORDS.has(w))) return true
  return matchedEntries.some((entry) => entry.pattern.test(phrase))
}

/**
 * Audience / life-frame words for the segment scan: they state who
 * is asking or the life the question imagines ("raise a family",
 * "for families", "good for kids"), never a criterion a source
 * could measure — the same reading FM-1 applies to the engagement
 * lexicon. A segment reduced to these plus scaffolding is the
 * criteria-less shape ("best place to raise a family"), whose
 * shipped posture is to keep clarifying.
 */
const SEGMENT_FRAME_WORDS: ReadonlySet<string> = new Set([
  'family', 'families', 'kid', 'kids', 'children', 'child', 'raise', 'raising', 'raised',
  'live', 'living',
])

/** One unclaimed criterion segment: the segment's own words, kept so
 * the criterion built from it can carry them as its label and its
 * text (the reader's words, not a paraphrase). */
export interface CriterionSegment {
  /** The segment as written, trimmed of outer punctuation. */
  text: string
  /**
   * The criterion's reader-facing label. Residue a superlative
   * phrase carries ("the quietest streets" beside schools) keeps
   * the classic combined label — that is A4's accounting contract,
   * and the failure/evidence lines name it. Residue carried by its
   * content words alone ("a thriving arts scene") is labelled with
   * the segment's own words, so the line names the criterion the
   * reader stated.
   */
  label: string
}

/**
 * The question's criterion segments that NO layer claims (Lane A9
 * FM-2, measured by probe P15: "good schools and a thriving arts
 * scene" decomposed to [schools] only — the arts scene, a stated
 * criterion in plain words, had no accounting path beside a match
 * because hasUnclaimedCriterionPhrase scans superlative phrases
 * only and "a thriving arts scene" carries none). The scan: split
 * the question on conjunction / comma boundaries; a segment is
 * claimed when a catalog pattern reads it, when it states a figure
 * or a Census measure reading, or when what remains after removing
 * its claimed superlative phrases, scaffolding words, place-frame
 * words, measure heads, and proper nouns (geography names) is too
 * thin to state a criterion — no words, one short word ("to live"
 * in "cheapest place to live"), or a lone hyphenated modifier
 * ("year-round"). A segment carrying an unclaimed superlative
 * phrase is unclaimed by that phrase alone. Everything else that
 * remains — two or more content words, or one content word of five
 * letters or more ("liberal" in "towns that are liberal") — is a
 * stated criterion no layer serves, and it comes back here so
 * decomposition can carry it as its own criterion instead of
 * dropping it without a line anywhere.
 */
export function unclaimedCriterionSegments(
  queryText: string,
  matched: readonly ResearchCriterion[],
): CriterionSegment[] {
  const matchedEntries = RESEARCH_CRITERION_CATALOG.filter((entry) =>
    matched.some((criterion) => criterion.id === entry.id),
  )
  interface SegmentRecord {
    text: string
    /** Claimed outright: a catalog pattern, a stated figure, or a measure reading. */
    claimedDirect: boolean
    /** Carries a superlative phrase no layer claims. */
    unclaimedSuperlative: boolean
    /** The unclaimed phrase names no content noun ("best access to"). */
    phraseContentFree: boolean
    /** Content words beyond every superlative phrase. */
    residueBeyond: string[]
    /** Content words beyond the CLAIMED superlative phrases. */
    residue: string[]
  }
  const records: SegmentRecord[] = []
  for (const raw of queryText.split(/\s+and\s+|,\s*/i)) {
    const segment = raw.trim().replace(/[?.!]+$/, '').trim()
    if (segment.length === 0) continue
    const claimedDirect =
      RESEARCH_CRITERION_CATALOG.some((entry) => entry.pattern.test(segment)) ||
      /\$\s?\d/.test(segment) ||
      segment
        .toLowerCase()
        .split(/[^a-z'-]+/)
        .some((w) => MEASURE_HEAD_WORDS.has(w))
    // Superlative phrases: claimed ones are removed before the
    // residue count so the frame they ride on cannot inflate it;
    // an unclaimed one marks the segment, and its captured words
    // are read for whether the phrase itself names the criterion
    // ("best beer selection" — the phrase IS the criterion) or only
    // points at one ("best access to" — the criterion noun sits
    // outside the phrase, in the compound the next segment may
    // complete).
    let residueText = segment
    let residueBeyondText = segment
    let unclaimedSuperlative = false
    let phraseContentFree = true
    for (const match of segment.matchAll(CRITERION_SUPERLATIVE_RE)) {
      const phrase = (match[1] ?? '').toLowerCase()
      residueBeyondText = residueBeyondText.replace(match[0], ' ')
      if (superlativePhraseClaimed(phrase, matchedEntries)) {
        residueText = residueText.replace(match[0], ' ')
      } else {
        unclaimedSuperlative = true
        const contentWords = phrase
          .split(/\s+/)
          .filter((w) => !['access', 'to', 'of', 'the', 'a', 'an', 'for', 'with', 'in', 'on'].includes(w))
        if (contentWords.length > 0) phraseContentFree = false
      }
    }
    const originalTokens = segment.split(/\s+/).filter((w) => w.length > 0)
    const contentWords = (text: string): string[] =>
      text
        .toLowerCase()
        .split(/[^a-z'-]+/)
        .filter((w) => w.length > 0)
        .filter((w) => !SEGMENT_SCAFFOLD_WORDS.has(w))
        .filter((w) => !SEGMENT_FRAME_WORDS.has(w))
        .filter((w) => !PLACE_FRAME_WORDS.has(w))
        .filter((w) => !MEASURE_HEAD_WORDS.has(w))
        // Proper nouns are geography or place names, not criteria:
        // a token capitalized in the written segment (other than
        // the segment's first token, whose case is positional).
        .filter((w) => {
          const idx = originalTokens.findIndex(
            (t) => t.toLowerCase().replace(/[^a-z'-]/g, '') === w,
          )
          if (idx <= 0) return true
          return !/^[A-Z]/.test(originalTokens[idx]!)
        })
    records.push({
      text: segment,
      claimedDirect,
      unclaimedSuperlative,
      phraseContentFree,
      residueBeyond: contentWords(residueBeyondText),
      residue: contentWords(residueText),
    })
  }
  const segments: CriterionSegment[] = []
  records.forEach((record, i) => {
    if (record.claimedDirect) return
    const adjacentClaimed =
      (i > 0 && records[i - 1]!.claimedDirect) || (i < records.length - 1 && records[i + 1]!.claimedDirect)
    if (record.unclaimedSuperlative) {
      // Continuation head: the phrase names no criterion noun, the
      // words beyond it are at most the one noun the compound
      // needs, and an adjacent segment is catalog-claimed — the
      // phrase is the head of THAT criterion's compound phrase
      // ("best access to hiking | and wilderness": one nature
      // criterion across the conjunction), not a second criterion.
      if (record.phraseContentFree && record.residueBeyond.length <= 1 && adjacentClaimed) return
      segments.push({ text: record.text, label: 'Outside-Census criteria' })
      return
    }
    if (record.residue.length >= 2) {
      segments.push({ text: record.text, label: segmentCriterionLabel(record.text) })
      return
    }
    if (record.residue.length === 1) {
      const only = record.residue[0]!
      // A one-word residue beside an accounted segment is a
      // noun-phrase continuation ("hospitals | and doctors" — one
      // amenities criterion; "doctors" is its completion). A
      // one-word residue standing first ("towns that are liberal")
      // is a stated criterion in one word and stays unclaimed.
      if (i === 0 && only.length >= 5 && !only.includes('-')) {
        segments.push({ text: record.text, label: segmentCriterionLabel(record.text) })
      }
    }
  })
  return segments
}

/**
 * The reader-facing label for a residue segment's criterion: the
 * segment's own words with a leading question frame removed, first
 * letter capitalized. "a thriving arts scene" reads on the card as
 * "A thriving arts scene" — the reader's phrase, labelled as
 * itself, so the evidence line names the criterion the reader
 * actually stated.
 */
function segmentCriterionLabel(segmentText: string): string {
  const stripped = segmentText
    .replace(
      /^(?:what|which|where|who)\s+(?:\w+\s+){0,3}?(?:is|are|has|have)\s+(?:the\s+|a\s+|an\s+)?/i,
      '',
    )
    .trim()
  const label = stripped.length > 0 ? stripped : segmentText
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/**
 * Whether the question carries criterion content no layer claims:
 * an unclaimed superlative phrase (hasUnclaimedCriterionPhrase) or
 * an unclaimed criterion segment (unclaimedCriterionSegments). The
 * engagement derivation (AskPanel's needsResearch) and the combined
 * carry in decomposition both read this single test, so the layers
 * cannot drift into engaging different questions — the drift
 * between layers is the seam family the generality battery keeps
 * finding.
 */
export function hasUnclaimedCriterionContent(
  queryText: string,
  matched: readonly ResearchCriterion[],
): boolean {
  return (
    hasUnclaimedCriterionPhrase(queryText, matched) ||
    unclaimedCriterionSegments(queryText, matched).length > 0
  )
}

/* ------------------------------------------------------------------ */
/* Criterion poles (breadth mode)                                      */
/* ------------------------------------------------------------------ */

/**
 * Characterization dimensions whose poles decomposition names as
 * a pair: when the criterion's own text carries one side's
 * vocabulary, the other side is the negative pole — the pair is
 * part of what the criterion AS PARSED means ("most liberal"
 * parses against "conservative" whether or not the question
 * prints both words; AskPanel's politics lexicon already reads
 * the dimension with both vocabularies, for the coverage note).
 * The mechanism is general — a dimension is a row here, and the
 * standing derivation below reads only the poles, never the
 * dimension — this table is where a dimension's vocabulary
 * lives, the same place the criterion catalog keeps its own.
 */
const CHARACTERIZATION_POLE_PAIRS: readonly {
  title: string
  sides: readonly { head: string; terms: readonly string[] }[]
}[] = [
  {
    title: 'Political leaning',
    sides: [
      {
        head: 'liberal',
        terms: ['liberal', 'liberals', 'democratic', 'democrat', 'democrats', 'progressive', 'progressives'],
      },
      {
        head: 'conservative',
        terms: ['conservative', 'conservatives', 'republican', 'republicans'],
      },
    ],
  },
]

const SUPERLATIVE_WORDS: ReadonlySet<string> = new Set([
  'best', 'worst', 'most', 'least', 'fewest', 'greatest', 'finest', 'largest',
  'smallest', 'highest', 'lowest', 'quietest', 'prettiest', 'nicest', 'cheapest',
  'safest', 'warmest', 'coldest', 'strongest',
])

function termIn(lowerText: string, term: string): boolean {
  return new RegExp(`\\b${term.replace(/[.*+?^${'{}'}()|[\]\\]/g, '\\$&')}\\b`).test(lowerText)
}

/** The poles when the criterion's text names one side of a paired dimension. */
function characterizationPairPoles(text: string): CriterionPoles | null {
  const lower = text.toLowerCase()
  for (const pair of CHARACTERIZATION_POLE_PAIRS) {
    for (let side = 0; side < pair.sides.length; side++) {
      const positive = pair.sides[side]!
      if (!positive.terms.some((term) => termIn(lower, term))) continue
      const negative = pair.sides[(side + 1) % pair.sides.length]!
      const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
      return {
        mode: 'terms',
        positiveTerms: positive.terms,
        negativeTerms: negative.terms,
        positiveLabel: `${cap(positive.head)}-leaning`,
        negativeLabel: `${cap(negative.head)}-leaning`,
        mixedLabel: 'Mixed',
        title: pair.title,
      }
    }
  }
  return null
}

/**
 * The characterization term of an unclaimed superlative phrase
 * ("most charming" -> 'charming'): the phrase's head word, when
 * the phrase is a criterion phrase at all (not a measure reading,
 * not the ranking frame) — the same claimed test
 * hasUnclaimedCriterionPhrase applies, minus the catalog arm.
 */
function superlativeCharacterizationTerm(text: string): string | null {
  for (const match of text.matchAll(CRITERION_SUPERLATIVE_RE)) {
    const words = (match[1] ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 0)
    if (words.length === 0) continue
    if (PLACE_FRAME_WORDS.has(words[0]!)) continue
    if (words.some((w) => MEASURE_HEAD_WORDS.has(w))) continue
    return words[0]!
  }
  return null
}

/**
 * The poles of a combined-class criterion (a whole-question carry
 * or a per-segment residue), from its own text: a paired
 * dimension first; else the superlative characterization term;
 * else — for a per-segment residue, whose LABEL is the segment's
 * own characterization words — the label's content terms. The
 * whole-question carry whose text names none of these gets no
 * poles: its criterion is the ranking frame plus residue no
 * layer can characterize, and a breadth standing derived from
 * bare mentions would color places by proximity to prose, which
 * is inference, not evidence.
 */
export function combinedCriterionPoles(text: string, label: string): CriterionPoles | undefined {
  const pair = characterizationPairPoles(text)
  if (pair) return pair
  const head = superlativeCharacterizationTerm(text)
  if (head) {
    return {
      mode: 'terms',
      positiveTerms: [head],
      negativeTerms: [],
      positiveLabel: `Described as ${head}`,
      negativeLabel: `Described as not ${head}`,
      mixedLabel: 'Described both ways',
    }
  }
  if (label !== 'Outside-Census criteria') {
    const terms = label
      .toLowerCase()
      .split(/[^a-z'-]+/)
      .filter(
        (w) =>
          w.length >= 4 &&
          !SEGMENT_SCAFFOLD_WORDS.has(w) &&
          !PLACE_FRAME_WORDS.has(w) &&
          !SUPERLATIVE_WORDS.has(w),
      )
    if (terms.length > 0) {
      return {
        mode: 'terms',
        positiveTerms: terms,
        negativeTerms: [],
        positiveLabel: `Described as ${label.toLowerCase()}`,
        negativeLabel: `Described as not ${label.toLowerCase()}`,
        mixedLabel: 'Described both ways',
      }
    }
  }
  return undefined
}

/** The spread field carrying a combined criterion's poles, when it has any. */
function combinedPolesField(text: string, label: string): { poles: CriterionPoles } | {} {
  const poles = combinedCriterionPoles(text, label)
  return poles ? { poles } : {}
}

/**
 * Decompose a question's outside-Census criteria. Every catalog
 * criterion the words carry becomes its own criterion. Residue the
 * catalog does not name rides as its own criterion per segment
 * (unclaimedCriterionSegments), labelled with the segment's own
 * words — a partial match never silently drops the rest of the
 * question (the accounting invariant: every parsed criterion
 * yields exactly one evidence line). When NO catalog entry
 * matches, the outside criteria are carried as one combined
 * criterion when the question states criterion content no layer
 * claims, and for a criteria-less question (the ranking frame
 * alone) as the shipped total-miss fallback. A question that
 * states Census content and nothing else ("rent under $900")
 * decomposes to nothing and carries no spurious combined line
 * onto its pure-Census card (Lane A9 FM-3c, measured on the
 * cost-of-housing bucket: the shipped fallback stamped
 * "Outside-Census criteria — not measurable" on a question that
 * stated no outside criterion). An empty or absent query
 * decomposes to nothing.
 */
export function decomposeResearchCriteria(queryText: string | undefined): ResearchCriterion[] {
  if (!queryText || queryText.trim() === '') return []
  const quantitative = COUNT_SEEKING_RE.test(queryText)
  const found: ResearchCriterion[] = []
  for (const entry of RESEARCH_CRITERION_CATALOG) {
    if (!entry.pattern.test(queryText)) continue
    found.push({
      id: entry.id,
      label: entry.label,
      text: queryText,
      // Only a count/density criterion is quantitative, and only
      // when the reader's words seek a count ("fewest", "number of").
      quantitative: quantitative && (entry.id === 'fast_food' || entry.id === 'restaurants'),
      ...(entry.decomposedMetricKey ? { decomposedMetricKey: entry.decomposedMetricKey } : {}),
      // Catalog poles (breadth mode): the keyword test is the
      // characterization, so the poles ride in keywords mode.
      poles: {
        mode: 'keywords',
        positiveTerms: entry.keywords,
        negativeTerms: [],
        positiveLabel: 'Meets the description',
        negativeLabel: 'Does not meet the description',
        mixedLabel: 'Described both ways',
      },
    })
  }
  if (found.length > 0) {
    const residueSegments = unclaimedCriterionSegments(queryText, found)
    // A single unclaimed segment spanning the whole question is
    // the classic combined carry, not a per-segment criterion: its
    // "segment" is the question itself (the safety shape — "the
    // safest for families" reads as Outside-Census criteria, the
    // shipped label), and a segment label derived from it would
    // name the question back at the reader. Per-segment criteria
    // are for residue beside other content — the segment is one
    // part of the question, and its own words name it.
    const wholeQuestion =
      residueSegments.length === 1 &&
      residueSegments[0]!.text.replace(/[?.!]+$/, '').trim().toLowerCase() ===
        queryText.replace(/[?.!]+$/, '').trim().toLowerCase()
    if (wholeQuestion) {
      found.push({
        id: 'combined',
        label: 'Outside-Census criteria',
        text: queryText,
        quantitative,
        ...combinedPolesField(queryText, 'Outside-Census criteria'),
      })
    } else {
      for (const segment of residueSegments) {
        // Two residue segments can carry the same label (two
        // superlative residues both read as the combined class):
        // their accounting is one line, so the criterion is added
        // once — a duplicate would print the same evidence line
        // twice for one class of content.
        if (found.some((c) => c.id === 'combined' && c.label === segment.label)) continue
        found.push({
          id: 'combined',
          label: segment.label,
          text: segment.text,
          quantitative,
          ...combinedPolesField(segment.text, segment.label),
        })
      }
    }
    return found
  }
  if (hasUnclaimedCriterionContent(queryText, found)) {
    return [
      {
        id: 'combined',
        label: 'Outside-Census criteria',
        text: queryText,
        quantitative,
        ...combinedPolesField(queryText, 'Outside-Census criteria'),
      },
    ]
  }
  // The total-miss fallback survives for a CRITERIA-LESS question
  // (the ranking frame alone: "cheapest place to live" — pinned by
  // the Colorado battery): the combined criterion is the honest
  // carry for a question research may still speak to. A question
  // that states Census content — a measure reading or a stated
  // figure — and nothing else is a Census question: it decomposes
  // to nothing, and no combined line rides its card (FM-3c). The
  // measure heads here are the ones a registry metric can serve:
  // "commute" is a measure head for the superlative scan, but the
  // registry carries no commute-duration metric (commuting_workers
  // is a worker count), so a shortest-commute question states no
  // servable Census content and keeps the combined carry — the
  // research-first handoff battery's pinned reading.
  const statesCensusContent =
    /\$\s?\d/.test(queryText) ||
    queryText
      .toLowerCase()
      .split(/[^a-z'-]+/)
      .some((w) => w !== 'commute' && MEASURE_HEAD_WORDS.has(w))
  if (!statesCensusContent) {
    return [
      {
        id: 'combined',
        label: 'Outside-Census criteria',
        text: queryText,
        quantitative,
        ...combinedPolesField(queryText, 'Outside-Census criteria'),
      },
    ]
  }
  return []
}

/** An explicit county subject: the county itself is what is asked
 * about ("which county...", "counties with..."). */
const COUNTY_SUBJECT_RE = /\bwhich (?:county|counties)\b|\bcounties\b/i

/** A place noun as the question's ranked subject: the reader asks
 * for places, and a county in the text is their bound. */
const PLACE_FRAME_RE =
  /\b(?:places?|towns?|cities|city|areas?|villages?|communities|neighborhoods?|spots?)\b/i

/** "Where in <...> county..." asks for a place inside the county. */
const WHERE_COUNTY_RE = /\bwhere\b[^?]*\bcounty\b/i

/**
 * Whether the question asks for a county-level answer — the
 * county AS SUBJECT (its aggregate figure, or counties ranked).
 * The word "county" alone does not decide it (Lane A9 FM-10,
 * finding F1): "What's the cheapest place to live in Hawaii
 * County?" names the county as the BOUND of a place question, and
 * aggregating it answered a question nobody asked — the county's
 * own $1,473/mo aggregate in place of its cheapest places
 * (measured, C1 battery). The shape rule: an explicit county
 * subject always aggregates; a place noun (or a where-in-county
 * frame) as the ranked subject composes the ordinary place-level
 * screen over the county-bounded rows the runner already
 * expanded; every other county mention keeps the aggregate —
 * "What's the median household income in Boulder County?" is a
 * county lookup, and it stays one.
 */
/**
 * The direction a superlative question asks its ranking to run,
 * read from the reader's own words — the same posture as the
 * county-level reading below and the national-screen rescue: the
 * intent schema carries no direction field, so once a parse falls
 * into clarification and the completion rebuilds a bare screen
 * intent, the words are the only place the direction survives.
 * Until cure round 3 (2026-11-03) every bound-less sweep sorted
 * ascending, so "Which state has the oldest population?" answered
 * youngest-first on the live path — the exact inverse of the ask.
 * The reading is deliberately narrow: a descending stem with no
 * ascending stem opposing it. Anything else keeps the ascending
 * default the shipped screens have always used, so a question
 * whose superlative binds a researched criterion rather than the
 * ranked figure is never re-ordered by a stem it did not aim at
 * the figure.
 */
const DESCENDING_SUPERLATIVE_RE =
  /\b(?:oldest|highest|largest|biggest|greatest|longest|richest|wealthiest|priciest|costliest)\b|\bmost\s+expensive\b/i
const ASCENDING_SUPERLATIVE_RE =
  /\b(?:youngest|lowest|cheapest|smallest|fewest|most\s+affordable|most\s+inexpensive|least\s+expensive|lowest\s+cost)\b/i

export type RankDirection = 'ascending' | 'descending'

export function rankDirectionFromQuery(queryText: string | undefined): RankDirection {
  if (!queryText) return 'ascending'
  if (DESCENDING_SUPERLATIVE_RE.test(queryText) && !ASCENDING_SUPERLATIVE_RE.test(queryText)) {
    return 'descending'
  }
  return 'ascending'
}

/**
 * A state named as the question's SUBJECT: "which state", "what
 * state", "states with ...", "rank the states". "United States" is
 * stripped first — it names the country, not a state subject.
 */
const STATE_SUBJECT_RE =
  /\bwhich states?\b|\bwhat states?\b|\bstates?\s+(?:has|have|with|is|are)\b|\brank(?:ing|ed|s)?\s+(?:the\s+)?states?\b|\bstates?\s+ranked\b/i

/**
 * Whether the question asks for a STATE-level answer — the state
 * AS SUBJECT (its aggregate figure, states ranked), the state-level
 * twin of requestsCountyLevel. The word "state" alone does not
 * decide it: a place-frame noun as the ranked subject makes the
 * state the question's bound ("cheapest place to live in Texas" —
 * PLACE_FRAME_RE carries "place"), and an intent that already names
 * geographies is served by the named paths (a named state composes
 * its own state average; it is not silently widened to all states).
 * The placeless shape this serves is the superlative completion:
 * the question named no geography at all, so until cure round 3
 * the terminal silently downgraded to a national ZIP screen.
 */
export function requestsStateLevel(queryText: string | undefined, intent: ValidatedIntent): boolean {
  if (intent.geographies.length > 0) return false
  if (!queryText) return false
  const text = queryText.replace(/\bunited states\b/gi, 'the country')
  if (!/\bstates?\b/i.test(text)) return false
  if (PLACE_FRAME_RE.test(text)) return false
  return STATE_SUBJECT_RE.test(text)
}

/** A geography string that IS a county ("Boulder County, CO"),
 * as opposed to a place string that merely mentions one
 * ("Hilo, Hawaii County, HI"): the county is the geography's
 * first comma segment, not a later qualifier. */
function isCountyGeography(geography: string): boolean {
  const firstSegment = geography.split(',')[0]?.trim() ?? ''
  return /\bcounty$/i.test(firstSegment)
}

export function requestsCountyLevel(queryText: string | undefined, intent: ValidatedIntent): boolean {
  if (queryText && /\bcounty\b|\bcounties\b/i.test(queryText)) {
    if (COUNTY_SUBJECT_RE.test(queryText)) return true
    if (PLACE_FRAME_RE.test(queryText) || WHERE_COUNTY_RE.test(queryText)) return false
    return true
  }
  // No county in the question text: the county level may still be
  // the intent's own shape — but only when the intent is an
  // all-county intent (a county lookup, a county comparison, an
  // editor-built county intent). The earlier any-match rule let a
  // model intent parse that expanded ONE named place into its
  // county ("Hilo, Hawaii County, HI" beside "East Honolulu, HI")
  // flip a two-place comparison to county level, where the figures
  // become aggregates over whatever screen rows are loaded —
  // measured 2026-11-03: the same Hilo/East Honolulu comparison
  // returned three different figure pairs in one day, and only the
  // place-level reading matched the published Census rows. A named
  // place resolves at place level; the county level is a property
  // of the question, or of an intent that names counties only.
  return (
    intent.geographies.length > 0 &&
    intent.geographies.every((g) => isCountyGeography(g))
  )
}

const COUNT_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}
const COUNT_TOKEN = String.raw`(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`

/**
 * The place count a top-N question asks for, read from the reader's
 * own words: "top five places", "top 5", "the five best places".
 * Returns null when the words name no count — most questions do
 * not, and inventing one would cap answers nobody bounded. The
 * number-word arm requires "places" after the count so a figure in
 * the question ("rent under 1500 in 3 places I lived") is not read
 * as a requested count... the digit arm of "top N" is unambiguous
 * and needs no such guard. Counts above the candidate cap are
 * returned as asked: the compose cap still bounds the places, and
 * the shortfall line compares the true ask against what grounded.
 */
export function requestedCountFromQuery(queryText: string | undefined): number | null {
  if (!queryText) return null
  const top = new RegExp(String.raw`\btop\s+${COUNT_TOKEN}\b`, 'i').exec(queryText)
  const counted = new RegExp(
    String.raw`\b${COUNT_TOKEN}\s+(?:best\s+|top\s+)?places\b`,
    'i',
  ).exec(queryText)
  const token = top?.[1] ?? counted?.[1]
  if (!token) return null
  const value = /^\d+$/.test(token) ? Number(token) : COUNT_WORDS[token.toLowerCase()]
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null
}

/** Plural place-frame nouns: the question's subject is a SET of places. */
const SET_FRAME_PLURAL_RE =
  /\b(?:areas|cities|towns|places|communities|neighborhoods|neighbourhoods|villages|spots|locations|regions)\b/i

/**
 * A singular-superlative subject: a superlative ranging over ONE
 * place noun ("the most liberal city") — the winner-seeking shape,
 * however the rest of the question is framed.
 */
const SINGULAR_SUPERLATIVE_SUBJECT_RE =
  /\b(?:most|best|least|worst|fewest|greatest|finest|largest|smallest|highest|lowest|cheapest|safest|warmest|coldest|strongest|quietest|prettiest|nicest)\s+(?:[a-z]+\s+)?(city|town|place|area|community|neighborhood|neighbourhood|village|spot|location|region)\b/i

/**
 * Whether the question's shape asks for a SET of places rather
 * than a winner (breadth mode's shape half, derived from the
 * reader's words the same way the rest of decomposition reads
 * them): a plural place-frame noun carries the subject, and no
 * singular-superlative subject overrides it. "Which areas of
 * Texas are the most liberal?" is a set question — its
 * superlative ranges over the set's members. "What is the most
 * liberal city in Texas?" is not, and keeps the shipped
 * winner-seeking path exactly. A question with no plural frame
 * ("Where in Texas is it most liberal?") is not a set question
 * either: no set was asked for, so no set is assessed.
 */
export function questionSetForm(queryText: string | undefined): boolean {
  if (!queryText) return false
  if (SINGULAR_SUPERLATIVE_SUBJECT_RE.test(queryText)) return false
  return SET_FRAME_PLURAL_RE.test(queryText)
}

/** A breadth run's shape: the bound geography and the criterion its standings characterize. */
export interface BreadthShape {
  /** The bound state's plain name ('Texas'). */
  geographyLabel: string
  stateAbbr: string
  /** The lead researched criterion carrying parsed poles. */
  criterion: ResearchCriterion
}

/**
 * Whether this run is a breadth run, derived from decomposition
 * output and the question's shape — never from a keyword trigger
 * for any one question (the A9 engagement discipline: the layers
 * derive from the same parsed material or they drift). The full
 * shape: a set-form question (questionSetForm); exactly one
 * geography, and it is a state (the display set is that state's
 * places; a place bound's own rows are the shipped path's
 * universe, and a multi-state set has no single display
 * geography); no stated top-N count (the reader bounded the set
 * themselves — the cap machinery already serves that ask); and
 * at least one researched criterion whose poles decomposition
 * could name (the standing derivation needs the criterion's
 * poles as parsed — a criterion with no poles cannot characterize
 * a set, and engaging without them would color by mention).
 */
export function breadthShapeFor(input: {
  queryText?: string
  intent: ValidatedIntent
  researchCriteria: readonly ResearchCriterion[]
}): BreadthShape | null {
  const queryText = input.queryText
  if (!queryText || !questionSetForm(queryText)) return null
  if (requestedCountFromQuery(queryText) !== null) return null
  if (input.intent.geographies.length !== 1) return null
  const geography = input.intent.geographies[0]!
  if (!isStateGeography(geography)) return null
  const stateAbbr = stateAbbrOfGeography(geography)
  if (!stateAbbr) return null
  const criterion = input.researchCriteria.find(
    (c) => !c.decomposedMetricKey && c.poles !== undefined && c.poles.positiveTerms.length > 0,
  )
  if (!criterion) return null
  return {
    geographyLabel: STATE_NAME_BY_CODE[stateAbbr] ?? geography,
    stateAbbr,
    criterion,
  }
}

const STATE_NAME_SET: ReadonlySet<string> = new Set(
  Object.values(STATE_NAME_BY_CODE).map((name) => name.toLowerCase()),
)

/**
 * Whether one intent geography is a STATE bound — a postal code or a
 * full state name — as opposed to a place (a named city, whose own
 * rows are the answer's universe), a ZIP, or a county. The
 * research-first widening below keys on this distinction.
 */
export function isStateGeography(geography: string): boolean {
  const g = geography.trim()
  if (/^[A-Za-z]{2}$/.test(g)) return STATE_NAME_BY_CODE[g.toUpperCase()] !== undefined
  return STATE_NAME_SET.has(g.toLowerCase())
}

/** The geography level an intent's geographies name, before any county request. */
export function geographyLevelOfIntent(intent: ValidatedIntent): AnswerGeographyLevel {
  if (intent.geographies.length === 0) return 'national'
  if (intent.geographies.every((g) => /^\d{5}$/.test(g.trim()))) return 'zcta'
  if (intent.geographies.every((g) => /^[A-Za-z]{2}$/.test(g.trim()))) return 'state'
  return 'place'
}

/* ------------------------------------------------------------------ */
/* Stage 3: research over the screened subset                          */
/* ------------------------------------------------------------------ */

export interface ResearchStageResult {
  prose: string
  sources: AnswerSource[]
  claims: ResearchedClaim[]
  /**
   * Labels of criteria whose research pass FAILED — after a sibling
   * pass had already returned material (partial tolerance in
   * researchPerCriterion, 2026-11-02), or, on the screen path only,
   * with no pass returning at all (the total-failure degrade,
   * 2026-11-02: the completed Census screen carries the card and
   * every failed lookup is recorded on it). Absent when every pass
   * returned. A failed criterion is accounted on the card as not
   * measured, with the lookup's failure stated — never as if
   * research had run and found nothing.
   */
  failedCriteria?: readonly string[]
  /**
   * True when the stage re-asked once before settling (Lane A9
   * FM-11): an all-empty stage — every pass failed, or every pass
   * returned no usable material — is asked exactly once more
   * in-run, because per-call research variance is the dominant
   * measured residual (C1: three research-dependent questions
   * noted in one window while the same questions on another
   * device, same build, returned full material). The flag rides
   * the result so the answer's evidence can state the re-ask
   * where the stage still ends empty.
   */
  reAsked?: boolean
}

/**
 * Split research prose into claims and attach the result's citations.
 * The provider's citation gate operates at result granularity (a
 * research result with no sources is refused inside the provider),
 * so every sentence of a surviving result carries the result's source
 * URLs; compose still drops any claim whose source list is empty, so
 * a claim built elsewhere without citations cannot slip through by
 * being handed to compose directly.
 */
export function claimsFromResearch(result: ResearchResult): ResearchedClaim[] {
  const urls = result.sources.map((s) => s.url)
  return result.prose
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((text) => ({ text, sourceUrls: [...urls] }))
}

/**
 * Run the existing research logic over the screened subset only.
 * The provider is the same one the research route serves (proxy or
 * BYO direct), so its citation gate and its rescoped
 * banned-construction gate both apply before prose reaches compose.
 */
export async function researchScreened(
  provider: MuseProvider,
  screened: readonly AreaRow[],
  researchQuery: string,
  signal: AbortSignal,
): Promise<ResearchStageResult> {
  const places = screened.map((row) => row.name)
  const result = await provider.research({ queryText: researchQuery, places }, signal)
  return {
    prose: result.prose,
    sources: result.sources.map((s) => ({ title: s.title, url: s.url })),
    claims: claimsFromResearch(result),
  }
}

/**
 * The pass plan for a criterion list: which criteria actually take
 * a research pass, grouped by the pass that serves them (Lane A9
 * FM-3b). Every pass queries the reader's whole question, so a
 * named criterion's pass has already gathered whole-question
 * material when it returns — the combined-class criteria (the
 * whole-question combined carry and per-segment residue criteria)
 * are therefore ACCOUNTED from the gathered material and take no
 * pass of their own beside a named criterion: the shipped shape
 * ran a second, identical whole-question call for them and the
 * card carried two lines claiming the same service (measured on
 * the safety, nature, and health buckets — two research calls,
 * "Safety = met" beside "Outside-Census criteria = met", for one
 * gathering). When no named criterion takes a pass, the combined
 * class takes exactly one shared pass. A criterion decomposed onto
 * a Census metric takes no pass — its figures are the service.
 * The pipeline's progress denominators read this same plan (the
 * A7 contract: the pass count is fixed before research starts),
 * so the percent and the calls can never disagree.
 */
export function researchPassGroups(
  criteria: readonly ResearchCriterion[],
): ResearchCriterion[][] {
  const researched = criteria.filter((c) => !c.decomposedMetricKey)
  const named = researched.filter((c) => c.id !== 'combined')
  if (named.length > 0) return named.map((c) => [c])
  const combinedClass = researched.filter((c) => c.id === 'combined')
  return combinedClass.length > 0 ? [combinedClass] : []
}

/**
 * One research pass per pass group (researchPassGroups), over the
 * same places. The question text is the query for every pass (the
 * question itself states every criterion; the passes are separated
 * so each named criterion's sources are collected under its own
 * call, and a provider that answers criteria differently per call
 * is honoured). Identical claim texts returned by more than one
 * pass are kept once — the same finding cited twice is one finding.
 */
export async function researchPerCriterion(
  provider: MuseProvider,
  places: readonly string[],
  criteria: readonly ResearchCriterion[],
  researchQuery: string,
  signal: AbortSignal,
  options?: {
    /**
     * The caller's posture toward a TOTAL research failure — every
     * pass down, no material gathered. Default (research-first):
     * the failure rethrows, because research is that path's only
     * leg and the honest note is its terminal. The screen path
     * passes true: a completed Census screen can carry the card on
     * its own, so a total failure degrades onto it — every
     * researched criterion recorded in failedCriteria — instead of
     * discarding the screen. A partial failure (some pass returned)
     * is tolerated under either posture.
     */
    tolerateTotalFailure?: boolean
    /**
     * Observation seam for run progress (Lane A7): fired after every
     * pass that TERMINATES — a return, or a failure the tolerance
     * posture records — with the accumulated stage result (a copy;
     * the observer cannot mutate the run's material), the pass index,
     * and the pass total. Awaited before the next pass starts, so
     * progress events are strictly ordered by pass boundary. Never
     * fired for the rethrowing failure: that pass ends the stage,
     * and the caller's own failure handling owns what the reader is
     * told about it. Observation-only, like onStage: it changes
     * nothing the stage computes.
     */
    onPass?: (
      accumulated: ResearchStageResult,
      passIndex: number,
      passTotal: number,
    ) => void | Promise<void>
  },
): Promise<ResearchStageResult> {
  const sources: AnswerSource[] = []
  const claims: ResearchedClaim[] = []
  const proseParts: string[] = []
  const failedCriteria: string[] = []
  // The pass plan (researchPassGroups): named criteria take one
  // pass each; the combined class shares one pass when it rides
  // alone and takes none beside a named criterion — it is accounted
  // from the gathered material instead. When every pass has
  // terminated and no material was gathered, the combined class's
  // labels join the failures: the lookups that would have served
  // them did not return, and their evidence lines say exactly that.
  const groups = researchPassGroups(criteria)
  const combinedLabels = criteria
    .filter((c) => !c.decomposedMetricKey && c.id === 'combined')
    .map((c) => c.label)
  let terminatedGroups = 0
  const effectiveFailedCriteria = (): string[] => {
    const failed = [...failedCriteria]
    if (
      groups.length > 0 &&
      terminatedGroups === groups.length &&
      proseParts.length === 0
    ) {
      for (const label of combinedLabels) {
        if (!failed.includes(label)) failed.push(label)
      }
    }
    return failed
  }
  let stageReAsked = false
  /** The accumulated stage result as an observer may see it (copies). */
  const accumulated = (): ResearchStageResult => {
    const failed = effectiveFailedCriteria()
    return {
      prose: proseParts.join('\n'),
      sources: [...sources],
      claims: [...claims],
      ...(failed.length > 0 ? { failedCriteria: failed } : {}),
      ...(stageReAsked ? { reAsked: true } : {}),
    }
  }
  // The one bounded re-ask (Lane A9 FM-11): when the whole stage
  // ends EMPTY — every pass failed, or every pass returned without
  // usable material — the stage runs exactly once more before the
  // caller's honest-note machinery engages. Research variance is
  // per-call (C1 measured three noted questions in one window
  // against full material for the same questions in the same
  // window on another device), so a single in-run re-ask converts
  // the common flap into material; a second empty settles as
  // before, with reAsked recorded. A stage with ANY material never
  // re-asks — partial tolerance above already owns that case.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) {
      stageReAsked = true
      sources.length = 0
      claims.length = 0
      proseParts.length = 0
      failedCriteria.length = 0
      terminatedGroups = 0
    }
    let retryStage = false
    for (let pass = 0; pass < groups.length; pass++) {
    // Partial tolerance (2026-11-02, flexible-trigger cure): before
    // this, ANY pass failure threw out of the pipeline and discarded
    // every earlier pass's gathered material, so a dual-criteria
    // question whose first pass named places and whose second pass
    // hit a provider flap died at the compose-failed note with
    // research-named material in hand. Now a failed pass is recorded
    // and the remaining passes still run — WHEN at least one pass
    // has already returned material. When NO pass has succeeded the
    // failure rethrows exactly as before: research is down, no named
    // material exists to ground anything on, and the honest note is
    // the terminal by design.
    //
    // Total-failure degrade (2026-11-02, screen-path compose throw):
    // that rethrow is the RESEARCH-FIRST path's contract, where
    // research is the only leg. The screen path composes over a
    // completed Census screen, and the same rethrow discarded it
    // whole: the owner's "best schools and lowest cost of living in
    // Arkansas?" carries exactly ONE researched pass (schools; cost
    // of living decomposes onto median_gross_rent), so a provider
    // flap during that pass killed a compose whose screen material
    // was complete — the rendered screen above a compose-failed
    // note. When the caller passes tolerateTotalFailure (the screen
    // path only), a failure with no material yet is recorded like
    // any other failed pass and the loop continues; if no pass
    // returns, the stage result is empty material with every
    // researched criterion in failedCriteria, and compose accounts
    // each one on the card as a lookup that did not return.
    let result: ResearchResult
    try {
      result = await provider.research({ queryText: researchQuery, places: [...places] }, signal)
    } catch (err) {
      if (proseParts.length === 0 && !options?.tolerateTotalFailure) {
        // First attempt: the stage has returned nothing at all, so
        // the failure defers to the one re-ask (FM-11) instead of
        // throwing; the re-ask's own failure throws as before.
        if (attempt === 0) {
          retryStage = true
          break
        }
        throw err
      }
      for (const criterion of groups[pass]!) failedCriteria.push(criterion.label)
      terminatedGroups++
      await options?.onPass?.(accumulated(), pass, groups.length)
      continue
    }
    proseParts.push(result.prose)
    for (const source of result.sources) {
      if (!sources.some((s) => s.url === source.url)) {
        sources.push({ title: source.title, url: source.url })
      }
    }
    for (const claim of claimsFromResearch(result)) {
      if (!claims.some((c) => c.text === claim.text)) claims.push(claim)
    }
    terminatedGroups++
    await options?.onPass?.(accumulated(), pass, groups.length)
    }
    if (retryStage) continue
    // Material gathered settles the stage; an empty stage on the
    // first attempt falls through to the one re-ask.
    if (claims.length > 0 || proseParts.join('').trim() !== '') break
  }
  const failed = effectiveFailedCriteria()
  return {
    prose: proseParts.join('\n'),
    sources,
    claims,
    ...(failed.length > 0 ? { failedCriteria: failed } : {}),
    ...(stageReAsked ? { reAsked: true } : {}),
  }
}

/**
 * Merge two research stage yields into one (Lane completion K1,
 * 2026-11-03): prose concatenates, sources dedupe by URL, claims
 * dedupe by text, and a criterion stays in failedCriteria only
 * when BOTH stages failed it — a criterion the second stage
 * served is served. The first stage's re-ask record (FM-11)
 * carries over; the merge introduces no bookkeeping of its own.
 */
export function mergeResearchStages(
  first: ResearchStageResult,
  second: ResearchStageResult,
): ResearchStageResult {
  const sources = [...first.sources]
  for (const source of second.sources) {
    if (!sources.some((s) => s.url === source.url)) sources.push(source)
  }
  const claims = [...first.claims]
  for (const claim of second.claims) {
    if (!claims.some((c) => c.text === claim.text)) claims.push(claim)
  }
  const failedCriteria = (first.failedCriteria ?? []).filter((label) =>
    (second.failedCriteria ?? []).includes(label),
  )
  return {
    prose: [first.prose, second.prose].filter((p) => p.trim() !== '').join('\n'),
    sources,
    claims,
    ...(failedCriteria.length > 0 ? { failedCriteria } : {}),
    ...(first.reAsked ? { reAsked: true } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Research-first candidate extraction                                 */
/* ------------------------------------------------------------------ */

/**
 * The extraction seam: a parse-style call over the findings text
 * whose output is then validated against the place index / rows.
 * Injectable so tests can can it; the default is the deterministic
 * pattern below, not a model.
 */
export type CandidateExtractor = (findings: {
  prose: string
  sources: readonly AnswerSource[]
}) => Promise<string[]> | string[]

/** One resolved candidate: a cited name pinned to the ZCTAs it covers. */
export interface ResolvedCandidate {
  name: string
  zctas: string[]
}

/** The resolution seam: names in, ZCTA sets out; absent name = unresolvable. */
export type CandidateResolver = (
  names: readonly string[],
) => Promise<ResolvedCandidate[]> | ResolvedCandidate[]

const CANDIDATE_NAME_RE = /\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,3}), ([A-Z]{2})\b/g

/** Full state names to their abbreviations, for the list-genre
 * extraction below (multi-word names first: alternation order is
 * match order). */
const STATE_NAME_TO_ABBR: Readonly<Record<string, string>> = {
  'District of Columbia': 'DC',
  'North Carolina': 'NC',
  'South Carolina': 'SC',
  'North Dakota': 'ND',
  'South Dakota': 'SD',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'Rhode Island': 'RI',
  'West Virginia': 'WV',
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS',
  Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', Ohio: 'OH',
  Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', Tennessee: 'TN', Texas: 'TX',
  Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', Wisconsin: 'WI',
  Wyoming: 'WY',
}

const CANDIDATE_NAME_FULL_STATE_RE = new RegExp(
  `\\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,3}), (${Object.keys(STATE_NAME_TO_ABBR).join('|')})\\b`,
  'g',
)

/** Single-word state names by abbreviation (for the FM-20 bound-state test). */
const SINGLE_WORD_STATE_NAME_BY_ABBR: ReadonlyMap<string, string> = new Map(
  Object.entries(STATE_NAME_TO_ABBR)
    .filter(([name]) => !name.includes(' '))
    .map(([name, abbr]) => [abbr, name.toLowerCase()]),
)

/**
 * Descriptive modifier words that can precede a place name in
 * findings prose without being part of the name (Lane A11 FM-20):
 * research writes "Historic Jacksonville, OR" for the town of
 * Jacksonville, and the modifier form resolves to nothing — the
 * name the research means is the place under its own name, so the
 * mention collapses to it, at extraction and at bare-mention
 * recording alike. Neither word opens a Census place name, which
 * is what makes the strip safe: there is no "Historic X" or
 * "Downtown X" in the shipped index to shadow.
 *
 * The discourse openers join the set (Lane completion K3, 2026-11-03):
 * "Only Detroit has..." glues the sentence's opener to the name the
 * same way, and the A11 sheet recorded "Only Detroit" unmatched.
 * The safety basis is identical and was re-measured for the
 * extension against the shipped payload (public/map/zcta-places.json,
 * 19,829 name strings): no place name in the index opens with Only,
 * Just, or Near either, so the unstripped form can never resolve
 * and the strip can never shadow a real place. A single-word name
 * is untouched — collapse requires two or more words, so a place
 * actually named "Only" would keep its name.
 */
const MODIFIER_PREFIX_WORDS: ReadonlySet<string> = new Set([
  'historic',
  'downtown',
  'only',
  'just',
  'near',
])

/**
 * Drop a leading descriptive modifier from a candidate name
 * ("Historic Jacksonville, OR" -> "Jacksonville, OR"; bare form
 * "Historic Jacksonville" -> "Jacksonville"). Names of fewer than
 * two bare words, and names whose first word is not a modifier,
 * pass through untouched.
 */
export function collapseModifierPrefix(name: string): string {
  const commaAt = name.indexOf(',')
  const bare = (commaAt >= 0 ? name.slice(0, commaAt) : name).trim()
  const words = bare.split(/\s+/)
  if (words.length < 2 || !MODIFIER_PREFIX_WORDS.has(words[0]!.toLowerCase())) return name
  const collapsed = words.slice(1).join(' ')
  return commaAt >= 0 ? collapsed + name.slice(commaAt) : collapsed
}

/**
 * Default extraction: "Name, ST" mentions in the findings prose, in
 * mention order, de-duplicated. Prose names without a state are not
 * extracted — a bare name cannot be resolved without guessing which
 * same-named place was meant, and guessing is what the validation
 * step below exists to prevent.
 */
export function extractCandidateNamesFromProse(prose: string): string[] {
  const names: string[] = []
  for (const match of prose.matchAll(CANDIDATE_NAME_RE)) {
    let name = `${match[1]}, ${match[2]}`
    // A sentence-final capitalized word glues to the next
    // sentence's opening name through the token's period
    // ("...in red Texas. Marfa, TX is described as..."): the
    // capture reads "Texas. Marfa", the glued form resolves to
    // nothing, and the qualifier the sentence actually names is
    // lost with it — measured on finding-per-sentence research
    // prose, where a name at a sentence start after a capitalized
    // sentence-final word is the norm, not an edge (the Texas
    // specimen's prose lost Marfa and Sebastian this way). The
    // name the sentence names is the part after the sentence
    // break; a short head ("St.", "Mt.", "Ft.") is part of the
    // place's own name and is kept whole.
    const breakAt = name.lastIndexOf('. ')
    if (breakAt >= 3) name = name.slice(breakAt + 2)
    if (!names.includes(name)) names.push(name)
  }
  // List-genre findings name places with the full state name
  // ("1. Crystal City, Texas — ..."): the enumeration is the
  // research's candidate list, and the abbreviation-only pattern
  // above reads none of it — measured on the live Texas specimen's
  // genre in Lane A9 phase 1 (FM-6: the shortlist never
  // materialized). The same glue normalization applies.
  for (const match of prose.matchAll(CANDIDATE_NAME_FULL_STATE_RE)) {
    const abbr = STATE_NAME_TO_ABBR[match[2]!]
    if (!abbr) continue
    let name = `${match[1]}, ${abbr}`
    const breakAt = name.lastIndexOf('. ')
    if (breakAt >= 3) name = name.slice(breakAt + 2)
    if (!names.includes(name)) names.push(name)
  }
  // Modifier-prefixed mentions collapse to the place's own name
  // (FM-20, above): the collapsed form is what resolution tests
  // and what the unmatched record names — "Historic Jacksonville,
  // OR" is not a second candidate beside Jacksonville.
  const collapsed: string[] = []
  for (const name of names) {
    const canonical = collapseModifierPrefix(name)
    if (!collapsed.includes(canonical)) collapsed.push(canonical)
  }
  return collapsed
}

/** Sentence openers that are never a bare candidate mention. */
const BARE_MENTION_OPENERS: ReadonlySet<string> = new Set([
  'answer', 'the', 'a', 'an', 'in', 'on', 'for', 'this', 'these', 'those',
  'it', 'there', 'taken', 'overall', 'according', 'note', 'source',
  'sources', 'research', 'findings', 'however', 'while', 'both', 'many',
  'most', 'several', 'among', 'across', 'within',
])

/**
 * The words the loaded place names themselves use, hyphen-split
 * and lower-cased — the gazetteer the extraction-precision gate
 * (Lane A10 FM-14) tests a written token against: a token is
 * place-shaped when the place index itself uses one of its words
 * inside a real place name ("petersburg" from St. Petersburg,
 * "stowe" from Stowe). The test is deterministic and updates with
 * the data; the alternative, a fragment stoplist, is open-ended
 * and rots with the prose genre.
 */
function placeNameComponentWords(rows: readonly AreaRow[]): ReadonlySet<string> {
  const words = new Set<string>()
  for (const row of rows) {
    const bare = row.name.split(',')[0]!.trim()
    for (const word of bare.split(/[\s-]+/)) {
      const w = word.toLowerCase().replace(/\.+$/, '')
      if (w) words.add(w)
    }
  }
  return words
}

/** Whether a mention the rows do not carry is still place-shaped (FM-14). */
function isPlaceShapedMention(mention: string, componentWords: ReadonlySet<string>): boolean {
  const words = mention
    .toLowerCase()
    .split(/[\s-]+/)
    .map((w) => w.replace(/\.+$/, ''))
    .filter((w) => w.length > 0)
  return words.some((w) => componentWords.has(w))
}

/** Generic place-nouns: as a whole mention they name a category, not a place. */
const GENERIC_PLACE_NOUNS: ReadonlySet<string> = new Set([
  'city', 'town', 'village', 'county', 'area', 'region', 'district', 'community', 'state',
])

/**
 * Sentence-lead words that describe rather than name, from the
 * measured specimens: a mention opening with one is prose framing
 * ("Surrounding Custer Gallatin ...", "Other Michigan towns ...",
 * "Meeting ALL the criteria ..."), never a place's own name —
 * no Census place name opens with any of them.
 */
const NON_NAME_LEAD_WORDS: ReadonlySet<string> = new Set(['surrounding', 'other', 'meeting'])

/**
 * Healthcare-organization words (the "Ballad Health Dickenson"
 * specimen): in a non-initial position they mark an organization
 * named for a region, not a place. Initial position is exempt —
 * Medical Lake, WA is a place, and its first word is the name.
 */
const ORG_CLASS_WORDS: ReadonlySet<string> = new Set(['health', 'hospital', 'medical', 'clinic'])

const STATE_ABBRS: ReadonlySet<string> = new Set(Object.values(STATE_NAME_TO_ABBR))

/**
 * Fragment shape (Lane A11 FM-20): a recorded mention can pass the
 * FM-14 place-shaped test — some word of it is a real place-name
 * component somewhere — and still be prose, not a name. The live
 * re-verification sheet on 44f90ff printed "Florida", "City",
 * "Town", "Other Michigan", "Surrounding Custer Gallatin",
 * "Ballad Health Dickenson" and "Meeting ALL" as named places.
 * Each is shape-regular, and the shapes are the ones a genuine
 * mention never takes:
 * - the asked geography's own state name standing alone (the
 *   prose is talking about the geography, not naming a place in
 *   it) — tested only against the bound states the caller passes,
 *   so a same-named town outside the bound keeps its record;
 * - a generic place-noun as the whole mention ("City", "Town");
 * - a descriptive lead word (above);
 * - an all-caps emphasis word that is not a state code ("ALL");
 * - a healthcare-organization word in non-initial position.
 * A mention none of these describes records exactly as before —
 * the genuinely ambiguous token (Livingston, Howard) still reads
 * as a name, per the FM-5/FM-14 trade. The one specimen class no
 * shape separates is the ambiguous common noun ("Hurricane",
 * recorded because two real places carry the name while the prose
 * meant the weather): it is deterministically indistinguishable
 * from a genuine ambiguous town mention at this seam and stays
 * recorded, as the phase-3 FM-20 note anticipated — semantic
 * discrimination for it is a separate, gated decision.
 */
export function isFragmentShapedMention(
  mention: string,
  boundStateNames?: ReadonlySet<string>,
): boolean {
  const rawWords = mention.split(/[\s-]+/).filter((w) => w.length > 0)
  const words = rawWords
    .map((w) => w.toLowerCase().replace(/\.+$/, ''))
    .filter((w) => w.length > 0)
  if (words.length === 0) return false
  if (words.length === 1 && boundStateNames?.has(words[0]!)) return true
  if (words.length === 1 && GENERIC_PLACE_NOUNS.has(words[0]!)) return true
  if (NON_NAME_LEAD_WORDS.has(words[0]!)) return true
  if (rawWords.some((w) => /^[A-Z]{2,}$/.test(w) && !STATE_ABBRS.has(w))) return true
  if (words.slice(1).some((w) => ORG_CLASS_WORDS.has(w))) return true
  return false
}

/**
 * The bound geography's name index for normalization (Lane A10
 * FM-16): every bound place name under its full bare form (exact)
 * and under each trailing word sequence (suffix) — "St.
 * Petersburg" is indexed at "st. petersburg", and at "petersburg".
 * Values are the distinct full row names carrying the key, so a
 * key held by two different bound places is an ambiguity to
 * record, never a guess to make.
 */
interface BoundNameIndex {
  exact: Map<string, ReadonlySet<string>>
  suffix: Map<string, ReadonlySet<string>>
}

function boundNameIndex(rows: readonly AreaRow[]): BoundNameIndex {
  const add = (map: Map<string, Set<string>>, key: string, name: string) => {
    const set = map.get(key) ?? new Set<string>()
    set.add(name)
    map.set(key, set)
  }
  const exact = new Map<string, Set<string>>()
  const suffix = new Map<string, Set<string>>()
  for (const row of rows) {
    const bare = row.name.split(',')[0]!.trim()
    if (!bare) continue
    const bareLower = bare.toLowerCase()
    add(exact, bareLower, row.name)
    const words = bareLower.split(/\s+/)
    for (let start = 1; start < words.length; start++) {
      add(suffix, words.slice(start).join(' '), row.name)
    }
  }
  return { exact, suffix }
}

type BoundCompletion = { rowName: string } | { ambiguous: true }

/**
 * Normalize one bare mention against the bound index (FM-16):
 * the written form first, then its hyphen head ("Stowe-area" is
 * tested as "Stowe-area", then as "Stowe"); at each form, an
 * exact bound name, then a suffix completion ("Petersburg" ->
 * "St. Petersburg"). A form held by two or more distinct bound
 * places completes ambiguously — recorded, not guessed. Returns
 * null when the bound index holds nothing for the mention, and
 * the caller falls through to the all-rows reading unchanged.
 * The bound-only scope is the safety property: nationally,
 * "Petersburg" also names exact rows in other states and several
 * completions, so unbound completion would guess; inside the
 * asked geography the index either holds exactly one completion
 * or the ambiguity is the honest record. Suffix matching is
 * word-aligned and trailing-only, so every prefix form the index
 * holds (St., Fort, Mount, Lake, Port) completes without a
 * prefix lexicon.
 */
function completeAgainstBound(candidate: string, index: BoundNameIndex): BoundCompletion | null {
  const tries = [candidate.toLowerCase()]
  const hyphenAt = candidate.indexOf('-')
  if (hyphenAt > 0) tries.push(candidate.slice(0, hyphenAt).toLowerCase())
  for (const t of tries) {
    const exact = index.exact.get(t)
    if (exact && exact.size > 0) {
      return exact.size === 1 ? { rowName: [...exact][0]! } : { ambiguous: true }
    }
    const suffix = index.suffix.get(t)
    if (suffix && suffix.size > 0) {
      return suffix.size === 1 ? { rowName: [...suffix][0]! } : { ambiguous: true }
    }
  }
  return null
}

/**
 * Bare-name candidate extraction (Lane A9 FM-5): findings prose
 * also names places with no state at all ("Sanibel is often praised
 * for its gentle coastal weather"), and the extraction above reads
 * none of those — the name vanishes with no record at all (phase-1
 * battery: Sanibel). The design boundary in the extraction comment
 * stands — a bare name is never GUESSED at a place — so detection
 * uses the findings genre's own shape: one place per sentence,
 * named as the sentence's subject. A sentence-initial capitalized
 * sequence is a candidate mention; mid-sentence bare mentions are
 * framing, not candidates — the anchor city in "the safest suburbs
 * of Dallas" is named in exactly that position, and resolving it
 * would rank the anchor among its own suburbs (measured in this
 * cure's first pin run: Dallas and Chicago entered the ranked
 * sets). Four outcomes, none of them a guess: the bound rows
 * carry the name exactly once (resolved), two or more times
 * (ambiguous — recorded, not resolved), or not at all — and then
 * the mention is recorded as an unmatched name only when it is
 * place-shaped (FM-14, below); a fragment is counted, not recorded.
 */
export function extractBareCandidateNames(
  prose: string,
  alreadyExtracted: readonly string[],
  rows: readonly AreaRow[],
  boundRows?: readonly AreaRow[],
): { names: string[]; ambiguous: string[]; unresolved: string[]; fragments: number } {
  const byBare = new Map<string, string[]>()
  for (const row of rows) {
    const bare = row.name.split(',')[0]!.trim()
    if (!bare) continue
    const key = bare.toLowerCase()
    const list = byBare.get(key) ?? []
    list.push(row.name)
    byBare.set(key, list)
  }
  const covered = new Set(
    alreadyExtracted.map((n) => n.split(',')[0]!.trim().toLowerCase()),
  )
  const names: string[] = []
  const ambiguous: string[] = []
  const unresolved: string[] = []
  let fragments = 0
  const componentWords = placeNameComponentWords(rows)
  // Name normalization (FM-16) tests against the bound rows when
  // the caller supplies them; without a bound there is no index
  // to normalize against and the all-rows reading below stands.
  const boundIndex = boundRows && boundRows.length > 0 ? boundNameIndex(boundRows) : null
  // The bound geography's own state names (Lane A11 FM-20): a
  // bare mention that merely restates the asked state ("Florida"
  // opening a Florida answer's findings) is prose about the
  // geography, not a candidate in it — the fragment-shape test
  // below reads the mention against these names.
  const boundStateNames = new Set<string>()
  if (boundRows) {
    for (const row of boundRows) {
      const abbr = stateSuffixOf(row.name)
      const full = abbr ? SINGLE_WORD_STATE_NAME_BY_ABBR.get(abbr) : undefined
      if (full) boundStateNames.add(full)
    }
  }
  const seen = new Set<string>()
  for (const sentence of prose.split(/(?<=[.!?])\s+/)) {
    if (/^Answer:/.test(sentence)) continue
    const lead = sentence.match(/^([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2})/)
    if (!lead) continue
    const words = lead[1]!.split(' ')
    if (words[0]!.includes("'")) continue
    // Wholeness guard (Lane completion K0, 2026-11-03): the take
    // loop below descends from the full sentence lead to shorter
    // prefixes, and a prefix can be a DIFFERENT place than the
    // lead names — the owner's specimen lead "University City"
    // found no whole-form hit, descended to "University", and
    // recorded that fragment as an ambiguous name (rows named
    // University exist in FL and MS), dismantling the multi-word
    // name the research wrote. A unique RESOLUTION on a prefix
    // stays legitimate ("New York City" descends to the exact
    // bound name New York — the prefix is the place, the last
    // word is framing), so the guard arms only the RECORDING
    // outcomes: when every word after the first is itself a
    // place-name component word and the whole lead is
    // place-shaped, an ambiguous recording made from a descended
    // prefix records the WHOLE lead instead — the mention the
    // prose actually made, unresolved exactly as the fragment
    // was, and whole for the flexible lane's provenance record.
    const wholeLead = words.join(' ').replace(/\.+$/, '')
    const guardWholeLead =
      words.length > 1 &&
      isPlaceShapedMention(wholeLead, componentWords) &&
      words
        .slice(1)
        .every((w) => componentWords.has(w.toLowerCase().replace(/\.+$/, '')))
    let settled = false
    for (let take = words.length; take >= 1; take--) {
      // A sentence-final mention keeps the sentence's period in
      // the lead capture ("Tampa." as a one-word fragment
      // sentence): the period is punctuation, not part of the
      // name — strip it before every test, so the mention can
      // complete against the bound (FM-16) and records under the
      // name itself rather than as a punctuated token (FM-20).
      const candidate = words.slice(0, take).join(' ').replace(/\.+$/, '')
      const key = candidate.toLowerCase()
      if (covered.has(key)) {
        settled = true
        break
      }
      // Bound normalization (FM-16) runs before the all-rows
      // reading: the bound is what disambiguates — "Petersburg"
      // is ambiguous nationally and exactly one completion
      // inside Florida. A completion settles the mention here;
      // no completion falls through to the all-rows reading.
      if (boundIndex) {
        const completion = completeAgainstBound(candidate, boundIndex)
        if (completion) {
          settled = true
          if (!seen.has(key)) {
            seen.add(key)
            if ('rowName' in completion) {
              if (!names.includes(completion.rowName)) names.push(completion.rowName)
            } else if (isFragmentShapedMention(candidate, boundStateNames)) {
              // The suffix index completes a generic fragment
              // ambiguously by construction — "City" is a suffix
              // of every "... City" in the bound — and this branch
              // recorded it as a name where the byBare branch
              // below counts the same shape as a fragment (Lane
              // completion K0: the owner's specimen printed
              // "City" as a named place). The FM-20 gate now
              // applies at this recording point too: fragment-
              // shaped completions count, never record.
              fragments++
            } else if (take < words.length && guardWholeLead && !seen.has(wholeLead.toLowerCase())) {
              // Wholeness guard (above): an ambiguous recording
              // from a descended prefix names the whole lead.
              seen.add(wholeLead.toLowerCase())
              ambiguous.push(wholeLead)
            } else {
              ambiguous.push(candidate)
            }
          }
          break
        }
      }
      const hits = byBare.get(key)
      if (!hits) continue
      settled = true
      if (seen.has(key)) break
      seen.add(key)
      if (hits.length === 1) names.push(hits[0]!)
      else if (isFragmentShapedMention(candidate, boundStateNames)) fragments++
      else if (take < words.length && guardWholeLead && !seen.has(wholeLead.toLowerCase())) {
        // Wholeness guard (above): the descended prefix hit two
        // or more DIFFERENT places, so it is no resolution at
        // all — the recording names the whole lead the prose
        // wrote ("University City"), not the fragment it was
        // dismantled into ("University").
        seen.add(wholeLead.toLowerCase())
        ambiguous.push(wholeLead)
      }
      else ambiguous.push(candidate)
      break
    }
    if (settled) continue
    // No bound row carries the mention. Unless the lead is a
    // sentence opener rather than a name, the mention is recorded
    // as an unmatched name only when it is place-shaped (Lane A10
    // FM-14): a word the place index itself uses inside a real
    // place name. Live research prose capitalizes far more than
    // places — sheet A (production c7a6630) harvested "Initial,
    // One, Described, January-April, Another, No", "BeerAdvocate",
    // and "Now I'll, Downtown, Known, Described, Boutique,
    // Howard., Called, Also, What, They" as candidate names and
    // printed them in the unmatched line. Fragments are not names:
    // they are counted (the card counts them, FM-17) and never
    // enter the candidate stream. A fragment token that is also
    // a real place-name component ("Howard") stays place-shaped
    // by this test — a genuinely ambiguous token reads as a name
    // rather than vanishing, the same trade FM-5 made for Sanibel.
    // Recording is relative to the LOADED index: a production
    // load carries the national place set, so a real place name
    // is testable there and records as a name; a mention the
    // loaded index cannot test is counted here and disclosed by
    // count on the card (FM-17) — accounted, never silent, and
    // never guessed into a place (the FM-5 invariant, restated
    // for the sparser loads a fixture or a scoped sweep carries).
    //
    // The recorded form is the name itself (Lane A11 FM-20): the
    // sentence's trailing period stripped and any descriptive
    // modifier collapsed, the same canonical form extraction
    // produces — and a mention that is fragment-SHAPED
    // (isFragmentShapedMention: the asked state restated, a
    // generic noun, a descriptive lead, an emphasis word, an
    // organization) is counted as a fragment even when some word
    // of it is place-shaped, because printing it as a name was
    // the re-verification sheet's defect.
    const mention = collapseModifierPrefix(words.join(' ').replace(/\.+$/, ''))
    const key = mention.toLowerCase()
    if (BARE_MENTION_OPENERS.has(words[0]!.toLowerCase())) continue
    if (seen.has(key) || covered.has(key)) continue
    seen.add(key)
    // Matching-side collapse (Lane completion K3): when a modifier
    // was stripped, the collapsed form gets the same matching
    // chances a candidate gets — the take loop tested the glued
    // form ("Only Detroit") and found nothing, but the place the
    // prose means is the collapsed name, and when that remainder
    // resolves uniquely against the bound the mention is that
    // place, not an unmatched record of it. (The standard
    // extraction path collapses before resolution by construction;
    // this branch is where the bare path catches up.) An ambiguous
    // collapsed remainder records as ambiguous under the collapsed
    // form; a fragment-shaped one counts as a fragment.
    if (mention !== wholeLead) {
      if (boundIndex) {
        const completion = completeAgainstBound(mention, boundIndex)
        if (completion) {
          if ('rowName' in completion) {
            if (!names.includes(completion.rowName)) names.push(completion.rowName)
          } else if (isFragmentShapedMention(mention, boundStateNames)) {
            fragments++
          } else {
            ambiguous.push(mention)
          }
          continue
        }
      }
      const collapsedHits = byBare.get(key)
      if (collapsedHits) {
        if (collapsedHits.length === 1) {
          names.push(collapsedHits[0]!)
        } else if (isFragmentShapedMention(mention, boundStateNames)) {
          fragments++
        } else {
          ambiguous.push(mention)
        }
        continue
      }
    }
    if (
      isPlaceShapedMention(mention, componentWords) &&
      !isFragmentShapedMention(mention, boundStateNames)
    ) {
      unresolved.push(mention)
    } else {
      fragments++
    }
  }
  return { names, ambiguous, unresolved, fragments }
}

/** Default resolution: an exact match against a loaded row's name. */
export function resolveCandidatesAgainstRows(
  names: readonly string[],
  rows: readonly AreaRow[],
): ResolvedCandidate[] {
  const resolved: ResolvedCandidate[] = []
  for (const name of names) {
    const row = rows.find((r) => r.name.toLowerCase() === name.toLowerCase())
    if (row) resolved.push({ name: row.name, zctas: [row.zcta] })
  }
  return resolved
}

/**
 * One representative row per resolved candidate, in candidate
 * order (the research order). Places count BY PLACE, not by ZIP
 * (battery B3, measured 2026-11-02: research named three places;
 * Corbin, KY resolved to both of its ZIP areas and both were
 * listed and counted — "named 4" — including a split ZIP carrying
 * no researched claim, presented under criteria it was never
 * researched for). Each candidate therefore contributes the member
 * ZIP a cited claim names outright when one does, otherwise its
 * first ZIP that is actually among the loaded rows, otherwise its
 * first ZIP in resolver order — the same one-ZIP-per-named-place
 * rule lookup resolution applies. The loaded-rows preference
 * matters: the sweep loads in chunks, so a place's first ZIP in
 * index order may not be loaded while a later one is (the
 * live-path fixture loads Corbin's 40771, not its 40701 — picking
 * 40701 unconditionally would drop a researched place from the
 * card entirely, a worse failure than the split it cures). Shared
 * by the research-first compose and the run-progress derivation
 * (Lane A7): the interim candidates are the same places the
 * terminal card will carry — one selection, two renderings.
 */
export function representativeCandidateRows(
  resolved: readonly ResolvedCandidate[],
  claims: readonly ResearchedClaim[],
  rows: readonly AreaRow[],
): AreaRow[] {
  const loadedZctas = new Set(rows.map((row) => row.zcta))
  const representativeZctas: string[] = []
  for (const candidate of resolved) {
    const claimed = candidate.zctas.find(
      (z) => loadedZctas.has(z) && claims.some((claim) => claim.text.includes(z)),
    )
    const representative =
      claimed ?? candidate.zctas.find((z) => loadedZctas.has(z)) ?? candidate.zctas[0]
    if (representative && !representativeZctas.includes(representative)) {
      representativeZctas.push(representative)
    }
  }
  const representativeSet = new Set(representativeZctas)
  const candidateRows = rows.filter((row) => representativeSet.has(row.zcta))
  // Extraction order is the research order; rows arrive in load
  // order, so re-order by the resolved candidate sequence.
  const order = new Map<string, number>()
  representativeZctas.forEach((z, i) => order.set(z, i))
  candidateRows.sort((a, b) => (order.get(a.zcta) ?? 0) - (order.get(b.zcta) ?? 0))
  return candidateRows
}

/* ------------------------------------------------------------------ */
/* Geography binding for research-first candidates (Lane A10 FM-15)    */
/* ------------------------------------------------------------------ */

/**
 * The bound a question's geographies impose on research-first
 * candidates, in the two forms a caller can supply it: the ZCTA set
 * the caller's resolution produced (the same set the Census screen
 * itself bounds by — screenRows reads it identically), or, when no
 * set was passed, the state bounds derivable from the intent's own
 * geography strings (ZIP geographies give a ZCTA bound; state
 * geographies, every one of them, give a state bound). Anything
 * else — placeless, or a place/county bound with no resolved set —
 * derives no bound here and keeps the caller's set as the only
 * binding, exactly as before this cure.
 */
export interface CandidateBound {
  zctas: ReadonlySet<string> | null
  states: ReadonlySet<string> | null
}

function stateAbbrOfGeography(geography: string): string | null {
  const g = geography.trim()
  if (/^[A-Za-z]{2}$/.test(g)) {
    const abbr = g.toUpperCase()
    return STATE_NAME_BY_CODE[abbr] !== undefined ? abbr : null
  }
  const direct = STATE_NAME_TO_ABBR[g]
  if (direct) return direct
  const lower = g.toLowerCase()
  for (const [name, abbr] of Object.entries(STATE_NAME_TO_ABBR)) {
    if (name.toLowerCase() === lower) return abbr
  }
  return null
}

/** The state suffix of a "Name, ST" place name, or null. */
function stateSuffixOf(name: string): string | null {
  const match = /, ([A-Z]{2})$/.exec(name.trim())
  return match ? match[1]! : null
}

export function candidateBoundForInput(input: {
  intent: ValidatedIntent
  geographyZctas?: ReadonlySet<string>
}): CandidateBound {
  if (input.geographyZctas && input.geographyZctas.size > 0) {
    return { zctas: input.geographyZctas, states: null }
  }
  const geographies = input.intent.geographies
  if (geographies.length > 0 && geographies.every((g) => /^\d{5}$/.test(g.trim()))) {
    return { zctas: new Set(geographies.map((g) => g.trim())), states: null }
  }
  if (geographies.length > 0 && geographies.every((g) => isStateGeography(g))) {
    const states = new Set<string>()
    for (const g of geographies) {
      const abbr = stateAbbrOfGeography(g)
      if (abbr) states.add(abbr)
    }
    if (states.size > 0) return { zctas: null, states }
  }
  return { zctas: null, states: null }
}

/**
 * Geography binding (Lane A10 FM-15): resolution tests candidate
 * names against the national place index / the full loaded row
 * set, so a name the research prose carries for another state
 * resolves exactly as readily as an in-bound one — and until this
 * cure nothing downstream checked the bound at all. Measured live
 * (sheet A, production c7a6630): "Which town in Michigan has the
 * most fun things to do?" carded Ford, KS 67842 with a rent figure,
 * a confident figured answer to a different geography than the
 * reader asked about. The binding runs at the one choke point
 * every materialization path passes — after resolution, before
 * representative-row selection — so the bare-name, full-state,
 * comma-state, and representative-ZIP paths are all bound by the
 * same test, at the terminal compose and at the interim progress
 * derivation alike. Under a ZCTA bound a candidate keeps only its
 * in-bound ZCTAs (a multi-state name contributes its in-bound
 * instance); under a state bound the candidate's own state — from
 * its name's suffix, or from a loaded row carrying one of its
 * ZCTAs — decides. A candidate with nothing in-bound never cards:
 * it is returned in outOfBound and recorded on the answer, never
 * silently dropped and never repaired into the bound.
 */
export function bindResolvedCandidates(
  resolved: readonly ResolvedCandidate[],
  bound: CandidateBound,
  rows: readonly AreaRow[],
): { bound: ResolvedCandidate[]; outOfBound: string[] } {
  if (!bound.zctas && !bound.states) return { bound: [...resolved], outOfBound: [] }
  const rowStateByZcta = bound.states
    ? new Map(rows.map((r) => [r.zcta, stateSuffixOf(r.name)] as const))
    : null
  const kept: ResolvedCandidate[] = []
  const outOfBound: string[] = []
  for (const candidate of resolved) {
    if (bound.zctas) {
      const inside = candidate.zctas.filter((z) => bound.zctas!.has(z))
      if (inside.length === 0) outOfBound.push(candidate.name)
      else if (inside.length === candidate.zctas.length) kept.push(candidate)
      else kept.push({ ...candidate, zctas: inside })
      continue
    }
    const nameState = stateSuffixOf(candidate.name)
    const inBound =
      (nameState !== null && bound.states!.has(nameState)) ||
      candidate.zctas.some((z) => {
        const s = rowStateByZcta!.get(z)
        return s !== null && s !== undefined && bound.states!.has(s)
      })
    if (inBound) kept.push(candidate)
    else outOfBound.push(candidate.name)
  }
  return { bound: kept, outOfBound }
}

/* ------------------------------------------------------------------ */
/* Breadth display set (breadth mode)                                  */
/* ------------------------------------------------------------------ */

/**
 * A breadth run's display set: every DISTINCT place among the
 * bound rows, one representative row per place — the member row
 * with the largest published population (a place counts once, by
 * place, the B3 rule; ties break by ZCTA so the choice is
 * deterministic), ordered by population descending, then name,
 * then ZCTA. The order is an ASSESSMENT order only — which places
 * the batch passes reach first when the pass structure exhausts —
 * never a ranking: the map colors standings, not size, and the
 * card's order comes from the standings. The set's size is the
 * denominator every breadth surface states (Texas measured
 * 1,282 distinct places in the shipped index, 2026-11-03).
 */
export function breadthDisplaySet(
  rows: readonly AreaRow[],
): { name: string; zcta: string }[] {
  const populationOf = (row: AreaRow): number => {
    const value = row.metrics['population']
    return typeof value === 'number' && Number.isFinite(value) ? value : -1
  }
  const representative = new Map<string, AreaRow>()
  for (const row of rows) {
    const current = representative.get(row.name)
    if (!current) {
      representative.set(row.name, row)
      continue
    }
    const challenger = populationOf(row)
    const holder = populationOf(current)
    if (challenger > holder || (challenger === holder && row.zcta < current.zcta)) {
      representative.set(row.name, row)
    }
  }
  return [...representative.values()]
    .map((row) => ({ name: row.name, zcta: row.zcta }))
    .sort(
      (a, b) =>
        populationOf(representative.get(b.name)!) - populationOf(representative.get(a.name)!) ||
        a.name.localeCompare(b.name, 'en') ||
        a.zcta.localeCompare(b.zcta),
    )
}

/* ------------------------------------------------------------------ */
/* Claim-level prose refusal (P3 step 9)                               */
/* ------------------------------------------------------------------ */

/**
 * A ranking word in a non-ranking idiom: "avoid the worst of the
 * Highway 17 peak" ranks nothing — the superlative is the object of
 * a condition phrase, not a predication over a place. The shipped
 * word-level scan refused an ENTIRE research result over that
 * sentence (battery A-cluster note: context_blind_prose_refusal).
 * The exemption is narrow and structural: an idiom frame (avoid /
 * worst of the / best of the / make the best of) AND no place
 * predication ("X is the best/worst", "the best/worst place/town/…")
 * in the same sentence.
 */
const RANKING_IDIOM_RE =
  /\b(?:avoid|worst of the|best of the|make the best of|worst of a)\b/i
const PLACE_PREDICATION_RE =
  /\b(?:is|are|was|were)\s+the\s+(?:best|worst|finest|greatest|nicest)\b|\b(?:best|worst|finest|greatest|nicest)\s+(?:place|town|city|area|neighbourhood|neighborhood|district|community|county|state)\b/i

/** The banned-construction label for one sentence, or null when the
 * sentence is clean at claim level (criteria-grounded context, with
 * the non-ranking idiom exemption above). */
export function claimBannedLabel(sentence: string): string | null {
  const label = findBannedConstruction(sentence, { criteriaGrounded: true })
  if (label !== 'ranking') return label
  if (RANKING_IDIOM_RE.test(sentence) && !PLACE_PREDICATION_RE.test(sentence)) return null
  return label
}

/**
 * Split prose into sentences and drop only the offending ones
 * (P3 step 9): a banned construction costs its own sentence, never
 * the whole result, when the rest verifies. Returns the kept prose
 * and the dropped sentences so the drop is auditable, never silent.
 */
export function filterBannedSentences(prose: string): { prose: string; dropped: string[] } {
  const sentences = prose
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const kept: string[] = []
  const dropped: string[] = []
  for (const sentence of sentences) {
    if (claimBannedLabel(sentence)) dropped.push(sentence)
    else kept.push(sentence)
  }
  return { prose: kept.join(' '), dropped }
}

/* ------------------------------------------------------------------ */
/* Working-narration refusal (prose hygiene, 2026-11-03)              */
/* ------------------------------------------------------------------ */

/**
 * The research model's WORKING text is not findings: first-person
 * process narration ("I'll check the remaining towns next."),
 * interim progress lines ("Marfa and Crystal City show liberal
 * leanings so far."), meta statements about the research act
 * ("Research covered the first 10 candidate places…"), question
 * echoes, apparatus explanations, raw internal vocabulary (metric
 * keys), and markdown scaffolding (bold markers, "Answer:"
 * lead-ins, colon-terminated header lines). The Texas specimen
 * (owner device, 2026-11-03) rendered every one of those classes
 * verbatim as answer claims, with the actual conclusion buried
 * among them wearing its "**Answer:**" scaffolding. The banned-
 * construction scan above cannot see this class — narration is
 * grammatical, cited, and about no place — so compose applies this
 * filter beside it: narration segments are dropped and recorded
 * in droppedClaims like any other compose drop, kept segments are
 * stripped of scaffolding, and a segment carrying a cited source's
 * raw title is dropped whole (titles render once, as links —
 * AnswerCard's claimSourceVisibility — never as prose).
 */
const NARRATION_PROCESS_VERB_RE =
  /\b(?:check|gather|map|look|search|examin|review|verif|compar|assess|investigat|research|compil|confirm|explor)\w*\b/i
// Apostrophe forms: both the straight and the typographic
// apostrophe match (Lane completion K9 — model prose writes the
// first person either way, and the curly form escaped every
// first-person pattern here while the straight form was dropped).
const NARRATION_FIRST_PERSON_RE =
  /\bI(?:['\u2019]ll| will| have|['\u2019]ve| am|['\u2019]m|['\u2019]d| would)\b/
const NARRATION_FIRST_PERSON_PAST_RE =
  /\bI\s+(?:checked|gathered|mapped|looked|searched|examined|reviewed|verified|compared|assessed|investigated|researched)\b/i
const NARRATION_PROGRESS_RE =
  /\b(?:show|shows|showed|showing|found|lean|leans|leaning|stand|stands|results?)\b[^.!?]*\bso far\b/i
/**
 * Interim-state assertions (Lane completion K1, 2026-11-03): a
 * segment whose subject is the research's own preliminary state
 * — "Initial results point to Austin." on the R21 Texas terminal
 * — reports the RUN's intermediate standing, not a finding about
 * a place; the finding form names the place as its subject
 * ("Austin is described as..."). The shape needs both halves:
 * the interim subject (initial/early/preliminary results or
 * findings) and a direction verb (point/suggest/indicate/show/
 * lean/favor), so a source-reporting sentence ("Initial findings
 * from the county survey recorded...") survives.
 */
const NARRATION_INTERIM_RE =
  /\b(?:initial|early|preliminary)\s+(?:results?|findings?)\b[^.!?]*\b(?:points?|suggests?|indicates?|shows?|leans?|favou?rs?)\b/i
const NARRATION_META_RE =
  /\bresearch covered the first\b|\bwere not researched\b|\bnot addressed here\b|\bno web support found for\b|\bper pre-screening\b|\bfigures are shown separately\b|\bnot from the web\b/i
const RAW_METRIC_KEY_RE =
  /\b(?:median_gross_rent|median_household_income|median_home_value|median_rent_burden_pct|no_internet_access)\b/

function isWorkingNarration(segment: string, sources: readonly AnswerSource[]): boolean {
  // A colon-terminated segment is a lead-in header by construction
  // in this prose genre ("**What sources say about political
  // character — liberal:**", "Crystal City, TX — meets liberal +
  // Census, strongest support as most liberal:"): the finding it
  // introduces rides in the segments after it.
  if (segment.endsWith(':')) return true
  if (NARRATION_FIRST_PERSON_PAST_RE.test(segment)) return true
  if (NARRATION_FIRST_PERSON_RE.test(segment) && NARRATION_PROCESS_VERB_RE.test(segment)) {
    return true
  }
  if (/^Let(?:['\u2019]s| us| me)\b/i.test(segment)) return true
  if (NARRATION_PROGRESS_RE.test(segment)) return true
  if (NARRATION_INTERIM_RE.test(segment)) return true
  if (NARRATION_META_RE.test(segment)) return true
  if (/^Question:/i.test(segment)) return true
  if (RAW_METRIC_KEY_RE.test(segment)) return true
  const lower = segment.toLowerCase()
  return sources.some(
    // A title counts as a raw-title leak only when it is long
    // enough to be a concatenation rather than an ordinary noun
    // phrase: measured collision — the Hilo pin's source is
    // titled "Store listing" (13 chars) and its prose says "per
    // the cited store listing" as plain citation language, which
    // a 12-char threshold dropped wholesale (the coffee criterion
    // fell to not_measurable). The specimen's leaked title ran
    // ~100 chars; the line is set at 24.
    (source) => source.title.length >= 24 && lower.includes(source.title.toLowerCase()),
  )
}

/**
 * Split research prose into segments (sentences and lines — the
 * research genre is markdown-ish, so a bullet line is a segment),
 * drop the working-narration segments, and strip scaffolding from
 * the kept ones: bullet markers, bold markers, and the "Answer:" /
 * "Conclusion:" / "Summary:" lead-in labels a synthesis segment
 * wears. The conclusion itself is a finding and survives —
 * de-scaffolded.
 */
export function filterWorkingNarration(
  prose: string,
  sources: readonly AnswerSource[],
): { prose: string; dropped: string[] } {
  const segments = prose
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const kept: string[] = []
  const dropped: string[] = []
  for (const rawSegment of segments) {
    const segment = rawSegment
      .replace(/^\*\s+/, '')
      .replace(/\*\*/g, '')
      .trim()
    if (segment.length === 0) continue
    if (isWorkingNarration(segment, sources)) {
      dropped.push(segment)
      continue
    }
    kept.push(segment.replace(/^(?:Answer|Conclusion|Summary):\s*/i, ''))
  }
  return { prose: kept.join(' '), dropped }
}

/* ------------------------------------------------------------------ */
/* Per-criterion evidence                                              */
/* ------------------------------------------------------------------ */

/**
 * The reader-facing label for a stored criterion value: a metric key
 * maps to the registry's plain label for it (median_gross_rent ->
 * "Median gross rent", the same label plain-labels.ts serves the UI
 * from this registry), and a value with no registry entry — a
 * researched criterion's label, "County-level geography" — passes
 * through unchanged. Used ONLY where a criterion value is composed
 * into prose or rendered: the stored field stays the key (see
 * CriterionEvidence), because spoken-answer.ts matches on it.
 */
export function criterionDisplayLabel(criterion: string): string {
  return METRIC_DEFS_BY_KEY.get(criterion)?.label ?? criterion
}

const NUMERAL_IN_CLAIM_RE =
  /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i

/** Evidence that supports a safety criterion's DIRECTION (levels,
 * rates, comparisons) rather than merely mentioning crime data. */
const SAFETY_DIRECTION_RE =
  /\b(?:low|lower|below|declin\w*|reduced?|rate of|per capita|safer|safest|few(?:er)? (?:crimes|incidents|offen[cs]es))\b/i

/**
 * Markers that a claim describes its place as NOT meeting the
 * criterion it serves (Lane A9 FM-4 — candidate-direction
 * blindness, measured across nine phase-1 battery runs: places the
 * research itself describes with "fewer", "thinner", "higher
 * reported crime", "limited access", "only moderately", "less
 * often described as", "significant flood risk", or "the most
 * seasonal variation" entered the ranked entries as ordinary
 * places, because place inclusion had no direction rule at all —
 * the safety criterion had one for evidence STATUS only). The set
 * is deliberately conservative and auditable: explicit inferiority
 * comparisons ("than the leaders / the safest"), scarcity words
 * (fewer / thinner / limited / scarce), qualified middling states
 * ("only moderately" — bare "moderately" and bare "mixed" are NOT
 * markers: Savannah's "moderately liberal", Newport's "mixed flood
 * exposure", and Macon's "politically mixed" all stayed ranked in
 * the measured readings, correctly), bad-pole assertions for risk
 * criteria, and the weather genre's bad pole ("most seasonal
 * variation"). A place is direction-negative only when EVERY claim
 * serving a criterion carries a marker — one positive or neutral
 * serving claim keeps it ranked.
 */
export const CLAIM_DIRECTION_AGAINST_RE =
  /\bfewer\b|\bthinner\b|\blimited\b|\bscarce\b|\bthan the (?:leaders|best|safest|top)\b|\bonly moderately\b|\bless often\b|\bmost\s+\w*\s*variation\b|\b(?:significant|highest|severe|elevated|high)\s+(?:flood\s+)?risk\b|\bhigher reported crime\b/i

/** Whether every claim serving any researched criterion, among a
 * place's claims, carries a direction-against marker. A place with
 * no serving claim at all is not negative — absence of a claim is
 * not a negation. */
export function placeDirectionNegative(
  claims: readonly ResearchedClaim[],
  criteria: readonly ResearchCriterion[],
): boolean {
  const serving = claims.filter((claim) =>
    criteria.some((criterion) => claimServesCriterion(claim, criterion)),
  )
  if (serving.length === 0) return false
  return serving.every((claim) => CLAIM_DIRECTION_AGAINST_RE.test(claim.text))
}

export function claimServesCriterion(claim: ResearchedClaim, criterion: ResearchCriterion): boolean {
  if (criterion.id === 'combined') return true
  const entry = RESEARCH_CRITERION_CATALOG.find((e) => e.id === criterion.id)
  if (!entry) return claim.sourceUrls.length > 0
  const lower = claim.text.toLowerCase()
  return entry.keywords.some((keyword) => lower.includes(keyword))
}

/* ------------------------------------------------------------------ */
/* Breadth standing derivation (breadth mode)                          */
/* ------------------------------------------------------------------ */

/**
 * The poles a criterion falls back to when decomposition attached
 * none (a caller-supplied criterion list reaches the pipeline
 * without decomposition): keywords mode over no terms, which the
 * standing derivation reads as "the serving test alone, with the
 * FM-4 direction markers" — the weakest characterization the
 * machinery ever applies, and breadth's shape gate refuses it
 * (breadthShapeFor requires parsed poles), so it can only ever
 * serve a direct placeStanding caller's fallback.
 */
const FALLBACK_POLES: CriterionPoles = {
  mode: 'keywords',
  positiveTerms: [],
  negativeTerms: [],
  positiveLabel: 'Meets the description',
  negativeLabel: 'Does not meet the description',
  mixedLabel: 'Described both ways',
}

/** Whether the text negates a pole term nearby ("not liberal",
 * "least liberal", "not very liberal"): a negated positive is
 * negative evidence, never positive. The window is two words —
 * wide enough for the intensifier, narrow enough that a term
 * across a clause boundary is not read as negated. */
function negatedTermIn(lowerText: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${'{}'}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `\\b(?:not|never|hardly|least|no longer)\\s+(?:\\w+\\s+){0,2}?${escaped}\\b`,
  ).test(lowerText)
}

/**
 * How ONE sourced claim characterizes its place on the criterion,
 * or null when it does not characterize it at all. The claim must
 * serve the criterion first (claimServesCriterion — for the
 * combined class that is every cited claim, which is exactly why
 * terms mode then requires a pole term: serving is not
 * characterizing for a characterization criterion). In terms
 * mode a pole-negative term or an FM-4 against marker is
 * negative evidence and a pole-positive term is positive, with
 * negation flipping a positive term to negative. In keywords
 * mode the keyword presence is the positive characterization
 * and an against marker is the negative one — FM-4's own rule,
 * read per claim.
 */
export function claimCharacterization(
  claim: ResearchedClaim,
  criterion: ResearchCriterion,
): 'positive' | 'negative' | 'mixed' | null {
  if (!claimServesCriterion(claim, criterion)) return null
  const poles = criterion.poles ?? FALLBACK_POLES
  if (poles.mode === 'keywords') {
    return CLAIM_DIRECTION_AGAINST_RE.test(claim.text) ? 'negative' : 'positive'
  }
  const lower = claim.text.toLowerCase()
  const positive =
    poles.positiveTerms.some((term) => termIn(lower, term)) &&
    !poles.positiveTerms.some((term) => negatedTermIn(lower, term))
  const negative =
    poles.negativeTerms.some((term) => termIn(lower, term)) ||
    poles.positiveTerms.some((term) => negatedTermIn(lower, term)) ||
    CLAIM_DIRECTION_AGAINST_RE.test(claim.text)
  if (positive && negative) return 'mixed'
  if (positive) return 'positive'
  if (negative) return 'negative'
  return null
}

/**
 * A place's breadth standing from the sourced claims attributed
 * to it: positive when a characterizing claim places it at the
 * criterion's positive pole and none places it against, negative
 * for the mirror, mixed when sourced claims characterize it both
 * ways, and unassessed when no sourced claim characterizes it at
 * all — the class that keeps an unmentioned place uncolored. A
 * pure function of the claim SET: invariant under claim order
 * and candidate order by construction.
 */
export function placeStanding(
  claims: readonly ResearchedClaim[],
  criterion: ResearchCriterion,
): BreadthStanding {
  let positive = false
  let negative = false
  for (const claim of claims) {
    const characterization = claimCharacterization(claim, criterion)
    if (characterization === 'positive') positive = true
    else if (characterization === 'negative') negative = true
    else if (characterization === 'mixed') {
      positive = true
      negative = true
    }
  }
  if (positive && negative) return 'mixed'
  if (positive) return 'positive'
  if (negative) return 'negative'
  return 'unassessed'
}

/** The legend labels for a criterion's standings, by render phase. */
export function breadthLabelsFor(
  criterion: ResearchCriterion,
  phase: 'interim' | 'terminal',
): BreadthLabels {
  const poles = criterion.poles ?? FALLBACK_POLES
  return {
    positive: poles.positiveLabel,
    negative: poles.negativeLabel,
    mixed: poles.mixedLabel,
    unassessed: phase === 'interim' ? 'Not yet assessed' : 'Not assessed',
  }
}

/** The criterion name a breadth surface states: the poles' dimension title when parsed, else the criterion's label. */
export function breadthCriterionLabel(criterion: ResearchCriterion): string {
  return criterion.poles?.title ?? criterion.label
}

/**
 * Evidence per stated criterion, computed from what the answer
 * actually carries — screened places for Census criteria, cited
 * claims for researched ones. A count-seeking criterion served only
 * by qualitative claims is partially_measured: the source is named
 * through its URLs, and its wording stays qualitative.
 */
/**
 * The affordability anchor derived from a stated salary (P3b cure
 * 3, battery A4): 30 percent of the stated annual figure — the
 * standard affordability share — expressed as a monthly rent anchor.
 * The anchor is arithmetic on the reader's own figure, named as
 * derived wherever it is shown; it is never a Census measure and it
 * never becomes a screen bound the reader did not state. Returns
 * null when the text carries no parseable dollar figure.
 */
export function salaryAnchorFor(text: string | undefined): { salary: string; anchor: string } | null {
  if (!text) return null
  const match = /\$\s?([\d,]+(?:\.\d+)?)\s?(k)?\b/i.exec(text)
  if (!match) return null
  const amount = Number(match[1]!.replace(/,/g, '')) * (match[2] ? 1000 : 1)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const format = (value: number) =>
    `$${Math.round(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return { salary: format(amount), anchor: format((amount * 0.3) / 12) }
}

export function criterionEvidenceFor(input: {
  criteria: readonly ScreenCriterion[]
  droppedCriteria: readonly DroppedCriterion[]
  researchCriteria: readonly ResearchCriterion[]
  places: readonly AnswerPlace[]
  claims: readonly ResearchedClaim[]
  unsupportedGeography: string | null
  /** True when a county answer was composed from the crosswalk. */
  countySupported?: boolean
  /** A requested figure that cannot be aggregated to county level, when one was. */
  countyFigureNotMeasurable?: string | null
  /** The reader's question text, for stated criteria no layer serves. */
  queryText?: string
  /**
   * Labels of researched criteria whose research pass failed while
   * sibling passes returned material (ResearchStageResult
   * .failedCriteria). Their evidence entry states the lookup did
   * not return, rather than reading as if research ran and no
   * source spoke to the criterion.
   */
  failedResearchCriteria?: readonly string[]
  /**
   * True when the research stage re-asked its all-empty first
   * attempt once (FM-11): a failed criterion's detail then states
   * the re-ask, so the note does not read as a single unanswered
   * call.
   */
  researchReAsked?: boolean
}): CriterionEvidence[] {
  const evidence: CriterionEvidence[] = []
  for (const criterion of input.criteria) {
    evidence.push({
      criterion: criterion.metricKey,
      kind: 'census',
      status: input.places.length > 0 ? 'met' : 'not_measurable',
      detail:
        input.places.length > 0
          ? 'Measured from Census figures shown for each named place.'
          : 'No named place carries a Census figure for this criterion.',
      sourceUrls: [],
    })
  }
  for (const dropped of input.droppedCriteria) {
    evidence.push({
      criterion: dropped.metricKey,
      kind: 'census',
      status: 'not_measurable',
      detail: 'This bound cannot be expressed by the screening surface, so it was not applied.',
      sourceUrls: [],
    })
  }
  if (input.unsupportedGeography === 'county') {
    evidence.push({
      criterion: 'County-level geography',
      kind: 'census',
      status: 'not_measurable',
      detail:
        'County-level figures are not available from the shipped data, which is place and ZIP level; the places shown are at that level instead.',
      sourceUrls: [],
    })
  }
  if (input.countySupported) {
    evidence.push({
      criterion: 'County-level geography',
      kind: 'census',
      status: input.places.length > 0 ? 'met' : 'not_measurable',
      detail: COUNTY_AGGREGATION_METHOD,
      sourceUrls: [],
    })
    if (input.countyFigureNotMeasurable) {
      evidence.push({
        criterion: input.countyFigureNotMeasurable,
        kind: 'census',
        status: 'not_measurable',
        detail:
          'This figure cannot be aggregated to county level from ZIP-area figures, so no county figure is shown for it.',
        sourceUrls: [],
      })
    }
  }
  for (const criterion of input.researchCriteria) {
    // Decomposed criteria are Census-served (P3 step 3): the
    // criterion is ASSESSED on the card from the metric's figure on
    // each shown place — met when the places the answer ranks on
    // the metric carry the figure, not measurable when none does.
    // Coverage alone no longer makes it partial (owner live
    // failure, 2026-11-03): the shipped rule counted every row of
    // a several-hundred-row screen, so a state answer whose tail
    // rows lack a published rent figure stamped its designed cost
    // measure "partially measured" — coverage noise over places
    // the answer does not rank on the measure, not the criterion's
    // service. Places without a published figure are not ranked on
    // the measure, and the detail says so. The one partial that
    // remains is a DIRECTION failure — a shown place the
    // criterion's own reading fails (the internet share rule
    // below) — which is substantive, not coverage. The direction
    // is stated in the detail: for no_internet_access a lower
    // figure is better access; the figure itself is the assessment,
    // never a prose claim about it.
    // Salary (P3b cure 3, battery A4): the criterion is ACCOUNTED,
    // never silently dropped — the reader's figure and the rent
    // anchor derived from it are both visible in the detail. The
    // status stays not_measurable: no Census figure converts a
    // stated income into an affordability verdict, and a cited
    // guide calling a place "lower-cost" does not measure the
    // reader's salary either, so the research-claims path below
    // never labels it met. The anchor exists so the rent figure on
    // each shown place can be read against the reader's own number.
    if (criterion.id === 'salary') {
      const derived = salaryAnchorFor(criterion.text)
      evidence.push({
        criterion: criterion.label,
        kind: 'research',
        status: 'not_measurable',
        detail: derived
          ? `The stated salary of ${derived.salary} a year is recorded here with a rent anchor of ${derived.anchor} a month — 30 percent of the stated salary, the standard affordability share — derived from the reader's own figure, not from Census data. No Census figure converts a stated income into an affordability verdict, so the salary itself is not measured; the rent figures on each place can be read against the anchor.`
          : 'A stated income is recorded here, but its figure could not be read, so no affordability anchor is derived from it and the income itself is not measured.',
        sourceUrls: [],
      })
      continue
    }
    if (criterion.decomposedMetricKey) {
      const key = criterion.decomposedMetricKey
      const carrying = input.places.filter((p) => p.figures.some((f) => f.key === key)).length
      // Internet access (P3b cure 2, battery C5): figure presence
      // alone labelled every shown place "met" — including a place
      // where 4,000 of 8,000 households have no internet access,
      // under a summary claiming all stated criteria were met. When
      // a place carries both figures, the share decides: more than
      // a quarter of households without internet access does not
      // meet a good-internet-access criterion. A place without a
      // households figure cannot be share-assessed and keeps the
      // presence reading, exactly as before this cure.
      const failingInternet =
        key === 'no_internet_access'
          ? input.places.filter((place) => {
              const noInternet = place.figures.find((f) => f.key === key)?.value
              const households = place.figures.find((f) => f.key === 'households')?.value
              return (
                noInternet !== undefined &&
                households !== undefined &&
                households > 0 &&
                noInternet / households > 0.25
              )
            }).length
          : 0
      const unranked = input.places.length > carrying
      evidence.push({
        criterion: criterion.label,
        kind: 'census',
        status:
          carrying === 0
            ? 'not_measurable'
            : failingInternet > 0
              ? 'partially_measured'
              : 'met',
        detail:
          key === 'no_internet_access'
            ? failingInternet > 0
              ? 'Assessed from the Census figures shown for each place: a place where more than a quarter of households have no internet access does not meet a good internet access criterion, and at least one shown place is above that share, so the criterion is not met for every shown place.'
              : `Assessed from the Census figure for households with no internet access shown for each place; a lower figure means better internet access.${unranked ? ' Places without a published figure for it are not assessed on it.' : ''}`
            : `Assessed from the Census cost figures shown for each place, read on median gross rent as the headline cost measure.${unranked ? ' Places without a published rent figure are not ranked on that measure.' : ''}`,
        sourceUrls: [],
      })
      continue
    }
    const serving = input.claims.filter(
      (claim) => claim.sourceUrls.length > 0 && claimServesCriterion(claim, criterion),
    )
    const sourceUrls = [...new Set(serving.flatMap((claim) => claim.sourceUrls))]
    if (serving.length === 0) {
      evidence.push({
        criterion: criterion.label,
        kind: 'research',
        status: 'not_measurable',
        detail: (input.failedResearchCriteria ?? []).includes(criterion.label)
          ? input.researchReAsked
            ? 'The research lookup for this criterion did not return; it was asked twice in this run and neither attempt returned, so no cited source speaks to it here.'
            : 'The research lookup for this criterion did not return, so no cited source speaks to it here.'
          : 'No cited source available here speaks to this criterion.',
        sourceUrls: [],
      })
    } else if (input.places.length === 0) {
      // No-place lookup outcome (Lane A10 FM-18): the research
      // returned material that serves this criterion, but the
      // answer names no places — on the sheet-A specimens
      // (VA healthcare, FL weather) none of the places the
      // research named could be matched to Census data, so the
      // terminal is the did-not-name card. The "met" stamp
      // ("shown with the places") would describe an answer that
      // does not exist; the honest status is the lookup outcome.
      // Cards that name places keep the "met" stamp below. This
      // branch reads the same pre-partition places the census
      // branch above reads — evidence is composed before the
      // FM-4 direction partition, by design. The detail text is a
      // shared constant (NO_PLACE_LOOKUP_DETAIL) because the UI
      // runner restamps exactly these entries when the flexible
      // completion lands (Lane completion K0): a completed card
      // shows places, so the no-place outcome must not stand
      // beside them.
      evidence.push({
        criterion: criterion.label,
        kind: 'research',
        status: 'not_measurable',
        detail: NO_PLACE_LOOKUP_DETAIL,
        sourceUrls,
      })
    } else if (criterion.id === 'safety' && !serving.some((claim) => SAFETY_DIRECTION_RE.test(claim.text))) {
      // Direction-of-fit (P3 step 5, battery D7): "low crime" is
      // measured only by evidence about crime LEVELS — a source
      // stating that crime statistics are published or summarised
      // mentions the criterion without supporting its direction, so
      // the honest label is partially measured, with the reason.
      evidence.push({
        criterion: criterion.label,
        kind: 'research',
        status: 'partially_measured',
        detail:
          'A cited source mentions crime statistics for this criterion but does not show crime is low, so the direction the criterion asks for is not measured.',
        sourceUrls,
      })
    } else if (criterion.quantitative && !serving.some((claim) => NUMERAL_IN_CLAIM_RE.test(claim.text))) {
      evidence.push({
        criterion: criterion.label,
        kind: 'research',
        status: 'partially_measured',
        detail:
          'A cited source speaks to this criterion in qualitative terms only, so no count is shown for it.',
        sourceUrls,
      })
    } else {
      evidence.push({
        criterion: criterion.label,
        kind: 'research',
        status: 'met',
        detail: 'Served by the cited sources shown with the places.',
        sourceUrls,
      })
    }
  }
  // Criterion-slot accounting (P3 step 3, battery A4): a stated
  // income the reader asks to "live well on" has no slot in any
  // layer — nothing converts it to an affordability reading — so it
  // is recorded not_measurable and named, never silently dropped
  // beside the places that were shown.
  if (
    input.queryText &&
    /\$\s?\d[\d,]*(?:\s?k)?\b/i.test(input.queryText) &&
    /\b(?:salary|income|a year|per year|live well|afford)\b/i.test(input.queryText) &&
    !evidence.some((e) => e.criterion === 'Affordability on the stated income')
  ) {
    // Same accounting as the catalog salary entry above (P3b cure
    // 3): the figure and its derived anchor are visible, so a
    // caller that supplied its own criterion list cannot strand
    // the salary in the older, figure-free wording.
    const derived = salaryAnchorFor(input.queryText)
    evidence.push({
      criterion: 'Affordability on the stated income',
      kind: 'research',
      status: 'not_measurable',
      detail: derived
        ? `The stated salary of ${derived.salary} a year is recorded here with a rent anchor of ${derived.anchor} a month — 30 percent of the stated salary, the standard affordability share — derived from the reader's own figure, not from Census data. No Census figure converts a stated income into an affordability verdict, so the salary itself is not measured; the rent figures on each place can be read against the anchor.`
        : 'No figure here converts a stated income into an affordability reading, so that part of the question is not measured.',
      sourceUrls: [],
    })
  }
  return evidence
}

/* ------------------------------------------------------------------ */
/* Stage 4: compose                                                    */
/* ------------------------------------------------------------------ */

/**
 * Whether a claim mentions a place, by ZIP or by name — the mention
 * predicate claimPlace attributes with, exported so the run-progress
 * derivation (run-progress.ts) reads claims through the same test
 * compose does: one attribution, scored once, rendered by code in
 * both the interim verdicts and the terminal evidence.
 */
export function claimMentionsPlace(
  claim: ResearchedClaim,
  place: { name: string; zcta: string },
): boolean {
  const lower = claim.text.toLowerCase()
  return zctaMentioned(lower, place.zcta) || lower.includes(place.name.toLowerCase())
}

/**
 * Whether a claim's text carries a ZCTA as a standalone token
 * (Lane A10 FM-19): the digit-boundary test, not a substring
 * test. The shipped substring test attributed any claim whose
 * text contained the digit sequence anywhere — measured
 * hermetically on the sheet-B specimen's shape: "Austin is home
 * to 768021 registered voters" attributed to Early, TX, because
 * 76802 sits inside the longer figure, while the claim's own
 * place (named bare) matched nothing. A ZIP mentioned as itself
 * ("in 76802", "(76802)") still matches; a longer number that
 * merely contains the digits does not.
 */
function zctaMentioned(lowerText: string, zcta: string): boolean {
  return new RegExp(`(?<!\\d)${zcta}(?!\\d)`).test(lowerText)
}

/**
 * Why there is no materialization partition beside this cure
 * (FM-19 investigation record): a candidate whose claims all
 * failed compose's form refusals still cards — by design.
 * Compose refuses ranking-FORM claims ("X has the best beer
 * selection") while extraction elects their places, so claim
 * survival cannot testify that a finding described the place
 * (measured in this cure's first pin run: the A9 battery's five
 * lead places — Burlington, Plano, Naperville, Portland,
 * Burlington again on the re-ask — all card on refused-form
 * claims). And a prose-mention test cannot add evidence either:
 * FM-14's hygiene already gates what extraction reads, so every
 * extracted candidate is prose-mentioned by construction. The
 * specimen's harm was never the carding — it was the borrowed
 * evidence, cured by the boundary test above. A candidate that
 * cards claimless carries no other place's findings.
 */

function claimPlace(claim: ResearchedClaim, places: readonly AreaRow[]): AreaRow | null {
  for (const row of places) {
    if (claimMentionsPlace(claim, row)) return row
  }
  return null
}

/** Mid-sentence form of a pulled figure key's registry label. */
function figureClauseLabel(key: string): string {
  const label = criterionDisplayLabel(key)
  return label.charAt(0).toLowerCase() + label.slice(1)
}

function joinFigureLabels(keys: readonly string[]): string {
  const labels = keys.map(figureClauseLabel)
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/**
 * The figure-framed comparative lead for the degraded named-places
 * compose (the 26b2007 terminal: total research failure, the screen
 * bounded to the named places' own rows, no measure retained
 * anywhere, the headline money figures pulled as display figures).
 * Live specimen, 2026-11-03 on production 2839881: that card named
 * Hilo and East Honolulu with their figures ($1,346/$458,100 against
 * $2,946/$1,457,700) under the generic "shown with their Census
 * figures" summary and never stated the comparison the figures
 * plainly make, while direct-compose runs of the same question lead
 * with the conclusion. This lead states ONLY the ordering of the
 * figures shown — never that the failed research criterion was
 * measured; the summary's not-measured clauses follow it unchanged.
 *
 * The comparative signal is the validated intent's structured mode
 * ('compare') — the parse's own output, never a keyword scan of the
 * question text. A winner is named only when one place is uniquely
 * lowest on EVERY measure at least two compared places carry, and
 * the clean sentence ("on every measure shown") additionally
 * requires the compared places' figure sets to be exactly those
 * shared measures AND the card's margin-of-error bands to be
 * pairwise disjoint — the summary validator's own precision rule
 * (validator.ts step 4) withholds "lower than" prose whenever any
 * two bands on the card overlap, measured here on the S4 fixture:
 * Pahoa's rent band (1259 ±316) overlaps Hilo's (1346 ±52), so that
 * card's lead falls to the per-measure form. Anything else — a
 * split across measures, a tie, a one-sided figure set, overlapping
 * bands — is stated per measure, plainly, with no winner picked.
 * Numeral-free, like every composed summary.
 */
function degradedComparisonLead(input: {
  mode: IntentMode
  places: readonly AnswerPlace[]
  keys: readonly string[]
}): string | null {
  if (input.mode !== 'compare' || input.keys.length === 0) return null
  const valueOf = (place: AnswerPlace, key: string): number | undefined =>
    place.figures.find((f) => f.key === key)?.value
  const compared = input.places.filter((p) => input.keys.some((k) => valueOf(p, k) !== undefined))
  if (compared.length < 2) return null
  const sharedKeys = input.keys.filter(
    (k) => compared.filter((p) => valueOf(p, k) !== undefined).length >= 2,
  )
  if (sharedKeys.length === 0) return null
  const lows = sharedKeys.map((key) => {
    const carriers = compared.filter((p) => valueOf(p, key) !== undefined)
    const min = Math.min(...carriers.map((p) => valueOf(p, key) as number))
    return { key, lowest: carriers.filter((p) => valueOf(p, key) === min) }
  })
  const uniqueLowestEverywhere = compared.find((p) =>
    lows.every((l) => l.lowest.length === 1 && l.lowest[0] === p),
  )
  const uniformSets = compared.every(
    (p) =>
      sharedKeys.every((k) => valueOf(p, k) !== undefined) &&
      p.figures.every((f) => sharedKeys.includes(f.key)),
  )
  // The validator's precision rule, mirrored: "lower than" prose is
  // withheld when ANY two margin-of-error bands among the card's
  // figures overlap, so the winner sentence is available only when
  // every band on the card is disjoint from every other.
  const bands = compared.flatMap((p) =>
    p.figures
      .filter((f) => typeof f.marginOfError === 'number' && f.marginOfError > 0)
      .map((f) => ({ lo: f.value - Math.abs(f.marginOfError as number), hi: f.value + Math.abs(f.marginOfError as number) })),
  )
  // No bands at all is clean (nothing for the rule to bite on); a
  // single band is conservatively NOT clean — the validator's
  // one-band branch turns on other figures' values falling inside
  // it, and the per-measure form below states the same ordering
  // without the risk.
  const bandsDisjoint =
    bands.length !== 1 &&
    bands.every((a, i) => bands.every((b, j) => i === j || a.hi < b.lo || b.hi < a.lo))
  if (uniqueLowestEverywhere && uniformSets && bandsDisjoint) {
    return compared.length === 2
      ? `On the Census figures shown, ${uniqueLowestEverywhere.name} is lower than ${compared.find((p) => p !== uniqueLowestEverywhere)!.name} on every measure shown.`
      : `On the Census figures shown, ${uniqueLowestEverywhere.name} is lower than the other places shown on every measure shown.`
  }
  if (compared.length === 2) {
    const first = compared[0] as AnswerPlace
    const second = compared[1] as AnswerPlace
    const lowerFor = (place: AnswerPlace) =>
      lows.filter((l) => l.lowest.length === 1 && l.lowest[0] === place).map((l) => l.key)
    const tiedKeys = lows.filter((l) => l.lowest.length === 2).map((l) => l.key)
    if (tiedKeys.length === sharedKeys.length) {
      return `On the Census figures shown, ${first.name} and ${second.name} are equal on every measure shown.`
    }
    const clauses: string[] = []
    for (const place of compared) {
      const won = lowerFor(place)
      if (won.length > 0) clauses.push(`${place.name} is lower for ${joinFigureLabels(won)}`)
    }
    if (tiedKeys.length > 0) clauses.push(`both places are equal for ${joinFigureLabels(tiedKeys)}`)
    const split = compared.every((p) => lowerFor(p).length > 0)
    return `On the Census figures shown, ${split ? 'the comparison is split: ' : ''}${clauses.join('; ')}.`
  }
  const parts: string[] = []
  for (const place of compared) {
    const won = lows
      .filter((l) => l.lowest.length === 1 && l.lowest[0] === place)
      .map((l) => l.key)
    if (won.length > 0) parts.push(`${place.name} is lower for ${joinFigureLabels(won)}`)
  }
  for (const low of lows) {
    if (low.lowest.length >= 2) {
      parts.push(
        `the lowest ${figureClauseLabel(low.key)} is shared by ${low.lowest.map((p) => p.name).join(' and ')}`,
      )
    }
  }
  return `On the Census figures shown, ${parts.join('; ')}.`
}

export function composeAnswer(input: {
  intent: ValidatedIntent
  screen: ScreenResult
  research?: ResearchStageResult | null
  researchCriteria?: readonly ResearchCriterion[]
  candidateCapApplied?: boolean
  unresolvedCandidates?: readonly string[]
  /** Unmatched names whose stated state contradicts the bound (K3), recorded on the answer. */
  outOfStateCandidates?: readonly string[]
  /** Resolved candidates refused by the geography binding (FM-15), recorded on the answer. */
  outOfBoundCandidates?: readonly string[]
  /** Candidate-shaped tokens the extraction gate counted as fragments, not names (FM-14). */
  unmatchedFragmentCount?: number
  geographyLevel?: AnswerGeographyLevel
  unsupportedGeography?: string | null
  /** Research-first answers pull a headline Census figure even when the question named no measure. */
  pullMode?: boolean
  /** The named-places ZCTA bound the screen was composed under, when the caller resolved one. */
  geographyZctas?: ReadonlySet<string>
  summaryOverride?: string
  /** The top-N count the reader asked for, stamped verbatim for the card's shortfall line. */
  requestedCount?: number | null
  /**
   * County aggregation metadata keyed by aggregate-row zcta, from
   * county-aggregate.ts via the pipeline: which member ZCTAs formed
   * each county and which of its figures carry approximate margins.
   */
  countyMeta?: ReadonlyMap<string, { memberZctas: string[]; approximateMarginKeys: readonly string[] }>
  /** True when this answer was composed at county level from the crosswalk. */
  countySupported?: boolean
  /** A requested figure that could not be aggregated to county level. */
  countyFigureNotMeasurable?: string | null
  /** Counties dropped because their deciding figure was not measurable. */
  notMeasurableCounties?: readonly string[]
  /** Geography readings from the caller's resolution result, disclosed verbatim. */
  geographyDisclosures?: readonly string[]
  /** True when a state-average place was composed from a named state geography. */
  stateSupported?: boolean
}): ComposedAnswer {
  const { intent, screen } = input
  // Pull mode (research-first): candidates arrived from research, so
  // the figure pull needs a measure even when the question named
  // none. The pulled measure is the product's headline cost figure
  // (median gross rent, the same default the national screen uses);
  // it is a display figure, never a criterion — criterionEvidence
  // below carries no Census entry for it.
  // Decomposed criteria (P3 step 3) pull their metric's figure onto
  // every place, so the criterion is assessed on the card from data,
  // exactly like a stated Census measure.
  const decomposedKeys = [
    ...new Set(
      (input.researchCriteria ?? [])
        .map((c) => c.decomposedMetricKey)
        .filter((k): k is string => !!k)
        // The no-internet figure is a count of households; without
        // the households figure beside it the share — the reading
        // the internet criterion is assessed on (criterionEvidenceFor,
        // P3b cure 2) — cannot be computed, so the denominator is
        // pulled onto every place the numerator is pulled onto.
        .flatMap((k) => (k === 'no_internet_access' ? [k, 'households'] : [k])),
    ),
  ]
  // Named-places bound (screen-first): when the composed screen is
  // exactly the places the question named — every row inside the
  // resolved geographyZctas bound — and the question retained no
  // measure anywhere (no intent measures, no decomposed pull), the
  // card still needs the figures a place comparison is read on. The
  // pulled set is the headline money figures every screened row
  // carries (rent, home value, household income); like the pull-mode
  // figure above, these are display figures, never criteria — no
  // Census criterion entry is created for them. Without this, the
  // degraded terminal for the 2026-11-03 "cheaper, Hilo or East
  // Honolulu" specimen named both places with no figures at all,
  // under a summary claiming figures were shown.
  const boundDisplayKeys =
    !input.pullMode &&
    intent.metricKeys.length === 0 &&
    decomposedKeys.length === 0 &&
    input.geographyZctas &&
    input.geographyZctas.size > 0 &&
    screen.rows.length > 0 &&
    screen.rows.every((row) => input.geographyZctas!.has(row.zcta))
      ? ['median_gross_rent', 'median_home_value', 'median_household_income']
      : []
  const figureIntent: ValidatedIntent =
    input.pullMode && intent.metricKeys.length === 0
      ? { ...intent, metricKeys: [...new Set(['median_gross_rent', ...decomposedKeys])] }
      : decomposedKeys.length > 0
        ? { ...intent, metricKeys: [...new Set([...intent.metricKeys, ...decomposedKeys])] }
        : boundDisplayKeys.length > 0
          ? { ...intent, metricKeys: boundDisplayKeys }
          : intent
  const places: AnswerPlace[] = screen.rows.map((row) => {
    const figures = figuresForRow(row, figureIntent, screen.criteria)
    const meta = input.countyMeta?.get(row.zcta)
    if (meta) {
      // The approximation label rides from the aggregate row onto
      // the figure itself, so it survives to wherever the figure is
      // shown rather than living only in pipeline bookkeeping.
      for (const figure of figures) {
        if (figure.marginOfError !== undefined && meta.approximateMarginKeys.includes(figure.key)) {
          figure.marginApproximate = true
        }
      }
    }
    return {
      zcta: row.zcta,
      name: row.name,
      figures,
      claims: [],
      ...(meta ? { memberZctas: [...meta.memberZctas] } : {}),
    }
  })

  const droppedClaims: ResearchedClaim[] = []
  const generalClaims: ResearchedClaim[] = []
  const citedUrls = new Set<string>()
  for (const rawClaim of input.research?.claims ?? []) {
    // The citation gate at compose: an uncited researched claim is
    // dropped, and the drop is recorded on the answer.
    if (rawClaim.sourceUrls.length === 0) {
      droppedClaims.push(rawClaim)
      continue
    }
    // Claim-level prose refusal (P3 step 9): a banned construction
    // drops its own sentence, not the whole result — the surviving
    // sentences keep the claim and its citations; a claim with no
    // surviving sentence is dropped whole and recorded like any
    // other compose drop, instead of failing verify for the entire
    // answer downstream.
    const filtered = filterBannedSentences(rawClaim.text)
    for (const droppedSentence of filtered.dropped) {
      droppedClaims.push({ text: droppedSentence, sourceUrls: [...rawClaim.sourceUrls] })
    }
    if (filtered.prose.length === 0) continue
    // Working-narration refusal (2026-11-03, the Texas specimen):
    // the research model's process text is not findings — dropped
    // and recorded like the banned sentences above, at the same
    // composition boundary, so no path that composes claims can
    // render it.
    const hygienic = filterWorkingNarration(filtered.prose, input.research?.sources ?? [])
    for (const droppedSegment of hygienic.dropped) {
      droppedClaims.push({ text: droppedSegment, sourceUrls: [...rawClaim.sourceUrls] })
    }
    if (hygienic.prose.length === 0) continue
    const claim: ResearchedClaim = { ...rawClaim, text: hygienic.prose }
    for (const url of claim.sourceUrls) citedUrls.add(url)
    const row = claimPlace(claim, screen.rows)
    const place = row ? places.find((p) => p.zcta === row.zcta) : undefined
    if (place) place.claims.push(claim)
    else generalClaims.push(claim)
  }

  const sources = (input.research?.sources ?? []).filter((s) => citedUrls.has(s.url))
  const status: AnswerStatus = screen.rows.length === 0 ? 'empty' : 'verified'
  // Status is provisional until verifyAnswer runs; runAnswerPipeline
  // is the entry point that stamps the final status.
  const researchCriteria = input.researchCriteria ?? []
  const unsupportedGeography = input.unsupportedGeography ?? null
  const allClaims = [...places.flatMap((p) => p.claims), ...generalClaims]
  const criterionEvidence = criterionEvidenceFor({
    criteria: screen.criteria,
    droppedCriteria: screen.droppedCriteria,
    researchCriteria,
    places,
    claims: allClaims,
    unsupportedGeography,
    countySupported: input.countySupported ?? false,
    countyFigureNotMeasurable: input.countyFigureNotMeasurable ?? null,
    queryText: researchCriteria[0]?.text,
    failedResearchCriteria: input.research?.failedCriteria,
    researchReAsked: input.research?.reAsked,
  })
  // Summary-claim rule (P3 step 4, battery A1/B5/C5/D2): the
  // "meet all of the stated Census criteria" sentence renders ONLY
  // when the criterion accounting is complete — at least one Census
  // criterion was actually stated and applied, nothing was dropped
  // as inexpressible, and every recorded criterion (Census,
  // decomposed, researched) is met. Otherwise the summary names what
  // is unmeasured, or — when no Census criterion was stated at all
  // (A1's flagship) — makes no meeting claim in the first place.
  //
  // Summary-claim accounting cure (P3c, rerun-p3b C5 — mode
  // summary_meet_claim_with_unmet_decomposed_criterion, measured
  // summary_overclaim 0.92 / honesty 0.14 on the shipped build):
  // ONE accounting — criterionEvidence above — now drives BOTH the
  // claim and the bookend lists, split by exact status. The shipped
  // rule read the two from different sets: its unmeasured set was
  // every status other than met, so a partially measured decomposed
  // criterion (Houston at 4,000 of 8,000 households without internet
  // access, 50 percent against the disclosed quarter-share bar) was
  // listed under "Not measured here" — contradicting the card's own
  // partially measured label for the same criterion — while the
  // fallback sentence still asserted the places "meet the stated
  // Census criteria" over a shown place that fails that criterion.
  // Now: a meet claim (either shipped wording) asserts only when
  // every accounted criterion is met; any partially measured or
  // not measurable criterion falls the summary to the neutral
  // shown-with-figures form the rule already uses when no Census
  // criterion was stated, plus one clause per exact status set —
  // "Partially measured here:" carries exactly the
  // partially_measured criteria (represented in the prose, never
  // silently dropped and never relabelled not measured), and
  // "Not measured here:" carries exactly the not_measurable ones.
  const notMeasuredLabels = [
    ...new Set(
      criterionEvidence.filter((e) => e.status === 'not_measurable').map((e) => e.criterion),
    ),
  ]
  const partiallyMeasuredLabels = [
    ...new Set(
      criterionEvidence
        .filter((e) => e.status === 'partially_measured')
        .map((e) => e.criterion),
    ),
  ]
  const accountingComplete =
    screen.criteria.length > 0 &&
    screen.droppedCriteria.length === 0 &&
    notMeasuredLabels.length === 0 &&
    partiallyMeasuredLabels.length === 0 &&
    !unsupportedGeography
  // The summary is prose and renders verbatim everywhere (card,
  // spoken headline), so the labels joined here are mapped to plain
  // language at this composition seam — the stored criterion values
  // stay metric keys for the consumers that match on them
  // (F-B-ANSWER-CARD).
  const partialClause =
    partiallyMeasuredLabels.length > 0
      ? ` Partially measured here: ${partiallyMeasuredLabels.map(criterionDisplayLabel).join(', ')}.`
      : ''
  const notMeasuredClause =
    notMeasuredLabels.length > 0
      ? ` Not measured here: ${notMeasuredLabels.map(criterionDisplayLabel).join(', ')}.`
      : ''
  // The degraded named-places conclusion: only the 26b2007
  // figure-pull shape (boundDisplayKeys) can carry it, and only when
  // the parse's structured mode is a comparison — every other
  // compose keeps the summary it has today, byte for byte.
  const comparisonLead =
    boundDisplayKeys.length > 0
      ? degradedComparisonLead({ mode: intent.mode, places, keys: boundDisplayKeys })
      : null
  const summary =
    input.summaryOverride ??
    (screen.rows.length === 0
      ? 'No place in the loaded data meets all of the stated Census criteria.'
      : input.pullMode
        ? 'The places named here were named by the cited research for the stated criteria, with Census figures shown for each place.'
        : input.countySupported
          ? 'The counties named here are formed from the ZIP areas assigned to each county, with the deciding figures aggregated from those ZIP areas and shown from Census data.'
          : accountingComplete
            ? 'The places named here meet all of the stated Census criteria, with the deciding figures shown from Census data.'
            : comparisonLead
              ? `${comparisonLead} The places named here are shown with their Census figures for the measures in this request.${partialClause}${notMeasuredClause}`
              : `The places named here are shown with their Census figures for the measures in this request.${partialClause}${notMeasuredClause}`)
  // Candidate direction (Lane A9 FM-4): on the research-first path
  // (pullMode — the places ARE the research's candidates), a place
  // whose serving claims all describe it as not meeting the stated
  // criteria leaves the ranked entries and is named as considered-
  // and-not-meeting. Screen-first answers keep every screened
  // place: their places are the Census screen's answer, and
  // research decorates them — it does not un-elect them (the
  // Nashville contract). The partition runs after evidence and
  // summary composition, so the criterion accounting reads the
  // full candidate set exactly as before; only the ranked listing
  // narrows.
  let rankedPlaces = places
  let consideredNotMeeting: string[] | undefined
  if (input.pullMode) {
    const kept: AnswerPlace[] = []
    const notMeeting: string[] = []
    for (const place of places) {
      if (placeDirectionNegative(place.claims, researchCriteria)) notMeeting.push(place.name)
      else kept.push(place)
    }
    if (notMeeting.length > 0) {
      rankedPlaces = kept
      consideredNotMeeting = notMeeting
    }
  }
  return {
    status,
    stage: 'compose',
    criteria: screen.criteria,
    droppedCriteria: screen.droppedCriteria,
    unresolvedGeographies: screen.unresolvedGeographies,
    screenedCount: screen.inScopeCount,
    places: rankedPlaces,
    ...(consideredNotMeeting ? { consideredNotMeeting } : {}),
    generalClaims,
    sources,
    summary,
    droppedClaims,
    failures: [],
    researchCriteria: [...researchCriteria],
    criterionEvidence,
    candidateCap: SCREENED_RESEARCH_CANDIDATE_CAP,
    candidateCapApplied: input.candidateCapApplied ?? false,
    unresolvedCandidates: [...(input.unresolvedCandidates ?? [])],
    ...(input.outOfStateCandidates && input.outOfStateCandidates.length > 0
      ? { outOfStateCandidates: [...input.outOfStateCandidates] }
      : {}),
    ...(input.outOfBoundCandidates && input.outOfBoundCandidates.length > 0
      ? { outOfBoundCandidates: [...input.outOfBoundCandidates] }
      : {}),
    ...(input.unmatchedFragmentCount && input.unmatchedFragmentCount > 0
      ? { unmatchedFragmentCount: input.unmatchedFragmentCount }
      : {}),
    geographyLevel: input.geographyLevel ?? geographyLevelOfIntent(intent),
    unsupportedGeography,
    requestedCount: input.requestedCount ?? null,
    countyMethod: input.countySupported ? COUNTY_AGGREGATION_METHOD : null,
    notMeasurableCounties: [...(input.notMeasurableCounties ?? [])],
    geographyDisclosures: [...(input.geographyDisclosures ?? [])],
    stateMethod: input.stateSupported ? STATE_AGGREGATION_METHOD : null,
  }
}

/* ------------------------------------------------------------------ */
/* Stage 5: verify                                                     */
/* ------------------------------------------------------------------ */

/**
 * The stage gate. Figure equality is exact (===) against the screened
 * rows the caller supplies — the same rows compose read — so a figure
 * altered anywhere between screen and render fails here. Claims must
 * cite a source the answer carries, and all prose on the answer must
 * pass the validator in criteria-grounded context.
 */
export function verifyAnswer(
  answer: ComposedAnswer,
  screenedRows: readonly AreaRow[],
): { ok: boolean; failures: string[] } {
  const failures: string[] = []
  const rowByZcta = new Map(screenedRows.map((row) => [row.zcta, row]))
  const figures: FigureForValidation[] = []

  for (const place of answer.places) {
    const row = rowByZcta.get(place.zcta)
    if (!row) {
      failures.push(`place not in screened rows: ${place.zcta}`)
      continue
    }
    for (const figure of place.figures) {
      const expected = row.metrics[figure.key]
      if (expected === null || expected === undefined || figure.value !== expected) {
        failures.push(
          `figure mismatch for ${place.zcta} ${figure.key}: answer ${figure.value}, screened row ${String(expected)}`,
        )
      }
      const expectedMoe = row.moes[figure.key]
      const answerMoe = figure.marginOfError ?? null
      const rowMoe = expectedMoe === undefined ? null : expectedMoe
      if (answerMoe !== rowMoe) {
        failures.push(
          `margin mismatch for ${place.zcta} ${figure.key}: answer ${String(answerMoe)}, screened row ${String(rowMoe)}`,
        )
      }
      figures.push({
        key: figure.key,
        value: figure.value,
        ...(figure.marginOfError !== undefined ? { marginOfError: figure.marginOfError } : {}),
      })
    }
  }

  const carriedUrls = new Set(answer.sources.map((s) => s.url))
  const allClaims = [
    ...answer.places.flatMap((p) => p.claims),
    ...answer.generalClaims,
  ]
  for (const claim of allClaims) {
    if (claim.sourceUrls.length === 0) {
      failures.push(`uncited researched claim survived compose: ${claim.text}`)
    } else if (!claim.sourceUrls.every((url) => carriedUrls.has(url))) {
      failures.push(`claim cites a source the answer does not carry: ${claim.text}`)
    }
    // Claim-level scan (P3 step 9): the same idiom exemption compose
    // applies, so a surviving non-ranking "worst of the peak" claim
    // verifies instead of withholding the whole answer.
    const banned = claimBannedLabel(claim.text)
    if (banned) failures.push(`banned construction in claim (${banned}): ${claim.text}`)
  }

  // Evidence honesty: a researched criterion marked served must cite
  // only sources the answer carries — an evidence entry pointing at a
  // source compose dropped is exactly the silent upgrade the
  // evidence model exists to prevent.
  for (const evidence of answer.criterionEvidence) {
    if (!evidence.sourceUrls.every((url) => carriedUrls.has(url))) {
      failures.push(`criterion evidence cites a source the answer does not carry: ${evidence.criterion}`)
    }
  }

  const validator = createValidator()
  const verdict = validator.validate(answer.summary, figures)
  if (!verdict.pass) {
    // The summary is composed by code and numeral-free, so a failure
    // here is a defect in compose, reported like any other.
    failures.push(`summary failed validator: ${verdict.failure}: ${verdict.detail}`)
  }

  return { ok: failures.length === 0, failures }
}

/* ------------------------------------------------------------------ */
/* The staged flow                                                     */
/* ------------------------------------------------------------------ */

export interface AnswerPipelineInput {
  intent: ValidatedIntent
  rows: readonly AreaRow[]
  /** Caller-resolved ZCTAs for non-ZIP geographies (place index seam). */
  geographyZctas?: ReadonlySet<string>
  /**
   * The reader's non-Census criteria as text, for the research stage.
   * Absent = no research stage (the answer rests on Census criteria
   * alone and says so through an empty claims/sources list).
   */
  researchQuery?: string
  /**
   * The reader's question text, for decomposition and geography-level
   * detection (a county request must be reported even when the
   * question carries no research stage). Defaults to researchQuery.
   */
  queryText?: string
  /** Provider for the research stage; required when researchQuery is. */
  provider?: MuseProvider
  signal?: AbortSignal
  /**
   * Explicit researched criteria from the caller, as texts. When
   * absent, decomposeResearchCriteria derives them from
   * researchQuery. Supplying them does not widen the intent schema —
   * they travel beside the intent, like researchQuery always has.
   */
  researchCriteria?: readonly string[]
  /**
   * Breadth batch concurrency seam: how many roster batches may
   * be in flight at once in a breadth run. Absent = the shipped
   * bound (BREADTH_BATCH_CONCURRENCY). The seam exists for the
   * equivalence proof (the concurrency pins run the same fixture
   * at 1 — the sequential spec — and at the shipped bound and
   * compare terminals); result application is in roster order at
   * any value, so the value changes timing, never standings.
   */
  breadthConcurrency?: number
  /** Research-first extraction seam; defaults to the deterministic prose pattern. */
  candidateExtractor?: CandidateExtractor
  /** Research-first resolution seam; defaults to exact row-name matching. */
  candidateResolver?: CandidateResolver
  /**
   * The county crosswalk seam: ZCTA -> county assignment, from the
   * shipped artefact (CountyIndex.assignmentsFor in
   * src/core/zcta-county-index.ts). When a county-level answer is
   * requested and this seam is supplied, the screen's rows aggregate
   * to counties and the answer is composed at county level. When it
   * is absent, a county request is reported unsupported, as before
   * the artefact existed — never approximated from place fallbacks.
   */
  countyAssignments?: ReadonlyMap<string, CountyAssignment>
  /**
   * States named as aggregate/comparison geographies, resolved by
   * the caller to their member ZCTAs. When supplied, each is
   * composed as one state-average place over its member rows (the
   * state stage below); a state the caller did not flag here keeps
   * the ordinary screen reading (a state-scoped sweep lists the
   * state's places, it does not average them).
   */
  stateAggregates?: readonly StateAggregateGeography[]
  /**
   * The caller's per-geography resolution failures, from the same
   * resolution result the geography ZCTAs came from. When supplied
   * this list IS the answer's unresolvedGeographies — the pipeline
   * does not recompute it from the screen, because the screen's own
   * derivation (any non-ZIP geography is unresolved when no ZCTA set
   * was passed, none when one was) silently drops a failed
   * comparison side whenever another side resolved (battery C4) and
   * contradicts a resolved card whenever resolution happened in the
   * runner. Absent = the screen's derivation, as before.
   */
  unresolvedGeographies?: readonly string[]
  /** Geography readings from the caller's resolution result, disclosed on the card. */
  geographyDisclosures?: readonly string[]
  /**
   * Stage observer for the reader-facing staged status (drive item
   * 17, 2026-11-02): called at the moment a stage actually begins —
   * 'screen' once the parse gate has passed and the deterministic
   * screen is next, 'research' only at a research call site that is
   * really about to run (never when the stage is skipped: no research
   * query, no provider, or an empty screen), 'compose' before the
   * compose stage, 'verify' before the fail-closed verify. The
   * research subject is the first decomposed criterion's reader-facing
   * label, or the intent's first geography when no criterion label
   * exists — words from the reader's own question, never invented
   * granularity. Optional and observation-only: it changes nothing
   * the pipeline computes.
   */
  onStage?: (stage: 'screen' | 'research' | 'compose' | 'verify', subject?: string) => void
  /**
   * Run-progress observer (Lane A7): receives a RunProgressSnapshot
   * when a research stage begins and at every pass boundary, built
   * by the pipeline from the accumulated research material through
   * run-progress.ts (typed verdict data only — no prose, no figures,
   * no conclusion). Observation-only, like onStage: it changes
   * nothing the pipeline computes, and a run with no researched
   * criteria emits nothing — those shapes have no honest percent
   * and the stage line carries them.
   */
  onProgress?: (snapshot: RunProgressSnapshot) => void
}

function emptyAnswerFields(): Pick<
  ComposedAnswer,
  | 'researchCriteria'
  | 'criterionEvidence'
  | 'candidateCap'
  | 'candidateCapApplied'
  | 'unresolvedCandidates'
  | 'geographyLevel'
  | 'unsupportedGeography'
  | 'countyMethod'
  | 'notMeasurableCounties'
  | 'geographyDisclosures'
  | 'stateMethod'
> {
  return {
    researchCriteria: [],
    criterionEvidence: [],
    candidateCap: SCREENED_RESEARCH_CANDIDATE_CAP,
    candidateCapApplied: false,
    unresolvedCandidates: [],
    geographyLevel: 'national',
    unsupportedGeography: null,
    countyMethod: null,
    notMeasurableCounties: [],
    geographyDisclosures: [],
    stateMethod: null,
  }
}

export async function runAnswerPipeline(input: AnswerPipelineInput): Promise<ComposedAnswer> {
  const signal = input.signal ?? new AbortController().signal
  // Stage 1: parse gate. The intent arrived from the intent route,
  // but the gate is cheap and fail-closed, and the screen must never
  // run on a proxy-key filter the route somehow let through.
  const gate = intentGate(input.intent)
  if (!gate.pass) {
    return {
      status: 'blocked',
      stage: 'parse',
      criteria: [],
      droppedCriteria: [],
      unresolvedGeographies: [],
      screenedCount: 0,
      places: [],
      generalClaims: [],
      sources: [],
      summary: '',
      droppedClaims: [],
      failures: [`intent gate: ${gate.detail}`],
      ...emptyAnswerFields(),
    }
  }

  // The parse gate passed: the deterministic screen is the stage now
  // running (item 17 stage observer; see the input field's contract).
  input.onStage?.('screen')

  // Decomposition: Census criteria from the intent, researched
  // criteria from the question text (or the caller's explicit list).
  const researchCriteria: ResearchCriterion[] =
    input.researchCriteria && input.researchCriteria.length > 0
      ? input.researchCriteria.flatMap((text) => decomposeResearchCriteria(text))
      : decomposeResearchCriteria(input.researchQuery)
  const countyRequested = requestsCountyLevel(input.queryText ?? input.researchQuery, input.intent)
  const unsupportedGeography = countyRequested ? 'county' : null
  const geographyLevel: AnswerGeographyLevel = countyRequested
    ? 'county'
    : geographyLevelOfIntent(input.intent)

  // Research-first condition: external criteria and no Census bound,
  // plus optionally a geography bound (the intent's geographies,
  // which bound the research request and the figure pull, never the
  // extraction). A retained Census measure no longer excludes the
  // path by itself (P3b cure 1, battery A3 — mode
  // retained_measure_research_first_reexclusion: P3 removed the
  // mixed-intent exclusion at the panel handoff, and this condition
  // re-imposed it one layer down, so a retirement question with a
  // retained home-value measure fell to a 51-place nationwide
  // screen-first dump and the research-named places never appeared).
  // The retained measure is USED on this path: figureIntent in
  // composeAnswer pulls it onto every research-named place. The
  // widening is bounded to the shape that was actually broken — a
  // retained measure rides along only when the intent carries no
  // geographies (a geography-bounded screen-first answer is a real
  // screen, not a dump) and at least one NAMED catalog criterion is
  // researched (the combined carry alone does not widen: a placeless
  // superlative with a retained measure is the national screen's
  // shape, battery B1, and stays screen-first).
  //
  // State-bounded widening (owner live failure, 2026-11-03: "what
  // city in Colorado has the best nature and the lowest cost of
  // living?"): the no-geographies bound above left the state-bounded
  // intersection on the screen-first path, where its "screen" is a
  // boundless whole-state sort — not a real screen, and the lead
  // researched criterion never engaged: the answer ranked 527 places
  // by rent and said nothing about nature. The widening now also
  // admits a geography bound that is a STATE (isStateGeography: a
  // region whose places research must name), under the same two
  // guards — no filter bounds (screenProbe empty: a ranking, not a
  // screen) and a NAMED researched criterion. A place-level
  // geography keeps the screen-first path: a named city's own rows
  // are the answer's universe and the screen legitimately enumerates
  // them (the Nashville shape — schools researched over the city's
  // screened rows, A2's pinned behavior). A bounded state screen
  // (a stated filter) likewise stays screen-first.
  const screenProbe = screenCriteriaFromIntent(input.intent)
  const namedResearchCriterion = researchCriteria.some(
    (c) => !c.decomposedMetricKey && c.id !== 'combined',
  )
  const stateBounded =
    input.intent.geographies.length > 0 &&
    input.intent.geographies.every((g) => isStateGeography(g))
  // Researched-only superlative widening (owner live failure,
  // 2026-11-03: "what city in Texas is the most liberal" answered as
  // a whole-state rent sort — the research decorated the ten
  // cheapest-rent towns, the towns it called strongly conservative
  // led the card, and the qualifying shortlist sat at the bottom).
  // The class: decomposition yields ONLY researched criteria (the
  // combined carry included — "liberal" has no catalog entry), no
  // decomposed Census measure, and the question carries a
  // superlative attribute phrase no Census measure claims
  // (hasUnclaimedCriterionPhrase). The catalog-named arms above
  // cannot see this class — namedResearchCriterion is false by
  // construction — so a retained measure (the parse's guess at a
  // measure to show; the reader stated none) silently made the
  // screen the answer. The widening admits the class under the
  // same geography fencing as the named arm (placeless or a state
  // bound; a named place's own rows remain the question's universe
  // and stay screen-first — the Nashville contract), and the phrase
  // test is the B1 guard: "cheapest place to live" phrases its
  // superlative over the ranking frame itself, claims it by
  // construction, and stays the national screen. Measured on the
  // specimen text: hasUnclaimedCriterionPhrase returns true; on
  // the B1 text every phrase is place-frame or a measure head.
  const researchedOnlySuperlative =
    researchCriteria.length > 0 &&
    researchCriteria.every((c) => !c.decomposedMetricKey) &&
    !namedResearchCriterion &&
    hasUnclaimedCriterionPhrase(input.queryText ?? input.researchQuery ?? '', researchCriteria)
  const researchFirst =
    researchCriteria.some((c) => !c.decomposedMetricKey) &&
    screenProbe.criteria.length === 0 &&
    (input.intent.metricKeys.length === 0 ||
      ((input.intent.geographies.length === 0 || stateBounded) &&
        (namedResearchCriterion || researchedOnlySuperlative))) &&
    !!input.provider &&
    !!input.researchQuery

  // The geography bound research-first candidates must satisfy
  // (FM-15): derived once here, applied at both materialization
  // sites below (the interim progress derivation and the terminal
  // compose), so a place the research names outside the asked
  // geography can appear on neither rendering.
  const candidateBound = candidateBoundForInput(input)
  // The bound rows themselves, for name normalization (FM-16):
  // bare extraction completes partial and hyphenated mentions
  // against the asked geography's own places, never the nation's.
  const candidateBoundRows = candidateBound.zctas
    ? input.rows.filter((r) => candidateBound.zctas!.has(r.zcta))
    : candidateBound.states
      ? input.rows.filter((r) => {
          const s = stateSuffixOf(r.name)
          return s !== null && candidateBound.states!.has(s)
        })
      : undefined

  // The research stage's reader-facing subject, from the reader's own
  // words: the first named (non-combined) decomposed criterion's label,
  // else the combined criterion's label, else the first geography.
  const researchSubject =
    researchCriteria.find((c) => c.id !== 'combined')?.label ??
    researchCriteria[0]?.label ??
    input.intent.geographies[0]

  // Run progress (Lane A7): the criteria that take a research pass
  // (a criterion decomposed onto a Census metric takes none — its
  // figures are the service), and the snapshot builder both research
  // call sites emit through. The pass count is fixed here, before
  // research starts, which is what makes the percent an honest
  // fraction. Verdicts derive from the accumulated claims through
  // compose's own attribution (claimServesCriterion /
  // claimMentionsPlace, injected into run-progress's derivation):
  // the interim standing is the terminal evidence's judgment,
  // rendered early — never a second, divergent scoring.
  const researchPassCriteria = researchCriteria.filter((c) => !c.decomposedMetricKey)
  // The pass plan (FM-3b): totalUnits counts PASSES, which is the
  // pass-group count — beside a named criterion the combined class
  // takes no pass of its own, so the denominator is the group
  // count, not the criterion count. criteriaTotal keeps counting
  // criteria: the verdict derivation covers every researched
  // criterion, combined class included (it is assessed from the
  // first terminated pass's whole-question material).
  const passGroups = researchPassGroups(researchCriteria)
  const combinedClassLabels = researchPassCriteria
    .filter((c) => c.id === 'combined')
    .map((c) => c.label)
  const combinedHasOwnGroup = passGroups.some((g) => g.some((c) => c.id === 'combined'))
  const assessedThrough = (doneCount: number): string[] => {
    const labels = passGroups
      .slice(0, doneCount)
      .flatMap((g) => g.map((c) => c.label))
    if (doneCount > 0 && !combinedHasOwnGroup) {
      for (const label of combinedClassLabels) {
        if (!labels.includes(label)) labels.push(label)
      }
    }
    return labels
  }
  const buildProgress = (
    doneUnits: number,
    assessedLabels: readonly string[],
    failedLabels: readonly string[],
    candidates: readonly { name: string; zcta: string }[],
    claims: readonly ResearchedClaim[],
  ): RunProgressSnapshot => ({
    doneUnits,
    totalUnits: passGroups.length,
    criteriaTotal: researchPassCriteria.length,
    criteriaDone: researchPassCriteria
      .filter((c) => assessedLabels.includes(c.label) && !failedLabels.includes(c.label))
      .map((c) => c.label),
    criteriaFailed: [...failedLabels],
    places: deriveInterimPlaces(
      {
        claims,
        criteria: researchPassCriteria,
        assessedLabels,
        failedLabels,
        candidates,
      },
      { servesCriterion: claimServesCriterion, mentionsPlace: claimMentionsPlace },
    ),
  })
  /** The all-lookups-failed snapshot a total research failure ends with. */
  const totalFailureProgress = (
    candidates: readonly { name: string; zcta: string }[],
  ): RunProgressSnapshot => {
    const allLabels = researchPassCriteria.map((c) => c.label)
    return buildProgress(passGroups.length, allLabels, allLabels, candidates, [])
  }

  // The widened arm, identified structurally: state bound + a named
  // researched criterion + retained measures. This identification
  // gates the intersection RANKING below (candidates ranked by the
  // decomposed measure) — the class whose success-path order the
  // Colorado cure established.
  const widenedStateBound =
    stateBounded && namedResearchCriterion && input.intent.metricKeys.length > 0
  // Total-failure ladder on the research-first path
  // (compose-degradation cure, 2026-11-03): a TOTAL research
  // failure never rethrows out of the pipeline. The hosted-browser
  // capture on df91134 measured the rethrow's cost: the Colorado
  // question — state-bounded, its cost measure carried only in the
  // criterion decomposition, so the intent retained no measures
  // and the earlier measures-gated degrade did not hold —
  // terminated at the caller's bare compose-failure note after one
  // provider_down, discarding the complete state screen the run
  // already held. The ladder, by the material in hand:
  // - State-bounded: the question carries a complete Census screen
  //   (the state's places under its stated bounds), so the run
  //   degrades onto the screen card with every researched
  //   criterion recorded as a lookup that did not return — the
  //   screen-compose cure's terminal (2026-11-02, the Arkansas
  //   battery), now gated on the state bound alone: whether a
  //   measure survived the intent parse is not what makes the
  //   screen real.
  // - Any other bound (placeless or place-level): no screen
  //   answers the question — a national dump is not an answer —
  //   so the run composes the honest-note terminal in-pipeline
  //   from an empty research result whose failedCriteria carry
  //   every researched label: the summary states the lookup did
  //   not return and the per-criterion accounting renders the
  //   same line. The terminal carries no noCensusMatch marker
  //   and names no places, so the caller's flexible fall-through
  //   does not engage: a completion is grounded on what research
  //   returned, and a total failure returns nothing to ground
  //   one on — nothing in hand stays the honest note.
  let firstResearch: ResearchStageResult | null = null
  let firstResearchDown = false
  let firstResearchFailed = false
  if (researchFirst) {
    input.onStage?.('research', researchSubject)
    if (input.onProgress && researchPassCriteria.length > 0) {
      // Research begins: the progress bar appears now — never
      // during the screen phase before it — at 0 of the planned
      // passes, with no candidates yet: on this path the candidate
      // set is extracted from the accumulated prose per pass.
      input.onProgress(buildProgress(0, [], [], [], []))
    }
    try {
      firstResearch = await researchPerCriterion(
        input.provider!,
        input.intent.geographies,
        researchCriteria,
        input.researchQuery!,
        signal,
        input.onProgress
          ? {
              onPass: async (accumulated, passIndex) => {
                // The provisional candidate set: extraction +
                // resolution over the prose accumulated so far,
                // through the same seams the terminal path uses,
                // so the interim places are the terminal places,
                // arriving early.
                const extractor =
                  input.candidateExtractor ??
                  (({ prose }) => extractCandidateNamesFromProse(prose))
                // Extraction reads hygienic prose (FM-14): the
                // research model's working narration is refused
                // as claims at compose, and it is refused here
                // too — its sentence openings ("Now I'll check
                // the remaining towns next") are not candidate
                // mentions. The same filter compose applies,
                // applied before extraction at both sites.
                const extractionProseNow = filterWorkingNarration(
                  accumulated.prose,
                  accumulated.sources,
                ).prose
                const extractedStdNow = await extractor({
                  prose: extractionProseNow,
                  sources: accumulated.sources,
                })
                // The same bare-name pass as the terminal path
                // (FM-5), so an interim place is a terminal place.
                const bareNow = extractBareCandidateNames(
                  extractionProseNow,
                  extractedStdNow,
                  input.rows,
                  candidateBoundRows,
                )
                const extractedNow = [
                  ...extractedStdNow,
                  ...bareNow.names.filter((n) => !extractedStdNow.includes(n)),
                ]
                const resolver =
                  input.candidateResolver ??
                  ((names) => resolveCandidatesAgainstRows(names, input.rows))
                const resolvedNow = await resolver(extractedNow)
                // The same geography binding as the terminal path
                // (FM-15): an out-of-bound place is not an interim
                // place either — the map fills with the terminal
                // places, arriving early, never with places the
                // terminal will refuse.
                const boundNow = bindResolvedCandidates(resolvedNow, candidateBound, input.rows)
                const candidates = representativeCandidateRows(
                  boundNow.bound,
                  accumulated.claims,
                  input.rows,
                )
                input.onProgress!(
                  buildProgress(
                    passIndex + 1,
                    assessedThrough(passIndex + 1),
                    accumulated.failedCriteria ?? [],
                    candidates,
                    accumulated.claims,
                  ),
                )
              },
            }
          : undefined,
      )
    } catch {
      // The degrade question is whether the screen this pipeline is
      // about to run is itself an answer-shaped universe for the
      // question. Two shapes qualify: a state bound (the state screen
      // IS the sweep the question asks over) and the named-places
      // bound — when the intent's geographies resolved to ZCTAs in
      // hand, screenRows bounds the screen to exactly those places'
      // rows, so the screened figures answer the question and the
      // research failure belongs ON that card as a recorded criterion
      // failure, not in place of it. The 2026-11-03 live specimen
      // ("Which is cheaper, Hilo or East Honolulu?", research down on
      // both attempts) terminated naming no place because this branch
      // keyed only on the state bound while the two places' screened
      // comparison sat in hand. What still lands the honest note: no
      // answer-shaped screen in hand — a placeless question, or named
      // places that never resolved to rows — where any screen the
      // pipeline could show would be a dump, not an answer.
      const namedPlacesBound =
        input.intent.geographies.length > 0 &&
        !!input.geographyZctas &&
        input.geographyZctas.size > 0 &&
        [...input.geographyZctas].some((z) => input.rows.some((r) => r.zcta === z))
      if (stateBounded || namedPlacesBound) {
        firstResearchDown = true
      } else {
        firstResearchFailed = true
        firstResearch = {
          prose: '',
          sources: [],
          claims: [],
          failedCriteria: researchCriteria
            .filter((c) => !c.decomposedMetricKey)
            .map((c) => c.label),
          // The stage throws only after its one re-ask has also
          // failed (FM-11), so the synthesized result carries the
          // re-ask record the evidence lines state.
          reAsked: true,
        }
        // The research stage is over and every lookup failed: the
        // progress record says so before the honest note composes,
        // so the run's summary names the failure instead of the
        // stage simply vanishing.
        if (input.onProgress && researchPassCriteria.length > 0) {
          input.onProgress(totalFailureProgress([]))
        }
      }
    }
  }
  if (researchFirst && firstResearch) {
    // Stage order inverts: research -> extract -> resolve -> pull.
    // A top-N ask bounds the composed places at the asked count
    // (never above the candidate cap): "top five" answered with ten
    // places has not answered the question that was asked. The
    // asked count rides on the answer so the card can state any
    // shortfall between it and the places that grounded.
    const requestedCount = requestedCountFromQuery(input.queryText ?? input.researchQuery)
    const placeLimit =
      requestedCount !== null
        ? Math.min(SCREENED_RESEARCH_CANDIDATE_CAP, requestedCount)
        : SCREENED_RESEARCH_CANDIDATE_CAP
    const rankKey = researchCriteria.find((c) => c.decomposedMetricKey)?.decomposedMetricKey
    /**
     * Materialize one research stage result into candidate rows:
     * extract -> resolve -> bind -> rank -> cap, through the same
     * seams in the same order for the first yield and for the
     * resolution re-ask's merged yield below, so a place the
     * re-ask rescues is materialized exactly as a first-yield
     * place is.
     */
    const materialize = async (stage: ResearchStageResult) => {
      const extractor =
        input.candidateExtractor ?? (({ prose }) => extractCandidateNamesFromProse(prose))
      // Extraction reads hygienic prose (Lane A10 FM-14): compose
      // has always refused the research model's working narration
      // as claims, but extraction read the raw prose, so narration
      // sentence openings entered the candidate stream as names —
      // sheet A's unmatched lines carried "Now I'll" among the
      // fragments. The same filter now runs before extraction;
      // claims derivation is untouched (compose still filters per
      // claim from the stage's prose).
      const extractionProse = filterWorkingNarration(stage.prose, stage.sources).prose
      const extractedStd = await extractor({ prose: extractionProse, sources: stage.sources })
      // Bare names the prose carries with no state at all join the
      // candidate list when the bound rows carry exactly one match
      // (FM-5, extractBareCandidateNames); ambiguous bare names are
      // recorded with the unresolved names below, never resolved.
      const bare = extractBareCandidateNames(extractionProse, extractedStd, input.rows, candidateBoundRows)
      const extracted = [
        ...extractedStd,
        ...bare.names.filter((n) => !extractedStd.includes(n)),
      ]
      const resolver =
        input.candidateResolver ?? ((names) => resolveCandidatesAgainstRows(names, input.rows))
      const resolved = await resolver(extracted)
      // Resolution is by name, exactly as extracted: a resolver either
      // returns the extracted name with its ZCTAs or it does not, and
      // a name it does not return is reported, never repaired.
      const resolvedNames = new Set(resolved.map((r) => r.name.toLowerCase()))
      const unresolvedRecord = [
        ...extracted.filter((name) => !resolvedNames.has(name.toLowerCase())),
        ...bare.ambiguous.filter((name) => !resolvedNames.has(name.toLowerCase())),
        ...bare.unresolved.filter(
          (name) =>
            !resolvedNames.has(name.toLowerCase()) &&
            !extracted.some((e) => e.toLowerCase() === name.toLowerCase()),
        ),
      ]
      // State-contradiction partition (Lane completion K3, 2026-11-03):
      // an unmatched name carrying an explicit state suffix that
      // contradicts the run's state bound is not an in-bound
      // candidate that merely failed to match — its own stated
      // state is outside the asked geography (the A11 specimen:
      // "Tazewell, WA" printed in a Virginia question's unmatched
      // line). FM-15's binding handles this class for RESOLVED
      // candidates; this is the unresolved side of the same
      // discipline. The contradicting names are recorded separately
      // (outOfStateCandidates) and the card accounts them under
      // their own line; the flexible packet's record
      // (researchNamedPlaces) is untouched — the completion may
      // still name such a place with its stated state and its
      // evidence label. Only a state bound can contradict: place
      // and ZCTA bounds carry no state set and stay neutral.
      const unresolvedCandidates: string[] = []
      const outOfStateCandidates: string[] = []
      for (const name of unresolvedRecord) {
        const suffix = stateSuffixOf(name)
        if (suffix && candidateBound.states && !candidateBound.states.has(suffix)) {
          outOfStateCandidates.push(name)
        } else {
          unresolvedCandidates.push(name)
        }
      }
      // Geography binding (FM-15): the resolved set is tested
      // against the question's bound before any row is selected —
      // resolution itself is national (the index and the loaded rows
      // know every state), so this is the first point where the
      // asked geography speaks. Out-of-bound candidates are recorded
      // on the answer, never carded.
      const binding = bindResolvedCandidates(resolved, candidateBound, input.rows)
      // One representative row per resolved candidate, in research
      // order (representativeCandidateRows — the battery B3 rule:
      // places count by place, not by ZIP). The claim that names the
      // place still attributes to the representative by name mention
      // in compose, so no researched claim is lost with a split ZIP.
      const candidateRows = representativeCandidateRows(binding.bound, stage.claims, input.rows)
      const candidateCapApplied = candidateRows.length > SCREENED_RESEARCH_CANDIDATE_CAP
      // Intersection ranking (2026-11-03, the Colorado cure): on the
      // state-bounded arm, when the question also carries a criterion
      // decomposed onto a Census metric (cost of living onto median
      // gross rent), the research order is not the answer's order —
      // the candidates are the researched criterion's places, ranked
      // by the decomposed measure, lowest first, because both shipped
      // decomposed measures read low-is-better (rent is the cost
      // reading; the no-internet count is the access reading).
      // Candidates with no published figure for the measure sort
      // last, in research order — a missing figure is not the lowest
      // — and the evidence detail discloses that they are not ranked
      // on it. The sort is stable, so equal figures keep the research
      // order, and it runs before the cap so the cap keeps the
      // best-ranked candidates. The pre-existing research-first arms
      // keep research order untouched: that order is their pinned
      // contract (the B3 counting pin, geo-resolution), and the
      // ranking belongs to the state-bounded intersection class this
      // arm serves.
      const rankedRows = rankKey && widenedStateBound
        ? [...candidateRows].sort((a, b) => {
            const av = a.metrics[rankKey]
            const bv = b.metrics[rankKey]
            const aKnown = typeof av === 'number' && Number.isFinite(av)
            const bKnown = typeof bv === 'number' && Number.isFinite(bv)
            if (aKnown && bKnown) return av - bv
            if (aKnown) return -1
            if (bKnown) return 1
            return 0
          })
        : candidateRows
      const cappedRows = rankedRows.slice(0, placeLimit)
      return {
        extracted,
        bare,
        unresolvedCandidates,
        outOfStateCandidates,
        binding,
        candidateCapApplied,
        cappedRows,
      }
    }
    let research = firstResearch
    // Breadth mode (owner directive 2026-11-03 12:44 HST: a
    // set-shaped researched question over a state — "Which areas
    // of Texas are the most liberal?" — must show ALL the state's
    // areas on the map by standing, filling in real time, with a
    // completion estimate): when the shape gate (breadthShapeFor)
    // admits the run, the standard stage's claims are joined by
    // roster batches over the bound geography's display set —
    // every distinct place in the bound rows, in assessment
    // order — one research call per batch, each batch's places
    // riding the request's places roster. Standings derive from
    // the merged claims through the pole test (placeStanding);
    // a place no sourced claim characterizes stays unassessed,
    // on the map and in the counts. A batch that fails leaves
    // its places unassessed and the run continues — the counts
    // line states the coverage honestly either way. When the
    // merged material characterizes NOTHING, breadth stands down
    // and the standard materialization below owns the terminal
    // exactly as before (the K1 re-ask included): breadth is an
    // assessment structure over material, never a new failure
    // mode. Design gate: Jev proceed / destructive 0.08 /
    // advances 0.95, PROCEED under Jev gate policy v1.
    // Concurrency follow-up (2026-11-03, owner: "Ship as is
    // then optimize so it doesn't take so long!"): the batches
    // run through a bounded pool and apply in roster order —
    // see BREADTH_BATCH_CONCURRENCY and the batch loop below.
    // Gate: Jev proceed / destructive 0.10 / advances 0.96,
    // PROCEED under Jev gate policy v1.
    const breadthShape = !firstResearchFailed
      ? breadthShapeFor({
          queryText: input.queryText ?? input.researchQuery,
          intent: input.intent,
          researchCriteria,
        })
      : null
    let breadthActive: {
      shape: NonNullable<typeof breadthShape>
      standings: BreadthPlace[]
      assessedCount: number
      elapsedMs: number
      rankedRows: AreaRow[]
      negativeNames: string[]
    } | null = null
    if (breadthShape) {
      const boundRows =
        candidateBoundRows ??
        input.rows.filter((r) => stateSuffixOf(r.name) === breadthShape.stateAbbr)
      const displaySet = breadthDisplaySet(boundRows)
      if (displaySet.length > 0) {
        const rowByZcta = new Map(input.rows.map((r) => [r.zcta, r]))
        const batches: (typeof displaySet)[] = []
        for (let i = 0; i < displaySet.length; i += BREADTH_BATCH_SIZE) {
          batches.push(displaySet.slice(i, i + BREADTH_BATCH_SIZE))
        }
        // The roster steering rides the query text, so it is
        // bounded by the route's query ceiling: appended only
        // when the whole text stays comfortably under it — the
        // places roster itself scopes the call either way (the
        // research prompt researches only the named places).
        const steering =
          "\nFor each place in this request's place list, name the place in its finding " +
          'and state the characterization plainly — one finding per place.'
        const breadthQuery =
          input.researchQuery!.length + steering.length <= 480
            ? input.researchQuery! + steering
            : input.researchQuery!
        const breadthStart = Date.now()
        let batchStage: ResearchStageResult = { prose: '', sources: [], claims: [] }
        let batchesDone = 0
        const emitBreadthProgress = () => {
          if (!input.onProgress) return
          const merged = mergeResearchStages(firstResearch, batchStage)
          const placesNow = deriveBreadthPlaces(
            { displaySet, claims: merged.claims, criterion: breadthShape.criterion },
            { mentionsPlace: claimMentionsPlace, standingForPlace: placeStanding },
          )
          const assessedNow = placesNow.filter((p) => p.standing !== 'unassessed').length
          const elapsedNow = Date.now() - breadthStart
          input.onProgress({
            doneUnits: passGroups.length + batchesDone,
            totalUnits: passGroups.length + batches.length,
            criteriaTotal: researchPassCriteria.length,
            criteriaDone: researchPassCriteria
              .filter((c) => !(firstResearch.failedCriteria ?? []).includes(c.label))
              .map((c) => c.label),
            criteriaFailed: [...(firstResearch.failedCriteria ?? [])],
            places: [],
            breadth: {
              displayTotal: displaySet.length,
              assessedCount: assessedNow,
              elapsedMs: elapsedNow,
              etaMs: estimateRemainingMs(assessedNow, displaySet.length, elapsedNow),
              geographyLabel: breadthShape.geographyLabel,
              criterionLabel: breadthCriterionLabel(breadthShape.criterion),
              labels: breadthLabelsFor(breadthShape.criterion, 'interim'),
            },
            breadthPlaces: placesNow.map(({ name, zcta, standing }) => ({
              name,
              zcta,
              standing,
            })),
          })
        }
        emitBreadthProgress()
        // Bounded concurrency with roster-order application
        // (2026-11-03): a pool of workers keeps up to
        // BREADTH_BATCH_CONCURRENCY batches in flight, but a
        // batch's yield MERGES only when every roster predecessor
        // has merged — a batch that finishes early waits in its
        // slot. Merging is the only place batch order is
        // observable (mergeResearchStages concatenates prose and
        // appends deduped claims/sources in merge order), so
        // applying in roster order makes the merged stage — and
        // every progress snapshot, each emitted at an applied
        // batch boundary — exactly the sequential run's at the
        // same applied count; the pool changes timing, never
        // content. A failed batch settles its slot empty: its
        // places stay unassessed, successors are never blocked
        // beyond the slot, and the counts state the coverage.
        // Exactly one attempt per batch at any bound — the total
        // research calls are the sequential run's, compressed in
        // time, never multiplied.
        const batchSlots: (ResearchStageResult | null)[] = batches.map(() => null)
        const batchSettled = batches.map(() => false)
        let batchesApplied = 0
        const applySettledPrefix = () => {
          while (batchesApplied < batches.length && batchSettled[batchesApplied]) {
            const stage = batchSlots[batchesApplied]
            if (stage) batchStage = mergeResearchStages(batchStage, stage)
            batchesApplied++
            batchesDone = batchesApplied
            emitBreadthProgress()
          }
        }
        const runBatch = async (index: number): Promise<void> => {
          const batch = batches[index]!
          try {
            const result = await input.provider!.research(
              { queryText: breadthQuery, places: batch.map((p) => p.name) },
              signal,
            )
            batchSlots[index] = {
              prose: result.prose,
              sources: result.sources.map((s) => ({ title: s.title, url: s.url })),
              claims: claimsFromResearch(result),
            }
          } catch {
            // The batch's places stay unassessed; the run
            // continues and the counts state the coverage.
            batchSlots[index] = null
          }
          batchSettled[index] = true
          applySettledPrefix()
        }
        const concurrency = Math.min(
          batches.length,
          Math.max(1, Math.floor(input.breadthConcurrency ?? BREADTH_BATCH_CONCURRENCY)),
        )
        let nextBatchToLaunch = 0
        const workers: Promise<void>[] = []
        for (let w = 0; w < concurrency; w++) {
          workers.push(
            (async () => {
              while (nextBatchToLaunch < batches.length) {
                const index = nextBatchToLaunch++
                await runBatch(index)
              }
            })(),
          )
        }
        await Promise.all(workers)
        research = mergeResearchStages(firstResearch, batchStage)
        const standings = deriveBreadthPlaces(
          { displaySet, claims: research.claims, criterion: breadthShape.criterion },
          { mentionsPlace: claimMentionsPlace, standingForPlace: placeStanding },
        )
        const assessed = standings.filter((p) => p.standing !== 'unassessed')
        // The card's ranked rows: positive-pole places first,
        // then mixed, each in assessment (display) order — the
        // candidate-led simple answer over the assessed set.
        // Negative-pole places are the FM-4 class read through
        // the poles: considered and not meeting, named on the
        // card's existing line, never ranked.
        const rankedRows = [
          ...assessed.filter((p) => p.standing === 'positive'),
          ...assessed.filter((p) => p.standing === 'mixed'),
        ]
          .map((p) => rowByZcta.get(p.zcta))
          .filter((r): r is AreaRow => r !== undefined)
        // Breadth owns the terminal only when it can lead the
        // card: an all-negative or all-unassessed yield stands
        // down to the standard materialization, whose terminals
        // (the FM-4 partition, the honest note, the flexible
        // fall-through) already own those shapes.
        if (rankedRows.length > 0) {
          breadthActive = {
            shape: breadthShape,
            // The terminal standings carry only CHARACTERIZING
            // claims — the click detail shows the evidence behind
            // the standing, not every mention of the place.
            standings: standings.map((p) => ({
              ...p,
              claims: (p.claims ?? []).filter(
                (claim) => claimCharacterization(claim, breadthShape.criterion) !== null,
              ),
            })),
            assessedCount: assessed.length,
            elapsedMs: Date.now() - breadthStart,
            rankedRows,
            negativeNames: assessed
              .filter((p) => p.standing === 'negative')
              .map((p) => p.name),
          }
        }
      }
    }
    let m = await materialize(research)
    // The resolution re-ask (Lane completion K1, 2026-11-03): the
    // stage returned material and extraction named candidates, but
    // ZERO resolved against the bound index — the Michigan shape
    // (carded on one build, no-place on the next, on identical
    // questions): FM-11's re-ask cannot see this case, because the
    // stage is not empty; the yield died one layer down, at
    // resolution. Exactly one bounded re-ask, steered at the
    // failure: name specific incorporated cities and towns, each
    // with its state, preferring places Census data carries. The
    // yields merge (the stage's own dedupe rules; a criterion
    // stays failed only when both stages failed it) and the merged
    // stage re-materializes through the same seams. A re-ask that
    // throws keeps the first yield untouched — the run is never
    // worse for having asked. Runs that card never re-ask, and a
    // stage whose record is empty in every channel — no extracted
    // mentions and no claims — has nothing to steer toward (that is
    // FM-11's and the honest note's ground). The claims disjunct
    // (2026-11-03, the Texas specimen): a stage can return claims
    // that demonstrably discuss places while every place name sits
    // in a form extraction cannot capture (bare mid-sentence, no
    // state suffix), leaving the extraction record at zero while
    // the claims carry the steering material — the earlier
    // extraction-only condition deterministically declined to
    // re-ask on exactly that shape, and the run terminated in the
    // flexible lane with no Census figures.
    if (
      m.cappedRows.length === 0 &&
      !firstResearchFailed &&
      !breadthActive &&
      (m.extracted.length + m.bare.ambiguous.length + m.bare.unresolved.length > 0 ||
        research.claims.length > 0)
    ) {
      try {
        const steered = await researchPerCriterion(
          input.provider!,
          input.intent.geographies,
          researchCriteria,
          `${input.researchQuery!}\n` +
            'Name the places you find as specific incorporated cities or towns, each ' +
            'with its U.S. state (for example, "Traverse City, Michigan"), and prefer ' +
            'places that appear in U.S. Census data over neighborhoods, regions, or ' +
            'organizations.',
          signal,
        )
        research = mergeResearchStages(research, steered)
        m = await materialize(research)
      } catch {
        // The first yield stands, exactly as gathered.
      }
    }
    const { extracted, bare, unresolvedCandidates, outOfStateCandidates, binding } = m
    let candidateCapApplied = m.candidateCapApplied
    let cappedRows = m.cappedRows
    if (breadthActive) {
      // The breadth card: the assessed set's ranked rows under
      // the same place limit the research-first card observes,
      // with the cap accounting reading the ranked set's size —
      // the breadth counts line on the card states the full
      // assessed/display accounting beside it.
      candidateCapApplied = breadthActive.rankedRows.length > placeLimit
      cappedRows = breadthActive.rankedRows.slice(0, placeLimit)
    }
    const baseScreen = screenRows(input.intent, input.rows, input.geographyZctas)
    const pullScreen: ScreenResult = {
      criteria: [],
      droppedCriteria: baseScreen.droppedCriteria,
      unresolvedGeographies: baseScreen.unresolvedGeographies,
      inScopeCount: input.rows.length,
      rows: cappedRows,
    }
    input.onStage?.('compose')
    const composedRaw = composeAnswer({
      intent: input.intent,
      screen: pullScreen,
      research,
      researchCriteria,
      candidateCapApplied,
      unresolvedCandidates,
      outOfStateCandidates,
      outOfBoundCandidates: binding.outOfBound,
      unmatchedFragmentCount: bare.fragments,
      geographyLevel,
      unsupportedGeography,
      pullMode: true,
      requestedCount,
      geographyDisclosures: input.geographyDisclosures,
      summaryOverride:
        cappedRows.length === 0
          ? firstResearchFailed
            ? 'The research lookup for the stated criteria did not return, so no place is named here.'
            : 'Research for the stated criteria did not produce a place that could be shown here.'
          : // The researched-only superlative class stated no
            // Census measure at all, so the pulled figures are
            // context for the named places — the summary says so
            // rather than letting a pulled figure read as the
            // measure the question asked for (the specimen's
            // screen-first summary claimed "the measures in this
            // request" for a rent figure the reader never stated).
            researchedOnlySuperlative
            ? 'The places named here were named by the cited research for the stated criteria, with Census figures shown for context.'
            : undefined,
    })
    const composedWithMarker = {
      ...composedRaw,
      // The FULL extraction record (Lane completion K0, 2026-11-03):
      // this field's own contract (see the type) is every name the
      // extraction stage pulled from the findings, resolved and
      // unresolved alike, but the stamp carried only `extracted` —
      // the state-suffixed extractions plus the bare names that
      // resolved. The bare AMBIGUOUS and bare UNRESOLVED buckets
      // were left out, and they are exactly where a zero-yield run's
      // names live: the owner's phone specimen terminated on the
      // no-place note with its findings' names ("University",
      // "City", and the rest) sitting in those buckets while this
      // field read empty. The flexible completion's packet and its
      // provenance validator both read this field
      // (flexible-runner's researchNamedPlacesOf), so the lane
      // designed to complete that terminal was offered none of the
      // places the research named and its validator rejected a
      // draft naming them — the rescue could not pass its own gate
      // on the shape it exists for. The stamp now carries the whole
      // record, in the unresolvedCandidates composition's order.
      researchNamedPlaces: [
        ...extracted,
        ...bare.ambiguous.filter(
          (name) => !extracted.some((e) => e.toLowerCase() === name.toLowerCase()),
        ),
        ...bare.unresolved.filter(
          (name) => !extracted.some((e) => e.toLowerCase() === name.toLowerCase()),
        ),
      ],
      ...(cappedRows.length === 0 && !firstResearchFailed ? { noCensusMatch: true } : {}),
      ...(research.failedCriteria?.length
        ? { researchFailures: research.failedCriteria }
        : {}),
      // The breadth record (breadth mode): the terminal map and
      // the counts line read the answer's own standings, and the
      // negative-pole places join compose's own FM-4 partition
      // on the considered-and-not-meeting line — one accounting,
      // deduped, compose's entries first.
      ...(breadthActive
        ? {
            breadth: {
              geographyLabel: breadthActive.shape.geographyLabel,
              criterionLabel: breadthCriterionLabel(breadthActive.shape.criterion),
              labels: breadthLabelsFor(breadthActive.shape.criterion, 'terminal'),
              displayTotal: breadthActive.standings.length,
              assessedCount: breadthActive.assessedCount,
              elapsedMs: breadthActive.elapsedMs,
              standings: breadthActive.standings,
            },
            ...(breadthActive.negativeNames.length > 0
              ? {
                  consideredNotMeeting: [
                    ...new Set([
                      ...(composedRaw.consideredNotMeeting ?? []),
                      ...breadthActive.negativeNames,
                    ]),
                  ],
                }
              : {}),
          }
        : {}),
    }
    const composed = input.unresolvedGeographies
      ? { ...composedWithMarker, unresolvedGeographies: [...input.unresolvedGeographies] }
      : composedWithMarker
    if (composed.status === 'empty') return { ...composed, stage: 'verify' }
    input.onStage?.('verify')
    const verdict = verifyAnswer(composed, cappedRows)
    if (!verdict.ok) {
      return { ...composed, status: 'withheld', stage: 'verify', failures: verdict.failures }
    }
    return { ...composed, status: 'verified', stage: 'verify' }
  }

  // Stage 2: deterministic Census screen.
  const screen = screenRows(
    input.intent,
    input.rows,
    input.geographyZctas,
    rankDirectionFromQuery(input.queryText ?? input.researchQuery),
  )

  // Stage 2b (county): when the question asks for counties and the
  // caller supplied the crosswalk, aggregate the screened rows to
  // their counties. The order is the gated semantics: the screen
  // bounds first — a state bound in the intent's geographies has
  // already narrowed the rows inside screenRows — and aggregation
  // runs over what the screen kept. Counties whose deciding figure
  // (the question's measure, or its first criterion) cannot be
  // aggregated are dropped and named on the answer; when that figure
  // class is not aggregable at all, the evidence entry says so. If
  // no screened row carries an assignment, the county level stays
  // unsupported, exactly as it was before the crosswalk shipped.
  let effectiveScreen = screen
  let effectiveUnsupportedGeography = unsupportedGeography
  let countyMeta: Map<string, { memberZctas: string[]; approximateMarginKeys: readonly string[] }> | undefined
  let countySupported = false
  let countyFigureNotMeasurable: string | null = null
  let notMeasurableCounties: string[] = []
  let countyEmptySummary: string | undefined
  if (countyRequested && input.countyAssignments) {
    const figureKeys = [
      ...new Set([
        ...input.intent.metricKeys,
        ...screen.criteria.map((c) => c.metricKey),
      ]),
    ]
    const aggregation = aggregateRowsToCounties(screen.rows, input.countyAssignments, figureKeys)
    if (aggregation.rows.length > 0) {
      countySupported = true
      effectiveUnsupportedGeography = null
      countyMeta = new Map(
        aggregation.rows.map((row) => [
          row.zcta,
          { memberZctas: row.memberZctas, approximateMarginKeys: row.approximateMarginKeys },
        ]),
      )
      const rankKey = input.intent.metricKeys[0] ?? screen.criteria[0]?.metricKey
      let countyRows = aggregation.rows
      if (rankKey) {
        if (classifyMetricKey(rankKey) === 'not_aggregable') {
          countyFigureNotMeasurable = rankKey
        }
        const measurable = new Set(
          countyRows.filter((row) => {
            const value = row.metrics[rankKey]
            return typeof value === 'number' && Number.isFinite(value)
          }),
        )
        notMeasurableCounties = countyRows
          .filter((row) => !measurable.has(row))
          .map((row) => row.name)
        countyRows = countyRows.filter((row) => measurable.has(row))
        // The bounded-superlative order at county level: a boundless
        // sweep sorts by its measure, exactly as the ZCTA screen
        // does — now over the county aggregates, so the county with
        // the leading aggregated figure heads the answer. The
        // direction is the reader's (rankDirectionFromQuery, cure
        // round 3): lowest first unless the words ask highest
        // first. Bounded screens keep the deterministic name order
        // the aggregation produced; the card orders those by their
        // first criterion.
        if (screen.criteria.length === 0 && input.intent.metricKeys.length > 0) {
          const direction = rankDirectionFromQuery(input.queryText ?? input.researchQuery)
          countyRows = [...countyRows].sort((a, b) => {
            const av = a.metrics[rankKey] as number
            const bv = b.metrics[rankKey] as number
            return (direction === 'descending' ? bv - av : av - bv) || a.name.localeCompare(b.name, 'en')
          })
        }
        if (countyRows.length === 0) {
          countyEmptySummary =
            'No county in the loaded data has a measurable figure for the stated measure at county level, so no county is named here.'
        }
      }
      effectiveScreen = { ...screen, rows: countyRows }
    }
  }

  // Stage 2c (state average): a state the caller flagged as an
  // aggregate geography (a lookup/compare side, never a sweep scope)
  // composes as ONE state-average place over its member rows, under
  // the county aggregation rules — the aggregator is keyed by an
  // assignment map, and a state is one group in it. Rows the intent
  // named outright as ZIP geographies stay individual (96720 in
  // battery C6 is both a comparison side and a member of its state's
  // average; it appears as itself AND inside the average, which is
  // what "compare to the state average" means). A state whose
  // deciding figure cannot be aggregated is dropped and disclosed,
  // never replaced by a same-named place. Skipped on the county
  // path: a request is composed at one aggregate level at a time.
  let stateMeta: Map<string, { memberZctas: string[]; approximateMarginKeys: readonly string[] }> | undefined
  let stateSupported = false
  let stateRankingApplied = false
  const pipelineDisclosures: string[] = []
  if (!countySupported && input.stateAggregates && input.stateAggregates.length > 0) {
    const figureKeys = [
      ...new Set([
        ...input.intent.metricKeys,
        ...screen.criteria.map((c) => c.metricKey),
      ]),
    ]
    const zipNamed = new Set(
      input.intent.geographies.map((g) => g.trim()).filter((g) => /^\d{5}$/.test(g)),
    )
    let rows = [...effectiveScreen.rows]
    for (const aggregate of input.stateAggregates) {
      const memberSet = new Set(aggregate.zctas)
      // Every member row feeds the average, including a ZIP the
      // intent also named outright — that ZIP is a member of its
      // state. Only the individual listing below keeps it separate.
      const members = rows.filter((row) => memberSet.has(row.zcta))
      if (members.length === 0) continue
      const assignments = new Map(
        members.map((row) => [row.zcta, { name: aggregate.label, state: aggregate.state }]),
      )
      const aggregation = aggregateRowsToCounties(members, assignments, figureKeys)
      const rankKey = input.intent.metricKeys[0] ?? screen.criteria[0]?.metricKey
      const aggRows = aggregation.rows
        .filter((row) => {
          if (!rankKey) return true
          const value = row.metrics[rankKey]
          return typeof value === 'number' && Number.isFinite(value)
        })
        .map((row) => ({ ...row, name: `${aggregate.label} state average` }))
      if (aggRows.length === 0) {
        pipelineDisclosures.push(
          `${aggregate.label} was named as a state average, but its figures could not be ` +
            'aggregated from the available ZIP-area figures, so no state average is shown for it.',
        )
        continue
      }
      stateSupported = true
      stateMeta = new Map([
        ...(stateMeta ?? new Map()),
        ...aggRows.map(
          (row) =>
            [
              row.zcta,
              { memberZctas: row.memberZctas, approximateMarginKeys: row.approximateMarginKeys },
            ] as const,
        ),
      ])
      rows = [...rows.filter((row) => !memberSet.has(row.zcta) || zipNamed.has(row.zcta)), ...aggRows]
    }
    // The state-unit ranking (cure round 3, 2026-11-03): the
    // question named the STATE as its subject ("which state has
    // the oldest population?") and no geography at all, so the
    // runner supplied every state's aggregate and the terminal
    // rows are exactly the state figures. Their order is the
    // question's ranking — by the named measure, in the direction
    // the reader's words carry — the county path's ordering rule
    // one level up. The guard is the whole shape: every terminal
    // row is a state aggregate, the intent named no geography and
    // no bound. Any other state-supported shape (named states,
    // comparison sides, a ZIP named beside its state) keeps the
    // assembly order it has today, and the answer's geography
    // level stays what the intent reports.
    if (
      stateSupported &&
      stateMeta &&
      rows.length > 0 &&
      rows.every((row) => stateMeta!.has(row.zcta)) &&
      input.intent.geographies.length === 0 &&
      screen.criteria.length === 0 &&
      input.intent.metricKeys.length > 0 &&
      requestsStateLevel(input.queryText ?? input.researchQuery, input.intent)
    ) {
      const rankKey = input.intent.metricKeys[0]!
      const direction = rankDirectionFromQuery(input.queryText ?? input.researchQuery)
      rows = [...rows].sort((a, b) => {
        const av = a.metrics[rankKey] as number
        const bv = b.metrics[rankKey] as number
        return (direction === 'descending' ? bv - av : av - bv) || a.name.localeCompare(b.name, 'en')
      })
      stateRankingApplied = true
    }
    if (stateSupported) effectiveScreen = { ...effectiveScreen, rows }
  }

  // Stage 3: research over the screened subset only, one pass per
  // decomposed criterion, capped at SCREENED_RESEARCH_CANDIDATE_CAP
  // places. An empty screen researches nothing — there is no subset
  // to research. A question with a research query but no catalog
  // criterion still decomposes to the one combined criterion, so the
  // legacy single-pass shape is the one-criterion case of this loop.
  // On the county path the subset is the county aggregates, so
  // research is told county names, never member ZCTAs.
  let research: ResearchStageResult | null = null
  const candidateCapApplied = effectiveScreen.rows.length > SCREENED_RESEARCH_CANDIDATE_CAP
  if (firstResearchDown) {
    // The research-first attempt above measured a total research
    // failure for this state-bounded question; the screen flow
    // carries the card and every researched criterion is recorded
    // as a lookup that did not return — the screen path's own
    // degrade accounting, without spending the identical passes a
    // second time inside the same run.
    research = {
      prose: '',
      sources: [],
      claims: [],
      failedCriteria: researchCriteria
        .filter((c) => !c.decomposedMetricKey)
        .map((c) => c.label),
    }
    // The run's progress record closes with the failure stated:
    // every researched lookup failed, over the screen's candidate
    // set the card is about to carry.
    if (input.onProgress && researchPassCriteria.length > 0) {
      input.onProgress(
        totalFailureProgress(effectiveScreen.rows.slice(0, SCREENED_RESEARCH_CANDIDATE_CAP)),
      )
    }
  } else if (input.researchQuery && input.provider && effectiveScreen.rows.length > 0) {
    // Inside the condition, so the stage is named only when a
    // research call really follows (item 17: never name a stage
    // that did not run).
    input.onStage?.('research', researchSubject)
    const capped = effectiveScreen.rows.slice(0, SCREENED_RESEARCH_CANDIDATE_CAP)
    if (input.onProgress && researchPassCriteria.length > 0) {
      // Research begins over a candidate set the screen has already
      // fixed: the initial snapshot carries those places with every
      // verdict still pending.
      input.onProgress(buildProgress(0, [], [], capped, []))
    }
    // This stage runs only over a non-empty screen, so Census
    // material exists that can carry the card on its own: a total
    // research failure degrades onto the card as recorded lookup
    // failures (tolerateTotalFailure — see researchPerCriterion);
    // the research-first call above degrades on its own ladder
    // (the state screen, or the honest note where no screen
    // answers the question). The single-pass legacy
    // shape degrades the same way; it carries no decomposed
    // criterion, so there is no label for the stage result to
    // record — the card is the screen's, with no research claims.
    research =
      researchCriteria.length > 0
        ? await researchPerCriterion(
            input.provider,
            capped.map((row) => row.name),
            researchCriteria,
            input.researchQuery,
            signal,
            {
              tolerateTotalFailure: true,
              ...(input.onProgress
                ? {
                    onPass: (accumulated: ResearchStageResult, passIndex: number) => {
                      input.onProgress!(
                        buildProgress(
                          passIndex + 1,
                          assessedThrough(passIndex + 1),
                          accumulated.failedCriteria ?? [],
                          capped,
                          accumulated.claims,
                        ),
                      )
                    },
                  }
                : {}),
            },
          )
        : await researchScreened(input.provider, capped, input.researchQuery, signal).catch(
            (): ResearchStageResult => ({ prose: '', sources: [], claims: [] }),
          )
  }

  // Stage 4: compose. The state aggregates ride the countyMeta seam:
  // it is the generic member/approximation metadata keyed by the
  // synthetic aggregate key, whatever level formed the aggregate.
  const mergedMeta =
    countyMeta || stateMeta
      ? new Map([...(countyMeta ?? new Map()), ...(stateMeta ?? new Map())])
      : undefined
  input.onStage?.('compose')
  const composedRaw = composeAnswer({
    intent: input.intent,
    screen: effectiveScreen,
    research,
    // The decomposed criteria ride to compose whenever the caller
    // supplied them, research query or not (P3b cure 2, battery
    // C5): this line used to gate them on input.researchQuery, so
    // a criterion the runner had decomposed and passed in was
    // dropped here — the App-seam gate's twin, one layer down —
    // whenever the lexical research trigger had not fired and no
    // research query existed. Decomposed Census criteria are
    // assessed from figures at compose; they never needed the
    // research stage to be accounted.
    researchCriteria,
    candidateCapApplied: research && !firstResearchDown ? candidateCapApplied : false,
    geographyZctas: input.geographyZctas,
    geographyLevel: stateRankingApplied ? 'state' : geographyLevel,
    unsupportedGeography: effectiveUnsupportedGeography,
    countyMeta: mergedMeta,
    countySupported,
    countyFigureNotMeasurable,
    notMeasurableCounties,
    geographyDisclosures: [...(input.geographyDisclosures ?? []), ...pipelineDisclosures],
    stateSupported,
    summaryOverride: countyEmptySummary,
  })
  const composedWithFailures =
    research?.failedCriteria?.length
      ? { ...composedRaw, researchFailures: research.failedCriteria }
      : composedRaw
  const composed = input.unresolvedGeographies
    ? { ...composedWithFailures, unresolvedGeographies: [...input.unresolvedGeographies] }
    : composedWithFailures
  if (composed.status === 'empty') return { ...composed, stage: 'verify' }

  // Stage 5: verify, fail-closed. On the county path the figures are
  // checked against the aggregate rows compose read — the same
  // exact-equality gate, over the aggregated figures.
  input.onStage?.('verify')
  const verdict = verifyAnswer(composed, effectiveScreen.rows)
  if (!verdict.ok) {
    return { ...composed, status: 'withheld', stage: 'verify', failures: verdict.failures }
  }
  return { ...composed, status: 'verified', stage: 'verify' }
}
