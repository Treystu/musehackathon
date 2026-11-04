import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { runAnswerPipeline } from '../../src/core/ai/answer'
import {
  degradeDisplayOnlyDemographicIntent,
  validateIntent,
  withRunnability,
} from '../../src/core/ai/intent-schema'
import { researchFirstHandoff } from '../../src/ui/ai/AskPanel'
import { composeSpokenSummary } from '../../src/ui/ai/spoken-answer'

/**
 * Scenario-coverage seat, ROUND 2 battery (2026-11-03, post-FM-9 tree).
 *
 * Fresh cells per the matrix: S4/S7/S9 cross-products on G1/G2, C5
 * shapes under the NEW FM-9 ruling (owner 2026-11-03: median_age
 * rank-legal — pinned in fm9-rank-legal.test.ts; the other demographic
 * figures degrade to research-first), voice-originated terminals for
 * the new FM-9 shapes, and invented criteria round 2 (12 nouns absent
 * from every shipped catalog — absence verified by grep over src/
 * before this file was written: baseball, jazz, beekeep, roller rink,
 * swimming pool, chess, botanical, drive-in, climbing gym, sailing,
 * quilt, railroad — zero hits; round 1's twelve are not repeated).
 */

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: [],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
}

function row(
  zcta: string,
  name: string,
  rent: number,
  extra: Record<string, number | null> = {},
): AreaRow {
  return {
    zcta,
    name,
    metrics: { median_gross_rent: rent, median_home_value: rent * 220, ...extra },
    moes: { median_gross_rent: 60, median_home_value: 9000 },
  }
}

const TX_ROWS: AreaRow[] = [
  row('78701', 'Austin, TX', 1650),
  row('75201', 'Dallas, TX', 1425),
  row('77002', 'Houston, TX', 1280),
  row('79901', 'El Paso, TX', 950),
  row('79401', 'Lubbock, TX', 875),
  row('79843', 'Marfa, TX', 1100),
  row('78624', 'Fredericksburg, TX', 1450),
  row('75657', 'Jefferson, TX', 900),
]

const VT_ROWS: AreaRow[] = [
  row('05401', 'Burlington, VT', 1525),
  row('05602', 'Montpelier, VT', 1275),
  row('05301', 'Brattleboro, VT', 1150),
  row('05701', 'Rutland, VT', 975),
  row('05819', 'St. Johnsbury, VT', 850),
]

const TN_ROWS: AreaRow[] = [
  row('37201', 'Nashville, TN', 1750),
  row('37902', 'Knoxville, TN', 1250),
  row('37402', 'Chattanooga, TN', 1150),
  row('37064', 'Franklin, TN', 1950),
]

function proseProvider(prose: string, calls?: { n: number }) {
  return createStubProvider({
    async research() {
      if (calls) calls.n += 1
      return { prose, sources: [{ title: 'Findings', url: 'https://example.org/f' }] }
    },
  })
}

describe('R2 cross-products: S4 multi-place comparison', () => {
  it('C1 x S4 x G1: a three-place rent comparison cards all three with their figures', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'compare',
        geographies: ['Austin, TX', 'Dallas, TX', 'Houston, TX'],
        metricKeys: ['median_gross_rent'],
      }),
      rows: TX_ROWS.slice(0, 3),
      queryText: 'Compare rent in Austin, Dallas, and Houston.',
      provider: createStubProvider({}),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toEqual(['Austin, TX', 'Dallas, TX', 'Houston, TX'])
    for (const place of answer.places) {
      const figure = place.figures.find((f) => f.key === 'median_gross_rent')
      const source = TX_ROWS.find((r) => r.zcta === place.zcta)!
      expect(figure?.value).toBe(source.metrics.median_gross_rent)
    }
  })

  it('C3 x S4 x G1: a researched superlative over three named places cards the supported winner', async () => {
    const q = 'Which of Austin, Dallas, or Houston has the best food scene?'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['TX'] }),
      rows: TX_ROWS,
      researchQuery: q,
      queryText: q,
      provider: proseProvider(
        'Houston, TX is described as having the most celebrated food scene of the three, with the most diverse restaurant landscape in Texas. ' +
          'Dallas, TX has a strong food scene with many acclaimed restaurants. ' +
          'Austin, TX has a celebrated food truck and barbecue scene. ' +
          'Answer: Houston, TX has the strongest support for the most celebrated food scene.',
      ),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places[0]?.name).toBe('Houston, TX')
    expect(answer.places[0]?.claims.length).toBeGreaterThan(0)
    for (const criterion of answer.researchCriteria) {
      const lines = answer.criterionEvidence.filter((e) => e.criterion === criterion.label)
      expect(lines).toHaveLength(1)
    }
  })
})

