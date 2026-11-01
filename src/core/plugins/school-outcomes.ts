/**
 * Nationwide 2019 school-level adjusted cohort graduation outcomes.
 *
 * NCES EDGE supplies 2019–20 public-school locations. The Urban Institute
 * Education Data Portal supplies 2019 EDFacts ACGR records. They are joined by
 * NCES school ID, with one statewide outcome request per nearby state.
 */

import { getJson } from '../http'
import type { MetricValue, PluginRequest, QueryContext, SourceRef } from '../types'

export const PUBLIC_SCHOOL_LOCATIONS_QUERY =
  'https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_1920/MapServer/0/query'
export const SCHOOL_ACGR_ENDPOINT =
  'https://educationdata.urban.org/api/v1/schools/edfacts/grad-rates/2019/'

const SCHOOL_RADIUS_METRES = 3000
const SCHOOL_RESULT_LIMIT = 8
const SCHOOL_YEAR = '2019-2020'
const SOURCE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const EARTH_RADIUS_METRES = 6_371_000
const ENVELOPE_METRES_PER_DEGREE = 110_000
const SUBGROUP_FILTERS = {
  race: '99',
  disability: '99',
  econ_disadvantaged: '99',
  foster_care: '99',
  homeless: '99',
  lep: '99',
} as const

const OUT_FIELDS = 'NCESSCH,NAME,OPSTFIPS,LAT,LON,SCHOOLYEAR'

export const SCHOOL_OUTCOMES_SOURCE: SourceRef = {
  publisher: 'U.S. Department of Education, EDFacts; Urban Institute; NCES EDGE',
  dataset: '2019 Adjusted Cohort Graduation Rate and 2019–20 public-school locations',
  tableId: 'EDFacts FS150 / DG695; NCES NCESSCH',
  vintage: '2019 ACGR; 2019–20 NCES EDGE locations',
  url: SCHOOL_ACGR_ENDPOINT,
  citation:
    'EDFacts Adjusted Cohort Graduation Rates (2019), via Education Data Portal v0.27.0, Urban Institute, under ODC-By 1.0; joined to NCES EDGE public-school locations.',
}

interface ArcGisFeature {
  attributes?: Record<string, unknown>
}

interface ArcGisResponse {
  features?: ArcGisFeature[]
  error?: { code?: number; message?: string }
}

interface AcgrRecord {
  ncessch?: string | number
  fips?: string | number
  year?: string | number
  school_name?: string
  cohort_num?: string | number | null
  grad_rate_midpt?: string | number | null
  grad_rate_low?: string | number | null
  grad_rate_high?: string | number | null
}

interface AcgrResponse {
  results?: AcgrRecord[]
  next?: string | null
}

interface NearbyPublicSchool {
  ncessch: string
  name: string
  fips: number
  metres: number
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(number) ? number : null
}

function ncesId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const raw = String(value)
  if (!/^\d+$/.test(raw)) return null
  return raw.replace(/^0+/, '') || '0'
}

function distanceMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(a))
}

