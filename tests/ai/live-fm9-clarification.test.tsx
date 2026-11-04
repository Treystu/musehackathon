// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  DISPLAYABLE_KEYS,
} from '../../src/core/ai/intent-schema'
import {
  canResolveClarification,
  resolveClarification,
} from '../../src/core/ai/intent-edit'
import {
  createStubProvider,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import {
  decomposeResearchCriteria,
  runAnswerPipeline,
} from '../../src/core/ai/answer'
import {
  AskPanel,
  isResearchFirstHandoff,
  needsResearch,
  researchFirstHandoff,
} from '../../src/ui/ai/AskPanel'
import { ClarificationPanel } from '../../src/ui/ai/ClarificationPanel'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import {
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'
import { Methodology } from '../../src/ui/Methodology'

/**
 * Live FM-9 failure (parent verification on production bef1220,
 * 2026-11-03 17:38-17:48 HST): the ef1f266 cure passed its pins but
 * not the live user path. "Which state has the oldest population?"
 * and "Which state has the most poverty?" both landed in the
 * clarification panel; picking the measure there dead-ended ("These
 * choices cannot run yet") because the clarification seam still read
 * the pre-ruling capability surface (filter-legal only), and the
 * poverty question's criterion decomposed to nothing, so the
 * research-first handoff never engaged either. These pins drive the
 * LIVE traversal — parse -> clarification entry -> terminal — not
 * only the accept seam the FM-9 pins already cover.
 */

const EMPTY_PARSE: ValidatedIntent = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

const Q1 = 'Which state has the oldest population?'
const Q2 = 'Which state has the most poverty?'

const AGE_ROWS: AreaRow[] = [
  { zcta: '44501', name: 'Youngstown, OH', metrics: { median_age: 34 }, moes: { median_age: 1 } },
  { zcta: '66001', name: 'Midway, KS', metrics: { median_age: 47 }, moes: { median_age: 2 } },
  { zcta: '04201', name: 'Old Town, ME', metrics: { median_age: 58 }, moes: { median_age: 2 } },
]

// The poverty figures deliberately disagree with the research claim
// order: Burlington carries the larger count, so any figure ranking
// (either direction) puts it first or last — never second.
const POVERTY_ROWS: AreaRow[] = [
  { zcta: '04401', name: 'Greenville, ME', metrics: { below_poverty_count: 4000 }, moes: { below_poverty_count: 300 } },
  { zcta: '05401', name: 'Burlington, VT', metrics: { below_poverty_count: 9000 }, moes: { below_poverty_count: 500 } },
]

function povertyResearchProvider() {
  return createStubProvider({
    async research() {
      return {
        prose:
          'Greenville, ME has the most poverty of these places in recent reporting. ' +
          'Burlington, VT also has substantial poverty. ' +
          'Answer: Greenville, ME has the strongest support for the most poverty.',
        sources: [{ title: 'Poverty reporting', url: 'https://example.com/poverty' }],
      }
    },
  })
}

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

describe('live FM-9: the demographic superlative criteria decompose', () => {
  it('Q2 states a poverty criterion; an ordinary poverty lookup states none', () => {
    expect(decomposeResearchCriteria(Q2).map((c) => c.id)).toContain('poverty')
    expect(needsResearch(Q2)).toBe(true)
    expect(
      decomposeResearchCriteria('How many people are below the poverty line in 78701?').map(
        (c) => c.id,
      ),
    ).not.toContain('poverty')
    expect(
      decomposeResearchCriteria('Which town has the most college graduates?').map((c) => c.id),
    ).toContain('attainment')
  })

  it('the empty clarifying parse for Q2 hands off research-first', () => {
    const handedOff = researchFirstHandoff(EMPTY_PARSE, Q2)
    expect(handedOff).not.toBeNull()
    expect(isResearchFirstHandoff(handedOff!)).toBe(true)
  })
})

describe('live FM-9: Q1 through the clarification panel to a screen card', () => {
  it('a placeless median-age pick completes as the national screen (core seam)', () => {
    expect(
      canResolveClarification({ mode: 'lookup', geographies: [], metricKeys: ['median_age'] }),
    ).toBe(true)
    const resolved = resolveClarification(EMPTY_PARSE, {
      geographies: [],
      metricKeys: ['median_age'],
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.intent.mode).toBe('sweep_filter')
      expect(resolved.intent.geographies).toEqual([])
      expect(resolved.intent.metricKeys).toEqual(['median_age'])
      expect(resolved.intent.clarificationNeeded).toBe(false)
    }
    // A non-rank, non-demographic measure still cannot complete placeless.
    expect(
      canResolveClarification({ mode: 'lookup', geographies: [], metricKeys: ['population'] }),
    ).toBe(false)
  })

  it('parse -> panel -> Median age pick -> figure-ordered median-age card', async () => {
    const onExecute = vi.fn()
    const requests: { intent: ValidatedIntent; queryText: string }[] = []
    const provider = createStubProvider({
      async intent() {
        return { intent: EMPTY_PARSE }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={onExecute}
        onAnswerRequest={(intent, queryText) => requests.push({ intent, queryText })}
        clarificationCandidates={{ geographies: [], metricKeys: [...DISPLAYABLE_KEYS] }}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask(Q1)
    const section = clarificationSection()
    expect(section).not.toBeNull()
    clickIn(section!, 'Median age')
    expect(onExecute).toHaveBeenCalledTimes(1)
    const executed = onExecute.mock.calls[0]?.[0] as ValidatedIntent
    expect(executed).toMatchObject({
      mode: 'sweep_filter',
      geographies: [],
      metricKeys: ['median_age'],
      clarificationNeeded: false,
    })
    expect(requests).toHaveLength(1)

    const answer = await composeAnswerForRequest({
      intent: executed,
      queryText: Q1,
      rows: AGE_ROWS,
      resolved: resolveAnswerGeographies(executed, null),
      provider: createStubProvider(),
      research: false,
    })
    expect(answer?.status).toBe('verified')
    // The screen's ranking contract, as cure round 3 (2026-11-03)
    // changed it: the order follows the QUESTION's direction, read
    // from the reader's words at the answer layer. This traversal
    // composes with no place index, so no state aggregates can
    // form and the terminal is the ZIP screen — ordered oldest
    // first for "oldest", where round 2 asserted the ascending
    // order the live probe showed was the defect. (With the index
    // the same traversal terminates at state level; that terminal
    // is pinned in live-fm9-round3.test.tsx.)
    expect(answer?.places.map((p) => p.name)).toEqual(['Old Town, ME', 'Midway, KS', 'Youngstown, OH'])
    expect(answer?.places.map((p) => p.figures.find((f) => f.key === 'median_age')?.value)).toEqual([
      58, 47, 34,
    ])

    render(<AnswerCard answer={answer!} />)
    const text = container.textContent ?? ''
    expect(text.indexOf('Old Town, ME')).toBeLessThan(text.indexOf('Midway, KS'))
    expect(text.indexOf('Midway, KS')).toBeLessThan(text.indexOf('Youngstown, OH'))
  })
})

describe('live FM-9: Q2 to the research-first card', () => {
  it('parse -> research-first handoff (no panel) -> claim-ordered card', async () => {
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
    await ask(Q2)
    expect(clarificationSection()).toBeNull()
    expect(requests).toHaveLength(1)
    expect(isResearchFirstHandoff(requests[0]!.intent)).toBe(true)

    const answer = await runAnswerPipeline({
      intent: requests[0]!.intent,
      rows: POVERTY_ROWS,
      researchQuery: Q2,
      queryText: Q2,
      provider: povertyResearchProvider(),
    })
    expect(answer.status).toBe('verified')
    expect(answer.researchCriteria.map((c) => c.id)).toContain('poverty')
    // Claim order (Greenville, Burlington): the poverty figure
    // never ranks — figure order would not put Burlington second.
    expect(answer.places.map((p) => p.name)).toEqual(['Greenville, ME', 'Burlington, VT'])
  })

  it('a poverty pick inside the panel resolves to the handoff, not "cannot run yet"', async () => {
    const onResolve = vi.fn()
    render(
      <ClarificationPanel
        intent={EMPTY_PARSE}
        candidates={{ geographies: [], metricKeys: [...DISPLAYABLE_KEYS] }}
        onResolve={onResolve}
      />,
    )
    const section = clarificationSection()
    expect(section).not.toBeNull()
    clickIn(section!, 'People below the poverty line')
    expect(onResolve).toHaveBeenCalledTimes(1)
    const resolved = onResolve.mock.calls[0]?.[0] as ValidatedIntent
    expect(resolved.metricKeys).toEqual([])
    expect(resolved.clarificationNeeded).toBe(false)
    expect(isResearchFirstHandoff(resolved)).toBe(true)

    const answer = await runAnswerPipeline({
      intent: resolved,
      rows: POVERTY_ROWS,
      researchQuery: Q2,
      queryText: Q2,
      provider: povertyResearchProvider(),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toEqual(['Greenville, ME', 'Burlington, VT'])
  })
})

describe('live FM-9: Methodology states the ruled posture', () => {
  it('median age is Ask-rank-legal in the dictionary; the four figures carry the research-first rule', () => {
    render(<Methodology />)
    const text = container.textContent ?? ''
    expect(text).not.toContain('never offered as a sort or filter control')
    expect(text).not.toContain('It will not sort or rank places by age')
    expect(text).toContain('may order an Ask answer')
    expect(text).toContain('answered research-first')
    // Broadband's shipped exception, stated as shipped: where the
    // internet criterion maps to the screened figure, the figure
    // assesses the criterion on the card.
    expect(text).toContain('assesses the criterion')
  })
})