describe('R2 cross-products: S7 ranked / top-N', () => {
  it('C2 x S7 x G2: the three cheapest Vermont rents lead the card in ascending order', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['VT'], metricKeys: ['median_gross_rent'] }),
      rows: VT_ROWS,
      queryText: 'What are the three cheapest places to rent in Vermont?',
      provider: createStubProvider({}),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.slice(0, 3).map((p) => p.name)).toEqual([
      'St. Johnsbury, VT',
      'Rutland, VT',
      'Brattleboro, VT',
    ])
  })

  it('C3 x S7 x G1: a top-three researched ranking keeps the prose order', async () => {
    const q = 'What are the top three most charming towns in Texas?'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['TX'] }),
      rows: TX_ROWS,
      researchQuery: q,
      queryText: q,
      provider: proseProvider(
        'Marfa, TX is described as the most charming town in Texas, an arts outpost with a beloved main street. ' +
          'Fredericksburg, TX is described as very charming, with German heritage storefronts and wineries. ' +
          'Jefferson, TX is described as charming, a preserved riverport town with brick streets. ' +
          'Answer: Marfa, TX has the strongest support as the most charming town in Texas.',
      ),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toEqual([
      'Marfa, TX',
      'Fredericksburg, TX',
      'Jefferson, TX',
    ])
  })
})

describe('R2 cross-products: S9 multi-criteria AND', () => {
  it('C4 x S9 x G1: a rent bound AND a researched criterion are both served (Texas hiking)', async () => {
    const q = 'Where in Texas can I rent under $1,300 and find great hiking?'
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['TX'],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1300 }],
      }),
      rows: TX_ROWS,
      researchQuery: q,
      queryText: q,
      provider: proseProvider(
        'El Paso, TX has great hiking, with desert mountain trails inside the city. ' +
          'Lubbock, TX has some hiking in its canyon parks. ' +
          'Answer: El Paso, TX has the strongest support for great hiking.',
      ),
    })
    expect(answer.status).toBe('verified')
    // The screen bound held: no place at or above $1,300 appears.
    for (const place of answer.places) {
      const rent = place.figures.find((f) => f.key === 'median_gross_rent')
      expect(rent?.value).toBeLessThan(1300)
    }
    expect(answer.places.map((p) => p.name)).toContain('El Paso, TX')
    // Both criteria accounted: the Census bound and the researched one.
    expect(answer.criterionEvidence.length).toBeGreaterThanOrEqual(2)
    expect(answer.criterionEvidence.some((e) => e.status === 'met')).toBe(true)
  })

  it('C4 x S9 x G2: a rent bound AND good schools are both served (Vermont)', async () => {
    const q = 'Where in Vermont is rent under $1,200 with good schools?'
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['VT'],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1200 }],
      }),
      rows: VT_ROWS,
      researchQuery: q,
      queryText: q,
      provider: proseProvider(
        'Brattleboro, VT has good schools, with well-regarded public schools for its size. ' +
          'Rutland, VT has decent schools with strong community ratings. ' +
          'Answer: Brattleboro, VT has the strongest support for good schools.',
      ),
    })
    expect(answer.status).toBe('verified')
    for (const place of answer.places) {
      const rent = place.figures.find((f) => f.key === 'median_gross_rent')
      expect(rent?.value).toBeLessThan(1200)
    }
    expect(answer.places.map((p) => p.name)).toContain('Brattleboro, VT')
    expect(answer.criterionEvidence.length).toBeGreaterThanOrEqual(2)
  })

  it('C6 x S9 x G1: the demo shape — best schools AND fewest fast food (Tennessee)', async () => {
    const q = 'Where in Tennessee has the best schools but also the fewest fast food restaurants?'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['TN'] }),
      rows: TN_ROWS,
      researchQuery: q,
      queryText: q,
      provider: proseProvider(
        'Franklin, TN has the best schools in Tennessee in recent ratings, with top-ranked public schools. ' +
          'Franklin, TN also has few fast food restaurants relative to its size. ' +
          'Knoxville, TN has good schools and a moderate number of fast food restaurants. ' +
          'Answer: Franklin, TN has the strongest support for the best schools and the fewest fast food restaurants.',
      ),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places[0]?.name).toBe('Franklin, TN')
    // Every parsed criterion accounted exactly once — the negated
    // criterion is served, never silently dropped.
    expect(answer.researchCriteria.length).toBeGreaterThanOrEqual(2)
    for (const criterion of answer.researchCriteria) {
      const lines = answer.criterionEvidence.filter((e) => e.criterion === criterion.label)
      expect(lines, `criterion "${criterion.label}"`).toHaveLength(1)
    }
  })
})

