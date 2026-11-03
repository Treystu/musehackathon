// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAnswerPipeline, type ComposedAnswer } from '../../src/core/ai/answer'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'

/**
 * AnswerCard states (2026-11-02, answer-first directive). Answers are
 * built through the real pipeline over fixture rows with a canned
 * research provider — no live calls — so each rendered state is the
 * state the verify stage actually produced.
 */
const ROWS: AreaRow[] = [
  {
    zcta: '96720',
    name: 'Hilo, HI',
    metrics: { median_gross_rent: 1450, median_home_value: 440000, households: 14000 },
    moes: { median_gross_rent: 85, median_home_value: 25000, households: 420 },
  },
  {
    zcta: '96749',
    name: 'Keaau, HI',
    metrics: { median_gross_rent: 1325, median_home_value: 385000, households: 5200 },
    moes: { median_gross_rent: 120, median_home_value: 31000, households: 260 },
  },
  {
    zcta: '96778',
    name: 'Pahoa, HI',
    metrics: { median_gross_rent: 1750, median_home_value: 340000, households: 6100 },
    moes: { median_gross_rent: 150, median_home_value: 28000, households: 300 },
  },
]

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: ['median_gross_rent'],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
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

describe('AnswerCard', () => {
  it('verified criteria answer renders place headlines, formatted figures, and cited claims', async () => {
    const provider = createStubProvider({
      async research() {
        return {
          prose:
            'Hilo, HI has two elementary schools within the district. Keaau, HI hosts a Sunday farmers market.',
          sources: [
            { title: 'Hawaii DOE', url: 'https://example.org/doe' },
            { title: 'Market guide', url: 'https://example.org/market' },
          ],
        }
      },
    })
    const answer = await runAnswerPipeline({
      intent: intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] }),
      rows: ROWS,
      researchQuery: 'places under the rent bound with elementary schools nearby',
      provider,
    })
    expect(answer.status).toBe('verified')
    render(<AnswerCard answer={answer} />)
    const text = container.textContent ?? ''
    // Both screened places headline; Pahoa (rent 1750) is not named.
    expect(text).toContain('Hilo, HI')
    expect(text).toContain('Keaau, HI')
    expect(text).not.toContain('Pahoa, HI')
    // Display order follows the deciding figure, cheapest first —
    // the same order the screening table below is sorted in.
    expect(text.indexOf('Keaau, HI')).toBeLessThan(text.indexOf('Hilo, HI'))
    // Figures formatted as the data views format them, margin beside.
    expect(text).toContain('$1,450/mo')
    expect(text).toContain('±85')
    expect(text).toContain('$1,325/mo')
    expect(text).toContain('±120')
    // The composed summary leads when criteria were applied.
    expect(text).toContain('meet all of the stated Census criteria')
    // Researched claims render with their sources as quiet links.
    expect(text).toContain('Hilo, HI has two elementary schools within the district.')
    const link = [...container.querySelectorAll('a')].find(
      (a) => a.getAttribute('href') === 'https://example.org/doe',
    )
    expect(link).toBeDefined()
    expect(link?.textContent).toContain('Hawaii DOE')
  })

  it('withheld renders the quiet line and no place claims', () => {
    const withheld: ComposedAnswer = {
      status: 'withheld',
      stage: 'verify',
      criteria: [{ metricKey: 'median_gross_rent', bound: 'atMost', value: 1500, intentOp: 'lt' }],
      droppedCriteria: [],
      unresolvedGeographies: [],
      screenedCount: 3,
      places: [
        {
          zcta: '96720',
          name: 'Hilo, HI',
          figures: [{ key: 'median_gross_rent', value: 9999 }],
          claims: [{ text: 'An unverified claim about Hilo.', sourceUrls: ['https://example.org'] }],
        },
      ],
      generalClaims: [],
      sources: [{ title: 'Example', url: 'https://example.org' }],
      summary: '',
      droppedClaims: [],
      failures: ['figure mismatch for 96720 median_gross_rent'],
      researchCriteria: [],
      criterionEvidence: [],
      candidateCap: 10,
      candidateCapApplied: false,
      unresolvedCandidates: [],
      geographyLevel: 'place',
      unsupportedGeography: null,
    }
    render(<AnswerCard answer={withheld} />)
    const text = container.textContent ?? ''
    expect(text).toContain('was withheld because it did not pass verification')
    expect(text).not.toContain('Hilo, HI')
    expect(text).not.toContain('An unverified claim')
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('dropped-criterion line appears when a bound could not be expressed', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({
        filters: [
          { metricKey: 'median_gross_rent', op: 'gt', value: 500 },
          { metricKey: 'median_gross_rent', op: 'lt', value: 1500 },
        ],
      }),
      rows: ROWS,
      provider: createStubProvider(),
    })
    expect(answer.status).toBe('verified')
    expect(answer.droppedCriteria).toHaveLength(1)
    render(<AnswerCard answer={answer} />)
    expect(container.textContent).toContain(
      "A lower bound on median gross rent can't be applied yet, so it was not used.",
    )
  })

  it('pure-figure lookup renders the plain card: place and figure, no criteria summary', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'lookup',
        geographies: ['96720'],
        metricKeys: ['median_home_value'],
      }),
      rows: ROWS,
      provider: createStubProvider(),
    })
    expect(answer.status).toBe('verified')
    render(<AnswerCard answer={answer} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Hilo, HI')
    expect(text).toContain('96720')
    expect(text).toContain('$440,000')
    expect(text).toContain('±25,000')
    expect(text).not.toContain('meet all of the stated Census criteria')
    expect(text).not.toContain('Keaau, HI')
  })

  it('empty renders the honest line and names no place', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1000 }] }),
      rows: ROWS,
      provider: createStubProvider(),
    })
    expect(answer.status).toBe('empty')
    render(<AnswerCard answer={answer} />)
    const text = container.textContent ?? ''
    expect(text).toContain('No place in the loaded data meets all of the stated Census criteria.')
    expect(text).not.toContain('Hilo, HI')
  })

  it('a research-failure note carries its per-criterion accounting on the note shell (FM-8)', async () => {
    // Finding F3: note terminals rendered the summary alone — the
    // per-criterion block was mounted on the card and flexible
    // branches only, so a note's reader could not see which stated
    // criteria were looked up and which did not return. The data
    // was always on the answer; the mount was the gap.
    const question = 'Where can I find the best schools but also the fewest fast food restaurants?'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: [] }),
      rows: ROWS,
      researchQuery: question,
      researchCriteria: [question],
      queryText: question,
      provider: createStubProvider({
        async research() {
          throw new Error('provider_down')
        },
      }),
    })
    expect(answer.status).toBe('empty')
    expect(answer.criterionEvidence.length).toBeGreaterThan(0)
    render(<AnswerCard answer={answer} />)
    const text = container.textContent ?? ''
    expect(text).toContain('School quality')
    expect(text).toContain('did not return')
  })
})
