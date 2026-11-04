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
