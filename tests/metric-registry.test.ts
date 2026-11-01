/**
 * The metric registry, made complete and kept that way.
 *
 * This file exists because seven ACS variables were fetched on every national
 * sweep since the map work shipped and then discarded — unnamed, unmapped,
 * never displayed — while the roadmap described them as shown. Three of them
 * requested the wrong Census column entirely, and the wrongness never surfaced
 * precisely because nothing ever displayed the result. One more (owner-occupied
 * units) was mapped but missing from the definitions registry.
 *
 * The invariants below make that entire class impossible: every variable the
 * screen and detail paths request must map to a metric key, every mapped key
 * must have a definition, and the definitions must be exactly the keys the
 * dictionary on the methodology page documents.
 */
import { describe, expect, it } from 'vitest'

import {
  areaRowFromRaw,
  DETAIL_VARS,
  METRIC_DEFS_BY_KEY,
  METRIC_KEYS,
  METRIC_FOR_VAR,
  SCREEN_VARS,
  tableOfMetric,
  VARS,
} from '../src/core/plugins/acs'
import { NYC_SCHOOLS_SOURCE } from '../src/core/plugins/ny-schools'
import { SORTABLE_METRIC_KEYS } from '../src/core/sortable-surface'

/** The estimates among a variable list, with their margins stripped. */
const estimatesOf = (ids: readonly string[]) => ids.filter((id) => !/M$/.test(id))

describe('the metric registry is complete', () => {
  it('every estimate the screen requests maps to a metric key', () => {
    // The screen requests raw column IDs; every estimate among them must be a
    // key in METRIC_FOR_VAR, or the app is paying for a column it never reads —
    // the exact defect this file exists to prevent.
    for (const id of estimatesOf(SCREEN_VARS)) {
      expect(METRIC_FOR_VAR[id], `screen requests ${id} but maps it to nothing`).toBeDefined()
    }
  })

  it('every estimate the detail fetch requests maps to a metric key', () => {
    for (const id of estimatesOf(DETAIL_VARS)) {
      expect(METRIC_FOR_VAR[id], `detail requests ${id} but maps it to nothing`).toBeDefined()
    }
  })

  it('every mapped metric key has a definition, a category, and a Census table', () => {
    for (const key of Object.values(METRIC_FOR_VAR)) {
      const def = METRIC_DEFS_BY_KEY.get(key)
      expect(def, `no definition for ${key}`).toBeDefined()
      expect(def!.label.trim().length).toBeGreaterThan(0)
      expect(def!.note.trim().length).toBeGreaterThan(0)
      expect(def!.category).toMatch(/^(cost|education|demographics|health|environment|labor)$/)
      expect(tableOfMetric(key), `no Census table for ${key}`).toMatch(/^B\d{5}$/)
    }
  })

  it('the definition list and the key list are the same set, in the same order', () => {
    expect(METRIC_KEYS).toEqual([...METRIC_DEFS_BY_KEY.keys()])
    expect(new Set(METRIC_KEYS).size).toBe(METRIC_KEYS.length)
  })

  it('the seven figures that were fetched-and-discarded are now displayable', () => {
    for (const key of [
      'vacant_units',
      'no_internet_access',
      'average_household_size',
      'median_age',
      'below_poverty_count',
      'bachelors_count',
      'commuting_workers',
      'owner_occupied',
    ]) {
      expect(METRIC_DEFS_BY_KEY.has(key), `${key} must be defined and displayed`).toBe(true)
    }
  })

  it('the wrong Census columns are gone', () => {
    // The four that shipped wrong until 2026-10-09. If these ever come back,
    // a headcount is being rendered as minutes, a diploma as a degree, housing
    // units as households, and dial-up households as the disconnected.
    expect(VARS.households).toBe('B25002_002E') // occupied, not total housing units
    expect(VARS.noInternetAccess).toBe('B28002_013E') // no access at all, not dial-up only
    expect(VARS.commutingWorkers).toBe('B08303_001E') // workers who commute, the universe of the travel-time table
    expect(VARS.bachelorsCount).toBe('B15003_022E') // bachelor's, not high-school diploma
    expect(VARS.belowPovertyCount).toBe('B17001_002E') // count below poverty, as labelled
    expect(tableOfMetric('households')).toBe('B25002') // methodology follows the occupied-units estimate
  })

  it('attributes New York school figures to the dataset metadata actually used', () => {
    expect(NYC_SCHOOLS_SOURCE).toMatchObject({
      publisher: 'New York City Department of Education (DOE)',
      dataset: '2020 DOE High School Directory',
      tableId: '23z9-6uk9',
      vintage: '2018-19 school year',
    })
  })

  it('the demographic figures the dictionary documents are not sortable', () => {
    for (const key of ['median_age', 'below_poverty_count', 'bachelors_count', 'population']) {
      expect(SORTABLE_METRIC_KEYS, `${key} must never be a sort control`).not.toContain(key)
    }
  })

  it('derives the margin column for every estimate, not only each table\u2019s first', () => {
    // The derivation bug: _001E -> _001M matched nothing on B25002_003E, so the
    // code fell back to the estimate's own column and every one of these figures
    // would have been displayed as its own margin of error. A synthetic
    // response shaped exactly like the API's, with distinct values, proves each
    // margin now comes from its own M column.
    const estimateIds = estimatesOf(DETAIL_VARS)
    const header = ['NAME', ...estimateIds, ...estimateIds.map((id) => id.replace(/E$/, 'M'))]
    const row: (string | number)[] = ['ZCTA5 78701']
    for (const id of estimateIds) {
      row.push(Number(id.replace(/\D/g, '').slice(-3))) // distinct estimate value
    }
    for (const id of estimateIds) {
      row.push(Number(id.replace(/\D/g, '').slice(-3)) + 1) // distinct margin value
    }
    const [area] = areaRowFromRaw(header, [row])
    expect(area).toBeDefined()
    for (const id of estimateIds) {
      const key = METRIC_FOR_VAR[id]
      const estimate = area!.metrics[key]
      const margin = area!.moes[key]
      if (estimate !== null) {
        expect(margin, `${key} margin must come from its own column`).toBe(estimate! + 1)
      }
    }
  })

  it('every detail estimate that has a published margin requests it', () => {
    // ACS publishes an _M for every estimate in these tables; the detail fetch
    // requests them all, so a figure can never appear without the precision the
    // publisher supplies.
    const wanted = new Set(DETAIL_VARS)
    for (const id of estimatesOf(DETAIL_VARS)) {
      expect(wanted.has(id.replace(/E$/, 'M')), `detail fetches ${id} but not its margin`).toBe(true)
    }
  })
})
