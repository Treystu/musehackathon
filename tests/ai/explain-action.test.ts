import { describe, expect, it } from 'vitest'
import { createStubProvider, type ExplainRequest } from '../../src/core/ai/provider'
import type { FigureInput } from '../../src/ui/ai/FigureCard'
import {
  requestValidatedExplanation,
  requestValidatedExplanationWithRetry,
  valuesForExplanation,
} from '../../src/ui/ai/ExplainAction'

function figure(key: string, value: number | null, marginOfError?: number): FigureInput {
  return {
    key,
    value,
    marginOfError,
    source: 'ACS 5-year estimates',
    publisher: 'U.S. Census Bureau',
    dataset: 'ACS',
    table: 'B25064',
    vintage: '2023',
  }
}

describe('Explain action input and validator gate', () => {
  it('sends only known keys and applies the counts-only suppression rule', () => {
    expect(valuesForExplanation([
      figure('households', 12, 5),
      figure('median_age', 12, 2),
      figure('not_a_registry_key', 77),
    ])).toEqual([
      { key: 'households', value: null, marginOfError: undefined },
      { key: 'median_age', value: 12, marginOfError: 2 },
    ])
  })

  it('carries the figure place label into the request so prose can attribute figures to places', () => {
    expect(valuesForExplanation([
      { ...figure('median_gross_rent', 1346, 52), label: 'Hilo, HI' },
      { ...figure('median_gross_rent', 2946, 338), label: 'East Honolulu, HI' },
    ])).toEqual([
      { key: 'median_gross_rent', value: 1346, marginOfError: 52, label: 'Hilo, HI' },
      { key: 'median_gross_rent', value: 2946, marginOfError: 338, label: 'East Honolulu, HI' },
    ])
  })

  it('caps each provider request at the shared explain ceiling', () => {
    const values = valuesForExplanation(Array.from({ length: 25 }, () => figure('median_gross_rent', 1450)))
    expect(values).toHaveLength(24)
  })

  it('passes sourced wording and sends only the stable surface id plus figures', async () => {
    const calls: ExplainRequest[] = []
    const provider = createStubProvider({
      async explain(request) {
        calls.push(request)
        return { prose: 'The median gross rent is 1,450 ± 85.' }
      },
    })

    const result = await requestValidatedExplanation(provider, 'ask', [figure('median_gross_rent', 1450, 85)])

    expect(calls).toEqual([{
      figureSetId: 'ask',
      values: [{ key: 'median_gross_rent', value: 1450, marginOfError: 85 }],
    }])
    expect(result).toEqual({ explanation: { prose: 'The median gross rent is 1,450 ± 85.' } })
  })

  it('withholds invented numerals and reports an empty stub response safely', async () => {
    const invented = createStubProvider({
      async explain() {
        return { prose: 'The median gross rent is 9999.' }
      },
    })
    const empty = createStubProvider()
    const figures = [figure('median_gross_rent', 1450, 85)]

    await expect(requestValidatedExplanation(invented, 'comparison', figures)).resolves.toEqual({
      explanation: { withheld: true },
      withholdClass: 'invented_numeral',
    })
    await expect(requestValidatedExplanation(empty, 'comparison', figures)).resolves.toEqual({
      message: 'The wording helper returned no explanation.',
    })
  })

  it('retries once on a transient failure and returns the retried prose', async () => {
    let calls = 0
    const provider = createStubProvider({
      async explain() {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('breaker_open'), { code: 'breaker_open' })
        return { prose: 'The median gross rent is 1,450 ± 85.' }
      },
    })

    const result = await requestValidatedExplanationWithRetry(
      provider,
      'comparison',
      [figure('median_gross_rent', 1450, 85)],
      { sleep: async () => {} },
    )

    expect(calls).toBe(2)
    expect(result).toEqual({ explanation: { prose: 'The median gross rent is 1,450 ± 85.' } })
  })

  it('gives up after one retry when the failure persists', async () => {
    let calls = 0
    const provider = createStubProvider({
      async explain() {
        calls += 1
        throw Object.assign(new Error('provider_down'), { code: 'provider_down' })
      },
    })

    const result = await requestValidatedExplanationWithRetry(
      provider,
      'comparison',
      [figure('median_gross_rent', 1450, 85)],
      { sleep: async () => {} },
    )

    expect(calls).toBe(2)
    expect(result.errorState).toBe('provider_down')
    expect(result.message).toBe('Explanation is unavailable right now. The figures remain available.')
  })

  it('never retries a non-retryable error or withheld prose', async () => {
    let badKeyCalls = 0
    const badKey = createStubProvider({
      async explain() {
        badKeyCalls += 1
        throw Object.assign(new Error('bad_key'), { code: 'bad_key' })
      },
    })
    const withheld = createStubProvider({
      async explain() {
        return { prose: 'The median gross rent is 9999.' }
      },
    })
    const figures = [figure('median_gross_rent', 1450, 85)]

    const badKeyResult = await requestValidatedExplanationWithRetry(badKey, 'comparison', figures, {
      sleep: async () => {},
    })
    expect(badKeyCalls).toBe(1)
    expect(badKeyResult.errorState).toBe('bad_key')

    await expect(
      requestValidatedExplanationWithRetry(withheld, 'comparison', figures, { sleep: async () => {} }),
    ).resolves.toEqual({ explanation: { withheld: true }, withholdClass: 'invented_numeral' })
  })

  it('does not call a provider when every value is absent or suppressed', async () => {
    let calls = 0
    const provider = createStubProvider({
      async explain() {
        calls += 1
        return { prose: '' }
      },
    })

    await expect(requestValidatedExplanation(provider, 'map-selection', [figure('households', 19)])).resolves.toEqual({
      message: 'No reportable figures are available to explain.',
    })
    expect(calls).toBe(0)
  })
})
