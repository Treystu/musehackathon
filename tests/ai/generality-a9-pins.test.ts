import { describe, expect, it } from 'vitest'
import {
  decomposeResearchCriteria,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import { needsResearch, researchFirstCriteria } from '../../src/ui/ai/AskPanel'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { resultMapRelevant } from '../../src/core/map/result-scale'

/**
 * Lane A9 generality pin base (phase 2). The phase-1 battery
 * (generality-a9.test.ts, harvest-style) measured the failure map
 * FM-1..FM-12 on cb1a074; this file pins the cured behavior per
 * bucket prompt + probes, with the same fixtures and prose genre
 * (finding-per-sentence, scaffolded conclusion, the specimen's
 * narration sentence). Assertions grow per cure cluster; each
 * cluster's commit names the assertions it added.
 */

const NARRATION = "I'll check the remaining towns next."

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return { mode: 'sweep_filter', geographies: [], metricKeys: [], filters: [], clarificationNeeded: false, ...partial }
}

function row(zcta: string, name: string, rent: number, extra: Record<string, number | null> = {}): AreaRow {
  return { zcta, name, metrics: { median_gross_rent: rent, ...extra }, moes: { median_gross_rent: 60 } }
}

function provider(prose: string, calls: { places: readonly string[]; queryText: string }[]) {
  return createStubProvider({
    async research(input) {
      calls.push({ places: input.places, queryText: input.queryText })
      return { prose, sources: [{ title: 'Findings source', url: 'https://example.com/f' }] }
    },
  })
}

function renderedText(a: ComposedAnswer): string {
  return [a.summary, ...a.places.flatMap((p) => p.claims.map((c) => c.text)), ...a.generalClaims.map((c) => c.text)].join('\n')
}

interface Scenario {
  id: string
  q: string
  intent: Partial<ValidatedIntent>
  rows: AreaRow[]
  prose: string
}

interface Reading {
  engaged: boolean
  researchCalls: number
  status: string
  evidence: string[]
  places: string[]
  narrationLeak: boolean
  mapRelevant: boolean
  unresolved: string[]
  answer: ComposedAnswer
}

async function runScenario(s: Scenario): Promise<Reading> {
  const calls: { places: readonly string[]; queryText: string }[] = []
  const engaged = researchFirstCriteria(s.q).length > 0 || needsResearch(s.q)
  const answer = await runAnswerPipeline({
    intent: intent(s.intent),
    rows: s.rows,
    researchQuery: engaged ? s.q : undefined,
    researchCriteria: [s.q],
    queryText: s.q,
    provider: provider(s.prose, calls),
  })
  return {
    engaged,
    researchCalls: calls.length,
    status: answer.status,
    evidence: answer.criterionEvidence.map((e) => `${e.criterion}=${e.status}`),
    places: answer.places.map((p) => p.name),
    narrationLeak: renderedText(answer).includes(NARRATION),
    mapRelevant: resultMapRelevant(answer),
    unresolved: answer.unresolvedCandidates,
    answer,
  }
}