describe('R2: C5 shapes under the new FM-9 ruling (degrade -> research-first)', () => {
  async function degradedHandoff(
    geographies: string[],
    metricKey: string,
    query: string,
  ): Promise<ValidatedIntent> {
    const degraded = degradeDisplayOnlyDemographicIntent({
      mode: 'sweep_filter',
      geographies,
      metricKeys: [metricKey],
      filters: [],
      clarificationNeeded: false,
    })
    expect(degraded).not.toBeNull()
    const check = validateIntent(degraded)
    expect(check.ok).toBe(true)
    if (!check.ok) throw new Error('degraded intent must validate')
    const handedOff = researchFirstHandoff(withRunnability(check.intent), query)
    expect(handedOff).not.toBeNull()
    return handedOff!
  }

  it('attainment x G2: a college-graduates superlative cards research-first (Vermont)', async () => {
    const q = 'Which Vermont town has the most college graduates?'
    const handedOff = await degradedHandoff(['VT'], 'bachelors_count', q)
    const rows = VT_ROWS.map((r) =>
      r.name === 'Rutland, VT'
        ? { ...r, metrics: { ...r.metrics, bachelors_count: 9000 }, moes: { ...r.moes, bachelors_count: 500 } }
        : { ...r, metrics: { ...r.metrics, bachelors_count: 3000 }, moes: { ...r.moes, bachelors_count: 300 } },
    )
    const answer = await runAnswerPipeline({
      intent: { ...handedOff, clarificationNeeded: false },
      rows,
      researchQuery: q,
      queryText: q,
      provider: proseProvider(
        'Montpelier, VT has the most college graduates per capita of any Vermont town, a state-capital workforce. ' +
          'Burlington, VT also has many college graduates. ' +
          'Answer: Montpelier, VT has the strongest support for the most college graduates.',
      ),
    })
    expect(answer.status).toBe('verified')
    // Claim order leads with Montpelier even though Rutland carries
    // the largest raw bachelors_count in the fixture: the figure
    // never ranks.
    expect(answer.places[0]?.name).toBe('Montpelier, VT')
  })

  it('broadband x G1: a worst-internet superlative terminates as a figure-assessed card (Texas)', async () => {
    // Broadband is the one ruled figure whose criterion DECOMPOSES
    // onto the figure (the catalog's internet entry, P3 step 3,
    // reaffirmed by the Colorado intersection cure): the terminal is
    // a verified screen card that assesses the criterion from the
    // shown figures — never a refusal, never a research ranking.
    // The FM-9 degrade still applies at the panel seam (this flow):
    // a parse retaining the key no longer refuses whole. Recorded in
    // RESULTS-ROUND2 as the observed exception among the four: if
    // broadband is to behave exactly like poverty/attainment/
    // crowding, the change is removing that entry's
    // decomposedMetricKey, with the p3 C5 pin and the Colorado
    // intersection arm in its blast radius — an owner/gate call, not
    // a silent rewrite.
    const q = 'Which Texas town has the worst internet access?'
    const handedOff = await degradedHandoff(['TX'], 'no_internet_access', q)
    const rows: AreaRow[] = [
      { zcta: '78701', name: 'Austin, TX', metrics: { median_gross_rent: 1650, no_internet_access: 9000, households: 400000 }, moes: { median_gross_rent: 60, no_internet_access: 800 } },
      { zcta: '79843', name: 'Marfa, TX', metrics: { median_gross_rent: 1100, no_internet_access: 2100, households: 2400 }, moes: { median_gross_rent: 60, no_internet_access: 300 } },
      { zcta: '75657', name: 'Jefferson, TX', metrics: { median_gross_rent: 900, no_internet_access: 1600, households: 2100 }, moes: { median_gross_rent: 60, no_internet_access: 260 } },
    ]
    const answer = await runAnswerPipeline({
      intent: { ...handedOff, clarificationNeeded: false },
      rows,
      researchQuery: q,
      queryText: q,
      provider: proseProvider(
        'Marfa, TX is described as having the poorest internet access of these Texas towns, with limited broadband options in a remote area. ' +
          'Jefferson, TX also has limited internet access. ' +
          'Answer: Marfa, TX has the strongest support for the poorest internet access.',
      ),
    })
    expect(answer.status).toBe('verified')
    // The criterion is accounted exactly once, from the figures.
    const internetLines = answer.criterionEvidence.filter((e) => e.criterion === 'Internet access')
    expect(internetLines).toHaveLength(1)
    expect(internetLines[0]?.kind).toBe('census')
    // Every place carries its published figure, copied strict.
    for (const place of answer.places) {
      const figure = place.figures.find((f) => f.key === 'no_internet_access')
      const source = rows.find((r) => r.zcta === place.zcta)!
      expect(figure?.value).toBe(source.metrics.no_internet_access)
    }
  })

  it('crowding x G1: a most-crowded-housing superlative cards research-first (Arizona)', async () => {
    const q = 'Which Arizona town has the most crowded housing?'
    const handedOff = await degradedHandoff(['AZ'], 'average_household_size', q)
    const azRows: AreaRow[] = [
      row('85003', 'Phoenix, AZ', 1400),
      row('85701', 'Tucson, AZ', 1100),
      row('86336', 'Sedona, AZ', 1700),
    ]
    const answer = await runAnswerPipeline({
      intent: { ...handedOff, clarificationNeeded: false },
      rows: azRows,
      researchQuery: q,
      queryText: q,
      provider: proseProvider(
        'Phoenix, AZ has the most crowded housing of these Arizona towns in recent housing surveys. ' +
          'Tucson, AZ has less crowded housing than Phoenix. ' +
          'Answer: Phoenix, AZ has the strongest support for the most crowded housing.',
      ),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places[0]?.name).toBe('Phoenix, AZ')
  })
})

describe('R2: voice-originated terminals for the FM-9 shapes', () => {
  it('the age-ranked card speaks: headline place, spoken figures, no raw keys or URLs', async () => {
    const azRows: AreaRow[] = [
      { zcta: '86336', name: 'Sedona, AZ', metrics: { median_gross_rent: 1700, median_age: 58 }, moes: { median_gross_rent: 60, median_age: 2 } },
      { zcta: '85003', name: 'Phoenix, AZ', metrics: { median_gross_rent: 1400, median_age: 34 }, moes: { median_gross_rent: 60, median_age: 2 } },
    ]
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['AZ'], metricKeys: ['median_age'] }),
      rows: azRows,
      queryText: 'Which town in Arizona has the highest median age?',
      provider: createStubProvider({}),
    })
    expect(answer.status).toBe('verified')
    const spoken = composeSpokenSummary(answer)
    expect(spoken.length).toBeGreaterThan(0)
    expect(spoken.length).toBeLessThanOrEqual(6)
    const text = spoken.join(' ')
    expect(text).not.toContain('median_age')
    expect(text).not.toContain('http')
    // The spoken contract for a measure-only screen card (A8): the
    // headline plus a chart-reference sentence naming the measure in
    // plain words — no per-place spoken ranking exists for this
    // class, and none is invented here.
    expect(text).toContain('median age')
  })

  it('the research-first poverty card speaks its leading place without the display-only key', async () => {
    const q = 'Which town in Arizona has the most people in poverty?'
    const degraded = degradeDisplayOnlyDemographicIntent({
      mode: 'sweep_filter',
      geographies: ['AZ'],
      metricKeys: ['below_poverty_count'],
      filters: [],
      clarificationNeeded: false,
    })
    const check = validateIntent(degraded)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    const handedOff = researchFirstHandoff(withRunnability(check.intent), q)
    expect(handedOff).not.toBeNull()
    const azRows: AreaRow[] = [
      row('85003', 'Phoenix, AZ', 1400, { below_poverty_count: 90000 }),
      row('85701', 'Tucson, AZ', 1100, { below_poverty_count: 60000 }),
    ]
    const answer = await runAnswerPipeline({
      intent: { ...handedOff!, clarificationNeeded: false },
      rows: azRows,
      researchQuery: q,
      queryText: q,
      provider: proseProvider(
        'Phoenix, AZ has the most people in poverty of any Arizona town in recent counts. ' +
          'Answer: Phoenix, AZ has the strongest support for the most people in poverty.',
      ),
    })
    expect(answer.status).toBe('verified')
    const spoken = composeSpokenSummary(answer)
    expect(spoken.length).toBeGreaterThan(0)
    const text = spoken.join(' ')
    expect(text).toContain('Phoenix')
    expect(text).not.toContain('below_poverty_count')
    expect(text).not.toContain('http')
  })
})
