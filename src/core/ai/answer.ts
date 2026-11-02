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
 *     status: 'verified' | 'withheld' | 'blocked' | 'empty'
 *       verified — passed verify; safe to render as an answer.
 *       withheld — composed but failed verify; `failures` names why.
 *       blocked  — parse gate refused the intent; `failures` names why.
 *       empty    — the screen found no place meeting the criteria.
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
 *   - Research-first: the question carries ONLY external criteria
 *     (no Census bound and no Census measure) plus optionally a
 *     geography bound — research runs first, candidate place names
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
import { METRIC_DEFS_BY_KEY } from '../civicscope-registry'
import type { AreaRow } from '../plugins/acs'
import type { MuseProvider, ResearchResult, ValidatedIntent } from './provider'
import {
  createValidator,
  findBannedConstruction,
  intentGate,
  type FigureForValidation,
} from './validator'

/* ------------------------------------------------------------------ */
/* Stage types                                                         */
/* ------------------------------------------------------------------ */

export type AnswerStage = 'parse' | 'screen' | 'research' | 'compose' | 'verify'

export type AnswerStatus = 'verified' | 'withheld' | 'blocked' | 'empty'

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
}

export type CriterionEvidenceStatus = 'met' | 'partially_measured' | 'not_measurable'

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
 * the card cannot show should not spend a research pass). When a
 * screen leaves more survivors than this, research covers the first
 * cap-many in screen order and the answer discloses the cap.
 */
