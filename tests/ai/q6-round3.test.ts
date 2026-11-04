import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  claimMentionsPlace,
  decomposeResearchCriteria,
  extractBareCandidateNames,
  extractCandidateNamesFromProse,
  filterWorkingNarration,
  placeDirectionNegative,
  resolveCandidatesAgainstRows,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import { createStubProvider } from '../../src/core/ai/provider'
import { decodePlaces } from '../../src/core/zcta-place-index'
import { composeFlexibleCompletion } from '../../src/ui/ai/flexible-runner'

/**
 * Q6 round 3 (2026-11-04): the demo question dead-ended a third
 * time on production 0aacd29b — research ran, named candidate
 * strings, grounded ZERO, and the terminal reported the criteria
 * unmeasurable. The RCA captured the production research route's
 * actual returns for this question's pipeline shapes (verbatim
 * below, 2026-11-04 ~04:5x HST, two calls spaced per the probing
 * discipline):
 *
 * - The base shape (the question verbatim, no named places)
 *   returns methodology prose and declines to name any place:
 *   the research system prompt's contract ("research ONLY the
 *   named places") is the screen path's, and on the research-first
 *   path there are no named places — research itself must
 *   nominate.
 * - The steered shape (the K1 re-ask's sentence) names its real
 *   candidates BARE (Berkeley, Cambridge, Carlsbad — ambiguous
 *   nationally, recorded, never retried) and two further places
 *   with state suffixes only to EXCLUDE them (Arlington,
 *   Virginia; The Woodlands, Texas) — extraction grounded exactly
 *   the excluded pair.
 *
 * The pins below run the captured prose over the shipped national
 * place index (the production row set's names), not a fixture
 * subset: the ambiguity this class turns on is a national property.
 */

const Q6 = 'Where can I find the best schools but also the fewest fast food restaurants?'

/** Captured live return, base shape (POST /api/muse/research, question verbatim, places []). */
export const CAPTURED_BASE_PROSE =
  "No specific places were named, so I'll gather authoritative background on measuring school quality and fast-food density. I've confirmed the school rating methods; now I'll verify the fast-food data source. No named places were provided to research, so no place can be named as meeting ALL of your criteria. It is based on up to three themed ratings, including Student Progress, College Readiness, and Test Score Rating based on state-standardized test performance. Only public schools receive GreatSchools ratings because the ratings rely on publicly available state education data. Department of Education along with test scores, college data, and ratings from millions of users. Its Academics Grade, based on state assessment proficiency, college enrollment data, and survey responses, carries 60.0% weight. * **Fewest fast food restaurants:** The USDA Food Environment Atlas is a county-level interactive data map that displays fast food restaurants and expenditures at fast food restaurants for all counties in the U.S. Produced by the USDA Economic Research Service, it assembles county-level statistics on food environment indicators, such as food choices, health and well-being and community characteristics. To identify specific places, Census-screened places would need to be named, then school ratings and county fast-food counts checked place-by-place."
export const CAPTURED_BASE_SOURCES = [
  { title: 'GreatSchools ratings methodology report', url: 'https://www.greatschools.org/gk/about/ratings-methodology/' },
  { title: 'Understanding GreatSchools ratings', url: 'https://www.GreatSchools.org/gk/parenting/school-ratings/understanding-greatschools-ratings/' },
  { title: 'GreatSchools Ratings: A Comprehensive Analysis', url: 'http://flyriver.com/g/greatschools-ratings' },
  { title: 'How School Ratings Actually Work (and Miss)', url: 'https://allk12.com/blog/how-school-ratings-actually-work' },
  { title: 'Understanding GreatSchools Data – ApartmentHomeLiving.com', url: 'https://image.apartmenthomeliving.com/info/greatschools' },
  { title: 'GreatSchools', url: 'https://en.wikipedia.org/wiki/GreatSchools' },
  { title: 'Are you only researching on GreatSchools when choosing a school?', url: 'https://fairfax.homebyschool.com/are-you-only-using-greatschools-when-choosing-a-school/' },
  { title: 'The murky middle: What an average school rating means', url: 'https://www.greatschools.org/gk/articles/what-average-greatschools-ratings-mean' },
]