const FL_ROWS = [
  row('32208', 'Jacksonville, FL', 1250), row('33101', 'Miami, FL', 2100), row('33602', 'Tampa, FL', 1650),
  row('33040', 'Key West, FL', 2400), row('32801', 'Orlando, FL', 1550), row('32301', 'Tallahassee, FL', 1100),
  row('33901', 'Fort Myers, FL', 1700), row('34102', 'Naples, FL', 2300), row('33401', 'West Palm Beach, FL', 1900),
  row('32501', 'Pensacola, FL', 1050),
]
const VT_ROWS = [
  row('05401', 'Burlington, VT', 1500), row('05301', 'Brattleboro, VT', 1050), row('05602', 'Montpelier, VT', 1100),
  row('05701', 'Rutland, VT', 900), row('05201', 'Bennington, VT', 950), row('05819', 'St. Johnsbury, VT', 800),
  row('05478', 'St. Albans, VT', 1000), row('05641', 'Barre, VT', 850), row('05001', 'White River Junction, VT', 1050),
  row('05346', 'Middlebury, VT', 1200),
]
const GA_ROWS = [
  row('30601', 'Athens, GA', 1100), row('31401', 'Savannah, GA', 1300), row('30303', 'Atlanta, GA', 1600),
  row('30030', 'Decatur, GA', 1450), row('30901', 'Augusta, GA', 950), row('31201', 'Macon, GA', 900),
  row('31901', 'Columbus, GA', 1000), row('31520', 'Brunswick, GA', 1050), row('30634', 'Washington, GA', 700),
  row('39828', 'Cairo, GA', 650),
]
const DAL_ROWS = [
  row('75201', 'Dallas, TX', 1400), row('75023', 'Plano, TX', 1750), row('75034', 'Frisco, TX', 1900),
  row('75080', 'Richardson, TX', 1500), row('75040', 'Garland, TX', 1350), row('75006', 'Carrollton, TX', 1550),
  row('75038', 'Irving, TX', 1450), row('75052', 'Grand Prairie, TX', 1300), row('75149', 'Mesquite, TX', 1250),
  row('75116', 'Duncanville, TX', 1200),
]
const CHI_ROWS = [
  row('60601', 'Chicago, IL', 1500), row('60540', 'Naperville, IL', 1900), row('60201', 'Evanston, IL', 1700),
  row('60301', 'Oak Park, IL', 1600), row('60004', 'Arlington Heights, IL', 1650), row('60126', 'Elmhurst, IL', 1750),
  row('60035', 'Highland Park, IL', 2100), row('60453', 'Oak Lawn, IL', 1300), row('60108', 'Bloomingdale, IL', 1550),
  row('60515', 'Downers Grove, IL', 1800),
]
const MT_ROWS = [
  row('59715', 'Bozeman, MT', 1600), row('59937', 'Whitefish, MT', 1500), row('59047', 'Livingston, MT', 1100),
  row('59070', 'Red Lodge, MT', 1000), row('59801', 'Missoula, MT', 1300), row('59901', 'Kalispell, MT', 1250),
  row('59701', 'Butte, MT', 800), row('59601', 'Helena, MT', 1050), row('59101', 'Billings, MT', 1100),
  row('59401', 'Great Falls, MT', 950),
]
const OH_ROWS = [
  row('43215', 'Columbus, OH', 1100), row('45202', 'Cincinnati, OH', 1000), row('44113', 'Cleveland, OH', 950),
  row('43604', 'Toledo, OH', 800), row('44308', 'Akron, OH', 850), row('45402', 'Dayton, OH', 875),
  row('44503', 'Youngstown, OH', 700), row('44702', 'Canton, OH', 825), row('45503', 'Springfield, OH', 780),
  row('44870', 'Sandusky, OH', 900),
]
const NAT_ROWS = [
  row('43215', 'Columbus, OH', 1100), row('60601', 'Chicago, IL', 1500), row('55401', 'Minneapolis, MN', 1300),
  row('64106', 'Kansas City, MO', 1000), row('46204', 'Indianapolis, IN', 1050), row('53203', 'Milwaukee, WI', 950),
  row('02108', 'Boston, MA', 2300), row('94103', 'San Francisco, CA', 2600), row('10001', 'New York, NY', 2500),
  row('80202', 'Denver, CO', 1750),
]
const ME_ROWS = [
  row('04101', 'Portland, ME', 1500), row('04401', 'Bangor, ME', 1000), row('04609', 'Bar Harbor, ME', 1300),
  row('04210', 'Auburn, ME', 950), row('04011', 'Brunswick, ME', 1200), row('04901', 'Waterville, ME', 850),
  row('04769', 'Presque Isle, ME', 750), row('04605', 'Ellsworth, ME', 1050), row('04074', 'Scarborough, ME', 1600),
  row('04106', 'South Portland, ME', 1450),
]
const AZ_ROWS = [
  row('86336', 'Sedona, AZ', 1700, { median_age: 58 }), row('85251', 'Scottsdale, AZ', 1800, { median_age: 47 }),
  row('85331', 'Cave Creek, AZ', 1750, { median_age: 52 }), row('86442', 'Bullhead City, AZ', 900, { median_age: 55 }),
  row('85003', 'Phoenix, AZ', 1400, { median_age: 34 }), row('85701', 'Tucson, AZ', 1100, { median_age: 38 }),
  row('86301', 'Prescott, AZ', 1400, { median_age: 56 }), row('86001', 'Flagstaff, AZ', 1650, { median_age: 31 }),
  row('85364', 'Yuma, AZ', 1000, { median_age: 36 }), row('85635', 'Sierra Vista, AZ', 1050, { median_age: 40 }),
]
const MI_ROWS = [
  row('49684', 'Traverse City, MI', 1200), row('48104', 'Ann Arbor, MI', 1600), row('49503', 'Grand Rapids, MI', 1150),
  row('49423', 'Holland, MI', 1050), row('49007', 'Kalamazoo, MI', 950), row('48823', 'East Lansing, MI', 1100),
  row('49770', 'Petoskey, MI', 1000), row('49441', 'Muskegon, MI', 850), row('48602', 'Saginaw, MI', 800),
  row('49201', 'Jackson, MI', 875),
]
const OR_ROWS = [
  row('97103', 'Astoria, OR', 1150), row('97365', 'Newport, OR', 1200), row('97439', 'Florence, OR', 1100),
  row('97411', 'Bandon, OR', 1000), row('97520', 'Ashland, OR', 1400), row('97031', 'Hood River, OR', 1500),
  row('97530', 'Jacksonville, OR', 1350), row('97110', 'Cannon Beach, OR', 1450), row('97333', 'Corvallis, OR', 1450),
  row('97401', 'Eugene, OR', 1350),
]
const VA_ROWS = [
  row('22903', 'Charlottesville, VA', 1500), row('23219', 'Richmond, VA', 1200), row('24014', 'Roanoke, VA', 950),
  row('24501', 'Lynchburg, VA', 900), row('22980', 'Waynesboro, VA', 1000), row('24401', 'Staunton, VA', 975),
  row('22601', 'Winchester, VA', 1250), row('22801', 'Harrisonburg, VA', 1100), row('24523', 'Bedford, VA', 925),
  row('24060', 'Blacksburg, VA', 1150),
]

