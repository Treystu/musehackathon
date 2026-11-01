/**
 * The protected-class rule, made mechanical.
 *
 * `src/core/types.ts` calls this "the single most important rule in the codebase":
 * a metric that encodes or proxies a protected characteristic is displayed but
 * never offered as a sort or filter control. Until issue #11 was closed, that rule
 * existed only as prose. `scoring.ts` said the engine "refuses to fold demographic
 * data into a composite. That is a hard rule, not a convention" — while reading no
 * flag, and while no plugin set one. The guarantee held because nobody had
 * happened to wire a demographic metric into a column list yet, which is a
 * convention wearing a hard rule's clothes.
 *
 * Every assertion below closes one of the three ways that rule could break again:
 *
 *   1. the executor must stamp the flag centrally, so a plugin cannot forget it
 *   2. the allowlist must draw only from the ACS housing definitions, which are
 *      not a protected-class proxy
 *   3. every sort surface in the app must draw only from that allowlist
 */
import { describe, expect, it } from 'vitest'

import { registry } from '../src/core/plugin-catalog'
import { METRIC_DEFS_BY_KEY, acsHousingPlugin } from '../src/core/plugins/acs'
import { SORTABLE_METRIC_KEYS, isSortableMetricKey } from '../src/core/sortable-surface'
import { affordabilityIndex } from '../src/core/scoring'
import type { MetricValue } from '../src/core/types'

describe('the flag is declared by the plugins that should carry it', () => {
  it('marks CDC PLACES health measures as a protected-class proxy', () => {
    const places = registry.all().find((p) => p.id === 'cdc-places')
    expect(places, 'the CDC PLACES plugin must be registered').toBeTruthy()
    expect(places!.legal.protectedClassProxy, 'health prevalence proxies age and disability').toBe(true)
  })

  it('does not mark the ACS housing plugin, which the sort allowlist draws from', () => {
    // If this ever flips, every sortable column becomes a protected-class
    // control and the allowlist must be rebuilt from a different source.
    expect(acsHousingPlugin.legal.protectedClassProxy ?? false).toBe(false)
  })

  it('is set by at least one plugin, so the enforcement paths are live', () => {
    const flagged = registry.all().filter((p) => p.legal.protectedClassProxy)
    expect(flagged.length).toBeGreaterThan(0)
    expect(flagged.map((p) => p.id)).toContain('cdc-places')
  })
})

describe('the sortable allowlist', () => {
  it('contains only keys the ACS housing plugin actually defines', () => {
    for (const key of SORTABLE_METRIC_KEYS) {
      expect(METRIC_DEFS_BY_KEY.has(key), `"${key}" is not an ACS housing metric`).toBe(true)
    }
  })

  it('excludes the demographic figures the ACS screen loads for display only', () => {
    // The screen loads these so the table can show them beside the housing
    // columns. None may be sorted by, which is the rule working: several of them
    // are the demographic figures the rule exists to keep out of a ranking.
    const displayOnly = [
      'population',
      'median_age',
      'poverty_rate',
      'bachelors_or_higher',
      'persons_per_household',
      'no_broadband',
    ]
    for (const key of displayOnly) {
      expect(SORTABLE_METRIC_KEYS, `"${key}" must never be sortable`).not.toContain(key)
    }
  })

  it('recognises its own members and nothing else', () => {
    expect(isSortableMetricKey('median_gross_rent')).toBe(true)
    expect(isSortableMetricKey('median_age')).toBe(false)
    expect(isSortableMetricKey('a_key_that_does_not_exist')).toBe(false)
  })
})

describe('scoring refuses a protected-class metric', () => {
  /** A minimal metric with just the fields the composite reads. */
  const metric = (key: string, value: number, extra: Partial<MetricValue> = {}): MetricValue =>
    ({
      key,
      label: key,
      value,
      unit: 'usd',
      category: 'cost',
      source: { publisher: 'test', dataset: 'test', tableId: 'test', vintage: 'test', url: 'test' },
      quality: {},
      ...extra,
    }) as MetricValue

  it('folds a normal metric into the composite', () => {
    const composite = affordabilityIndex([
      metric('median_rent_burden_pct', 30),
      metric('median_gross_rent', 1200),
      metric('median_home_value', 300000),
      metric('median_household_income', 60000),
    ])
    expect(composite.score).not.toBeNull()
    expect(composite.components.every((c) => c.excluded === undefined)).toBe(true)
  })

  it('refuses a metric stamped protectedClassProxy, and says so in the basis', () => {
    const composite = affordabilityIndex([
      metric('median_rent_burden_pct', 30, { protectedClassProxy: true }),
      metric('median_gross_rent', 1200),
      metric('median_home_value', 300000),
      metric('median_household_income', 60000),
    ])
    // The composite still computes from the remaining components, reweighted;
    // what it must never do is use the flagged one.
    expect(composite.score).not.toBeNull()
    const refused = composite.components.find((c) => c.key === 'median_rent_burden_pct')
    expect(refused?.excluded).toMatch(/protected characteristic/)
    expect(composite.basis).toMatch(/Excluded by the fair-housing rule/)
  })

  it('refuses every component if every input is flagged, rather than ranking on nothing', () => {
    const composite = affordabilityIndex([
      metric('median_rent_burden_pct', 30, { protectedClassProxy: true }),
      metric('median_gross_rent', 1200, { protectedClassProxy: true }),
      metric('median_home_value', 300000, { protectedClassProxy: true }),
      metric('median_household_income', 60000, { protectedClassProxy: true }),
    ])
    expect(composite.score).toBeNull()
  })
})
