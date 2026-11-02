/**
 * The national screen: a placeless sweep over the whole country, sorted
 * by one sortable measure. It exists because a natural question —
 * "what's the cheapest housing in the whole country?" (the owner's own
 * live test, 2026-11-01) — names no place and chooses no bound, so the
 * intent layer clarified it and the clarification offered no forward
 * path: its only move was "add a place", which defeats the question as
 * asked. The manual table already answers the question by sorting; this
 * module gives the Ask path the same completion, deterministically —
 * no model behaviour is involved, so the golden corpus contract is
 * untouched (the corpus holds no placeless or filter-less sweep case;
 * verified when this landed).
 *
 * Two entry points share the one intent shape:
 *  - rescueNationalScreen: the reader's own words carry an ascending
 *    superlative plus exactly one sortable measure ("cheapest rent in
 *    America") and the model's reply clarified with neither. The Ask
 *    panel presents the constructed screen as the understood request,
 *    with a note disclosing the reading, before anything runs.
 *  - resolveClarification (intent-edit.ts): the reader picks a measure
 *    in the clarification panel while no place is named or picked.
 *
 * Descending superlatives ("most expensive") do not rescue: execution
 * sorts a screen ascending, and presenting a lowest-first table for a
 * highest-first question would misstate the request. They clarify, as
 * before. Sorting is a presentation of figures, never a verdict about
 * a place — the same line the manual sort already walks.
 *
 * Measure-less cost questions (owner live failure, 2026-11-02: "What's
 * the cheapest place to live" clarified and dead-ended): a cost
 * superlative over a generic place to live — place, area,
 * neighbourhood, town, city — names no measure, so the explicit
 * phrases above cannot fire. That family defaults to median gross
 * rent: it is the measure the Ask stat band itself headlines (App's
 * screenStats leads with the cheapest median rent over the loaded
 * screen), so the default is the product's own headline cost figure,
 * disclosed in the panel note before anything runs, not an invented
 * composite "cost of living". The default fires only when no explicit
 * measure phrase matched and the question carries no other object
 * (schools and the like — see NON_COST_OBJECT_RE): "cheapest schools"
 * is not a rent question, and "best place to raise a family" carries
 * no cost superlative at all, so both still clarify.
 */
import { isFilterLegal, withRunnability } from './intent-schema'
import type { ValidatedIntent } from './provider'
import { STATE_NAME_BY_CODE } from '../sweep/states'

/**
 * The state a geography names, by code ("TX") or full name ("Texas"),
 * or null. The bounded-superlative rescue and the answer runner share
 * this one reading, so a geography the rescue calls resolvable is a
 * geography the runner can actually resolve.
 */
export function stateCodeForGeography(text: string): string | null {
  const trimmed = text.trim()
  const code = trimmed.toUpperCase()
  if (Object.prototype.hasOwnProperty.call(STATE_NAME_BY_CODE, code)) return code
  const lower = trimmed.toLowerCase()
  for (const [stateCode, name] of Object.entries(STATE_NAME_BY_CODE)) {
    if (name.toLowerCase() === lower) return stateCode
  }
  return null
}

/**
 * Whether a geography is resolvable enough for a bounded screen: a
 * ZIP, a state (code or full name), or a "City, ST" place whose state
 * suffix pins it. A bare place name ("Springfield") is NOT — which
 * same-named place was meant is a real ambiguity, and it keeps its
 * clarification.
 */
export function isBoundedScreenGeography(text: string): boolean {
  const trimmed = text.trim()
  if (/^\d{5}$/.test(trimmed)) return true
  if (stateCodeForGeography(trimmed)) return true
  const suffixed = /^(.+?),\s*([A-Za-z]{2})$/.exec(trimmed)
  return !!suffixed && stateCodeForGeography(suffixed[2]!) !== null
}

/** The bounded-screen intent shape: a sweep over one named geography, sorted by its measure. */
export function boundedScreenIntent(metricKey: string, geographies: string[]): ValidatedIntent {
  return withRunnability({
    mode: 'sweep_filter',
    geographies: [...geographies],
    metricKeys: [metricKey],
    filters: [],
    clarificationNeeded: true,
  })
}

/**
 * Normalise reader text for rescue matching (P3 lexical robustness,
 * battery F-A/B10): ASR transcripts double words ("the most the most
 * cost effective"), drop words, and hyphenate inconsistently. The
 * rescue reads only the reader's words for a superlative reading, so
 * its matching — never figure extraction — tolerates that shape:
 * lowercase, hyphens become spaces, and consecutive duplicate words
 * collapse. Measured against the F-A garble variants in the battery
 * register (doubled "most", doubled "place").
 */
