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

/** Ascending superlatives the rescue recognises, as whole phrases. */
const ASCENDING_SUPERLATIVES: readonly string[] = [
  'cheapest',
  'lowest',
  'most affordable',
  'least expensive',
  'smallest',
]

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
  /\bcheapest\b/,
  /\bmost affordable\b/,
  /\blowest[-\s]cost\b/,
  /\bleast expensive\b/,
  /\bmost inexpensive\b/,
]

/**
 * Generic places to live: the noun the cost superlative ranges over
 * when the question is about the cost of living somewhere rather than
 * the cost of a thing. "To live" covers "where is it cheapest to
 * live?" where no place noun appears at all.
 */
const GENERIC_LIVING_PLACE_RE =
  /\b(?:places?|areas?|neighbou?rhoods?|towns?|cities|city|locations?)(?:\s+to\s+live(?:\s+in)?)?\b|\bto\s+live(?:\s+in)?\b/

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
  const lower = text.toLowerCase()
  if (!COST_SUPERLATIVES.some((phrase) => phrase.test(lower))) return null
  if (!GENERIC_LIVING_PLACE_RE.test(lower)) return null
  if (NON_COST_OBJECT_RE.test(lower)) return null
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
  const lower = text.toLowerCase()
  if (!ASCENDING_SUPERLATIVES.some((word) => lower.includes(word))) return null
  for (const [phrase, key] of MEASURE_PHRASES) {
    if (phrase.test(lower)) return key
  }
  return costDefaultMeasure(lower)
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
  if (intent.metricKeys.length > 0) return null
  if (!intent.geographies.every(isCountryGeography)) return null
  if (typeof queryText !== 'string' || queryText.trim() === '') return null
  const metricKey = superlativeMeasure(queryText)
  if (metricKey === null || !isFilterLegal(metricKey)) return null
  return nationalScreenIntent(metricKey)
}
