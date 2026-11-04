/**
 * The geography gate (drug-law specimen cure, 2026-11-04): the
 * general mechanism for a question whose FIRST criterion is a
 * researched (non-Census) classification of a COARSER geography
 * than the Census extremum its SECOND part seeks — "what state has
 * the most relaxed drug laws, and which city/county/zip has the
 * lowest cost of living in that state?"
 *
 * The shipped decomposition had exactly two criterion roles —
 * Census metrics (screened) and researched criteria (annotated per
 * place) — and no representation for a criterion whose value is a
 * GEOGRAPHY SET bounding another criterion's screen. A runnable
 * screen intent therefore took the screen-first path: the specimen
 * screened all 33,791 places nationally, researched the first 10
 * cheapest places in the country, and rendered the state
 * classification the research had returned as a footnote — no state
 * winner, no in-state winner, and the national head (Corbin, KY)
 * sat in a state the classification excludes.
 *
 * The gate is structural, never criterion-specific (the standing
 * NO SINGLE-MODE TOOLS rule): it engages when the question's own
 * structure says a researched criterion DEFINES the geography —
 *   1. the intent names no geography (the bound must be derived);
 *   2. a Census extremum is present (an intent metric or a
 *      decomposed-metric criterion) for the gate to bound;
 *   3. the question carries a state-domain CLASSIFYING clause —
 *      a superlative ("what/which state ... most/least/best/worst
 *      ..."), an absence predicate ("which state has no income
 *      tax"), or a presence predicate whose criterion carries a
 *      favorable marker ("which states allow ...") — AND a
 *      dependent bound ("in/for/among that state / those states /
 *      the same state", or a closing "there") tying the extremum
 *      to the classification's output. Round 3 (2026-11-04): the
 *      tax specimen classified by predicate with a set-valued
 *      answer and no superlative anywhere; requiring one left the
 *      gate unengaged while a state-aggregate screen ranked by an
 *      unasked measure answered in its place;
 *   4. a residue ("combined") researched criterion with no Census
 *      decomposition exists to do the classifying — catalog
 *      criteria keep their shipped per-place semantics, and a
 *      criterion with no state clause in the question (the
 *      "good beer selection" class) never engages the gate.
 *
 * When it engages, the runner resolves the classification FIRST
 * (one research pass over the ~50 states), this module classifies
 * states deterministically from the returned prose, and the screen
 * runs bounded to the qualifying set through the pipeline's
 * existing geographyZctas seam — the same seam the near frame uses.
 * If the research singles out ONE state as the superlative winner,
 * the bound is that state (the question's "in that state" is
 * singular); otherwise the bound is the full favorable class, and
 * the answer says so with its coverage. An empty classification
 * engages nothing: the shipped path stands, exactly as the near
 * frame behaves when it cannot form.
 */

import { STATE_NAME_BY_CODE } from '../sweep/states'
import type { ValidatedIntent } from './provider'

/** A criterion reference in the decomposition's own shape. */
export interface GateCriterionRef {
  id: string
  label: string
  text: string
  decomposedMetricKey?: string | null
}

export interface GateStateRef {
  code: string
  name: string
}

export interface GeographyGateSpec {
  /** The classifying criterion (residue class, no Census decomposition). */
  criterion: GateCriterionRef
  /**
   * The dependent extremum's Census metric: the decomposed
   * criterion's own key when the question decomposes one (the
   * deterministic measure mapping — "lowest cost of living" is
   * median_gross_rent on every path), else the intent's first
   * metric. The runner leads the gate run's intent with it, so a
   * parse that named a different measure first (the tax specimen's
   * live parse led with household income) cannot silently re-rank
   * the bounded screen by an unasked measure.
   */
  extremumMetricKey: string | null
}

const STATE_SUPERLATIVE_RE =
  /\b(?:what|which)\s+state\b[^.?!]*\b(?:most|least|best|worst|highest|lowest|strongest|weakest|toughest|strictest)\b/i
