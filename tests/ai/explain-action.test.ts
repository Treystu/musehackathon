import { describe, expect, it } from 'vitest'
import { createStubProvider, type ExplainRequest } from '../../src/core/ai/provider'
import type { FigureInput } from '../../src/ui/ai/FigureCard'
import { requestValidatedExplanation, valuesForExplanation } from '../../src/ui/ai/ExplainAction'

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
