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
}

export type CriterionEvidenceStatus = 'met' | 'partially_measured' | 'not_measurable'

/** Per-criterion evidence: what serves each stated criterion, honestly labelled. */
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
 * county-level answers are NOT derivable from what ships. The place
 * index (public/map/zcta-places.json, decoded by
 * src/core/zcta-place-index.ts) is ZCTA-level: it carries a county
 * name only as the fallback record for the 4,983 ZCTAs with no
 * incorporated place (kind 'K' in the generator,
 * tools/gen-zcta-city-mapping.mjs) — for every other ZCTA the county
 * was fetched at generation time (the Census 2020 ZCTA-to-county
 * relationship file, tab20_zcta520_county20_natl.txt) and discarded
 * in favour of the city. A county rollup therefore needs that
 * crosswalk shipped as a build-time artefact (one county per ZCTA by
 * largest land overlap, the generator's existing rule); until it is,
 * 'county' is a level an answer can REQUEST and must report as
 * unsupported (unsupportedGeography + a not_measurable evidence
 * entry), never a level approximated from fallback names. This is
 * the generalization phase's one open item.
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
}[] = [
  { id: 'schools', label: 'School quality', pattern: /\bschools?\b|\beducation\b/i, keywords: ['school'] },
  { id: 'fast_food', label: 'Fast food restaurants', pattern: /fast[-\s]?food/i, keywords: ['fast-food', 'fast food'] },
  // The lookbehind keeps "fast food restaurants" to the fast-food
  // criterion above: the same words are one criterion, not two.
  { id: 'restaurants', label: 'Restaurants', pattern: /(?<!fast[-\s]food\s)\brestaurants?\b/i, keywords: ['restaurant'] },
  { id: 'coffee', label: 'Coffee nearby', pattern: /\bstarbucks\b|\bcoffee shops?\b|\bcoffee\b/i, keywords: ['starbucks', 'coffee'] },
  { id: 'groceries', label: 'Groceries', pattern: /\bgrocer(?:y|ies)\b|\bsupermarkets?\b/i, keywords: ['grocer', 'supermarket'] },
  { id: 'safety', label: 'Safety', pattern: /\bsafety\b|\bcrime\b|\bsafe\b/i, keywords: ['safety', 'crime', 'safe'] },
  { id: 'walkability', label: 'Walkability', pattern: /\bwalkable\b|\bwalkability\b/i, keywords: ['walkab'] },
  { id: 'amenities', label: 'Amenities', pattern: /\bgyms?\b|\bnightlife\b|\bplaygrounds?\b|\bhospitals?\b|\btransit\b|\bairports?\b|\blibrar(?:y|ies)\b|\bparks?\b/i, keywords: ['gym', 'nightlife', 'playground', 'hospital', 'transit', 'airport', 'librar', 'park'] },
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
  // query is the reader's whole question for every pass.
  for (let pass = 0; pass < criteria.length; pass++) {
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
/* Per-criterion evidence                                              */
/* ------------------------------------------------------------------ */

const NUMERAL_IN_CLAIM_RE =
  /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i

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
  for (const criterion of input.researchCriteria) {
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
}): ComposedAnswer {
  const { intent, screen } = input
  // Pull mode (research-first): candidates arrived from research, so
  // the figure pull needs a measure even when the question named
  // none. The pulled measure is the product's headline cost figure
  // (median gross rent, the same default the national screen uses);
  // it is a display figure, never a criterion — criterionEvidence
  // below carries no Census entry for it.
  const figureIntent: ValidatedIntent =
    input.pullMode && intent.metricKeys.length === 0
      ? { ...intent, metricKeys: ['median_gross_rent'] }
      : intent
  const places: AnswerPlace[] = screen.rows.map((row) => ({
    zcta: row.zcta,
    name: row.name,
    figures: figuresForRow(row, figureIntent, screen.criteria),
    claims: [],
  }))

  const droppedClaims: ResearchedClaim[] = []
  const generalClaims: ResearchedClaim[] = []
  const citedUrls = new Set<string>()
  for (const claim of input.research?.claims ?? []) {
    // The citation gate at compose: an uncited researched claim is
    // dropped, and the drop is recorded on the answer.
    if (claim.sourceUrls.length === 0) {
      droppedClaims.push(claim)
      continue
    }
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
  const summary =
    input.summaryOverride ??
    (screen.rows.length === 0
      ? 'No place in the loaded data meets all of the stated Census criteria.'
      : input.pullMode
        ? 'The places named here were named by the cited research for the stated criteria, with Census figures shown for each place.'
        : 'The places named here meet all of the stated Census criteria, with the deciding figures shown from Census data.')

  const researchCriteria = input.researchCriteria ?? []
  const unsupportedGeography = input.unsupportedGeography ?? null
  const allClaims = [...places.flatMap((p) => p.claims), ...generalClaims]
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
    criterionEvidence: criterionEvidenceFor({
      criteria: screen.criteria,
      droppedCriteria: screen.droppedCriteria,
      researchCriteria,
      places,
      claims: allClaims,
      unsupportedGeography,
    }),
    candidateCap: SCREENED_RESEARCH_CANDIDATE_CAP,
    candidateCapApplied: input.candidateCapApplied ?? false,
    unresolvedCandidates: [...(input.unresolvedCandidates ?? [])],
    geographyLevel: input.geographyLevel ?? geographyLevelOfIntent(intent),
    unsupportedGeography,
    requestedCount: input.requestedCount ?? null,
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
    const banned = findBannedConstruction(claim.text, { criteriaGrounded: true })
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
> {
  return {
    researchCriteria: [],
    criterionEvidence: [],
    candidateCap: SCREENED_RESEARCH_CANDIDATE_CAP,
    candidateCapApplied: false,
    unresolvedCandidates: [],
    geographyLevel: 'national',
    unsupportedGeography: null,
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
    researchCriteria.length > 0 &&
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
    const resolvedZctas = new Set(resolved.flatMap((r) => r.zctas))
    const unresolvedCandidates = extracted.filter(
      (name) => !resolvedNames.has(name.toLowerCase()),
    )
    const candidateRows = input.rows.filter((row) => resolvedZctas.has(row.zcta))
    // Extraction order is the research order; rows arrive in load
    // order, so re-order by the resolved candidate sequence.
    const order = new Map<string, number>()
    resolved.forEach((candidate, i) => candidate.zctas.forEach((z) => order.set(z, i)))
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
    const composed = composeAnswer({
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
      summaryOverride:
        cappedRows.length === 0
          ? 'Research for the stated criteria did not name a place that could be matched to Census data, so no place is named here.'
          : undefined,
    })
    if (composed.status === 'empty') return { ...composed, stage: 'verify' }
    const verdict = verifyAnswer(composed, cappedRows)
    if (!verdict.ok) {
      return { ...composed, status: 'withheld', stage: 'verify', failures: verdict.failures }
    }
    return { ...composed, status: 'verified', stage: 'verify' }
  }

  // Stage 2: deterministic Census screen.
  const screen = screenRows(input.intent, input.rows, input.geographyZctas)

  // Stage 3: research over the screened subset only, one pass per
  // decomposed criterion, capped at SCREENED_RESEARCH_CANDIDATE_CAP
  // places. An empty screen researches nothing — there is no subset
  // to research. A question with a research query but no catalog
  // criterion still decomposes to the one combined criterion, so the
  // legacy single-pass shape is the one-criterion case of this loop.
  let research: ResearchStageResult | null = null
  const candidateCapApplied = screen.rows.length > SCREENED_RESEARCH_CANDIDATE_CAP
  if (input.researchQuery && input.provider && screen.rows.length > 0) {
    const capped = screen.rows.slice(0, SCREENED_RESEARCH_CANDIDATE_CAP)
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

  // Stage 4: compose.
  const composed = composeAnswer({
    intent: input.intent,
    screen,
    research,
    researchCriteria: input.researchQuery ? researchCriteria : [],
    candidateCapApplied: research ? candidateCapApplied : false,
    geographyLevel,
    unsupportedGeography,
  })
  if (composed.status === 'empty') return { ...composed, stage: 'verify' }

  // Stage 5: verify, fail-closed.
  const verdict = verifyAnswer(composed, screen.rows)
  if (!verdict.ok) {
    return { ...composed, status: 'withheld', stage: 'verify', failures: verdict.failures }
  }
  return { ...composed, status: 'verified', stage: 'verify' }
}