const STATE_WITH_SUPERLATIVE_RE =
  /\bstates?\s+with\s+the\s+(?:most|least|best|worst|highest|lowest)\b/i
const DEPENDENT_BOUND_RE = /\bin\s+(?:that|those|the same)\s+states?\b/i
/**
 * A state clause predicating an ABSENCE ("which state has no
 * income tax", "states that have no sales tax"): the researched
 * criterion CLASSIFIES states by a predicate, with a set-valued
 * answer, instead of ranking them by a superlative (round 3,
 * 2026-11-04 — the tax specimen carried no superlative at all,
 * and the round-1 detection, which required one, never engaged).
 */
const STATE_ABSENCE_CLAUSE_RE =
  /\b(?:which|what)\s+states?\b[^.?!]*?\b(?:has|have|having)\s+no\s+[a-z]/i
const STATES_THAT_ABSENCE_RE = /\bstates?\s+(?:that|which)\s+(?:have|has|having)\s+no\s+[a-z]/i
/** Any state-domain clause ("which states ...", "states that ..."). */
const STATE_CLAUSE_RE = /\b(?:which|what)\s+states?\b|\bstates?\s+(?:that|which)\b/i
/**
 * The dependent bound's wider prepositions (round 3): the tax
 * specimen binds with "for those states", where round 1 read only
 * "in that state". The bare anaphor "there" closing the question
 * ("...the cheapest rent zip there?") binds the same way.
 */
const DEPENDENT_BOUND_WIDE_RE =
  /\b(?:in|for|within|among|across)\s+(?:that|those|the same)\s+states?\b/i
const DEPENDENT_THERE_RE = /\bthere\s*[?.!]*$/i
const RESTRICTIVE_POLE_RE =
  /\b(?:strictest|toughest|harshest|most restrictive|least relaxed|least permissive|most prohibitive)\b/i

/**
 * Detect the gate shape from the question's structure alone.
 * Returns the classifying criterion when the shape holds, else null.
 */
export function detectGeographyGate(input: {
  queryText: string
  intent: Pick<ValidatedIntent, 'geographies' | 'metricKeys' | 'mode'>
  researchCriteria: readonly GateCriterionRef[]
}): GeographyGateSpec | null {
  if (!input.queryText || input.intent.geographies.length > 0) return null
  if (input.intent.mode === 'similarity') return null
  const hasExtremum =
    input.intent.metricKeys.length > 0 ||
    input.researchCriteria.some((c) => !!c.decomposedMetricKey)
  if (!hasExtremum) return null
  const criterion = input.researchCriteria.find((c) => c.id === 'combined' && !c.decomposedMetricKey)
  if (!criterion) return null
  // The classifying clause, three shapes (round 3): a state-domain
  // SUPERLATIVE ("what state has the most relaxed drug laws"), an
  // ABSENCE predicate ("which state has no income tax"), or a
  // PRESENCE predicate whose criterion text carries a favorable
  // marker ("which states allow recreational marijuana" — the
  // criterion itself must say the favorable thing, so a Census
  // state question that merely decomposes beside a residue
  // criterion is not swept in). A pure Census state superlative
  // (the FM-9 pair) never reaches here: it decomposes to no
  // residue criterion at all.
  const superlativeClause =
    STATE_SUPERLATIVE_RE.test(input.queryText) || STATE_WITH_SUPERLATIVE_RE.test(input.queryText)
  const absenceClause =
    STATE_ABSENCE_CLAUSE_RE.test(input.queryText) || STATES_THAT_ABSENCE_RE.test(input.queryText)
  const presenceClause =
    STATE_CLAUSE_RE.test(input.queryText) &&
    (FAVORABLE_RE.test(criterion.text) || /\b(?:allows?|permits?)\b/i.test(input.queryText))
  if (!superlativeClause && !absenceClause && !presenceClause) return null
  if (
    !DEPENDENT_BOUND_RE.test(input.queryText) &&
    !DEPENDENT_BOUND_WIDE_RE.test(input.queryText) &&
    !DEPENDENT_THERE_RE.test(input.queryText)
  ) {
    return null
  }
  const extremumMetricKey =
    input.researchCriteria.find((c) => !!c.decomposedMetricKey)?.decomposedMetricKey ??
    input.intent.metricKeys[0] ??
    null
  return { criterion, extremumMetricKey }
}