export function schoolLocationsUrl(lat: number, lon: number, radiusMetres = SCHOOL_RADIUS_METRES): string {
  // Keep the server-side envelope slightly wider than the Haversine circle:
  // candidate points are filtered by exact distance below, but a tight
  // approximation here could omit a school that lies on the 3 km boundary.
  const latDelta = radiusMetres / ENVELOPE_METRES_PER_DEGREE
  const lonDelta = radiusMetres / (ENVELOPE_METRES_PER_DEGREE * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))
  const params = new URLSearchParams({
    where: '1=1',
    geometry: `${(lon - lonDelta).toFixed(5)},${(lat - latDelta).toFixed(5)},${(lon + lonDelta).toFixed(5)},${(lat + latDelta).toFixed(5)}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: OUT_FIELDS,
    returnGeometry: 'false',
    f: 'json',
  })
  return `${PUBLIC_SCHOOL_LOCATIONS_QUERY}?${params.toString()}`
}

export function schoolAcgrUrl(fips: number): string {
  const params = new URLSearchParams({ fips: String(fips), ...SUBGROUP_FILTERS })
  return `${SCHOOL_ACGR_ENDPOINT}?${params.toString()}`
}

export function parseNearbyPublicSchools(
  body: ArcGisResponse,
  lat: number,
  lon: number,
  radiusMetres = SCHOOL_RADIUS_METRES,
): NearbyPublicSchool[] {
  if (body.error) throw new Error(`NCES EDGE school-location query failed (${body.error.code ?? 'unknown'})`)
  if (!Array.isArray(body.features)) {
    throw new Error('NCES EDGE school-location query returned an invalid response (expected features array)')
  }

  const byId = new Map<string, NearbyPublicSchool>()
  for (const feature of body.features) {
    const attributes = feature.attributes
    const rawId = attributes?.NCESSCH
    const id = ncesId(rawId)
    const name = typeof attributes?.NAME === 'string' ? attributes.NAME.trim() : ''
    const stateFips = typeof attributes?.OPSTFIPS === 'string' ? attributes.OPSTFIPS : ''
    const schoolLat = numberValue(attributes?.LAT)
    const schoolLon = numberValue(attributes?.LON)
    if (
      !id || typeof rawId !== 'string' || !/^\d{12}$/.test(rawId) || !name ||
      !/^\d{2}$/.test(stateFips) || Number(stateFips) === 0 ||
      rawId.slice(0, 2) !== stateFips ||
      attributes?.SCHOOLYEAR !== SCHOOL_YEAR || schoolLat === null || schoolLon === null ||
      schoolLat < -90 || schoolLat > 90 || schoolLon < -180 || schoolLon > 180
    ) {
      continue
    }

    const metres = distanceMetres(lat, lon, schoolLat, schoolLon)
    if (metres > radiusMetres) continue

    const current = byId.get(id)
    if (!current || metres < current.metres) {
      byId.set(id, { ncessch: id, name, fips: Number(stateFips), metres })
    }
  }

  return [...byId.values()].sort((a, b) => a.metres - b.metres)
}

async function acgrRecordsForState(fips: number, signal: AbortSignal): Promise<AcgrRecord[]> {
  const records: AcgrRecord[] = []
  const allowedOrigin = new URL(SCHOOL_ACGR_ENDPOINT).origin
  let url: string | null = schoolAcgrUrl(fips)
  let pages = 0

  while (url) {
    if (new URL(url).origin !== allowedOrigin || pages >= 20) {
      throw new Error('Education Data Portal returned an invalid or unexpectedly long page sequence')
    }
    const page: AcgrResponse = await getJson<AcgrResponse>(url, {
      signal,
      metered: true,
      ttlMs: SOURCE_TTL_MS,
    })
    if (!Array.isArray(page.results)) throw new Error('Education Data Portal returned an invalid ACGR response')
    records.push(...page.results)
    url = page.next ?? null
    pages += 1
  }

  return records
}

function acgrMetric(school: NearbyPublicSchool, record: AcgrRecord, requestUrl: string): MetricValue | null {
  const midpoint = numberValue(record.grad_rate_midpt)
  if (midpoint === null || midpoint < 0 || midpoint > 100 || Number(record.year) !== 2019) return null
  if (Number(record.fips) !== school.fips || ncesId(record.ncessch) !== school.ncessch) return null

  const low = numberValue(record.grad_rate_low)
  const high = numberValue(record.grad_rate_high)
  const validBand = low !== null && high !== null && low >= 0 && high <= 100 && low <= midpoint && midpoint <= high
  const bandNote = validBand && low !== high
    ? ` The Portal reports this rate in the ${low}–${high}% band; ${midpoint}% is its midpoint, not an exact rate.`
    : ' The Portal supplied no low/high bounds for this record.'
  const cohort = numberValue(record.cohort_num)
  const cohortNote = cohort !== null && cohort > 0 ? ` The adjusted cohort contains ${cohort} students.` : ''

  return {
    key: `edfacts_2019_acgr_${school.ncessch}`,
    label: `${school.name} — graduation rate midpoint (2019 ACGR)`,
    value: midpoint,
    unit: 'percent',
    category: 'education',
    source: { ...SCHOOL_OUTCOMES_SOURCE, url: requestUrl },
    quality: { derived: false },
    geographyContext: `NCES EDGE public-school point, ${Math.round(school.metres)} m from the selected location.`,
    note:
      `Four-year adjusted cohort graduation rate for the all-students total. This 2019 outcome is matched to a 2019–20 NCES public-school location by NCES school ID. Only public schools with a reportable cohort outcome appear; missing, not-applicable, and suppressed records are omitted. This is not an all-grade achievement measure or a school-quality rating.${bandNote}${cohortNote}`,
  }
}

export const nationalSchoolOutcomesPlugin: PluginRequest = {
  id: 'edfacts-school-outcomes-2019',
  title: 'Public school graduation outcomes (EDFacts, 2019)',
  category: 'education',
  geography: 'school',
  minZoom: 4,
  legal: {
    notice:
      'This national lane covers only up to the eight nearest public schools with a reportable 2019 four-year adjusted cohort graduation outcome within 3 km of the selected location. The displayed value is the Portal midpoint and may represent a published range. Missing, not-applicable, and suppressed outcomes are omitted. Other schools, years, grades, and outcome types are not covered; this is not a school-quality rating.',
  },

  async fetch(ctx: QueryContext): Promise<MetricValue[]> {
    const { lat, lon } = ctx.geo ?? {}
    if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) return []

    const locationUrl = schoolLocationsUrl(lat, lon)
    const locationBody = await getJson<ArcGisResponse>(locationUrl, {
      signal: ctx.signal,
      metered: true,
      ttlMs: SOURCE_TTL_MS,
    })
    const schools = parseNearbyPublicSchools(locationBody, lat, lon)
    if (schools.length === 0) return []

    const fipsList = [...new Set(schools.map((school) => school.fips))]
    const outcomes = await Promise.all(fipsList.map(async (fips) => ({
      fips,
      url: schoolAcgrUrl(fips),
      records: await acgrRecordsForState(fips, ctx.signal),
    })))
    const rateBySchool = new Map<string, { record: AcgrRecord; url: string }>()
    for (const state of outcomes) {
      for (const record of state.records) {
        const id = ncesId(record.ncessch)
        if (id && Number(record.fips) === state.fips && !rateBySchool.has(id)) {
          rateBySchool.set(id, { record, url: state.url })
        }
      }
    }

    return schools
      .map((school) => {
        const match = rateBySchool.get(school.ncessch)
        return match ? acgrMetric(school, match.record, match.url) : null
      })
      .filter((metric): metric is MetricValue => metric !== null)
      .slice(0, SCHOOL_RESULT_LIMIT)
  },
}
