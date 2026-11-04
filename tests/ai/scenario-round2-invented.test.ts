import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { runAnswerPipeline } from '../../src/core/ai/answer'

/**
 * Scenario-coverage seat, invented-criteria battery ROUND 2
 * (2026-11-03, post-FM-9 tree). Twelve criterion nouns that appear in
 * NO decomposition catalog or lexicon in the shipped source and were
 * NOT in round 1's twelve (haunted houses, stargazing, disc golf, hot
 * springs, waterfalls, bookstores, dog parks, lighthouses, covered
 * bridges, mushroom foraging, kite surfing, antique shops). Absence
 * verified by grep over src/ before this file was written (baseball,
 * jazz, beekeep, roller rink, swimming pool, chess, botanical,
 * drive-in, climbing gym, sailing, quilt, railroad — zero hits).
 *
 * Same contract as round 1: the hard parse shape (the criterion
 * survives only as the combined carry, the intent retains no
 * measures), a state bound, and the expected terminal is the
 * researched card naming the prose-supported winner with the
 * criterion accounted exactly once. The total-failure twin expects
 * the state-bounded degrade.
 */

function intent(state: string): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [state],
    metricKeys: [],
    filters: [],
    clarificationNeeded: false,
  }
}

function rowsFor(places: Array<[string, string, number]>): AreaRow[] {
  return places.map(([zcta, name, rent]) => ({
    zcta,
    name,
    metrics: { median_gross_rent: rent, median_home_value: rent * 220 },
    moes: { median_gross_rent: 60, median_home_value: 9000 },
  }))
}

interface Cell {
  criterion: string
  question: string
  state: string
  stateName: string
  rows: AreaRow[]
  winner: string
  runnerUp: string
  prose: string
}

function cell(
  criterion: string,
  question: string,
  state: string,
  stateName: string,
  places: Array<[string, string, number]>,
  winner: string,
  runnerUp: string,
  praise: string,
  mild: string,
): Cell {
  return {
    criterion,
    question,
    state,
    stateName,
    rows: rowsFor(places),
    winner,
    runnerUp,
    prose:
      `${winner} is described as having ${praise}. ` +
      `${runnerUp} is described as having ${mild}. ` +
      `Answer: ${winner} has the strongest support for ${criterion} in ${stateName}.`,
  }
}