/**
 * The classification research ask: the reader's question, plus the
 * instruction the classification extraction below reads — enumerate
 * the criterion's standing across the whole domain, and name any
 * single state the sources identify as the strongest example.
 * Appending a focus instruction to the question text is the
 * runner's established research-query pattern. Round 2 (2026-11-04,
 * measured live on 2e04268): the round-1 ask ("list every state")
 * still returned prose centered on ONE state (Oregon's
 * decriminalization) with the favorable class carried as background,
 * and the classifier followed the narrative focus to a one-state
 * class. The ask now requires the domain-wide enumeration itself —
 * the standing state by state, as an explicit list covering the
 * full set the sources support — so the prose the classifier reads
 * enumerates the class instead of exemplifying it.
 */
export function gateClassificationQueryText(queryText: string, spec: GeographyGateSpec): string {
  // Predicate criteria (round 3): the disjunction is part of the
  // ask — each alternative is enumerated separately, so the prose
  // the classifier reads carries per-alternative membership, and
  // the evidence can say which states qualified under which part.
  const alternatives = parsePredicateAlternatives(spec.criterion.text)
  if (alternatives) {
    const parts = alternatives
      .map((alternative) =>
        alternative.negated
          ? `For the part "no ${alternative.phrase}": enumerate every U.S. state that currently ` +
            `has no ${alternative.phrase}, as an explicit list, naming each state in its own ` +
            `sentence stating that it has no ${alternative.phrase}, covering the full set the ` +
            'sources support rather than focusing on any single state.'
          : `For the part "${alternative.label}": enumerate every U.S. state that currently ` +
            `meets it, as an explicit list, naming each state in its own sentence with the ` +
            'basis the sources give, covering the full set the sources support rather than ' +
            'focusing on any single state.',
      )
      .join(' ')
    return (
      `${queryText} For the state part of the question, answer from current sources, taking ` +
      `each part of the criterion separately. ${parts}`
    )
  }
  return (
    `${queryText} For the state part of the question, answer from current sources with the ` +
    `criterion's standing across the whole country, state by state: enumerate every U.S. state ` +
    `that currently meets this criterion — ${spec.criterion.text} — as an explicit list, ` +
    'naming each state in its own sentence with the basis the sources give, covering the ' +
    'full set the sources support rather than focusing on any single state; then name any ' +
    'single state the sources identify as the strongest example.'
  )
}

/**
 * The gate's count phrase, agreeing with its count: "1 state",
 * "24 states". Round 2 (2026-11-04, measured live on 2e04268): the
 * criterion evidence rendered "Research classifies 1 states as
 * meeting this criterion" over the one-state class — every
 * count-bearing gate sentence (the evidence entry, the runner's
 * bound disclosure) interpolated the bare numeral against a fixed
 * plural. All of them read through this helper instead.
 */
export function stateCountPhrase(count: number): string {
  return count === 1 ? '1 state' : `${count} states`
}

/** State name -> code, from the shipped name table (states + DC + PR). */
const STATE_CODE_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(STATE_NAME_BY_CODE).map(([code, name]) => [name.toLowerCase(), code]),
)

/**
 * State codes accepted as classification subjects: the 50 states +
 * DC. The name table also carries the territories (AS/GU/MP/PR/VI);
 * a state-law classification roundup's subjects are states, and a
 * territory's own regime is not the classification the question asks
 * for, so territories never classify (their rows can still be
 * screened by an ordinary geography bound, unchanged).
 */
