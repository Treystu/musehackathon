import { describe, expect, it } from 'vitest'
import {
  DISCLOSURE_TEXT,
  createValidator,
  hermeticStubValidator,
  intentGate,
  realValidator,
  type FigureForValidation,
  type ValidatorVerdict,
} from '../../src/core/ai/validator'

const v = createValidator()

function failure(r: ValidatorVerdict) {
  return r.pass ? null : r.failure
}

// Canned fixture sentences only. No live model, no keys.
describe('exports and back-compat', () => {
  it('keeps disclosure text and the stub contract', () => {
    expect(DISCLOSURE_TEXT).toContain("Figures are CivicScope's")
    expect(hermeticStubValidator.validate('', []).pass).toBe(true)
    expect(hermeticStubValidator.validate('rent is 1200', []).pass).toBe(false)
    expect(realValidator.validate('', []).pass).toBe(true)
  })
  it('passes empty and numeral-free prose', () => {
    expect(v.validate('Rent burden is shown in the figure.', []).pass).toBe(true)
  })
})

describe('intentGate (step 0)', () => {
  it('passes filter-legal sweep_filter and similarity intents', () => {
    expect(intentGate({ mode: 'sweep_filter', metricKeys: ['median_gross_rent'], filters: [{ metricKey: 'median_gross_rent', op: 'gt', value: 1000 }] }).pass).toBe(true)
    expect(intentGate({ mode: 'similarity', metricKeys: ['median_household_income'] }).pass).toBe(true)
    expect(intentGate({ mode: 'lookup', metricKeys: ['median_age'] }).pass).toBe(true)
  })
  it('rejects proxy/school/health keys in filters', () => {
    expect(failure(intentGate({ mode: 'sweep_filter', filters: [{ metricKey: 'bachelors_count', op: 'gt', value: 1 }] }))).toBe('intent_gate')
    expect(failure(intentGate({ mode: 'lookup', filters: [{ metricKey: 'asthma_rate', op: 'gt', value: 1 }] }))).toBe('intent_gate')
    expect(failure(intentGate({ mode: 'sweep_filter', filters: [{ metricKey: 'race_share', op: 'gt', value: 1 }] }))).toBe('intent_gate')
  })
  it('rejects school/health keys in sort, similarity and composite intents', () => {
    expect(failure(intentGate({ mode: 'lookup', sortBy: 'school_score' }))).toBe('intent_gate')
    expect(failure(intentGate({ mode: 'similarity', metricKeys: ['median_age'] }))).toBe('intent_gate')
    expect(failure(intentGate({ mode: 'composite', metricKeys: ['asthma_rate'] }))).toBe('intent_gate')
    expect(failure(intentGate({ mode: 'composite', composite: { metricKeys: ['median_rent_burden_pct', 'school_score'] } }))).toBe('intent_gate')
  })
  it('rejects non-object intents fail-closed', () => {
    expect(failure(intentGate(null))).toBe('intent_gate')
    expect(failure(intentGate('sweep_filter'))).toBe('intent_gate')
  })
})

describe('numeral scan and provenance (steps 1-3)', () => {
  const rent: FigureForValidation[] = [{ key: 'median_gross_rent', value: 1200 }]
  it('passes digit, comma and decimal numerals within rounding', () => {
    expect(v.validate('The median gross rent is 1200.', rent).pass).toBe(true)
    expect(v.validate('The median gross rent is 1,200.', rent).pass).toBe(true)
    expect(v.validate('The burden is 33.3 percent.', [{ key: 'median_rent_burden_pct', value: 33.3 }]).pass).toBe(true)
    expect(v.validate('The rent is 1,250.', [{ key: 'median_gross_rent', value: 1249.6 }]).pass).toBe(true)
  })
  it('rejects numerals not supplied, including outside rounding', () => {
    expect(failure(v.validate('The median gross rent is 1300.', rent))).toBe('invented_numeral')
    expect(failure(v.validate('The median gross rent is 1200.', []))).toBe('invented_numeral')
  })
  it('catches word-form numerals (closed table)', () => {
    expect(failure(v.validate('There are twelve renter households.', [{ key: 'renter_occupied', value: 150 }]))).toBe('invented_numeral')
    expect(failure(v.validate('The share is thirty percent.', [{ key: 'median_rent_burden_pct', value: 33.3 }]))).toBe('invented_numeral')
  })
  it('passes word-form numerals that match a supplied figure', () => {
    expect(v.validate('The renter share is forty-two percent.', [{ key: 'derived:renter_pct', value: 42 }]).pass).toBe(true)
    expect(v.validate('The renter share is thirty percent.', [{ key: 'derived:renter_pct', value: 30 }]).pass).toBe(true)
  })
  it('allows citing a supplied margin of error', () => {
    expect(v.validate('The rent is 1200, plus or minus 50.', [{ key: 'median_gross_rent', value: 1200, marginOfError: 50 }]).pass).toBe(true)
  })
  it('does not compute derived percentages from counts itself', () => {
    const counts: FigureForValidation[] = [
      { key: 'renter_occupied', value: 420 },
      { key: 'households', value: 1000 },
    ]
    expect(failure(v.validate('The renter share is 42 percent.', counts))).toBe('invented_numeral')
  })
})

describe('C05 asthma wide-CI hedge', () => {
  const figs: FigureForValidation[] = [
    { key: 'asthma_rate', value: 34, marginOfError: 20 },
    { key: 'asthma_rate_other', value: 28, marginOfError: 15 },
  ]
  it('PASS: hedged wording about a wide-CI estimate', () => {
    expect(v.validate('The estimated rate is about 34, but the margin of error is wide, so the true rate could differ substantially.', figs).pass).toBe(true)
  })
  it('REJECT: precise strong claim despite wide overlapping CIs', () => {
    const r = v.validate('The rate is exactly 34 and is significantly higher than 28.', figs)
    expect(r.pass).toBe(false)
    expect(failure(r)).toBe('precision')
  })
})

