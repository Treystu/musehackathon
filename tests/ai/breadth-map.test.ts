import { describe, expect, it } from 'vitest'
import {
  BREADTH_BATCH_SIZE,
  breadthDisplaySet,
  breadthShapeFor,
  claimCharacterization,
  decomposeResearchCriteria,
  filterWorkingNarration,
  placeStanding,
  questionSetForm,
  runAnswerPipeline,
  type ComposedAnswer,
  type ResearchedClaim,
} from '../../src/core/ai/answer'
import {
  deriveBreadthPlaces,
  estimateRemainingMs,
  durationText,
  progressPercent,
  runSummaryText,
  situationalText,
  type RunProgressSnapshot,
} from '../../src/core/ai/run-progress'
import { RESEARCH_PLACES_LIMIT } from '../../src/core/ai/meta-client'
import { resultMapRelevant, terminalChartKinds } from '../../src/core/map/result-scale'
import { breadthCountsLine } from '../../src/ui/ai/AnswerCard'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'

/**
 * Breadth mode pins (owner directive 2026-11-03 12:44 HST: the
 * set-shaped researched question over a state shows ALL its areas
 * on the map by standing, filling in real time, with a completion
 * bar + estimated time). The specimen throughout is the owner's
 * exact question; the mechanism's generality is pinned by the
 * shape/poles units beside it (a catalog criterion in set form,
 * the mirrored politics pole, a non-Texas state).
 */

const TEXAS_QUESTION = 'Which areas of Texas are the most liberal?'
const SINGULAR_QUESTION = 'What is the most liberal city in Texas?'

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return { mode: 'sweep_filter', geographies: [], metricKeys: [], filters: [], clarificationNeeded: false, ...partial }
}

function row(zcta: string, name: string, rent: number, pop: number): AreaRow {
  return { zcta, name, metrics: { median_gross_rent: rent, population: pop }, moes: { median_gross_rent: 60 } }
}

const TX_ROWS = [
  row('78701', 'Austin, TX', 1600, 950000), row('75201', 'Dallas, TX', 1400, 1300000),
  row('76102', 'Fort Worth, TX', 1250, 980000), row('77002', 'Houston, TX', 1350, 2300000),
  row('79901', 'El Paso, TX', 950, 680000), row('79101', 'Amarillo, TX', 900, 200000),
  row('78205', 'San Antonio, TX', 1100, 1430000), row('79401', 'Lubbock, TX', 925, 260000),
  row('79843', 'Marfa, TX', 1050, 1800), row('78839', 'Crystal City, TX', 700, 6700),
  row('78401', 'Corpus Christi, TX', 1150, 320000), row('76701', 'Waco, TX', 1000, 140000),
  row('79701', 'Midland, TX', 1300, 170000), row('75701', 'Tyler, TX', 975, 105000),
]

const SOURCE = { title: 'Findings source', url: 'https://example.com/f' }
const STD_PROSE =
  'Austin, TX is widely described as the most liberal city in Texas. ' +
  'Fort Worth, TX is described as one of the most conservative large cities in Texas.'

/** Per-place findings the batch passes return, keyed by place name. */
const FINDINGS: Readonly<Record<string, string>> = {
  'Austin, TX': 'Austin, TX is described as the most liberal city in Texas.',
  'El Paso, TX': 'El Paso, TX is described as strongly Democratic and liberal-leaning.',
  'Crystal City, TX': 'Crystal City, TX is described as a liberal stronghold.',
  'Houston, TX': 'Houston, TX is described as politically mixed, with liberal and conservative areas.',
  'Fort Worth, TX': 'Fort Worth, TX is described as one of the most conservative large cities in Texas.',
  'Amarillo, TX': 'Amarillo, TX is described as deeply conservative.',
  'Lubbock, TX': 'Lubbock, TX is described as a conservative stronghold.',
}

interface Call { places: readonly string[]; queryText: string }

function breadthProvider(calls: Call[], opts?: { failBatches?: boolean }) {
  return createStubProvider({
    async research(input) {
      calls.push({ places: input.places, queryText: input.queryText })
      if (input.places.length === 1 && input.places[0] === 'Texas') {
        return { prose: STD_PROSE, sources: [SOURCE] }
      }
      if (opts?.failBatches) throw new Error('provider_down')
      const prose = input.places.map((name) => FINDINGS[name]).filter(Boolean).join(' ')
      return { prose, sources: [SOURCE] }
    },
  })
}

