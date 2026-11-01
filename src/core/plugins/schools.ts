/**
 * School district resources, from NCES EDGE school-district boundaries.
 *
 * Source: the live NCES ArcGIS GeoService for EDGE_ADMIN district boundaries,
 * reached through the Data.ed.gov catalog. Verified working: a point query
 * returns the district containing that coordinate, with teacher count
 * (TOTTCH), student-teacher ratio (STUTERATIO), enrollment (MEMBER), school
 * count (SCH), and grade span already joined in. It sends
 * Access-Control-Allow-Origin, so it is keyless and works in the browser.
 *
 * This replaced an earlier integration against educationdata.education.gov.
 * The EDGE admin-data layer supplies the staffing and enrollment figures joined
 * to the boundary, so no second request and no name-matching guess is needed.
 *
 * Two data hazards are handled explicitly, both found by querying live data:
 *
 *   1. `-2` is NCES's missing-value sentinel, not a number. It appears where a
 *      district is real but reports no figure.
 *   2. A point can fall inside a *supervisory union* (LEA_TYPE 3) rather than a
 *      school district — all of New York City is inside "NYC Chancellor's
 *      Office", a state-level administrative entity with no students. Returning
 *      it as "the school district" would show a user real but meaningless
 *      numbers, so those are rejected and reported honestly.
 *
 * This reports district staffing and enrollment indicators. It does not invent
 * a school quality rating.
 */

import { getJson, SourceUnavailableError } from '../http'
import type { MetricValue, PluginRequest, QueryContext, SourceRef } from '../types'

const EDGE =
  'https://nces.ed.gov/opengis/rest/services/School_District_Boundaries/EDGE_ADMINDATA_SCHOOLDISTRICTS_SY2324/MapServer/1/query'

/** NCES missing-value sentinel. Never present a figure equal to this. */
const MISSING = -2

/** LEA_TYPE 3 is a supervisory union or administrative center, not a district. */
const ADMINISTRATIVE_LEA_TYPE = 3

interface EdgeFeature {
  attributes: {
    SURVYEAR?: string
    STATENAME?: string
    LEAID?: string
    ST_LEAID?: string
    LEA_NAME?: string
    LEA_TYPE?: number
    LEA_TYPE_TEXT?: string
    SY_STATUS_TEXT?: string
    GSLO?: string
    GSHI?: string
    SCH?: number
    MEMBER?: number
    TOTTCH?: number
    STUTERATIO?: number
    LOCALE_TEXT?: string
    CONAME?: string
  }
}

function source(url: string, tableId: string): SourceRef {
  return {
    publisher: 'U.S. Department of Education, National Center for Education Statistics',
    dataset: 'EDGE school district boundaries and characteristics',
    tableId,
    vintage: '2023-24',
    url,
    citation: 'NCES EDGE Admin Data, school district boundaries 2023-24',
  }
}

/** Returns a number only when it is present, positive, and not the sentinel. */
function real(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n === MISSING || n <= 0) return null
  return n
}

export type SchoolLookup =
  | { kind: 'district'; name: string; state: string; metrics: MetricValue[] }
  | { kind: 'administrative'; name: string; state: string }
  | { kind: 'not-found' }
  | { kind: 'unavailable'; reason: string }

/**
 * Exported for tests and for the drilldown panel.
 *
 * An upstream failure is `unavailable`, never `not-found`. Until 2026-10-07 every
 * fetch error collapsed into `not-found`, which meant two wrong things at once: a
 * reader during an NCES blip was told their district does not exist, and
 * `withNetworkRetry` in the live suite could not retry — the function never
 * throws, so a 500 arrived as a clean miss and a flapping upstream failed CI on
 * single blips. Found exactly that way: the live contract failed three times on
 * a service that was serving normally seconds later, and the failing assertion
 * read "expected 'not-found' to be 'district'", indistinguishable from real
 * drift. `not-found` now means only what it says: the point is outside any
 * district, or the district is an administrative area this panel does not show.
 */
