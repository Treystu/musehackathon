import { describe, expect, it } from 'vitest'
import { comparableMetricRows } from './comparison'
import type { MetricValue } from './types'

function metric(overrides: Partial<MetricValue> = {}): MetricValue {
  return {
    key: 'median_gross_rent',
    label: 'Median gross rent',
    value: 1400,
    unit: 'usd_monthly',
    category: 'cost',
    source: {
      publisher: 'U.S. Census Bureau',
      dataset: 'ACS 5-year',
      tableId: 'B25064',
      vintage: '2023',
      url: 'https://api.census.gov/data/2023/acs/acs5',
    },
    quality: { marginOfError: 80 },
    ...overrides,
  }
}

describe('comparableMetricRows', () => {
  it('keeps figures aligned only when every area uses the same measure', () => {
    const firstRent = metric({ value: 1400 })
    const secondRent = metric({ value: 1800 })
    const firstSchool = metric({
      key: 'enrollment',
      label: 'Enrollment',
      unit: 'count',
      source: { ...metric().source, publisher: 'NYC Department of Education' },
    })
    const secondSchool = metric({
      key: 'enrollment',
      label: 'Enrollment',
      unit: 'count',
      source: { ...metric().source, publisher: 'NCES' },
    })

    const rows = comparableMetricRows([
      { metrics: [firstRent, firstSchool] },
      { metrics: [secondRent, secondSchool] },
    ])

    expect(rows).toEqual([
      {
        key: 'median_gross_rent',
        label: 'Median gross rent',
        note: undefined,
        values: [firstRent, secondRent],
      },
    ])
  })

  it('omits a figure if an area is missing it or uses a different vintage', () => {
    const rent = metric()
    const oldRent = metric({ source: { ...metric().source, vintage: '2019' } })
    const income = metric({ key: 'income', label: 'Median income', unit: 'usd' })

    expect(
      comparableMetricRows([
        { metrics: [rent, income] },
        { metrics: [oldRent] },
      ]),
    ).toEqual([])
  })

  it('does not create a comparison with fewer than two areas', () => {
    expect(comparableMetricRows([{ metrics: [metric()] }])).toEqual([])
    expect(comparableMetricRows([])).toEqual([])
  })
})
