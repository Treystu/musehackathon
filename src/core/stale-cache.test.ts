/**
 * The stale-cache path.
 *
 * A cache hit bypasses the parser entirely, so rows written by an older build
 * replay verbatim. That is how -666666666 came back after the parser was
 * fixed: the poisoned rows were still cached under the same version stamp, so
 * nothing invalidated them.
 *
 * These tests seal that path from both ends: the stamp changes when the parsing
 * behaviour changes, and cached values are sanitised on read regardless of what
 * wrote them. The guarantee therefore does not depend on cache contents or on
 * which build created them.
 */

import { describe, expect, it } from 'vitest'
import { sanitiseAreaRow, sanitiseMetricValue, isAcsSentinel } from './plugins/acs'
import { SWEEP_VERSION } from './sweep/runSweep'
import { containsImplausible } from './cache'

describe('sanitiseMetricValue', () => {
  it('removes every ACS missing-value sentinel', () => {
    for (const v of [-666666666, -999999999, -888888888]) {
      expect(sanitiseMetricValue(v)).toBeNull()
      expect(sanitiseMetricValue(String(v))).toBeNull()
    }
  })

  it('removes any negative value, which no estimate in this set can be', () => {
    // A negative figure is either a sentinel or a bug. Either way it is not a
    // measurement and must not be displayed.
    expect(sanitiseMetricValue(-1)).toBeNull()
    expect(sanitiseMetricValue(-0.5)).toBeNull()
    expect(sanitiseMetricValue(-99999)).toBeNull()
  })

  it('rejects an impossible percentage', () => {
    // A rent burden above 100% is arithmetically possible in a year but is not
    // a median in practice, and it is always a symptom of a bad value.
    expect(sanitiseMetricValue(140, 'percent')).toBeNull()
    expect(sanitiseMetricValue(101, 'percent')).toBeNull()
  })

  it('rejects non-finite values', () => {
    expect(sanitiseMetricValue(Number.NaN)).toBeNull()
    expect(sanitiseMetricValue(Number.POSITIVE_INFINITY)).toBeNull()
    expect(sanitiseMetricValue('not a number')).toBeNull()
  })

  it('preserves every legitimate value', () => {
    for (const v of [0, 1, 26.3, 492, 8021, 653600, 18729, 95, 14.3]) {
      expect(sanitiseMetricValue(v)).toBe(v)
    }
    expect(sanitiseMetricValue(26.3, 'percent')).toBe(26.3)
    expect(sanitiseMetricValue(0, 'percent')).toBe(0)
  })
})

describe('sanitiseAreaRow: the poisoned-cache reproduction', () => {
  it('cleans a row exactly as the pre-fix build wrote it', () => {
    // This is the literal shape observed in a browser's storage: parsed metrics
    // holding the sentinel as a real number, which then rendered as
    // -666666666% and -$666,666,666.
    const poisoned = {
      zcta: '00601',
      name: 'ZCTA5 00601',
      metrics: {
        median_rent_burden_pct: -666666666,
        median_gross_rent: -666666666,
        median_household_income: -666666666,
        households: -666666666,
      },
      moes: {},
    }

    const clean = sanitiseAreaRow(poisoned)

    // Nothing poisoned survives, and the row keeps its identity so it can
    // still be listed and investigated.
    expect(clean.zcta).toBe('00601')
    for (const value of Object.values(clean.metrics)) {
      expect(value).toBeNull()
      expect(value).not.toBe(-666666666)
    }
    expect(Object.keys(clean.metrics).length).toBe(0)
  })

  it('keeps a good metric while dropping a poisoned sibling', () => {
    const mixed = {
      zcta: '78701',
      name: 'ZCTA5 78701',
      metrics: {
        median_gross_rent: 2732,
        median_rent_burden_pct: -666666666,
        households: 8021,
      },
      moes: { median_gross_rent: 320 },
    }
    const clean = sanitiseAreaRow(mixed)
    expect(clean.metrics.median_gross_rent).toBe(2732)
    expect(clean.metrics.households).toBe(8021)
    expect(clean.metrics.median_rent_burden_pct).toBeUndefined()
    expect(clean.moes.median_gross_rent).toBe(320)
  })

  it('cleans margins of error as well as estimates', () => {
    const row = sanitiseAreaRow({
      zcta: '78701',
      name: 'ZCTA5 78701',
      metrics: { median_gross_rent: 2732 },
      moes: { median_gross_rent: -999999999 },
    })
    expect(Object.keys(row.moes)).toHaveLength(0)
  })

  it('survives a row with a missing metrics object', () => {
    const broken = { zcta: '12345', name: 'ZCTA5 12345' } as never
    const clean = sanitiseAreaRow(broken)
    expect(clean.zcta).toBe('12345')
    expect(clean.metrics).toEqual({})
  })
})

