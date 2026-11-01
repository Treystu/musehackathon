import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  coverage,
  coverageReport,
  createReplayProvider,
  geoLevelOf,
  scoreCorpus,
  scoreExplain,
  type GoldenCorpus,
} from '../../src/core/ai/golden'
import { METRIC_KEYS } from '../../src/core/civicscope-registry'
import { canRun, validateIntent } from '../../src/core/ai/intent-schema'

const CORPUS_PATH = new URL('./golden-corpus.json', import.meta.url)
const REPORT_PATH = new URL('./coverage-report.md', import.meta.url)

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as GoldenCorpus

describe('golden corpus integrity', () => {
  it('every recorded intent is schema-valid', () => {
    for (const item of corpus.intent) {
      const check = validateIntent(item.expect)
      expect(check.ok, `${item.id}: ${check.ok ? '' : check.detail}`).toBe(true)
    }
  })

  it('every metric carries a canonical query and at least two colloquial paraphrases', () => {
    for (const metricKey of METRIC_KEYS) {
      const lookups = corpus.intent.filter(
        (item) => item.expect.mode === 'lookup' && item.expect.metricKeys.includes(metricKey),
      )
      expect(lookups.length, `${metricKey} lookup phrasings`).toBeGreaterThanOrEqual(3)
    }
  })

  it('safety cases are recorded as refusals, not as answers', () => {
    const safety = corpus.intent.filter((item) => item.safety)
    expect(safety.length).toBeGreaterThanOrEqual(5)
    for (const item of safety) {
      expect(item.expect.clarificationNeeded, `${item.id} must request clarification`).toBe(true)
      expect(canRun(item.expect), `${item.id} must not be runnable`).toBe(false)
    }
  })
})

describe('golden corpus scoring (hermetic replay)', () => {
  it('replays every case through the schema and validator path without a miss', async () => {
    const score = await scoreCorpus(corpus, createReplayProvider(corpus))
    expect(score.failures).toEqual([])
    expect(score.exactPct).toBe(100)
    expect(score.safetyPct).toBe(100)
    // Named so a future reader does not mistake this for a model score.
    console.log(
      `replay tier: exactIntent=${score.exact}/${score.total} safety=${score.safetyPass}/${score.safetyTotal}`,
    )
  })

  it('withholds every invented-numeral Explain fixture and passes every grounded one', () => {
    const score = scoreExplain(corpus)
    expect(score.total).toBe(METRIC_KEYS.length)
    expect(score.goodPassed).toBe(score.total)
    expect(score.badWithheld).toBe(score.total)
  })

  it('covers every supported metric x mode x geography combination and every metric Explain fixture', () => {
    const summary = coverage(corpus, METRIC_KEYS)
    const missing = summary.rows.filter((row) => row.missing.length > 0)
    expect(missing, `uncovered: ${JSON.stringify(missing)}`).toEqual([])
    expect(summary.intentCovered).toBe(summary.intentSupported)
    expect(summary.explainCovered).toBe(METRIC_KEYS.length)
  })

  it('records the generated coverage report in the repo', () => {
    const summary = coverage(corpus, METRIC_KEYS)
    const report = coverageReport(corpus, METRIC_KEYS)
    const current = (() => {
      try {
        return readFileSync(REPORT_PATH, 'utf8')
      } catch {
        return null
      }
    })()
    if (current !== report) writeFileSync(REPORT_PATH, report)
    // The committed file is the evidence; it must match what the registry says
    // today, so a registry addition without fixtures fails here rather than
    // shipping an unmeasured surface.
    expect(readFileSync(REPORT_PATH, 'utf8')).toBe(report)
    expect(report).toContain(`- Intent coverage: ${summary.intentCovered} of ${summary.intentSupported}`)
  })
})

describe('golden corpus geography levels', () => {
  it('names the geography level of every case instead of inferring it at scoring time', () => {
    for (const item of corpus.intent) {
      const level = geoLevelOf(item.expect)
      if (item.expect.geographies.length === 0) {
        expect(level, `${item.id} refusal cases carry no geography`).toBeNull()
      } else {
        expect(['zip', 'city', 'state'], item.id).toContain(level)
      }
    }
  })
})
