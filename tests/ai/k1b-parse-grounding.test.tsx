// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { grantMicConsent, type MicStorage } from '../../src/core/ai/mic'
import {
  createStubProvider,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import {
  AskPanel,
  dropUngroundedGeographies,
  geographyGroundedInQuestion,
} from '../../src/ui/ai/AskPanel'
import { AskSessionStore } from '../../src/ui/ai/session-store'

/**
 * K1b pins (Lane completion program, 2026-11-03): the in-session
 * Texas specimen. On production 6027031, "What is the most liberal
 * city in Texas?" asked SECOND in a session, right after a Hilo
 * comparison, clarified as a comparison holding the prior run's
 * "Hilo, HI" — a place the question never names — presented as the
 * reader's own choice already made, with standalone research
 * running beside the panel.
 *
 * Diagnosis (from source, recorded in RESULTS.md): the parse chain
 * is stateless — empty geography hints, queryText-only route and
 * provider, runQuery clears the panel intent at ask time,
 * candidates derive from the current parse alone. No client state
 * can carry a prior place into a new parse; the foreign geography
 * can only arrive inside the model reply itself (the specimen ran
 * under recorded contention, breaker tripping). The routing half
 * is deterministic: the politics fence keeps this question off the
 * research-first handoff, so a clarifying parse lands on the panel
 * by design — the defect is the FOREIGN PLACE on it. The cure is
 * the parse-grounding guard in accept(): a clarifying intent keeps
 * only geographies the reader's own words ground, the intent
 * prompt's own contract ("keep every place or state the question
 * names in geographies").
 *
 * Gate: Jev proceed / destructive 0.09 / advances 0.88, read under
 * policy v1 as investigate-then-proceed-with-note: the prompt
 * contract bounds replies to question-named places, so the drop
 * zone is non-compliant content; the residual cost of a drop in a
 * clarifying parse is a re-pick, never a wrong run.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function waitFor(predicate: () => boolean, budgetMs = 20000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    let ok = false
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      ok = predicate()
    })
    if (ok) return true
    if (Date.now() - start > budgetMs) return false
  }
}

function pageText(): string {
  return container.textContent ?? ''
}

async function typeAndSubmit(text: string) {
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
}

function fakeStorage(): MicStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

const COMPARISON_QUESTION = 'Which is cheaper, Hilo or East Honolulu?'
const TEXAS_QUESTION = 'What is the most liberal city in Texas?'

describe('K1b parse grounding (unit)', () => {
  it('places the question names are grounded, in the forms the prompt contract returns', () => {
    expect(geographyGroundedInQuestion('Hilo, HI', COMPARISON_QUESTION)).toBe(true)
    expect(geographyGroundedInQuestion('East Honolulu, HI', COMPARISON_QUESTION)).toBe(true)
    expect(geographyGroundedInQuestion('Texas', TEXAS_QUESTION)).toBe(true)
    expect(geographyGroundedInQuestion('TX', 'best schools in TX')).toBe(true)
    expect(geographyGroundedInQuestion('Texas', 'best schools in TX')).toBe(true)
    expect(geographyGroundedInQuestion('TX', 'best schools in Texas')).toBe(true)
    expect(geographyGroundedInQuestion('96720', 'what is the rent in 96720?')).toBe(true)
  })

  it('a place the question never names is not grounded', () => {
    expect(geographyGroundedInQuestion('Hilo, HI', TEXAS_QUESTION)).toBe(false)
    expect(geographyGroundedInQuestion('Austin, TX', TEXAS_QUESTION)).toBe(false)
    expect(geographyGroundedInQuestion('HI', TEXAS_QUESTION)).toBe(false)
  })

  it('the guard drops only ungrounded geographies, and only from clarifying intents', () => {
    const clarifying: ValidatedIntent = {
      mode: 'compare',
      geographies: ['Hilo, HI'],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    }
    const dropped = dropUngroundedGeographies(clarifying, TEXAS_QUESTION)
    expect(dropped.geographies).toEqual([])
    expect(dropped.mode).toBe('compare')

    const named: ValidatedIntent = {
      mode: 'compare',
      geographies: ['Hilo, HI', 'East Honolulu, HI'],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    }
    expect(dropUngroundedGeographies(named, COMPARISON_QUESTION)).toBe(named)

    const runnable: ValidatedIntent = {
      mode: 'lookup',
      geographies: ['Hilo, HI'],
      metricKeys: ['median_gross_rent'],
      filters: [],
      clarificationNeeded: false,
    }
    expect(dropUngroundedGeographies(runnable, TEXAS_QUESTION)).toBe(runnable)
  })
})

describe('K1b the session specimen', () => {
  it('a comparison, then the Texas superlative carrying a foreign place: the place never settles, research still runs', async () => {
    const store = new AskSessionStore()
    const researchQueries: string[] = []
    const provider = createStubProvider({
      intent: (req) => {
        if (req.queryText === COMPARISON_QUESTION) {
          return {
            intent: {
              mode: 'compare',
              geographies: ['Hilo, HI', 'East Honolulu, HI'],
              metricKeys: ['median_gross_rent'],
              filters: [],
              clarificationNeeded: false,
            },
          }
        }
        // The specimen's reply shape: a comparison holding the
        // prior run's place, which the Texas question never names.
        return {
          intent: {
            mode: 'compare',
            geographies: ['Hilo, HI'],
            metricKeys: [],
            filters: [],
            clarificationNeeded: true,
          },
        }
      },
      research: (req) => {
        researchQueries.push(req.queryText)
        return {
          prose: 'Austin, TX is described by the cited guide as strongly liberal.',
          sources: [{ title: 'Guide', url: 'https://example.org/guide' }],
        }
      },
    })
    const storage = fakeStorage()
    grantMicConsent(storage)
    render(
      <AskPanel session={store} provider={provider} micStorage={storage} parseRetryDelaysMs={[]} />,
    )
    await flush()

    // Question 1: the comparison runs with both of its own places.
    await typeAndSubmit(COMPARISON_QUESTION)
    expect(await waitFor(() => store.getSnapshot().panel.busy === false)).toBe(true)
    expect(store.getSnapshot().panel.intent?.geographies).toEqual([
      'Hilo, HI',
      'East Honolulu, HI',
    ])

    // Question 2: the superlative. Its parse carries the foreign
    // place; the settled intent must not, the panel must not frame
    // a comparison continuation, and the question's standalone
    // research (the designed politics posture) still fires.
    await typeAndSubmit(TEXAS_QUESTION)
    expect(await waitFor(() => store.getSnapshot().panel.busy === false)).toBe(true)
    await flush()
    expect(store.getSnapshot().panel.intent?.geographies).toEqual([])
    // The prior run's place as a settled choice is what must be
    // absent ("Hilo, HI" the chip form; the standing example chip
    // "Compare rent in Honolulu and Hilo" is welcome content, not
    // session state, and is not the specimen).
    expect(pageText()).not.toContain('Hilo, HI')
    expect(pageText()).not.toContain('Choices already made')
    expect(pageText()).not.toContain('Comparing needs two places')
    expect(researchQueries).toContain(TEXAS_QUESTION)
  })
})
