/**
 * County aggregation, pinned against hand-computed fixtures.
 *
 * Every expected value below is arithmetic done in the test's own
 * comments, not copied from the implementation's output: the point
 * of the module is that a county figure is a stated rule applied to
 * member figures, and a rule whose test just mirrors the code would
 * pin nothing.
 */
import { describe, expect, it } from 'vitest'

import {
  aggregateRowsToCounties,
  classifyMetricKey,
  COUNT_METRIC_KEYS,
  WEIGHTED_METRIC_KEYS,
  type CountyAssignment,
} from './county-aggregate'
import { METRIC_KEYS } from './plugins/acs'
import type { AreaRow } from './plugins/acs'

function row(
  zcta: string,
  metrics: Record<string, number | null>,
  moes: Record<string, number | null> = {},
): AreaRow {
  return { zcta, name: `ZCTA5 ${zcta}`, metrics, moes }
}

const ASSIGNMENTS = new Map<string, CountyAssignment>([
  ['80301', { name: 'Boulder County', state: 'CO' }],
  ['80302', { name: 'Boulder County', state: 'CO' }],
  ['80202', { name: 'Denver County', state: 'CO' }],
  ['80203', { name: 'Denver County', state: 'CO' }],
])

describe('classification covers the registry exactly', () => {
  it('every registered metric key is classified, and the classes partition the registry', () => {
    for (const key of METRIC_KEYS) {
      expect(classifyMetricKey(key), key).not.toBe('not_aggregable')
    }
    expect(COUNT_METRIC_KEYS.size + WEIGHTED_METRIC_KEYS.size).toBe(METRIC_KEYS.length)
    for (const key of COUNT_METRIC_KEYS) expect(WEIGHTED_METRIC_KEYS.has(key)).toBe(false)
  })

  it('median_age is weighted, never summed, despite its registry unit', () => {
    // METRIC_DEFS carries median_age with unit 'count' (its unit is
    // years). It is a published median; summing member medians would
    // be meaningless, so the classification is by what the figure
    // IS, not by the unit string.
    expect(classifyMetricKey('median_age')).toBe('weighted')
  })

  it('an unknown key fails closed as not aggregable', () => {
    expect(classifyMetricKey('affordability_index')).toBe('not_aggregable')
    expect(classifyMetricKey('made_up_key')).toBe('not_aggregable')
  })
})

describe('counts: summed, margin is root-sum-of-squares', () => {
  it('sums member counts and combines margins by RSS', () => {
    const { rows, notMeasurable } = aggregateRowsToCounties(
      [
        row('80301', { households: 12000 }, { households: 300 }),
        row('80302', { households: 4000 }, { households: 200 }),
      ],
      ASSIGNMENTS,
      ['households'],
    )
    expect(notMeasurable).toEqual([])
    expect(rows).toHaveLength(1)
    const boulder = rows[0]!
    expect(boulder.name).toBe('Boulder County, CO')
    expect(boulder.memberZctas).toEqual(['80301', '80302'])
    expect(boulder.metrics.households).toBe(16000)
    // sqrt(300^2 + 200^2) = sqrt(130000) = 360.555...
    expect(boulder.moes.households).toBeCloseTo(Math.sqrt(130000), 10)
    // A summed margin is the standard propagation, not the RMS
    // approximation, so it is not labelled approximate.
    expect(boulder.approximateMarginKeys).toEqual([])
  })

  it('a count with a missing member value is not measurable, never a partial sum', () => {
    const { rows, notMeasurable } = aggregateRowsToCounties(
      [
        row('80301', { households: 12000 }),
        row('80302', { households: null }),
      ],
      ASSIGNMENTS,
      ['households'],
    )
    expect(rows[0]?.metrics.households).toBeNull()
    expect(notMeasurable).toEqual([
      { county: 'Boulder County, CO', metricKey: 'households', reason: 'partial_member_values' },
    ])
  })

  it('a sum whose members lack margins reports the value with no margin', () => {
    const { rows } = aggregateRowsToCounties(
      [row('80301', { households: 12000 }, { households: 300 }), row('80302', { households: 4000 })],
      ASSIGNMENTS,
      ['households'],
    )
    expect(rows[0]?.metrics.households).toBe(16000)
    expect(rows[0]?.moes.households).toBeUndefined()
  })
})

