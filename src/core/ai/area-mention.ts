/**
 * Named areas: a region the reader names ("the Bay Area", "the Pacific
 * Northwest") that is neither a single place in the index, nor a state,
 * nor a Census region.
 *
 * The defect this module exists for (owner live report, 2026-11-04, on
 * the frozen build): "Where is the cheapest place to live to commute
 * and work in the Bay area?" returned a NATIONAL cheapest-rent screen
 * headed "No place was named, so this screens the whole country…".
 * The loss chain, measured against the tree:
 *
 *  - The intent contract has no representation for a region: the parse
 *    prompt admits geographies only as ZIPs, "City, ST", or a state
 *    code, so the model has no legal way to return the area and the
 *    reply carried no geography for it.
 *  - The one word-level geography recovery in the accept seam,
 *    stateNamedInWords, matches full STATE names only; "Bay area"
 *    names no state, so recovery returned null — while the generic
 *    living-place lexicon consumed the word "area" itself as the
 *    noun that arms the measure-less cost default.
 *  - rescueNationalScreen therefore widened the question to the
 *    whole country, and the panel note "No place was named" was
 *    chosen from the intent's empty geography list without ever
 *    consulting the reader's words.
 *
 * The mechanisms here are the seam's established posture — a
 * deterministic reading of the reader's own words, beside the
 * national-screen rescue and the state recovery:
 *
 *  - detectAreaMention finds the mention in the words.
 *  - The rescue refuses its placeless (national) completion while a
 *    mention stands, so the question reaches the clarification
 *    panel — the shipped pre-run sync surface — instead of running
 *    nationally, and the false no-place premise can never render
 *    for a question that names an area.
 *  - REGION_INTERPRETATIONS gives the panel a leading interpretation
 *    to propose for one-tap confirmation, and gives the runner a
 *    membership to resolve: county-precise where the region is a
 *    county set (the CountyIndex carries every ZCTA's county), a
 *    state set where the region is one. The gazetteer is data, not
 *    mechanism: an area with no entry still survives (no widening,
 *    no false premise) and the panel names it and says it cannot
 *    place it yet.
 */
import { STATE_NAME_BY_CODE } from '../sweep/states'

/** A named region's confirmed reading: what it is, and what bounds it. */
export interface RegionInterpretation {
  /** Canonical geography string the confirmed intent carries. */
  geography: string
  /** The proposal as the panel words it, e.g. "the San Francisco Bay Area, California". */
  label: string
  /** Short region name for the answer's disclosure, e.g. "the San Francisco Bay Area". */
  name: string
  /** The region's anchor metro place, "City, ST" — the commute reading's reference. */
  anchor: string
  /** State codes the region spans. */
  states: readonly string[]
  /**
   * County membership (Census county names) when the region is
   * county-precise; absent when the region is a state set.
   */
  counties?: readonly { name: string; state: string }[]
}

const BAY_AREA_COUNTIES: readonly { name: string; state: string }[] = [
  { name: 'Alameda County', state: 'CA' },
  { name: 'Contra Costa County', state: 'CA' },
  { name: 'Marin County', state: 'CA' },
  { name: 'Napa County', state: 'CA' },
  { name: 'San Francisco County', state: 'CA' },
  { name: 'San Mateo County', state: 'CA' },
  { name: 'Santa Clara County', state: 'CA' },
  { name: 'Solano County', state: 'CA' },
  { name: 'Sonoma County', state: 'CA' },
]

const BAY_AREA: RegionInterpretation = {
  geography: 'San Francisco Bay Area',
  label: 'the San Francisco Bay Area, California',
  name: 'the San Francisco Bay Area',
  anchor: 'San Francisco, CA',
  states: ['CA'],
  counties: BAY_AREA_COUNTIES,
}

/**
 * Known named regions, keyed by normalised mention (lowercase, no
 * leading "the"). High-confidence readings only: a wrong membership
 * is worse than an honest "cannot place it yet", which is what an
 * unlisted area gets.
 */