export async function lookupSchoolDistrict(
  lat: number,
  lon: number,
  signal: AbortSignal,
): Promise<SchoolLookup> {
  const url =
    `${EDGE}?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326` +
    `&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`

  let body: { features?: EdgeFeature[]; error?: { message?: string } }
  try {
    body = await getJson<{ features?: EdgeFeature[]; error?: { message?: string } }>(url, { signal, metered: true })
  } catch (err) {
    if (signal.aborted) throw err
    return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
  }
  // ArcGIS answers HTTP 200 with an error body for a failing query, which is
  // indistinguishable from a miss unless the body is inspected.
  if (body.error) {
    return { kind: 'unavailable', reason: body.error.message ?? 'NCES returned an error body' }
  }

  const attrs = body.features?.[0]?.attributes
  if (!attrs) return { kind: 'not-found' }

  const name = (attrs.LEA_NAME ?? 'Unknown district').trim()
  const state = (attrs.STATENAME ?? '').trim()

  // A supervisory union is not a school district. This is the whole of New York
  // City, so silently returning it would be a wrong answer rather than a
  // missing one.
  if (attrs.LEA_TYPE === ADMINISTRATIVE_LEA_TYPE) {
    return { kind: 'administrative', name, state }
  }

  const metrics: MetricValue[] = []
  const push = (
    key: string,
    label: string,
    raw: unknown,
    unit: MetricValue['unit'],
    derivation: string,
    betterWhen: 'higher' | 'lower',
    note?: string,
  ) => {
    const value = real(raw)
    metrics.push({
      key,
      label,
      value,
      unit,
      category: 'education',
      source: source(url, 'EDGE_ADMINDATA_SCHOOLDISTRICTS'),
      // These are published values, not our arithmetic.
      quality: { derived: false },
      betterWhen,
      note,
    })
    void derivation
  }

  // The EDGE admin-data layer publishes no finance field at all — its only
  // figures are schools, enrolment, teachers and the ratio. From the first
  // version until 2026-10-09 this slot was named as an expenditure-per-pupil
  // metric and read `TOTTCH` — the teacher count — under a dollars label: a
  // district with 62 teachers displayed "Expenditure per pupil $62", and
  // because the education composite weighted it 0.6, every district in the
  // country scored 40 on that index, exactly. Found by a reader comparing
  // their county's card against common sense. This is now the teacher count,
  // labelled as the teacher count, and the composite is gone rather than fed:
  // restoring per-pupil spending means a real finance source (the Census
  // school system finances survey), not a relabelled staffing figure.
  push('teachers_total', 'Teachers in district', attrs.TOTTCH, 'count', '', 'higher',
    'Teachers reported by the district, all types. A staffing input, not a measure of teaching quality.')
  push('student_teacher_ratio', 'Students per teacher', attrs.STUTERATIO, 'ratio', '', 'lower',
    'Total enrollment divided by teacher count, as published by NCES. All teachers, not classroom-only.')
  push('enrolled_students', 'Enrolled students', attrs.MEMBER, 'count', '', 'lower')
  push('school_count', 'Schools in district', attrs.SCH, 'institutions', '', 'lower',
    'How many schools this district operates. A high count often means a fragmented district, which limits how much any one school can specialise.')

  // Context that helps a user judge what the numbers describe, taken from the
  // same record rather than invented.
  const context: string[] = []
  const localeTail = attrs.LOCALE_TEXT?.split(':').pop()?.trim()
  if (localeTail) context.push(`Locale: ${localeTail}`)
  if (attrs.CONAME) context.push(`County: ${attrs.CONAME}`)
  const span = [
    attrs.GSHI === 'PK' ? 'serves pre-K' : null,
    attrs.GSHI && attrs.GSHI !== 'N' ? `through grade ${attrs.GSHI}` : null,
  ]
    .filter(Boolean)
    .join(' ')
  if (span) context.push(span[0]! === 'serves pre-K' ? `Grade span: ${span}` : span)
  if (attrs.SURVYEAR) context.push(`NCES data year ${attrs.SURVYEAR}`)

  const suffix = context.length ? ` ${context.join('. ')}.` : ''

  return {
    kind: 'district',
    name,
    state,
    metrics: metrics
      .filter((m) => m.value !== null)
      .map((m) => ({ ...m, note: `${m.note ?? ''}${suffix}`.trim() })),
  }
}

/**
 * Per-state assessment results.
 *
 * The original brief asked for per-state school detail on drilldown. The
 * completion gate identified this as the one materially unmet requirement, and
 * it is now partly delivered: the app has NYC DOE school detail and a separate
 * nationwide 2019 EDFacts graduation-outcome lane joined to NCES EDGE locations.
 *
 * National outcomes are limited to the eight nearest public schools with
 * reportable 2019 four-year adjusted cohort graduation data within 3 km. This
 * is not all-grade or current-year school coverage; missing, not-applicable,
 * and suppressed values are not shown. The 55-portal search did not cover this
 * federal API and is not evidence that other school-level sources do not exist.
 */
export const STATE_ASSESSMENT_COVERAGE = {
  federal: 'NCES EDGE district context nationwide; up to 8 nearby 2019 EDFacts ACGR outcomes per selected location.',
  perSchool: ['Up to 8 nearest public schools within 3 km with reportable 2019 ACGR', 'New York City DOE detail (2018–19)'],
  notYetCovered:
    'National school outcomes show at most 8 public schools within 3 km per selected location and are limited to reportable 2019 ACGR; other years, grades, outcome types, private schools, and non-reportable records are not covered.',
  reason:
    'NCES EDGE 2019–20 public-school locations are joined by NCES school ID to 2019 EDFacts ACGR from the Urban Institute Education Data Portal. Up to eight nearest reportable schools are shown; the source reports ranges for many cohorts and omits non-reportable outcomes.',
} as const

export const ncesSchoolCorePlugin: PluginRequest = {
  id: 'nces-school-core',
  title: 'School district resources (NCES)',
  category: 'education',
  geography: 'schoolDistrict',
  minZoom: 4,
  legal: {
    suppressBelow: 20,
    notice:
      'School district boundaries are administrative and historical, not a reflection of school quality. Attendance zone assignment varies by district and can change. These are staffing and enrollment indicators, not ratings. Figures NCES reports as unavailable are shown as blank rather than substituted.',
  },

  async fetch(ctx: QueryContext): Promise<MetricValue[]> {
    const { lat, lon } = ctx.geo ?? {}
    if (lat === undefined || lon === undefined) return []
    const found = await lookupSchoolDistrict(lat, lon, ctx.signal)
    // `unavailable` is thrown as SourceUnavailableError rather than returned
    // empty, because the executor already maps that error to a plugin result of
    // status 'unavailable' with the reason — the engine's existing convention for
    // a source that could not be reached. Returning [] here would fold a dead
    // upstream into a no-district answer, which is the confusion this fix exists
    // to remove.
    if (found.kind === 'unavailable') {
      throw new SourceUnavailableError(`NCES school data unavailable: ${found.reason}`, this.id)
    }
    if (found.kind !== 'district') return []
    return found.metrics
  },
}
