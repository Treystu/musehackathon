import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { areaRowFromRaw } from '../../src/core/plugins/acs'
import { runAnswerPipeline, type ComposedAnswer } from '../../src/core/ai/answer'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import {
  parseFlexibleDraft,
  verifyFlexibleAnswer,
  type FlexibleAnswer,
} from '../../src/core/ai/flexible'

/**
 * Figure provenance for the 2026-11-03 live specimen (15:23-15:30
 * HST, production d017f10): "Which is cheaper, Hilo or East
 * Honolulu?" showed Hilo home value $499,500 +/-9,848 and East
 * Honolulu $1,246,700 +/-56,000, with rent margins +/-81 and +/-177
 * — a figure set that matches no geography in the Census Bureau's
 * published ACS 2023 5-year tables.
 *
 * Ground truth, read 2026-11-03 from the Bureau's own table-based
 * summary files (acsdt5y2023-b25077.dat / acsdt5y2023-b25064.dat,
 * every summary level): ZCTA 96720 is 458100 +/-12269 and
 * 1346 +/-52; ZCTA 96821 is 1457700 +/-85996 and 2946 +/-338. The
 * specimen's exact pairs (499500+/-9848, 1246700+/-56000,
 * 2946+/-177) appear for NO geography at any summary level in that
 * release, and the two ZCTAs' rows in the 2022 and 2024 5-year
 * releases differ too (2022: 421800/1229, 1310400/2491; 2024:
 * 485400/1428, 1563300/3061). The specimen figures are therefore
 * not Census figures from any vintage this app could serve.
 *
 * These pins hold the provenance contract that makes that
 * conclusion structural rather than anecdotal: every figure on a
 * strict card is copied from the screened ACS row and verified
 * strict-equal (value AND margin) before the card may render, and
 * on the flexible lane a figure may claim Census provenance only
 * under the same strict-equal rule — any other figure renders
 * under a non-Census evidence label.
 */

const HILO: AreaRow = {
  zcta: '96720',
  name: 'Hilo, HI',
  metrics: { median_gross_rent: 1346, median_home_value: 458100 },
  moes: { median_gross_rent: 52, median_home_value: 12269 },
}
const EAST_HONOLULU: AreaRow = {
  zcta: '96821',
  name: 'East Honolulu, HI',
  metrics: { median_gross_rent: 2946, median_home_value: 1457700 },
  moes: { median_gross_rent: 338, median_home_value: 85996 },
}
const HAWAII_KAI_NEIGHBOR: AreaRow = {
  zcta: '96825',
  name: 'Honolulu, HI',
  metrics: { median_gross_rent: 3416, median_home_value: 1067900 },
  moes: { median_gross_rent: 192, median_home_value: 26485 },
}
const ROWS: AreaRow[] = [HILO, EAST_HONOLULU, HAWAII_KAI_NEIGHBOR]

const QUESTION = 'Which is cheaper, Hilo or East Honolulu?'

function figuresByKey(answer: ComposedAnswer, zcta: string) {
  const place = answer.places.find((p) => p.zcta === zcta)
  return new Map((place?.figures ?? []).map((f) => [f.key, f]))
}

/** Every figure on the card equals its screened row's, margin included. */
function expectFiguresCanonical(answer: ComposedAnswer) {
  const rowByZcta = new Map(ROWS.map((r) => [r.zcta, r]))
  for (const place of answer.places) {
    const row = rowByZcta.get(place.zcta)!
    expect(row, `card place ${place.zcta} is a screened row`).toBeDefined()
    for (const figure of place.figures) {
      expect(figure.value).toBe(row.metrics[figure.key])
      expect(figure.marginOfError ?? null).toBe(row.moes[figure.key] ?? null)
    }
  }
}