export const REGION_INTERPRETATIONS: Readonly<Record<string, RegionInterpretation>> = {
  'bay area': BAY_AREA,
  'san francisco bay area': BAY_AREA,
  'silicon valley': {
    geography: 'Silicon Valley',
    label: 'Silicon Valley, California',
    name: 'Silicon Valley',
    anchor: 'San Jose, CA',
    states: ['CA'],
    counties: [
      { name: 'Santa Clara County', state: 'CA' },
      { name: 'San Mateo County', state: 'CA' },
    ],
  },
  'pacific northwest': {
    geography: 'Pacific Northwest',
    label: 'the Pacific Northwest (Washington and Oregon)',
    name: 'the Pacific Northwest',
    anchor: 'Seattle, WA',
    states: ['WA', 'OR'],
  },
}

/** Normalise a geography or mention for gazetteer lookup. */
export function normaliseRegionText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
}

/** The interpretation a text names, or null when it names no known region. */
export function regionInterpretationFor(text: string): RegionInterpretation | null {
  return REGION_INTERPRETATIONS[normaliseRegionText(text)] ?? null
}

/** Whether a geography string is a confirmed region geography. */
export function isRegionGeography(text: string): boolean {
  return regionInterpretationFor(text) !== null
}

const STATE_NAMES_LOWER: ReadonlySet<string> = new Set(
  Object.values(STATE_NAME_BY_CODE).map((name) => name.toLowerCase()),
)

/**
 * Capitalised-head area/region phrases: "the Bay area", "the Greater
 * Boston area", "the San Francisco Bay Area". The head must carry a
 * capitalised word — the reader's own emphasis is the signal that a
 * NAME stands here; a bare "the area" is a generic noun, not a named
 * area, and never matches. Read on the original text, before any
 * lowercasing: the rescue's normalised text has already thrown the
 * capitals away, which is part of how the mention was lost.
 */
const CAPITALISED_AREA_RE =
  /\bthe\s+([A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*)*)\s+(area|Area|region|Region)\b/u
const BARE_CAPITALISED_AREA_RE =
  /\b([A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*)+)\s+(area|Area|region|Region)\b/u

/**
 * The region/area mention a question carries, as written (minus a
 * leading "the"), or null. Gazetteer phrases match case-insensitively
 * ("pacific northwest" typed lowercase is still the region); the
 * morphological forms require the capitalised head. State names are
 * excluded — a state is the state recovery's ground, already served.
 */
export function detectAreaMention(queryText: string | undefined): string | null {
  if (!queryText || queryText.trim() === '') return null
  // Gazetteer phrases first: the known regions are mentions however
  // they are cased. The mention is returned as written — the panel's
  // "you named" line quotes the reader's own words, not the
  // gazetteer's canonical form.
  const lower = queryText.toLowerCase().replace(/\s+/g, ' ')
  for (const key of Object.keys(REGION_INTERPRETATIONS)) {
    const at = lower.indexOf(key)
    if (at < 0) continue
    const before = at === 0 ? ' ' : lower[at - 1]!
    const after = lower[at + key.length] ?? ' '
    if (!/[\s,.:;!?]/.test(before) || !/[\s,.:;!?]/.test(after)) continue
    return queryText.replace(/\s+/g, ' ').slice(at, at + key.length)
  }
  for (const pattern of [CAPITALISED_AREA_RE, BARE_CAPITALISED_AREA_RE]) {
    const match = pattern.exec(queryText)
    if (!match) continue
    const head = match[1]!.trim()
    if (STATE_NAMES_LOWER.has(head.toLowerCase())) continue
    return `${head} ${match[2]!.toLowerCase()}`
  }
  return null
}

/**
 * Whether an intent's geographies already cover an area mention: the
 * mention itself, or its interpretation's canonical geography, stands
 * in the list (the parse named the area and it was kept). A covered
 * mention needs no sync — the understood request already shows it.
 */
export function areaMentionCoveredBy(
  mention: string,
  geographies: readonly string[],
): boolean {
  const wanted = new Set([normaliseRegionText(mention)])
  const interpretation = regionInterpretationFor(mention)
  if (interpretation) wanted.add(normaliseRegionText(interpretation.geography))
  return geographies.some((g) => wanted.has(normaliseRegionText(g)))
}
