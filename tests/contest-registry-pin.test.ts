/**
 * Contest port pin for the pre-existing registry (issue #33).
 *
 * The registry below is pre-existing CivicScope code, sourced from
 * Sovereign-Communication/civicscope at
 * 3aa7e10dc59e764a8636aa273d4ff86714a3e782 and labeled as such in
 * docs/contest-port-manifest.md. The contest work builds on it; it does
 * not get to quietly change it. These assertions pin the exact key sets
 * as they stood at the source SHA, so a drift on the contest branch
 * fails here and has to be argued for on its own, not inherited.
 */
import { describe, expect, it } from 'vitest'

import {
  METRIC_KEYS as HOUSE_METRIC_KEYS,
  SORTABLE_METRIC_KEYS as HOUSE_SORTABLE_METRIC_KEYS,
} from '../src/core/civicscope-registry'
import { METRIC_DEFS_BY_KEY, METRIC_KEYS } from '../src/core/plugins/acs'
import { SORTABLE_METRIC_KEYS } from '../src/core/sortable-surface'

describe('contest registry pin (pre-existing, source 3aa7e10d)', () => {
  it('METRIC_KEYS is exactly the 15 pre-existing keys, in source order', () => {
    expect(METRIC_KEYS).toEqual([
      'median_gross_rent',
      'median_rent_burden_pct',
      'median_home_value',
      'median_household_income',
      'households',
      'population',
      'renter_occupied',
      'owner_occupied',
      'vacant_units',
      'no_internet_access',
      'average_household_size',
      'median_age',
      'below_poverty_count',
      'bachelors_count',
      'commuting_workers',
    ])
  })

  it('every pinned key has a definition with its source field annotations', () => {
    for (const key of METRIC_KEYS) {
      const def = METRIC_DEFS_BY_KEY.get(key)
      expect(def, `no definition for ${key}`).toBeDefined()
      expect(def!.label.trim().length).toBeGreaterThan(0)
      expect(def!.note.trim().length).toBeGreaterThan(0)
      expect(typeof def!.unit).toBe('string')
      expect(typeof def!.category).toBe('string')
      expect(['higher', 'lower']).toContain(def!.betterWhen)
    }
  })

  it('SORTABLE_METRIC_KEYS is exactly the 5 pre-existing keys, in source order', () => {
    expect([...SORTABLE_METRIC_KEYS]).toEqual([
      'median_rent_burden_pct',
      'median_gross_rent',
      'median_home_value',
      'median_household_income',
      'households',
    ])
  })

  it('the House registry module (ported copy) cannot drift from this registry', () => {
    // src/core/civicscope-registry.ts is the workbench's labeled pre-existing
    // copy of this same registry, ported byte-faithful for the House layer.
    // Two copies exist by design of the port; this pin is the mechanical
    // guarantee that they describe the same registry, so the duplication
    // cannot silently become divergence.
    expect([...HOUSE_METRIC_KEYS]).toEqual([...METRIC_KEYS])
    expect([...HOUSE_SORTABLE_METRIC_KEYS]).toEqual([...SORTABLE_METRIC_KEYS])
  })
})
