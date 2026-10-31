import { describe, expect, it } from 'vitest'
import {
  EXPLAIN_VIEW_CLASSES,
  explainRequestForView,
  explainView,
  figureSetIdForView,
  type ExplainViewClass,
  type ViewFigureForExplain,
} from '../../src/core/ai/explain-view'
import {
  createStubProvider,
  type ExplainRequest,
  type MuseProvider,
} from '../../src/core/ai/provider'
import { realValidator } from '../../src/core/ai/validator'

const RENT: ViewFigureForExplain = {
  key: 'median_gross_rent',
  value: 1450,
  marginOfError: 85,
  vintage: '2023',
}
const RENT_OTHER: ViewFigureForExplain = {
  key: 'median_gross_rent',
  value: 1200,
  marginOfError: 50,
  vintage: '2023',
}

/** One passing figure set + prose pair per Explain class. */
const PASSING: Record<
  ExplainViewClass,
  { figures: ViewFigureForExplain[]; prose: string }
> = {
  drilldown: {
    figures: [RENT],
    prose: 'The median gross rent is 1,450, plus or minus 85.',
  },
  comparison: {
    figures: [RENT, RENT_OTHER],
    prose: 'The median gross rent figures are 1,450 and 1,200.',
  },
  sweep: {
    figures: [{ key: 'median_home_value', value: 685000, vintage: '2023' }],
    prose: 'The median home value is 685,000.',
  },
  map_selection: {
    figures: [{ key: 'households', value: 5230, vintage: '2023' }],
    prose: 'The selected area has 5,230 households.',
  },
  saved_view: {
    figures: [
      {
        key: 'median_household_income',
        value: 58200,
        marginOfError: 1200,
        vintage: '2023',
      },
    ],
    prose: 'Median household income is 58,200, plus or minus 1,200.',
  },
  similarity: {
    figures: [
      {
        key: 'median_rent_burden_pct',
        value: 31.5,
        marginOfError: 1.2,
        vintage: '2023',
      },
    ],
    prose: 'The median rent burden is 31.5 percent.',
  },
}

function providerReturning(prose: string): MuseProvider {
  return createStubProvider({
    async explain() {
      return { prose }
    },
  })
}

describe('explain on all views', () => {
  it('covers exactly the six plan classes', () => {
    expect([...EXPLAIN_VIEW_CLASSES].sort()).toEqual(
      [
        'comparison',
        'drilldown',
        'map_selection',
        'saved_view',
        'similarity',
        'sweep',
      ].sort(),
    )
  })

  for (const viewClass of EXPLAIN_VIEW_CLASSES) {
    it(`returns validated prose for the ${viewClass} view`, async () => {
      const { figures, prose } = PASSING[viewClass]
      const result = await explainView(
        providerReturning(prose),
        realValidator,
        viewClass,
        figures,
      )
      expect(result.withheld).toBe(false)
      expect(result.failure).toBeUndefined()
      expect(result.prose).toBe(prose)
    })

    it(`withholds invented numerals for the ${viewClass} view`, async () => {
      const { figures } = PASSING[viewClass]
      const result = await explainView(
        providerReturning('The headline figure is 9,999.'),
        realValidator,
        viewClass,
        figures,
      )
      expect(result.withheld).toBe(true)
      expect(result.failure).toBe('invented_numeral')
      expect(result.prose).toBeNull()
    })
  }

  it('builds the explain request from the view figure set', () => {
    const req = explainRequestForView('comparison', [RENT, RENT_OTHER])
    expect(req.figureSetId).toBe('comparison:median_gross_rent+median_gross_rent')
    expect(req.values).toEqual([
      { key: 'median_gross_rent', value: 1450, marginOfError: 85 },
      { key: 'median_gross_rent', value: 1200, marginOfError: 50 },
    ])
  })

  it('sends the built request to the provider unchanged', async () => {
    let seen: ExplainRequest | null = null
    const provider = createStubProvider({
      async explain(req) {
        seen = req
        return { prose: PASSING.drilldown.prose }
      },
    })
    await explainView(provider, realValidator, 'drilldown', [RENT])
    expect(seen).toEqual(explainRequestForView('drilldown', [RENT]))
  })

  it('caps the figure set id at the route limit', () => {
    const figures = Array.from({ length: 24 }, () => RENT)
    expect(figureSetIdForView('sweep', figures).length).toBeLessThanOrEqual(128)
  })

  it('withholds banned constructions even when the figures match', async () => {
    const result = await explainView(
      providerReturning('This is the best area; the median gross rent is 1,450.'),
      realValidator,
      'drilldown',
      [RENT],
    )
    expect(result.withheld).toBe(true)
    expect(result.failure).toBe('banned_construction')
    expect(result.prose).toBeNull()
  })

  it('withholds on provider error instead of surfacing anything', async () => {
    const provider = createStubProvider({
      async explain() {
        throw Object.assign(new Error('down'), { code: 'provider_down' })
      },
    })
    const result = await explainView(provider, realValidator, 'sweep', [
      PASSING.sweep.figures[0] as ViewFigureForExplain,
    ])
    expect(result.withheld).toBe(true)
    expect(result.failure).toBe('provider_error')
    expect(result.prose).toBeNull()
  })

  it('treats empty provider prose as an empty state, not a failure', async () => {
    const result = await explainView(
      providerReturning(''),
      realValidator,
      'saved_view',
      PASSING.saved_view.figures,
    )
    expect(result.withheld).toBe(false)
    expect(result.prose).toBe('')
  })
})