const TERRITORY_CODES: ReadonlySet<string> = new Set(['AS', 'GU', 'MP', 'PR', 'VI'])
const CLASSIFIABLE_CODES: ReadonlySet<string> = new Set(
  Object.keys(STATE_NAME_BY_CODE).filter((code) => !TERRITORY_CODES.has(code)),
)

const FAVORABLE_RE =
  /\blegal(?:ized|ised|ization|isation)?\b|\bdecriminali[sz]ed\b|\bpermitted\b|\ballowed\b/i
const UNFAVORABLE_RE =
  /\billegal\b|\bprohibit(?:ed|s|ion)?\b|\bbanned\b|\bcriminali[sz]ed\b|\bnot\s+legal\b/i
const SUPERLATIVE_RE = /\b(?:most|least|best|worst)\b/i

/** States a prose sentence mentions, by full name or ", ST" suffix. */
export function statesMentionedIn(sentence: string): GateStateRef[] {
  const found = new Map<string, GateStateRef>()
  const lower = sentence.toLowerCase()
  for (const [name, code] of STATE_CODE_BY_NAME) {
    if (!CLASSIFIABLE_CODES.has(code)) continue
    // Full-name match on word boundaries; single-word names that are
    // also common words (e.g. none in the state list) need no extra
    // guard beyond the boundary test.
    const re = new RegExp(`\\b${name.replace(/[.*+?^${'{}'}()|[\]\\]/g, '\\$&')}\\b`)
    if (re.test(lower)) found.set(code, { code, name: STATE_NAME_BY_CODE[code]! })
  }
  for (const match of sentence.matchAll(/,\s*([A-Z]{2})\b/g)) {
    const code = match[1]!
    if (CLASSIFIABLE_CODES.has(code) && STATE_NAME_BY_CODE[code]) {
      found.set(code, { code, name: STATE_NAME_BY_CODE[code] })
    }
  }
  return [...found.values()]
}

const ENUM_COUNT_RE = /\b\d+\s+(?:states|jurisdictions)\b/i
const ENUM_NEGATION_RE = /\b(?:not|never|no)\b/i

/**
 * Whether a sentence ANNOUNCES an enumerated class for the
 * criterion's pole: it carries the pole's marker, no opposite-pole
 * marker and no negation, and it either ends in a colon (a list
 * follows), carries a class count ("fully legal in 24 states"),
 * uses an announcing verb ("the states ... include"), or is a
 * short favorable heading naming the class ("Fully legal states"),
 * whose items follow on the next lines. Round 2 (2026-11-04,
 * measured live on 2e04268): the round-1 classifier read prose
 * sentence by sentence on markers alone, so when the live research
 * centered its narrative on one state and carried the favorable
 * class as a bare list under a lead-in, the list items — carrying
 * no marker of their own — classified nothing, and the class
 * collapsed to the narrative's focus (Oregon alone). An announced
 * enumeration is the research's explicit membership assertion for
 * the whole domain; it outranks elimination-by-focus.
 */
function isEnumerationLead(sentence: string, favorableRe: RegExp, unfavorableRe: RegExp): boolean {
  if (!favorableRe.test(sentence)) return false
  if (unfavorableRe.test(sentence)) return false
  if (ENUM_NEGATION_RE.test(sentence)) return false
  if (sentence.trimEnd().endsWith(':')) return true
  if (ENUM_COUNT_RE.test(sentence)) return true
  if (/\b(?:following|include|including)\b/i.test(sentence)) return true
  // A short favorable heading that names the class but no state of
  // its own: the list itself follows on the next lines.
  return (
    statesMentionedIn(sentence).length === 0 &&
    /\bstates?\b|\bjurisdictions\b/i.test(sentence) &&
    sentence.split(/\s+/).filter(Boolean).length <= 7
  )
}

