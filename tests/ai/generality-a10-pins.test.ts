import { describe, expect, it } from 'vitest'
import {
  bindResolvedCandidates,
  candidateBoundForInput,
  claimMentionsPlace,
  extractBareCandidateNames,
  runAnswerPipeline,
  type ComposedAnswer,
  type ResolvedCandidate,
  type RunProgressSnapshot,
} from '../../src/core/ai/answer'
import { outOfBoundCandidatesLine, unresolvedCandidatesLine } from '../../src/ui/ai/AnswerCard'
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

/* ------------------------------------------------------------------ */
/* FM-14 — extraction precision (the sheet-A fragment specimens)       */
/* ------------------------------------------------------------------ */

const FL_ROWS = [
  row('32208', 'Jacksonville, FL', 1250),
  row('33101', 'Miami, FL', 2100),
  row('33602', 'Tampa, FL', 1650),
  row('32801', 'Orlando, FL', 1550),
  row('32301', 'Tallahassee, FL', 1100),
  row('33901', 'Fort Myers, FL', 1700),
  row('34102', 'Naples, FL', 2300),
  row('32501', 'Pensacola, FL', 1050),
  row('33701', 'St. Petersburg, FL', 1450),
]

// The FL weather specimen's prose shape (sheet A Q1): research
// engaged and returned material, but its sentences open with
// fragments, and the one real place mention is a partial name.
const FL_FRAGMENT_PROSE =
  'Initial findings cover the whole coast. ' +
  'Described as mild year-round, the climate suits most visitors. ' +
  'January-April is the driest window for outdoor plans. ' +
  'Another consideration is hurricane season. ' +
  'No month averages below sixty degrees. ' +
  'Petersburg appears in several guides to the bay area.'

const VT_ROWS = [
  row('05401', 'Burlington, VT', 1500),
  row('05301', 'Brattleboro, VT', 1050),
  row('05602', 'Montpelier, VT', 1100),
  row('05701', 'Rutland, VT', 900),
  row('05201', 'Bennington, VT', 950),
  row('05819', 'St. Johnsbury, VT', 800),
  row('05478', 'St. Albans, VT', 1000),
  row('05641', 'Barre, VT', 850),
  row('05001', 'White River Junction, VT', 1050),
  row('05346', 'Middlebury, VT', 1200),
  row('05672', 'Stowe, VT', 1320),
]

describe('FM-14 extraction precision (unit, verbatim sheet-A lists)', () => {
  it('the FL weather fragments are counted, never recorded; the partial name is recorded', () => {
    const bare = extractBareCandidateNames(FL_FRAGMENT_PROSE, [], FL_ROWS)
    expect(bare.unresolved).toEqual(['Petersburg'])
    expect(bare.names).toEqual([])
    expect(bare.ambiguous).toEqual([])
    // Initial, Described, January-April, Another, No.
    expect(bare.fragments).toBe(5)
  })

  it('the OR charming specimen list contributes zero recorded names', () => {
    const orRows = [
      row('97103', 'Astoria, OR', 1150),
      row('97365', 'Newport, OR', 1200),
      row('97110', 'Cannon Beach, OR', 1600),
      row('97439', 'Florence, OR', 1050),
      row('97411', 'Bandon, OR', 1100),
      row('97415', 'Brookings, OR', 1150),
      row('97367', 'Lincoln City, OR', 1250),
      row('97138', 'Seaside, OR', 1300),
    ]
    const prose =
      "Now I'll survey the coast towns next. " +
      'No town on the list is large. ' +
      'Downtown districts vary in charm. ' +
      'One account after another praises the main streets. ' +
      'Maritime Museum exhibits anchor the harbor towns. ' +
      'Known for its galleries, the town draws weekend visitors. ' +
      'Described as storybook, the village keeps its historic facades. ' +
      'Boutique inns line the quiet streets. ' +
      'Howard. ' +
      'Called the prettiest town in the state by one guide, it keeps a busy farmers market. ' +
      'Also notable are the river walks. ' +
      'What gives the town its character is the preserved architecture. ' +
      'They say the lighthouse views complete the picture.'
    const bare = extractBareCandidateNames(prose, [], orRows)
    expect(bare.unresolved).toEqual([])
    expect(bare.names).toEqual([])
    // Now I'll, No, Downtown, One, Maritime Museum, Known,
    // Described, Boutique, Howard., Called, Also, What, They.
    expect(bare.fragments).toBe(13)
  })

  it('the VT beer fragments are counted; the hyphenated area form is recorded as written (FM-16 normalizes it)', () => {
    const prose =
      'Early reviews praise the variety on offer. ' +
      'BeerAdvocate ranks the state near the top for selection. ' +
      'Stowe-area draws skiers and beer travelers alike.'
    const bare = extractBareCandidateNames(prose, [], VT_ROWS)
    expect(bare.unresolved).toEqual(['Stowe-area'])
    // Early, BeerAdvocate.
    expect(bare.fragments).toBe(2)
  })
})

