/**
 * Similarity, pinned.
 *
 * The assertions here are the recorded decisions of the feature, not its
 * arithmetic. The tests that matter most are the two born from a reader's
 * report on 2026-10-09 that a Puerto Rico ZIP showed "distance 0.04" from a
 * Hawaii ZIP:
 *
 *   - Below-floor values must not collapse onto the same point. Under the old
 *     fixed scoring floors with clamping, a $20,000 income and a $27,000 income
 *     normalized to the *same* coordinate, so their difference read as zero.
 *   - A candidate missing a compared figure must be excluded, not scored on a
 *     renormalized subset — one small difference on one shared dimension used
 *     to beat four honest differences on four, so the sparsest areas won.
 *
 * Everything else is the standing set: nothing is ranked, nothing
 * protected-class can be weighted, results are alphabetical, and a missing
 * figure never fakes closeness.
 */
import { describe, expect, it } from 'vitest'

import {
  comparisonDims,
  computeRanges,
  DEFAULT_WEIGHTS,
  distance,
  findSimilar,
  isSimilarityMetric,
  SIMILARITY_METRICS,
  type Weights,
} from '../src/core/similarity'
import { SORTABLE_METRIC_KEYS } from '../src/core/sortable-surface'
import type { AreaRow } from '../src/core/plugins/acs'

const row = (zcta: string, metrics: Partial<AreaRow['metrics']>): AreaRow => ({
  zcta,
  name: zcta,
  metrics: {
    median_rent_burden_pct: 30,
    median_gross_rent: 1200,
    median_home_value: 300000,
    median_household_income: 60000,
    ...metrics,
  } as AreaRow['metrics'],
  moes: {},
})

const W = DEFAULT_WEIGHTS

/** A sweep whose observed range spans genuinely different figures. */
const COUNTRY = [
  row('00001', { median_gross_rent: 400, median_household_income: 11000, median_home_value: 25000 }),
  row('19999', { median_gross_rent: 3500, median_household_income: 250000, median_home_value: 1600000 }),
  row('78701', {}),
  row('10001', {}),
  row('60601', { median_gross_rent: 1300 }),
]

describe('the weightable dimensions', () => {
  it('are drawn from the sortable allowlist, so no protected-class metric can be weighted', () => {
    for (const m of SIMILARITY_METRICS) {
      expect(SORTABLE_METRIC_KEYS, `"${m}" must be allowlisted to be weightable`).toContain(m)
    }
  })

  it('exclude health and school measures by name, which is the Phase 2B decision', () => {
    const joined = SIMILARITY_METRICS.join(',')
    expect(joined).not.toMatch(/places|health|disability|school|per_pupil|student_teacher/)
  })

  it('reject an unknown key at runtime, where weights arrive from storage', () => {
    expect(isSimilarityMetric('median_gross_rent')).toBe(true)
    expect(isSimilarityMetric('obesity_crudeprev')).toBe(false)
    expect(isSimilarityMetric('median_age')).toBe(false)
  })
})

describe('normalization against the observed range', () => {
  it('computes the loaded screen\u2019s own minimum and maximum per figure', () => {
    const ranges = computeRanges(COUNTRY, SIMILARITY_METRICS)
    expect(ranges.get('median_gross_rent')).toEqual({ min: 400, max: 3500 })
    expect(ranges.get('median_household_income')).toEqual({ min: 11000, max: 250000 })
    expect(ranges.get('median_home_value')).toEqual({ min: 25000, max: 1600000 })
  })

  it('two different below-floor incomes are different points, not the same one', () => {
    // The regression behind the reader's 0.04. The old normalization clamped
    // anything below the affordability index's floor to 0, so $20,000 and
    // $27,000 were identical coordinates and their difference read as zero.
    // Against the observed range the same values differ by their true share.
    const ranges = computeRanges(
      [
        row('00001', { median_household_income: 11000 }),
        row('19999', { median_household_income: 250000 }),
      ],
      ['median_household_income'],
    )
    const a = row('30001', { median_household_income: 20000 })
    const b = row('40001', { median_household_income: 27000 })
    const zeroWeight: Weights = { ...W, median_gross_rent: 0, median_home_value: 0, median_rent_burden_pct: 0 }
    const d = distance(a, b, zeroWeight, ranges, ['median_household_income'])
    expect(d).not.toBe(0)
    expect(d).toBeCloseTo(7000 / 239000, 10)
  })

  it('a figure the whole country agrees on cannot separate areas, and does not divide by zero', () => {
    const sweep = [row('00001'), row('19999')] // identical burden 30 everywhere
    const ranges = computeRanges(sweep, ['median_rent_burden_pct'])
    expect(ranges.get('median_rent_burden_pct')).toEqual({ min: 30, max: 30 })
    const d = distance(sweep[0]!, sweep[1]!, W, ranges, ['median_rent_burden_pct'])
    expect(d).toBe(0)
  })

  it('a figure nobody carries is absent from the ranges, not zero', () => {
    const sweep = [row('00001', { median_home_value: null })]
    const ranges = computeRanges(sweep, ['median_home_value'])
    expect(ranges.has('median_home_value')).toBe(false)
  })
})

