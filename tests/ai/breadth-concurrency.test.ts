/**
 * Breadth concurrency pins (2026-11-03 — the optimization the
 * breadth build's gate dossier named, ordered by the owner after
 * the sequential build shipped: the first live full-Texas run
 * took about 50 minutes over 27 sequential batches). The
 * sequential pipeline is the spec: these pins run the SAME
 * multi-batch fixture through the pipeline at concurrency 1
 * (the breadthConcurrency seam) and at the shipped bound, with
 * batch completion deliberately scrambled, and require identical
 * terminals and identical progress-snapshot state sequences —
 * the pool may change when calls happen, never what a merged
 * prefix means. Failure shapes (a middle batch down, the
 * breaker forced open after the first batch) get the same A/B
 * treatment plus the bounded-attempts accounting.
 */
import { describe, expect, it } from 'vitest'
import {
  BREADTH_BATCH_CONCURRENCY,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import type { RunProgressSnapshot } from '../../src/core/ai/run-progress'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'

const TEXAS_QUESTION = 'Which areas of Texas are the most liberal?'
const SOURCE = { title: 'Findings source', url: 'https://example.com/f' }

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return { mode: 'sweep_filter', geographies: [], metricKeys: [], filters: [], clarificationNeeded: false, ...partial }
}

function row(zcta: string, name: string, rent: number, pop: number): AreaRow {
  return { zcta, name, metrics: { median_gross_rent: rent, population: pop }, moes: { median_gross_rent: 60 } }
}

/** 120 places -> roster batches of [50, 50, 20], Place 001 first. */
const TX_ROWS_120: AreaRow[] = []
for (let i = 1; i <= 120; i++) {
  TX_ROWS_120.push(row(String(76000 + i), `Place ${String(i).padStart(3, '0')}, TX`, 1000, 100000 - i))
}

/** Characterizing findings, spread across all three batches. */
const FINDINGS: Readonly<Record<string, string>> = {
  'Place 001, TX': 'Place 001, TX is described as liberal.',
  'Place 002, TX': 'Place 002, TX is described as deeply conservative.',
  'Place 051, TX': 'Place 051, TX is described as a liberal stronghold.',
  'Place 052, TX': 'Place 052, TX is described as politically mixed, with liberal and conservative areas.',
  'Place 101, TX': 'Place 101, TX is described as strongly liberal-leaning.',
  'Place 102, TX': 'Place 102, TX is described as a conservative stronghold.',
}

function batchIndexOf(places: readonly string[]): number {
  const first = Number(/\d+/.exec(places[0] ?? '')?.[0] ?? 1)
  return Math.floor((first - 1) / 50)
}

interface Tracker {
  rosterCalls: number
  maxInFlight: number
}

/**
 * A breadth provider whose batches complete OUT of roster order
 * (later batches resolve sooner) unless a failure knob says
 * otherwise. The standard pass returns no material, so every
 * standing in these runs comes from the roster batches alone.
 */
function scrambledProvider(
  tracker: Tracker,
  opts?: { failBatches?: ReadonlySet<number>; breakerAfterRosterCalls?: number },
) {
  let inFlight = 0
  return createStubProvider({
    async research(input) {
      if (input.places.length === 1 && input.places[0] === 'Texas') {
        return { prose: '', sources: [SOURCE] }
      }
      tracker.rosterCalls++
      if (
        opts?.breakerAfterRosterCalls !== undefined &&
        tracker.rosterCalls > opts.breakerAfterRosterCalls
      ) {
        throw new Error('breaker_open')
      }
      const batch = batchIndexOf(input.places)
      if (opts?.failBatches?.has(batch)) throw new Error('provider_down')
      inFlight++
      tracker.maxInFlight = Math.max(tracker.maxInFlight, inFlight)
      // Batch 0 slowest, the last batch immediate: completion
      // order is the reverse of roster order.
      await new Promise((resolve) => setTimeout(resolve, (2 - batch) * 15))
      inFlight--
      const prose = input.places.map((name) => FINDINGS[name]).filter(Boolean).join(' ')
      return { prose, sources: [SOURCE] }
    },
  })
}

async function runMode(
  concurrency: number | undefined,
  opts?: { failBatches?: ReadonlySet<number>; breakerAfterRosterCalls?: number },
) {
  const tracker: Tracker = { rosterCalls: 0, maxInFlight: 0 }
  const snapshots: RunProgressSnapshot[] = []
  const answer = await runAnswerPipeline({
    intent: intent({ geographies: ['Texas'] }),
    rows: TX_ROWS_120,
    researchQuery: TEXAS_QUESTION,
    researchCriteria: [TEXAS_QUESTION],
    queryText: TEXAS_QUESTION,
    provider: scrambledProvider(tracker, opts),
    ...(concurrency !== undefined ? { breadthConcurrency: concurrency } : {}),
    onProgress: (s) => snapshots.push(s),
  })
  return { answer, snapshots, tracker }
}

