import { describe, expect, it } from 'vitest'
import {
  composeAnswer,
  runAnswerPipeline,
  screenCriteriaFromIntent,
  screenRows,
  verifyAnswer,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { findBannedConstruction } from '../../src/core/ai/validator'

/**
 * Answer layer (2026-11-02): parse -> screen -> research -> compose ->
 * verify. Fixture rows only; the research stage runs on the stub
 * provider, so no network and no model is involved.
 */
const ROWS: AreaRow[] = [
  {
    zcta: '96720',
    name: 'Hilo, HI',
    metrics: { median_gross_rent: 1450, median_rent_burden_pct: 31.5, median_household_income: 62000, households: 14000 },
    moes: { median_gross_rent: 85, median_rent_burden_pct: 2.1, median_household_income: 3100, households: 420 },
  },
  {
    zcta: '96749',
    name: 'Keaau, HI',
    metrics: { median_gross_rent: 1325, median_rent_burden_pct: 29.8, median_household_income: 54000, households: 5200 },
    moes: { median_gross_rent: 120, median_rent_burden_pct: 3.4, median_household_income: 4100, households: 260 },
  },
  {
    zcta: '96778',
    name: 'Pahoa, HI',
    metrics: { median_gross_rent: 1750, median_rent_burden_pct: 38.2, median_household_income: 48000, households: 6100 },
    moes: { median_gross_rent: 150, median_rent_burden_pct: 4.0, median_household_income: 3900, households: 300 },
  },
  {
    zcta: '96813',
    name: 'Honolulu, HI',
    metrics: { median_gross_rent: null, median_rent_burden_pct: 33.1, median_household_income: 88000, households: 21000 },
    moes: { median_gross_rent: null, median_rent_burden_pct: 2.8, median_household_income: 5200, households: 610 },
  },
]

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: ['median_gross_rent'],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
}

describe('screen: thresholds over fixture rows', () => {
  it('keeps only rows whose known values meet every bound', () => {
    const screen = screenRows(
      intent({
        filters: [
          { metricKey: 'median_gross_rent', op: 'lt', value: 1500 },
          { metricKey: 'median_rent_burden_pct', op: 'lt', value: 32 },
        ],
      }),
      ROWS,
    )
    // Pahoa fails both bounds; Honolulu has no published rent and is
    // excluded rather than kept (a missing figure is not a match).
    expect(screen.rows.map((r) => r.zcta)).toEqual(['96720', '96749'])
    expect(screen.inScopeCount).toBe(4)
  })

  it('converts intent ops the way the existing Ask execution does, and reports the rest', () => {
    const { criteria, dropped } = screenCriteriaFromIntent(
      intent({
        filters: [
          { metricKey: 'median_gross_rent', op: 'lt', value: 1500 },
          { metricKey: 'median_home_value', op: 'eq_range', value: 400000 },
          { metricKey: 'households', op: 'gt', value: 1000 },
          { metricKey: 'median_gross_rent', op: 'gt', value: 900 },
          { metricKey: 'households', op: 'lt', value: 50000 },
        ],
      }),
    )
    expect(criteria).toEqual([
      { metricKey: 'median_gross_rent', bound: 'atMost', value: 1500, intentOp: 'lt' },
      { metricKey: 'median_home_value', bound: 'atMost', value: 400000, intentOp: 'eq_range' },
      { metricKey: 'households', bound: 'atLeast', value: 1000, intentOp: 'gt' },
    ])
    expect(dropped).toEqual([
      { metricKey: 'median_gross_rent', intentOp: 'gt', value: 900, reason: 'bound_not_expressible' },
      { metricKey: 'households', intentOp: 'lt', value: 50000, reason: 'bound_not_expressible' },
    ])
  })

  it('applies a households minimum', () => {
    const screen = screenRows(
      intent({ filters: [{ metricKey: 'households', op: 'gt', value: 10000 }] }),
      ROWS,
    )
    expect(screen.rows.map((r) => r.zcta)).toEqual(['96720', '96813'])
  })
})

