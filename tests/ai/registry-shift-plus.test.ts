import { describe, expect, it, vi } from 'vitest'

// Shifted registry FILE (+1): median_age promoted to sortable. Proves the
// schema/harness execute against the file, not a hand list.
vi.mock('../../src/core/civicscope-registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/civicscope-registry')>()
  const sortable = [...actual.SORTABLE_METRIC_KEYS, 'median_age'] as unknown as typeof actual.SORTABLE_METRIC_KEYS
  return {
    ...actual,
    SORTABLE_METRIC_KEYS: sortable,
    isSortableMetricKey: (key: string) =>
      (sortable as readonly string[]).includes(key) && actual.METRIC_DEFS_BY_KEY.has(key),
  }
})

import {
  SORTABLE_METRIC_KEYS,
  METRIC_KEYS,
} from '../../src/core/civicscope-registry'
import {
  DISPLAYABLE_KEYS,
  FILTER_LEGAL_KEYS,
  validateIntent,
} from '../../src/core/ai/intent-schema'
import { registryFixtures } from '../../src/core/ai/harness'

describe('registry-shift file executes (+1 median_age)', () => {
  it('derived allowlist reflects the shifted file', () => {
    expect(FILTER_LEGAL_KEYS).toBe(SORTABLE_METRIC_KEYS)
    expect(FILTER_LEGAL_KEYS).toContain('median_age')
    expect(DISPLAYABLE_KEYS).toBe(METRIC_KEYS)
  })

  it('validator legality reflects the shifted file', () => {
    const r = validateIntent({
      mode: 'sweep_filter',
      geographies: ['HI'],
      metricKeys: ['median_age'],
      filters: [{ metricKey: 'median_age', op: 'gt', value: 40 }],
      clarificationNeeded: false,
    })
    expect(r.ok).toBe(true)
  })

  it('fixture generation reflects the shifted file', () => {
    const fixtures = registryFixtures()
    expect(fixtures).toHaveLength(METRIC_KEYS.length)
    const promoted = fixtures.find((f) => f.metricKey === 'median_age')
    expect(promoted?.kind).toBe('filter-legal-accept')
    expect(promoted?.expectedOk).toBe(true)
    expect(
      fixtures.filter((f) => f.kind === 'filter-legal-accept'),
    ).toHaveLength(SORTABLE_METRIC_KEYS.length)
  })
})
