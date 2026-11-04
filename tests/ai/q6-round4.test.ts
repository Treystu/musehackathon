import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  RESEARCH_SECOND_DRAW_LEAD,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import { buildFlexiblePacketText } from '../../src/core/ai/flexible'
import { createStubProvider } from '../../src/core/ai/provider'
import { decodePlaces } from '../../src/core/zcta-place-index'
import { composeFlexibleCompletion } from '../../src/ui/ai/flexible-runner'

/**
 * Q6 round 4 (2026-11-04): the demo question on production
 * 358ce75, asked twice by the parent (05:18 and 05:25 HST),
 * split — run 2 carded Fort Smith, AR with both criteria
 * measured; run 1 dead-ended:
 *
 *   "Complete — 2 of 2 checks done · 1 lookup did not return"
 *   "Research for the stated criteria did not produce a place
 *    that could be shown here."
 *   "7 names in the findings could not be matched to Census
 *    data, so they were not used."
 *   both criteria "not measurable from available sources", the
 *   school line carrying the no-place detail (serving claims
 *   existed), and NO flexible completion on the card.
 *
 * Run 1's counters fix its shape exactly: unresolvedCandidates
 * empty and the unmatched line in its count form means every
 * mention fragmented at extraction (bare.fragments = 7, every
 * name channel empty), while claims served the criteria. The
 * grounding re-ask fired on the claims disjunct and still
 * grounded zero; no further draw existed; the flexible lane
 * engaged on the marker + claims and returned null — its packet
 * offered zero candidate names and its zero-place gap asserted
 * "the research named places", a premise the drafter could see
 * was false, so both drafts named no place.
 *
 * The pins below reproduce that shape over the shipped national
 * place index: FRAGMENT_PROSE's mentions are generic-noun
 * sentence leads (City, Town, County, Region, State, District,
 * Area — the FM-20 fragment shapes), verified to extract as
 * std [], bare names/ambiguous/unresolved [], fragments 8, with
 * every sentence a claim. One place the findings discuss —
 * Marfa, mid-sentence, no state suffix — is invisible to both
 * extractors by construction and rides only in the claims,
 * exactly the material the floor exists to complete from.
 */

const Q6 = 'Where can I find the best schools but also the fewest fast food restaurants?'

const FRAGMENT_PROSE =
  'City rankings of school quality weigh state test scores heavily in their ratings. ' +
  'Town guides count fast food restaurants per capita for small communities. ' +
  'County data on fast food restaurants comes from state health departments rather than town surveys. ' +
  'Region summaries describe school quality without naming individual districts. ' +
  'State atlases map fast food restaurants by county rather than by town. ' +
  'District profiles rate school quality from state assessment results. ' +
  'Area studies of fast food density rely on county-level counts. ' +
  'One widely cited example pairs the Marfa school district with a near absence of fast food restaurants.'
const FRAGMENT_SOURCES = [
  { title: 'School ratings and fast food density methods', url: 'https://example.org/methods' },
]

/** The second draw's expected yield genre: small towns, "City, State" form. */
const SMALL_TOWNS_PROSE =
  'Marfa, Texas pairs highly rated public schools with very few fast food restaurants in town. ' +
  'Bisbee, Arizona is known for strong public schools and has almost no fast food restaurants. ' +
  'Eureka Springs, Arkansas has well-regarded public schools and few fast food restaurants.'
const SMALL_TOWNS_SOURCES = [
  { title: 'Small towns with strong schools', url: 'https://example.org/small-towns' },
]

/** A steered first yield in the captured round-3 genre: real candidates bare, an excluded pair suffixed. */
const STEERED_PROSE =
  'Cambridge Public Schools offers strong academic programs with Cambridge Rindge and Latin School as public high school. ' +
  'Berkeley Unified School District serves students in a city anchored by University of California, Berkeley. ' +
  'Carlsbad Unified School District includes Carlsbad High School and Sage Creek High School. ' +
  'Excluded from this list even though high-ranked for schools: Arlington, Virginia and The Woodlands, Texas.'
const GROUNDING_PROSE =
  'Berkeley, California: Berkeley Unified School District serves the city, and California cities like Berkeley are named among those with the fewest fast-food restaurants per person. ' +
  'Cambridge, Massachusetts: Cambridge Public Schools serves the city, and the Eastern region around Cambridge has just 2.5 fast food restaurants per 10K residents, the fewest of any region. ' +
  'Carlsbad, California: Carlsbad Unified School District serves the city, and Carlsbad is on the California list of cities with the fewest fast-food restaurants.'
