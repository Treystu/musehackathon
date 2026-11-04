/**
 * Result-map geometry loader: generalized ZCTA polygons for the places
 * in one verified answer, fetched live from TIGERweb.
 *
 * Probe-corrected query (P6 probe, 2026-11-02, hidden_files/drive-scratch/
 * p6-probe/RESULTS.md + results.json — measured, not estimated):
 *
 *   With outSR=4326, maxAllowableOffset is in DEGREES (units of the output
 *   spatial reference), not metres. The result-map spec's literal 250
 *   collapses every polygon to a ~4-vertex blob (area ratio vs full
 *   precision: median 0.597 Seattle, 0.656 Santa Cruz, min 0.387) and was
 *   rejected under the spec's own honesty rule. The ~100 m intent is
 *   0.0009 degrees: 25 Seattle ZCTAs measured 13,907 B raw / 0.66 s and
 *   17 coastal Santa Cruz ZCTAs 28,976 B raw / 0.70 s, with worst-ZCTA
 *   area ratio 0.964-0.974 and rings + MultiPolygon structure intact.
 *   Micro-ZCTAs (building-scale, e.g. Seattle 98154/98164/98174) reduce
 *   to minimal 4-vertex polygons at any offset; the component gives
 *   those the centroid-dot treatment (spec section 4.6).
 *
 * Hard rules that keep live geometry viable (spec section 2.3):
 *   - The colored set is the answer's verified places only, capped at
 *     RESULT_GEOMETRY_CAP (25) polygons, in ONE batched IN query.
 *   - The raw payload budget (500 KB) is enforced in code: one retry at
 *     the larger offset, flagged simplified; a second breach is a
 *     failure the component renders as one quiet line, never a map.
 *   - Responses route through the shared IndexedDB response cache
 *     (90-day TTL: boundaries change at most annually; the ZCTA
 *     enumeration's 90-day precedent) and the shared paced() queue, so
 *     geometry never stampedes alongside sweep chunks. TIGERweb is
 *     keyless, so the fetch rides the queue's keyless posture
 *     (ratelimit.ts): the concurrency and interval discipline apply,
 *     but the Census key's daily budget neither walls it nor is
 *     charged for it. That distinction is load-bearing — under the
 *     counted default, an exhausted key budget failed the map of an
 *     answer whose figures were already in hand (Lane completion
 *     K2, production specimen 2026-11-03).
 *   - TIGERweb answers a bad field name with HTTP 200 and an
 *     {"error": ...} body (the geocode.ts trap), so the body is checked
 *     before it is parsed as geometry. The field list is exactly
 *     ZCTA5, pinned by the unit tests.
 */

import { isFresh, readCache, writeCache } from '../cache'
import { fetchResilient } from '../http'
import { paced } from '../ratelimit'

export const TIGERWEB_ZCTA_LAYER_URL =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/2/query'

/** Colored polygons per answer. This cap is what makes live geometry viable. */
export const RESULT_GEOMETRY_CAP = 25

/**
 * Request-time generalization, in DEGREES under outSR=4326 (see the
 * header: the probe measured the spec's metre reading destroying the
 * shapes). 0.0009 degrees is ~100 m at the measured latitudes.
 */
export const RESULT_GEOMETRY_OFFSET_DEGREES = 0.0009

/** The one budget retry: ~500 m, used only when the first payload is over budget. */
export const RESULT_GEOMETRY_RETRY_OFFSET_DEGREES = 0.0045

/** Raw-byte ceiling for one answer's geometry, enforced before anything draws. */
export const RESULT_GEOMETRY_PAYLOAD_BUDGET_BYTES = 500_000

/** Geometry cache TTL: boundaries change at most annually (90-day precedent). */
export const RESULT_GEOMETRY_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** County outlines are member geometry merged into one shape; beyond this many members the outline is not attempted. */
export const RESULT_COUNTY_MEMBER_CAP = 100

export interface ResultGeometryFeature {
  type: 'Feature'
  properties: { ZCTA5: string }
  geometry: { type: string; coordinates: unknown }
}

/**
 * Ring-orientation sum for one GeoJSON ring (the shoelace variant
 * sum((x2-x1)*(y2+y1)) over lon/lat pairs). The SIGN is all that is
 * read: measured against d3-geo (2026-11-03, R23 cure), a ring whose
 * sum is negative is wound so that d3's spherical path treats the
 * polygon's interior as the REST of the sphere — geoArea returns
 * 4*pi steradians (the whole sphere) for every TIGERweb feature,
 * geoCentroid returns the antipode (Seattle 98101 read as
 * 57.66, -47.61 instead of -122.34, 47.61), and an SVG fill paints
 * the projection's sphere outline as a frame-sized disc with the
 * true polygon as a white hole (the R23 captures: all 25 Colorado
 * result paths sharing one rendered bbox). Esri's GeoJSON output
 * winds exterior rings that way; d3 wants the opposite.
 */
