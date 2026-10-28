import { describe, expect, it, vi } from 'vitest'

// Shifted registry FILE (-1): households removed from sortable. Proves the
// schema/harness execute against the file, not a hand list.
vi.mock('../../src/core/civicscope-registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/civicscope-registry')>()
  const sortable = (
    actual.SORTABLE_METRIC_KEYS as readonly string[]
  ).filter((k) => k !== 'households') as unknown as typeof actual.SORTABLE_METRIC_KEYS
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

describe('registry-shift file executes (-1 households)', () => {
  it('derived allowlist reflects the shifted file', () => {
    expect(FILTER_LEGAL_KEYS).toBe(SORTABLE_METRIC_KEYS)
    expect(FILTER_LEGAL_KEYS).not.toContain('households')
    expect(DISPLAYABLE_KEYS).toBe(METRIC_KEYS)
    expect(DISPLAYABLE_KEYS).toContain('households')
  })

  it('validator legality reflects the shifted file', () => {
    const r = validateIntent({
      mode: 'sweep_filter',
      geographies: ['HI'],
      metricKeys: ['households'],
      filters: [{ metricKey: 'households', op: 'gt', value: 1000 }],
      clarificationNeeded: false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('proxy_metric_blocked')
  })

  it('fixture generation reflects the shifted file', () => {
    const fixtures = registryFixtures()
    expect(fixtures).toHaveLength(METRIC_KEYS.length)
    const dropped = fixtures.find((f) => f.metricKey === 'households')
    expect(dropped?.kind).toBe('displayable-not-filter-legal-reject')
    expect(dropped?.expectedOk).toBe(false)
    expect(dropped?.expectedError).toBe('proxy_metric_blocked')
    expect(
      fixtures.filter((f) => f.kind === 'filter-legal-accept'),
    ).toHaveLength(SORTABLE_METRIC_KEYS.length)
  })
})
