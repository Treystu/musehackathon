// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createStubProvider,
  type ResearchRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { AskPanel, needsResearch } from '../../src/ui/ai/AskPanel'

/**
 * Research in the Ask flow (2026-11-01, owner directive): a question
 * carrying criteria the Census data cannot serve fires the grounded
 * web path in parallel with the parse and renders a labeled,
 * sourced "From the web" section. A pure Census question never
 * fires it. When research cannot be reached on a politics question,
 * the coverage note is the fallback.
 */
const runnable: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [],
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

describe('needsResearch', () => {
  it('matches outside-data criteria and not pure Census questions', () => {
    expect(needsResearch('which neighborhood has the best schools and a Starbucks nearby')).toBe(true)
    expect(needsResearch('I want somewhere that is not Republican')).toBe(true)
    expect(needsResearch('compare rent in Honolulu and Hilo')).toBe(false)
    expect(needsResearch('median home value in Austin')).toBe(false)
    expect(needsResearch(undefined)).toBe(false)
  })
})

describe('research section', () => {
  it('renders sourced web findings beside the executed request', async () => {
    const researchCalls: ResearchRequest[] = []
    const provider = createStubProvider({
      async intent() {
        return { intent: runnable }
      },
      async research(req) {
        researchCalls.push(req)
        return {
          prose: 'Hilo schools include well-rated elementary options.',
          sources: [{ title: 'Hawaii DOE', url: 'https://example.org/doe' }],
        }
      },
    })
    render(<AskPanel provider={provider} onExecute={() => ''} />)
    await ask('best schools near Hilo with affordable rent')
    expect(researchCalls).toHaveLength(1)
    const section = container.querySelector('section[aria-label="From the web"]')
    expect(section).not.toBeNull()
    expect(section?.textContent).toContain('Hilo schools include')
    expect(section?.textContent).toContain('not Census figures')
    const link = section?.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.org/doe')
  })

  it('a pure Census question never fires research', async () => {
    const researchCalls: ResearchRequest[] = []
    const provider = createStubProvider({
      async intent() {
        return { intent: runnable }
      },
      async research(req) {
        researchCalls.push(req)
        return { prose: 'x', sources: [{ title: 't', url: 'https://example.org' }] }
      },
    })
    render(<AskPanel provider={provider} onExecute={() => ''} />)
    await ask('rent in Hilo')
    expect(researchCalls).toHaveLength(0)
    expect(container.querySelector('section[aria-label="From the web"]')).toBeNull()
  })

  it('research failure on a politics question falls back to the coverage note', async () => {
    const provider = createStubProvider({
      async intent() {
        return {
          intent: { ...runnable, geographies: ['NV'], clarificationNeeded: true, metricKeys: [] },
        }
      },
      async research() {
        throw Object.assign(new Error('down'), { code: 'provider_down' })
      },
    })
    render(<AskPanel provider={provider} onExecute={() => ''} />)
    await ask('I live in El Paso and want to move somewhere in Nevada that is not Republican')
    expect(container.textContent).toContain('no voter registration, party affiliation, or election results')
    expect(container.textContent).toContain('Web findings are unavailable right now')
  })
})