function ringOrientationSum(ring: unknown): number {
  if (!Array.isArray(ring)) return 0
  let sum = 0
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i] as [number, number]
    const b = ring[i + 1] as [number, number]
    if (!Array.isArray(a) || !Array.isArray(b)) return 0
    sum += (b[0] - a[0]) * (b[1] + a[1])
  }
  return sum
}

/**
 * Normalizes Polygon/MultiPolygon ring winding for d3-geo: exterior
 * rings to a positive orientation sum, holes to negative, reversing
 * only a ring whose sign is wrong — so geometry from a source that
 * already winds d3's way passes through untouched, vertex for
 * vertex. Applied at parse time (below), which puts every consumer
 * of this loader — ResultMap, the progressive map, the qualifying
 * map, county outlines — on the corrected geometry at one seam.
 */
export function normalizeGeometryWinding<T extends { type: string; coordinates: unknown }>(
  geometry: T,
): T {
  const fixPolygon = (rings: unknown): unknown => {
    if (!Array.isArray(rings)) return rings
    return rings.map((ring, i) => {
      const sum = ringOrientationSum(ring)
      if (sum === 0 || !Array.isArray(ring)) return ring
      const wantPositive = i === 0
      return sum > 0 === wantPositive ? ring : [...ring].reverse()
    })
  }
  if (geometry.type === 'Polygon') {
    return { ...geometry, coordinates: fixPolygon(geometry.coordinates) }
  }
  if (geometry.type === 'MultiPolygon') {
    if (!Array.isArray(geometry.coordinates)) return geometry
    return { ...geometry, coordinates: geometry.coordinates.map(fixPolygon) }
  }
  return geometry
}

export interface ResultGeometry {
  /** Geometry by ZCTA, for exactly the requested ZCTAs that returned a polygon. */
  features: Map<string, ResultGeometryFeature>
  /** Requested ZCTAs the service returned no polygon for, in request order. */
  missing: string[]
  /** True when the payload budget forced the larger generalization offset. */
  simplified: boolean
  /** Raw bytes of the accepted response (the sum across batches for county outlines). */
  bytes: number
}

export class ResultGeometryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResultGeometryError'
  }
}

/**
 * Builds the one batched query URL for a set of ZCTAs.
 *
 * Apostrophes are %27-encoded: encodeURIComponent leaves them bare and
 * TIGERweb rejects a bare apostrophe with HTTP 200 + an error body (the
 * geocode.ts trap). ZCTAs are digits, so the escaping is belt-and-braces
 * here — it is pinned so a future caller passing place names fails the
 * test, not the live service.
 */
export function buildResultGeometryUrl(
  zctas: readonly string[],
  offsetDegrees: number = RESULT_GEOMETRY_OFFSET_DEGREES,
): string {
  const list = zctas.map((z) => `'${z}'`).join(',')
  const where = encodeURIComponent(`ZCTA5 IN (${list})`).replace(/'/g, '%27')
  const params = [
    `where=${where}`,
    'outFields=ZCTA5',
    'returnGeometry=true',
    'outSR=4326',
    'f=geojson',
    'geometryPrecision=3',
    `maxAllowableOffset=${offsetDegrees}`,
  ]
  return `${TIGERWEB_ZCTA_LAYER_URL}?${params.join('&')}`
}

/** Distinct, well-formed ZCTAs in caller order, capped. County members pass through the same hygiene. */
export function capResultZctas(zctas: readonly string[], cap: number = RESULT_GEOMETRY_CAP): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const z of zctas) {
    if (!/^\d{5}$/.test(z) || seen.has(z)) continue
    seen.add(z)
    out.push(z)
    if (out.length >= cap) break
  }
  return out
}

/**
 * Parses one TIGERweb GeoJSON response body.
 *
 * Throws ResultGeometryError on the 200-with-error-body shape and on
 * malformed GeoJSON — a partial map drawn from a corrupt body would be
 * a wrong map, so there is no partial-parse path. A requested ZCTA
 * absent from the features is reported in `missing`, never silently
 * dropped: the component discloses those places as dots / in words.
 */
export function parseResultGeometry(text: string, requested: readonly string[]): {
  features: Map<string, ResultGeometryFeature>
  missing: string[]
  bytes: number
} {
  const bytes = new TextEncoder().encode(text).length
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ResultGeometryError('TIGERweb geometry response was not valid JSON')
  }
  if (parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)) {
    throw new ResultGeometryError('TIGERweb geometry query returned an error body')
  }
  const collection = parsed as { type?: string; features?: unknown }
  if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new ResultGeometryError('TIGERweb geometry response was not a GeoJSON FeatureCollection')
  }
  const features = new Map<string, ResultGeometryFeature>()
  for (const raw of collection.features) {
    const feature = raw as ResultGeometryFeature
    const zcta = feature?.properties?.ZCTA5
    if (typeof zcta !== 'string' || !feature.geometry) continue
    if (!requested.includes(zcta) || features.has(zcta)) continue
    // Ring winding is normalized here, at the parse seam: TIGERweb's
    // exterior rings wind against d3-geo's spherical convention, and
    // unnormalized every feature renders as its own complement (see
    // normalizeGeometryWinding).
    features.set(zcta, { ...feature, geometry: normalizeGeometryWinding(feature.geometry) })
  }
  const missing = requested.filter((z) => !features.has(z))
  return { features, missing, bytes }
}