/** Captured live return, steered shape (the K1 re-ask's query text, places []). */
export const CAPTURED_STEERED_PROSE =
  "I found promising leads on school rankings and fast-food density. Now I'll open those sources to identify specific qualifying cities. I've mapped the top school districts. Next I'll verify which of those cities also have the lowest fast-food concentration. Niche ranking is a weighted average of public-school grades factoring test scores, graduation rates, SAT and ACT scores, teacher quality, and student and parent reviews. * **Fast food:** Priceonomics / Datafiniti analysis of restaurant locations adjusted for population. New York City has the fewest per person, and California cities like Los Angeles, San Francisco, and Oakland don't have much fast food either. States with fewest are mainly in Northeast with Vermont, New Jersey, and New York taking top three spots. Berkeley Unified School District serves students in a city anchored by University of California, Berkeley. Exact fast-food per-capita count for Berkeley is not given in the text of the fast-food source; support is at state / regional level: California cities dominate the fewest-fast-food city list, with San Francisco and Oakland named as low-fast-food examples in the same Bay Area. Cambridge Public Schools offers academic programs with Cambridge Rindge and Latin School as public high school. Exact fast-food per-capita count for Cambridge is not given in the text; support is at regional level: Eastern region has fewest with just 2.5 fast food restaurants per 10K residents. Carlsbad Unified School District includes Carlsbad High School and Sage Creek High School. Same fast-food caveat as Berkeley: exact Carlsbad count not given, but California concentration in fewest-fast-food cities applies. Excluded from this list even though high-ranked for schools: Arlington, Virginia and The Woodlands, Texas, because Stacker notes Arlington, Virginia, is a county, and The Woodlands, Texas, is an unincorporated master-planned community."
export const CAPTURED_STEERED_SOURCES = [
  { title: 'Best and Worst US Cities for Foodies', url: 'https://www.accessadventure.net/best-and-worst-us-cities-for-foodies/' },
  { title: 'Ranking The Places With The Most (And Least) Fast Food', url: 'https://priceonomics.com/ranking-the-places-with-the-most-and-least-fast/' },
]

/**
 * The grounding re-ask's yield, shaped on the captured steered
 * prose's own candidates and findings (the same places, the same
 * regional fast-food support, the 2.5-per-10K figure the captured
 * prose itself carries) with each candidate written in the
 * groundable "City, State" form the re-ask requests.
 */
const GROUNDING_PROSE =
  'Berkeley, California: Berkeley Unified School District serves the city, and California cities like Berkeley are named among those with the fewest fast-food restaurants per person. ' +
  'Cambridge, Massachusetts: Cambridge Public Schools serves the city, and the Eastern region around Cambridge has just 2.5 fast food restaurants per 10K residents, the fewest of any region. ' +
  'Carlsbad, California: Carlsbad Unified School District serves the city, and Carlsbad is on the California list of cities with the fewest fast-food restaurants.'

function nationalRows(): AreaRow[] {
  const payload = JSON.parse(readFileSync('public/map/zcta-places.json', 'utf8'))
  const { byZip } = decodePlaces(payload)
  return [...byZip.values()].map((rec) => ({
    zcta: rec.zip,
    name: `${rec.displayName}, ${rec.state}`,
    metrics: { median_gross_rent: 1000 },
    moes: { median_gross_rent: 50 },
  })) as AreaRow[]
}

const Q6_INTENT = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
} as const

/* ------------------------------------------------------------------ */
/* The seams over the captured prose                                   */
/* ------------------------------------------------------------------ */

describe('Q6 round 3: the captured base yield names no groundable place', () => {
  it('extraction over the captured base prose is empty in every channel', () => {
    const rows = nationalRows()
    const hygienic = filterWorkingNarration(CAPTURED_BASE_PROSE, CAPTURED_BASE_SOURCES).prose
    const std = extractCandidateNamesFromProse(hygienic)
    const bare = extractBareCandidateNames(hygienic, std, rows, undefined, CAPTURED_BASE_SOURCES.map((s) => s.title))
    expect(std).toEqual([])
    expect(bare.names).toEqual([])
    expect(bare.ambiguous).toEqual([])
    expect(bare.unresolved).toEqual([])
  })
})