describe('C08 buyer MOE-overlap refusal', () => {
  it('PASS: comparative claim when MOE bands do not overlap', () => {
    const figs: FigureForValidation[] = [
      { key: 'median_home_value', value: 500000, marginOfError: 10000 },
      { key: 'median_home_value', value: 400000, marginOfError: 10000 },
    ]
    expect(v.validate('The first median home value is 500000, higher than the second value of 400000.', figs).pass).toBe(true)
  })
  it('REJECT: comparative claim when MOE bands overlap', () => {
    const figs: FigureForValidation[] = [
      { key: 'median_home_value', value: 500000, marginOfError: 60000 },
      { key: 'median_home_value', value: 460000, marginOfError: 50000 },
    ]
    const r = v.validate('The first median home value is 500000, higher than the second value of 460000.', figs)
    expect(r.pass).toBe(false)
    expect(failure(r)).toBe('precision')
  })
})

describe('C01 renter derived percentage', () => {
  it('PASS: code-computed derived percentage supplied as a figure', () => {
    const figs: FigureForValidation[] = [
      { key: 'renter_occupied', value: 420 },
      { key: 'households', value: 1000 },
      { key: 'derived:renter_pct', value: 42 },
    ]
    expect(v.validate('The renter share is 42 percent.', figs).pass).toBe(true)
  })
  it('REJECT: percentage asserted without a computed derived figure', () => {
    const figs: FigureForValidation[] = [
      { key: 'renter_occupied', value: 420 },
      { key: 'households', value: 1000 },
    ]
    const r = v.validate('The renter share is 42 percent.', figs)
    expect(r.pass).toBe(false)
    expect(failure(r)).toBe('invented_numeral')
  })
})

describe('C07 disaster-mover ranking rejection', () => {
  const figs: FigureForValidation[] = [{ key: 'median_gross_rent', value: 1200 }]
  it('PASS: neutral figure statement', () => {
    expect(v.validate('The median gross rent is 1200.', figs).pass).toBe(true)
  })
  it('REJECT: ranking / recommendation / steering language', () => {
    const r = v.validate('This is the best neighbourhood to move to, and we recommend it: the median gross rent is 1200.', figs)
    expect(r.pass).toBe(false)
    expect(failure(r)).toBe('banned_construction')
    expect(failure(v.validate('You should move here; it is a good neighbourhood.', []))).toBe('banned_construction')
    expect(failure(v.validate('This is the worst and top ranked area.', []))).toBe('banned_construction')
  })
})

describe('C04 tenant proxy leak and suppression', () => {
  it('PASS: citing a non-suppressed tenant count', () => {
    expect(v.validate('There are 150 renter-occupied households.', [{ key: 'renter_occupied', value: 150 }]).pass).toBe(true)
  })
  it('REJECT: suppressed small count cannot be cited (digit or word form)', () => {
    const figs: FigureForValidation[] = [{ key: 'renter_occupied', value: 12 }]
    expect(failure(v.validate('There are twelve renter-occupied households.', figs))).toBe('invented_numeral')
    expect(failure(v.validate('There are 12 renter-occupied households.', figs))).toBe('invented_numeral')
  })
  it('REJECT: proxy key used as a filter, and proxy characterisation in prose', () => {
    expect(failure(intentGate({ mode: 'sweep_filter', filters: [{ metricKey: 'renter_occupied', op: 'gt', value: 100 }] }))).toBe('intent_gate')
    expect(failure(v.validate('This is mostly renters, a tenant area.', []))).toBe('banned_construction')
  })
})

describe('C09 small-count suppression is counts-only', () => {
  it('PASS: a below-20 percentage is not suppressed for smallness', () => {
    expect(
      v.validate('The rent burden is 15 percent.', [
        { key: 'median_rent_burden_pct', value: 15 },
      ]).pass,
    ).toBe(true)
    expect(
      v.validate('The rent burden is 20 percent.', [
        { key: 'median_rent_burden_pct', value: 20 },
      ]).pass,
    ).toBe(true)
  })
  it('PASS: small medians, averages, and dollars are not suppressed', () => {
    expect(v.validate('The median age is 12.', [{ key: 'median_age', value: 12 }]).pass).toBe(true)
    expect(
      v.validate('The average household size is 2.5.', [{ key: 'average_household_size', value: 2.5 }]).pass,
    ).toBe(true)
    expect(
      v.validate('The median gross rent is 15.', [{ key: 'median_gross_rent', value: 15 }]).pass,
    ).toBe(true)
  })
  it('REJECT: a genuine below-20 count is still suppressed', () => {
    expect(
      failure(v.validate('There are 3 households.', [{ key: 'households', value: 3 }])),
    ).toBe('invented_numeral')
  })
  it('intentGate accepts a below-20 percentage filter, rejects a below-20 count', () => {
    expect(
      intentGate(
        {
          mode: 'sweep_filter',
          metricKeys: ['median_rent_burden_pct'],
          filters: [{ metricKey: 'median_rent_burden_pct', op: 'gt', value: 15 }],
        },
        [{ key: 'median_rent_burden_pct', value: 15 }],
      ).pass,
    ).toBe(true)
    expect(
      failure(
        intentGate(
          {
            mode: 'sweep_filter',
            metricKeys: ['households'],
            filters: [{ metricKey: 'households', op: 'gt', value: 3 }],
          },
          [{ key: 'households', value: 3 }],
        ),
      ),
    ).toBe('intent_gate')
  })
})
