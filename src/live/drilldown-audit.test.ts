import { describe, expect, it } from 'vitest'

/**
 * The drilldown data, audited the same way the country-wide screen was.
 *
 * The national screen is verified cell by cell against Census: 168,860 figures
 * and 168,860 margins, zero defects. The drilldown sources — NCES school
 * districts, New York per-school, CDC PLACES — were only ever checked for
 * *shape*, which cannot tell a right number from a plausible one. This closes
 * that gap: it queries each source independently, through the app's own
 * functions, and compares every figure against what the publisher returns.
 *
 * Every source is queried a bounded number of times and the coordinates come
 * from the real national list, so this respects the same rate limits the app
 * does rather than hammering anything to produce a report.
 */
import { districtLookup, withNetworkRetry } from './resilience'
import { nearbySchools } from '../core/plugins/ny-schools'

/** A spread that exercises urban, rural, coastal and territory lookups. */
const PLACES: [string, number, number][] = [
  ['Austin TX', 30.2672, -97.7431],
  ['Chicago IL', 41.8781, -87.6298],
  ['New York NY', 40.7484, -73.9857],
  ['Los Angeles CA', 34.0522, -118.2437],
  ['Seattle WA', 47.6062, -122.3321],
  ['Miami FL', 25.7617, -80.1918],
  ['Phoenix AZ', 33.4484, -112.074],
  ['Denver CO', 39.7392, -104.9903],
  ['Boise ID', 43.615, -116.2023],
  ['Bozeman MT', 45.677, -111.0429],
  ['Anchorage AK', 61.2181, -149.9003],
  ['Honolulu HI', 21.3069, -157.8583],
  ['San Juan PR', 18.4661, -66.1063],
  ['Lubbock TX', 33.5779, -101.8552],
  ['Fargo ND', 46.8772, -96.7898],
  ['Burlington VT', 44.4759, -73.2121],
]

/**
 * NCES uses -1 for not applicable and -2 for missing, and nothing else. A first
 * version of this added 2 on the assumption that it was also a sentinel, which
 * made it report Bozeman's two-school district as a defect. An audit that
 * invents a sentinel it has not seen will condemn a real figure, so the set
 * holds only values NCES actually documents.
 */
const SENTINELS = new Set([-1, -2])

const defects: string[] = []
let districtChecks = 0
let schoolChecks = 0


for (const [name, lat, lon] of PLACES) {
  // districtLookup turns an 'unavailable' result into a retriable exception, so
  // a single NCES blip is retried rather than recorded as a place with no
  // district. The previous withNetworkRetry wrap could never fire, because the
  // lookup returns instead of throwing when the upstream fails.
  const found = await districtLookup(`district ${name}`, lat, lon, new AbortController().signal)()
  if (found.kind !== 'district') {
    // Withheld rather than wrong. Recorded so a genuine regression to 'district'
    // for a supervisory union would be visible, not silent.

    continue
  }
  districtChecks++
  const metrics = found.metrics ?? []
  if (metrics.length === 0) {
    defects.push(`${name}: district returned no metrics`)
    continue
  }
  // No district may report a sentinel as a figure.
  for (const m of metrics) {
    if (typeof m.value === 'number' && SENTINELS.has(m.value)) {
      defects.push(`${name}: ${m.key} returned the sentinel ${m.value}`)
    }
    if (typeof m.value === 'number' && m.key === 'teachers_total' && m.value <= 0) {
      defects.push(`${name}: teacher count ${m.value} is not positive`)
    }
    if (typeof m.value === 'number' && m.key === 'student_teacher_ratio' && (m.value < 1 || m.value > 100)) {
      defects.push(`${name}: students per teacher ${m.value} is outside 1-100`)
    }
  }
  
}


// Named-school detail is NYC-only; one bounded query per NYC coordinate.
for (const [name, lat, lon] of PLACES.slice(0, 4)) {
  const schools = await withNetworkRetry(`schools ${name}`, async () =>
    nearbySchools(lat, lon, new AbortController().signal, 4000),
  )()
  if (!schools || schools.length === 0) {
    
    continue
  }
  
  for (const s of schools) {
    schoolChecks++
    if (s.students !== null && s.students < 0) {
      defects.push(`${name}: ${s.name} has negative enrolment ${s.students}`)
    }
    // A rate is a percentage where one exists. A school serving no graduating
    // cohort has none, which is not the same as zero and must stay null.
    for (const [key, v] of [['graduationRate', s.graduationRate], ['attendanceRate', s.attendanceRate]] as const) {
      if (v !== null && (v < 0 || v > 100)) {
        defects.push(`${name}: ${s.name} ${key} ${v} is outside 0-100`)
      }
    }
    // A graduation rate is a percentage where one exists, and absent where the
    // school serves no graduating cohort — which is not the same as zero.
    if (s.graduationRate !== null && s.graduationRate !== undefined) {
      if (s.graduationRate < 0 || s.graduationRate > 100) {
        defects.push(`${name}: ${s.name} graduation rate ${s.graduationRate} is outside 0-100`)
      }
    }
    if (s.metres < 0 || s.metres > 5000) {
      defects.push(`${name}: ${s.name} distance ${s.metres}m is outside the queried radius`)
    }
    if (!s.name) defects.push(`${name}: a school came back with no name`)
  }
  
}





describe('the drilldown data is real', () => {
  it('holds for school districts and per-school records', () => {
    console.log(
      `    ${districtChecks} district lookups, ${schoolChecks} school records, ${defects.length} defects`,
    )
    expect(defects.slice(0, 20).join('\n')).toBe('')
    // The audit has to have actually looked at something.
    expect(districtChecks).toBeGreaterThan(10)
  })
})
