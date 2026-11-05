/**
 * The near frame: "where near <place> has <criteria>, within N miles
 * (as compared to <place> itself)".
 *
 * Measured defect (owner live specimen, 2026-11-03, production
 * 9a75c2f): the question named Philadelphia as its anchor and
 * reference, and every shipped layer read the anchor as the answer's
 * universe — geography resolution served ONE of the city's 49 ZIP
 * areas (the lookup/compare single-ZIP rule), the screen bounded to
 * that ZIP, research ran over the anchor alone, and the card
 * certified the reference against itself: "0 miles from itself",
 * "Census-screened for lower-cost rent / home-value" (lower than
 * itself), all three criteria stamped measured, closing on "No other
 * places were named for research, so completeness on 'near
 * Philadelphia' suburbs cannot be established from the web here."
 * The R24 Jev audit of that answer scored all six aspects failing
 * (combined 0.00; primary_gap near_frame_candidates).
 *
 * The frame's semantics, implemented here at the runner/place-index
 * layer (the layer FM-21 assigned anchor resolution to):
 *   - The candidate set is the places AROUND the anchor: every place
 *     in the place index whose nearest ZIP-area centroid is within
 *     the stated radius of one of the anchor's ZIP-area centroids.
 *     The geography data is the product's own — the baked centroid
 *     file the maps render from (zcta-centroids.bin), decoded by
 *     core/map/centroids. No external geocoding is introduced.
 *   - The anchor is the REFERENCE, never a candidate: it is excluded
 *     from its own candidate set, and its baseline figures are
 *     formed from ALL of its ZIP areas through the shipped
 *     aggregation machinery (the single-group form stage 2c uses for
 *     state averages) — never one resolved ZIP wearing the place's
 *     name.
 *   - A stated cost comparative ("lower cost of living", "cheaper")
 *     is a RELATIVE bound against that baseline: a candidate
 *     qualifies on the headline cost measure only strictly below
 *     the reference's figure. The pipeline applies it as a screen
 *     bound, the same species as a stated absolute bound.
 *
 * Detection is deliberately narrow — every condition must hold, so
 * the shipped shapes keep their paths: exactly one named geography,
 * that geography a place (not a state, county, region, or ZIP), the
 * anchor's name present in the reader's words, and a near phrase in
 * those words (an explicit "within N miles", or near/around/suburb
 * of/outside anchored at the place). A plain lookup of the place,
 * a two-place comparison, and every state-bounded shape fail at
 * least one condition and never see this module's effects.
 */
import type { PlaceIndex, PlaceSuggestion } from '../zcta-place-index'
import type { ZctaPoint } from '../map/centroids'
import type { AreaRow } from '../plugins/acs'
import { aggregateRowsToCounties } from '../county-aggregate'
import { STATE_NAME_BY_CODE } from '../sweep/states'
import type { ValidatedIntent } from './provider'

/** The reading for a near phrase with no stated radius. */
export const DEFAULT_NEAR_RADIUS_MILES = 25

const COUNTY_LIKE_RE = /\b(county|parish|borough|census area|municipality)\b/i
const WITHIN_RADIUS_RE = /\bwithin\s+(\d{1,3})\s*miles?\b/i
const COST_COMPARATIVE_RE =
  /\b(?:lower|cheaper|less\s+expensive|more\s+affordable)\b/i

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The place-name part of an intent geography ("Philadelphia, PA" -> "Philadelphia"). */
function geographyNamePart(geography: string): string {
  const comma = geography.indexOf(',')
  return (comma >= 0 ? geography.slice(0, comma) : geography).trim()
}

/** Whether the geography names a state itself (bare code or full name). */
function isStateGeographyText(geography: string): boolean {
  const trimmed = geography.trim()
  if (trimmed.includes(',')) return false
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    return trimmed.toUpperCase() in STATE_NAME_BY_CODE
  }
  const lower = trimmed.toLowerCase()
  return Object.values(STATE_NAME_BY_CODE).some((name) => name.toLowerCase() === lower)
}

/**
 * The state code a bare state geography names, by code ("TX") or
 * full name ("Texas"), or null — the runner's state reading
 * (stateCodeForGeography) mirrored on this module's own import
 * surface, so the detector and the runner read a co-named state
 * identically. A place geography ("Houston, Texas") is not a
 * bare state and reads null here; its suffix is read separately.
 */
function stateCodeOfGeography(geography: string): string | null {
  const trimmed = geography.trim()
  const code = trimmed.toUpperCase()
  if (Object.prototype.hasOwnProperty.call(STATE_NAME_BY_CODE, code)) return code
  const lower = trimmed.toLowerCase()
  for (const [stateCode, name] of Object.entries(STATE_NAME_BY_CODE)) {
    if (name.toLowerCase() === lower) return stateCode
  }
  return null
}