/**
 * Whether a unit continues an announced enumeration: it carries no
 * opposite-pole marker, and either it is itself a further lead
 * (a colon announcement naming no state — the counted lead and the
 * list lead often arrive as two consecutive lines) or it is shaped
 * like a list item naming states — a bare name or short comma run,
 * or a longer run naming several states at once. The block ends at
 * the first unit that is neither.
 */
function enumerationContinuation(
  sentence: string,
  favorableRe: RegExp,
  unfavorableRe: RegExp,
): boolean {
  if (unfavorableRe.test(sentence)) return false
  const states = statesMentionedIn(sentence)
  if (states.length === 0) return isEnumerationLead(sentence, favorableRe, unfavorableRe)
  if (states.length >= 3) return true
  const words = sentence.replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean)
  return words.length <= 8
}

export interface StateClassification {
  /** Every state the research classifies as meeting the criterion. */
  favorableStates: GateStateRef[]
  /**
   * The single state the research superlativizes, when exactly one
   * is so marked; null when the research returns a class with no
   * singled-out winner (the honest shape for most roundups).
   */
  winnerState: GateStateRef | null
  /** The classification sentences themselves, kept as cited claims. */
  claims: string[]
  /**
   * Per-alternative accounting, present exactly when the criterion
   * parsed as predicate alternatives (round 3): each alternative
   * the criterion states, with the states the research classified
   * under it (possibly none — the accounting names the part either
   * way). favorableStates is the alternatives' union.
   */
  alternatives?: readonly {
    label: string
    phrase: string
    negated: boolean
    states: GateStateRef[]
  }[]
}

/**
 * One predicate alternative as the criterion states it: the noun
 * phrase the classification predicates ("income tax") and whether
 * the criterion predicates its ABSENCE ("no income tax") or its
 * presence. The label is the reader's own wording for the part.
 */
export interface PredicateAlternative {
  label: string
  phrase: string
  negated: boolean
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${'()|[\]\\'}]/g, '\\$&')

/**
 * Parse a residue criterion's text into predicate alternatives, or
 * null when the criterion is not an absence-predicate
 * classification. The parse reads the classifying clause's own
 * grammar: the predicate after has/have ("has no income tax? or
 * sales tax") splits on "or" into alternatives, and a leading
 * negation distributes over the split ("has no A or B" predicates
 * the absence of both). The dependent extremum's clause, when the
 * criterion text carries the whole question, is cut away first.
 * At least one alternative must be negated for the parse to hold:
 * a presence-only or superlative criterion ("the most relaxed
 * drug laws") keeps the marker classification below, unchanged.
 */
export function parsePredicateAlternatives(criterionText: string): PredicateAlternative[] | null {
  const head = /\b(?:has|have|having)\s+(.+)$/i.exec(criterionText)
  if (!head) return null
  let region = head[1]!
  const cuts = [
    /\s+(?:and|but)\s+(?:what|which|where)\b/i,
    /,\s*(?:and\s+)?(?:what|which|where)\b/i,
    /\b(?:in|for|within|among|across)\s+(?:that|those|the same)\s+states?\b/i,
  ]
  let cutAt = region.length
  for (const cut of cuts) {
    const m = cut.exec(region)
    if (m && m.index < cutAt) cutAt = m.index
  }
  region = region.slice(0, cutAt).replace(/[?.,;]+/g, ' ').trim()
  if (!region) return null
  const alternatives: PredicateAlternative[] = []
  let sharedNegation = false
  for (const rawChunk of region.split(/\s+or\s+/i)) {
    let chunk = rawChunk.trim().replace(/\s+/g, ' ')
    if (!chunk) continue
    let negated = sharedNegation
    const negation = /^(?:no|without)\s+(.+)$/i.exec(chunk)
    if (negation) {
      negated = true
      sharedNegation = true
      chunk = negation[1]!
    }
    const phrase = chunk
      .replace(/^(?:a|an|the)\s+/i, '')
      .replace(/^(?:state|statewide)\s+/i, '')
      .trim()
    if (!phrase || phrase.split(/\s+/).length > 5) return null
    if (SUPERLATIVE_RE.test(phrase) || /\b(?:most|least|best|worst)\b/i.test(phrase)) return null
    alternatives.push({
      label: `${negated ? 'no ' : ''}${phrase}`,
      phrase,
      negated,
    })
  }
  if (alternatives.length === 0) return null
  if (!alternatives.some((a) => a.negated)) return null
  return alternatives
}

