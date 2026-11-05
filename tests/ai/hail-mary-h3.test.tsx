// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAnswerPipeline } from '../../src/core/ai/answer'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import { AskPanel } from '../../src/ui/ai/AskPanel'
import { AskSessionStore } from '../../src/ui/ai/session-store'
import {
  isFragmentFollowUp,
  mergeFragmentIntent,
  standingScreenFromSession,
  type StandingScreen,
} from '../../src/ui/ai/fragment-carry'

const COLORADO: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['Colorado'],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
  clarificationNeeded: false,
}

const PLACELESS_WALMART: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

const TEXAS_FRESH: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['Texas'],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1800 }],
  clarificationNeeded: false,
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

async function flush(ms = 20) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

describe('H3 chained refinement', () => {
  it('standing screen persists and fragment gate fires only for criteria-only follow-ups', () => {
    const store = new AskSessionStore()
    expect(standingScreenFromSession(store)).toBeNull()
    store.setAnswerState({
      request: { id: 1, intent: COLORADO, queryText: 'Cheapest rent in Colorado' },
    })
    const standing = standingScreenFromSession(store)
    expect(standing?.geographies).toEqual(['Colorado'])
    expect(isFragmentFollowUp('also needs to be near a Walmart (within 10 miles)', standing)).toBe(true)
    expect(isFragmentFollowUp('What is the cheapest rent in Texas?', standing)).toBe(false)
    expect(isFragmentFollowUp('Cheapest rent in Colorado under $1200', standing)).toBe(false)
    // Regression: a fresh criteria-only question with no fragment signal
    // starts fresh even when short (measured 2026-11-05: the length
    // fallback merged a schools/fast-food question into a Hilo screen).
    expect(
      isFragmentFollowUp(
        'Which area has the best schools and the fewest fast food restaurants?',
        standing,
      ),
    ).toBe(false)
    // A follow-up naming a new place of its own is not a fragment.
    expect(isFragmentFollowUp('near Denver within 10 miles', standing, true)).toBe(false)
  })

  it('fragment merge carries geography, measure, and filters; fresh starts fresh', () => {
    const standing: StandingScreen = {
      geographies: ['Colorado'],
      metricKeys: ['median_gross_rent'],
      filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
      mode: 'sweep_filter',
    }
    const merged = mergeFragmentIntent(PLACELESS_WALMART, standing, 'also near Walmart within 10 miles')
    expect(merged.geographies).toEqual(['Colorado'])
    expect(merged.metricKeys).toContain('median_gross_rent')
    expect(merged.filters).toEqual(standing.filters)
    // Fresh full question with its own geography is untouched by merge (gate false).
    expect(isFragmentFollowUp('What is rent in Texas?', standing)).toBe(false)
    expect(TEXAS_FRESH.geographies).toEqual(['Texas'])
  })

  it('Colorado → Walmart chain refines hermetically with superseded count', async () => {
    const store = new AskSessionStore()
    const seen: ValidatedIntent[] = []
    const slotCalls: { geo: string[]; metric: string[] }[] = []
    const provider = createStubProvider({
      intent: async (req) => {
        slotCalls.push({ geo: [...req.slots.geographyHints], metric: [...req.slots.metricHints] })
        const q = req.queryText.toLowerCase()
        if (q.includes('walmart')) return { intent: { ...PLACELESS_WALMART } }
        return { intent: { ...COLORADO } }
      },
    })
    let answerReq: { intent: ValidatedIntent; queryText: string } | null = null
    render(
      <AskPanel
        session={store}
        provider={provider}
        parseRetryDelaysMs={[]}
        onAnswerRequest={(intent, queryText) => {
          seen.push(intent)
          answerReq = { intent, queryText }
          // Mint the standing screen like App does.
          store.setAnswerState({
            request: { id: seen.length, intent, queryText, epoch: store.getSnapshot().answer.askEpoch },
          })
        }}
        onAskStart={(queryText) => {
          const epoch = store.getSnapshot().answer.askEpoch + 1
          store.setAnswerState({ askEpoch: epoch })
          void queryText
        }}
      />,
    )
    const input = container.querySelector('#ask-input') as HTMLInputElement
    const form = container.querySelector('form') as HTMLFormElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set!
    async function ask(text: string) {
      await act(async () => {
        setter.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      await flush(50)
    }
    await ask('Cheapest rent in Colorado')
    expect(seen.length).toBe(1)
    expect(seen[0]!.geographies).toEqual(['Colorado'])
    // Second run carries slots from the standing screen (no silent drop).
    await ask('also needs to be near a Walmart (within 10 miles)')
    await flush(50)
    expect(seen.length).toBe(2)
    const refined = seen[1]!
    expect(refined.geographies).toEqual(['Colorado'])
    expect(refined.metricKeys).toContain('median_gross_rent')
    // Slots on the follow-up carried the standing context.
    expect(slotCalls[1]!.geo).toContain('Colorado')
    // Fresh full question starts fresh (gate false, no carry).
    const freshGate = isFragmentFollowUp(
      'What is the cheapest rent in Texas?',
      standingScreenFromSession(store),
    )
    expect(freshGate).toBe(false)
    expect(
      isFragmentFollowUp(
        'Which area has the best schools and the fewest fast food restaurants?',
        standingScreenFromSession(store),
      ),
    ).toBe(false)
    expect(answerReq).not.toBeNull()
  })

  it('refinement chips show carried criteria and remove', async () => {
    const provider = createStubProvider({ async research() { return { prose: '', sources: [] } } })
    const rows: AreaRow[] = [0, 1, 2].map((i) => ({
      zcta: `8000${i}`,
      name: `Town ${i}, CO`,
      metrics: { median_gross_rent: 1300 + i * 50, households: 5000 },
      moes: { median_gross_rent: 40, households: 100 },
    }))
    const answer = await runAnswerPipeline({
      intent: COLORADO,
      rows,
      researchQuery: 'Cheapest rent in Colorado near Walmart',
      provider,
    })
    expect(answer.status).toBe('verified')
    render(<AnswerCard answer={answer} />)
    const chips = container.querySelector('[aria-label="Refined criteria"]')
    expect(chips).not.toBeNull()
    expect(chips?.textContent).toContain('Median gross rent')
    const removeBtn = [...container.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label')?.startsWith('Remove '),
    )
    expect(removeBtn).not.toBeUndefined()
    await act(async () => {
      ;(removeBtn as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Removal hides the chip (display-level, no silent re-screen).
    expect(container.querySelector('[aria-label="Refined criteria"]')?.textContent ?? '').not.toContain(
      'Median gross rent',
    )
  })
})
