// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { DISPLAYABLE_KEYS } from '../../src/core/ai/intent-schema'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import {
  rankDirectionFromQuery,
  requestsStateLevel,
  runAnswerPipeline,
} from '../../src/core/ai/answer'
import { AskPanel } from '../../src/ui/ai/AskPanel'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'
import { PlaceIndex } from '../../src/core/zcta-place-index'

/**
 * Cure round 3 — the FM-9 median-age superlative on the live path,
 * second failure shape (parent probes on production 4a44ce4,
 * 2026-11-03 18:13-18:22 HST). The round-2 cure made the
 * clarification completion RUN; the live traversal then terminated
 * in a national ZIP screen ordered ASCENDING by median age
 * (youngest first — the exact inverse of "oldest"), with no
 * margins, no verified framing, the stale clarification banner
 * standing over the completed answer, and a false bound-failure
 * note beside it. Four defects, four general mechanisms:
 * direction read from the reader's words at the answer layer;
 * the state-unit reading answered by the shipped state-aggregate
 * machinery over every state; the screen carrying the published
 * median-age margin (pinned in screen-median-age-margin.test.ts);
 * and the clarification chrome retiring when the run it waited
 * for executes. These pins reproduce the live traversal — both
 * clarification shapes the probes produced — end to end.
 */

const Q1 = 'Which state has the oldest population?'
const Q1_YOUNGEST = 'Which state has the youngest population?'

const EMPTY_PARSE: ValidatedIntent = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

/** Run A's shape: the parse already carries the measure as a
 * placeless sweep but still asks for clarification. */
const CLARIFYING_SWEEP_PARSE: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: [],
  metricKeys: ['median_age'],
  filters: [],
  clarificationNeeded: true,
}

const SWEEP_MEDIAN_AGE: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: [],
  metricKeys: ['median_age'],
  filters: [],
  clarificationNeeded: false,
}

// A three-state country. Maine's aggregate median age is the
// population-weighted (55*100 + 53*300) / 400 = 53.5, Florida's is
// 46, Utah's is 32 — so the descending state order (Maine, Florida,
// Utah) differs from the ascending one at every position, and the
// ZIP order differs from both.
const STATE_ROWS: AreaRow[] = [
  { zcta: '03901', name: 'Kittery, ME', metrics: { median_age: 55, population: 100 }, moes: { median_age: 2 } },
  { zcta: '03902', name: 'York, ME', metrics: { median_age: 53, population: 300 }, moes: { median_age: 1 } },
  { zcta: '33001', name: 'Key West, FL', metrics: { median_age: 45, population: 200 }, moes: { median_age: 3 } },
  { zcta: '33002', name: 'Marathon, FL', metrics: { median_age: 47, population: 200 }, moes: { median_age: 1 } },
  { zcta: '84001', name: 'Provo, UT', metrics: { median_age: 30, population: 100 }, moes: { median_age: 2 } },
  { zcta: '84002', name: 'Orem, UT', metrics: { median_age: 34, population: 100 }, moes: { median_age: 2 } },
]

const STATE_INDEX = new PlaceIndex(
  new Map(
    STATE_ROWS.map((row) => {
      const [town, state] = row.name.split(', ') as [string, string]
      return [
        row.zcta,
        {
          zip: row.zcta,
          censusName: `${town} city`,
          displayName: town,
          state,
          isCity: true,
          incorporated: true,
        },
      ] as const
    }),
  ),
  [
    { displayName: 'Kittery', censusName: 'Kittery city', state: 'ME', isCity: true, zips: ['03901'] },
    { displayName: 'York', censusName: 'York city', state: 'ME', isCity: true, zips: ['03902'] },
    { displayName: 'Key West', censusName: 'Key West city', state: 'FL', isCity: true, zips: ['33001'] },
    { displayName: 'Marathon', censusName: 'Marathon city', state: 'FL', isCity: true, zips: ['33002'] },
    { displayName: 'Provo', censusName: 'Provo city', state: 'UT', isCity: true, zips: ['84001'] },
    { displayName: 'Orem', censusName: 'Orem city', state: 'UT', isCity: true, zips: ['84002'] },
  ],
)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

