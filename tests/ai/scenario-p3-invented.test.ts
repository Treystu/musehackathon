/**
 * Scenario-coverage seat, P3 invented-criteria battery (2026-11-03).
 *
 * The matrix's P3 contract: at least 12 criterion nouns that appear in
 * NO decomposition catalog or lexicon in the shipped source, each run
 * as a state superlative through the general mechanism only. Absence
 * was verified by grep over src/ before this file was written
 * (haunted, stargazing, disc golf, hot springs, waterfalls, bookstores,
 * dog parks, lighthouses, covered bridges, mushroom foraging, kite
 * surfing, antique shops — zero catalog hits; "farmers markets" was
 * dropped from the list because it IS a catalog entry).
 *
 * Every cell uses the hard parse shape: the criterion survives only as
 * the combined carry (no decomposedMetricKey), the intent retains no
 * measures, and the geography is a state bound. The expected terminal
 * is the researched card naming the prose-supported winner with the
 * criterion accounted exactly once; the total-failure twin cell
 * expects the state-bounded degrade (verified screen card, criterion
 * recorded as a lookup that did not return).
 */
import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { runAnswerPipeline } from '../../src/core/ai/answer'

const OR_ROWS: AreaRow[] = [
  { zcta: '97701', name: 'Bend, OR', metrics: { median_gross_rent: 1988, median_home_value: 778600 }, moes: { median_gross_rent: 120, median_home_value: 21000 } },
  { zcta: '97520', name: 'Ashland, OR', metrics: { median_gross_rent: 1645, median_home_value: 652300 }, moes: { median_gross_rent: 140, median_home_value: 26000 } },
  { zcta: '97031', name: 'Hood River, OR', metrics: { median_gross_rent: 1720, median_home_value: 698400 }, moes: { median_gross_rent: 160, median_home_value: 31000 } },
  { zcta: '97103', name: 'Astoria, OR', metrics: { median_gross_rent: 1310, median_home_value: 481200 }, moes: { median_gross_rent: 110, median_home_value: 19000 } },
  { zcta: '97401', name: 'Eugene, OR', metrics: { median_gross_rent: 1495, median_home_value: 512700 }, moes: { median_gross_rent: 90, median_home_value: 15000 } },
  { zcta: '97205', name: 'Portland, OR', metrics: { median_gross_rent: 1718, median_home_value: 584900 }, moes: { median_gross_rent: 60, median_home_value: 12000 } },
]

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: ['OR'],
    metricKeys: [],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
}

interface InventedCell {
  criterion: string
  question: string
  winner: string
  runnerUp: string
  prose: string
}

function cell(criterion: string, question: string, winner: string, runnerUp: string, praise: string, mild: string): InventedCell {
  return {
    criterion,
    question,
    winner,
    runnerUp,
    prose:
      `${winner} is described as having ${praise}. ` +
      `${runnerUp} is described as having ${mild}. ` +
      `Answer: ${winner} has the strongest support for ${criterion} in Oregon.`,
  }
}