export interface ResultGeometryFetchResult {
  text: string
  status: number
}

export type ResultGeometryFetcher = (
  url: string,
  signal?: AbortSignal,
) => Promise<ResultGeometryFetchResult>

/**
 * The default fetcher: response cache first (a repeat answer for the
 * same area costs zero requests), then the paced resilient fetch. The
 * raw text is measured before parsing so the payload budget applies to
 * what actually arrived, not to a re-serialization.
 */
const defaultFetcher: ResultGeometryFetcher = async (url, signal) => {
  const cached = await readCache<{ text: string }>(url)
  if (cached && isFresh(cached, RESULT_GEOMETRY_CACHE_TTL_MS)) {
    return { text: cached.body.text, status: 200 }
  }
  const res = await paced(
    () =>
      fetchResilient(url, { signal, headers: { Accept: 'application/geo+json, application/json' } }),
    { budget: 'keyless' },
  )
  const text = await res.text()
  if (res.ok) await writeCache(url, { text })
  return { text, status: res.status }
}

async function fetchBatch(
  zctas: readonly string[],
  offsetDegrees: number,
  fetcher: ResultGeometryFetcher,
  signal?: AbortSignal,
): Promise<{ features: Map<string, ResultGeometryFeature>; missing: string[]; bytes: number }> {
  const url = buildResultGeometryUrl(zctas, offsetDegrees)
  const { text, status } = await fetcher(url, signal)
  if (status < 200 || status >= 300) {
    throw new ResultGeometryError(`TIGERweb geometry request failed (HTTP ${status})`)
  }
  return parseResultGeometry(text, zctas)
}

/**
 * Loads geometry for one batch of at most RESULT_GEOMETRY_CAP ZCTAs,
 * enforcing the payload budget: an over-budget response is retried
 * exactly once at the larger offset and flagged simplified; a second
 * breach throws, and the component falls back to its quiet line.
 */
export async function loadResultGeometry(
  zctas: readonly string[],
  opts: { signal?: AbortSignal; fetcher?: ResultGeometryFetcher } = {},
): Promise<ResultGeometry> {
  const capped = capResultZctas(zctas)
  if (capped.length === 0) throw new ResultGeometryError('no ZCTAs to load geometry for')
  const fetcher = opts.fetcher ?? defaultFetcher

  const first = await fetchBatch(capped, RESULT_GEOMETRY_OFFSET_DEGREES, fetcher, opts.signal)
  if (first.bytes <= RESULT_GEOMETRY_PAYLOAD_BUDGET_BYTES) {
    return { features: first.features, missing: first.missing, simplified: false, bytes: first.bytes }
  }
  const retry = await fetchBatch(capped, RESULT_GEOMETRY_RETRY_OFFSET_DEGREES, fetcher, opts.signal)
  if (retry.bytes > RESULT_GEOMETRY_PAYLOAD_BUDGET_BYTES) {
    throw new ResultGeometryError(
      `TIGERweb geometry payload exceeded the ${RESULT_GEOMETRY_PAYLOAD_BUDGET_BYTES}-byte budget twice`,
    )
  }
  return { features: retry.features, missing: retry.missing, simplified: true, bytes: retry.bytes }
}

/**
 * Loads a county outline's member geometry in cap-sized batches.
 *
 * The members are never colored individually — the component merges
 * them into ONE path carrying the county's figure — so this loader
 * exists only to supply that merged outline. The same budget rule
 * applies per batch, through loadResultGeometry.
 */
export async function loadCountyOutlineGeometry(
  memberZctas: readonly string[],
  opts: { signal?: AbortSignal; fetcher?: ResultGeometryFetcher } = {},
): Promise<ResultGeometry> {
  const members = capResultZctas(memberZctas, RESULT_COUNTY_MEMBER_CAP)
  if (members.length === 0) throw new ResultGeometryError('county place has no member ZCTAs')
  const features = new Map<string, ResultGeometryFeature>()
  const missing: string[] = []
  let bytes = 0
  let simplified = false
  for (let i = 0; i < members.length; i += RESULT_GEOMETRY_CAP) {
    const batch = await loadResultGeometry(members.slice(i, i + RESULT_GEOMETRY_CAP), opts)
    for (const [zcta, feature] of batch.features) features.set(zcta, feature)
    missing.push(...batch.missing)
    bytes += batch.bytes
    simplified = simplified || batch.simplified
  }
  return { features, missing, simplified, bytes }
}