export const SCENARIOS: Record<string, Scenario> = {
  climate_weather: {
    id: 'climate_weather', q: 'What city in Florida has the best weather year-round?',
    intent: { geographies: ['FL'], metricKeys: ['median_gross_rent'] }, rows: FL_ROWS,
    prose: 'Key West, FL has the mildest weather in Florida, with winter lows that rarely fall below 65 degrees and steady ocean breezes. ' +
      'Naples, FL is known for its dry, sunny winters and some of the most consistent weather in the state. ' +
      'Sanibel is often praised by residents for its gentle coastal weather year-round. ' +
      'Jacksonville, FL has the most seasonal variation in Florida weather, with cooler winters than the south. ' + NARRATION + ' ' +
      'Answer: Key West, FL has the strongest support for the best year-round weather in Florida.',
  },
  food_drink_beer: {
    id: 'food_drink_beer', q: 'What town in Vermont has the best beer selection?',
    intent: { geographies: ['VT'], metricKeys: [] }, rows: VT_ROWS,
    prose: 'Burlington, VT has the best beer selection in Vermont, with more craft breweries and taprooms per capita than any other town in the state. ' +
      'Brattleboro, VT has a strong beer scene anchored by long-running brewpubs and a well-regarded beer festival. ' +
      'Stowe, VT draws beer travelers for its brewery taprooms near the mountain. ' +
      'Rutland, VT has fewer beer options and a thinner selection than the leaders. ' + NARRATION + ' ' +
      'Answer: Burlington, VT has the strongest support for the best beer selection in Vermont.',
  },
  culture_politics: {
    id: 'culture_politics', q: 'Which town in Georgia is the most liberal?',
    intent: { geographies: ['GA'], metricKeys: ['median_gross_rent'] }, rows: GA_ROWS,
    prose: 'Athens, GA is described as the most liberal town in Georgia, a university town that votes heavily Democratic. ' +
      'Decatur, GA is described as strongly liberal, with some of the highest Democratic vote shares in the state. ' +
      'Savannah, GA is described as moderately liberal in its historic core. ' +
      'Macon, GA is described as politically mixed, leaning conservative outside the center. ' + NARRATION + ' ' +
      'Answer: Athens, GA has the strongest support as the most liberal town in Georgia.',
  },
  safety: {
    id: 'safety', q: 'Which suburb of Dallas is the safest for families?',
    intent: { geographies: ['Dallas, TX'], metricKeys: [] }, rows: DAL_ROWS,
    prose: 'Plano, TX is consistently rated one of the safest suburbs of Dallas, with low violent crime rates and strong safety rankings. ' +
      'Frisco, TX is described as very safe, with crime rates well below national averages. ' +
      'Carrollton, TX is described as a safe community with steady, low crime. ' +
      'Mesquite, TX has higher reported crime than the safest suburbs on this list. ' + NARRATION + ' ' +
      'Answer: Plano, TX has the strongest support as the safest suburb of Dallas for families.',
  },
  schools_family: {
    id: 'schools_family', q: 'What suburb of Chicago has the best schools for families?',
    intent: { geographies: ['Chicago, IL'], metricKeys: [] }, rows: CHI_ROWS,
    prose: 'Naperville, IL is rated as having the best public schools among Chicago suburbs, with top school ratings year after year. ' +
      'Evanston, IL has highly rated schools and is a long-standing choice for families who want strong school districts. ' +
      'Arlington Heights, IL is known for well-regarded schools and family amenities. ' +
      'Oak Lawn, IL has more mixed school ratings than the leaders here. ' + NARRATION + ' ' +
      'Answer: Naperville, IL has the strongest support for the best schools for families near Chicago.',
  },
  outdoors_nature: {
    id: 'outdoors_nature', q: 'What town in Montana has the best access to hiking and wilderness?',
    intent: { geographies: ['MT'], metricKeys: [] }, rows: MT_ROWS,
    prose: 'Whitefish, MT sits beside Glacier country, with trailheads into mountain wilderness minutes from town and extensive forest trails. ' +
      'Livingston, MT offers trail access into the Absaroka wilderness and Paradise Valley trail networks. ' +
      'Red Lodge, MT is a gateway to high alpine trails and wilderness trailheads on the Beartooth plateau. ' +
      'Butte, MT has fewer celebrated trail systems than the leaders. ' + NARRATION + ' ' +
      'Answer: Whitefish, MT has the strongest support for the best access to hiking and wilderness in Montana.',
  },
  cost_housing_bounded: {
    id: 'cost_housing_bounded', q: 'Where in Ohio can I rent a house for under $900 a month?',
    intent: { geographies: ['OH'], metricKeys: ['median_gross_rent'], filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 900 }] },
    rows: OH_ROWS, prose: '',
  },
  work_income: {
    id: 'work_income', q: 'What city in the Midwest has the strongest job market?',
    intent: { geographies: [], metricKeys: [] }, rows: NAT_ROWS,
    prose: 'Columbus, OH has the strongest job market in the Midwest in recent rankings, with broad hiring across logistics, finance, and technology. ' +
      'Minneapolis, MN is described as a strong job market with low unemployment and many large employers. ' +
      'Indianapolis, IN has a growing job market with steady hiring. ' +
      'Milwaukee, WI has a thinner job market than the leaders here. ' + NARRATION + ' ' +
      'Answer: Columbus, OH has the strongest support for the strongest job market in the Midwest.',
  },
  health_access: {
    id: 'health_access', q: 'What town in Maine has the best access to hospitals and doctors?',
    intent: { geographies: ['ME'], metricKeys: [] }, rows: ME_ROWS,
    prose: 'Portland, ME has the best access to hospitals and doctors in Maine, home to the state\'s largest hospital and its densest concentration of doctors and clinics. ' +
      'Bangor, ME is a regional hospital hub with a major hospital serving northern Maine. ' +
      'Brunswick, ME has a community hospital and good doctor coverage for its size. ' +
      'Presque Isle, ME has thinner hospital and doctor access than the leaders. ' + NARRATION + ' ' +
      'Answer: Portland, ME has the strongest support for the best access to hospitals and doctors in Maine.',
  },
  transport_walkable: {
    id: 'transport_walkable', q: 'What city in the US is the most walkable without a car?',
    intent: { geographies: [], metricKeys: [] }, rows: NAT_ROWS,
    prose: 'Boston, MA is rated the most walkable large city in the US, with a highly walkable downtown and strong walkability scores. ' +
      'San Francisco, CA is described as very walkable, with most daily needs reachable on foot in its core neighborhoods. ' +
      'New York, NY is described as extremely walkable, the classic car-free city. ' +
      'Denver, CO is described as only moderately walkable outside its center. ' + NARRATION + ' ' +
      'Answer: Boston, MA has the strongest support as the most walkable city in the US.',
  },
  community_retirees: {
    id: 'community_retirees', q: 'What town in Arizona has the most retirees?',
    intent: { geographies: ['AZ'], metricKeys: ['median_age'] }, rows: AZ_ROWS, prose: '',
  },
  recreation_fun: {
    id: 'recreation_fun', q: 'Which town in Michigan has the most fun things to do?',
    intent: { geographies: ['MI'], metricKeys: [] }, rows: MI_ROWS,
    prose: 'Traverse City, MI is rated as having the most fun things to do in Michigan, with festivals, beaches, wineries, and a lively downtown. ' +
      'Ann Arbor, MI has a fun, busy calendar of events and a vibrant downtown scene. ' +
      'Grand Rapids, MI offers many things to do, from museums to a large craft festival scene. ' +
      'Saginaw, MI has fewer things to do than the leaders here. ' + NARRATION + ' ' +
      'Answer: Traverse City, MI has the strongest support for the most fun things to do.',
  },
  environment_flood: {
    id: 'environment_flood', q: 'What coastal town in Oregon has the lowest flood risk?',
    intent: { geographies: ['OR'], metricKeys: [] }, rows: OR_ROWS,
    prose: 'Bandon, OR sits largely on elevated bluffs and is assessed as having the lowest flood risk among Oregon coastal towns, with most homes above flood zones. ' +
      'Florence, OR has moderate flood risk along its riverfront districts. ' +
      'Astoria, OR has significant flood risk in its low-lying areas near the river mouth. ' +
      'Newport, OR has mixed flood exposure across its neighborhoods. ' + NARRATION + ' ' +
      'Answer: Bandon, OR has the strongest support for the lowest flood risk on the Oregon coast.',
  },
  abstract_charming: {
    id: 'abstract_charming', q: 'Where in Oregon is the most charming small town?',
    intent: { geographies: ['OR'], metricKeys: [] }, rows: OR_ROWS,
    prose: 'Jacksonville, OR is widely described as the most charming small town in Oregon, a preserved gold-rush town with a beloved historic main street. ' +
      'Ashland, OR is described as charming, with a famous theater festival and a pretty downtown. ' +
      'Hood River, OR is described as a charming small town in the gorge with mountain views. ' +
      'Eugene, OR is a larger city and less often described as a charming small town. ' + NARRATION + ' ' +
      'Answer: Jacksonville, OR has the strongest support as the most charming small town in Oregon.',
  },
  probe_arts_residue: {
    id: 'probe_arts_residue', q: 'What town in Vermont has good schools and a thriving arts scene?',
    intent: { geographies: ['VT'], metricKeys: [] }, rows: VT_ROWS,
    prose: 'Brattleboro, VT has well-regarded schools and a school district families praise. ' +
      'Burlington, VT has strong schools with highly rated school programs. ' +
      'Middlebury, VT is known for good schools anchored by the college community. ' + NARRATION + ' ' +
      'Answer: Brattleboro, VT has the strongest support for good schools in Vermont.',
  },
  probe_healthcare_wording: {
    id: 'probe_healthcare_wording', q: 'Where in rural Virginia is healthcare most accessible?',
    intent: { geographies: ['VA'], metricKeys: [] }, rows: VA_ROWS,
    prose: 'Charlottesville, VA anchors rural healthcare access in central Virginia, with a major hospital serving the surrounding rural counties. ' +
      'Roanoke, VA is a healthcare hub for rural southwest Virginia, with a large hospital system. ' +
      'Harrisonburg, VA has a community hospital serving its rural region. ' +
      'Bedford, VA has limited healthcare access compared with the hubs. ' + NARRATION + ' ' +
      'Answer: Charlottesville, VA has the strongest support for healthcare access in rural Virginia.',
  },
}

