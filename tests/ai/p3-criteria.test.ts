import { describe, expect, it } from 'vitest'
import {
  completeParsedBoundedScreen,
  normalizeRescueText,
  rescueNationalScreen,
  superlativeMeasure,
} from '../../src/core/ai/national-screen'
import { canRun } from '../../src/core/ai/intent-schema'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import { createStubProvider } from '../../src/core/ai/provider'
import {
  claimBannedLabel,
  decomposeResearchCriteria,
  filterBannedSentences,
  runAnswerPipeline,
} from '../../src/core/ai/answer'
import { needsResearch, politicsCoverageNote, researchFirstHandoff, isResearchFirstHandoff } from '../../src/ui/ai/AskPanel'
import type { AreaRow } from '../../src/core/plugins/acs'

/**
 * P3 pins (recompiled plan phase P3, battery register 2026-11-02):
 * one battery-shaped test per cure — F-A named sentences + garbles,
 * A3 mixed shape, safest, internet decomposition, D6 Spanish, E4
 * news, D7 direction-of-fit, D2 farmers markets, A2 cost of living,
 * A4 salary accounting, A1 summary rule, claim-level refusal.
 */

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

const AK_ROWS: AreaRow[] = [
  { zcta: '99801', name: 'Juneau, AK', metrics: { median_gross_rent: 1450 }, moes: { median_gross_rent: 90 } },
  { zcta: '99501', name: 'Anchorage, AK', metrics: { median_gross_rent: 1250 }, moes: { median_gross_rent: 70 } },
  { zcta: '99701', name: 'Fairbanks, AK', metrics: { median_gross_rent: 1350 }, moes: { median_gross_rent: 80 } },
]

describe('F-A: cost-effective lexicon gap', () => {
  it.each([
    ['Alaska', 'AK'],
    ['Oregon', 'OR'],
    ['Maine', 'ME'],
  ])('rescues the typed %s sentence into a bounded screen card', async (state, code) => {
    const parsed = intent({ mode: 'sweep_filter', geographies: [code] })
    const rescued = rescueNationalScreen(parsed, `What is the most cost effective place in ${state}?`)
    expect(rescued?.geographies).toEqual([code])
    expect(rescued?.metricKeys).toEqual(['median_gross_rent'])
    expect(rescued && canRun(rescued)).toBe(true)
    if (code === 'AK' && rescued) {
      const answer = await runAnswerPipeline({ intent: rescued, rows: AK_ROWS })
      expect(answer.status).toBe('verified')
      // Bounded screen sorts by its measure, lowest first.
      expect(answer.places.map((p) => p.name)).toEqual(['Anchorage, AK', 'Fairbanks, AK', 'Juneau, AK'])
    }
  })

  it('tolerates ASR garbles: doubled and dropped words in the rescue matching', () => {
    const parsed = intent({ mode: 'sweep_filter', geographies: ['AK'] })
    // Doubled frame words (the owner's live transcript shape).
    expect(
      rescueNationalScreen(parsed, 'What is the most the most cost effective place in Alaska')?.metricKeys,
    ).toEqual(['median_gross_rent'])
    // Doubled content word.
    expect(
      rescueNationalScreen(parsed, 'most cost effective place place in Alaska')?.metricKeys,
    ).toEqual(['median_gross_rent'])
    // Dropped "most": the cost-effective phrase itself carries the reading.
    expect(rescueNationalScreen(parsed, 'cost effective place in Alaska')?.metricKeys).toEqual([
      'median_gross_rent',
    ])
    // Dropped "cost": "most effective" plus a generic living place.
    expect(superlativeMeasure('What is the most effective place to live in Alaska?')).toBe(
      'median_gross_rent',
    )
    expect(normalizeRescueText('the most the most cost-effective')).toBe('the most cost effective')
  })

  it('uses a retained measure in the rescue instead of refusing it', () => {
    const parsed = intent({
      mode: 'sweep_filter',
      geographies: ['TX'],
      metricKeys: ['median_home_value'],
    })
    const rescued = rescueNationalScreen(parsed, 'cheapest homes in Texas')
    expect(rescued?.metricKeys).toEqual(['median_home_value'])
    expect(rescued?.geographies).toEqual(['TX'])
  })
})

describe('lexical patterns: superlative and plural forms', () => {
  it('fires research for "safest" and decomposes it to the safety criterion', () => {
    expect(needsResearch('safest neighborhoods in Chicago with rent under $1,500')).toBe(true)
    expect(decomposeResearchCriteria('safest neighborhoods in Chicago').map((c) => c.id)).toContain('safety')
  })

  it('matches plural hospitals and Republicans in every trigger', () => {
    expect(needsResearch('towns with good hospitals nearby')).toBe(true)
    expect(needsResearch('places with no Republicans')).toBe(true)
    expect(politicsCoverageNote('I want somewhere with no Republicans')).not.toBe('')
    expect(politicsCoverageNote('areas with fewer Democrats')).not.toBe('')
    expect(decomposeResearchCriteria('retiring near hospitals').map((c) => c.id)).toContain('amenities')
  })

  it('gives farmers markets a research slot instead of dropping it (D2)', () => {
    expect(needsResearch('places near Portland with farmers markets and rent under $1,600')).toBe(true)
    expect(
      decomposeResearchCriteria('places near Portland with farmers markets').map((c) => c.id),
    ).toContain('farmers_markets')
  })
})