describe('screen: geography', () => {
  it('matches a 5-digit geography directly against the ZCTA', () => {
    const screen = screenRows(
      intent({
        geographies: ['96749'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
      }),
      ROWS,
    )
    expect(screen.rows.map((r) => r.zcta)).toEqual(['96749'])
  })

  it('narrows by caller-resolved ZCTAs for a named place', () => {
    const screen = screenRows(
      intent({
        geographies: ['Hilo, HI'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 2000 }],
      }),
      ROWS,
      new Set(['96720', '96749']),
    )
    expect(screen.rows.map((r) => r.zcta)).toEqual(['96720', '96749'])
    expect(screen.unresolvedGeographies).toEqual([])
  })

  it('reports a named place it cannot resolve instead of guessing', () => {
    const screen = screenRows(
      intent({
        geographies: ['Hilo, HI'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1400 }],
      }),
      ROWS,
    )
    expect(screen.unresolvedGeographies).toEqual(['Hilo, HI'])
    // Unresolved geography does not narrow: the bound alone screens.
    expect(screen.rows.map((r) => r.zcta)).toEqual(['96749'])
  })
})

describe('compose: deciding figures with margins carried through', () => {
  it('copies value and margin of error exactly, with headroom against the bound', () => {
    const screen = screenRows(
      intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] }),
      ROWS,
    )
    const answer = composeAnswer({ intent: intent({}), screen })
    const hilo = answer.places.find((p) => p.zcta === '96720')
    expect(hilo?.figures).toEqual([
      { key: 'median_gross_rent', value: 1450, marginOfError: 85, distanceToBound: 50 },
    ])
    const keaau = answer.places.find((p) => p.zcta === '96749')
    expect(keaau?.figures[0]).toMatchObject({ value: 1325, marginOfError: 120, distanceToBound: 175 })
  })
})

describe('pipeline: stages end to end', () => {
  it('verifies a Census-only answer and names the meeting places', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] }),
      rows: ROWS,
    })
    expect(answer.status).toBe('verified')
    expect(answer.stage).toBe('verify')
    expect(answer.places.map((p) => p.name)).toEqual(['Hilo, HI', 'Keaau, HI'])
    expect(answer.sources).toEqual([])
  })

  it('researches only the screened subset and attaches cited claims', async () => {
    let researchedPlaces: string[] | undefined
    const provider = createStubProvider({
      async research(req) {
        researchedPlaces = req.places
        return {
          prose: 'Hilo, HI has two elementary schools within the district. A public library branch serves the area.',
          sources: [{ title: 'State school directory', url: 'https://example.org/schools' }],
        }
      },
    })
    const answer = await runAnswerPipeline({
      intent: intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] }),
      rows: ROWS,
      researchQuery: 'places under the rent bound with elementary schools nearby',
      provider,
    })
    expect(answer.status).toBe('verified')
    // Pahoa and Honolulu never reached the research stage.
    expect(researchedPlaces).toEqual(['Hilo, HI', 'Keaau, HI'])
    const hilo = answer.places.find((p) => p.zcta === '96720')
    expect(hilo?.claims).toHaveLength(1)
    expect(hilo?.claims[0]?.sourceUrls).toEqual(['https://example.org/schools'])
    expect(answer.generalClaims).toHaveLength(1)
    expect(answer.sources).toEqual([{ title: 'State school directory', url: 'https://example.org/schools' }])
  })

  it('returns empty, and researches nothing, when no place meets the criteria', async () => {
    let researchCalled = false
    const provider = createStubProvider({
      async research() {
        researchCalled = true
        return { prose: 'x', sources: [{ title: 't', url: 'https://example.org' }] }
      },
    })
    const answer = await runAnswerPipeline({
      intent: intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 900 }] }),
      rows: ROWS,
      researchQuery: 'schools',
      provider,
    })
    expect(answer.status).toBe('empty')
    expect(answer.places).toEqual([])
    expect(researchCalled).toBe(false)
  })

  it('blocks at parse when the intent gate refuses a proxy filter', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ filters: [{ metricKey: 'race_share', op: 'gt', value: 1 }] }),
      rows: ROWS,
    })
    expect(answer.status).toBe('blocked')
    expect(answer.stage).toBe('parse')
    expect(answer.failures[0]).toContain('intent gate')
  })
})