describe('A9 pins — engagement (FM-1)', () => {
  // The seven phase-1 trigger failures + P16: engagement used to
  // read needsResearch false and research never ran. As-wired now.
  for (const id of [
    'climate_weather', 'food_drink_beer', 'work_income', 'recreation_fun',
    'environment_flood', 'abstract_charming', 'probe_healthcare_wording',
  ] as const) {
    it(`${id}: engages as-wired and serves through the general path`, async () => {
      const s = SCENARIOS[id]!
      expect(needsResearch(s.q)).toBe(true)
      const r = await runScenario(s)
      expect(r.engaged).toBe(true)
      expect(r.researchCalls).toBe(1)
      expect(r.status).toBe('verified')
      expect(r.evidence.some((e) => e.endsWith('=met'))).toBe(true)
      expect(r.narrationLeak).toBe(false)
      expect(r.mapRelevant).toBe(false)
    })
  }

  it('pure-Census questions do not engage', () => {
    expect(needsResearch('Where in Ohio can I rent a house for under $900 a month?')).toBe(false)
    expect(needsResearch('compare rent in Honolulu and Hilo')).toBe(false)
    expect(needsResearch('cheapest place to live in the United States')).toBe(false)
    expect(needsResearch('best place to raise a family')).toBe(false)
  })

  it('the previously served buckets still serve', async () => {
    for (const id of ['culture_politics', 'safety', 'schools_family', 'outdoors_nature', 'health_access', 'transport_walkable'] as const) {
      const r = await runScenario(SCENARIOS[id]!)
      expect(r.status).toBe('verified')
      expect(r.narrationLeak).toBe(false)
      expect(r.mapRelevant).toBe(false)
    }
  })
})