/** The terminal, minus the fields concurrency legitimately changes (elapsed time). */
function terminalProjection(answer: ComposedAnswer) {
  const b = answer.breadth!
  return {
    status: answer.status,
    places: answer.places.map((p) => p.name),
    consideredNotMeeting: answer.consideredNotMeeting ?? [],
    displayTotal: b.displayTotal,
    assessedCount: b.assessedCount,
    standings: b.standings.map((p) => ({
      name: p.name,
      zcta: p.zcta,
      standing: p.standing,
      claims: (p.claims ?? []).map((c) => c.text),
    })),
  }
}

/** The breadth snapshot state sequence, minus measured time (elapsed / ETA). */
function snapshotProjection(snapshots: RunProgressSnapshot[]) {
  return snapshots
    .filter((s) => s.breadth)
    .map((s) => ({
      doneUnits: s.doneUnits,
      assessedCount: s.breadth!.assessedCount,
      places: (s.breadthPlaces ?? []).map((p) => `${p.name}:${p.standing}`),
    }))
}

describe('breadth concurrency — the sequential run is the spec', () => {
  it('identical terminals and snapshot sequences, completion order scrambled', async () => {
    const sequential = await runMode(1)
    const concurrent = await runMode(undefined)
    expect(terminalProjection(concurrent.answer)).toEqual(terminalProjection(sequential.answer))
    expect(snapshotProjection(concurrent.snapshots)).toEqual(snapshotProjection(sequential.snapshots))
    // The fixture's six characterized places, across all three
    // batches, are the whole assessed set in both modes.
    expect(concurrent.answer.breadth!.assessedCount).toBe(6)
    expect(concurrent.answer.breadth!.displayTotal).toBe(120)
    // Snapshot assessed counts never decrease in either mode.
    for (const run of [sequential, concurrent]) {
      const counts = snapshotProjection(run.snapshots).map((s) => s.assessedCount)
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!)
      }
    }
  })

  it('the pool overlaps in flight, never beyond the shipped bound; the seam at 1 never overlaps', async () => {
    const concurrent = await runMode(undefined)
    expect(concurrent.tracker.maxInFlight).toBeGreaterThan(1)
    expect(concurrent.tracker.maxInFlight).toBeLessThanOrEqual(BREADTH_BATCH_CONCURRENCY)
    const sequential = await runMode(1)
    expect(sequential.tracker.maxInFlight).toBe(1)
    // Same total calls in both modes — compressed, not multiplied.
    expect(concurrent.tracker.rosterCalls).toBe(3)
    expect(sequential.tracker.rosterCalls).toBe(3)
  })

  it('a failed middle batch costs exactly its places, identically in both modes', async () => {
    const opts = { failBatches: new Set([1]) }
    const sequential = await runMode(1, opts)
    const concurrent = await runMode(undefined, opts)
    expect(terminalProjection(concurrent.answer)).toEqual(terminalProjection(sequential.answer))
    expect(snapshotProjection(concurrent.snapshots)).toEqual(snapshotProjection(sequential.snapshots))
    // Batches 0 and 2 assessed (4 places); batch 1's two
    // characterized places stay unassessed, and the run owns
    // its terminal through batch 0/2's positive places.
    expect(concurrent.answer.breadth!.assessedCount).toBe(4)
    const byName = new Map(concurrent.answer.breadth!.standings.map((p) => [p.name, p.standing]))
    expect(byName.get('Place 051, TX')).toBe('unassessed')
    expect(byName.get('Place 052, TX')).toBe('unassessed')
    expect(byName.get('Place 001, TX')).toBe('positive')
    expect(byName.get('Place 101, TX')).toBe('positive')
  })

  it('breaker forced open after the first batch: honest termination, one attempt per batch', async () => {
    const opts = { breakerAfterRosterCalls: 1 }
    const concurrent = await runMode(undefined, opts)
    const sequential = await runMode(1, opts)
    expect(terminalProjection(concurrent.answer)).toEqual(terminalProjection(sequential.answer))
    // Exactly one attempt per batch — no retry storm at any bound.
    expect(concurrent.tracker.rosterCalls).toBe(3)
    expect(sequential.tracker.rosterCalls).toBe(3)
    // Only the first batch's characterizations landed; the rest
    // of the state reads as not assessed, and the run still
    // terminates on a verified breadth card.
    expect(concurrent.answer.status).toBe('verified')
    expect(concurrent.answer.breadth!.assessedCount).toBe(2)
    const byName = new Map(concurrent.answer.breadth!.standings.map((p) => [p.name, p.standing]))
    expect(byName.get('Place 001, TX')).toBe('positive')
    expect(byName.get('Place 002, TX')).toBe('negative')
    expect(byName.get('Place 051, TX')).toBe('unassessed')
    expect(byName.get('Place 101, TX')).toBe('unassessed')
  })
})