/** The first state any of the intent's geographies names, as a code. */
function coNamedStateCode(geographies: readonly string[]): string | null {
  for (const geography of geographies) {
    const code = stateCodeOfGeography(geography)
    if (code) return code
  }
  return null
}

/**
 * The radius spec's anchor geography for a matched anchor: the
 * anchor's name qualified by its state whenever a state is
 * known — from the anchor's own suffix (a spelled-out suffix,
 * "Houston, Texas", normalizes to its code) or, for a bare name,
 * from the state the intent names beside it. The qualification
 * is what makes the place index's resolution deterministic
 * (round 3, measured 2026-11-04 against the shipped index):
 * search scopes to a suffixed state before ranking, while a
 * bare same-named place resolves in baked index order — bare
 * "Houston" resolves to Houston, AK, and bare "Miami" to
 * Miami, FL only by that order's luck, which is why the Miami
 * specimen's anchor-dropped parse engaged live and the Houston
 * question's could not. A suffix that names no state, and a
 * bare name with no co-named state, keep the anchor verbatim —
 * the shipped reading.
 */
function qualifiedAnchorGeography(
  rawAnchor: string,
  geographies: readonly string[],
): string {
  const trimmed = rawAnchor.trim()
  const comma = trimmed.lastIndexOf(',')
  const name = (comma >= 0 ? trimmed.slice(0, comma) : trimmed).trim()
  const suffix = comma >= 0 ? trimmed.slice(comma + 1).trim() : ''
  if (suffix) {
    const code = stateCodeOfGeography(suffix)
    return code ? `${name}, ${code}` : trimmed
  }
  const coNamed = coNamedStateCode(geographies)
  return coNamed ? `${name}, ${coNamed}` : trimmed
}

export interface NearFrameSpec {
  /** The intent geography string that names the anchor, verbatim. */
  anchorGeography: string
  /** The radius the candidate set is drawn at, in miles. */
  radiusMiles: number
  /** True when the reader stated the radius; false for the default reading. */
  radiusStated: boolean
  /** True when the reader's words carry a cost comparative. */
  relativeCost: boolean
}

/**
 * Detect the near frame in a question, from the reader's words and
 * the parsed intent together. Pure text + intent; no index needed,
 * so the App can precheck with it before any geography load.
 */
export function detectNearFrame(
  queryText: string | undefined,
  intent: ValidatedIntent,
): NearFrameSpec | null {
  if (!queryText || queryText.trim() === '') return null
  if (intent.geographies.length !== 1) return null
  const geography = intent.geographies[0]!.trim()
  if (/^\d{5}$/.test(geography)) return null
  if (COUNTY_LIKE_RE.test(geographyNamePart(geography))) return null
  if (isStateGeographyText(geography)) return null
  const anchorName = geographyNamePart(geography)
  if (anchorName === '') return null
  const text = queryText.toLowerCase()
  const anchorToken = anchorName.toLowerCase()
  if (!text.includes(anchorToken)) return null

  let radiusMiles: number | null = null
  let radiusStated = false
  const within = WITHIN_RADIUS_RE.exec(queryText)
  if (within) {
    radiusMiles = Number.parseInt(within[1]!, 10)
    radiusStated = true
  } else {
    const nearPhrase = new RegExp(
      `\\b(?:near|around|outside|neighbouring|neighboring)\\s+(?:the\\s+)?${escapeRegExp(anchorToken)}\\b` +
        `|\\bsuburbs?\\s+of\\s+(?:the\\s+)?${escapeRegExp(anchorToken)}\\b`,
    )
    if (nearPhrase.test(text)) radiusMiles = DEFAULT_NEAR_RADIUS_MILES
  }
  if (radiusMiles === null || !Number.isFinite(radiusMiles) || radiusMiles <= 0) return null
  return {
    anchorGeography: geography,
    radiusMiles,
    radiusStated,
    relativeCost: COST_COMPARATIVE_RE.test(queryText),
  }
}

const LIKENESS_WORD_RE = /\bsimilar\b|\bresembl\w*\b/i
const PLACE_NOUN_LIKE_RE =
  /\b(?:places|towns|cities|areas|suburbs|neighbourhoods|neighborhoods)\s+like\b/i

/**
 * Whether the reader's words carry an explicit likeness predicate
 * for the anchor ("places similar to Philadelphia", "towns like
 * Philadelphia") — the similarity lane's own signal, as opposed to
 * the frame's proximity + radius + anchored relative bound. The
 * test is anchored: "similar" or "resembling" anywhere, "like"
 * only as the comparison predicate (immediately after a place
 * noun, or immediately before the anchor's name), so an incidental
 * "like" ("what is life like near…") never reads as likeness.
 */
