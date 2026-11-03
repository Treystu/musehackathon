import { describe, expect, it } from 'vitest'
import { runAnswerPipeline, type ComposedAnswer } from '../../src/core/ai/answer'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return { mode: 'sweep_filter', geographies: [], metricKeys: [], filters: [], clarificationNeeded: false, ...partial }
}

const Q = 'What town in Arizona has the most retirees?'

function rows(withAgeMoe: boolean): AreaRow[] {
  const mk = (zcta: string, name: string, rent: number, age: number): AreaRow => ({
    zcta, name,
    metrics: { median_gross_rent: rent, median_age: age },
    moes: withAgeMoe ? { median_gross_rent: 60, median_age: 2 } : { median_gross_rent: 60 },
  })
  return [
    mk('86336', 'Sedona, AZ', 1700, 58), mk('85251', 'Scottsdale, AZ', 1800, 47),
    mk('86442', 'Bullhead City, AZ', 900, 55), mk('85003', 'Phoenix, AZ', 1400, 34),
    mk('85701', 'Tucson, AZ', 1100, 38), mk('86301', 'Prescott, AZ', 1400, 56),
  ]
}

async function variant(id: string, partial: Partial<ValidatedIntent>, withAgeMoe: boolean) {
  const answer: ComposedAnswer = await runAnswerPipeline({
    intent: intent(partial), rows: rows(withAgeMoe), researchCriteria: [Q], queryText: Q,
    provider: createStubProvider({}),
  })
  console.log('A9D|' + JSON.stringify({
    id, status: answer.status, stage: answer.stage, failures: answer.failures,
    screened: answer.screenedCount, places: answer.places.map((p) => p.name),
    evidence: answer.criterionEvidence.map((e) => `${e.criterion}=${e.status}`),
    summary: answer.summary.slice(0, 110),
  }))
}

describe('A9 retirees diagnosis', () => {
  it('variants', async () => {
    await variant('age+ageMoe', { geographies: ['AZ'], metricKeys: ['median_age'] }, true)
    await variant('age-noAgeMoe', { geographies: ['AZ'], metricKeys: ['median_age'] }, false)
    await variant('noMetric', { geographies: ['AZ'], metricKeys: [] }, true)
    await variant('rentMetric', { geographies: ['AZ'], metricKeys: ['median_gross_rent'] }, true)
    expect(true).toBe(true)
  })
})
