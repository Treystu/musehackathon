/**
 * Source: the NYC Department of Education's 2020 High School Directory.
 *
 * Verified live: `data.ny.gov` responds with a 308 redirect to
 * `data.cityofnewyork.us`, which is where the data actually lives. A browser
 * follows the redirect automatically, but the Content-Security-Policy is checked
 * against the *redirected* origin, so a browser blocked the request and the
 * plugin returned nothing. The final origin is therefore used directly, and
 * both are on the allowlist.
 *
 * It is a Socrata portal, so it returns
 * `Access-Control-Allow-Origin: *`, needs no key, and carries per-school
 * enrolment, grade span, graduation and attendance rates plus latitude and
 * longitude, so schools can be selected by proximity to an address.
 *
 * The honest caveat, and it is not small: `graduation_rate` here is a fraction,
 * and it is blank for schools that serve no graduating cohort — elementary and
 * middle schools, and schools too small to report. A blank means "not
 * applicable", not "poor", and the UI says so rather than showing a zero.
 *
 * This is NYC data, not a statewide New York directory. Other state and local
 * sources need their own schema and reuse-term review before integration. The
 * `StateSchoolPlugin` interface below is the extension point.
 */

import { getJson } from '../http'
import type { MetricValue, PluginRequest, QueryContext, SourceRef } from '../types'

/** The contract every per-state plugin implements. */
export interface StateSchoolPlugin extends PluginRequest {
  /** The two-letter state code this plugin covers. */
  stateCode: string
  /** Human name of the state, for the UI. */
  stateName: string
}

/**
 * The dataset's final origin.
 *
 * `data.ny.gov` answers with a redirect to `data.cityofnewyork.us`. Both are on
 * the CSP allowlist so the redirect is safe either way, but the final origin is
 * used directly to avoid a round trip.
 */
const DATASET = 'https://data.cityofnewyork.us/resource/23z9-6uk9.json'
const VINTAGE = '2018-19 school year'

export const NYC_SCHOOLS_SOURCE: SourceRef = {
  publisher: 'New York City Department of Education (DOE)',
  dataset: '2020 DOE High School Directory',
  tableId: '23z9-6uk9',
  vintage: VINTAGE,
  url: DATASET,
  citation: `NYC DOE 2020 High School Directory (${VINTAGE}), via NYC Open Data`,
}

function source(url: string): SourceRef {
  return { ...NYC_SCHOOLS_SOURCE, url }
}

interface NySchool {
  dbn?: string
  school_name?: string
  // Socrata returns these as STRINGS even though they are numeric, verified
  // live: `typeof latitude === 'number'` is false for every row. A strict type
  // check here silently discards the entire result set, which is exactly the
  // failure this caused.
  total_students?: string | number | null
  finalgrades?: string
  grades2019?: string
  graduation_rate?: string | number | null
  attendance_rate?: string | number | null
  latitude?: string | number | null
  longitude?: string | number | null
  borough?: string
}

/** Parses a Socrata numeric field that may arrive as a string. */
function coord(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** A rate that is absent because the school has no graduating cohort. */
function ratePct(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 1000) / 10
}

function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/**
 * Bounding box for the five NYC boroughs, with room for coastline and nearby
 * centroids. The source is a NYC Department of Education dataset; using a
 * statewide box caused needless requests for areas where it could never return
 * a nearby school.
 */
const NYC_BOUNDS = { minLat: 40.49, maxLat: 40.93, minLon: -74.28, maxLon: -73.65 }

export function isInNycCoverage(lat: number, lon: number): boolean {
  return lat >= NYC_BOUNDS.minLat && lat <= NYC_BOUNDS.maxLat && lon >= NYC_BOUNDS.minLon && lon <= NYC_BOUNDS.maxLon
}

export interface NearbySchool {
  dbn: string
  name: string
  metres: number
  students: number | null
  gradeSpan: string
  graduationRate: number | null
  attendanceRate: number | null
  metrics: MetricValue[]
}

/**
 * Finds the schools nearest a point.
 *
 * Fetching every New York school would be thousands of rows for a question that
 * is really "which schools are near this address". A small bounding box around
 * the point is the cheap and correct query, and the distance is computed here so
 * ordering does not depend on the portal.
 */