/** The sentence patterns asserting an alternative's ABSENCE of its phrase. */
function absencePatternsFor(phrase: string): RegExp[] {
  const p = escapeRegExp(phrase)
  return [
    new RegExp(`\\bno\\s+(?:[a-z]+\\s+){0,2}${p}\\b`, 'i'),
    new RegExp(`\\bwithout\\s+(?:a\\s+|an\\s+)?(?:[a-z]+\\s+){0,1}${p}\\b`, 'i'),
    new RegExp(`\\bdo(?:es)?\\s+not\\s+(?:[a-z]+\\s+){0,3}${p}\\b`, 'i'),
  ]
}

/** The sentence pattern asserting an alternative's phrase is PRESENT (levied/held). */
function presencePatternFor(phrase: string): RegExp {
  const p = escapeRegExp(phrase)
  return new RegExp(
    `\\b(?:levies|levy|imposes|impose|charges|charge|collects|collect|has|have)\\s+(?:a\\s+|an\\s+)?(?:[a-z]+\\s+){0,2}${p}\\b`,
    'i',
  )
}

/**
 * Deterministic sentence-level classification of the research prose.
 *
 * A sentence classifies the states it mentions when it carries a
 * favorable marker for the criterion's pole and no unfavorable
 * marker (a contrast sentence carrying both is skipped —
 * conservative: the coverage the answer states is the count
 * actually classified, and the classification ask makes the
 * research enumerate the favorable set in clean sentences, the
 * shape the specimen's own research returned). The pole flips on a
 * restrictive superlative in the criterion's own words ("strictest
 * drug laws" classifies on the restrictive markers). A sentence
 * with a superlative marker, a favorable marker, and exactly one
 * state marks that state as the research's singled-out winner.
 *
 * Before that pass, an enumeration pass collects any ANNOUNCED
 * class (isEnumerationLead): the lead sentence plus its list-shaped
 * continuation units classify every state they name, markers or
 * not — a counted/listed class in the prose is the domain-wide
 * assertion and outranks the narrative's focus. Prose carrying no
 * announced enumeration is untouched by the pass, so a genuinely
 * narrow classification stays narrow.
 */
/**
 * Predicate classification (round 3): each alternative classifies
 * separately, on its own assertions. A sentence classifies every
 * state it names under an alternative when it asserts that
 * alternative — for a negated alternative, an absence assertion
 * ("Alaska has no state income tax", "Oregon does not levy a
 * sales tax"); a sentence asserting the phrase's PRESENCE under a
 * negated alternative classifies nothing under it (absence is
 * checked first: "has no income tax" also matches a naive "has
 * ... income tax" presence read). An absence assertion carrying a
 * colon or a class count announces an enumeration, and list-shaped
 * continuation units extend that alternative's set, on the round-2
 * principle: an announced list is the domain-wide assertion.
 * Nothing is invented: prose supporting only a narrow set under
 * an alternative classifies exactly that set.
 */