const CELLS: Cell[] = [
  cell('the best minor league baseball', 'Which town in North Carolina has the best minor league baseball?', 'NC', 'North Carolina',
    [['27701', 'Durham, NC', 1450], ['28202', 'Charlotte, NC', 1525], ['27401', 'Greensboro, NC', 1150], ['28801', 'Asheville, NC', 1475]],
    'Durham, NC', 'Charlotte, NC', 'the best minor league baseball in the state, with a beloved ballpark downtown', 'a solid minor league team'),
  cell('the best jazz festivals', 'Which town in Louisiana has the best jazz festivals?', 'LA', 'Louisiana',
    [['70112', 'New Orleans, LA', 1350], ['70801', 'Baton Rouge, LA', 1050], ['70501', 'Lafayette, LA', 950], ['71101', 'Shreveport, LA', 850]],
    'New Orleans, LA', 'Lafayette, LA', 'the best jazz festivals in the country, anchored by its famous spring festival season', 'a small jazz weekend each fall'),
  cell('the best beekeeping', 'Which town in Utah is best for beekeeping?', 'UT', 'Utah',
    [['84401', 'Ogden, UT', 1250], ['84601', 'Provo, UT', 1350], ['84321', 'Logan, UT', 1050], ['84532', 'Moab, UT', 1400]],
    'Ogden, UT', 'Logan, UT', 'the best beekeeping community in the state, with a large keepers association and many backyard apiaries', 'a handful of active beekeepers'),
  cell('the most roller rinks', 'Which town in Pennsylvania has the most roller rinks?', 'PA', 'Pennsylvania',
    [['16501', 'Erie, PA', 950], ['17401', 'York, PA', 1100], ['16602', 'Altoona, PA', 800], ['18503', 'Scranton, PA', 900]],
    'Erie, PA', 'York, PA', 'the most roller rinks of any town in the state, a legacy of its skating clubs', 'one long-running roller rink'),
  cell('the most public swimming pools', 'Which town in Arizona has the most public swimming pools?', 'AZ', 'Arizona',
    [['85201', 'Mesa, AZ', 1350], ['85701', 'Tucson, AZ', 1100], ['85003', 'Phoenix, AZ', 1400], ['86001', 'Flagstaff, AZ', 1550]],
    'Mesa, AZ', 'Tucson, AZ', 'the most public swimming pools in the state, with large municipal aquatic centers in every district', 'several public pools open all summer'),
  cell('the best chess clubs', 'Which town in Minnesota has the best chess clubs?', 'MN', 'Minnesota',
    [['55901', 'Rochester, MN', 1250], ['55802', 'Duluth, MN', 1050], ['56301', 'St. Cloud, MN', 1000], ['56001', 'Mankato, MN', 950]],
    'Rochester, MN', 'Duluth, MN', 'the best chess clubs in the state, with weekly rated nights drawing players from across the region', 'a small weekly chess meetup'),
  cell('the best botanical gardens', 'Which town in South Carolina has the best botanical gardens?', 'SC', 'South Carolina',
    [['29601', 'Greenville, SC', 1250], ['29201', 'Columbia, SC', 1100], ['29401', 'Charleston, SC', 1750], ['29306', 'Spartanburg, SC', 950]],
    'Greenville, SC', 'Charleston, SC', 'the best botanical gardens in the state, with extensive collections along its river park', 'noted historic gardens at its plantations'),
  cell('the most drive-in theaters', 'Which town in Idaho has the most drive-in theaters nearby?', 'ID', 'Idaho',
    [['83402', 'Idaho Falls, ID', 1150], ['83702', 'Boise, ID', 1450], ['83301', 'Twin Falls, ID', 1050], ['83201', 'Pocatello, ID', 950]],
    'Idaho Falls, ID', 'Twin Falls, ID', 'the most drive-in theaters nearby of any Idaho town, with two still operating within a short drive', 'one seasonal drive-in theater'),
  cell('the best rock climbing gyms', 'Which town in Colorado has the best rock climbing gyms?', 'CO', 'Colorado',
    [['80301', 'Boulder, CO', 1950], ['80401', 'Golden, CO', 1750], ['80521', 'Fort Collins, CO', 1550], ['80903', 'Colorado Springs, CO', 1350]],
    'Boulder, CO', 'Golden, CO', 'the best rock climbing gyms in the state, with several large gyms serving its climbing community', 'one well-regarded climbing gym'),
  cell('the best sailing clubs', 'Which town in Maine has the best sailing clubs?', 'ME', 'Maine',
    [['04843', 'Camden, ME', 1450], ['04101', 'Portland, ME', 1550], ['04401', 'Bangor, ME', 950], ['04609', 'Bar Harbor, ME', 1650]],
    'Camden, ME', 'Portland, ME', 'the best sailing clubs on the coast, with an active racing fleet in its harbor', 'a busy marina with a sailing program'),
  cell('the most quilt shops', 'Which town in Wisconsin has the most quilt shops?', 'WI', 'Wisconsin',
    [['54601', 'La Crosse, WI', 1050], ['54701', 'Eau Claire, WI', 1000], ['54911', 'Appleton, WI', 1150], ['54301', 'Green Bay, WI', 1100]],
    'La Crosse, WI', 'Appleton, WI', 'the most quilt shops of any town in the state, a destination for quilters across the river valley', 'two established quilt shops'),
  cell('the best model railroad clubs', 'Which town in New Mexico has the best model railroad clubs?', 'NM', 'New Mexico',
    [['88001', 'Las Cruces, NM', 1050], ['87501', 'Santa Fe, NM', 1550], ['87102', 'Albuquerque, NM', 1250], ['88201', 'Roswell, NM', 900]],
    'Las Cruces, NM', 'Albuquerque, NM', 'the best model railroad clubs in the state, with a large permanent layout open to visitors', 'a small club layout at its fairgrounds'),
]

describe('R2 invented criteria: state superlatives through the general mechanism', () => {
  it.each(CELLS.map((c) => [c.criterion, c] as const))(
    'criterion "%s" terminates as a researched card naming the supported winner',
    async (_name, c) => {
      const answer = await runAnswerPipeline({
        intent: intent(c.state),
        rows: c.rows,
        researchQuery: c.question,
        queryText: c.question,
        provider: createStubProvider({
          async research() {
            return {
              prose: c.prose,
              sources: [{ title: 'State guide', url: 'https://example.org/guide' }],
            }
          },
        }),
      })
      expect(answer.status).toBe('verified')
      expect(answer.places.map((p) => p.name)).toContain(c.winner)
      expect(answer.researchCriteria.length).toBeGreaterThan(0)
      for (const criterion of answer.researchCriteria) {
        const lines = answer.criterionEvidence.filter((e) => e.criterion === criterion.label)
        expect(lines, `criterion "${criterion.label}" accounting lines`).toHaveLength(1)
      }
    },
  )

  it('total-failure twin: an invented criterion with research down degrades onto the state screen', async () => {
    const c = CELLS.find((x) => x.criterion === 'the best chess clubs')!
    const answer = await runAnswerPipeline({
      intent: intent(c.state),
      rows: c.rows,
      researchQuery: c.question,
      queryText: c.question,
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