describe('the published response parses to the published figures', () => {
  it('areaRowFromRaw carries the Bureau values for 96720 and 96821 exactly', () => {
    // The live API response shape: NAME plus the requested
    // variables plus the trailing geography column.
    const header = [
      'NAME',
      'B25064_001E',
      'B25064_001M',
      'B25077_001E',
      'B25077_001M',
      'zip code tabulation area',
    ]
    const rows = areaRowFromRaw(header, [
      ['ZCTA5 96720', '1346', '52', '458100', '12269', '96720'],
      ['ZCTA5 96821', '2946', '338', '1457700', '85996', '96821'],
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]!.metrics).toMatchObject({ median_gross_rent: 1346, median_home_value: 458100 })
    expect(rows[0]!.moes).toMatchObject({ median_gross_rent: 52, median_home_value: 12269 })
    expect(rows[1]!.metrics).toMatchObject({ median_gross_rent: 2946, median_home_value: 1457700 })
    expect(rows[1]!.moes).toMatchObject({ median_gross_rent: 338, median_home_value: 85996 })
  })
})

describe('screen-first compare (the confirmation-run shape)', () => {
  it('both places carry the canonical figures, exactly', async () => {
    const intent: ValidatedIntent = {
      mode: 'compare',
      geographies: ['Hilo, HI', 'East Honolulu, HI'],
      metricKeys: ['median_gross_rent', 'median_home_value'],
      filters: [],
      clarificationNeeded: false,
    }
    const answer = await runAnswerPipeline({
      intent,
      rows: ROWS,
      geographyZctas: new Set(['96720', '96821']),
      queryText: QUESTION,
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.zcta)).toEqual(['96720', '96821'])
    expect(figuresByKey(answer, '96720').get('median_gross_rent')).toMatchObject({
      value: 1346,
      marginOfError: 52,
    })
    expect(figuresByKey(answer, '96720').get('median_home_value')).toMatchObject({
      value: 458100,
      marginOfError: 12269,
    })
    expect(figuresByKey(answer, '96821').get('median_gross_rent')).toMatchObject({
      value: 2946,
      marginOfError: 338,
    })
    expect(figuresByKey(answer, '96821').get('median_home_value')).toMatchObject({
      value: 1457700,
      marginOfError: 85996,
    })
    expectFiguresCanonical(answer)
  })
})