describe('A9 pins — decomposition accounting (FM-2 / FM-3)', () => {
  it('P15: residue beside a match becomes its own criterion with its own evidence line', async () => {
    const s = SCENARIOS.probe_arts_residue!
    expect(decomposeResearchCriteria(s.q).map((c) => c.id)).toEqual(['schools', 'combined'])
    const r = await runScenario(s)
    expect(r.evidence).toContain('School quality=met')
    expect(r.evidence).toContain('A thriving arts scene=met')
    // FM-3b: the segment criterion is accounted from the schools
    // pass's whole-question material — one research call, not two.
    expect(r.researchCalls).toBe(1)
  })

  it('cost_housing: no spurious combined line on a pure-Census question (FM-3c)', async () => {
    const s = SCENARIOS.cost_housing_bounded!
    expect(decomposeResearchCriteria(s.q)).toEqual([])
    const r = await runScenario(s)
    expect(r.status).toBe('verified')
    expect(r.evidence).toEqual(['median_gross_rent=met'])
    expect(r.places).toHaveLength(7)
    expect(r.places.every((p) => true)).toBe(true)
  })

  it('safety / nature / health: one pass, one line per stated criterion (FM-3b)', async () => {
    const safety = await runScenario(SCENARIOS.safety!)
    expect(safety.researchCalls).toBe(1)
    expect(safety.evidence).toEqual(['Safety=met'])
    const nature = await runScenario(SCENARIOS.outdoors_nature!)
    expect(nature.researchCalls).toBe(1)
    expect(nature.evidence).toEqual(['Nature and outdoors=met'])
    const health = await runScenario(SCENARIOS.health_access!)
    expect(health.researchCalls).toBe(1)
    expect(health.evidence).toEqual(['Amenities=met'])
  })

describe('A9 pins — candidate direction (FM-4)', () => {
  // Each fixture's contrast sentence describes one place as NOT
  // meeting the criterion; phase 1 measured all of them entering
  // the ranked entries. The positive and middling places (Florence's
  // "moderate flood risk", Newport's "mixed flood exposure",
  // Savannah's "moderately liberal", Macon's "politically mixed")
  // stay ranked — the marker set is the measured genre, both ways.
  const cases: [keyof typeof SCENARIOS, string[], string[]][] = [
    ['climate_weather', ['Key West, FL', 'Naples, FL'], ['Jacksonville, FL']],
    ['food_drink_beer', ['Burlington, VT', 'Brattleboro, VT'], ['Rutland, VT']],
    ['safety', ['Plano, TX', 'Frisco, TX', 'Carrollton, TX'], ['Mesquite, TX']],
    ['schools_family', ['Naperville, IL', 'Evanston, IL', 'Arlington Heights, IL'], ['Oak Lawn, IL']],
    ['outdoors_nature', ['Whitefish, MT', 'Livingston, MT', 'Red Lodge, MT'], ['Butte, MT']],
    ['work_income', ['Columbus, OH', 'Minneapolis, MN', 'Indianapolis, IN'], ['Milwaukee, WI']],
    ['health_access', ['Portland, ME', 'Bangor, ME', 'Brunswick, ME'], ['Presque Isle, ME']],
    ['transport_walkable', ['Boston, MA', 'San Francisco, CA', 'New York, NY'], ['Denver, CO']],
    ['recreation_fun', ['Traverse City, MI', 'Ann Arbor, MI', 'Grand Rapids, MI'], ['Saginaw, MI']],
    ['environment_flood', ['Bandon, OR', 'Florence, OR', 'Newport, OR'], ['Astoria, OR']],
    ['abstract_charming', ['Jacksonville, OR', 'Ashland, OR', 'Hood River, OR'], ['Eugene, OR']],
    ['probe_healthcare_wording', ['Charlottesville, VA', 'Roanoke, VA', 'Harrisonburg, VA'], ['Bedford, VA']],
    ['culture_politics', ['Athens, GA', 'Decatur, GA', 'Savannah, GA', 'Macon, GA'], []],
  ]
  for (const [id, ranked, notMeeting] of cases) {
    it(`${id}: negated-only places leave the ranked entries, named as considered-and-not-meeting`, async () => {
      const r = await runScenario(SCENARIOS[id]!)
      expect(r.places).toEqual(ranked)
      expect(r.answer.consideredNotMeeting ?? []).toEqual(notMeeting)
    })
  }
})

describe('A9 pins — decomposition accounting (FM-2 / FM-3)', () => {
  it('decomposition: criteria-less total-miss keeps the combined fallback', () => {
    expect(
      decomposeResearchCriteria('What is the cheapest place to live in the United States?').map((c) => c.id),
    ).toEqual(['combined'])
    expect(decomposeResearchCriteria('Which area near Hilo has the shortest commute?').map((c) => c.id)).toEqual(['combined'])
  })
})
})