export async function nearbySchools(
  lat: number,
  lon: number,
  signal: AbortSignal,
  radiusMetres = 3000,
  limit = 8,
): Promise<NearbySchool[]> {
  // A 0.05-degree box is roughly 5km of latitude, comfortably larger than the
  // requested radius, and small enough that the result set stays readable.
  const url =
    `${DATASET}?$limit=200` +
    `&$where=${encodeURIComponent(
      `latitude between ${(lat - 0.05).toFixed(5)} and ${(lat + 0.05).toFixed(5)} ` +
        `and longitude between ${(lon - 0.06).toFixed(5)} and ${(lon + 0.06).toFixed(5)}`,
    )}` +
    `&$select=${encodeURIComponent(
      'dbn,school_name,total_students,graduation_rate,attendance_rate,latitude,longitude,finalgrades,grades2019',
    )}`

  let rows: NySchool[]
  try {
    rows = await getJson<NySchool[]>(url, { signal, metered: true })
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []

  const withCoords = rows
    .map((r) => ({ r, lat: coord(r.latitude), lon: coord(r.longitude) }))
    .filter((x): x is { r: NySchool; lat: number; lon: number } => x.lat !== null && x.lon !== null && Boolean(x.r.dbn))

  return withCoords
    .map(({ r, lat: sLat, lon: sLon }) => ({
      dbn: r.dbn!,
      name: (r.school_name ?? '').trim() || r.dbn!,
      metres: metresBetween(lat, lon, sLat, sLon),
      students: coord(r.total_students),
      graduationRate: ratePct(r.graduation_rate),
      attendanceRate: ratePct(r.attendance_rate),
      gradeSpan: [r.grades2019, r.finalgrades && `through ${r.finalgrades}`].filter(Boolean).join(' ') || 'not reported',
      metrics: [],
    }))
    .filter((s) => s.metres <= radiusMetres)
    .sort((a, b) => a.metres - b.metres)
    .slice(0, limit)
}

export const nySchoolPlugin: StateSchoolPlugin = {
  id: 'nyc-doe-school-detail',
  stateCode: 'NY',
  stateName: 'New York',
  title: 'Individual schools (NYC DOE)',
  category: 'education',
  geography: 'school',
  minZoom: 4,
  legal: {
    suppressBelow: 20,
    notice:
      'Graduation and attendance rates are reported only by schools that serve graduating cohorts, so elementary and middle schools and very small schools show no rate at all. A blank means not applicable, not poor. School quality is not the same as test results, and attendance and graduation rates are two measures among many.',
  },

  async fetch(ctx: QueryContext): Promise<MetricValue[]> {
    const { lat, lon } = ctx.geo ?? {}
    if (lat === undefined || lon === undefined) return []

    // The source is a New York City directory, not a statewide school feed.
    // Bare ZIP geocoding does not carry a USPS state code, so use the source
    // coverage area to avoid requests that cannot produce a nearby result.
    if (!isInNycCoverage(lat, lon)) return []

    const near = await nearbySchools(lat, lon, ctx.signal)
    if (near.length === 0) return []

    // One metric per school per figure, so a user compares schools directly
    // rather than through a district average.
    const out: MetricValue[] = []
    for (const s of near) {
      const where = `${Math.round(s.metres)} m away. Grade span ${s.gradeSpan}. District code ${s.dbn}.`
      const add = (key: string, label: string, value: number | null, unit: MetricValue['unit'], better: 'higher' | 'lower', note: string) => {
        out.push({
          key: `ny_${s.dbn}_${key}`,
          label: `${s.name} — ${label}`,
          value,
          unit,
          category: 'education',
          source: source(DATASET),
          quality: { derived: false },
          betterWhen: better,
          note: `${note} ${where}`,
        })
      }
      add('students', 'enrolled students', s.students, 'count', 'lower', 'Reported enrolment.')
      add('graduation_rate', 'graduation rate', s.graduationRate, 'percent', 'higher',
        'Only reported by schools serving a graduating cohort, so a blank means not applicable rather than poor.')
      add('attendance_rate', 'attendance rate', s.attendanceRate, 'percent', 'higher',
        'Reported by the school. Attendance is not the same as achievement.')
    }
    return out
  },
}

export const STATE_SCHOOL_PLUGINS: StateSchoolPlugin[] = [nySchoolPlugin]