async function runBreadth(q: string, rows: AreaRow[], opts?: { failBatches?: boolean }) {
  const calls: Call[] = []
  const snapshots: RunProgressSnapshot[] = []
  const answer = await runAnswerPipeline({
    intent: intent({ geographies: ['Texas'] }),
    rows,
    researchQuery: q,
    researchCriteria: [q],
    queryText: q,
    provider: breadthProvider(calls, opts),
    onProgress: (s) => snapshots.push(s),
  })
  return { answer, calls, snapshots }
}

describe('breadth shape derivation', () => {
  it('the set form is the plural frame without a singular-superlative subject', () => {
    expect(questionSetForm(TEXAS_QUESTION)).toBe(true)
    expect(questionSetForm('What are the most liberal cities in Texas?')).toBe(true)
    expect(questionSetForm('Which Texas towns have the best schools?')).toBe(true)
    expect(questionSetForm(SINGULAR_QUESTION)).toBe(false)
    expect(questionSetForm('Where in Texas is it most liberal?')).toBe(false)
    expect(questionSetForm('What is the cheapest place to live in Texas?')).toBe(false)
    expect(questionSetForm(undefined)).toBe(false)
  })

  it('decomposition attaches the politics poles, mirrored by the asked pole', () => {
    const [criterion] = decomposeResearchCriteria(TEXAS_QUESTION)
    expect(criterion!.poles?.mode).toBe('terms')
    expect(criterion!.poles?.title).toBe('Political leaning')
    expect(criterion!.poles?.positiveLabel).toBe('Liberal-leaning')
    expect(criterion!.poles?.negativeLabel).toBe('Conservative-leaning')
    const [mirrored] = decomposeResearchCriteria('Which areas of Texas are the most conservative?')
    expect(mirrored!.poles?.positiveLabel).toBe('Conservative-leaning')
    expect(mirrored!.poles?.negativeLabel).toBe('Liberal-leaning')
    const [schools] = decomposeResearchCriteria('Which Texas towns have the best schools?')
    expect(schools!.poles?.mode).toBe('keywords')
    expect(schools!.poles?.positiveTerms).toContain('school')
  })

  it('the shape gate admits the specimen and refuses its neighbours', () => {
    const shape = breadthShapeFor({
      queryText: TEXAS_QUESTION,
      intent: intent({ geographies: ['Texas'] }),
      researchCriteria: decomposeResearchCriteria(TEXAS_QUESTION),
    })
    expect(shape?.geographyLabel).toBe('Texas')
    expect(shape?.criterion.poles?.title).toBe('Political leaning')
    // Singular superlative: the shipped winner path, untouched.
    expect(
      breadthShapeFor({
        queryText: SINGULAR_QUESTION,
        intent: intent({ geographies: ['Texas'] }),
        researchCriteria: decomposeResearchCriteria(SINGULAR_QUESTION),
      }),
    ).toBeNull()
    // A stated top-N bounds the set by the reader's own number.
    expect(
      breadthShapeFor({
        queryText: 'What are the top 10 most liberal areas in Texas?',
        intent: intent({ geographies: ['Texas'] }),
        researchCriteria: decomposeResearchCriteria('What are the top 10 most liberal areas in Texas?'),
      }),
    ).toBeNull()
    // Two states: no single display geography.
    expect(
      breadthShapeFor({
        queryText: TEXAS_QUESTION,
        intent: intent({ geographies: ['Texas', 'Oklahoma'] }),
        researchCriteria: decomposeResearchCriteria(TEXAS_QUESTION),
      }),
    ).toBeNull()
    // A place bound: the named place's rows are the shipped universe.
    expect(
      breadthShapeFor({
        queryText: TEXAS_QUESTION,
        intent: intent({ geographies: ['Austin'] }),
        researchCriteria: decomposeResearchCriteria(TEXAS_QUESTION),
      }),
    ).toBeNull()
    // A criteria-less ranking question carries no poles: no breadth.
    const bare = 'What are the best places to live in Texas?'
    expect(decomposeResearchCriteria(bare)[0]?.poles).toBeUndefined()
    expect(
      breadthShapeFor({
        queryText: bare,
        intent: intent({ geographies: ['Texas'] }),
        researchCriteria: decomposeResearchCriteria(bare),
      }),
    ).toBeNull()
  })
})