export function normalizeRescueText(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[-/]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
  const collapsed: string[] = []
  for (const word of words) {
    if (collapsed[collapsed.length - 1] !== word) collapsed.push(word)
  }
  // ASR doubling is phrasal as often as it is lexical ("the most the
  // most cost effective" — the F-A transcript): collapse an
  // immediately repeated two- or three-word phrase the same way.
  const phrases: string[] = []
  let i = 0
  while (i < collapsed.length) {
    let repeated = 0
    for (const n of [3, 2]) {
      const prev = phrases.slice(-n).join(' ')
      const next = collapsed.slice(i, i + n).join(' ')
      if (phrases.length >= n && prev === next && next.length > 0) repeated = n
    }
    if (repeated > 0) {
      i += repeated
    } else {
      phrases.push(collapsed[i]!)
      i += 1
    }
  }
  return phrases.join(' ')
}

/**
 * Ascending superlatives the rescue recognises, as PATTERNS over
 * stems (P3 step 1: morphological tolerance, not ever-longer word
 * lists — "cheapest-class forms generally"). A stem plus an -est /
 * most- / least- frame is the reading; a bare "safest" is not a cost
 * reading and never rescues a screen (it routes to research instead).
 */
const ASCENDING_SUPERLATIVE_RE =
  /\b(?:cheap|low|small|afford\w*|inexpens\w*|econom\w*|budget\w*)est\b|\bmost\s+(?:affordable|inexpensive|economical|cost\s+effective|budget\s+friendly|effective)\b|\bleast\s+expensive\b|\blowest\s+cost\b|\bcost\s+effective(?:ness)?\b|\bm[aá]s\s+(?:barato|econ[oó]mico)\b|\bmenor\s+(?:costo|precio)\b/

/**
 * Measure phrases in precedence order: burden before rent (a burden
 * question contains the word "rent"), value/income before the bare
 * rent fallback. Keys are the screening table's sortable surface.
 */
const MEASURE_PHRASES: readonly (readonly [RegExp, string])[] = [
  [/rent burden|burden|share of (their |the )?income|of (their |the )?income/i, 'median_rent_burden_pct'],
  [/home values?|house values?|home prices?|house prices?|property values?/i, 'median_home_value'],
  [/household income|median income|\bincome\b|\bearnings\b/i, 'median_household_income'],
  [/\brents?\b|\brentals?\b/i, 'median_gross_rent'],
  [/\bhouseholds?\b/i, 'households'],
]

/** Reader-facing labels, matching the screening table's column names. */
export const NATIONAL_SCREEN_LABELS: Readonly<Record<string, string>> = {
  median_gross_rent: 'median gross rent',
  median_rent_burden_pct: 'median rent burden',
  median_home_value: 'median home value',
  median_household_income: 'median household income',
  households: 'households',
}

/**
 * Cost superlatives for the measure-less default. A subset of the
 * ascending list on purpose: "smallest" is a size reading and "lowest"
 * alone is a direction, not a cost — neither may default to rent.
 */
const COST_SUPERLATIVES: readonly RegExp[] = [
  /\bcheap\w*est\b/,
  /\bmost affordable\b/,
  /\blowest\s+cost\b/,
  /\bleast expensive\b/,
  /\bmost inexpens\w*\b/,
  // "Cost effective" is a cost-of-living superlative in the reader's
  // words (battery F-A: absent from both lexicons, the bounded screen
  // never fired and Alaska/Oregon/Maine all dead-ended). It matches
  // with or without the "most" frame, and in the ASR-dropped form
  // "most effective" when a generic living place carries the cost
  // reading (costDefaultMeasure requires that noun anyway).
  /\bcost\s+effective(?:ness)?\b/,
  /\bmost effective\b/,
  /\bm[aá]s\s+(?:barato|econ[oó]mico)\b/,
]

/** The cost-effective family on its own: unlike "cheapest housing",
 * "most cost effective" names a cost-of-living reading, not the price
 * of a thing, so it defaults to the headline cost measure even when
 * no generic place noun survives (an ASR-dropped noun must not strand
 * a bounded question whose geography the parse already holds). */
const COST_EFFECTIVE_RE = /\bcost\s+effective(?:ness)?\b/

/**
 * Generic places to live: the noun the cost superlative ranges over
 * when the question is about the cost of living somewhere rather than
 * the cost of a thing. "To live" covers "where is it cheapest to
 * live?" where no place noun appears at all.
 */
const GENERIC_LIVING_PLACE_RE =
  /\b(?:places?|areas?|neighbou?rhoods?|towns?|cities|city|locations?|lugar(?:es)?|ciudad(?:es)?|zona(?:s)?)(?:\s+to\s+live(?:\s+in)?)?\b|\bto\s+live(?:\s+in)?\b|\bpara\s+vivir\b/

/**
 * Objects whose cost is not rent. A question naming one of these is
 * about that thing's price or quality, and defaulting it to a rent
 * screen would answer a question nobody asked ("cheapest schools").
 */
