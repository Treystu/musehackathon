import { describe, expect, it } from 'vitest'
import { runAnswerPipeline } from '../../src/core/ai/answer'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import type { AreaRow } from '../../src/core/plugins/acs'
import { composeSpokenSummary } from '../../src/ui/ai/spoken-answer'
import { buildVerifyPacket } from '../../src/core/ai/bookends'

/**
 * P3c pins — SUMMARY-CLAIM ACCOUNTING (rerun-p3b C5, mode
 * summary_meet_claim_with_unmet_decomposed_criterion, measured
 * summary_overclaim 0.92 / honesty 0.14 on the shipped build).
 * One accounting (criterionEvidence) drives both the summary's meet
 * claim and its bookend lists, split by exact status:
 *  - C5 shape: a decomposed criterion at partially_measured (Houston
 *    4,000 of 8,000 households without internet access, 50 percent
 *    against the disclosed quarter-share bar) falls the meet claim
 *    AND is carried by the summary's partial clause — never listed
 *    under "Not measured here", which is exactly the
 *    not_measurable set.
 *  - Fully-met control: every criterion met, including a decomposed
 *    one at measured, KEEPS the shipped meet-all claim (no
 *    over-correction).
 *  - Not-measurable control: a warm-climate criterion still lists
 *    under "Not measured here".
 * The spoken headline and the bookend verify packet serialize
 * answer.summary verbatim (asserted below), so the cure at the
 * compose seam is the cure at those seams too.
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

const C5_QUERY = 'Texas places with home values under $250,000 and good internet access'
const C5_INTENT = intent({
  mode: 'sweep_filter',
  clarificationNeeded: false,
  geographies: ['TX'],
  metricKeys: ['median_home_value'],
  filters: [{ metricKey: 'median_home_value', op: 'lt', value: 250000 }],
})

function texasRow(zcta: string, name: string, noInternet: number, households: number): AreaRow {
  return {
    zcta,
    name,
    metrics: { median_home_value: 210000, no_internet_access: noInternet, households },
    moes: { median_home_value: 9000, no_internet_access: 300, households: 250 },
  }
}

/** The rerun-p3b C5 designed figures, verbatim. */
const C5_ROWS: AreaRow[] = [
  texasRow('79901', 'El Paso, TX', 1500, 9000),
  texasRow('78201', 'San Antonio, TX', 2500, 10000),
  texasRow('77002', 'Houston, TX', 4000, 8000),
]

describe('P3c: summary-claim accounting (C5 shape)', () => {
  it('falls the meet claim and reflects the partial status when a shown place fails a decomposed criterion', async () => {
    const answer = await runAnswerPipeline({
      intent: C5_INTENT,
      rows: C5_ROWS,
      researchQuery: C5_QUERY,
      queryText: C5_QUERY,
    })
    expect(answer.status).toBe('verified')
    const internet = answer.criterionEvidence.find((e) => e.criterion === 'Internet access')
    expect(internet?.status).toBe('partially_measured')
    // No meet claim in either shipped wording.
    expect(answer.summary).not.toContain('meet all of the stated Census criteria')
    expect(answer.summary).not.toContain('meet the stated Census criteria')
    // The partial status is what the summary reflects.
    expect(answer.summary).toContain('Partially measured here: Internet access.')
    // Internet access is NOT listed as not measured, and this shape
    // has no not_measurable criterion at all.
    expect(answer.summary).not.toContain('Not measured here')
  })

  it('keeps the meet-all claim when every criterion is met, including a decomposed one at measured', async () => {
    const answer = await runAnswerPipeline({
      intent: C5_INTENT,
      rows: [
        texasRow('79901', 'El Paso, TX', 1500, 9000),
        texasRow('78201', 'San Antonio, TX', 2000, 10000),
        texasRow('77002', 'Houston, TX', 1000, 8000),
      ],
      researchQuery: C5_QUERY,
      queryText: C5_QUERY,
    })
    expect(answer.status).toBe('verified')
    const internet = answer.criterionEvidence.find((e) => e.criterion === 'Internet access')
    expect(internet?.status).toBe('met')
    expect(answer.summary).toBe(
      'The places named here meet all of the stated Census criteria, with the deciding figures shown from Census data.',
    )
    expect(answer.summary).not.toContain('Partially measured here')
    expect(answer.summary).not.toContain('Not measured here')
  })

  it('still lists a not_measurable criterion under "Not measured here" (warm climate)', async () => {
    const query = 'Warm places with rent under $1,500'
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'sweep_filter',
        clarificationNeeded: false,
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
      }),
      rows: [
        {
          zcta: '85701',
          name: 'Tucson, AZ',
          metrics: { median_gross_rent: 1250 },
          moes: { median_gross_rent: 60 },
        },
      ],
      researchQuery: query,
      queryText: query,
    })
    expect(answer.status).toBe('verified')
    const warm = answer.criterionEvidence.find((e) => e.criterion === 'Warm climate')
    expect(warm?.status).toBe('not_measurable')
    expect(answer.summary).toContain('Not measured here: Warm climate.')
    expect(answer.summary).not.toContain('meet the stated Census criteria')
    expect(answer.summary).not.toContain('Partially measured here')
  })

  it('splits partial and not-measured criteria into their exact clauses in one summary', async () => {
    const query = `${C5_QUERY} and a warm climate`
    const answer = await runAnswerPipeline({
      intent: C5_INTENT,
      rows: C5_ROWS,
      researchQuery: query,
      queryText: query,
    })
    expect(answer.status).toBe('verified')
    expect(answer.summary).toContain('Partially measured here: Internet access.')
    expect(answer.summary).toContain('Not measured here: Warm climate.')
    expect(answer.summary).not.toContain('Not measured here: Internet access')
    expect(answer.summary).not.toContain('Partially measured here: Warm climate')
    expect(answer.summary).not.toContain('meet the stated Census criteria')
  })

  it('the spoken summary and the bookend verify packet serialize the cured claim verbatim', async () => {
    const answer = await runAnswerPipeline({
      intent: C5_INTENT,
      rows: C5_ROWS,
      researchQuery: C5_QUERY,
      queryText: C5_QUERY,
    })
    // Spoken: the headline IS answer.summary (no independent rebuild
    // of the claim in spoken-answer.ts), and the per-criterion
    // sentences read the same criterionEvidence statuses.
    const spoken = composeSpokenSummary(answer)
    expect(spoken[0]).toBe(answer.summary)
    expect(spoken[0]).not.toContain('meet the stated Census criteria')
    expect(spoken).toContain('Internet access: partially measured.')
    // Bookend: the verify packet carries the summary and the
    // evidence labels verbatim (bookends.ts buildVerifyPacket, fed
    // by answer-runner.ts from answer.summary / criterionEvidence).
    const packet = buildVerifyPacket({
      summary: answer.summary,
      places: answer.places.map((p) => ({
        name: p.name,
        figures: p.figures.map((f) => ({ key: f.key, value: f.value })),
      })),
      evidence: answer.criterionEvidence.map((e) => ({
        criterion: e.criterion,
        status: e.status,
        detail: e.detail,
      })),
      sources: [],
      verifySummary: `status ${answer.status}`,
      placeDisplayLimit: 10,
    })
    expect(packet.summary).toBe(answer.summary)
    expect(JSON.stringify(packet)).not.toContain('meet the stated Census criteria')
    expect(JSON.stringify(packet)).toContain('partially_measured')
  })
})