describe('A9 pins — resolution (FM-5 bare names, FM-6 list genre)', () => {
  it('FM-5: a bare name with no bound row is recorded, not vanished (Sanibel)', async () => {
    // The battery's bound FL rows carry no Sanibel: the phase-1
    // defect was that the mention left NO record. It now lands in
    // unresolvedCandidates under its written form.
    const r = await runScenario(SCENARIOS.climate_weather!)
    expect(r.places).not.toContain('Sanibel, FL')
    expect(r.unresolved).toContain('Sanibel')
  })

  it('FM-5: a bare name carried by exactly one bound row resolves', async () => {
    const calls: { places: readonly string[]; queryText: string }[] = []
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['FL'], metricKeys: [] }),
      rows: [row('33040', 'Key West, FL', 2400), row('33957', 'Sanibel, FL', 2300)],
      researchQuery: 'What city in Florida has the best weather year-round?',
      researchCriteria: ['What city in Florida has the best weather year-round?'],
      queryText: 'What city in Florida has the best weather year-round?',
      provider: provider(
        'Key West, FL has the mildest weather in Florida. Sanibel is often praised by residents for its gentle coastal weather year-round. Answer: Key West, FL has the strongest support for the best year-round weather in Florida.',
        calls,
      ),
    })
    expect(answer.places.map((p) => p.name)).toEqual(['Key West, FL', 'Sanibel, FL'])
    expect(answer.unresolvedCandidates).not.toContain('Sanibel')
  })

  it('FM-5: an anchor city named in framing prose does not enter the ranked set', async () => {
    // "the safest suburbs of Dallas": Dallas is the anchor, named
    // mid-sentence. The first cure run resolved it as a candidate;
    // sentence-initial detection keeps it framing.
    const r = await runScenario(SCENARIOS.safety!)
    expect(r.places).not.toContain('Dallas, TX')
    const s = await runScenario(SCENARIOS.schools_family!)
    expect(s.places).not.toContain('Chicago, IL')
  })

  it('FM-5: a bare name carried by two bound rows is recorded ambiguous, never resolved', async () => {
    const calls: { places: readonly string[]; queryText: string }[] = []
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: [] }),
      rows: [row('04101', 'Portland, ME', 1500), row('97201', 'Portland, OR', 1600), row('02108', 'Boston, MA', 2400)],
      researchQuery: 'What city in the US is the most walkable without a car?',
      researchCriteria: ['What city in the US is the most walkable without a car?'],
      queryText: 'What city in the US is the most walkable without a car?',
      provider: provider(
        'Boston, MA is exceptionally walkable, with most errands on foot. Portland is also frequently named for walking. Answer: Boston has the strongest support in these findings for the stated criteria.',
        calls,
      ),
    })
    expect(answer.places.map((p) => p.name)).toEqual(['Boston, MA'])
    expect(answer.unresolvedCandidates).toContain('Portland')
  })

  it('FM-6: list-genre findings (full state names, bare follow-ups) materialize the shortlist', async () => {
    const calls: { places: readonly string[]; queryText: string }[] = []
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['Texas'], metricKeys: [] }),
      rows: [
        row('78839', 'Crystal City, TX', 812),
        row('79843', 'Marfa, TX', 975),
        row('78827', 'Asherton, TX', 640),
        row('78594', 'Sebastian, TX', 705),
        row('78701', 'Austin, TX', 1449),
      ],
      researchQuery: 'what city in Texas is the most liberal',
      researchCriteria: ['what city in Texas is the most liberal'],
      queryText: 'what city in Texas is the most liberal',
      provider: provider(
        'The most liberal cities in Texas, from recent rankings: 1. Crystal City, Texas — a small border city that votes heavily Democratic in recent elections. 2. Marfa, Texas — a desert arts town known for progressive politics. 3. Asherton, Texas — a small city that also leans strongly Democratic. 4. Sebastian, Texas — a community described as politically mixed but leaning liberal. Austin is the large-city reference and is often described as liberal. Answer: Crystal City has the strongest support in these findings for the stated criteria.',
        calls,
      ),
    })
    expect(answer.status).toBe('verified')
    // The T1 shape: at least three named qualifiers materialize as
    // entries (the live failure had exactly one).
    expect(answer.places.map((p) => p.name)).toEqual([
      'Crystal City, TX',
      'Marfa, TX',
      'Asherton, TX',
      'Sebastian, TX',
      'Austin, TX',
    ])
    expect(answer.places[0]!.zcta).toBe('78839')
  })
})