describe('weighted figures: population-weighted mean, RMS margin labelled approximate', () => {
  it('weights member medians by member population, not by a plain mean', () => {
    const { rows } = aggregateRowsToCounties(
      [
        row('80301', { median_gross_rent: 1800, population: 30000 }, { median_gross_rent: 100 }),
        row('80302', { median_gross_rent: 1600, population: 10000 }, { median_gross_rent: 80 }),
      ],
      ASSIGNMENTS,
      ['median_gross_rent'],
    )
    const boulder = rows[0]!
    // (1800*30000 + 1600*10000) / 40000 = 1750. The plain mean
    // would be 1700; the population weight is the whole point.
    expect(boulder.metrics.median_gross_rent).toBe(1750)
    // sqrt((30000*100^2 + 10000*80^2) / 40000) = sqrt(9100) = 95.39...
    expect(boulder.moes.median_gross_rent).toBeCloseTo(Math.sqrt(9100), 10)
    expect(boulder.approximateMarginKeys).toEqual(['median_gross_rent'])
  })

  it('population itself is a count and sums, so county weights are auditable', () => {
    const { rows } = aggregateRowsToCounties(
      [
        row('80301', { population: 30000 }),
        row('80302', { population: 10000 }),
      ],
      ASSIGNMENTS,
      ['population'],
    )
    expect(rows[0]?.metrics.population).toBe(40000)
  })

  it('a weighted figure with values but no population weights is not measurable', () => {
    const { rows, notMeasurable } = aggregateRowsToCounties(
      [
        row('80301', { median_gross_rent: 1800, population: null }),
        row('80302', { median_gross_rent: 1600, population: null }),
      ],
      ASSIGNMENTS,
      ['median_gross_rent'],
    )
    expect(rows[0]?.metrics.median_gross_rent).toBeNull()
    expect(notMeasurable).toEqual([
      { county: 'Boulder County, CO', metricKey: 'median_gross_rent', reason: 'no_population_weight' },
    ])
  })

  it('a weighted figure with no member value at all is not measurable', () => {
    const { rows, notMeasurable } = aggregateRowsToCounties(
      [row('80301', { median_gross_rent: null, population: 30000 })],
      ASSIGNMENTS,
      ['median_gross_rent'],
    )
    expect(rows[0]?.metrics.median_gross_rent).toBeNull()
    expect(notMeasurable[0]?.reason).toBe('no_member_value')
  })

  it('a member with a value but no weight is excluded and the partial coverage is recorded', () => {
    const { rows, notMeasurable } = aggregateRowsToCounties(
      [
        row('80301', { median_gross_rent: 1800, population: 30000 }),
        row('80302', { median_gross_rent: 1200, population: null }),
      ],
      ASSIGNMENTS,
      ['median_gross_rent'],
    )
    // Only the weighted member can enter the mean.
    expect(rows[0]?.metrics.median_gross_rent).toBe(1800)
    expect(notMeasurable).toEqual([
      { county: 'Boulder County, CO', metricKey: 'median_gross_rent', reason: 'partial_weight_coverage' },
    ])
  })
})

describe('non-aggregable figures and unassigned rows', () => {
  it('an unregistered figure is reported not measurable at county level, never invented', () => {
    const { rows, notMeasurable } = aggregateRowsToCounties(
      [row('80301', { affordability_index: 42, population: 30000 })],
      ASSIGNMENTS,
      ['affordability_index'],
    )
    expect(rows[0]?.metrics.affordability_index).toBeNull()
    expect(notMeasurable).toEqual([
      { county: 'Boulder County, CO', metricKey: 'affordability_index', reason: 'not_aggregable' },
    ])
  })

  it('a row with no county assignment is reported, never guessed into a county', () => {
    const { rows, unassignedZctas } = aggregateRowsToCounties(
      [row('80301', { households: 12000 }), row('99999', { households: 10 })],
      ASSIGNMENTS,
      ['households'],
    )
    expect(unassignedZctas).toEqual(['99999'])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.metrics.households).toBe(12000)
  })

  it('same-named counties in different states aggregate separately', () => {
    const assignments = new Map<string, CountyAssignment>([
      ['80301', { name: 'Washington County', state: 'CO' }],
      ['74011', { name: 'Washington County', state: 'OK' }],
    ])
    const { rows } = aggregateRowsToCounties(
      [row('80301', { households: 100 }), row('74011', { households: 200 })],
      assignments,
      ['households'],
    )
    expect(rows.map((r) => r.name)).toEqual(['Washington County, CO', 'Washington County, OK'])
    expect(rows.map((r) => r.metrics.households)).toEqual([100, 200])
  })
})