describe('distance', () => {
  const ranges = computeRanges(COUNTRY, SIMILARITY_METRICS)
  const dims = SIMILARITY_METRICS.filter((m) => (W[m] ?? 0) > 0)

  it('is zero for identical areas', () => {
    const a = row('11111', {})
    const b = row('22222', {})
    expect(distance(a, b, W, ranges, dims)).toBe(0)
  })

  it('is symmetric', () => {
    const a = row('11111', { median_gross_rent: 800 })
    const b = row('22222', { median_gross_rent: 2800 })
    expect(distance(a, b, W, ranges, dims)).toBeCloseTo(distance(b, a, W, ranges, dims)!, 12)
  })

  it('grows as the figures grow apart, and stays inside 0..1', () => {
    const origin = row('11111', {})
    const near = row('22222', { median_gross_rent: 1300 })
    const far = row('33333', { median_gross_rent: 3400 })
    const dNear = distance(origin, near, W, ranges, dims)!
    const dFar = distance(origin, far, W, ranges, dims)!
    expect(dFar).toBeGreaterThan(dNear)
    expect(dFar).toBeLessThanOrEqual(1)
  })

  it('returns null when either area is missing a compared figure — excluded, not imputed', () => {
    const sparse = row('44444', { median_gross_rent: null })
    expect(distance(row('11111', {}), sparse, W, ranges, dims)).toBeNull()
  })

  it('ignores a metric the reader weighted at zero', () => {
    const origin = row('11111', {})
    const differsOnlyInRent = row('22222', { median_gross_rent: 3400 })
    const zeroRent: Weights = { ...W, median_gross_rent: 0 }
    expect(distance(origin, differsOnlyInRent, zeroRent, ranges, ['median_rent_burden_pct', 'median_home_value', 'median_household_income'])).toBe(0)
  })
})

describe('findSimilar', () => {
  const origin = row('78701', {})

  it('excludes an area that shares one figure over one that shares all four', () => {
    // The second half of the reader's 0.04: renormalization meant a candidate
    // with a single small difference on a single shared dimension outscored
    // candidates with real differences across all four. It must be excluded.
    const sweep = [
      row('00001', { median_gross_rent: 1250 }), // carries all four, modest diffs
      row('96778', { median_gross_rent: null, median_home_value: null, median_household_income: null }), // one figure only
      origin,
    ]
    const out = findSimilar(sweep, origin, W, 1)
    expect(out.map((s) => s.zcta)).toContain('00001')
    expect(out.map((s) => s.zcta)).not.toContain('96778')
  })

  it('orders results alphabetically by ZIP code, never by distance', () => {
    const out = findSimilar(COUNTRY, origin, W, 1)
    const zips = out.map((s) => s.zcta)
    expect(zips).toEqual([...zips].sort())
  })

  it('carries each result\u2019s figures, so the reader can check the comparison', () => {
    const out = findSimilar(COUNTRY, origin, W, 1)
    for (const s of out) {
      expect(Object.keys(s.figures)).toHaveLength(SIMILARITY_METRICS.length)
    }
  })

  it('respects a tighter cut-off than the default', () => {
    const loose = findSimilar(COUNTRY, origin, W, 1).length
    const tight = findSimilar(COUNTRY, origin, W, 0.001).length
    expect(tight).toBeLessThanOrEqual(loose)
  })

  it('is deterministic', () => {
    const first = findSimilar(COUNTRY, origin, W, 1).map((s) => `${s.zcta}:${s.distance}`)
    for (let i = 0; i < 3; i++) {
      expect(findSimilar(COUNTRY, origin, W, 1).map((s) => `${s.zcta}:${s.distance}`)).toEqual(first)
    }
  })

  it('compares only on dimensions the origin actually carries', () => {
    const sparseOrigin = row('96778', { median_gross_rent: null })
    expect(comparisonDims(sparseOrigin, W)).not.toContain('median_gross_rent')
    // And a candidate is measured against exactly those dimensions.
    const sweep = [sparseOrigin, row('00001', {})]
    const out = findSimilar(sweep, sparseOrigin, W, 1)
    expect(out.every((s) => Object.keys(s.figures).length === 3)).toBe(true)
  })

  it('returns nothing when the origin carries none of the weighted figures', () => {
    const empty = row('99999', {
      median_gross_rent: null,
      median_home_value: null,
      median_household_income: null,
      median_rent_burden_pct: null,
    })
    expect(findSimilar(COUNTRY, empty, W, 1)).toEqual([])
  })
})