const STEERED_SOURCES = [
  { title: 'Ranking The Places With The Most (And Least) Fast Food', url: 'https://example.org/fast-food' },
]

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

interface RecordedCall {
  queryText: string
  places: string[]
}

/* ------------------------------------------------------------------ */
/* Run 1's shape: fragments + claims, zero grounding at every draw     */
/* ------------------------------------------------------------------ */

describe('Q6 round 4: run 1’s shape — every draw fragments, the floor completes', () => {
  /**
   * The run-1 provider: every pass returns the fragment yield;
   * every second call throws (one criterion's lookup does not
   * return in every stage, exactly run 1's failure accounting).
   */
  function run1Provider() {
    const calls: RecordedCall[] = []
    let n = 0
    const provider = createStubProvider({
      async research(req: { queryText: string; places?: string[] }) {
        n += 1
        calls.push({ queryText: req.queryText, places: [...(req.places ?? [])] })
        if (n % 2 === 0) throw new Error('provider flap')
        return { prose: FRAGMENT_PROSE, sources: FRAGMENT_SOURCES }
      },
    })
    return { provider, calls }
  }

  async function run1Answer(): Promise<{ answer: ComposedAnswer; calls: RecordedCall[] }> {
    const { provider, calls } = run1Provider()
    const answer = await runAnswerPipeline({
      intent: { ...Q6_INTENT },
      rows: nationalRows(),
      researchQuery: Q6,
      queryText: Q6,
      provider,
    })
    return { answer, calls }
  }

  it('the strict terminal is run 1’s: empty, one failed lookup, fragments only, claims in hand', async () => {
    const { answer, calls } = await run1Answer()
    expect(answer.status).toBe('empty')
    expect(answer.places).toEqual([])
    expect(answer.summary).toBe(
      'Research for the stated criteria did not produce a place that could be shown here.',
    )
    // "1 lookup did not return": one criterion failed in every stage.
    expect(answer.researchFailures).toEqual(['Fast food restaurants'])
    // "N names in the findings could not be matched": the count
    // form — no recorded name, fragments only.
    expect(answer.unresolvedCandidates).toEqual([])
    expect(answer.researchNamedPlaces).toEqual([])
    expect(answer.unmatchedFragmentCount).toBeGreaterThan(0)
    // The material the floor completes from: claims, and the marker.
    expect(answer.generalClaims.length).toBeGreaterThan(0)
    expect(answer.noCensusMatch).toBe(true)
    // Call accounting: first stage + grounding re-ask + exactly
    // ONE second draw — three stages of two passes each, no more.
    expect(calls).toHaveLength(6)
    expect(calls[0]!.queryText).toContain('specific incorporated cities or towns')
    expect(
      calls.filter((c) => c.queryText.includes(RESEARCH_SECOND_DRAW_LEAD)),
    ).toHaveLength(2)
    // The second draw leads with the last-stated criterion.
    expect(calls[4]!.queryText).toContain('lead with Fast food restaurants')
  })

  it('the floor completes from the findings: the re-draft names a findings place, labelled model knowledge', async () => {
    const { answer } = await run1Answer()
    const requests: { revision?: { gaps: readonly string[] } }[] = []
    let drafts = 0
    const outcome = await composeFlexibleCompletion({
      queryText: Q6,
      strictAnswer: answer,
      rows: nationalRows(),
      criteria: [],
      deps: {
        flexibleTransport: async (request) => {
          drafts += 1
          requests.push(request as { revision?: { gaps: readonly string[] } })
          return drafts === 1
            ? { prose: 'No place can be shown for these criteria.', places: [], figures: [] }
            : {
                prose: 'The findings discuss Marfa for the stated criteria.',
                places: [
                  { name: 'Marfa, TX', basis: 'model', note: 'Discussed in the findings for both criteria.', figures: [] },
                ],
                figures: [],
              }
        },
        jevTransport: (async () => {
          throw new Error('jev loop not under test here')
        }) as never,
        verifyTransport: async () => null,
      },
    })
    expect(drafts).toBe(2)
    // The re-draft's gap names the findings shape, not the
    // names-record premise this packet does not carry.
    const gaps = requests[1]!.revision?.gaps ?? []
    expect(gaps.some((g) => g.includes('the research findings discuss places'))).toBe(true)
    expect(gaps.some((g) => g.includes('though the research named places'))).toBe(false)
    // The completion lands: a named place, its evidence class labelled.
    expect(outcome).not.toBeNull()
    expect(outcome!.flexible.places.map((p) => p.name)).toEqual(['Marfa, TX'])
    expect(outcome!.flexible.places[0]!.evidenceClass).toBe('model_knowledge')
  })
})