describe('A9 pins — render-once scope (FM-7)', () => {
  it('the same source at two URLs renders its title once; a title-shaped claim renders nothing and consumes no visibility', async () => {
    const { claimSourceVisibility, isSourceTitleClaim } = await import('../../src/ui/ai/AnswerCard')
    const r = await runScenario(SCENARIOS.culture_politics!)
    const answer = r.answer
    const title = '10 Most Liberal Cities in Texas'
    const urlA = 'https://example.com/a'
    const urlB = 'https://example.com/b'
    const titleClaim = { text: title, sourceUrls: [urlA] }
    const realClaim = { text: 'Athens, GA is described as a liberal college town.', sourceUrls: [urlA, urlB] }
    const laterClaim = { text: 'Decatur, GA is described as liberal-leaning.', sourceUrls: [urlB] }
    const mutated: ComposedAnswer = {
      ...answer,
      sources: [
        { title, url: urlA },
        { title, url: urlB },
      ],
      places: answer.places.map((p, i) =>
        i === 0 ? { ...p, claims: [titleClaim, realClaim] } : p,
      ),
      generalClaims: [laterClaim],
    }
    expect(isSourceTitleClaim(titleClaim, mutated.sources)).toBe(true)
    expect(isSourceTitleClaim(realClaim, mutated.sources)).toBe(false)
    const visibility = claimSourceVisibility(mutated)
    // The title claim is skipped entirely: no entry, no seen-marking.
    expect(visibility.has(titleClaim)).toBe(false)
    // The real claim shows the source once (first URL); the second
    // URL carries the same title and is the same source.
    expect(visibility.get(realClaim)).toEqual([urlA])
    // And no later claim resurrects either URL.
    expect(visibility.get(laterClaim)).toEqual([])
  })
})