describe('Q6 round 3: the captured steered yield — real candidates bare, excluded places suffixed', () => {
  it('extraction grounds the excluded pair and records the real candidates as ambiguous', () => {
    const rows = nationalRows()
    const hygienic = filterWorkingNarration(CAPTURED_STEERED_PROSE, CAPTURED_STEERED_SOURCES).prose
    const std = extractCandidateNamesFromProse(hygienic)
    const bare = extractBareCandidateNames(hygienic, std, rows, undefined, CAPTURED_STEERED_SOURCES.map((s) => s.title))
    const resolved = resolveCandidatesAgainstRows([...std, ...bare.names], rows)
    // The two places the prose names with suffixes are the two it
    // excludes; both resolve against the national index.
    expect(resolved.map((r) => r.name)).toEqual(['Arlington, VA', 'The Woodlands, TX'])
    // The places the prose puts forward ride bare and ambiguous.
    expect(bare.ambiguous).toContain('Cambridge')
    expect(bare.ambiguous.some((n) => n.startsWith('Berkeley'))).toBe(true)
    expect(bare.ambiguous.some((n) => n.startsWith('Carlsbad'))).toBe(true)
  })

  it('a full-state-name mention attributes to the abbreviated row, and only to its own state', () => {
    const claim = {
      text: 'Excluded from this list even though high-ranked for schools: Arlington, Virginia and The Woodlands, Texas, because Stacker notes Arlington, Virginia, is a county.',
      sourceUrls: ['https://example.org/x'],
    }
    expect(claimMentionsPlace(claim, { name: 'Arlington, VA', zcta: '22201' })).toBe(true)
    expect(claimMentionsPlace(claim, { name: 'The Woodlands, TX', zcta: '77380' })).toBe(true)
    // The same bare name in another state is not matched by the
    // Virginia mention: the state rides in the mention itself.
    expect(claimMentionsPlace(claim, { name: 'Arlington, WA', zcta: '98223' })).toBe(false)
  })

  it('an explicit exclusion is direction-negative for the place it excludes', () => {
    const criteria = decomposeResearchCriteria(Q6)
    const exclusion = {
      text: 'Excluded from this list even though high-ranked for schools: Arlington, Virginia and The Woodlands, Texas, because Stacker notes Arlington, Virginia, is a county, and The Woodlands, Texas, is an unincorporated master-planned community.',
      sourceUrls: ['https://example.org/x'],
    }
    expect(placeDirectionNegative([exclusion], criteria)).toBe(true)
    // Control: a positive serving claim about a place is not negative.
    const positive = {
      text: 'Carmel, IN is described as having the strongest school ratings of the group and few fast-food outlets.',
      sourceUrls: ['https://example.org/x'],
    }
    expect(placeDirectionNegative([positive], criteria)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* The traversal: captured prose in, grounded card out                 */
/* ------------------------------------------------------------------ */

/**
 * A provider modelling the live route's response surface, keyed
 * on the request shape exactly as the pipeline composes it:
 * the grounding re-ask (candidate names in the places slot)
 * returns the grounding yield; a nomination-steered pass returns
 * the captured steered yield; an unsteered pass returns the
 * captured base yield.
 */
function liveShapedProvider(grounding: boolean) {
  const calls: { queryText: string; places: string[] }[] = []
  const provider = createStubProvider({
    async research(req: { queryText: string; places?: string[] }) {
      calls.push({ queryText: req.queryText, places: [...(req.places ?? [])] })
      if (grounding && (req.places?.length ?? 0) > 0) {
        return { prose: GROUNDING_PROSE, sources: CAPTURED_STEERED_SOURCES }
      }
      if (req.queryText.includes('specific incorporated cities or towns')) {
        return { prose: CAPTURED_STEERED_PROSE, sources: CAPTURED_STEERED_SOURCES }
      }
      return { prose: CAPTURED_BASE_PROSE, sources: CAPTURED_BASE_SOURCES }
    },
  })
  return { provider, calls }
}

describe('Q6 round 3: the demo question over the captured live prose', () => {
  it('first pass asks for nominations; the grounding re-ask carries the ungrounded names; the card grounds them', async () => {
    const { provider, calls } = liveShapedProvider(true)
    const answer = await runAnswerPipeline({
      intent: { ...Q6_INTENT },
      rows: nationalRows(),
      researchQuery: Q6,
      queryText: Q6,
      provider,
    })
    // The first pass carries the nomination steering (the bare
    // question is the shape that returned the no-place yield).
    expect(calls[0]!.queryText).toContain('specific incorporated cities or towns')
    // The disambiguation attempt happened: a later call carried
    // the ungrounded candidate names in the places slot.
    expect(calls.some((c) => c.places.includes('Cambridge'))).toBe(true)
    // The card: the research's own candidates, grounded.
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Berkeley, CA', 'Cambridge, MA', 'Carlsbad, CA']),
    )
    // The excluded places the first yield grounded are accounted
    // as considered-and-not-meeting, never as answers.
    expect(answer.consideredNotMeeting).toContain('Arlington, VA')
    expect(answer.consideredNotMeeting).toContain('The Woodlands, TX')
    expect(answer.places.map((p) => p.name)).not.toContain('Arlington, VA')
    expect(answer.places.map((p) => p.name)).not.toContain('The Woodlands, TX')
    // Neither criterion carries the no-place verdict.
    for (const label of ['School quality', 'Fast food restaurants']) {
      const entry = answer.criterionEvidence.find((e) => e.criterion === label)
      expect(entry?.status).not.toBe('not_measurable')
    }
  })

  it('without a grounding yield, the terminal is the floor’s material, never the bare dead end', async () => {
    const { provider } = liveShapedProvider(false)
    const answer = await runAnswerPipeline({
      intent: { ...Q6_INTENT },
      rows: nationalRows(),
      researchQuery: Q6,
      queryText: Q6,
      provider,
    })
    // The excluded places are partitioned out even when nothing
    // rescues the run.
    expect(answer.consideredNotMeeting).toContain('Arlington, VA')
    expect(answer.consideredNotMeeting).toContain('The Woodlands, TX')
    expect(answer.places).toEqual([])
    // The strict terminal carries the completion lane's material
    // (the names the research produced) and its marker — the
    // runner's fall-through engages on exactly this record.
    expect(answer.noCensusMatch).toBe(true)
    expect(answer.researchNamedPlaces?.length).toBeGreaterThan(0)
    expect(answer.researchNamedPlaces).toContain('Cambridge')
  })
})

/* ------------------------------------------------------------------ */
/* The floor: a zero-place completion is not a terminal                */
/* ------------------------------------------------------------------ */

function fragmentOnlyStrictAnswer(): ComposedAnswer {
  return {
    status: 'empty',
    stage: 'verify',
    criteria: [],
    droppedCriteria: [],
    unresolvedGeographies: [],
    screenedCount: 0,
    places: [],
    generalClaims: [
      { text: 'Only public schools receive GreatSchools ratings because the ratings rely on publicly available state education data.', sourceUrls: ['https://example.org/a'] },
      { text: 'The USDA Food Environment Atlas displays fast food restaurants for all counties in the U.S.', sourceUrls: ['https://example.org/b'] },
    ],
    sources: [
      { title: 'GreatSchools ratings methodology report', url: 'https://example.org/a' },
      { title: 'USDA Food Environment Atlas', url: 'https://example.org/b' },
    ],
    summary: 'Research for the stated criteria did not produce a place that could be shown here.',
    failures: [],
    researchCriteria: [
      { id: 'schools', label: 'School quality' },
      { id: 'fast_food', label: 'Fast food restaurants' },
    ],
    criterionEvidence: [],
    unresolvedCandidates: [],
    // The fragment-only record: claims exist, no name was recorded.
    researchNamedPlaces: [],
    noCensusMatch: true,
  } as unknown as ComposedAnswer
}

describe('Q6 round 3: the flexible floor rejects a zero-place completion when material exists', () => {
  it('a zero-place draft is re-drafted once, and the place-naming re-draft completes', async () => {
    let calls = 0
    const outcome = await composeFlexibleCompletion({
      queryText: Q6,
      strictAnswer: fragmentOnlyStrictAnswer(),
      rows: [],
      criteria: [],
      deps: {
        flexibleTransport: async () => {
          calls += 1
          return calls === 1
            ? { prose: 'No place can be shown for these criteria.', places: [], figures: [] }
            : {
                prose: 'Berkeley is offered from general knowledge for the stated criteria.',
                places: [{ name: 'Berkeley, CA', basis: 'model', note: 'Offered from general knowledge.', figures: [] }],
                figures: [],
              }
        },
        jevTransport: (async () => {
          throw new Error('jev loop not under test here')
        }) as never,
        verifyTransport: async () => null,
      },
    })
    expect(calls).toBe(2)
    expect(outcome).not.toBeNull()
    expect(outcome!.flexible.places.map((p) => p.name)).toEqual(['Berkeley, CA'])
    expect(outcome!.flexible.places[0]!.evidenceClass).toBe('model_knowledge')
  })

  it('a completion that stays zero-place fails closed to the strict note after the one re-draft', async () => {
    let calls = 0
    const outcome = await composeFlexibleCompletion({
      queryText: Q6,
      strictAnswer: fragmentOnlyStrictAnswer(),
      rows: [],
      criteria: [],
      deps: {
        flexibleTransport: async () => {
          calls += 1
          return { prose: 'No place can be shown for these criteria.', places: [], figures: [] }
        },
        jevTransport: (async () => {
          throw new Error('jev loop not under test here')
        }) as never,
        verifyTransport: async () => null,
      },
    })
    expect(calls).toBe(2)
    expect(outcome).toBeNull()
  })
})
