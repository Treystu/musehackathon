import { describe, expect, it } from 'vitest'
import {
  DISPLAYABLE_KEYS,
  canRun,
  isFilterLegal,
} from '../../src/core/ai/intent-schema'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import {
  canResolveClarification,
  resolveClarification,
} from '../../src/core/ai/intent-edit'
import {
  costDefaultMeasure,
  nationalScreenIntent,
  rescueNationalScreen,
  superlativeMeasure,
} from '../../src/core/ai/national-screen'

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'lookup',
    geographies: [],
    metricKeys: [],
    filters: [],
    clarificationNeeded: true,
    ...partial,
  }
}

describe('superlativeMeasure', () => {
  it('maps an ascending superlative plus a sortable measure', () => {
    expect(superlativeMeasure('where is the cheapest rent in America?')).toBe('median_gross_rent')
    expect(superlativeMeasure('What are the lowest home values in the country?')).toBe(
      'median_home_value',
    )
    expect(superlativeMeasure('show me the lowest income places')).toBe('median_household_income')
    expect(superlativeMeasure('most affordable rentals nationwide')).toBe('median_gross_rent')
  })

  it('reads burden before rent, because a burden question contains "rent"', () => {
    expect(superlativeMeasure('where is the cheapest rent burden?')).toBe(
      'median_rent_burden_pct',
    )
    expect(superlativeMeasure('lowest share of income going to rent')).toBe(
      'median_rent_burden_pct',
    )
  })

  it('defaults a measure-less cost question about a place to live to median gross rent', () => {
    // Owner live failure, 2026-11-02: the exact question at the head
    // of this family clarified and dead-ended on the shipped build.
    expect(superlativeMeasure("What's the cheapest place to live")).toBe('median_gross_rent')
    expect(superlativeMeasure('most affordable area to live in')).toBe('median_gross_rent')
    expect(superlativeMeasure('lowest cost place to live in America')).toBe('median_gross_rent')
    expect(superlativeMeasure('least expensive neighbourhood')).toBe('median_gross_rent')
    expect(superlativeMeasure('least expensive neighborhood to live in')).toBe(
      'median_gross_rent',
    )
    expect(superlativeMeasure('where is it cheapest to live?')).toBe('median_gross_rent')
    expect(costDefaultMeasure("What's the cheapest place to live")).toBe('median_gross_rent')
  })

  it('never lets the cost default swallow a question carrying its own measure or a non-cost object', () => {
    // An explicit measure keeps its own reading, even inside a
    // place-to-live frame.
    expect(superlativeMeasure('cheapest rent burden in a place to live')).toBe(
      'median_rent_burden_pct',
    )
    expect(superlativeMeasure('lowest home values in a place to live')).toBe('median_home_value')
    // "Cheapest schools" is not a rent question.
    expect(superlativeMeasure('cheapest schools')).toBeNull()
    expect(superlativeMeasure('cheapest schools in a nice place to live')).toBeNull()
    expect(costDefaultMeasure('cheapest schools')).toBeNull()
    // A non-cost superlative still clarifies: the safety corpus case
    // safety-ranking ("Where is the best place to raise a family in
    // Texas?") pins this posture at the corpus level.
    expect(superlativeMeasure('best place to raise a family')).toBeNull()
    expect(costDefaultMeasure('best place to raise a family')).toBeNull()
    // Descending and size readings are not cost readings.
    expect(superlativeMeasure('most expensive place to live')).toBeNull()
    expect(superlativeMeasure('smallest place to live')).toBeNull()
  })

  it('leaves measure-less and descending questions to clarification', () => {
    // "Housing" alone is genuinely ambiguous between rent and home value.
    expect(superlativeMeasure("what's the cheapest housing in the whole country?")).toBeNull()
    // Descending superlatives do not rescue: the screen sorts ascending.
    expect(superlativeMeasure('where is the most expensive rent?')).toBeNull()
    expect(superlativeMeasure('highest home prices in America')).toBeNull()
    // No superlative at all.
    expect(superlativeMeasure('show me rent in America')).toBeNull()
  })
})

describe('the national screen intent', () => {
  it('is runnable under the one predicate', () => {
    const screen = nationalScreenIntent('median_gross_rent')
    expect(screen.mode).toBe('sweep_filter')
    expect(screen.geographies).toEqual([])
    expect(screen.clarificationNeeded).toBe(false)
    expect(canRun(screen)).toBe(true)
  })
})

describe('canRun minimums after the national-screen exception', () => {
  it('runs a placeless sweep on a filter-legal measure, with or without a bound', () => {
    expect(
      canRun(intent({ mode: 'sweep_filter', metricKeys: ['median_gross_rent'] })),
    ).toBe(true)
    expect(
      canRun(
        intent({
          mode: 'sweep_filter',
          metricKeys: ['median_gross_rent'],
          filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
        }),
      ),
    ).toBe(true)
  })

  it('runs a placed sweep with no bound as the geography-bounded screen, and still requires a place for every other mode', () => {
    // Bounded-screen exception (2026-11-02): the placed twin of the
    // placeless screen — scope is the named geography, sort is the
    // request. This is what makes "cheapest place to live in Texas"
    // answer-eligible instead of clarifying.
    expect(
      canRun(intent({ mode: 'sweep_filter', geographies: ['CO'], metricKeys: ['median_gross_rent'] })),
    ).toBe(true)
    expect(canRun(intent({ mode: 'lookup', metricKeys: ['median_gross_rent'] }))).toBe(false)
    expect(canRun(intent({ mode: 'similarity', metricKeys: ['median_gross_rent'] }))).toBe(false)
    expect(
      canRun(
        intent({
          mode: 'compare',
          geographies: ['Austin, TX'],
          metricKeys: ['median_gross_rent'],
        }),
      ),
    ).toBe(false)
  })

  it('keeps a non-sortable measure out of a placeless sweep', () => {
    const nonLegal = DISPLAYABLE_KEYS.find((key) => !isFilterLegal(key))
    expect(nonLegal).toBeDefined()
    expect(canRun(intent({ mode: 'sweep_filter', metricKeys: [nonLegal!] }))).toBe(false)
    expect(canRun(intent({ mode: 'sweep_filter', metricKeys: [] }))).toBe(false)
  })
})

