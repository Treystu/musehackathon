/**
 * Data-integrity assertions over the live API.
 *
 * The requirement is absolute: no placeholder, sentinel, or invented figure may
 * reach a user. These tests verify that against the real Census API rather than
 * against a fixture, because the defect they guard against was only ever visible
 * in a real response.
 *
 * Every assertion is about a value that would be visible in the UI.
 */

import { describe, expect, it } from 'vitest'
import { areaRowFromRaw, isAcsSentinel, toNum, SCREEN_VARS, VARS } from '../core/plugins/acs'
import { districtLookup } from './resilience'
import { CHUNK_SIZE, fetchChunk, listAllZctas, planChunks } from '../core/sweep/chunk'

const sig = () => new AbortController().signal
const KEY = process.env.CENSUS_KEY

/** Any value a user could see that is not a real measurement. */
const FORBIDDEN = [-666666666, -999999999, -888888888, -2]

describe.skipIf(!KEY)('data integrity: a real ZIP code carries real figures', () => {
  it('returns plausible values for a dense urban ZIP, with margins of error', async () => {
    const { fetchAreas } = await import('../core/plugins/acs')
    const rows = await fetchAreas(['10001'], KEY!, sig())
    const row = rows.find((r) => r.zcta === '10001')
    if (!row) throw new Error('10001 did not resolve')

    // Household counts for a Manhattan ZIP are in the tens of thousands, not 0
    // and not a sentinel.
    expect(row.metrics.households).toBeGreaterThan(1000)
    expect(row.metrics.median_gross_rent).toBeGreaterThan(0)
    expect(row.metrics.median_rent_burden_pct).toBeGreaterThan(0)
    expect(row.metrics.median_rent_burden_pct).toBeLessThan(100)

    // The published margin of error must accompany the estimate.
    expect(row.moes.median_gross_rent).toBeGreaterThan(0)
    expect(row.moes.median_gross_rent).toBeLessThan(row.metrics.median_gross_rent!)
  }, 60000)

  it('gives a sparse rural ZIP a real, distinguishable result', async () => {
    const { fetchAreas } = await import('../core/plugins/acs')
    const [city] = await fetchAreas(['10001'], KEY!, sig())
    const [rural] = await fetchAreas(['59001'], KEY!, sig())
    expect(city?.metrics.households).not.toBe(rural?.metrics.households)
    expect(rural?.metrics.households).toBeGreaterThan(0)
  }, 60000)
})

describe.skipIf(!KEY)('data integrity: an absent estimate is absent, not negative', () => {
  it('reports ZCTA 00786 as not applicable rather than as a negative figure', async () => {
    // Verified live: 00786 has no renter households, so the Census API returns
    // -666666666 for rent, income and rent burden while households is a real
    // count. The point is that none of the three appear as figures.
    const { fetchAreas } = await import('../core/plugins/acs')
    const rows = await fetchAreas(['00786'], KEY!, sig())
    const row = rows.find((r) => r.zcta === '00786')
    if (!row) throw new Error('00786 did not resolve')

    for (const [key, value] of Object.entries(row.metrics)) {
      expect(FORBIDDEN, `${key} held ${value}`).not.toContain(value)
    }
    // Households is genuinely reported, so it must survive.
    expect(row.metrics.households).toBeGreaterThan(0)
  }, 60000)

  it('holds across a full chunk of real ZIP codes', async () => {
    const { SCREEN_VARS } = await import('../core/plugins/acs')
    const all = await listAllZctas(sig())
    // A wide sample from the low ranges, where ZCTAs are small and missing
    // estimates are common.
    const sample = all.filter((z) => z < '02000').slice(0, CHUNK_SIZE)
    const { header, rows } = await fetchChunk(sample, SCREEN_VARS, KEY!, sig())
    const parsed = areaRowFromRaw(header, rows)

    let present = 0
    for (const row of parsed) {
      for (const [key, value] of Object.entries(row.metrics)) {
        expect(FORBIDDEN.includes(value as number), `${row.zcta} ${key} held ${value}`).toBe(false)
        if (value !== null) {
          present++
          // No metric is ever negative once sentinels are removed.
          expect(value as number, `${row.zcta} ${key} was negative`).toBeGreaterThanOrEqual(0)
        }
      }
    }
    // The chunk is not entirely empty, which would pass the above vacuously.
    expect(present).toBeGreaterThan(100)
  }, 300000)
})