describe('verify: the stage gate fails closed', () => {
  function verifiedAnswer(): ComposedAnswer {
    const screen = screenRows(
      intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] }),
      ROWS,
    )
    return composeAnswer({ intent: intent({}), screen })
  }

  it('passes the composed answer against its screened rows', () => {
    const screen = screenRows(
      intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] }),
      ROWS,
    )
    expect(verifyAnswer(verifiedAnswer(), screen.rows).ok).toBe(true)
  })

  it('fails when a figure on the answer was tampered with', () => {
    const answer = verifiedAnswer()
    const tampered: ComposedAnswer = {
      ...answer,
      places: answer.places.map((p, i) =>
        i === 0 ? { ...p, figures: p.figures.map((f) => ({ ...f, value: f.value + 1 })) } : p,
      ),
    }
    const verdict = verifyAnswer(tampered, ROWS)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]).toContain('figure mismatch')
  })

  it('fails when a margin of error was tampered with', () => {
    const answer = verifiedAnswer()
    const tampered: ComposedAnswer = {
      ...answer,
      places: answer.places.map((p, i) =>
        i === 0 ? { ...p, figures: p.figures.map((f) => ({ ...f, marginOfError: 1 })) } : p,
      ),
    }
    const verdict = verifyAnswer(tampered, ROWS)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]).toContain('margin mismatch')
  })

  it('drops an uncited researched claim at compose and records the drop', () => {
    const screen = screenRows(
      intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] }),
      ROWS,
    )
    const answer = composeAnswer({
      intent: intent({}),
      screen,
      research: {
        prose: '',
        sources: [{ title: 'Directory', url: 'https://example.org/schools' }],
        claims: [
          { text: 'Hilo, HI has an elementary school.', sourceUrls: ['https://example.org/schools'] },
          { text: 'Keaau, HI has a farmers market every week.', sourceUrls: [] },
        ],
      },
    })
    expect(answer.droppedClaims).toEqual([
      { text: 'Keaau, HI has a farmers market every week.', sourceUrls: [] },
    ])
    const allClaims = [...answer.places.flatMap((p) => p.claims), ...answer.generalClaims]
    expect(allClaims.map((c) => c.text)).toEqual(['Hilo, HI has an elementary school.'])
    expect(verifyAnswer(answer, screen.rows).ok).toBe(true)
  })
})

describe('gate rescope: criteria-grounded naming', () => {
  const grounded = { criteriaGrounded: true } as const

  it('passes naming the places that meet the stated criteria, with figures and sources', () => {
    expect(
      findBannedConstruction(
        'Hilo and Keaau meet all of your stated criteria. The cited directory lists two elementary schools in Hilo.',
        grounded,
      ),
    ).toBeNull()
    expect(
      findBannedConstruction(
        'Hilo has good schools, according to the cited state directory.',
        grounded,
      ),
    ).toBeNull()
  })

  it('still withholds protected-class steering and characterisation', () => {
    expect(
      findBannedConstruction('Hilo is a mostly hispanic area, so it may suit you.', grounded),
    ).toBe('proxy characterisation')
    expect(
      findBannedConstruction('Keaau is a christian neighbourhood with churches on every street.', grounded),
    ).toBe('proxy characterisation')
    expect(findBannedConstruction('Stay away from Pahoa.', grounded)).toBe('steering')
  })

  it('still withholds an ungrounded superlative and a personal recommendation', () => {
    expect(findBannedConstruction('Hilo is the best place in Hawaii.', grounded)).toBe('ranking')
    expect(findBannedConstruction('Hilo is the greatest town on the island.', grounded)).toBe('ranking')
    expect(findBannedConstruction('We recommend Hilo for your move.', grounded)).toBe('recommendation')
  })

  it('keeps the strict scan for figure prose: school characterisation and bare ranking still fail there', () => {
    expect(findBannedConstruction('Hilo has good schools.')).toBe('proxy characterisation')
    expect(findBannedConstruction('This is the top area.')).toBe('ranking')
    expect(findBannedConstruction('Hilo is the best place in Hawaii.')).toBe('ranking')
  })
})