function hasLikenessPredicate(queryText: string, anchorName: string): boolean {
  if (LIKENESS_WORD_RE.test(queryText)) return true
  if (PLACE_NOUN_LIKE_RE.test(queryText)) return true
  const anchorToken = anchorName.toLowerCase()
  return new RegExp(
    `\\blike\\s+(?:the\\s+)?${escapeRegExp(anchorToken)}\\b`,
    'i',
  ).test(queryText)
}

/**
 * The routing discrimination for a parse the model labelled
 * similarity (near-frame round 2, measured live on production
 * 6151d0c, 2026-11-03): the specimen's phrasing — "where near
 * philadelphia has good schools and lower cost of living, within
 * 20 miles (as compared to philadelphia itself)" — parsed as
 * similarity, and every downstream gate keys off that label:
 * answerEligible excludes similarity (it has no pipeline shape),
 * so no answer request was registered, the frame never engaged,
 * and execution opened the similar-ZIP search on the anchor's own
 * first ZIP, leaving a standalone web summary as the answer. The
 * same mechanism with a lookup-shaped phrasing ("What suburbs
 * of Philadelphia have good schools?") engaged the frame live.
 * The label is the model's; the frame's signals are the reader's
 * words, so the routing re-reads the label against the words —
 * the accept seam's established posture for deterministic
 * readings (the national-screen rescue, the bounded-screen
 * completion).
 *
 * The discrimination is the signal set, not surface forms: the
 * intent carries the frame envelope (detectNearFrame: one place
 * geography, the anchor named in the reader's words, a stated
 * radius or a near/suburb phrase anchored at the place) AND the
 * words carry no likeness predicate for the anchor. Genuine
 * similarity questions fail at least one arm — "places similar
 * to Philadelphia" and "towns like Philadelphia for retirees"
 * carry no radius or near phrase, and their likeness predicate
 * would refuse the re-route even with one — so the similarity
 * lane keeps its questions. Casing, the parenthetical, and word
 * order are all inside the envelope because the tests read the
 * lowercased words and the intent together, never a fixed form.
 *
 * The re-routed intent is the frame's proven shape (round 1's
 * traversal pins): a lookup of the anchor carrying the measures
 * to show — the parse's own metricKeys when it carries any, else
 * the caller's completion (the question's decomposed Census keys,
 * else the headline cost measure). Everything else rides
 * verbatim. Null when the discrimination does not fire; the
 * caller stamps runnability, as for every accept-seam transform.
 */
export function rerouteSimilarityToNearFrame(
  intent: ValidatedIntent,
  queryText: string | undefined,
  metricKeysWhenAbsent: readonly string[],
): ValidatedIntent | null {
  if (intent.mode !== 'similarity') return null
  if (!queryText || queryText.trim() === '') return null
  const spec = detectNearFrame(queryText, intent)
  if (!spec) return null
  if (hasLikenessPredicate(queryText, geographyNamePart(spec.anchorGeography))) {
    return null
  }
  const metricKeys =
    intent.metricKeys.length > 0 ? intent.metricKeys : [...metricKeysWhenAbsent]
  if (metricKeys.length === 0) return null
  return { ...intent, mode: 'lookup', metricKeys }
}

/**
 * Whether a decomposed criterion's text is the frame phrase itself
 * (the radius/near segment the decomposition carries as a combined
 * criterion). The frame is served by construction — the candidate
 * set IS the radius test — so the pipeline retires a criterion
 * whose text is only the frame phrase and accounts it from the
 * frame instead. A segment carrying any other content words (a
 * second criterion riding in the same segment) is not the frame
 * and is never retired.
 */
export function isFrameSegmentText(
  text: string,
  frame: { anchorName: string; radiusMiles: number },
): boolean {
  const lower = text.toLowerCase()
  const hasRadius = new RegExp(`\\bwithin\\s+${frame.radiusMiles}\\s*miles?\\b`).test(lower)
  const hasNear =
    /\b(?:near|around|outside|suburbs?\s+of)\b/.test(lower) &&
    lower.includes(frame.anchorName.toLowerCase())
  if (!hasRadius && !hasNear) return false
  const rest = lower
    .replace(new RegExp(escapeRegExp(frame.anchorName.toLowerCase()), 'g'), ' ')
    .replace(
      /\b(?:within|miles?|of|as|compared|to|itself|the|near|around|suburbs?|outside|and|from|in)\b/g,
      ' ',
    )
    .replace(/[\d\s().,—–-]+/g, '')
  return rest.length === 0
}

