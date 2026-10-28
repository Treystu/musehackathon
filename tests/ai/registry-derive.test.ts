import { describe, expect, it } from 'vitest'
import {
  METRIC_DEFS_BY_KEY,
  METRIC_KEYS,
  SORTABLE_METRIC_KEYS,
  isSortableMetricKey,
} from '../../src/core/civicscope-registry'
import { registryFixtures } from '../../src/core/ai/harness'
import {
  DISPLAYABLE_KEYS,
  FILTER_LEGAL_KEYS,
  validateIntent,
} from '../../src/core/ai/intent-schema'

describe('registry derivation (single source)', () => {
  it('allowlists are the registry sets, not copies', () => {
    // Same reference: a hand-edit to either side is impossible by construction.
    expect(FILTER_LEGAL_KEYS).toBe(SORTABLE_METRIC_KEYS)
    expect(DISPLAYABLE_KEYS).toBe(METRIC_KEYS)
  })

  it('every filter-legal key is a sortable registry key, every displayable key a registry key', () => {
    for (const key of FILTER_LEGAL_KEYS) {
      expect(isSortableMetricKey(key)).toBe(true)
    }
    for (const key of DISPLAYABLE_KEYS) {
      expect(METRIC_DEFS_BY_KEY.has(key)).toBe(true)
    }
    for (const key of METRIC_KEYS) {
      expect(DISPLAYABLE_KEYS).toContain(key)
    }
  })

  it('divergence: removing one sortable key flips its fixture from accept to reject', () => {
    const baseline = registryFixtures()
    expect(baseline.filter((f) => f.kind === 'filter-legal-accept')).toHaveLength(
      SORTABLE_METRIC_KEYS.length,
    )
    const dropped = 'households'
    const shifted = registryFixtures(
      METRIC_KEYS,
      SORTABLE_METRIC_KEYS.filter((k) => k !== dropped),
    )
    // One fewer accept, one more reject; the dropped key is now rejected.
    expect(shifted.filter((f) => f.kind === 'filter-legal-accept')).toHaveLength(
      SORTABLE_METRIC_KEYS.length - 1,
    )
    const droppedFixture = shifted.find((f) => f.metricKey === dropped)
    expect(droppedFixture?.kind).toBe('displayable-not-filter-legal-reject')
    expect(droppedFixture?.expectedOk).toBe(false)
    expect(droppedFixture?.expectedError).toBe('proxy_metric_blocked')
    // Default wiring is untouched by the probe.
    expect(registryFixtures()).toHaveLength(baseline.length)
  })

  it('divergence: promoting one displayable key to sortable flips its fixture to accept', () => {
    const promoted = 'median_age'
    expect(
      registryFixtures().find((f) => f.metricKey === promoted)?.kind,
    ).toBe('displayable-not-filter-legal-reject')
    const shifted = registryFixtures(METRIC_KEYS, [...SORTABLE_METRIC_KEYS, promoted])
    const promotedFixture = shifted.find((f) => f.metricKey === promoted)
    expect(promotedFixture?.kind).toBe('filter-legal-accept')
    expect(promotedFixture?.expectedOk).toBe(true)
  })

  it('fixture-independence: a wrong allowlist disagrees with registry fixtures', () => {
    // Simulate the old failure mode: an allowlist that wrongly admits median_age.
    const wrongLegal = new Set<string>([...FILTER_LEGAL_KEYS, 'median_age'])
    const fixture = registryFixtures().find((f) => f.metricKey === 'median_age')!
    expect(fixture.kind).toBe('displayable-not-filter-legal-reject')
    // The wrong allowlist would accept it; the registry-derived fixture says
    // reject, and validation (true allowlist) agrees with the fixture.
    expect(wrongLegal.has(fixture.metricKey)).toBe(true)
    const result = validateIntent(fixture.raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('proxy_metric_blocked')
  })
})