describe('A3 mixed shape end-to-end', () => {
  const query = 'Where should I retire that is warm and has affordable homes and good hospitals?'

  it('hands off despite the retained measure, and the pipeline ships the partial answer', async () => {
    const parsed = intent({ metricKeys: ['median_home_value'] })
    const handedOff = researchFirstHandoff(parsed, query)
    expect(handedOff).not.toBeNull()
    expect(handedOff?.metricKeys).toEqual(['median_home_value'])
    expect(isResearchFirstHandoff(handedOff!)).toBe(true)

    const provider = createStubProvider({
      async research() {
        return {
          prose: 'Hilo, HI has a hospital with an emergency department. Hilo, HI has warm weather year round.',
          sources: [{ title: 'Hospital directory', url: 'https://example.org/hospital' }],
        }
      },
    })
    const answer = await runAnswerPipeline({
      intent: { ...handedOff!, mode: 'sweep_filter', clarificationNeeded: false },
      rows: [
        {
          zcta: '96720',
          name: 'Hilo, HI',
          metrics: { median_home_value: 340000, median_gross_rent: 1450 },
          moes: { median_home_value: 15000, median_gross_rent: 85 },
        },
      ],
      researchQuery: query,
      queryText: query,
      provider,
    })
    expect(answer.status).toBe('verified')
    // The retained measure is USED: its figure is on the place.
    expect(answer.places[0]?.figures.some((f) => f.key === 'median_home_value')).toBe(true)
    // Both external criteria are accounted, not dropped.
    const labels = answer.criterionEvidence.map((e) => e.criterion)
    expect(labels).toContain('Amenities')
    expect(labels).toContain('Warm climate')
  })
})

describe('criterion-slot accounting', () => {
  it('decomposes "good internet access" onto no_internet_access and assesses it on the card (C5)', async () => {
    const query = 'Texas places with home values under $250,000 and good internet access'
    const criteria = decomposeResearchCriteria(query)
    expect(criteria.find((c) => c.id === 'internet')?.decomposedMetricKey).toBe('no_internet_access')
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'sweep_filter',
        clarificationNeeded: false,
        metricKeys: ['median_home_value'],
        filters: [{ metricKey: 'median_home_value', op: 'lt', value: 250000 }],
      }),
      rows: [
        {
          zcta: '77002',
          name: 'Houston, TX',
          metrics: { median_home_value: 210000, no_internet_access: 4000 },
          moes: { median_home_value: 9000, no_internet_access: 300 },
        },
      ],
      researchQuery: query,
      queryText: query,
    })
    expect(answer.status).toBe('verified')
    expect(answer.places[0]?.figures.some((f) => f.key === 'no_internet_access')).toBe(true)
    const internet = answer.criterionEvidence.find((e) => e.criterion === 'Internet access')
    expect(internet?.kind).toBe('census')
    expect(internet?.status).toBe('met')
    expect(internet?.detail).toContain('no internet access')
  })

  it('records "lower cost of living" as a decomposed Census criterion (A2)', async () => {
    const query = 'Family-friendly areas near Austin with good schools and lower cost of living'
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'sweep_filter',
        clarificationNeeded: false,
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 2000 }],
      }),
      rows: [
        {
          zcta: '73301',
          name: 'Austin, TX',
          metrics: { median_gross_rent: 1800 },
          moes: { median_gross_rent: 110 },
        },
      ],
      researchQuery: query,
      queryText: query,
    })
    const col = answer.criterionEvidence.find((e) => e.criterion === 'Cost of living')
    expect(col?.kind).toBe('census')
    expect(col?.status).toBe('met')
  })

  it('names a stated salary as not_measurable instead of dropping it (A4)', async () => {
    const query = 'Where in Colorado can I live well on a $70,000 salary?'
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'sweep_filter',
        clarificationNeeded: false,
        geographies: ['CO'],
        metricKeys: ['median_gross_rent'],
      }),
      rows: [
        {
          zcta: '80201',
          name: 'Denver, CO',
          metrics: { median_gross_rent: 1700 },
          moes: { median_gross_rent: 95 },
        },
      ],
      researchQuery: query,
      queryText: query,
    })
    const salary = answer.criterionEvidence.find(
      (e) => e.criterion === 'Affordability on the stated income',
    )
    expect(salary?.status).toBe('not_measurable')
    expect(answer.summary).not.toContain('meet all of the stated Census criteria')
  })

  it('withholds the "meet all" summary when no Census criterion was stated (A1)', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ mode: 'lookup', clarificationNeeded: false, geographies: ['96720'], metricKeys: ['median_gross_rent'] }),
      rows: AK_ROWS.map((r) => ({ ...r, zcta: '96720', name: 'Hilo, HI' })).slice(0, 1),
    })
    expect(answer.summary).not.toContain('meet all of the stated Census criteria')
  })

  it('labels mention-only safety evidence partially measured, with the reason (D7)', async () => {
    const query = 'Bay Area places with low crime and good transit'
    const provider = createStubProvider({
      async research() {
        return {
          prose: 'Crime statistics for the area are published and summarised annually by the city.',
          sources: [{ title: 'City open data', url: 'https://example.org/data' }],
        }
      },
    })
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'sweep_filter',
        clarificationNeeded: false,
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 3000 }],
      }),
      rows: [
        {
          zcta: '94110',
          name: 'San Francisco, CA',
          metrics: { median_gross_rent: 2400 },
          moes: { median_gross_rent: 200 },
        },
      ],
      researchQuery: query,
      queryText: query,
      provider,
    })
    const safety = answer.criterionEvidence.find((e) => e.criterion === 'Safety')
    expect(safety?.status).toBe('partially_measured')
    expect(safety?.detail).toContain('does not show crime is low')
    expect(answer.summary).toContain('Not measured here')
  })
})