describe('standing derivation', () => {
  const [criterion] = decomposeResearchCriteria(TEXAS_QUESTION)
  const claim = (text: string, urls: string[] = [SOURCE.url]): ResearchedClaim => ({
    text,
    sourceUrls: urls,
  })

  it('a sourced claim carrying a pole term characterizes; a bare mention does not', () => {
    expect(placeStanding([claim('Austin, TX is the most liberal city in Texas.')], criterion!)).toBe('positive')
    expect(placeStanding([claim('Fort Worth, TX is one of the most conservative large cities in Texas.')], criterion!)).toBe('negative')
    expect(placeStanding([claim('Fort Worth, TX hosts a large stock show.')], criterion!)).toBe('unassessed')
    expect(placeStanding([], criterion!)).toBe('unassessed')
    expect(claimCharacterization(claim('Austin, TX is not liberal.'), criterion!)).toBe('negative')
    expect(
      placeStanding(
        [
          claim('Houston, TX has liberal neighborhoods.'),
          claim('Houston, TX has conservative suburbs.'),
        ],
        criterion!,
      ),
    ).toBe('mixed')
  })

  it('standings are invariant under claim order, and an uncited claim characterizes nothing', () => {
    const displaySet = [
      { name: 'Austin, TX', zcta: '78701' },
      { name: 'Fort Worth, TX', zcta: '76102' },
      { name: 'Marfa, TX', zcta: '79843' },
    ]
    const claims = [
      claim('Fort Worth, TX is described as deeply conservative.'),
      claim('Marfa, TX is described as liberal-leaning.', []),
      claim('Austin, TX is described as the most liberal city in Texas.'),
    ]
    const forward = deriveBreadthPlaces(
      { displaySet, claims, criterion: criterion! },
      {
        mentionsPlace: (c, p) => c.text.includes(p.name),
        standingForPlace: (cs, crit) => placeStanding(cs, crit),
      },
    )
    const reversed = deriveBreadthPlaces(
      { displaySet, claims: [...claims].reverse(), criterion: criterion! },
      {
        mentionsPlace: (c, p) => c.text.includes(p.name),
        standingForPlace: (cs, crit) => placeStanding(cs, crit),
      },
    )
    expect(forward.map((p) => p.standing)).toEqual(['positive', 'negative', 'unassessed'])
    expect(reversed.map((p) => p.standing)).toEqual(forward.map((p) => p.standing))
  })
})

describe('display set', () => {
  it('one representative row per place — the largest-population member — in assessment order', () => {
    const set = breadthDisplaySet([
      row('78701', 'Austin, TX', 1600, 100),
      row('78617', 'Austin, TX', 1450, 5000),
      row('75201', 'Dallas, TX', 1400, 9000),
      row('76102', 'Fort Worth, TX', 1250, 9000),
    ])
    expect(set).toEqual([
      { name: 'Dallas, TX', zcta: '75201' },
      { name: 'Fort Worth, TX', zcta: '76102' },
      { name: 'Austin, TX', zcta: '78617' },
    ])
  })

  it('the batch size never exceeds the research roster ceiling', () => {
    expect(BREADTH_BATCH_SIZE).toBeLessThanOrEqual(RESEARCH_PLACES_LIMIT)
  })
})