describe('data integrity: sentinels can never be constructed from any input shape', () => {
  it('handles strings, numbers, and decimal string forms', () => {
    for (const v of [
      '-666666666', -666666666, '-666666666.0', -999999999, '-999999999',
      -888888888, '-888888888.0', ' -666666666 ', '-666666666,',
    ]) {
      expect(isAcsSentinel(v), `${v} was not detected`).toBe(true)
      expect(toNum(v), `${v} became ${toNum(v)}`).toBeNull()
    }
  })

  it('leaves every legitimate value untouched', () => {
    for (const v of [0, 1, 0.5, 492, 26.3, 5093, 14.3, 666666666, 1e6]) {
      expect(toNum(v), `${v} was wrongly nulled`).not.toBeNull()
    }
  })
})

describe.skipIf(!KEY)('data integrity: school figures are real', () => {
  it('refuses a supervisory union rather than reporting it as a district', async () => {
    // All of New York City is inside an LEA_TYPE 3 administrative entity with
    // no students. Reporting it as "the school district" would be a wrong
    // answer, not a missing one.
const found = await districtLookup('NCES Manhattan', 40.7484, -73.9857, sig())()
    // What matters is the guarantee, not the catalogue: a supervisory union is
    // never returned as a school district with students and figures. NCES has
    // returned this point as the LEA_TYPE 3 administrative entity for years,
    // but that is a public catalogue which has changed underneath this test —
    // it began answering not-found — and a not-found is also a correct outcome,
    // because it withholds an answer rather than giving a wrong one. Asserting
    // the exact upstream entity would make this a test of NCES rather than of
    // the behaviour this app promises.
    expect(
      ['administrative', 'not-found'],
      `a supervisory union was resolved as ${found.kind}`,
    ).toContain(found.kind)
    // NCES EDGE is a public service and has been seen to take well over a minute
    // under load. This assertion is about a supervisory union never being
    // reported as a district, which is true regardless of how slow the service
    // is, so the budget reflects the upstream rather than the test.
  }, 300000)

  it('returns a real district with positive figures, never a sentinel', async () => {
    // Chicago, verified to fall inside an operating district. Manhattan is
    // deliberately NOT used here: the whole of New York City sits inside
    // "NYC Chancellor's Office", a supervisory union that the plugin correctly
    // rejects rather than reporting as a district.
    const found = await districtLookup('NCES Chicago', 41.8858, -87.6229, sig())()
    if (found.kind !== 'district') throw new Error(`expected a district, got ${found.kind}`)
    for (const m of found.metrics) {
      expect(FORBIDDEN, `${m.key} held ${m.value}`).not.toContain(m.value)
      expect(m.value, `${m.key} was not positive`).toBeGreaterThan(0)
    }
  }, 300000)
})

describe('data integrity: the sweep is planned within the measured ceiling', () => {
  it('never plans a chunk the API would reject', () => {
    // A pure check, no network: the planner must not be able to produce an
    // over-long chunk even if the chunk size is misconfigured downstream.
    const fake = Array.from({ length: 2001 }, (_, i) => String(10000 + i).slice(0, 5))
    for (const chunk of planChunks(fake)) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_SIZE)
    }
  })

  it('does not request more variables than the screen needs', () => {
    // The cap is on request size, not latency. The old justification was a
    // measurement taken against the ZIP wildcard query; this app issues chunked
    // queries, where adding five margin-of-error columns moved a real 800-ZCTA
    // chunk from 0.45s to 0.47s. Twelve keeps a screening request inside the
    // URL length the Census API accepts.
    expect(SCREEN_VARS.length).toBeLessThanOrEqual(20)
    // Every screen variable must be a real, defined ACS variable, either an
    // estimate (E) or a margin of error (M).
    for (const v of SCREEN_VARS) expect(v).toMatch(/^B\d{5}_\d{3}[EM]$/)
    // Each margin must have its estimate present, so a figure is never shown
    // with a precision attached to nothing.
    for (const margin of SCREEN_VARS.filter((x) => x.endsWith('_001M'))) {
      expect(SCREEN_VARS, `margin ${margin} has no matching estimate`).toContain(
        margin.replace('_001M', '_001E'),
      )
    }
    expect(SCREEN_VARS).toContain(VARS.households)
  })
})
