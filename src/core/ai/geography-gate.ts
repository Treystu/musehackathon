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
 *   3. the question carries a state-domain superlative clause
 *      ("what/which state ... most/least/best/worst ...") AND a
 *      dependent bound ("in that state / those states / the same
 *      state") tying the extremum to the classification's output;
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
}

const STATE_SUPERLATIVE_RE =
  /\b(?:what|which)\s+state\b[^.?!]*\b(?:most|least|best|worst|highest|lowest|strongest|weakest|toughest|strictest)\b/i
const STATE_WITH_SUPERLATIVE_RE =
  /\bstates?\s+with\s+the\s+(?:most|least|best|worst|highest|lowest)\b/i
const DEPENDENT_BOUND_RE = /\bin\s+(?:that|those|the same)\s+states?\b/i
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
  if (!STATE_SUPERLATIVE_RE.test(input.queryText) && !STATE_WITH_SUPERLATIVE_RE.test(input.queryText)) {
    return null
  }
  if (!DEPENDENT_BOUND_RE.test(input.queryText)) return null
  const criterion = input.researchCriteria.find((c) => c.id === 'combined' && !c.decomposedMetricKey)
  if (!criterion) return null
  return { criterion }
}

/**
 * The classification research ask: the reader's question, plus the
 * instruction the classification extraction below reads — name every
 * qualifying state, and name any single state the sources identify
 * as the strongest example. Appending a focus instruction to the
 * question text is the runner's established research-query pattern.
 */
export function gateClassificationQueryText(queryText: string, spec: GeographyGateSpec): string {
  return (
    `${queryText} For the state part of the question, answer from current sources: ` +
    `list every U.S. state that currently meets this criterion — ${spec.criterion.text} — ` +
    'naming each state in its own sentence with the basis the sources give, and name any ' +
    'single state the sources identify as the strongest example.'
  )
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
 */
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
  const favorable = new Map<string, GateStateRef>()
  const claims: string[] = []
  const winners = new Map<string, GateStateRef>()
  for (const sentence of sentences) {
    const states = statesMentionedIn(sentence)
    if (states.length === 0) continue
    const favorableHit = favorableRe.test(sentence)
    const unfavorableHit = unfavorableRe.test(sentence)
    if (!favorableHit || unfavorableHit) continue
    for (const state of states) favorable.set(state.code, state)
    claims.push(sentence)
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