describe('the specimen run', () => {
  it('assesses the whole display set in roster batches and terminates candidate-led', async () => {
    const { answer, calls, snapshots } = await runBreadth(TEXAS_QUESTION, TX_ROWS)
    expect(answer.status).toBe('verified')
    // One standard pass (the state as its place) + one roster batch.
    expect(calls).toHaveLength(2)
    expect(calls[0]!.places).toEqual(['Texas'])
    const roster = calls[1]!.places
    expect(roster).toHaveLength(14)
    expect(roster[0]).toBe('Houston, TX')
    expect(new Set(roster).size).toBe(14)
    for (const call of calls) expect(call.places.length).toBeLessThanOrEqual(RESEARCH_PLACES_LIMIT)

    const breadth = answer.breadth!
    expect(breadth.geographyLabel).toBe('Texas')
    expect(breadth.criterionLabel).toBe('Political leaning')
    expect(breadth.displayTotal).toBe(14)
    expect(breadth.assessedCount).toBe(7)
    expect(breadth.standings.filter((p) => p.standing !== 'unassessed')).toHaveLength(7)
    // The card leads with the positive pole, then mixed, in
    // assessment order; the negative pole is accounted, not ranked.
    expect(answer.places.map((p) => p.name)).toEqual([
      'Austin, TX',
      'El Paso, TX',
      'Crystal City, TX',
      'Houston, TX',
    ])
    expect(answer.consideredNotMeeting).toEqual(['Fort Worth, TX', 'Lubbock, TX', 'Amarillo, TX'])
    // Assessed places carry their characterizing claims for the
    // map's click detail; an unassessed place carries none.
    const austin = breadth.standings.find((p) => p.name === 'Austin, TX')!
    expect(austin.standing).toBe('positive')
    expect((austin.claims ?? []).length).toBeGreaterThan(0)
    const marfa = breadth.standings.find((p) => p.name === 'Marfa, TX')!
    expect(marfa.standing).toBe('unassessed')
    expect(marfa.claims ?? []).toHaveLength(0)

    // Progress: the first breadth snapshot opens with the standard
    // pass's characterizations already applied (the breadth run
    // starts from that pass's yields, not from an empty map);
    // the last carries the terminal's own assessed count.
    const breadthSnapshots = snapshots.filter((s) => s.breadth)
    expect(breadthSnapshots.length).toBeGreaterThanOrEqual(2)
    expect(breadthSnapshots[0]!.breadth!.assessedCount).toBe(2)
    expect(breadthSnapshots[0]!.breadthPlaces).toHaveLength(14)
    expect(breadthSnapshots[0]!.breadthPlaces!.filter((p) => p.standing === 'unassessed')).toHaveLength(12)
    const last = breadthSnapshots[breadthSnapshots.length - 1]!
    expect(last.breadth!.assessedCount).toBe(breadth.assessedCount)
    expect(progressPercent(last)).toBe(50)

    // The strip, the counts line, and the spoken chart reference
    // all read the terminal's own record.
    expect(
      runSummaryText(last, 0, {
        assessedCount: breadth.assessedCount,
        displayTotal: breadth.displayTotal,
        geographyLabel: breadth.geographyLabel,
        elapsedMs: breadth.elapsedMs,
      }),
    ).toBe('Complete — 7 of 14 areas in Texas assessed')
    expect(breadthCountsLine(answer)).toBe(
      '7 of 14 areas in Texas were assessed from cited sources. The other 7 are shown on the map as not assessed — no cited source characterized them.',
    )
    expect(resultMapRelevant(answer)).toBe(false)
    expect(terminalChartKinds(answer)).toEqual([
      {
        kind: 'map',
        spokenName: 'the map',
        subject: 'the areas by their standing',
        sentence: 'The map shows the areas of Texas by political leaning.',
      },
    ])
  })

  it('a failed batch leaves its places unassessed and the run still completes', async () => {
    const { answer } = await runBreadth(TEXAS_QUESTION, TX_ROWS, { failBatches: true })
    expect(answer.status).toBe('verified')
    // Only the standard pass's two characterizations landed.
    expect(answer.breadth!.assessedCount).toBe(2)
    expect(answer.breadth!.displayTotal).toBe(14)
    expect(answer.places.map((p) => p.name)).toEqual(['Austin, TX'])
    expect(answer.consideredNotMeeting).toEqual(['Fort Worth, TX'])
  })

  it('the singular form never engages breadth and keeps the shipped path', async () => {
    const { answer, calls } = await runBreadth(SINGULAR_QUESTION, TX_ROWS)
    expect(answer.breadth).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(answer.places.map((p) => p.name)).toEqual(['Austin, TX', 'Fort Worth, TX'])
  })

  it('rosters partition a large display set exactly, each within the ceiling', async () => {
    const rows: AreaRow[] = []
    for (let i = 1; i <= 120; i++) {
      rows.push(row(String(76000 + i), `Place ${String(i).padStart(3, '0')}, TX`, 1000, 100000 - i))
    }
    const calls: Call[] = []
    const provider = createStubProvider({
      async research(input) {
        calls.push({ places: input.places, queryText: input.queryText })
        if (input.places.includes('Place 001, TX')) {
          return { prose: 'Place 001, TX is described as liberal.', sources: [SOURCE] }
        }
        return { prose: '', sources: [SOURCE] }
      },
    })
    const answer: ComposedAnswer = await runAnswerPipeline({
      intent: intent({ geographies: ['Texas'] }),
      rows,
      researchQuery: TEXAS_QUESTION,
      researchCriteria: [TEXAS_QUESTION],
      queryText: TEXAS_QUESTION,
      provider,
    })
    const batches = calls.filter((c) => !(c.places.length === 1 && c.places[0] === 'Texas'))
    expect(batches.map((b) => b.places.length)).toEqual([50, 50, 20])
    const rostered = batches.flatMap((b) => b.places)
    expect(new Set(rostered).size).toBe(120)
    expect(answer.breadth!.displayTotal).toBe(120)
    expect(answer.breadth!.assessedCount).toBe(1)
  })
})