/** Great-circle distance in miles between two lon/lat points. */
export function haversineMiles(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface NearCandidate {
  place: PlaceSuggestion
  /** Nearest-centroid distance from the anchor, in miles. */
  distanceMiles: number
}

/**
 * The anchor's hit in the place index, under the same preference
 * geography resolution uses (a city record over a county fallback,
 * the state designator scoping the search when the geography
 * carries one). Null when the index does not know the place — the
 * frame then does not engage and the shipped path stands.
 */
export function anchorHitFor(
  placeIndex: PlaceIndex,
  geography: string,
): PlaceSuggestion | null {
  const trimmed = geography.trim()
  const comma = trimmed.lastIndexOf(',')
  const stateSuffix = comma >= 0 ? trimmed.slice(comma + 1).trim() : ''
  const hits = stateSuffix
    ? placeIndex.search(`${geographyNamePart(trimmed)}, ${stateSuffix}`, 8)
    : placeIndex.search(trimmed, 8)
  return hits.find((h) => h.isCity) ?? hits[0] ?? null
}

/**
 * Every place whose nearest ZIP-area centroid lies within the
 * radius of one of the anchor's ZIP-area centroids — the anchor
 * itself excluded by construction. Distance is centroid-to-centroid
 * (ZIP areas, not municipal boundaries), which is the geography
 * grain the product's own data carries; the frame's evidence line
 * states exactly that basis.
 */
export function nearCandidates(
  placeIndex: PlaceIndex,
  centroidsByZip: ReadonlyMap<string, ZctaPoint>,
  anchor: PlaceSuggestion,
  radiusMiles: number,
): NearCandidate[] {
  const anchorPoints = anchor.zips
    .map((zip) => centroidsByZip.get(zip))
    .filter((p): p is ZctaPoint => !!p)
  if (anchorPoints.length === 0) return []
  // Bounding-box prefilter: a candidate point outside the box
  // around every anchor point cannot be within the radius.
  const latPad = radiusMiles / 69
  const lonPad = radiusMiles / 45
  const inBox = (p: ZctaPoint) =>
    anchorPoints.some(
      (a) => Math.abs(p.lat - a.lat) <= latPad && Math.abs(p.lon - a.lon) <= lonPad,
    )
  const out: NearCandidate[] = []
  for (const place of placeIndex.places) {
    if (place.displayName === anchor.displayName && place.state === anchor.state) continue
    let best = Number.POSITIVE_INFINITY
    for (const zip of place.zips) {
      const point = centroidsByZip.get(zip)
      if (!point || !inBox(point)) continue
      for (const anchorPoint of anchorPoints) {
        const d = haversineMiles(anchorPoint, point)
        if (d < best) best = d
      }
    }
    if (best <= radiusMiles) out.push({ place, distanceMiles: best })
  }
  return out.sort(
    (a, b) =>
      a.distanceMiles - b.distanceMiles ||
      a.place.displayName.localeCompare(b.place.displayName, 'en'),
  )
}

export interface NearFrameBaseline {
  /** The headline cost measure the relative bound reads. */
  key: string
  /** The reference's aggregate figure for that measure. */
  value: number
  /** The aggregate's combined margin, when one formed. */
  margin: number | null
}

/**
 * Everything the pipeline and the evidence layer need about an
 * engaged near frame, built once at the runner (which owns
 * geography resolution) and carried into the pipeline as data.
 */
export interface NearFrameContext {
  /** "Philadelphia, PA" — the reference's reader-facing label. */
  anchorLabel: string
  /** The anchor place's display name ("Philadelphia"), for claim attribution. */
  anchorName: string
  anchorZctas: ReadonlySet<string>
  anchorZipCount: number
  /** Every ZIP area of every candidate place. */
  candidateZctas: ReadonlySet<string>
  candidatePrefixes: string[]
  candidateCount: number
  radiusMiles: number
  radiusStated: boolean
  /** The relative bound, armed: comparative present AND a cost reading exists. */
  relativeCost: boolean
  /** The reference's aggregate baseline on the headline cost measure, when it formed. */
  baseline: NearFrameBaseline | null
}

/**
 * Build the frame context: resolve the anchor, draw the candidate
 * set at the radius, and form the reference baseline from the
 * anchor's full ZIP set over the loaded rows. Null when the anchor
 * is unknown to the index, no candidate place lies within the
 * radius, or the anchor has no centroid — every null leaves the
 * shipped path standing, unchanged.
 */
export function buildNearFrameContext(input: {
  spec: NearFrameSpec
  placeIndex: PlaceIndex
  centroids: readonly ZctaPoint[]
  rows: readonly AreaRow[]
  /** Figure keys the baseline aggregation forms (intent measures + decomposed keys). */
  figureKeys: readonly string[]
  /** The headline cost measure the relative bound reads. */
  baselineKey: string
  /** Whether the question carries a cost reading the bound can apply to. */
  costReading: boolean
}): NearFrameContext | null {
  const anchor = anchorHitFor(input.placeIndex, input.spec.anchorGeography)
  if (!anchor) return null
  const centroidsByZip = new Map(input.centroids.map((p) => [p.zcta, p]))
  const candidates = nearCandidates(
    input.placeIndex,
    centroidsByZip,
    anchor,
    input.spec.radiusMiles,
  )
  if (candidates.length === 0) return null
  const candidateZctas = new Set<string>()
  for (const candidate of candidates) {
    for (const zip of candidate.place.zips) candidateZctas.add(zip)
  }
  const anchorZctas = new Set(anchor.zips)

  // The baseline: the anchor's figures formed from ALL of its ZIP
  // areas through the shipped aggregation machinery — the
  // single-group assignment form stage 2c uses for state averages
  // (population-weighted means, RMS-approximation margins labelled
  // on the aggregate). One resolved ZIP's figures under the place's
  // name was the specimen's provenance defect.
  let baseline: NearFrameBaseline | null = null
  const anchorRows = input.rows.filter((row) => anchorZctas.has(row.zcta))
  if (anchorRows.length > 0 && input.figureKeys.length > 0) {
    const assignments = new Map(
      anchorRows.map((row) => [row.zcta, { name: anchor.displayName, state: anchor.state }]),
    )
    const aggregation = aggregateRowsToCounties(anchorRows, assignments, input.figureKeys)
    const aggregate = aggregation.rows[0]
    if (aggregate) {
      const value = aggregate.metrics[input.baselineKey]
      if (typeof value === 'number' && Number.isFinite(value)) {
        const margin = aggregate.moes[input.baselineKey]
        baseline = {
          key: input.baselineKey,
          value,
          margin: typeof margin === 'number' && Number.isFinite(margin) ? margin : null,
        }
      }
    }
  }

  return {
    anchorLabel: `${anchor.displayName}, ${anchor.state}`,
    anchorName: anchor.displayName,
    anchorZctas,
    anchorZipCount: anchor.zips.length,
    candidateZctas,
    candidatePrefixes: [...new Set([...candidateZctas].map((z) => z.slice(0, 2)))].sort(),
    candidateCount: candidates.length,
    radiusMiles: input.spec.radiusMiles,
    radiusStated: input.spec.radiusStated,
    relativeCost: input.spec.relativeCost && input.costReading,
    baseline,
  }
}

/**
 * The candidate set's sweep-scope prefixes, for the App's scoped
 * load: the frame's rows live in these prefixes, which the anchor's
 * own resolution never names (a cross-river suburb is another
 * prefix entirely). Null exactly when buildNearFrameContext would
 * return null for want of candidates.
 */
/* ------------------------------------------------------------------ */
/* The radius frame                                                    */
/* ------------------------------------------------------------------ */

/**
 * The radius frame: "What's the cheapest place to live in Florida
 * within 100 miles of Miami?" — a stated radius anchored at a named
 * place BESIDE a broader geography (here the state sweep).
 *
 * Measured defect (owner live specimen, 2026-11-04, production
 * 94f796e): the parse carried both geographies (FL + Miami, FL),
 * so the near frame above — which requires exactly one geography
 * and reference semantics — could not engage, and no other layer
 * read the radius as geography at all. Decomposition has no
 * catalog entry for a radius phrase and the question is a single
 * clause, so the radius rode into research as part of one combined
 * criterion whose text is the whole question; the research stage
 * assessed that criterion per place from web snippets, the answer
 * led with places hundreds of miles outside the radius (Putnam
 * County at ~282 mi, Blountstown at ~454 mi), rendered raw
 * search-result titles as finding prose, and never named the
 * cheapest place actually inside the radius. Proximity is
 * geography, not a research topic: the product's own centroid
 * geography answers it deterministically.
 *
 * The frame's semantics differ from the near frame's in exactly
 * two ways, both read off the question's shape:
 *   - The anchor is INSIDE its own radius: "within 100 miles of
 *     Miami" includes Miami's own ZIP areas as candidates. There
 *     is no reference and no baseline.
 *   - Ranking is the question's own measure over the in-radius
 *     set — no relative bound.
 * Detection requires a STATED radius (no default reading in this
 * class), the anchor's name immediately after the phrase's
 * of/from, an intent geography naming that anchor as a place, and
 * at least one further geography beside it — the last condition
 * is the discrimination from the near frame's single-geography
 * class, which keeps its questions.
 */
export interface RadiusFrameSpec {
  /** The intent geography string that names the anchor, verbatim. */
  anchorGeography: string
  /** The stated radius, in miles. */
  radiusMiles: number
  /**
   * The reader's radius phrase verbatim, anchor name included
   * ("within 100 miles of Miami") — the pipeline strips exactly
   * this span from a criterion's text to test whether the
   * criterion carries anything beyond the radius.
   */
  phraseText: string
}

const RADIUS_PHRASE_RES: readonly RegExp[] = [
  /\bwithin\s+an?\s+(\d{1,3})\s*[-\s](?:miles?|mi)\s+radius\s+of\s+/i,
  /\bwithin\s+(\d{1,3})\s*(?:miles?|mi)\s+radius\s+of\s+/i,
  /\binside\s+(?:an?\s+)?(\d{1,3})\s*[-\s](?:miles?|mi)\s+radius\s+of\s+/i,
  /\b(\d{1,3})\s*[-\s](?:miles?|mi)\s+radius\s+(?:of|around)\s+/i,
  /\bwithin\s+(\d{1,3})\s*(?:miles?|mi)\s+of\s+/i,
  /\bno\s+more\s+than\s+(\d{1,3})\s*(?:miles?|mi)\s+from\s+/i,
]

/**
 * The anchor name the reader's own words state after a radius
 * phrase, when no intent geography names it (round 2, measured
 * live 2026-11-04: in one of two genuine Spark parses of the
 * Miami specimen the model's geography list dropped the anchor
 * entirely — ["FL"] alone — while the reader's words still
 * stated it verbatim after the phrase). The span runs to the
 * first sentence punctuation; a name the place index does not
 * know resolves to no frame at build time, so a non-place span
 * ("the coast", "my house") fails safe to the shipped path.
 * Null for a span that cannot be a place name: empty, over six
 * words, carrying a digit, a state itself, county-like, or a ZIP.
 */
function radiusAnchorNameFromText(after: string): { name: string; spanLength: number } | null {
  const spanMatch = /^[^?.;!(]+/.exec(after)
  if (!spanMatch) return null
  const rawSpan = spanMatch[0]
  const leading = rawSpan.length - rawSpan.trimStart().length
  const name = rawSpan.trim().replace(/\s{2,}/g, ' ')
  if (name === '') return null
  if (name.split(/\s+/).length > 6) return null
  if (/\d/.test(name)) return null
  if (/^\d{5}$/.test(name)) return null
  if (COUNTY_LIKE_RE.test(geographyNamePart(name))) return null
  if (isStateGeographyText(name)) return null
  return { name, spanLength: leading + name.length }
}

/**
 * Detect the radius frame in a question, from the reader's words
 * and the parsed intent together. Pure text + intent, like
 * detectNearFrame, so the App can precheck before any load.
 *
 * Round 2 (2026-11-04, parent browser acceptance on the round-1
 * build): the frame did not engage live for either acceptance
 * question, while its pins — built on fabricated intents carrying
 * both geographies and the measure — stayed green. The genuine
 * Spark parses differ from the fabricated ones in two ways, and
 * detection now meets both:
 *   - The anchor can stand ALONE in the geography list (the
 *     Orlando acceptance question: ["Orlando, FL"] in both real
 *     samples). The round-1 gate demanded a second geography
 *     beside the anchor; the discrimination from the near frame
 *     is not the geography count but the reference signals, and
 *     it now lives in radiusPreemptsNear at the call sites.
 *   - The anchor can be ABSENT from the geography list while the
 *     reader's words state it after the phrase (the Miami
 *     specimen's second sample: ["FL"]). The text-stated name
 *     becomes the spec's anchor; the place index resolves it at
 *     build time or the frame does not engage.
 * The intent-geography match is tried first in both cases, so
 * every round-1 shape keeps its exact spec.
 *
 * Round 3 (2026-11-04, parent browser acceptance on the round-2
 * build): Miami and Orlando engage live; the Houston question
 * ("What's the cheapest place to live in Texas within 200 miles
 * of Houston?") does not — it took the research path over the
 * whole state. The genuine parses (three draws) split by shape:
 * ["TX", "Houston, TX"] detects and builds, but ["TX"] — the
 * anchor dropped, the Miami sample-2 shape — anchors on the
 * text-stated name "Houston", and the place index resolves a
 * bare same-named place in baked index order: Houston, AK is
 * first of seven Houstons, so the runner's Texas intersection
 * emptied the candidate set and the context build returned
 * null. Miami's identical shape engaged only because Miami, FL
 * happens to sort first among the Miamis. A spelled-out suffix
 * ("Houston, Texas") failed the same way at the other end: the
 * index's suffix reading knows only two-letter codes, so the
 * name matched nothing at all. The cure is in the spec, at
 * detection: the anchor geography is state-qualified whenever
 * a state is known (qualifiedAnchorGeography) — from its own
 * suffix, spelled-out suffixes normalized to their code, or
 * from the co-named state geography — so an explicit radius
 * phrase with a resolvable anchor engages identically on every
 * parse shape. Specs whose anchors already carried a code
 * suffix are byte-identical to rounds 1–2.
 */
export function detectRadiusFrame(
  queryText: string | undefined,
  intent: ValidatedIntent,
): RadiusFrameSpec | null {
  if (!queryText || queryText.trim() === '') return null
  if (intent.geographies.length < 1) return null
  for (const pattern of RADIUS_PHRASE_RES) {
    const match = pattern.exec(queryText)
    if (!match) continue
    const radiusMiles = Number.parseInt(match[1]!, 10)
    if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) continue
    const after = queryText.slice(match.index + match[0].length)
    for (const geography of intent.geographies) {
      const trimmed = geography.trim()
      if (/^\d{5}$/.test(trimmed)) continue
      if (COUNTY_LIKE_RE.test(geographyNamePart(trimmed))) continue
      if (isStateGeographyText(trimmed)) continue
      const anchorName = geographyNamePart(trimmed)
      if (anchorName === '') continue
      if (!after.toLowerCase().startsWith(anchorName.toLowerCase())) continue
      const nextChar = after.charAt(anchorName.length)
      if (nextChar !== '' && /[A-Za-z]/.test(nextChar)) continue
      return {
        anchorGeography: qualifiedAnchorGeography(geography, intent.geographies),
        radiusMiles,
        phraseText: queryText.slice(
          match.index,
          match.index + match[0].length + anchorName.length,
        ),
      }
    }
    const fromText = radiusAnchorNameFromText(after)
    if (fromText) {
      return {
        anchorGeography: qualifiedAnchorGeography(fromText.name, intent.geographies),
        radiusMiles,
        phraseText: queryText.slice(
          match.index,
          match.index + match[0].length + fromText.spanLength,
        ),
      }
    }
  }
  return null
}

/**
 * Whether the radius reading, not the near frame's reference
 * reading, owns a question both detectors match (round 2). The
 * near frame's semantics — the anchor as comparison reference,
 * excluded from its own candidate set, its baseline the bound a
 * candidate must beat — are the reader's when their words cast
 * the anchor in that role: a likeness predicate, an explicit
 * comparison ("compared to ...", "than <anchor>"), or the
 * anchor named as the reference itself ("<anchor> itself", the
 * Philadelphia specimen's parenthetical). A stated radius with
 * none of those signals casts the anchor as a CENTRE: the places
 * within the radius, the anchor's own areas among them, ranked
 * by the question's measure — the radius frame's reading. A bare
 * cost comparative ("cheaper") without "than <anchor>" is the
 * sweep's own ranking word, not a reference signal: it does not
 * hold the near frame. Callers consult this only when a radius
 * spec also matched, so a question with no stated radius phrase
 * is never re-read by it.
 */
export function radiusPreemptsNear(queryText: string, nearSpec: NearFrameSpec): boolean {
  const anchorName = geographyNamePart(nearSpec.anchorGeography)
  if (hasLikenessPredicate(queryText, anchorName)) return false
  if (/\bcompared\s+(?:to|with)\b/i.test(queryText)) return false
  if (
    new RegExp(`\\bthan\\s+(?:the\\s+)?${escapeRegExp(anchorName)}\\b`, 'i').test(queryText)
  ) {
    return false
  }
  if (
    new RegExp(`\\b${escapeRegExp(anchorName)}\\s+itself\\b`, 'i').test(queryText)
  ) {
    return false
  }
  return true
}

export interface RadiusFrameContext {
  /** "Miami, FL" — the anchor's reader-facing label. */
  anchorLabel: string
  /** The anchor place's display name ("Miami"). */
  anchorName: string
  anchorZctas: ReadonlySet<string>
  /** Every ZIP area of every in-radius place, the anchor's included. */
  candidateZctas: ReadonlySet<string>
  /**
   * The candidate ZIP areas whose OWN centroid lies within the
   * radius (round 3): membership is place-level — a place is
   * inside when its nearest ZIP-area centroid is — so a
   * qualifying place can carry ZIP areas that are themselves
   * outside. The lead row of a radius-framed answer must come
   * from this set (see the compose lead rule in answer.ts).
   */
  qualifyingZctas: ReadonlySet<string>
  candidatePrefixes: string[]
  /** How many places (index records) fall inside the radius. */
  candidatePlaceCount: number
  radiusMiles: number
  /** The reader's radius phrase, verbatim (see RadiusFrameSpec). */
  phraseText: string
}

/**
 * Build the radius frame context: the anchor plus every place
 * whose nearest ZIP-area centroid lies within the radius of one
 * of the anchor's ZIP-area centroids (nearCandidates' grain — a
 * place is inside when its nearest centroid is), optionally
 * intersected with a restricting ZIP set (the co-named state's
 * areas, supplied by the caller). Null when the anchor is unknown
 * to the index, the anchor has no centroid (no distance basis
 * exists), or the restricted set is empty — every null leaves the
 * shipped path standing.
 */
export function buildRadiusFrameContext(input: {
  spec: RadiusFrameSpec
  placeIndex: PlaceIndex
  centroids: readonly ZctaPoint[]
  restrictZctas?: ReadonlySet<string> | null
}): RadiusFrameContext | null {
  const anchor = anchorHitFor(input.placeIndex, input.spec.anchorGeography)
  if (!anchor) return null
  const centroidsByZip = new Map(input.centroids.map((p) => [p.zcta, p]))
  const anchorPoints = anchor.zips
    .map((zip) => centroidsByZip.get(zip))
    .filter((p): p is ZctaPoint => !!p)
  if (anchorPoints.length === 0) return null
  const near = nearCandidates(
    input.placeIndex,
    centroidsByZip,
    anchor,
    input.spec.radiusMiles,
  )
  const candidatePlaces: PlaceSuggestion[] = [anchor, ...near.map((c) => c.place)]
  const restrict = input.restrictZctas ?? null
  const candidateZctas = new Set<string>()
  let candidatePlaceCount = 0
  for (const place of candidatePlaces) {
    let contributed = false
    for (const zip of place.zips) {
      if (restrict && !restrict.has(zip)) continue
      candidateZctas.add(zip)
      contributed = true
    }
    if (contributed) candidatePlaceCount++
  }
  if (candidateZctas.size === 0) return null
  // The qualifying ZIP areas: candidates whose own centroid lies
  // within the radius of an anchor centroid. Membership above is
  // place-level (a place is inside when its NEAREST centroid
  // is), so this set can be smaller than the candidate set —
  // the anchor's own areas always qualify (distance zero).
  const qualifyingZctas = new Set<string>()
  for (const zip of candidateZctas) {
    const point = centroidsByZip.get(zip)
    if (!point) continue
    if (anchorPoints.some((a) => haversineMiles(a, point) <= input.spec.radiusMiles)) {
      qualifyingZctas.add(zip)
    }
  }
  return {
    anchorLabel: `${anchor.displayName}, ${anchor.state}`,
    anchorName: anchor.displayName,
    anchorZctas: new Set(anchor.zips),
    candidateZctas,
    qualifyingZctas,
    candidatePrefixes: [...new Set([...candidateZctas].map((z) => z.slice(0, 2)))].sort(),
    candidatePlaceCount,
    radiusMiles: input.spec.radiusMiles,
    phraseText: input.spec.phraseText,
  }
}

/**
 * The radius candidate set's sweep-scope prefixes, for the App's
 * scoped load (the nearCandidatePrefixes twin). Null exactly when
 * buildRadiusFrameContext would return null (no restriction is
 * applied at this seam — the load widening is a superset by
 * design, and the runner's restricted context bounds the screen).
 */
export function radiusCandidatePrefixes(input: {
  spec: RadiusFrameSpec
  placeIndex: PlaceIndex
  centroids: readonly ZctaPoint[]
}): string[] | null {
  const context = buildRadiusFrameContext(input)
  return context ? context.candidatePrefixes : null
}

/**
 * Remove the reader's radius phrase from a text (a criterion's
 * text, which derives from the same question the spec was
 * detected in). Returns the remainder with whitespace collapsed,
 * or null when the phrase is not present to remove.
 */
export function stripRadiusPhrase(text: string, phraseText: string): string | null {
  const idx = text.toLowerCase().indexOf(phraseText.toLowerCase())
  if (idx < 0) return null
  return (text.slice(0, idx) + ' ' + text.slice(idx + phraseText.length))
    .replace(/\s+([,?.!])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function nearCandidatePrefixes(input: {
  spec: NearFrameSpec
  placeIndex: PlaceIndex
  centroids: readonly ZctaPoint[]
}): string[] | null {
  const anchor = anchorHitFor(input.placeIndex, input.spec.anchorGeography)
  if (!anchor) return null
  const centroidsByZip = new Map(input.centroids.map((p) => [p.zcta, p]))
  const candidates = nearCandidates(
    input.placeIndex,
    centroidsByZip,
    anchor,
    input.spec.radiusMiles,
  )
  if (candidates.length === 0) return null
  const zctas = new Set<string>()
  for (const candidate of candidates) {
    for (const zip of candidate.place.zips) zctas.add(zip)
  }
  return [...new Set([...zctas].map((z) => z.slice(0, 2)))].sort()
}