describe('rescueNationalScreen', () => {
  const clarified = intent({})

  it('rescues the placeless superlative reply into the disclosed screen', () => {
    const rescued = rescueNationalScreen(clarified, 'where is the cheapest rent in America?')
    expect(rescued?.mode).toBe('sweep_filter')
    expect(rescued?.metricKeys).toEqual(['median_gross_rent'])
    expect(rescued?.clarificationNeeded).toBe(false)
  })

  it("rescues the owner's exact measure-less question into the rent screen", () => {
    // The probe shape the live route returns for this question
    // (coordinator probe, 2026-11-02): a clarified lookup naming
    // neither a place nor a measure.
    const rescued = rescueNationalScreen(clarified, "What's the cheapest place to live")
    expect(rescued?.mode).toBe('sweep_filter')
    expect(rescued?.geographies).toEqual([])
    expect(rescued?.metricKeys).toEqual(['median_gross_rent'])
    expect(rescued?.clarificationNeeded).toBe(false)
    expect(rescued && canRun(rescued)).toBe(true)
    // A resolvable geography in the parse bounds the screen instead
    // (generalization item 4): the same question in Texas rescues to
    // the Texas-bounded screen, not the national one.
    const bounded = rescueNationalScreen(
      intent({ geographies: ['Texas'] }),
      'cheapest place to live in Texas',
    )
    expect(bounded?.mode).toBe('sweep_filter')
    expect(bounded?.geographies).toEqual(['Texas'])
    expect(bounded?.metricKeys).toEqual(['median_gross_rent'])
    expect(bounded && canRun(bounded)).toBe(true)
  })

  it('rescues a reply whose only geographies are country-level names', () => {
    // Observed live (2026-11-01): the model attaches "America" as a
    // geography to the placeless question. A country name is not a
    // place the app can open, so the screen still completes directly.
    for (const geo of ['America', 'United States', 'the country', 'USA']) {
      const rescued = rescueNationalScreen(
        intent({ geographies: [geo] }),
        'where is the cheapest rent in America?',
      )
      expect(rescued?.mode).toBe('sweep_filter')
      expect(rescued?.geographies).toEqual([])
      expect(rescued?.metricKeys).toEqual(['median_gross_rent'])
    }
    // A resolvable real geography bounds the screen; country names
    // in the list drop out rather than widening it back to national.
    const bounded = rescueNationalScreen(
      intent({ geographies: ['America', 'Texas'] }),
      'cheapest rent in America',
    )
    expect(bounded?.geographies).toEqual(['Texas'])
    expect(bounded?.metricKeys).toEqual(['median_gross_rent'])
    const texasOnly = rescueNationalScreen(
      intent({ geographies: ['Texas'] }),
      'cheapest rent in Texas',
    )
    expect(texasOnly?.geographies).toEqual(['Texas'])
    expect(texasOnly?.clarificationNeeded).toBe(false)
  })

  it('does not touch a reply that names an unresolvable place, a measure, or runs already', () => {
    expect(
      rescueNationalScreen(intent({ geographies: ['Springfield'] }), 'cheapest rent in Springfield'),
    ).toBeNull()
    expect(
      rescueNationalScreen(intent({ metricKeys: ['median_gross_rent'] }), 'cheapest rent'),
    ).toBeNull()
    expect(
      rescueNationalScreen(
        intent({ clarificationNeeded: false }),
        'cheapest rent in America',
      ),
    ).toBeNull()
    expect(rescueNationalScreen(clarified, 'what is the rent in America?')).toBeNull()
    expect(rescueNationalScreen(clarified, undefined)).toBeNull()
  })
})

describe('clarification completion for placeless picks', () => {
  it('enables and resolves a measure-only pick as the national screen', () => {
    const base = intent({})
    expect(
      canResolveClarification({ mode: 'lookup', geographies: [], metricKeys: ['median_gross_rent'] }),
    ).toBe(true)
    const resolved = resolveClarification(base, { geographies: [], metricKeys: ['median_gross_rent'] })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.intent.mode).toBe('sweep_filter')
      expect(resolved.intent.geographies).toEqual([])
      expect(resolved.intent.clarificationNeeded).toBe(false)
    }
  })

  it('never bypasses a named place: the Springfield shape resolves as itself', () => {
    const base = intent({ geographies: ['Springfield'] })
    const resolved = resolveClarification(base, {
      geographies: [],
      metricKeys: ['median_gross_rent'],
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.intent.mode).toBe('lookup')
      expect(resolved.intent.geographies).toEqual(['Springfield'])
    }
  })

  it('keeps a non-screen measure from completing placeless', () => {
    const nonLegal = DISPLAYABLE_KEYS.find((key) => !isFilterLegal(key))!
    expect(
      canResolveClarification({ mode: 'lookup', geographies: [], metricKeys: [nonLegal] }),
    ).toBe(false)
    const resolved = resolveClarification(intent({}), { geographies: [], metricKeys: [nonLegal] })
    expect(resolved.ok).toBe(false)
  })
})
