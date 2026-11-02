// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  createStubProvider,
  type ResearchRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import {
  AskPanel,
  answerEligible,
  hasAmbiguousPlaceCandidates,
  isResearchFirstHandoff,
  researchFirstCriteria,
  researchFirstHandoff,
} from '../../src/ui/ai/AskPanel'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import {
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'
import {
  PlaceIndex,
  type PlaceRecord,
  type PlaceSuggestion,
} from '../../src/core/zcta-place-index'

/**
 * Research-first handoff (owner requirement, 2026-11-02 08:29 HST:
 * a partially servable question gets a partial grounded answer,
 * never a dead-end clarification). The Answer Layer's research-first
 * path shipped in 078dda4 but the live Ask path never reached it —
 * an external-only parse clarified and stopped. These tests drive
 * the Ask flow: parse in, handoff out (no clarification rendered),
 * the pipeline over canned seams, the card.
 */

const OWNER_QUESTION =
  'Which area has the best schools and the fewest fast food restaurants?'

const ROWS: AreaRow[] = [
  {
    zcta: '96720',
    name: 'Hilo, HI',
    metrics: { median_gross_rent: 1450 },
    moes: { median_gross_rent: 85 },
  },
  {
    zcta: '96749',
    name: 'Keaau, HI',
    metrics: { median_gross_rent: 1325 },
    moes: { median_gross_rent: 120 },
  },
  {
    zcta: '73301',
    name: 'Austin, TX',
    metrics: { median_gross_rent: 1800 },
    moes: { median_gross_rent: 110 },
  },
]

const HI_INDEX_PLACES: PlaceSuggestion[] = [
  { displayName: 'Hilo', censusName: 'Hilo CDP', state: 'HI', isCity: true, zips: ['96720'] },
  { displayName: 'Keaau', censusName: 'Keaau CDP', state: 'HI', isCity: true, zips: ['96749'] },
]
const HI_INDEX = new PlaceIndex(
  new Map<string, PlaceRecord>(
    HI_INDEX_PLACES.flatMap((place) =>
      place.zips.map(
        (zip) =>
          [
            zip,
            {
              zip,
              censusName: place.censusName,
              displayName: place.displayName,
              state: place.state,
              isCity: true,
              incorporated: true,
            },
          ] as const,
      ),
    ),
  ),
  HI_INDEX_PLACES,
)

/** The external-only parse shape: no Census bound, no measure, clarification. */
function externalOnlyParse(geographies: string[]): ValidatedIntent {
  return {
    mode: 'lookup',
    geographies,
    metricKeys: [],
    filters: [],
    clarificationNeeded: true,
  }
}

/** Canned research naming Hilo for both of the owner's criteria. */
function cannedResearch(calls?: ResearchRequest[]) {
  return createStubProvider({
    async research(req) {
      calls?.push(req)
      return {
        prose:
          'Hilo, HI elementary schools are rated above the state average in the cited directory. ' +
          'Hilo, HI has few fast-food outlets along its main street.',
        sources: [
          { title: 'State school directory', url: 'https://example.org/schools' },
          { title: 'Local dining guide', url: 'https://example.org/dining' },
        ],
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

describe("research-first handoff: the owner's exact example, end to end", () => {
  it('"Which area has the best schools and the fewest fast food restaurants?" -> handoff (no clarification) -> research-first pipeline -> card', async () => {
    const requests: { intent: ValidatedIntent; queryText: string }[] = []
    const onExecute = vi.fn()
    const provider = createStubProvider({
      async intent() {
        return { intent: externalOnlyParse([]) }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={onExecute}
        onAnswerRequest={(intent, queryText) => requests.push({ intent, queryText })}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask(OWNER_QUESTION)

    // The clarification dead-end is gone, and the handoff intent —
    // the parse verbatim with the flag cleared — reached the answer
    // layer with the reader's exact words.
    expect(clarificationSection()).toBeNull()
    expect(container.textContent).not.toContain('More detail is needed before anything runs')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.queryText).toBe(OWNER_QUESTION)
    expect(requests[0]?.intent).toEqual({
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: false,
    })
    expect(isResearchFirstHandoff(requests[0]!.intent)).toBe(true)
    expect(answerEligible(requests[0]!.intent)).toBe(true)
    // Placeless: no view execution — the answer layer owns this one.
    expect(onExecute).not.toHaveBeenCalled()

    // The research-first pipeline over canned seams composes the card.
    const answer = await composeAnswerForRequest({
      intent: requests[0]!.intent,
      queryText: OWNER_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(requests[0]!.intent, HI_INDEX),
      provider: cannedResearch(),
      research: true,
      placeIndex: HI_INDEX,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.researchCriteria.map((c) => c.id)).toEqual(['schools', 'fast_food'])
    expect(answer?.places.map((p) => p.name)).toEqual(['Hilo, HI'])
    const schools = answer?.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(schools?.status).toBe('met')
    const fastFood = answer?.criterionEvidence.find(
      (e) => e.criterion === 'Fast food restaurants',
    )
    expect(fastFood?.status).toBe('partially_measured')

    render(<AnswerCard answer={answer!} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Hilo, HI')
    expect(text).toContain('$1,450/mo')
    expect(text).toContain('School quality')
    expect(text).toContain('partially measured')
  })

  it('"best schools near Hilo" hands off with the geography bound carried into research', async () => {
    const requests: { intent: ValidatedIntent; queryText: string }[] = []
    const onExecute = vi.fn()
    const provider = createStubProvider({
      async intent() {
        return { intent: externalOnlyParse(['Hilo']) }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={onExecute}
        onAnswerRequest={(intent, queryText) => requests.push({ intent, queryText })}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask('best schools near Hilo')
    expect(clarificationSection()).toBeNull()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.intent.geographies).toEqual(['Hilo'])
    // A placed handoff still opens its geography in the views.
    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({ geographies: ['Hilo'] })

    // The bound rides into the pipeline: every research pass is
    // scoped to the named geography.
    const researchCalls: ResearchRequest[] = []
    const answer = await composeAnswerForRequest({
      intent: requests[0]!.intent,
      queryText: 'best schools near Hilo',
      rows: ROWS,
      resolved: resolveAnswerGeographies(requests[0]!.intent, HI_INDEX),
      provider: cannedResearch(researchCalls),
      research: true,
      placeIndex: HI_INDEX,
    })
    expect(researchCalls.length).toBeGreaterThan(0)
    for (const call of researchCalls) {
      expect(call.places).toEqual(['Hilo'])
    }
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.name)).toEqual(['Hilo, HI'])
  })
})

describe('research-first handoff: the discriminator', () => {
  it('separates same-name candidates (ambiguity) from two named places', () => {
    expect(hasAmbiguousPlaceCandidates(['Springfield, IL', 'Springfield, MO'])).toBe(true)
    expect(hasAmbiguousPlaceCandidates(['Springfield', 'Springfield, IL'])).toBe(true)
    expect(hasAmbiguousPlaceCandidates(['Hilo', 'Austin'])).toBe(false)
    expect(hasAmbiguousPlaceCandidates(['Hilo'])).toBe(false)
    expect(hasAmbiguousPlaceCandidates([])).toBe(false)
  })

  it('hands off external-only parses, placeless and geography-bound', () => {
    expect(researchFirstHandoff(externalOnlyParse([]), OWNER_QUESTION)).toEqual({
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: false,
    })
    expect(
      researchFirstHandoff(externalOnlyParse(['Hilo']), 'best schools near Hilo'),
    ).toMatchObject({ geographies: ['Hilo'], clarificationNeeded: false })
  })

  it('carries combined-criterion questions the catalog cannot split', () => {
    // "Commute" fires the outside-knowledge triggers but no catalog
    // entry, so the decomposition is the one combined criterion —
    // servable as that, per the catalog's own carry.
    expect(researchFirstCriteria('Which area near Hilo has the shortest commute?').map((c) => c.id)).toEqual([
      'combined',
    ])
    expect(
      researchFirstHandoff(
        externalOnlyParse(['Hilo']),
        'Which area near Hilo has the shortest commute?',
      ),
    ).not.toBeNull()
  })

  it('keeps clarification for every not-servable shape', () => {
    // CHANGED (P3 step 2, battery A3 — recompiled plan is the
    // authority): a retained metricKey alone is no longer a
    // not-servable shape. The shipped exclusion dropped every
    // servable part of A3 (the parse kept median_home_value and both
    // partial-answer paths refused it); the retained measure now
    // rides along as chosen and the handoff fires. A FILTER remains
    // runnable Census content and still keeps clarification below.
    expect(
      researchFirstHandoff(
        { ...externalOnlyParse([]), metricKeys: ['median_gross_rent'] },
        OWNER_QUESTION,
      ),
    ).toMatchObject({ metricKeys: ['median_gross_rent'], clarificationNeeded: false })
    expect(
      researchFirstHandoff(
        {
          ...externalOnlyParse([]),
          filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
        },
        OWNER_QUESTION,
      ),
    ).toBeNull()
    // Genuine ambiguity in the current parse: the panel's case.
    expect(
      researchFirstHandoff(
        externalOnlyParse(['Springfield, IL', 'Springfield, MO']),
        'best schools in Springfield',
      ),
    ).toBeNull()
    // No criteria at all: the safety corpus posture.
    expect(researchFirstCriteria('best place to raise a family')).toEqual([])
    expect(
      researchFirstHandoff(externalOnlyParse(['Texas']), 'best place to raise a family in Texas'),
    ).toBeNull()
    // Characterization doing the asking: safety posture unchanged.
    expect(
      researchFirstHandoff(externalOnlyParse([]), 'best schools in a mostly Black neighborhood'),
    ).toBeNull()
    expect(
      researchFirstHandoff(externalOnlyParse(['Hilo']), 'best schools in a liberal area near Hilo'),
    ).toBeNull()
    // A runnable intent never hands off; neither does a missing question.
    expect(
      researchFirstHandoff(
        { ...externalOnlyParse(['Hilo']), clarificationNeeded: false, metricKeys: ['median_gross_rent'] },
        'best schools near Hilo',
      ),
    ).toBeNull()
    expect(researchFirstHandoff(externalOnlyParse([]), undefined)).toBeNull()
  })

  it('the handoff marker reads only the state the handoff produces', () => {
    expect(isResearchFirstHandoff(externalOnlyParse([]))).toBe(false)
    expect(
      isResearchFirstHandoff({ ...externalOnlyParse([]), clarificationNeeded: false }),
    ).toBe(true)
    expect(
      isResearchFirstHandoff({
        mode: 'lookup',
        geographies: ['Hilo'],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(false)
    // The marker's limit, pinned: it trusts the single-owner flag
    // invariant (withRunnability stamps clarificationNeeded =
    // !canRun on every parse/editor/clarification path), so a
    // hand-built settled-but-unrunnable intent with no Census
    // content reads as a handoff. No shipped path builds one except
    // researchFirstHandoff.
  })
})

describe('research-first handoff: clarification keeps its cases at the panel', () => {
  it('"best place to raise a family" still clarifies and hands nothing to the pipeline', async () => {
    const requests: unknown[] = []
    const provider = createStubProvider({
      async intent() {
        return { intent: externalOnlyParse([]) }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={() => ''}
        onAnswerRequest={(intent, queryText) => requests.push({ intent, queryText })}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask('Where is the best place to raise a family?')
    expect(clarificationSection()).not.toBeNull()
    expect(requests).toHaveLength(0)
  })

  it('an ambiguous Springfield external question still clarifies, and standalone research remains its fallback', async () => {
    const requests: unknown[] = []
    const researchCalls: ResearchRequest[] = []
    const provider = createStubProvider({
      async intent() {
        return { intent: externalOnlyParse(['Springfield, IL', 'Springfield, MO']) }
      },
      async research(req) {
        researchCalls.push(req)
        return {
          prose: 'Springfield schools include well-rated options in both states.',
          sources: [{ title: 'School directory', url: 'https://example.org/schools' }],
        }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={() => ''}
        onAnswerRequest={(intent, queryText) => requests.push({ intent, queryText })}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask('best schools in Springfield')
    expect(clarificationSection()).not.toBeNull()
    expect(requests).toHaveLength(0)
    expect(researchCalls).toHaveLength(1)
  })
})
