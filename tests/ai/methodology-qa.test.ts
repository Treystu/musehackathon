import { describe, expect, it } from 'vitest'
import {
  answerMethodologyQuestion,
  qaMetricCoverage,
  validateCorpus,
  METHODOLOGY_CORPUS,
} from '../../src/core/ai/methodology-qa'
import { METRIC_DEFS } from '../../src/core/civicscope-registry'
import { createValidator } from '../../src/core/ai/validator'

interface QaFixture {
  question: string
  answered: boolean
  entryId?: string
  reason?: 'out_of_corpus' | 'not_covered' | 'data_question'
}

const FIXTURES: QaFixture[] = [
  // In-corpus: methodology questions the corpus must answer.
  { question: 'How current is this rent figure?', answered: true, entryId: 'acs-currency' },
  { question: 'What does the margin of error mean?', answered: true, entryId: 'moe-meaning' },
  { question: 'Why is there no graduation rate for this ZIP?', answered: true, entryId: 'graduation-coverage' },
  { question: 'Why is there no figure for this place?', answered: true, entryId: 'missing-figure' },
  { question: 'Why was this count suppressed?', answered: true, entryId: 'suppression' },
  { question: 'Where does median gross rent come from?', answered: true, entryId: 'source-median_gross_rent' },
  { question: 'Where does the data come from?', answered: true, entryId: 'sources-overview' },
  { question: 'How is the affordability composite calculated?', answered: true, entryId: 'composite-method' },
  { question: 'What geography are these figures for, ZIP or tract?', answered: true, entryId: 'geography-coverage' },
  { question: 'Do you store my searches or my key?', answered: true, entryId: 'privacy-method' },
  // Out-of-corpus and data questions: refused, boundary stated.
  { question: 'What is the median gross rent in Hilo?', answered: false, reason: 'data_question' },
  { question: 'How many households are in 96778?', answered: false, reason: 'data_question' },
  { question: 'Do you have crime data for this area?', answered: false, reason: 'not_covered' },
  { question: 'What is the weather tomorrow?', answered: false, reason: 'not_covered' },
  { question: 'What will rent cost next year?', answered: false, reason: 'out_of_corpus' },
  { question: 'Recommend a good neighbourhood near Hilo', answered: false, reason: 'out_of_corpus' },
  { question: 'Who won the election?', answered: false, reason: 'out_of_corpus' },
  { question: '', answered: false, reason: 'out_of_corpus' },
]

describe('methodology Q&A fixture set', () => {
  it('scores 100% on the fixture set', () => {
    const failures: string[] = []
    for (const fixture of FIXTURES) {
      const result = answerMethodologyQuestion(fixture.question)
      if (result.answered !== fixture.answered) {
        failures.push(`${fixture.question}: answered=${result.answered}, expected ${fixture.answered}`)
        continue
      }
      if (fixture.answered && result.answered && result.entryId !== fixture.entryId) {
        failures.push(`${fixture.question}: entry=${result.entryId}, expected ${fixture.entryId}`)
      }
      if (!fixture.answered && !result.answered && result.reason !== fixture.reason) {
        failures.push(`${fixture.question}: reason=${result.reason}, expected ${fixture.reason}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('states the boundary on every refusal', () => {
    for (const fixture of FIXTURES.filter((f) => !f.answered)) {
      const result = answerMethodologyQuestion(fixture.question)
      expect(result.answered).toBe(false)
      if (!result.answered) {
        expect(result.text).toContain('Methodology Q&A answers only questions')
      }
    }
  })

  it('answers the source question for every registered metric', () => {
    for (const def of METRIC_DEFS) {
      const result = answerMethodologyQuestion(`What is the source of ${def.label}?`)
      expect(result.answered, def.key).toBe(true)
      if (result.answered) expect(result.entryId).toBe(`source-${def.key}`)
    }
  })

  it('registry-generated coverage: no registered metric is missing a Q&A source entry', () => {
    const coverage = qaMetricCoverage()
    expect(coverage.missing).toEqual([])
    expect(coverage.covered).toHaveLength(METRIC_DEFS.length)
  })
})

describe('methodology corpus self-check', () => {
  it('every corpus answer passes the F4 validator against its declared figures', () => {
    const results = validateCorpus()
    const failures = results.filter((r) => !r.pass)
    expect(failures).toEqual([])
  })

  it('every answered fixture response passes the F4 validator', () => {
    const validator = createValidator()
    for (const entry of METHODOLOGY_CORPUS) {
      if (entry.refusal) continue
      const verdict = validator.validate(entry.answer, entry.figures)
      expect(verdict.pass, `${entry.id}: ${verdict.pass ? '' : verdict.detail}`).toBe(true)
    }
  })
})
