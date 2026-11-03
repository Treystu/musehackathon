import { describe, expect, it } from 'vitest'
import {
  bindResolvedCandidates,
  candidateBoundForInput,
  runAnswerPipeline,
  type ComposedAnswer,
  type ResolvedCandidate,
  type RunProgressSnapshot,
} from '../../src/core/ai/answer'
import { outOfBoundCandidatesLine } from '../../src/ui/ai/AnswerCard'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'

/**
 * Lane A10 generality pins (phase 3: extraction quality). Fixtures
 * are built from the LIVE sheet-A specimens (production c7a6630,
 * 2026-11-03 05:21-05:52 HST): research prose as it actually
 * arrives — fragments, hyphenates, narration-bearing sentences,
 * listicles with partial names — not the cleaner genre phases 1-2
 * pinned. The sheet's verbatim unmatched lists are the specimen
 * set. Assertions grow per cure cluster; each cluster's commit
 * names the assertions it added.
 */

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return { mode: 'sweep_filter', geographies: [], metricKeys: [], filters: [], clarificationNeeded: false, ...partial }
}

function row(zcta: string, name: string, rent: number): AreaRow {
  return { zcta, name, metrics: { median_gross_rent: rent }, moes: { median_gross_rent: 60 } }
}

function provider(prose: string) {
  return createStubProvider({
    async research() {
      return { prose, sources: [{ title: 'Findings source', url: 'https://example.com/f' }] }
    },
  })
}

async function runPipeline(input: {
  q: string
  intent: Partial<ValidatedIntent>
  rows: AreaRow[]
  prose: string
  geographyZctas?: ReadonlySet<string>
  onProgress?: (snapshot: RunProgressSnapshot) => void
}): Promise<ComposedAnswer> {
  return runAnswerPipeline({
    intent: intent(input.intent),
    rows: input.rows,
    researchQuery: input.q,
    researchCriteria: [input.q],
    queryText: input.q,
    provider: provider(input.prose),
    geographyZctas: input.geographyZctas,
    onProgress: input.onProgress,
  })
}

/* ------------------------------------------------------------------ */
/* FM-15 — geography binding                                           */
/* ------------------------------------------------------------------ */

const MI_ROWS = [
  row('49684', 'Traverse City, MI', 1250),
  row('49855', 'Marquette, MI', 1100),
  row('49770', 'Petoskey, MI', 1350),
  row('67842', 'Ford, KS', 766),
]

// Live-shaped prose in the sheet-A genre: Michigan towns named as
// findings, and a Kansas place carried in the same findings text
// (the live run's research described a Ford attraction and the
// extraction materialized the Kansas town of that name).
const MI_PROSE =
  'Traverse City, MI pairs a walkable downtown with lakefront parks and a full calendar of festivals. ' +
  'Marquette, MI offers trails, a historic lighthouse, and lively local events through the summer. ' +
  'Ford, Kansas is a small farming town with a quiet main street and a county fair each August. ' +
  'Petoskey, MI is known for its bay views, shopping streets, and summer concerts.'