describe('FM-14 extraction precision (pipeline)', () => {
  it('narration never reaches extraction, and fragments are counted on the answer, not printed as names', async () => {
    const q = 'What town in Vermont has the best beer selection?'
    const prose =
      "Now I'll check the remaining towns next. " +
      'Early reviews praise the variety on offer in the state. ' +
      'BeerAdvocate ranks Vermont near the top for selection. ' +
      'Burlington, VT anchors the scene with the widest tap lists in the state. ' +
      'Stowe-area draws skiers and beer travelers alike.'
    const answer = await runPipeline({ q, intent: { geographies: ['Vermont'], metricKeys: [] }, rows: VT_ROWS, prose })
    // FM-16 (cluster 3) completes the hyphenated area form against
    // the bound index: Stowe-area now resolves to Stowe, VT and
    // cards (under FM-14 alone it was recorded as written).
    expect(answer.places.map((p) => p.name)).toEqual(['Burlington, VT', 'Stowe, VT'])
    expect(answer.unresolvedCandidates).toEqual([])
    // Early + BeerAdvocate reached extraction and were gated out;
    // the narration sentence was filtered before extraction and is
    // not part of the count.
    expect(answer.unmatchedFragmentCount).toBe(2)
    expect(JSON.stringify(answer.unresolvedCandidates)).not.toContain("Now I'll")
  })

  it('the FL weather shape under FM-14 alone: nothing materializes, fragments counted, the partial name the only recorded one', async () => {
    // The unit-level FM-14 reading (no bound index supplied to the
    // bare pass) stands in the unit pins above; at pipeline level
    // FM-16's completion now applies — see the FM-16 section.
    const q = 'What city in Florida has the best weather year-round?'
    const answer = await runPipeline({
      q,
      intent: { geographies: ['Florida'], metricKeys: [] },
      rows: FL_ROWS,
      prose: FL_FRAGMENT_PROSE,
    })
    expect(answer.unmatchedFragmentCount).toBe(5)
    expect(answer.unresolvedCandidates).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* FM-16 — name normalization against the bound index                  */
/* ------------------------------------------------------------------ */

describe('FM-16 name normalization (unit)', () => {
  it('a suffix completion resolves when the bound index holds exactly one ("Petersburg" -> St. Petersburg, FL)', () => {
    const bare = extractBareCandidateNames(
      'Petersburg appears in several guides to the bay area.',
      [],
      FL_ROWS,
      FL_ROWS,
    )
    expect(bare.names).toEqual(['St. Petersburg, FL'])
    expect(bare.unresolved).toEqual([])
    expect(bare.ambiguous).toEqual([])
  })

  it('the bound disambiguates what the nation leaves ambiguous (Petersburg, VA in the full row set)', () => {
    const national = [...FL_ROWS, row('23803', 'Petersburg, VA', 900)]
    const bare = extractBareCandidateNames(
      'Petersburg appears in several guides to the bay area.',
      [],
      national,
      FL_ROWS,
    )
    expect(bare.names).toEqual(['St. Petersburg, FL'])
    expect(bare.ambiguous).toEqual([])
  })

  it('a hyphenated area form resolves through its head ("Stowe-area" -> Stowe, VT)', () => {
    const bare = extractBareCandidateNames(
      'Stowe-area draws skiers and beer travelers alike.',
      [],
      VT_ROWS,
      VT_ROWS,
    )
    expect(bare.names).toEqual(['Stowe, VT'])
    expect(bare.unresolved).toEqual([])
  })

  it('two distinct bound completions are recorded as ambiguous, never guessed', () => {
    const bound = [row('33701', 'St. Petersburg, FL', 1450), row('33702', 'Fort Petersburg, FL', 1300)]
    const bare = extractBareCandidateNames(
      'Petersburg appears in several guides to the bay area.',
      [],
      bound,
      bound,
    )
    expect(bare.names).toEqual([])
    expect(bare.ambiguous).toEqual(['Petersburg'])
  })

  it('no bound index: normalization does not run and the written form is the record', () => {
    const bare = extractBareCandidateNames(
      'Stowe-area draws skiers and beer travelers alike.',
      [],
      VT_ROWS,
    )
    expect(bare.names).toEqual([])
    expect(bare.unresolved).toEqual(['Stowe-area'])
  })
})

describe('FM-16 name normalization (pipeline)', () => {
  it('the FL weather specimen: the partial name completes and the did-not-name terminal becomes a card', async () => {
    const q = 'What city in Florida has the best weather year-round?'
    const answer = await runPipeline({
      q,
      intent: { geographies: ['Florida'], metricKeys: [] },
      rows: FL_ROWS,
      prose: FL_FRAGMENT_PROSE,
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toEqual(['St. Petersburg, FL'])
    expect(answer.unresolvedCandidates).toEqual([])
    expect(answer.unmatchedFragmentCount).toBe(5)
  })
})

/* ------------------------------------------------------------------ */
/* FM-17 — unmatched-line presentation: names print, fragments count   */
/* ------------------------------------------------------------------ */

function lineAnswer(partial: {
  status?: string
  unresolvedCandidates?: string[]
  unmatchedFragmentCount?: number
}): ComposedAnswer {
  return {
    status: 'empty',
    unresolvedCandidates: [],
    ...partial,
  } as unknown as ComposedAnswer
}

describe('FM-17 unmatched-line presentation (unit)', () => {
  it('names only: the shipped wording is verbatim, singular and plural', () => {
    expect(unresolvedCandidatesLine(lineAnswer({ unresolvedCandidates: ['Fort'] }))).toBe(
      'Research named Fort, which could not be matched to Census data, so it was not used.',
    )
    expect(unresolvedCandidatesLine(lineAnswer({ unresolvedCandidates: ['Fort', 'Palm'] }))).toBe(
      'Research named Fort, Palm, which could not be matched to Census data, so they were not used.',
    )
  })

  it('names plus fragments: the count rides as a second sentence, tokens never print', () => {
    const line = unresolvedCandidatesLine(
      lineAnswer({ unresolvedCandidates: ['Fort'], unmatchedFragmentCount: 5 }),
    )
    expect(line).toBe(
      'Research named Fort, which could not be matched to Census data, so it was not used. ' +
        '5 further names in the findings could not be matched to Census data either.',
    )
    expect(
      unresolvedCandidatesLine(lineAnswer({ unresolvedCandidates: ['Fort'], unmatchedFragmentCount: 1 })),
    ).toBe(
      'Research named Fort, which could not be matched to Census data, so it was not used. ' +
        '1 further name in the findings could not be matched to Census data either.',
    )
  })

  it('fragments only: the line is the count alone, in the same plain wording', () => {
    expect(unresolvedCandidatesLine(lineAnswer({ unmatchedFragmentCount: 5 }))).toBe(
      '5 names in the findings could not be matched to Census data, so they were not used.',
    )
    expect(unresolvedCandidatesLine(lineAnswer({ unmatchedFragmentCount: 1 }))).toBe(
      '1 name in the findings could not be matched to Census data, so it was not used.',
    )
  })

  it('nothing recorded: no line; a flexible answer never carries the line', () => {
    expect(unresolvedCandidatesLine(lineAnswer({}))).toBeNull()
    expect(
      unresolvedCandidatesLine(lineAnswer({ status: 'flexible', unmatchedFragmentCount: 5 })),
    ).toBeNull()
  })
})

describe('FM-17 unmatched-line presentation (pipeline)', () => {
  it('a place-shaped unmatched name prints; the sheet-A fragments are counted beside it', async () => {
    const q = 'What city in Florida has the best weather year-round?'
    const prose = FL_FRAGMENT_PROSE + ' Fort sits on the river bend.'
    const answer = await runPipeline({
      q,
      intent: { geographies: ['Florida'], metricKeys: [] },
      rows: FL_ROWS,
      prose,
    })
    expect(answer.places.map((p) => p.name)).toEqual(['St. Petersburg, FL'])
    expect(answer.unresolvedCandidates).toEqual(['Fort'])
    expect(unresolvedCandidatesLine(answer)).toBe(
      'Research named Fort, which could not be matched to Census data, so it was not used. ' +
        '5 further names in the findings could not be matched to Census data either.',
    )
  })
})

/* ------------------------------------------------------------------ */
/* FM-19 — claim-place attribution (the sheet-B Early/Austin specimen) */
/* ------------------------------------------------------------------ */

const TX_ROWS = [
  row('78617', 'Austin, TX', 1449),
  row('76802', 'Early, TX', 700),
  row('78834', 'Crystal City, TX', 448),
  row('79843', 'Marfa, TX', 460),
]
const TX_Q = 'what city in Texas is the most liberal'

describe('FM-19 claim-place attribution (unit)', () => {
  const claim = (text: string) => ({ text, sourceUrls: ['https://example.com/f'] })

  it('a ZCTA matches as a standalone token, never inside a longer figure', () => {
    const early = { name: 'Early, TX', zcta: '76802' }
    expect(claimMentionsPlace(claim('Austin is home to 768021 registered voters.'), early)).toBe(false)
    expect(claimMentionsPlace(claim('The ZIP 76802 covers the town.'), early)).toBe(true)
    expect(claimMentionsPlace(claim('Early, TX (76802) is a small town.'), early)).toBe(true)
    expect(
      claimMentionsPlace(claim('Austin, TX is home to many voters.'), { name: 'Austin, TX', zcta: '78617' }),
    ).toBe(true)
  })

})

describe('FM-19 claim-place attribution (the sheet-B specimen, hermetic)', () => {
  it('borrowed evidence is impossible: Austin findings render under Austin or as general claims, never under Early', async () => {
    const prose =
      'Crystal City, TX is described as the bluest town in red Texas, with Democratic margins among the largest in the state. ' +
      'Austin is still the most liberal major city in Texas. ' +
      'Austin, TX pairs that standing with a large university population and a deep bench of progressive organizations. ' +
      'Early returns from the canvass point the same way as the endorsements. ' +
      'Marfa, TX draws a smaller but durable liberal community around its arts institutions.'
    const answer = await runPipeline({
      q: TX_Q,
      intent: { geographies: ['Texas'], metricKeys: [] },
      rows: TX_ROWS,
      prose,
    })
    const early = answer.places.find((p) => p.name === 'Early, TX')
    // The recorded boundary (FM-19 diagnosis): the fragment token
    // in name position still materializes Early — no deterministic
    // form test separates it from a terse finding — but it cards
    // CLAIMLESS. The sheet-B harm was the borrowed evidence:
    // Austin's sentences rendered as Early's. That is what is
    // pinned shut here.
    expect(early).toBeDefined()
    expect(early!.claims).toEqual([])
    expect(answer.places.find((p) => p.name === 'Austin, TX')!.claims.map((c) => c.text)).toEqual([
      'Austin, TX pairs that standing with a large university population and a deep bench of progressive organizations.',
    ])
    // The bare-form Austin finding attributes nowhere strictly and
    // stays a general claim — it is not borrowed onto any place.
    expect(answer.generalClaims.map((c) => c.text)).toContain(
      'Austin is still the most liberal major city in Texas.',
    )
  })

  it('a figure carrying another place ZIP digits attributes nowhere (768021 is not 76802)', async () => {
    const prose =
      'Crystal City, TX is described as the bluest town in red Texas. ' +
      'Austin is home to 768021 registered voters across its precincts, the largest liberal electorate in the state. ' +
      'Early returns from the canvass point the same way as the endorsements.'
    const answer = await runPipeline({
      q: TX_Q,
      intent: { geographies: ['Texas'], metricKeys: [] },
      rows: TX_ROWS,
      prose,
    })
    // Before the cure this claim attached to Early, TX (its ZIP
    // sits inside the figure). Now it attributes to no place and
    // stays a general claim; no place carries it as evidence.
    expect(answer.places.flatMap((p) => p.claims.map((c) => c.text))).toEqual([
      'Crystal City, TX is described as the bluest town in red Texas.',
    ])
    expect(answer.generalClaims.map((c) => c.text)).toContain(
      'Austin is home to 768021 registered voters across its precincts, the largest liberal electorate in the state.',
    )
    expect(answer.places.find((p) => p.name === 'Early, TX')!.claims).toEqual([])
    expect(answer.places.map((p) => p.name)).toContain('Austin, TX')
  })

  it('a candidate whose only claim is refused for its form still cards — claimless, never borrowed (the design boundary)', async () => {
    const prose =
      'Crystal City, TX is described as the bluest town in red Texas. ' +
      'Early, TX is the worst town in the state for a liberal household, by every account.'
    const answer = await runPipeline({
      q: TX_Q,
      intent: { geographies: ['Texas'], metricKeys: [] },
      rows: TX_ROWS,
      prose,
    })
    // The Early sentence is a ranking construction with a place
    // predication: compose refuses the claim for its FORM, as it
    // refuses the A9 battery's "has the best..." lead claims —
    // while extraction still elects their places. That posture
    // is the measured design (FM-19 investigation record): claim
    // survival cannot testify about description, so there is no
    // materialization partition. Early cards with no claims; the
    // refused claim is in droppedClaims, and nothing of
    // Crystal City's renders under Early.
    const early = answer.places.find((p) => p.name === 'Early, TX')
    expect(early).toBeDefined()
    expect(early!.claims).toEqual([])
    expect(answer.droppedClaims.map((c) => c.text)).toContain(
      'Early, TX is the worst town in the state for a liberal household, by every account.',
    )
  })
})
