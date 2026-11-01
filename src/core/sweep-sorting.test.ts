import { describe, expect, it } from 'vitest'
import { sortSweepRows } from './sweep-sorting'
import type { AreaRow } from './plugins/acs'

function row(zcta: string, rent: number | null): AreaRow {
  return { zcta, name: zcta, metrics: { median_gross_rent: rent }, moes: {} }
}

describe('sortSweepRows', () => {
  it('starts with ascending ZIP order when no figure is selected', () => {
    expect(sortSweepRows([row('90001', 900), row('02108', 1200), row('10001', 1500)], null).map((r) => r.zcta)).toEqual([
      '02108',
      '10001',
      '90001',
    ])
  })

  it('sorts by the selected figure and keeps missing figures last in either direction', () => {
    const rows = [row('10003', null), row('10002', 800), row('10001', 900)]
    expect(sortSweepRows(rows, 'median_gross_rent').map((r) => r.zcta)).toEqual(['10002', '10001', '10003'])
    expect(sortSweepRows(rows, 'median_gross_rent', false).map((r) => r.zcta)).toEqual(['10001', '10002', '10003'])
  })
})
