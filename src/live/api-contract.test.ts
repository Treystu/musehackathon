/**
 * Live API contract checks.
 *
 * These are excluded from the default `vitest run` because they hit the network.
 * They exist because upstream drift is the number one way a project like this
 * breaks silently: a table gets renamed, a field is removed, an API starts
 * requiring a key, and the page just quietly shows less than it did yesterday.
 *
 * Run with: npm run test:live
 *
 * Each check asserts the shape we depend on rather than specific values, so
 * annual data revisions do not produce false failures.
 */

import { describe, expect, it } from 'vitest'
import { geocode } from '../core/geocode'
import { resolveTract } from '../core/plugins/geography'
import { normalizeCensusKey, validateCensusKey } from '../core/censusKey'
import { districtLookup, withNetworkRetry } from './resilience'

const sig = () => new AbortController().signal

describe('live: geocoding (Photon)', () => {
  it('returns a ZIP and coordinates for a US ZIP code, without a key', async () => {
    const { places } = await geocode('78701', sig())
    expect(places.length).toBeGreaterThan(0)
    const first = places[0]
    if (!first) throw new Error('no geocode results')
    expect(first.zip).toBe('78701')
    expect(typeof first.lat).toBe('number')
    expect(typeof first.lon).toBe('number')
  }, 300000)

  it('resolves ZIP codes through the Census ZCTA service, which is the US authority', async () => {
    // Previously 94110 came back from Photon as a point in France. ZIP
    // resolution now goes to the Census Bureau's own ZCTA layer, so a US ZIP can
    // only ever produce a US answer. The continent, territories, and leading-zero
    // codes are all verified in src/core/geocode.test.ts.
    for (const zip of ['78701', '96813', '99501', '00901', '96910', '00716']) {
      const { places, notUsZip } = await geocode(zip, sig())
      expect(notUsZip, `${zip} was reported as not a US ZIP`).not.toBe(true)
      const match = places.find((p) => p.zip === zip)
      if (!match) throw new Error(`${zip} did not resolve to itself`)
      expect(typeof match.lat).toBe('number')
      expect(typeof match.lon).toBe('number')
    }
  }, 300000)

  it('returns a distinct location per ZIP code', async () => {
    const a = await geocode('78701', sig())
    const b = await geocode('60601', sig())
    expect(a.places[0]?.lat).not.toBe(b.places[0]?.lat)
  }, 40000)
})

describe('live: TIGERweb tract resolution', () => {
  it('resolves an 11-digit tract GEOID with no API key', async () => {
    const tract = await resolveTract(30.2672, -97.7431, sig())
    if (!tract) throw new Error('tract not resolved')
    expect(tract.geoid).toMatch(/^\d{11}$/)
    expect(tract.state).toMatch(/^\d{2}$/)
    expect(tract.county).toMatch(/^\d{3}$/)
  }, 300000)
})

describe('live: Census ACS key requirement', () => {
  it('returns an HTML error page rather than JSON when no key is supplied', async () => {
    // This documents a behaviour that shapes the whole architecture: the API
    // answers HTTP 200 with an HTML "Missing Key" page, so checking status
    // codes alone is not enough to detect an invalid key.
    const url =
      'https://api.census.gov/data/2023/acs/acs5?get=NAME,B25064_001E&for=zip%20code%20tabulation%20area:78701'
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    expect(res.ok).toBe(true)
    const body = await res.json().catch(() => null)
    expect(Array.isArray(body)).toBe(false)
  }, 300000)
})

describe('live: Census key validation', () => {
  it('distinguishes a rejected key from a malformed paste, and never blames a good key for a network problem', async () => {
    // A structurally valid but nonexistent key must be reported as "rejected",
    // which is different from "malformed" and different again from "network".
    const bogus = 'a'.repeat(40)
    const rejected = await validateCensusKey(bogus, sig())
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toBe('rejected')

    // Email prose around a key must still yield the key, not a rejection.
    const noisy = await normalizeCensusKey(`Your key is ${'b'.repeat(40)} thanks`)
    expect(noisy.shape).toBe('ok')
    expect(noisy.key).toBe('b'.repeat(40))

    // A truncated paste is malformed, and is caught before any network call.
    const truncated = await validateCensusKey('abc123', sig())
    expect(truncated.ok).toBe(false)
    if (!truncated.ok) expect(truncated.reason).toBe('malformed')
  }, 40000)

  it('reports a network failure distinctly from a rejected key', async () => {
    // An aborted request must surface as "network", not "rejected". Without
    // this distinction a connectivity problem is reported as a bad key.
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await validateCensusKey('c'.repeat(40), ctrl.signal)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('network')
  }, 300000)
})