describe('research-first (the specimen shape: research names both places)', () => {
  const prose =
    'Hilo, HI is named in the cited guide as the cheaper of the two towns. ' +
    'East Honolulu, HI is named in the cited guide for its beaches and schools.'

  it('the card figures are the screened rows figures, whatever research returned', async () => {
    const provider = createStubProvider({
      research: async () => ({
        prose,
        sources: [{ title: 'Hawaii towns guide', url: 'https://example.org/hawaii-towns' }],
      }),
    })
    const intent: ValidatedIntent = {
      mode: 'compare',
      geographies: ['Hilo, HI', 'East Honolulu, HI'],
      metricKeys: [],
      filters: [],
      clarificationNeeded: false,
    }
    const answer = await runAnswerPipeline({
      intent,
      rows: ROWS,
      researchQuery: QUESTION,
      researchCriteria: [QUESTION],
      queryText: QUESTION,
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.zcta).sort()).toEqual(['96720', '96821'])
    // Pull mode pulls the headline figure (median gross rent) as
    // display context; it is the row's figure, margin included.
    expect(figuresByKey(answer, '96720').get('median_gross_rent')).toMatchObject({
      value: 1346,
      marginOfError: 52,
    })
    expect(figuresByKey(answer, '96821').get('median_gross_rent')).toMatchObject({
      value: 2946,
      marginOfError: 338,
    })
    expectFiguresCanonical(answer)
  })

  it('a failed lookup beside a naming pass still composes canonical figures', async () => {
    // The specimen's own shape: one research pass did not return
    // ("1 lookup did not return") while another named the places.
    // Named criteria take one pass each (researchPassGroups), so
    // two named criteria from two question segments give two
    // passes; the stub fails the second (the amenities lookup).
    let calls = 0
    const provider = createStubProvider({
      research: async () => {
        calls += 1
        if (calls === 2) throw new Error('provider_down')
        return {
          prose,
          sources: [{ title: 'Hawaii towns guide', url: 'https://example.org/hawaii-towns' }],
        }
      },
    })
    const question = 'Which is cheaper, Hilo or East Honolulu, and which has better schools and nightlife?'
    const intent: ValidatedIntent = {
      mode: 'compare',
      geographies: ['Hilo, HI', 'East Honolulu, HI'],
      metricKeys: [],
      filters: [],
      clarificationNeeded: false,
    }
    const answer = await runAnswerPipeline({
      intent,
      rows: ROWS,
      researchQuery: question,
      researchCriteria: [
        'Which schools serve Hilo and East Honolulu?',
        'What is the nightlife like in Hilo and East Honolulu?',
      ],
      queryText: question,
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.researchFailures ?? []).toEqual(['Amenities'])
    expect(answer.places.map((p) => p.zcta).sort()).toEqual(['96720', '96821'])
    expectFiguresCanonical(answer)
  })
})

describe('the flexible lane and the specimen figure set', () => {
  const context = { rows: ROWS, researchNamedPlaces: ['Hilo, HI', 'East Honolulu, HI'] }
  const specimenDraft = (basis: string): FlexibleAnswer =>
    parseFlexibleDraft({
      prose: 'Hilo is the cheaper of the two on the figures the research states.',
      places: [
        {
          name: 'Hilo, HI',
          basis: 'research',
          figures: [
            { label: 'Median gross rent', value: 1346, unit: '/mo', basis, marginOfError: 81, censusKey: 'median_gross_rent', zcta: '96720' },
            { label: 'Median home value', value: 499500, basis, marginOfError: 9848, censusKey: 'median_home_value', zcta: '96720' },
          ],
        },
        {
          name: 'East Honolulu, HI',
          basis: 'research',
          figures: [
            { label: 'Median gross rent', value: 2946, unit: '/mo', basis, marginOfError: 177, censusKey: 'median_gross_rent', zcta: '96821' },
            { label: 'Median home value', value: 1246700, basis, marginOfError: 56000, censusKey: 'median_home_value', zcta: '96821' },
          ],
        },
      ],
      figures: [],
    })!

  it('the specimen figures are refused as Census figures — value and margin each fail', () => {
    const verdict = verifyFlexibleAnswer(specimenDraft('census'), context)
    expect(verdict.ok).toBe(false)
    // The home values match no screened row...
    expect(verdict.failures.join(' ')).toContain('census figure mismatch')
    // ...and the rent margins fail even where the rent values are
    // the rows' own: 81 is not the published 52, 177 is not 338.
    expect(verdict.failures.join(' ')).toContain('census margin mismatch')
  })

  it('the same figures pass only under a non-Census evidence label', () => {
    expect(verifyFlexibleAnswer(specimenDraft('research'), context).ok).toBe(true)
    expect(verifyFlexibleAnswer(specimenDraft('model'), context).ok).toBe(true)
  })

  it('the canonical figures pass as Census figures, exactly', () => {
    const draft = parseFlexibleDraft({
      prose: 'Hilo is cheaper on both Census measures shown.',
      places: [
        {
          name: 'Hilo, HI',
          basis: 'research',
          figures: [
            { label: 'Median gross rent', value: 1346, unit: '/mo', basis: 'census', marginOfError: 52, censusKey: 'median_gross_rent', zcta: '96720' },
            { label: 'Median home value', value: 458100, basis: 'census', marginOfError: 12269, censusKey: 'median_home_value', zcta: '96720' },
          ],
        },
      ],
      figures: [],
    })!
    expect(verifyFlexibleAnswer(draft, context)).toEqual({ ok: true, failures: [] })
  })
})