const NON_COST_OBJECT_RE =
  /\b(?:schools?|tuition|colleges?|universit(?:y|ies)|childcare|preschools?|daycare|flights?|hotels?|cars?|insurance|groceries)\b/

/**
 * The measure a measure-less cost-superlative place question defaults
 * to (median gross rent, the stat band's headline measure), or null
 * when the text is not that shape: no cost superlative, no generic
 * place to live, or a non-cost object named instead.
 */
export function costDefaultMeasure(text: string): string | null {
  const lower = normalizeRescueText(text)
  if (!COST_SUPERLATIVES.some((phrase) => phrase.test(lower))) return null
  if (NON_COST_OBJECT_RE.test(lower)) return null
  if (!GENERIC_LIVING_PLACE_RE.test(lower) && !COST_EFFECTIVE_RE.test(lower)) return null
  return 'median_gross_rent'
}

/**
 * The sortable measure an ascending-superlative text names, or null
 * when the text carries no ascending superlative or no sortable
 * measure. "Housing" alone names no measure — rent and home value are
 * both live readings, so that ambiguity stays with the clarification
 * panel, whose measure pick completes the same screen. A measure-less
 * cost question about a place to live is the one exception, and it
 * defaults through costDefaultMeasure above — only after every
 * explicit measure phrase has failed to match, so a question that
 * does carry a measure ("cheapest home values") keeps its own.
 */
export function superlativeMeasure(text: string): string | null {
  const lower = normalizeRescueText(text)
  if (!ASCENDING_SUPERLATIVE_RE.test(lower)) return null
  for (const [phrase, key] of MEASURE_PHRASES) {
    if (phrase.test(lower)) return key
  }
  // Spanish measure nouns (additive only, P3 step 6): "renta" is the
  // rent measure the English phrases above cannot see.
  if (/\brenta\b|\balquiler\b/.test(lower)) return 'median_gross_rent'
  return costDefaultMeasure(lower)
}

/**
 * The 50 states' full names, from the one state table (territories
 * and the district excluded — the recovery below is a US-state
 * bound, and a territory name in the reader's words keeps the
 * existing placeless behaviour).
 */
const FIFTY_STATE_NAMES: readonly string[] = Object.entries(STATE_NAME_BY_CODE)
  .filter(([code]) => !['AS', 'DC', 'GU', 'MP', 'PR', 'VI'].includes(code))
  .map(([, name]) => name)

/**
 * The US state the reader's own words name, or null (P3b cure 4,
 * battery D6 — candidate mode
 * geography_dropped_by_parse_rescue_widening). When the model parse
 * returns EMPTY geographies for "¿Dónde es más barato vivir en
 * California?", the placeless branch of the rescue below widened
 * the screen to the whole nation (Corbin, KY led a California
 * question) and nothing disclosed the widening. The deterministic
 * layer now recovers a geography present only in the reader's
 * words: a full state name matched as written against the static
 * 50-state list, on the rescue's normalised text (longest names
 * first, so "West Virginia" wins over "Virginia"). This is not a
 * translator — "California" is spelled identically in Spanish,
 * which is the measured shape; no other language handling is
 * implied. No state named = null, and the placeless behaviour
 * stands (a genuinely placeless superlative is a national screen,
 * battery B1).
 */
export function stateNamedInWords(text: string | undefined): string | null {
  if (!text || text.trim() === '') return null
  const padded = ` ${normalizeRescueText(text)} `
  const byLength = [...FIFTY_STATE_NAMES].sort((a, b) => b.length - a.length)
  for (const name of byLength) {
    if (padded.includes(` ${name.toLowerCase()} `)) return name
  }
  return null
}

/** The one national-screen intent shape, stamped by the runnability owner. */
export function nationalScreenIntent(metricKey: string): ValidatedIntent {
  return withRunnability({
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: [metricKey],
    filters: [],
    clarificationNeeded: true,
  })
}

/** Whether an intent is a placeless sweep — the national screen. */
export function isNationalScreen(intent: ValidatedIntent): boolean {
  return intent.mode === 'sweep_filter' && intent.geographies.length === 0
}

/**
 * Country-level geography names a reply may attach to a placeless
 * question ("cheapest rent in America" came back with geographies
 * ["America"] in live replies, 2026-11-01). They are not places the app
 * can open, and leaving one in the intent also blocks the clarification
 * panel's own placeless completion, which requires no named place —
 * the reader would have to remove a bogus chip before the measure pick
 * can finish the screen. Matched normalised (lowercase, trimmed,
 * single spaces). Anything not on this list is a real place and keeps
 * its clarification.
 */