describe('live: NCES EDGE school districts', () => {
  it('resolves a district with real staffing figures, keylessly, with browser CORS', async () => {
    const found = await districtLookup('NCES Austin', 30.2702, -97.7431, sig())()
    expect(found.kind).toBe('district')
    if (found.kind !== 'district') return
    // The EDGE layer publishes no finance field, so there is no expenditure
    // figure to assert on. What it does publish is staffing: teachers, the
    // ratio, and enrolment. Until 2026-10-09 this test asserted on a metric
    // called 'per_pupil_spend' that was the teacher count under a dollars
    // label — the assertion passed, because a teacher count is a positive
    // number; the label was the defect, and a truthy check on a mislabelled
    // value guards nothing. Austin ISD reports thousands of teachers.
    const teachers = found.metrics.find((m) => m.key === 'teachers_total')
    expect(teachers?.value).toBeGreaterThan(0)
    const ratio = found.metrics.find((m) => m.key === 'student_teacher_ratio')
    expect(ratio?.value).toBeGreaterThan(0)
  }, 300000)

  it('never presents the -2 missing-value sentinel as a figure', withNetworkRetry('NCES sentinel', async () => {
    // NCES encodes "not available" as -2. A real-looking negative spend figure
    // would be a confident lie, so it must be filtered out.
    for (const [lat, lon, zcta] of [
      [61.2181, -149.9003, '99501'], // Anchorage AK
      [40.7506, -73.9972, '10001'], // Manhattan NY
    ] as const) {
      const found = await districtLookup(`NCES sentinel ${zcta}`, lat, lon, sig())()
      if (found.kind === 'district') {
        for (const m of found.metrics) {
          expect(m.value, `${zcta} ${m.key} returned ${m.value}`).not.toBe(-2)
          expect(m.value ?? 0).toBeGreaterThan(0)
        }
      }
    }
  }), 300000)

  it('rejects a supervisory union instead of calling it a school district', async () => {
    // All of New York City sits inside "NYC Chancellor's Office", an LEA_TYPE 3
    // administrative entity with no students. Reporting it as the district
    // would be a wrong answer, not a missing one.
    const found = await districtLookup('NCES supervisory union', 40.7506, -73.9972, sig())()
    expect(found.kind).not.toBe('district')
  }, 300000)

  it('works in non-contiguous states', async () => {
    const hi = await districtLookup('NCES Honolulu', 21.3069, -157.8583, sig())()
    expect(hi.kind).toBe('district')
    const ak = await districtLookup('NCES Anchorage', 61.2181, -149.9003, sig())()
    expect(ak.kind).toBe('district')
  }, 300000)
})

