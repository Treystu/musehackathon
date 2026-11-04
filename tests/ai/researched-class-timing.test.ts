import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'

/**
 * Phase 5 timing probe (owner addendum, 2026-11-03 23:14 HST —
 * measure first): the researched/geographic class's latency
 * structure, measured in-process at the runner seam. Research is
 * scripted (instant, then 600 ms per call) so the table separates
 * the deterministic floor from the pass structure: production
 * wall-clock is floor + passes x per-pass network time, and the
 * passes run sequentially inside researchPerCriterion. The
 * measured numbers are printed for the Phase 5 record
 * (RESEARCHED-CLASS-PERF.md); the pins hold the STRUCTURE —
 * pass counts and the preliminary's precedence — not the
 * millisecond readings, which are machine-relative.
 */

const STATE_PLACES: PlaceSuggestion[] = [
  { displayName: 'Denver', censusName: 'Denver city', state: 'CO', isCity: true, zips: ['80202'] },
  { displayName: 'Golden', censusName: 'Golden city', state: 'CO', isCity: true, zips: ['80401'] },
  { displayName: 'Fort Collins', censusName: 'Fort Collins city', state: 'CO', isCity: true, zips: ['80525'] },
  { displayName: 'Austin', censusName: 'Austin city', state: 'TX', isCity: true, zips: ['78701'] },
  { displayName: 'Dallas', censusName: 'Dallas city', state: 'TX', isCity: true, zips: ['75201'] },
  { displayName: 'Houston', censusName: 'Houston city', state: 'TX', isCity: true, zips: ['77002'] },
]

const BY_ZIP = new Map<string, PlaceRecord>(
  STATE_PLACES.flatMap((place) =>
    place.zips.map(
      (zip) =>
        [
          zip,
          {
            zip,
            censusName: place.censusName,
            displayName: place.displayName,
            state: place.state,
            isCity: true,
            incorporated: true,
          },
        ] as const,
    ),
  ),
)
const INDEX = new PlaceIndex(BY_ZIP, STATE_PLACES)

const ROWS: AreaRow[] = [
  { zcta: '80202', name: 'ZCTA5 80202', metrics: { median_gross_rent: 1750, median_home_value: 560000, population: 12000 }, moes: { median_gross_rent: 90 } },
  { zcta: '80401', name: 'ZCTA5 80401', metrics: { median_gross_rent: 1650, median_home_value: 720000, population: 9000 }, moes: { median_gross_rent: 110 } },
  { zcta: '80525', name: 'ZCTA5 80525', metrics: { median_gross_rent: 1550, median_home_value: 540000, population: 15000 }, moes: { median_gross_rent: 70 } },
  { zcta: '78701', name: 'ZCTA5 78701', metrics: { median_gross_rent: 1600, median_home_value: 480000, population: 11000 }, moes: { median_gross_rent: 85 } },
  { zcta: '75201', name: 'ZCTA5 75201', metrics: { median_gross_rent: 1500, median_home_value: 420000, population: 10000 }, moes: { median_gross_rent: 95 } },
  { zcta: '77002', name: 'ZCTA5 77002', metrics: { median_gross_rent: 1400, median_home_value: 390000, population: 13000 }, moes: { median_gross_rent: 80 } },
]

async function probe(input: {
  label: string
  queryText: string
  intent: ValidatedIntent
  researchDelayMs: number
}) {
  let passes = 0
  let preliminaryAt: number | null = null
  const provider = createStubProvider({
    async research() {
      passes++
      if (input.researchDelayMs > 0) {
        await new Promise((r) => setTimeout(r, input.researchDelayMs))
      }
      return { prose: '', sources: [] }
    },
  })
  const started = performance.now()
  const answer = await composeAnswerForRequest({
    intent: input.intent,
    queryText: input.queryText,
    rows: ROWS,
    resolved: resolveAnswerGeographies(input.intent, INDEX),
    provider,
    research: true,
    placeIndex: INDEX,
    onPreliminary: () => {
      if (preliminaryAt === null) preliminaryAt = performance.now() - started
    },
  })
  const totalMs = performance.now() - started
  // eslint-disable-next-line no-console
  console.log(
    `[phase5-probe] ${input.label}: passes=${passes} preliminaryAt=${preliminaryAt === null ? 'none' : preliminaryAt.toFixed(1) + 'ms'} total=${totalMs.toFixed(1)}ms status=${answer?.status ?? 'null'}`,
  )
  return { passes, preliminaryAt, totalMs, answer }
}

const COLORADO_INTENT: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['Colorado'],
  metricKeys: [],
  filters: [],
  clarificationNeeded: false,
}
const TEXAS_INTENT: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['Texas'],
  metricKeys: [],
  filters: [],
  clarificationNeeded: false,
}

describe('Phase 5 timing probe: the researched/geographic class', () => {
  it('Colorado (nature + cost): pass structure and preliminary precedence', async () => {
    const instant = await probe({
      label: 'colorado-instant',
      queryText: 'what city in Colorado has the best nature and the lowest cost of living?',
      intent: COLORADO_INTENT,
      researchDelayMs: 0,
    })
    expect(instant.passes).toBeGreaterThanOrEqual(1)
    expect(instant.preliminaryAt).not.toBeNull()
    const delayed = await probe({
      label: 'colorado-600ms-per-pass',
      queryText: 'what city in Colorado has the best nature and the lowest cost of living?',
      intent: COLORADO_INTENT,
      researchDelayMs: 600,
    })
    // The preliminary is set by the deterministic floor, not by
    // the research latency: it lands well inside one pass.
    expect(delayed.preliminaryAt).not.toBeNull()
    expect(delayed.preliminaryAt!).toBeLessThan(600)
    expect(delayed.totalMs).toBeGreaterThanOrEqual(600)
  })

  it('Texas (most liberal): pass structure and preliminary precedence', async () => {
    const instant = await probe({
      label: 'texas-instant',
      queryText: 'Which city in Texas is the most liberal?',
      intent: TEXAS_INTENT,
      researchDelayMs: 0,
    })
    expect(instant.passes).toBeGreaterThanOrEqual(1)
    const delayed = await probe({
      label: 'texas-600ms-per-pass',
      queryText: 'Which city in Texas is the most liberal?',
      intent: TEXAS_INTENT,
      researchDelayMs: 600,
    })
    expect(delayed.preliminaryAt).not.toBeNull()
    expect(delayed.preliminaryAt!).toBeLessThan(600)
  })
})