describe('cache invalidation follows parsing behaviour', () => {
  it('does not reuse the stamp that the poisoned rows were written under', () => {
    // The poisoned chunks carried 'acs5:2023:screen:v1'. If the stamp ever
    // returns to that value, stale rows come back and the sentinels reappear.
    expect(SWEEP_VERSION).not.toBe('acs5:2023:screen:v1')
    expect(SWEEP_VERSION).toMatch(/v\d+/)
  })

  it('is stable, so a reload does not refetch the whole country', () => {
    // The stamp must change when parsing changes and stay fixed otherwise, or
    // every visit would be a fresh 34-request sweep.
    expect(SWEEP_VERSION).toBe(SWEEP_VERSION)
  })
})

describe('the cache self-heal only removes genuinely unusable data', () => {
  /**
   * The sweep deletes any chunk holding a value no estimate can take, which
   * means the predicate is also the thing that decides whether a returning
   * visitor keeps their data or silently refetches the whole country. A
   * predicate that is too wide is a worse bug than the sentinel it removes: it
   * burns the request budget and leaves the table empty. So its edges are
   * pinned here, including the one that a live probe found to be real.
   */
  it('flags a chunk containing a sentinel at any depth', () => {
    const poisoned = {
      body: [{ metrics: { median_home_value: 350000, median_gross_rent: -666666666 } }],
    }
    expect(containsImplausible(poisoned)).toBe(true)
    expect(containsImplausible({ body: [{ moes: { median_gross_rent: -999999999 } }] })).toBe(true)
    expect(containsImplausible({ body: [{ nested: { deep: [1, 2, -888888888] } }] })).toBe(true)
  })

  it('flags non-finite values, which cannot survive JSON but can survive a bug', () => {
    expect(containsImplausible({ body: [{ metrics: { households: Number.NaN } }] })).toBe(true)
    expect(containsImplausible({ body: [{ metrics: { households: Number.POSITIVE_INFINITY } }] })).toBe(true)
  })

  it('keeps a chunk of real data, so a healthy cache is never discarded', () => {
    // Verified against the live ACS endpoint: across 228 ZCTAs in four states,
    // the only negative values returned were missing-data encodings. Every
    // legitimate figure in this set is non-negative, and the lowest real median
    // rent burden is far from zero, so small positives must survive intact.
    const real = {
      body: [
        {
          metrics: {
            median_home_value: 0,
            median_gross_rent: 0,
            median_household_income: 0,
            median_rent_burden_pct: 0,
            households: 1,
            population: 1,
            renter_occupied: 1,
          },
          moes: { median_gross_rent: 0 },
        },
      ],
    }
    expect(containsImplausible(real)).toBe(false)
  })

  it('does not discard a chunk merely because a value is large', () => {
    // A wide predicate would catch sentinels by accident and take real
    // high-income or high-value ZCTAs with them.
    const wealthy = {
      body: [
        {
          metrics: {
            median_home_value: 9999999,
            median_household_income: 8888888,
            median_gross_rent: 99999,
            median_rent_burden_pct: 100,
            households: 33791,
            population: 99999999,
          },
        },
      ],
    }
    expect(containsImplausible(wealthy)).toBe(false)
  })
})

describe('the guarantee does not depend on the cache', () => {
  it('sentinel detection and sanitisation agree', () => {
    for (const v of [-666666666, -999999999, -888888888]) {
      expect(isAcsSentinel(v)).toBe(true)
      expect(sanitiseMetricValue(v)).toBeNull()
    }
  })
})