describe('D6: non-English servability', () => {
  it('completes a parsed bounded sweep regardless of the question language', async () => {
    // The D6 control shape: the same question with a fully parsed
    // intent serves. The completion reads the parse, not the words.
    const parsed = intent({ mode: 'sweep_filter', geographies: ['CA'] })
    const completed = completeParsedBoundedScreen(parsed)
    expect(completed?.metricKeys).toEqual(['median_gross_rent'])
    expect(completed && canRun(completed)).toBe(true)
    const answer = await runAnswerPipeline({
      intent: completed!,
      rows: [
        { zcta: '93301', name: 'Bakersfield, CA', metrics: { median_gross_rent: 1150 }, moes: { median_gross_rent: 60 } },
        { zcta: '94110', name: 'San Francisco, CA', metrics: { median_gross_rent: 2400 }, moes: { median_gross_rent: 200 } },
      ],
    })
    expect(answer.status).toBe('verified')
    expect(answer.places[0]?.name).toBe('Bakersfield, CA')
  })

  it('also rescues the Spanish words directly when the parse clarifies as a lookup', () => {
    expect(superlativeMeasure('¿Cuál es el lugar más barato para vivir en California?')).toBe(
      'median_gross_rent',
    )
    const rescued = rescueNationalScreen(
      intent({ geographies: ['California'] }),
      '¿Cuál es el lugar más barato para vivir en California?',
    )
    expect(rescued?.geographies).toEqual(['California'])
  })

  it('never completes a bare ambiguous place name or a lookup parse', () => {
    expect(
      completeParsedBoundedScreen(intent({ mode: 'sweep_filter', geographies: ['Springfield'] })),
    ).toBeNull()
    expect(completeParsedBoundedScreen(intent({ mode: 'lookup', geographies: ['CA'] }))).toBeNull()
  })
})

describe('E4: current-events arm', () => {
  it('routes news phrasing to research with a current-events criterion', () => {
    const query = 'What is the latest US housing news this week?'
    expect(needsResearch(query)).toBe(true)
    expect(decomposeResearchCriteria(query).map((c) => c.id)).toContain('current_events')
  })
})

describe('claim-level prose refusal (step 9)', () => {
  it('passes the non-ranking "worst of the peak" idiom', () => {
    expect(claimBannedLabel('Drivers can avoid the worst of the Highway 17 peak by leaving early.')).toBeNull()
    expect(claimBannedLabel('Hilo is the worst place in Hawaii.')).toBe('ranking')
  })

  it('drops only the offending sentence from a research result', () => {
    const filtered = filterBannedSentences(
      'Hilo, HI has a hospital with an emergency department. Hilo is the best place in Hawaii. The library branch opens daily.',
    )
    expect(filtered.dropped).toEqual(['Hilo is the best place in Hawaii.'])
    expect(filtered.prose).toContain('hospital')
    expect(filtered.prose).toContain('library')
  })

  it('keeps a cited Highway 17 claim on the answer instead of withholding it whole', async () => {
    const provider = createStubProvider({
      async research() {
        return {
          prose: 'Hilo, HI lets drivers avoid the worst of the Highway 17 peak by leaving before the rush.',
          sources: [{ title: 'Commute guide', url: 'https://example.org/commute' }],
        }
      },
    })
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'sweep_filter',
        clarificationNeeded: false,
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
      }),
      rows: [
        {
          zcta: '96720',
          name: 'Hilo, HI',
          metrics: { median_gross_rent: 1450 },
          moes: { median_gross_rent: 85 },
        },
      ],
      researchQuery: 'commute over Highway 17',
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.places[0]?.claims[0]?.text).toContain('worst of the Highway 17 peak')
  })
})
