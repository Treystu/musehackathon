import { describe, expect, it } from 'vitest'
import {
  PLAN_OBJECTION_CODES,
  PLAN_PACKET_TOKEN_BUDGET,
  VERIFY_PACKET_TOKEN_BUDGET,
  buildPlanPacket,
  buildVerifyPacket,
  parsePlanVerdict,
  parseVerifyVerdict,
} from '../../src/core/ai/hourglass-packets'

/**
 * C2/C5 packets and verdicts: budgets are hard properties of the
 * builders, trim is pinned, and verdict parsing is closed-schema —
 * anything off-schema is a degradation, never a verdict.
 */
describe('plan packet', () => {
  it('builds within budget for a small plan and names every field', () => {
    const p = buildPlanPacket({
      question: 'best schools and fewest fast food in Hawaii',
      intent: { mode: 'sweep_filter', geographies: ['HI'], measures: ['medianGrossRent'] },
      criteria: [
        { kind: 'research', text: 'good schools' },
        { kind: 'research', text: 'few fast food restaurants' },
      ],
      subset: { count: 41, ranges: [{ label: 'median gross rent', min: '900', max: '2400' }] },
    })
    expect(p.tokens).toBeLessThanOrEqual(PLAN_PACKET_TOKEN_BUDGET)
    expect(p.trimmed).toBe(false)
    expect(p.text).toContain('best schools')
    expect(p.text).toContain('Screened subset: 41 places.')
    expect(p.text).toContain('median gross rent 900 to 2400')
  })

  it('hard-trims an oversized plan to the 1500-token budget', () => {
    const criteria = Array.from({ length: 12 }, (_, i) => ({
      kind: 'research' as const,
      text: `criterion ${i} ${'x'.repeat(400)}`,
    }))
    const ranges = Array.from({ length: 10 }, (_, i) => ({
      label: `range ${i} ${'y'.repeat(200)}`,
      min: '1',
      max: '2',
    }))
    const p = buildPlanPacket({
      question: 'q'.repeat(500),
      intent: { mode: 'sweep_filter', geographies: ['HI'], measures: ['a'] },
      criteria,
      subset: { count: 5, ranges },
    })
    expect(p.tokens).toBeLessThanOrEqual(PLAN_PACKET_TOKEN_BUDGET)
    expect(p.trimmed).toBe(true)
  })
})

describe('verify packet', () => {
  it('compresses places beyond the display limit to a count', () => {
    const places = Array.from({ length: 14 }, (_, i) => `Place ${i}`)
    const p = buildVerifyPacket({
      answerText: 'Two places meet both criteria.',
      places,
      criteriaEvidence: [{ criterion: 'schools', label: 'met' }],
      sources: [{ title: 'State report', url: 'https://example.org/x' }],
      verifySummary: 'figures strict-equal',
    })
    expect(p.text).toContain('(+4 more)')
    expect(p.tokens).toBeLessThanOrEqual(VERIFY_PACKET_TOKEN_BUDGET)
  })

  it('hard-trims an oversized answer to the 2500-token budget', () => {
    const p = buildVerifyPacket({
      answerText: 'a'.repeat(30000),
      places: ['Hilo'],
      criteriaEvidence: [{ criterion: 'schools', label: 'met' }],
      sources: [],
      verifySummary: 'ok',
    })
    expect(p.tokens).toBeLessThanOrEqual(VERIFY_PACKET_TOKEN_BUDGET)
    expect(p.trimmed).toBe(true)
  })
})

describe('plan verdict parsing', () => {
  it('parses a sound verdict', () => {
    expect(parsePlanVerdict('{"verdict":"sound","objections":[]}')).toEqual({
      kind: 'sound',
      objections: [],
    })
  })

  it('parses each objection code in the closed set', () => {
    for (const code of PLAN_OBJECTION_CODES) {
      const v = parsePlanVerdict(
        JSON.stringify({ verdict: 'unsound', objections: [{ code, detail: 'named problem' }] }),
      )
      expect(v.kind).toBe('unsound')
      if (v.kind === 'unsound') expect(v.objections[0]?.code).toBe(code)
    }
  })

  it('extracts a verdict wrapped in prose', () => {
    const v = parsePlanVerdict('Here is my verdict: {"verdict":"sound","objections":[]} done.')
    expect(v.kind).toBe('sound')
  })

  it('malformed verdicts degrade: bad code, empty objections, non-JSON, wrong verdict word', () => {
    expect(parsePlanVerdict('{"verdict":"unsound","objections":[{"code":"other","detail":"x"}]}').kind).toBe('degraded')
    expect(parsePlanVerdict('{"verdict":"unsound","objections":[]}').kind).toBe('degraded')
    expect(parsePlanVerdict('the plan looks fine').kind).toBe('degraded')
    expect(parsePlanVerdict('{"verdict":"approved","objections":[]}').kind).toBe('degraded')
    expect(parsePlanVerdict('').kind).toBe('degraded')
  })
})

describe('verify verdict parsing', () => {
  it('parses verified, concerns, and not_verified', () => {
    expect(parseVerifyVerdict('{"verdict":"verified","concerns":[]}').kind).toBe('verified')
    const c = parseVerifyVerdict(
      '{"verdict":"concerns","concerns":[{"kind":"presentational","detail":"ordering"}]}',
    )
    expect(c.kind).toBe('concerns')
    const n = parseVerifyVerdict(
      '{"verdict":"not_verified","concerns":[{"kind":"factual","detail":"rent mismatch"}]}',
    )
    expect(n.kind).toBe('not_verified')
    if (n.kind === 'not_verified') expect(n.concerns[0]?.kind).toBe('factual')
  })

  it('malformed verdicts degrade', () => {
    expect(parseVerifyVerdict('{"verdict":"concerns","concerns":[{"kind":"other","detail":"x"}]}').kind).toBe('degraded')
    expect(parseVerifyVerdict('{"verdict":"concerns","concerns":[]}').kind).toBe('degraded')
    expect(parseVerifyVerdict('looks verified to me').kind).toBe('degraded')
  })
})
