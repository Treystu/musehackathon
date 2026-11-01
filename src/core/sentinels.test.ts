/**
 * Sentinel handling.
 *
 * The ACS does not return null or blank for an absent estimate; it returns a
 * large negative number. Rendering that as a figure produces "$-666,666,666/mo"
 * and "-666666666%" in the screening table, which is not a placeholder but a
 * confidently wrong number. These tests exist because that shipped once.
 *
 * Verified live against the Census API: ZCTA 00786 has no renter households, so
 * its median rent burden is N/A and the API returns -666666666 for rent, income
 * and burden, while households remains a real count.
 */

import { describe, expect, it } from 'vitest'
import { isAcsSentinel, toNum } from './plugins/acs'
import { areaRowFromRaw } from './plugins/acs'

describe('ACS missing-value sentinels', () => {
  it('recognises every documented sentinel', () => {
    expect(isAcsSentinel(-666666666)).toBe(true) // N/A
    expect(isAcsSentinel(-999999999)).toBe(true) // missing
    expect(isAcsSentinel(-888888888)).toBe(true) // not comparable
  })

  it('recognises sentinels in the string form the API actually returns', () => {
    // The API returns these as strings, and ratio tables add a decimal part.
    expect(isAcsSentinel('-666666666')).toBe(true)
    expect(isAcsSentinel('-666666666.0')).toBe(true)
    expect(isAcsSentinel('-999999999')).toBe(true)
  })

  it('does not treat real values as sentinels', () => {
    for (const real of [0, 1, -1, 492, 26.3, 999999, 666666666, -1.5]) {
      expect(isAcsSentinel(real), `${real} must not be a sentinel`).toBe(false)
    }
  })

  it('converts sentinels to null rather than a number', () => {
    expect(toNum('-666666666')).toBeNull()
    expect(toNum('-666666666.0')).toBeNull()
    expect(toNum(-999999999)).toBeNull()
    expect(toNum('-888888888')).toBeNull()
  })

  it('preserves genuine zero and legitimate negatives', () => {
    // Zero is a real value: a ZIP with no renter-occupied units has zero of them.
    // Filtering it out would hide a real fact.
    expect(toNum('0')).toBe(0)
    expect(toNum(0)).toBe(0)
    expect(toNum('-1')).toBe(-1)
  })

  it('produces no sentinel in a parsed row, for any column', () => {
    // The real shape: one row where three columns are N/A and one is not.
    const header = [
      'NAME',
      'B25064_001E',
      'B25071_001E',
      'B19013_001E',
      'B25002_002E',
      'zip code tabulation area',
    ]
    const rows = [['ZCTA5 00786', '-666666666', '-666666666.0', '-666666666', '97', '00786']]
    const parsed = areaRowFromRaw(header, rows)

    expect(parsed).toHaveLength(1)
    const row = parsed[0]!
    expect(row.metrics.median_gross_rent).toBeNull()
    expect(row.metrics.median_rent_burden_pct).toBeNull()
    expect(row.metrics.median_household_income).toBeNull()
    // Households is a real count and must survive.
    expect(row.metrics.households).toBe(97)
  })

  it('no metric can ever hold a sentinel, whatever the input', () => {
    const header = [
      'NAME',
      'B25064_001E',
      'B25071_001E',
      'B19013_001E',
      'B25002_002E',
      'B25003_003E',
      'B25003_002E',
      'B01003_001E',
      'zip code tabulation area',
    ]
    const rows = [
      ['ZCTA5 99999', '-666666666', '-666666666.0', '-999999999', '-888888888', '-666666666', '-666666666', '-666666666', '99999'],
    ]
    for (const row of areaRowFromRaw(header, rows)) {
      for (const [key, value] of Object.entries(row.metrics)) {
        // A sentinel must become null. Null is the correct representation of an
        // absent estimate, so the assertion is "not a sentinel", not "finite" —
        // requiring finiteness would reject the very fix.
        expect(value, `${key} held ${value}`).not.toBe(-666666666)
        expect(value, `${key} held ${value}`).not.toBe(-999999999)
        expect(value, `${key} held ${value}`).not.toBe(-888888888)
        if (value !== null) expect(Number.isFinite(value), `${key} was not finite`).toBe(true)
      }
      // Every metric in this deliberately all-sentinel row is absent.
      expect(Object.values(row.metrics).every((v) => v === null)).toBe(true)
    }
  })

  it('keeps a fully-populated row intact', () => {
    const header = ['NAME', 'B25064_001E', 'B25071_001E', 'B19013_001E', 'B25002_002E', 'zip code tabulation area']
    const rows = [['ZCTA5 00667', '492', '26.3', '18729', '12153', '00667']]
    const row = areaRowFromRaw(header, rows)[0]!
    expect(row.metrics.median_gross_rent).toBe(492)
    expect(row.metrics.median_rent_burden_pct).toBe(26.3)
    expect(row.metrics.median_household_income).toBe(18729)
    expect(row.metrics.households).toBe(12153)
  })
})

describe('NCES missing-value sentinel', () => {
  it('never surfaces -2 as a figure', () => {
    // NCES uses -2 for "not available", which is a different sentinel from the
    // ACS set. It is handled in the school plugin and asserted here so the two
    // encodings cannot drift into one another.
    const real = (v: unknown) => {
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    expect(real(-2)).toBeNull()
    expect(real(-2.0)).toBeNull()
    expect(real(5093)).toBe(5093)
    expect(real(14.3)).toBe(14.3)
    // A negative expenditure must never reach the screen.
    expect(real(-666666666)).toBeNull()
  })


  it('treats every margin-of-error encoding as absent', () => {
    // Found by auditing 4,000 real ZIP codes rather than by reading a
    // specification. Both appear only on margin columns, which is why nothing
    // caught them: a check on the estimate columns alone never sees them, and
    // the margin formatter hid them by rejecting any negative, which made a
    // parsing gap look like a working display rule.
    for (const raw of ['-333333333', '-222222222.0', '-333333333.0']) {
      expect(isAcsSentinel(raw), `${raw} is not recognised as absent`).toBe(true)
      expect(toNum(raw), `${raw} became a figure`).toBeNull()
    }
    // And the ones already known still are.
    for (const raw of ['-666666666', '-999999999', '-888888888']) {
      expect(toNum(raw)).toBeNull()
    }
    // A real margin is untouched.
    expect(toNum('862')).toBe(862)
  })
})