function classifyPredicateAlternatives(
  sentences: readonly string[],
  alternatives: readonly PredicateAlternative[],
): StateClassification {
  const favorable = new Map<string, GateStateRef>()
  const claims: string[] = []
  const claimed = new Set<string>()
  const pushClaim = (sentence: string) => {
    if (!claimed.has(sentence)) {
      claimed.add(sentence)
      claims.push(sentence)
    }
  }
  const perAlternative: { label: string; phrase: string; negated: boolean; states: GateStateRef[] }[] =
    alternatives.map((alternative) => ({ ...alternative, states: [] as GateStateRef[] }))
  alternatives.forEach((alternative, altIndex) => {
    const record = perAlternative[altIndex]!
    const byCode = new Map<string, GateStateRef>()
    const absenceRes = alternative.negated ? absencePatternsFor(alternative.phrase) : []
    const presenceRe = presencePatternFor(alternative.phrase)
    const asserts = (sentence: string): boolean =>
      alternative.negated
        ? absenceRes.some((re) => re.test(sentence))
        : presenceRe.test(sentence) && !/\bnot\b|\bno\s/i.test(sentence)
    const classifiesAgainst = (sentence: string): boolean =>
      alternative.negated ? presenceRe.test(sentence) && !asserts(sentence) : false
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i]!
      if (!asserts(sentence)) continue
      pushClaim(sentence)
      const named = statesMentionedIn(sentence)
      for (const state of named) byCode.set(state.code, state)
      // An announced enumeration for THIS alternative: list-shaped
      // continuations extend its set until a unit that asserts
      // against it or plainly leaves the list.
      const announces =
        sentence.trimEnd().endsWith(':') || ENUM_COUNT_RE.test(sentence) || named.length >= 2
      if (!announces) continue
      for (let j = i + 1; j < sentences.length; j++) {
        const unit = sentences[j]!
        if (asserts(unit)) break
        if (classifiesAgainst(unit)) break
        // A unit carrying ANY alternative's phrase has left this
        // alternative's list — the next part's own sentences carry
        // its phrase and must not be absorbed into this set.
        if (alternatives.some((a) => unit.toLowerCase().includes(a.phrase))) break
        const unitStates = statesMentionedIn(unit)
        if (unitStates.length === 0) break
        const words = unit.replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean)
        if (unitStates.length < 3 && words.length > 8) break
        pushClaim(unit)
        for (const state of unitStates) byCode.set(state.code, state)
      }
    }
    record.states = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const state of record.states) favorable.set(state.code, state)
  })
  return {
    favorableStates: [...favorable.values()].sort((a, b) => a.name.localeCompare(b.name, 'en')),
    winnerState: null,
    claims,
    alternatives: perAlternative,
  }
}