const COUNTRY_GEOGRAPHIES: ReadonlySet<string> = new Set([
  'america',
  'united states',
  'united states of america',
  'usa',
  'u.s.',
  'u.s.a.',
  'us',
  'the united states',
  'the us',
  'the country',
  'the nation',
  'the whole country',
  'entire country',
  'nationwide',
  'countrywide',
])

function isCountryGeography(name: string): boolean {
  return COUNTRY_GEOGRAPHIES.has(name.toLowerCase().trim().replace(/\s+/g, ' '))
}

/**
 * Rescue a clarified reply into a national screen when the reply names
 * no real place (at most country-level names) and no measure, and the
 * reader's words carry the superlative reading. Anything else returns
 * null and the clarification stands. The constructed intent is built
 * only from allowlisted keys — superlativeMeasure returns registry keys
 * or null — and isFilterLegal is re-checked here so a future phrase
 * entry cannot widen the surface by accident.
 */
export function rescueNationalScreen(
  intent: ValidatedIntent,
  queryText: string | undefined,
): ValidatedIntent | null {
  if (!intent.clarificationNeeded) return null
  if (typeof queryText !== 'string' || queryText.trim() === '') return null
  // Mixed-intent inclusivity (P3 step 2, battery A3): a retained
  // measure no longer refuses the rescue outright. When the parse
  // kept exactly one filter-legal measure and every real geography
  // is bounded-screen resolvable, the retained measure is USED as
  // the screen's measure — presented as chosen, never re-asked. A
  // placeless retained measure keeps the old posture (nothing to
  // bound, and the reader's superlative words alone do not widen a
  // measure they already picked into a national screen).
  if (intent.metricKeys.length > 0) {
    const retained = intent.metricKeys[0]!
    if (intent.metricKeys.length !== 1 || !isFilterLegal(retained)) return null
    if (!ASCENDING_SUPERLATIVE_RE.test(normalizeRescueText(queryText))) return null
    const real = intent.geographies.filter((g) => !isCountryGeography(g))
    if (real.length === 0 || !real.every(isBoundedScreenGeography)) return null
    return boundedScreenIntent(retained, real)
  }
  const metricKey = superlativeMeasure(queryText)
  if (metricKey === null || !isFilterLegal(metricKey)) return null
  // Geography-bounded superlative (generalization item 4, 2026-11-02:
  // the live-ask residual — "cheapest place to live in Texas" kept
  // its clarification because the national screen never bypassed a
  // named place). Country-level names in the list are not places and
  // drop out; every remaining geography must be resolvable as a
  // bounded screen geography, and the screen is then bounded by
  // exactly those geographies. An unresolvable geography (a bare
  // ambiguous place name, a county the shipped data cannot serve as
  // a screen scope) keeps its clarification.
  const realGeographies = intent.geographies.filter((g) => !isCountryGeography(g))
  if (realGeographies.length === 0) {
    // Geography recovery (P3b cure 4, battery D6): the parse dropped
    // every geography, but the reader's words may still name the
    // bound. A state named in the words bounds the screen to that
    // state instead of widening it to the nation; the panel's
    // rescued note ("This screens California by ...") and the
    // understood-request geography chip disclose the recovered
    // bound on the card's own surfaces. No state in the words = the
    // placeless national screen, as before.
    const recovered = stateNamedInWords(queryText)
    if (recovered) return boundedScreenIntent(metricKey, [recovered])
    return nationalScreenIntent(metricKey)
  }
  if (!realGeographies.every(isBoundedScreenGeography)) return null
  return boundedScreenIntent(metricKey, realGeographies)
}

/**
 * Parsed-intent completion (P3 step 6, battery D6): the lexical
 * layer may ADD paths, never veto a parsed servable intent. A parse
 * that itself declares a sweep over bounded geographies — the shape
 * a fully parsed non-English superlative question arrives in, where
 * the English superlative lexicon cannot see the reader's words —
 * completes on the domain default measure (median gross rent, the
 * stat band's headline) regardless of the question's language. This
 * reads the PARSE, not the words: mode sweep_filter, no measure, no
 * filter, every geography bounded-screen resolvable (or country-level,
 * which completes placeless). A bare ambiguous place name, a lookup,
 * or a parse carrying its own measure/filter is untouched and keeps
 * its clarification.
 */
export function completeParsedBoundedScreen(intent: ValidatedIntent): ValidatedIntent | null {
  if (!intent.clarificationNeeded) return null
  if (intent.mode !== 'sweep_filter') return null
  if (intent.metricKeys.length > 0 || intent.filters.length > 0) return null
  const realGeographies = intent.geographies.filter((g) => !isCountryGeography(g))
  if (realGeographies.length === 0) {
    return intent.geographies.length > 0 ? nationalScreenIntent('median_gross_rent') : null
  }
  if (!realGeographies.every(isBoundedScreenGeography)) return null
  return boundedScreenIntent('median_gross_rent', realGeographies)
}