const CELLS: InventedCell[] = [
  cell('the most haunted houses', 'Which town in Oregon has the most haunted houses?', 'Astoria, OR', 'Portland, OR', 'the most haunted houses on the coast, with ghost tours running nightly through its Victorian district', 'a few reputedly haunted hotels'),
  cell('the best stargazing', 'Which town in Oregon has the best stargazing?', 'Bend, OR', 'Ashland, OR', 'the best stargazing in the state, with certified dark skies over the high desert', 'good stargazing on clear summer nights'),
  cell('the best disc golf', 'Which town in Oregon has the best disc golf?', 'Eugene, OR', 'Bend, OR', 'the best disc golf scene in Oregon, with four maintained courses inside the city', 'two well-kept disc golf courses'),
  cell('the best hot springs', 'Which town in Oregon has the best hot springs?', 'Ashland, OR', 'Hood River, OR', 'the best hot springs access in the state, with mineral pools open year round', 'a small hot springs resort nearby'),
  cell('the most waterfalls', 'Which town in Oregon has the most waterfalls nearby?', 'Hood River, OR', 'Astoria, OR', 'the most waterfalls nearby of any Oregon town, with dozens of falls along the gorge trails', 'several waterfalls within a short drive'),
  cell('the most bookstores', 'Which town in Oregon has the most bookstores?', 'Portland, OR', 'Eugene, OR', 'the most bookstores per resident in the state, including one of the largest independent bookstores in the country', 'a healthy cluster of independent bookstores'),
  cell('the most dog parks', 'Which town in Oregon has the most dog parks?', 'Portland, OR', 'Bend, OR', 'the most dog parks of any Oregon city, with off-leash areas in every quadrant', 'several large dog parks'),
  cell('the most lighthouses', 'Which town in Oregon has the most lighthouses nearby?', 'Astoria, OR', 'Hood River, OR', 'the most lighthouses nearby, at the mouth of the Columbia and along the north coast', 'one historic lighthouse within driving distance'),
  cell('the most covered bridges', 'Which town in Oregon has the most covered bridges nearby?', 'Eugene, OR', 'Ashland, OR', 'the most covered bridges nearby, in the county with the largest collection in the state', 'a few covered bridges on its back roads'),
  cell('the best mushroom foraging', 'Which town in Oregon has the best mushroom foraging?', 'Astoria, OR', 'Eugene, OR', 'the best mushroom foraging in Oregon, with chanterelles and matsutake through the coastal forest', 'reliable mushroom foraging in the fall'),
  cell('the best kite surfing', 'Which town in Oregon has the best kite surfing?', 'Hood River, OR', 'Astoria, OR', 'the best kite surfing in the state, with steady gorge winds all summer', 'occasional kite surfing on windy days'),
  cell('the most antique shops', 'Which town in Oregon has the most antique shops?', 'Ashland, OR', 'Astoria, OR', 'the most antique shops on its main street of any town in the state', 'a handful of antique shops downtown'),
]

describe('P3 invented criteria: state superlatives through the general mechanism', () => {
  it.each(CELLS.map((c) => [c.criterion, c] as const))(
    'criterion "%s" terminates as a researched card naming the supported winner',
    async (_name, c) => {
      const answer = await runAnswerPipeline({
        intent: intent({}),
        rows: OR_ROWS,
        researchQuery: c.question,
        queryText: c.question,
        provider: createStubProvider({
          async research() {
            return {
              prose: c.prose,
              sources: [{ title: 'Oregon guide', url: 'https://example.org/oregon' }],
            }
          },
        }),
      })
      expect(answer.status).toBe('verified')
      expect(answer.places.map((p) => p.name)).toContain(c.winner)
      // The criterion is accounted exactly once — never dropped,
      // never duplicated. The label is whatever the decomposition
      // assigned (the combined carry, or an undecomposed bucket like
      // 'Amenities' for "dog parks"), so the invariant is stated over
      // the answer's own parsed criteria, not a literal label.
      expect(answer.researchCriteria.length).toBeGreaterThan(0)
      for (const criterion of answer.researchCriteria) {
        const lines = answer.criterionEvidence.filter((e) => e.criterion === criterion.label)
        expect(lines, `criterion "${criterion.label}" accounting lines`).toHaveLength(1)
      }
    },
  )

  it('total-failure twin: an invented criterion with research down degrades onto the state screen', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({}),
      rows: OR_ROWS,
      researchQuery: 'Which town in Oregon has the best stargazing?',
      queryText: 'Which town in Oregon has the best stargazing?',
      provider: createStubProvider({
        async research() {
          throw new Error('provider_down')
        },
      }),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.length).toBeGreaterThan(0)
    expect(answer.researchFailures).toContain('Outside-Census criteria')
  })
})