export const SCREENED_RESEARCH_CANDIDATE_CAP = 10

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
    screened.sort((a, b) => {
      const av = a.metrics[sortKey]
      const bv = b.metrics[sortKey]
      const aKnown = typeof av === 'number' && Number.isFinite(av)
      const bKnown = typeof bv === 'number' && Number.isFinite(bv)
      if (aKnown && bKnown) return av - bv || a.zcta.localeCompare(b.zcta)
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
 * The external-criterion catalog, in decomposition order. Patterns
 * match the reader's own words; `keywords` are what a cited claim
 * must mention for the criterion's evidence to count as served.
 * Fast food precedes restaurants so "fast food restaurants" is one
 * criterion, not two.
 */
const RESEARCH_CRITERION_CATALOG: readonly {
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
  // Current-events arm (P3 step 7, battery E4): news phrasing is a
  // research criterion, so the pipeline researches it with citations
  // instead of the question stranding in clarification.
  { id: 'current_events', label: 'Current events', pattern: /\bnews\b|\bcurrent events\b|\bheadlines?\b/i, keywords: ['news', 'announced', 'reported', 'this week'] },
  // Decomposed onto existing Census metrics (P3 step 3): these two
  // entries never take a research pass — the metric serves them.
  { id: 'internet', label: 'Internet access', pattern: /\binternet\b|\bbroadband\b/i, keywords: [], decomposedMetricKey: 'no_internet_access' },
  { id: 'cost_of_living', label: 'Cost of living', pattern: /\bcost of living\b/i, keywords: [], decomposedMetricKey: 'median_gross_rent' },
]

const COUNT_SEEKING_RE = /\bfewest\b|\bleast\b|\bnumber of\b|\bcount\b|\bdensity\b|\bhow many\b/i

/**
 * Decompose a question's outside-Census criteria. Every catalog
 * criterion the words carry becomes its own criterion; when none
 * matches, the outside criteria are carried as one combined
 * criterion (the honest shape — see the header). An empty or absent
 * query decomposes to nothing: no research was asked for.
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
    })
  }
  if (found.length > 0) return found
  return [{ id: 'combined', label: 'Outside-Census criteria', text: queryText, quantitative }]
}

/** Whether the question asks for a county-level answer. */
export function requestsCountyLevel(queryText: string | undefined, intent: ValidatedIntent): boolean {
  if (queryText && /\bcounty\b|\bcounties\b/i.test(queryText)) return true
  return intent.geographies.some((g) => /\bcounty\b/i.test(g))
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
 * One research pass per decomposed criterion, over the same places.
 * The question text is the query for every pass (the question itself
 * states every criterion; the passes are separated so each
 * criterion's sources are collected under its own call, and a
 * provider that answers criteria differently per call is honoured).
 * Identical claim texts returned by more than one pass are kept
 * once — the same finding cited twice is one finding.
 */
export async function researchPerCriterion(
  provider: MuseProvider,
  places: readonly string[],
  criteria: readonly ResearchCriterion[],
  researchQuery: string,
  signal: AbortSignal,
): Promise<ResearchStageResult> {
  const sources: AnswerSource[] = []
  const claims: ResearchedClaim[] = []
  const proseParts: string[] = []
  // One pass per criterion; the loop count is the contract, the
  // query is the reader's whole question for every pass. A criterion
  // decomposed onto a Census metric takes no pass — its figures are
  // the service, and a web pass over it would spend research on a
  // criterion the data already answers (P3 step 3).
  const researched = criteria.filter((c) => !c.decomposedMetricKey)
  for (let pass = 0; pass < researched.length; pass++) {
    const result = await provider.research({ queryText: researchQuery, places: [...places] }, signal)
    proseParts.push(result.prose)
    for (const source of result.sources) {
      if (!sources.some((s) => s.url === source.url)) {
        sources.push({ title: source.title, url: source.url })
      }
    }
    for (const claim of claimsFromResearch(result)) {
      if (!claims.some((c) => c.text === claim.text)) claims.push(claim)
    }
  }
  return { prose: proseParts.join('\n'), sources, claims }
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
    const name = `${match[1]}, ${match[2]}`
    if (!names.includes(name)) names.push(name)
  }
  return names
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

function claimServesCriterion(claim: ResearchedClaim, criterion: ResearchCriterion): boolean {
  if (criterion.id === 'combined') return true
  const entry = RESEARCH_CRITERION_CATALOG.find((e) => e.id === criterion.id)
  if (!entry) return claim.sourceUrls.length > 0
  const lower = claim.text.toLowerCase()
  return entry.keywords.some((keyword) => lower.includes(keyword))
}

/**
 * Evidence per stated criterion, computed from what the answer
 * actually carries — screened places for Census criteria, cited
 * claims for researched ones. A count-seeking criterion served only
 * by qualitative claims is partially_measured: the source is named
 * through its URLs, and its wording stays qualitative.
 */
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
    // each shown place — met when every shown place carries the
    // figure, partially measured when only some do, not measurable
    // when none does. The direction is stated in the detail: for
    // no_internet_access a lower figure is better access; the figure
    // itself is the assessment, never a prose claim about it.
    if (criterion.decomposedMetricKey) {
      const key = criterion.decomposedMetricKey
      const carrying = input.places.filter((p) => p.figures.some((f) => f.key === key)).length
      evidence.push({
        criterion: criterion.label,
        kind: 'census',
        status:
          input.places.length > 0 && carrying === input.places.length
            ? 'met'
            : carrying > 0
              ? 'partially_measured'
              : 'not_measurable',
        detail:
          key === 'no_internet_access'
            ? 'Assessed from the Census figure for households with no internet access shown for each place; a lower figure means better internet access.'
            : 'Assessed from the Census cost figures shown for each place, read on median gross rent as the headline cost measure.',
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
        detail: 'No cited source available here speaks to this criterion.',
        sourceUrls: [],
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
    evidence.push({
      criterion: 'Affordability on the stated income',
      kind: 'research',
      status: 'not_measurable',
      detail:
        'No figure here converts a stated income into an affordability reading, so that part of the question is not measured.',
      sourceUrls: [],
    })
  }
  return evidence
}

/* ------------------------------------------------------------------ */
/* Stage 4: compose                                                    */
/* ------------------------------------------------------------------ */

function claimPlace(claim: ResearchedClaim, places: readonly AreaRow[]): AreaRow | null {
  const lower = claim.text.toLowerCase()
  for (const row of places) {
    if (lower.includes(row.zcta) || lower.includes(row.name.toLowerCase())) return row
  }
  return null
}

export function composeAnswer(input: {
  intent: ValidatedIntent
  screen: ScreenResult
  research?: ResearchStageResult | null
  researchCriteria?: readonly ResearchCriterion[]
  candidateCapApplied?: boolean
  unresolvedCandidates?: readonly string[]
  geographyLevel?: AnswerGeographyLevel
  unsupportedGeography?: string | null
  /** Research-first answers pull a headline Census figure even when the question named no measure. */
  pullMode?: boolean
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
  const decomposedKeys = (input.researchCriteria ?? [])
    .map((c) => c.decomposedMetricKey)
    .filter((k): k is string => !!k)
  const figureIntent: ValidatedIntent =
    input.pullMode && intent.metricKeys.length === 0
      ? { ...intent, metricKeys: [...new Set(['median_gross_rent', ...decomposedKeys])] }
      : decomposedKeys.length > 0
        ? { ...intent, metricKeys: [...new Set([...intent.metricKeys, ...decomposedKeys])] }
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
    const claim: ResearchedClaim = { ...rawClaim, text: filtered.prose }
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
  })
  // Summary-claim rule (P3 step 4, battery A1/B5/C5/D2): the
  // "meet all of the stated Census criteria" sentence renders ONLY
  // when the criterion accounting is complete — at least one Census
  // criterion was actually stated and applied, nothing was dropped
  // as inexpressible, and every recorded criterion (Census,
  // decomposed, researched) is met. Otherwise the summary names what
  // is unmeasured, or — when no Census criterion was stated at all
  // (A1's flagship) — makes no meeting claim in the first place.
  const unmeasuredLabels = criterionEvidence
    .filter((e) => e.status !== 'met')
    .map((e) => e.criterion)
  const accountingComplete =
    screen.criteria.length > 0 &&
    screen.droppedCriteria.length === 0 &&
    unmeasuredLabels.length === 0 &&
    !unsupportedGeography
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
            : screen.criteria.length === 0
              ? 'The places named here are shown with their Census figures for the measures in this request.'
              : // The summary is prose and renders verbatim everywhere
                // (card, spoken headline), so the labels joined here are
                // mapped to plain language at this composition seam —
                // the stored criterion values stay metric keys for the
                // consumers that match on them (F-B-ANSWER-CARD).
                `The places named here meet the stated Census criteria, with the deciding figures shown from Census data. Not measured here: ${unmeasuredLabels.map(criterionDisplayLabel).join(', ')}.`)
  return {
    status,
    stage: 'compose',
    criteria: screen.criteria,
    droppedCriteria: screen.droppedCriteria,
    unresolvedGeographies: screen.unresolvedGeographies,
    screenedCount: screen.inScopeCount,
    places,
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

  // Research-first condition: ONLY external criteria — no Census
  // bound and no Census measure — plus optionally a geography bound
  // (the intent's geographies, which bound the research request and
  // the figure pull, never the extraction).
  const screenProbe = screenCriteriaFromIntent(input.intent)
  const researchFirst =
    researchCriteria.some((c) => !c.decomposedMetricKey) &&
    screenProbe.criteria.length === 0 &&
    input.intent.metricKeys.length === 0 &&
    !!input.provider &&
    !!input.researchQuery

  if (researchFirst) {
    // Stage order inverts: research -> extract -> resolve -> pull.
    const research = await researchPerCriterion(
      input.provider!,
      input.intent.geographies,
      researchCriteria,
      input.researchQuery!,
      signal,
    )
    const extractor = input.candidateExtractor ?? (({ prose }) => extractCandidateNamesFromProse(prose))
    const extracted = await extractor({ prose: research.prose, sources: research.sources })
    const resolver = input.candidateResolver ?? ((names) => resolveCandidatesAgainstRows(names, input.rows))
    const resolved = await resolver(extracted)
    // Resolution is by name, exactly as extracted: a resolver either
    // returns the extracted name with its ZCTAs or it does not, and
    // a name it does not return is reported, never repaired.
    const resolvedNames = new Set(resolved.map((r) => r.name.toLowerCase()))
    const unresolvedCandidates = extracted.filter(
      (name) => !resolvedNames.has(name.toLowerCase()),
    )
    // Places count BY PLACE, not by ZIP (battery B3, measured
    // 2026-11-02: research named three places; Corbin, KY resolved
    // to both of its ZIP areas and both were listed and counted —
    // "named 4" — including a split ZIP carrying no researched
    // claim, presented under criteria it was never researched for).
    // Each resolved candidate therefore contributes ONE
    // representative row: the member ZIP a cited claim names
    // outright when one does, otherwise the candidate's first ZIP
    // that is actually among the loaded rows, otherwise its first
    // ZIP in resolver order — the same one-ZIP-per-named-place rule
    // lookup resolution applies. The loaded-rows preference matters:
    // the sweep loads in chunks, so a place's first ZIP in index
    // order may not be loaded while a later one is (the live-path
    // fixture loads Corbin's 40771, not its 40701 — picking 40701
    // unconditionally would drop a researched place from the card
    // entirely, a worse failure than the split it cures). The claim
    // that names the place still attributes to the representative
    // by name mention in compose, so no researched claim is lost
    // with the split ZIP.
    const loadedZctas = new Set(input.rows.map((row) => row.zcta))
    const representativeZctas: string[] = []
    for (const candidate of resolved) {
      const claimed = candidate.zctas.find(
        (z) => loadedZctas.has(z) && research.claims.some((claim) => claim.text.includes(z)),
      )
      const representative =
        claimed ?? candidate.zctas.find((z) => loadedZctas.has(z)) ?? candidate.zctas[0]
      if (representative && !representativeZctas.includes(representative)) {
        representativeZctas.push(representative)
      }
    }
    const representativeSet = new Set(representativeZctas)
    const candidateRows = input.rows.filter((row) => representativeSet.has(row.zcta))
    // Extraction order is the research order; rows arrive in load
    // order, so re-order by the resolved candidate sequence.
    const order = new Map<string, number>()
    representativeZctas.forEach((z, i) => order.set(z, i))
    candidateRows.sort((a, b) => (order.get(a.zcta) ?? 0) - (order.get(b.zcta) ?? 0))
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
    const candidateCapApplied = candidateRows.length > SCREENED_RESEARCH_CANDIDATE_CAP
    const cappedRows = candidateRows.slice(0, placeLimit)
    const baseScreen = screenRows(input.intent, input.rows, input.geographyZctas)
    const pullScreen: ScreenResult = {
      criteria: [],
      droppedCriteria: baseScreen.droppedCriteria,
      unresolvedGeographies: baseScreen.unresolvedGeographies,
      inScopeCount: input.rows.length,
      rows: cappedRows,
    }
    const composedRaw = composeAnswer({
      intent: input.intent,
      screen: pullScreen,
      research,
      researchCriteria,
      candidateCapApplied,
      unresolvedCandidates,
      geographyLevel,
      unsupportedGeography,
      pullMode: true,
      requestedCount,
      geographyDisclosures: input.geographyDisclosures,
      summaryOverride:
        cappedRows.length === 0
          ? 'Research for the stated criteria did not name a place that could be matched to Census data, so no place is named here.'
          : undefined,
    })
    const composed = input.unresolvedGeographies
      ? { ...composedRaw, unresolvedGeographies: [...input.unresolvedGeographies] }
      : composedRaw
    if (composed.status === 'empty') return { ...composed, stage: 'verify' }
    const verdict = verifyAnswer(composed, cappedRows)
    if (!verdict.ok) {
      return { ...composed, status: 'withheld', stage: 'verify', failures: verdict.failures }
    }
    return { ...composed, status: 'verified', stage: 'verify' }
  }

  // Stage 2: deterministic Census screen.
  const screen = screenRows(input.intent, input.rows, input.geographyZctas)

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
        // sweep sorts by its measure, lowest first, exactly as the
        // ZCTA screen does — now over the county aggregates, so the
        // county with the lowest aggregated figure leads. Bounded
        // screens keep the deterministic name order the aggregation
        // produced; the card orders those by their first criterion.
        if (screen.criteria.length === 0 && input.intent.metricKeys.length > 0) {
          countyRows = [...countyRows].sort((a, b) => {
            const av = a.metrics[rankKey] as number
            const bv = b.metrics[rankKey] as number
            return av - bv || a.name.localeCompare(b.name, 'en')
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
  if (input.researchQuery && input.provider && effectiveScreen.rows.length > 0) {
    const capped = effectiveScreen.rows.slice(0, SCREENED_RESEARCH_CANDIDATE_CAP)
    research =
      researchCriteria.length > 0
        ? await researchPerCriterion(
            input.provider,
            capped.map((row) => row.name),
            researchCriteria,
            input.researchQuery,
            signal,
          )
        : await researchScreened(input.provider, capped, input.researchQuery, signal)
  }

  // Stage 4: compose. The state aggregates ride the countyMeta seam:
  // it is the generic member/approximation metadata keyed by the
  // synthetic aggregate key, whatever level formed the aggregate.
  const mergedMeta =
    countyMeta || stateMeta
      ? new Map([...(countyMeta ?? new Map()), ...(stateMeta ?? new Map())])
      : undefined
  const composedRaw = composeAnswer({
    intent: input.intent,
    screen: effectiveScreen,
    research,
    researchCriteria: input.researchQuery ? researchCriteria : [],
    candidateCapApplied: research ? candidateCapApplied : false,
    geographyLevel,
    unsupportedGeography: effectiveUnsupportedGeography,
    countyMeta: mergedMeta,
    countySupported,
    countyFigureNotMeasurable,
    notMeasurableCounties,
    geographyDisclosures: [...(input.geographyDisclosures ?? []), ...pipelineDisclosures],
    stateSupported,
    summaryOverride: countyEmptySummary,
  })
  const composed = input.unresolvedGeographies
    ? { ...composedRaw, unresolvedGeographies: [...input.unresolvedGeographies] }
    : composedRaw
  if (composed.status === 'empty') return { ...composed, stage: 'verify' }

  // Stage 5: verify, fail-closed. On the county path the figures are
  // checked against the aggregate rows compose read — the same
  // exact-equality gate, over the aggregated figures.
  const verdict = verifyAnswer(composed, effectiveScreen.rows)
  if (!verdict.ok) {
    return { ...composed, status: 'withheld', stage: 'verify', failures: verdict.failures }
  }
  return { ...composed, status: 'verified', stage: 'verify' }
}