describe('FM-15 geography binding (unit)', () => {
  const cand = (name: string, zctas: string[]): ResolvedCandidate => ({ name, zctas })

  it('a ZCTA bound keeps only in-bound ZCTAs and records the rest out-of-bound', () => {
    const { bound, outOfBound } = bindResolvedCandidates(
      [cand('Springfield', ['01103', '62701']), cand('Ford, KS', ['67842'])],
      { zctas: new Set(['01103', '49684']), states: null },
      MI_ROWS,
    )
    expect(bound).toEqual([{ name: 'Springfield', zctas: ['01103'] }])
    expect(outOfBound).toEqual(['Ford, KS'])
  })

  it('a state bound reads the candidate name suffix and loaded rows', () => {
    const { bound, outOfBound } = bindResolvedCandidates(
      [cand('Ford, KS', ['67842']), cand('Traverse City, MI', ['49684']), cand('Marquette', ['49855'])],
      { zctas: null, states: new Set(['MI']) },
      MI_ROWS,
    )
    expect(bound.map((c) => c.name)).toEqual(['Traverse City, MI', 'Marquette'])
    expect(outOfBound).toEqual(['Ford, KS'])
  })

  it('no bound passes every candidate through untouched', () => {
    const input = [cand('Ford, KS', ['67842'])]
    const { bound, outOfBound } = bindResolvedCandidates(input, { zctas: null, states: null }, MI_ROWS)
    expect(bound).toEqual(input)
    expect(outOfBound).toEqual([])
  })

  it('the bound derives from the caller set first, then ZIP, then state geographies', () => {
    const caller = new Set(['49684'])
    expect(candidateBoundForInput({ intent: intent({ geographies: ['Michigan'] }), geographyZctas: caller }).zctas).toBe(caller)
    expect(candidateBoundForInput({ intent: intent({ geographies: ['49684'] }) }).zctas).toEqual(new Set(['49684']))
    expect(candidateBoundForInput({ intent: intent({ geographies: ['Michigan'] }) }).states).toEqual(new Set(['MI']))
    expect(candidateBoundForInput({ intent: intent({ geographies: ['MI'] }) }).states).toEqual(new Set(['MI']))
    expect(candidateBoundForInput({ intent: intent({ geographies: ['Nashville'] }) })).toEqual({ zctas: null, states: null })
    expect(candidateBoundForInput({ intent: intent({ geographies: [] }) })).toEqual({ zctas: null, states: null })
  })
})

describe('FM-15 geography binding (the Michigan specimen, sheet A Q4)', () => {
  const q = 'Which town in Michigan has the most fun things to do?'

  it('never cards Ford, KS for a Michigan question (state bound derived from the intent)', async () => {
    const answer = await runPipeline({ q, intent: { geographies: ['Michigan'], metricKeys: [] }, rows: MI_ROWS, prose: MI_PROSE })
    expect(answer.places.map((p) => p.name)).toEqual(['Traverse City, MI', 'Marquette, MI', 'Petoskey, MI'])
    expect(answer.outOfBoundCandidates).toEqual(['Ford, KS'])
    expect(outOfBoundCandidatesLine(answer)).toBe(
      'Ford, KS was named in the research but is outside the area this question asks about, so it was not used.',
    )
  })

  it('never cards Ford, KS under the caller-resolved ZCTA bound (the production seam)', async () => {
    const answer = await runPipeline({
      q,
      intent: { geographies: ['Michigan'], metricKeys: [] },
      rows: MI_ROWS,
      prose: MI_PROSE,
      geographyZctas: new Set(['49684', '49855', '49770']),
    })
    expect(answer.places.map((p) => p.name)).toEqual(['Traverse City, MI', 'Marquette, MI', 'Petoskey, MI'])
    expect(answer.outOfBoundCandidates).toEqual(['Ford, KS'])
  })

  it('an out-of-bound place never appears in an interim progress snapshot either', async () => {
    const snapshots: RunProgressSnapshot[] = []
    const answer = await runPipeline({
      q,
      intent: { geographies: ['Michigan'], metricKeys: [] },
      rows: MI_ROWS,
      prose: MI_PROSE,
      onProgress: (s) => snapshots.push(s),
    })
    expect(answer.places.length).toBeGreaterThan(0)
    expect(JSON.stringify(snapshots)).not.toContain('Ford')
  })

  it('a placeless question keeps the unbound behavior — Ford cards when nothing bounds it out', async () => {
    const answer = await runPipeline({ q, intent: { geographies: [], metricKeys: [] }, rows: MI_ROWS, prose: MI_PROSE })
    expect(answer.places.map((p) => p.name)).toContain('Ford, KS')
    expect(answer.outOfBoundCandidates).toBeUndefined()
  })
})
