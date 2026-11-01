/**
 * Figure filters, pinned.
 *
 * The two assertions that matter most here are the ones a reviewer would not
 * catch by reading the UI: that a row with no figure is excluded rather than
 * kept (it reads as the filter matching), and that every filter metric is on the
 * sortable allowlist — which is the mechanism that keeps a demographic filter
 * from ever appearing here.
 */
import { describe, expect, it } from 'vitest'

import { applyFigureFilters, FIGURE_FILTERS } from '../src/core/figure-filters'
import { SORTABLE_METRIC_KEYS } from '../src/core/sortable-surface'
import type { AreaRow } from '../src/core/plugins/acs'

const row = (zcta: string, metrics: Partial<AreaRow['metrics']>): AreaRow => ({
  zcta,
  name: zcta,
  metrics: { median_gross_rent: 1000, ...metrics } as AreaRow['metrics'],
  moes: {},
})

describe('the offered filters', () => {
  it('draw every metric from the sortable allowlist', () => {
    for (const f of FIGURE_FILTERS) {
      expect(SORTABLE_METRIC_KEYS, `"${f.metric}" must be allowlisted to be a filter`).toContain(f.metric)
    }
  })

  it('do not include school or health measures, which is what issue #5 records', () => {
    const keys = FIGURE_FILTERS.map((f) => f.metric).join(',')
    expect(keys).not.toMatch(/school|health|grade|per_pupil|student_teacher|places|disability/)
  })

  it('cover the four housing decisions the Phase 2A record kept', () => {
    expect(FIGURE_FILTERS.map((f) => f.metric)).toEqual([
      'median_gross_rent',
      'median_rent_burden_pct',
      'median_home_value',
      'households',
    ])
  })
})

describe('applying the filters', () => {
  const rows = [
    row('11111', { median_gross_rent: 800, households: 100 }),
    row('22222', { median_gross_rent: 1500, households: 4000 }),
    row('33333', { median_gross_rent: null, households: 50 }),
  ]

  it('returns every row when no filter has a value', () => {
    const filters = FIGURE_FILTERS.map((f) => ({ ...f, value: null }))
    expect(applyFigureFilters(rows, filters)).toHaveLength(3)
  })

  it('keeps only the areas at or under a maximum', () => {
    const out = applyFigureFilters(rows, [{ metric: 'median_gross_rent', bound: 'atMost', value: 1000 }])
    expect(out.map((r) => r.zcta)).toEqual(['11111'])
  })

  it('keeps only the areas at or over a minimum', () => {
    const out = applyFigureFilters(rows, [{ metric: 'households', bound: 'atLeast', value: 1000 }])
    expect(out.map((r) => r.zcta)).toEqual(['22222'])
  })

  it('excludes a row with no figure for an active filter, rather than keeping it', () => {
    // A reader asking "rents under $2,000" has not asked about an area with no
    // rent figure at all. Keeping it would read as the filter matching it.
    const out = applyFigureFilters(rows, [{ metric: 'median_gross_rent', bound: 'atMost', value: 2000 }])
    expect(out.map((r) => r.zcta)).toEqual(['11111', '22222'])
  })

  it('intersects when several filters are active', () => {
    const out = applyFigureFilters(rows, [
      { metric: 'median_gross_rent', bound: 'atMost', value: 2000 },
      { metric: 'households', bound: 'atLeast', value: 1000 },
    ])
    expect(out.map((r) => r.zcta)).toEqual(['22222'])
  })

  it('ignores a filter whose metric is not on the allowlist, so one cannot be smuggled in', () => {
    // The type prevents this at compile time; this asserts the runtime holds
    // the same line if a value arrives from storage or a future refactor.
    const out = applyFigureFilters(rows, [{ metric: 'median_age', bound: 'atMost', value: 99 }])
    expect(out).toHaveLength(3)
  })

  it('does not mutate the rows it is given', () => {
    const before = JSON.stringify(rows)
    applyFigureFilters(rows, [{ metric: 'households', bound: 'atLeast', value: 1000 }])
    expect(JSON.stringify(rows)).toBe(before)
  })
})