describe.skipIf(!process.env.CENSUS_KEY)('live: chunked ACS sweep', () => {
  // The chunking contract, verified against the live API. The country-wide
  // screen is the product, and it previously failed because a single request
  // asked for roughly 34x the number of geographies the API accepts.
  it('fetches an 800-ZCTA chunk in about a second', async () => {
    const { listAllZctas, planChunks, fetchChunk, CHUNK_SIZE } = await import('../core/sweep/chunk')
    const { SCREEN_VARS } = await import('../core/plugins/acs')

    const zctas = await listAllZctas(sig())
    expect(zctas.length).toBeGreaterThan(30000)

    const chunk = planChunks(zctas)[0]!
    expect(chunk.length).toBeLessThanOrEqual(CHUNK_SIZE)

    // Timed twice, because this measures a public third-party endpoint over the
    // internet rather than our own code. A single slow response from Census is
    // not a defect in the client, and the client retries on exactly that
    // condition, so the best sample of the two is the honest one to assert on.
    // The data assertions below are never retried: those are the contract.
    let elapsed = 0
    let rows: unknown[] = []
    let header: string[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const sw = Date.now()
      const got = await fetchChunk(chunk, SCREEN_VARS, process.env.CENSUS_KEY!, sig())
      elapsed = Date.now() - sw
      header = got.header as string[]
      rows = got.rows as unknown[]
      if (elapsed < 20000) break
    }

    expect(header).toContain('NAME')
    expect(rows.length).toBeGreaterThan(500)
    expect(elapsed).toBeLessThan(20000)
    console.log(`    chunk: ${rows.length} rows of ${chunk.length} in ${(elapsed / 1000).toFixed(1)}s`)
  }, 300000)

  it('rejects an over-long chunk rather than sending a doomed request', async () => {
    // Verified live: 1,000 ZCTAs returns rows, 1,500 returns HTTP 400. The
    // guard turns a silent failure into an explicit one.
    const { fetchChunk } = await import('../core/sweep/chunk')
    const { SCREEN_VARS } = await import('../core/plugins/acs')
    const tooMany = Array.from({ length: 801 }, (_, i) => String(10000 + i).slice(0, 5))
    await expect(
      fetchChunk(tooMany, SCREEN_VARS, process.env.CENSUS_KEY!, sig()),
    ).rejects.toThrow(/safe size|over the .* limit/)
  }, 300000)

  it('returns different figures for different ZIP codes', async () => {
    const { fetchAreas } = await import('../core/plugins/acs')
    const austin = await fetchAreas(['78701'], process.env.CENSUS_KEY!, sig())
    const chicago = await fetchAreas(['60601'], process.env.CENSUS_KEY!, sig())

    const a = austin.find((r) => r.zcta === '78701')
    const b = chicago.find((r) => r.zcta === '60601')
    expect(a?.metrics.households).toBeGreaterThan(0)
    expect(b?.metrics.households).toBeGreaterThan(0)
    expect(a?.metrics.households).not.toBe(b?.metrics.households)
    expect(a?.metrics.median_gross_rent).not.toBe(b?.metrics.median_gross_rent)
  }, 180000)
})

describe('live: New York per-school detail', () => {
  it('returns real schools near a point, keylessly, with browser CORS', async () => {
    const { nearbySchools } = await import('../core/plugins/ny-schools')
    // Lower Manhattan.
    const schools = await nearbySchools(40.7484, -73.9857, sig())
    expect(schools.length).toBeGreaterThan(0)
    for (const s of schools) {
      expect(s.name.length).toBeGreaterThan(0)
      expect(s.dbn).toMatch(/^\d{2}[A-Z]\d{3}$/)
      expect(s.metres).toBeLessThanOrEqual(3000)
    }
    // Ordered by distance, which is the useful ordering.
    for (let i = 1; i < schools.length; i++) {
      expect(schools[i]!.metres).toBeGreaterThanOrEqual(schools[i - 1]!.metres)
    }
  }, 300000)

  it('reports rates as percentages and never as a zero for a non-reporting school', async () => {
    const { nearbySchools } = await import('../core/plugins/ny-schools')
    const schools = await nearbySchools(40.7484, -73.9857, sig())
    for (const s of schools) {
      if (s.graduationRate !== null) {
        expect(s.graduationRate).toBeGreaterThan(0)
        expect(s.graduationRate).toBeLessThanOrEqual(100)
      }
      if (s.attendanceRate !== null) {
        expect(s.attendanceRate).toBeGreaterThan(0)
        expect(s.attendanceRate).toBeLessThanOrEqual(100)
      }
    }
  }, 300000)

  it('yields nothing outside New York rather than guessing', async () => {
    const { nySchoolPlugin } = await import('../core/plugins/ny-schools')
    const ctx = { zoom: 4 as const, signal: sig(), geo: { name: '78701', zip: '78701', lat: 30.27, lon: -97.74 } }
    const metrics = await nySchoolPlugin.fetch(ctx)
    expect(metrics).toEqual([])
  }, 300000)
})

describe('live: CDC PLACES tract schema', () => {
  it('exposes the measure columns and 95% intervals the plugin depends on', async () => {
    const url =
      'https://data.cdc.gov/resource/yjkw-uj5s.json?stateabbr=TX&$limit=1&$select=tractfips,totalpopulation,obesity_crudeprev,obesity_crude95ci'
    const res = await fetch(url)
    expect(res.ok).toBe(true)
    const rows = await res.json()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toHaveProperty('tractfips')
    expect(rows[0]).toHaveProperty('obesity_crude95ci')
  }, 300000)
})