async function ask(text: string) {
  const input = container.querySelector('#ask-input') as HTMLInputElement
  const form = container.querySelector('form') as HTMLFormElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

function clarificationSection(): HTMLElement | null {
  return container.querySelector('[aria-label="Clarify the request"]')
}

function clickIn(section: HTMLElement, text: string) {
  const button = [...section.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!button) throw new Error(`button not found: ${text}`)
  act(() => button.click())
}

/** The terminal the acceptance names: state-level, descending,
 * margins carried, verified. Shared by both picker variants. */
async function expectStateTerminal(executed: ValidatedIntent) {
  const answer = await composeAnswerForRequest({
    intent: executed,
    queryText: Q1,
    rows: STATE_ROWS,
    resolved: resolveAnswerGeographies(executed, STATE_INDEX),
    provider: createStubProvider(),
    research: false,
    placeIndex: STATE_INDEX,
    stack: false,
  })
  expect(answer?.status).toBe('verified')
  expect(answer?.geographyLevel).toBe('state')
  expect(answer?.stateMethod).toContain('not official Census state margins')
  expect(answer?.places.map((p) => p.name)).toEqual([
    'Maine state average',
    'Florida state average',
    'Utah state average',
  ])
  const figures = answer!.places.map((p) => p.figures.find((f) => f.key === 'median_age')!)
  expect(figures.map((f) => f.value)).toEqual([53.5, 46, 32])
  // Population-weighted RMS margins over the member rows:
  // Maine sqrt((100*4 + 300*1)/400), Florida sqrt((200*9 + 200*1)/400),
  // Utah sqrt((100*4 + 100*4)/200). Approximate, and labelled so.
  expect(figures[0]!.marginOfError).toBeCloseTo(Math.sqrt(1.75), 10)
  expect(figures[1]!.marginOfError).toBeCloseTo(Math.sqrt(5), 10)
  expect(figures[2]!.marginOfError).toBeCloseTo(2, 10)
  expect(figures.every((f) => f.marginApproximate === true)).toBe(true)

  render(<AnswerCard answer={answer!} />)
  const text = container.textContent ?? ''
  expect(text.indexOf('Maine state average')).toBeLessThan(text.indexOf('Florida state average'))
  expect(text.indexOf('Florida state average')).toBeLessThan(text.indexOf('Utah state average'))
  // Median age renders in whole years on the card (54 for the exact
  // 53.5 asserted at the figure level above).
  expect(text).toContain('54')
  expect(text).toContain('±')
  expect(text).toContain('approx.')
  expect(text).toContain('not official Census state margins')
  // No stale clarification artifact renders over the answer.
  expect(text).not.toContain('More detail is needed before anything runs')
  expect(text).not.toContain('This bound cannot be set on the screening table')
}

describe('round 3: the direction and state-unit readings', () => {
  it('direction comes from the reader\u2019s superlative, defaulting to ascending', () => {
    expect(rankDirectionFromQuery(Q1)).toBe('descending')
    expect(rankDirectionFromQuery('Which state has the highest median household income?')).toBe(
      'descending',
    )
    expect(rankDirectionFromQuery('Where is rent most expensive?')).toBe('descending')
    expect(rankDirectionFromQuery(Q1_YOUNGEST)).toBe('ascending')
    expect(rankDirectionFromQuery('What is the cheapest place to live?')).toBe('ascending')
    expect(rankDirectionFromQuery('Screen the whole country by median age.')).toBe('ascending')
    expect(rankDirectionFromQuery(undefined)).toBe('ascending')
    // Opposed stems cancel to the shipped default rather than
    // guessing which superlative binds the ranked figure.
    expect(rankDirectionFromQuery('the oldest and cheapest places')).toBe('ascending')
  })

  it('the state-unit reading names the state as subject, not as bound', () => {
    expect(requestsStateLevel(Q1, SWEEP_MEDIAN_AGE)).toBe(true)
    expect(requestsStateLevel('Which states have the highest income?', SWEEP_MEDIAN_AGE)).toBe(true)
    expect(requestsStateLevel('Rank the states by median age', SWEEP_MEDIAN_AGE)).toBe(true)
    // A place question bounded by a state: the state is the bound.
    expect(requestsStateLevel('What is the cheapest place to live in Texas?', SWEEP_MEDIAN_AGE)).toBe(
      false,
    )
    // "United States" names the country, not a state subject.
    expect(
      requestsStateLevel('Does the United States have the oldest population?', SWEEP_MEDIAN_AGE),
    ).toBe(false)
    // An intent that already names geographies is the named paths' work.
    expect(
      requestsStateLevel(Q1, { ...SWEEP_MEDIAN_AGE, geographies: ['Maine'] }),
    ).toBe(false)
    expect(requestsStateLevel('Screen the whole country by median age.', SWEEP_MEDIAN_AGE)).toBe(
      false,
    )
  })
})

describe('round 3: the pipeline orders a bound-less sweep by the question\u2019s direction', () => {
  it('Q1\u2019s words order the ZIP screen oldest-first; youngest and neutral words keep ascending', async () => {
    const descending = await runAnswerPipeline({
      intent: SWEEP_MEDIAN_AGE,
      rows: STATE_ROWS,
      queryText: Q1,
      provider: createStubProvider(),
    })
    expect(descending.status).toBe('verified')
    expect(descending.places.map((p) => p.zcta)).toEqual([
      '03901',
      '03902',
      '33002',
      '33001',
      '84002',
      '84001',
    ])

    const ascending = await runAnswerPipeline({
      intent: SWEEP_MEDIAN_AGE,
      rows: STATE_ROWS,
      queryText: Q1_YOUNGEST,
      provider: createStubProvider(),
    })
    expect(ascending.places.map((p) => p.zcta)).toEqual([
      '84001',
      '84002',
      '33001',
      '33002',
      '03902',
      '03901',
    ])

    const neutral = await runAnswerPipeline({
      intent: SWEEP_MEDIAN_AGE,
      rows: STATE_ROWS,
      queryText: 'Screen the whole country by median age.',
      provider: createStubProvider(),
    })
    expect(neutral.places.map((p) => p.zcta)).toEqual([
      '84001',
      '84002',
      '33001',
      '33002',
      '03902',
      '03901',
    ])
  })

  it('the county aggregates take the same direction reading', async () => {
    const rows: AreaRow[] = [
      { zcta: '80301', name: 'Boulder, CO', metrics: { median_household_income: 90000, population: 30000 }, moes: { median_household_income: 4000 } },
      { zcta: '80302', name: 'Boulder, CO', metrics: { median_household_income: 70000, population: 10000 }, moes: { median_household_income: 3500 } },
      { zcta: '80202', name: 'Denver, CO', metrics: { median_household_income: 65000, population: 20000 }, moes: { median_household_income: 3000 } },
      { zcta: '80203', name: 'Denver, CO', metrics: { median_household_income: 75000, population: 20000 }, moes: { median_household_income: 3200 } },
    ]
    const assignments = new Map([
      ['80301', { name: 'Boulder County', state: 'CO' }],
      ['80302', { name: 'Boulder County', state: 'CO' }],
      ['80202', { name: 'Denver County', state: 'CO' }],
      ['80203', { name: 'Denver County', state: 'CO' }],
    ])
    const intent: ValidatedIntent = {
      mode: 'sweep_filter',
      geographies: ['Colorado'],
      metricKeys: ['median_household_income'],
      filters: [],
      clarificationNeeded: false,
    }
    const highest = await runAnswerPipeline({
      intent,
      rows,
      geographyZctas: new Set(rows.map((r) => r.zcta)),
      queryText: 'Which county in Colorado has the highest median household income?',
      countyAssignments: assignments,
      provider: createStubProvider(),
    })
    // Boulder's weighted mean is 85,000; Denver's is 70,000.
    expect(highest.places.map((p) => p.name)).toEqual(['Boulder County, CO', 'Denver County, CO'])
    const lowest = await runAnswerPipeline({
      intent,
      rows,
      geographyZctas: new Set(rows.map((r) => r.zcta)),
      queryText: 'Which county in Colorado has the lowest median household income?',
      countyAssignments: assignments,
      provider: createStubProvider(),
    })
    expect(lowest.places.map((p) => p.name)).toEqual(['Denver County, CO', 'Boulder County, CO'])
  })
})

describe('round 3: Q1 through both live clarification shapes', () => {
  it('variant B: empty parse -> measure panel -> Median age pick -> state terminal, banner retired', async () => {
    const requests: { intent: ValidatedIntent; queryText: string }[] = []
    const provider = createStubProvider({
      async intent() {
        return { intent: EMPTY_PARSE }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={() => ''}
        onAnswerRequest={(intent, queryText) => requests.push({ intent, queryText })}
        clarificationCandidates={{ geographies: [], metricKeys: [...DISPLAYABLE_KEYS] }}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask(Q1)
    const section = clarificationSection()
    expect(section).not.toBeNull()
    expect(container.textContent ?? '').toContain('More detail is needed before anything runs')
    clickIn(section!, 'Median age')
    expect(requests).toHaveLength(1)
    const executed = requests[0]!.intent
    expect(executed).toMatchObject({
      mode: 'sweep_filter',
      geographies: [],
      metricKeys: ['median_age'],
      clarificationNeeded: false,
    })
    // The banner retired with the run: the note now states the
    // completion — direction and level included — and the picker
    // is gone.
    const panelText = container.textContent ?? ''
    expect(panelText).not.toContain('More detail is needed before anything runs')
    expect(panelText).toContain(
      'This screens the whole country by median age, highest first, answered at state level.',
    )
    expect(clarificationSection()).toBeNull()

    await expectStateTerminal(executed)
  })

  it('variant A: a clarifying sweep parse executes at parse with the completion note, never the banner', async () => {
    const requests: { intent: ValidatedIntent; queryText: string }[] = []
    const provider = createStubProvider({
      async intent() {
        return { intent: CLARIFYING_SWEEP_PARSE }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={() => ''}
        onAnswerRequest={(intent, queryText) => requests.push({ intent, queryText })}
        clarificationCandidates={{ geographies: [], metricKeys: [...DISPLAYABLE_KEYS] }}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask(Q1)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.intent).toMatchObject({
      mode: 'sweep_filter',
      geographies: [],
      metricKeys: ['median_age'],
    })
    // The runnability owner re-stamps this parse runnable (its
    // clarification flag does not survive withRunnability), so it
    // executes at parse and no clarification chrome ever stands:
    // neither the banner nor a rescued-screen note claiming the
    // opposite direction.
    const panelText = container.textContent ?? ''
    expect(panelText).not.toContain('More detail is needed before anything runs')
    expect(panelText).not.toContain('lowest first')
    expect(clarificationSection()).toBeNull()

    await expectStateTerminal(requests[0]!.intent)
  })

  it('the direct-bind path (no clarification anywhere) reaches the same terminal', async () => {
    const answer = await composeAnswerForRequest({
      intent: SWEEP_MEDIAN_AGE,
      queryText: Q1,
      rows: STATE_ROWS,
      resolved: resolveAnswerGeographies(SWEEP_MEDIAN_AGE, STATE_INDEX),
      provider: createStubProvider(),
      research: false,
      placeIndex: STATE_INDEX,
      stack: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.geographyLevel).toBe('state')
    expect(answer?.places.map((p) => p.name)).toEqual([
      'Maine state average',
      'Florida state average',
      'Utah state average',
    ])
  })
})