/* ------------------------------------------------------------------ */
/* The second draw: varied steering rescues a zero-grounding run       */
/* ------------------------------------------------------------------ */

describe('Q6 round 4: the second draw', () => {
  it('a varied second draw grounds small towns the first yields could not', async () => {
    const calls: RecordedCall[] = []
    const provider = createStubProvider({
      async research(req: { queryText: string; places?: string[] }) {
        calls.push({ queryText: req.queryText, places: [...(req.places ?? [])] })
        if (req.queryText.includes(RESEARCH_SECOND_DRAW_LEAD)) {
          return { prose: SMALL_TOWNS_PROSE, sources: SMALL_TOWNS_SOURCES }
        }
        return { prose: FRAGMENT_PROSE, sources: FRAGMENT_SOURCES }
      },
    })
    const answer = await runAnswerPipeline({
      intent: { ...Q6_INTENT },
      rows: nationalRows(),
      researchQuery: Q6,
      queryText: Q6,
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Marfa, TX', 'Bisbee, AZ', 'Eureka Springs, AR']),
    )
    // Exactly one second-draw stage (two passes), after the
    // first stage and the re-ask (two passes each).
    expect(calls).toHaveLength(6)
    expect(
      calls.filter((c) => c.queryText.includes(RESEARCH_SECOND_DRAW_LEAD)),
    ).toHaveLength(2)
  })

  it('no second draw fires when the grounding re-ask already grounded the run', async () => {
    const calls: RecordedCall[] = []
    const provider = createStubProvider({
      async research(req: { queryText: string; places?: string[] }) {
        calls.push({ queryText: req.queryText, places: [...(req.places ?? [])] })
        if ((req.places?.length ?? 0) > 0) {
          return { prose: GROUNDING_PROSE, sources: STEERED_SOURCES }
        }
        return { prose: STEERED_PROSE, sources: STEERED_SOURCES }
      },
    })
    const answer = await runAnswerPipeline({
      intent: { ...Q6_INTENT },
      rows: nationalRows(),
      researchQuery: Q6,
      queryText: Q6,
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Berkeley, CA', 'Cambridge, MA', 'Carlsbad, CA']),
    )
    // The re-ask carried the ungrounded names (round 3), and the
    // second draw never fired: the rescue made it unnecessary.
    expect(calls.some((c) => c.places.includes('Cambridge'))).toBe(true)
    expect(
      calls.filter((c) => c.queryText.includes(RESEARCH_SECOND_DRAW_LEAD)),
    ).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* The packet: the findings-only shape instructs naming                */
/* ------------------------------------------------------------------ */

describe('Q6 round 4: the flexible packet on the findings-only shape', () => {
  it('a claims-only packet instructs the drafter to name the places the findings put forward', () => {
    const text = buildFlexiblePacketText({
      question: Q6,
      criteria: ['School quality', 'Fast food restaurants'],
      researchPlaces: [],
      claims: [
        {
          text: 'One widely cited example pairs the Marfa school district with a near absence of fast food restaurants.',
          sourceUrls: ['https://example.org/methods'],
        },
      ],
      sources: [{ title: 'Methods', url: 'https://example.org/methods' }],
    })
    expect(text).toContain('The findings above discuss places in their text')
  })

  it('a packet with research-named places carries no such instruction — the named places are the material', () => {
    const text = buildFlexiblePacketText({
      question: Q6,
      criteria: ['School quality', 'Fast food restaurants'],
      researchPlaces: ['Cambridge'],
      claims: [
        {
          text: 'Cambridge Public Schools offers strong academic programs.',
          sourceUrls: ['https://example.org/x'],
        },
      ],
      sources: [{ title: 'X', url: 'https://example.org/x' }],
    })
    expect(text).not.toContain('The findings above discuss places in their text')
    expect(text).toContain('PLACES THE RESEARCH NAMED: Cambridge')
  })
})