describe('progress v2 — percent, ETA, and the strip', () => {
  it('the ETA is rate-derived, labeled, and absent before a rate exists', () => {
    expect(estimateRemainingMs(0, 100, 5000)).toBeNull()
    expect(estimateRemainingMs(5, 100, 999)).toBeNull()
    expect(estimateRemainingMs(5, 100, 5000)).toBe(95000)
    expect(estimateRemainingMs(100, 100, 5000)).toBe(0)
    expect(durationText(3000)).toBe('a few seconds')
    expect(durationText(40000)).toBe('about 40 seconds')
    expect(durationText(60000)).toBe('about a minute')
    expect(durationText(150000)).toBe('about 3 minutes')
  })

  it('the situational line carries the ETA clause only when an estimate exists', () => {
    const base: RunProgressSnapshot = {
      doneUnits: 1,
      totalUnits: 27,
      criteriaTotal: 1,
      criteriaDone: ['Outside-Census criteria'],
      criteriaFailed: [],
      places: [],
      breadth: {
        displayTotal: 100,
        assessedCount: 5,
        elapsedMs: 5000,
        etaMs: 95000,
        geographyLabel: 'Texas',
        criterionLabel: 'Political leaning',
        labels: {
          positive: 'Liberal-leaning',
          negative: 'Conservative-leaning',
          mixed: 'Mixed',
          unassessed: 'Not yet assessed',
        },
      },
      breadthPlaces: [],
    }
    expect(situationalText(base, 0)).toBe(
      '5 of 100 areas in Texas assessed · about 2 minutes left — estimate',
    )
    expect(situationalText({ ...base, breadth: { ...base.breadth!, etaMs: null } }, 0)).toBe(
      '5 of 100 areas in Texas assessed',
    )
    expect(progressPercent(base)).toBe(5)
  })

  it('the strip stamps the terminal counts and the actual elapsed time', () => {
    const snapshot: RunProgressSnapshot = {
      doneUnits: 27,
      totalUnits: 27,
      criteriaTotal: 1,
      criteriaDone: ['Outside-Census criteria'],
      criteriaFailed: [],
      places: [],
    }
    expect(
      runSummaryText(snapshot, 0, {
        assessedCount: 900,
        displayTotal: 1282,
        geographyLabel: 'Texas',
        elapsedMs: 125000,
      }),
    ).toBe('Complete — 900 of 1282 areas in Texas assessed · took about 2 minutes')
    // No terminal breadth record — a breadth-abandoned run's
    // strip is the standard text even on a breadth snapshot.
    expect(runSummaryText(snapshot, 3)).toBe('Complete — 27 of 27 checks done · 3 places assessed')
  })

  it('the new code-authored copy passes the working-narration filter unchanged', () => {
    const copies = [
      'Complete — 7 of 14 areas in Texas assessed',
      '5 of 100 areas in Texas assessed · about 2 minutes left — estimate',
      '7 of 14 areas in Texas were assessed from cited sources. The other 7 are shown on the map as not assessed — no cited source characterized them.',
      'Liberal-leaning',
      'Conservative-leaning',
      'Not yet assessed',
    ]
    for (const copy of copies) {
      expect(filterWorkingNarration(copy, [SOURCE]).prose).toBe(copy)
    }
  })
})
