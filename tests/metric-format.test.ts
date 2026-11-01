import { describe, expect, it } from 'vitest'

import type { AbsentReason, MetricValue } from '../src/core/types'
import { absenceLabel, formatMetricNumber, formatMetricValue } from '../src/ui/metric-format'

function metric(value: number | null): MetricValue {
  return {
    key: 'fixture',
    label: 'Fixture metric',
    value,
    unit: 'number',
    category: 'education',
    source: {
      publisher: 'Fixture publisher',
      dataset: 'Fixture dataset',
      tableId: 'fixture',
      vintage: '2019',
      url: 'https://example.test/fixture',
    },
    quality: {},
  }
}

describe('shared unit formatting', () => {
  it('keeps currency, monthly rent, percentages, and counts aligned across views', () => {
    expect(formatMetricNumber(1250, 'usd')).toBe('$1,250')
    expect(formatMetricNumber(1250, 'usd_monthly')).toBe('$1,250/mo')
    expect(formatMetricNumber(23.4, 'percent')).toBe('23.4%')
    expect(formatMetricNumber(23.4, 'percent', { percentSuffix: false })).toBe('23.4')
    expect(formatMetricNumber(1234, 'count')).toBe('1,234')
    expect(formatMetricNumber(1234, 'institutions')).toBe('1,234')
  })

  it('preserves the country table precision and margin display', () => {
    expect(formatMetricNumber(23.456, 'percent', { percentSuffix: false, sweepPrecision: true })).toBe('23.456')
    expect(formatMetricNumber(2, 'number', { sweepPrecision: true })).toBe('2')
  })

  it('labels missing values by cause instead of showing a dash or a sentinel', () => {
    const labels: Record<AbsentReason, string> = {
      'not-applicable': 'no valid data available here',
      'not-comparable': 'not comparable',
      missing: 'not published',
      'too-few-households': 'too few households to be reliable',
      'out-of-range': 'outside the published range',
    }

    for (const [reason, label] of Object.entries(labels) as [AbsentReason, string][]) {
      expect(absenceLabel(reason)).toBe(label)
      expect(formatMetricValue(metric(null), reason)).toBe(label)
    }
    expect(formatMetricValue(metric(-666666666))).toBe(labels['out-of-range'])
  })
})