export function classifyStatesFromResearch(
  prose: string,
  spec: GeographyGateSpec,
): StateClassification {
  const restrictive = RESTRICTIVE_POLE_RE.test(spec.criterion.text)
  const favorableRe = restrictive ? UNFAVORABLE_RE : FAVORABLE_RE
  const unfavorableRe = restrictive ? FAVORABLE_RE : UNFAVORABLE_RE
  const sentences = prose
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[#*\-\s]+/, '').trim())
    .filter((s) => s.length > 0)
  // Predicate criteria (round 3) classify per alternative on the
  // alternatives' own assertions, not on the marker vocabulary —
  // the marker sets speak the language of law roundups and say
  // nothing about a tax regime. The parse is absence-gated, so
  // superlative and presence criteria never route here.
  const predicateAlternatives = parsePredicateAlternatives(spec.criterion.text)
  if (predicateAlternatives) return classifyPredicateAlternatives(sentences, predicateAlternatives)
  const favorable = new Map<string, GateStateRef>()
  const claims: string[] = []
  const claimed = new Set<string>()
  const pushClaim = (sentence: string) => {
    if (!claimed.has(sentence)) {
      claimed.add(sentence)
      claims.push(sentence)
    }
  }
  // Enumeration pass: collect each announced class as a class.
  for (let i = 0; i < sentences.length; i++) {
    const lead = sentences[i]!
    if (!isEnumerationLead(lead, favorableRe, unfavorableRe)) continue
    pushClaim(lead)
    for (const state of statesMentionedIn(lead)) favorable.set(state.code, state)
    for (let j = i + 1; j < sentences.length; j++) {
      const unit = sentences[j]!
      if (!enumerationContinuation(unit, favorableRe, unfavorableRe)) break
      pushClaim(unit)
      for (const state of statesMentionedIn(unit)) favorable.set(state.code, state)
    }
  }
  const winners = new Map<string, GateStateRef>()
  for (const sentence of sentences) {
    const states = statesMentionedIn(sentence)
    if (states.length === 0) continue
    const favorableHit = favorableRe.test(sentence)
    const unfavorableHit = unfavorableRe.test(sentence)
    if (!favorableHit || unfavorableHit) continue
    for (const state of states) favorable.set(state.code, state)
    pushClaim(sentence)
    if (states.length === 1 && SUPERLATIVE_RE.test(sentence)) {
      winners.set(states[0]!.code, states[0]!)
    }
  }
  return {
    favorableStates: [...favorable.values()].sort((a, b) => a.name.localeCompare(b.name, 'en')),
    winnerState: winners.size === 1 ? [...winners.values()][0]! : null,
    claims,
  }
}

/**
 * The gate context the runner hands the pipeline: the classification
 * record the answer composes from. `boundStates` is the screen's
 * bound (the winner alone when the research singled one out, else
 * the full favorable class); `classifiedStates` is the whole
 * favorable class, for the coverage the answer states.
 */
export interface GeographyGateContext {
  criterionId: string
  criterionLabel: string
  criterionText: string
  boundStates: GateStateRef[]
  classifiedStates: GateStateRef[]
  winnerState: GateStateRef | null
  /**
   * Per-alternative accounting (round 3), present exactly when the
   * criterion classified by predicate alternatives: which states
   * qualified under which alternative (a state under two parts
   * appears in both lists and once in the union bound). The
   * criterion evidence entry renders one line per part from this.
   */
  alternatives?: readonly {
    label: string
    phrase: string
    negated: boolean
    states: GateStateRef[]
  }[]
  /** Classification sentences as claims, with the research's source URLs. */
  claims: { text: string; sourceUrls: string[] }[]
  sources: { title: string; url: string }[]
}

export function buildGeographyGateContext(input: {
  spec: GeographyGateSpec
  classification: StateClassification
  sources: readonly { title: string; url: string }[]
}): GeographyGateContext | null {
  const { classification } = input
  if (classification.favorableStates.length === 0) return null
  const urls = input.sources.map((s) => s.url)
  const boundStates = classification.winnerState
    ? [classification.winnerState]
    : classification.favorableStates
  return {
    criterionId: input.spec.criterion.id,
    criterionLabel: input.spec.criterion.label,
    criterionText: input.spec.criterion.text,
    boundStates,
    classifiedStates: classification.favorableStates,
    winnerState: classification.winnerState,
    ...(classification.alternatives ? { alternatives: classification.alternatives } : {}),
    claims: classification.claims.map((text) => ({ text, sourceUrls: [...urls] })),
    sources: input.sources.map((s) => ({ title: s.title, url: s.url })),
  }
}

/** The state suffix of a "Name, ST" place name, or null (stateSuffixOf's rule). */
export function stateCodeOfPlaceName(name: string): string | null {
  const match = /, ([A-Z]{2})$/.exec(name.trim())
  return match ? match[1]! : null
}

/** The ZCTAs of the given rows that sit in the bound states — the screen's bound set. */
export function gateBoundZctas(
  rows: readonly { zcta: string; name: string }[],
  boundStates: readonly GateStateRef[],
): Set<string> {
  const codes = new Set(boundStates.map((s) => s.code))
  const zctas = new Set<string>()
  for (const row of rows) {
    const code = stateCodeOfPlaceName(row.name)
    if (code && codes.has(code)) zctas.add(row.zcta)
  }
  return zctas
}