describe('A9 pins — variance (FM-11: one bounded re-ask of an all-empty stage)', () => {
  const question = 'What town in Vermont has the best beer selection?'
  const prose =
    'Burlington, VT has the best beer selection in Vermont, with more craft breweries and taprooms per capita than any other town in the state. Answer: Burlington, VT has the strongest support for the best beer selection in Vermont.'

  function flakyProvider(failuresBeforeSuccess: number, calls: { n: number }) {
    return createStubProvider({
      async research() {
        calls.n++
        if (calls.n <= failuresBeforeSuccess) throw new Error('provider_down')
        return { prose, sources: [{ title: 'Findings source', url: 'https://example.com/f' }] }
      },
    })
  }

  it('a stage that fails empty is re-asked once and composes from the re-ask', async () => {
    const calls = { n: 0 }
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['VT'], metricKeys: [] }),
      rows: SCENARIOS.food_drink_beer!.rows,
      researchQuery: question,
      researchCriteria: [question],
      queryText: question,
      provider: flakyProvider(1, calls),
    })
    expect(calls.n).toBe(2)
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toContain('Burlington, VT')
  })

  it('a stage that stays down is asked exactly twice, and the note states the re-ask', async () => {
    const calls = { n: 0 }
    const answer = await runAnswerPipeline({
      // Placeless: a state-bounded total failure degrades onto the
      // Census card by the A5 ladder (a different terminal, also
      // carrying the re-ask record); the note is this shape's.
      intent: intent({ geographies: [], metricKeys: [] }),
      rows: SCENARIOS.food_drink_beer!.rows,
      researchQuery: question,
      researchCriteria: [question],
      queryText: question,
      provider: flakyProvider(Number.POSITIVE_INFINITY, calls),
    })
    expect(calls.n).toBe(2)
    expect(answer.status).toBe('empty')
    const evidence = answer.criterionEvidence.find((e) => e.kind === 'research')
    expect(evidence?.detail).toContain('asked twice')
  })

  it('a stage with material never re-asks: a partial failure keeps its single call set', async () => {
    // Two named criteria; the first returns, the second fails.
    // Partial tolerance owns this case — no stage re-ask.
    const calls = { n: 0 }
    const provider = createStubProvider({
      async research() {
        calls.n++
        if (calls.n === 1) {
          return {
            prose: 'Durango, CO schools are rated above the state average in the cited directory.',
            sources: [{ title: 'School directory', url: 'https://example.org/schools' }],
          }
        }
        throw new Error('provider_down')
      },
    })
    const text = 'best schools and the most coffee shops'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: [] }),
      rows: SCENARIOS.schools_family!.rows,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider,
    })
    expect(calls.n).toBe(2)
    expect(answer.researchFailures).toContain('Coffee nearby')
  })
})

describe('A9 pins — county shape (FM-10 / F1)', () => {
  it('requestsCountyLevel reads the subject, not the word', async () => {
    const { requestsCountyLevel } = await import('../../src/core/ai/answer')
    const bare = intent({ geographies: [], metricKeys: ['median_gross_rent'] })
    // County as subject: aggregates (the pinned shipped shapes).
    expect(requestsCountyLevel('Which county in Colorado has the lowest median rent?', bare)).toBe(true)
    expect(requestsCountyLevel("What's the median household income in Boulder County, Colorado?", bare)).toBe(true)
    expect(requestsCountyLevel('Which counties in Texas have the lowest rent?', bare)).toBe(true)
    expect(requestsCountyLevel('What is the cheapest county in Texas?', bare)).toBe(true)
    // Places within a county: the county is the bound, not the subject.
    expect(requestsCountyLevel("What's the cheapest place to live in Hawaii County?", bare)).toBe(false)
    expect(requestsCountyLevel('What towns in Cook County have the best schools?', bare)).toBe(false)
    expect(requestsCountyLevel('Where in Hawaii County is rent cheapest?', bare)).toBe(false)
  })

  it('the F1 shape composes places in the county, not the county aggregate', async () => {
    const rows = [
      row('96720', 'Hilo, HI', 1346),
      row('96749', 'Keaau, HI', 1325),
      row('96778', 'Pahoa, HI', 1750),
    ]
    const assignments = new Map(
      rows.map((r) => [r.zcta, { name: 'Hawaii County', state: 'Hawaii' }]),
    )
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['Hawaii County'], metricKeys: ['median_gross_rent'] }),
      rows,
      geographyZctas: new Set(rows.map((r) => r.zcta)),
      queryText: "What's the cheapest place to live in Hawaii County?",
      countyAssignments: assignments,
      provider: createStubProvider(),
    })
    expect(answer.status).toBe('verified')
    expect(answer.countyMethod).toBeNull()
    expect(answer.places.map((p) => p.name)).not.toContain('Hawaii County')
    expect(answer.places[0]!.name).toBe('Keaau, HI')
  })
})
