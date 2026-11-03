// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { ExplainOnAsk } from '../../src/ui/ai/ExplainOnAsk'
import type { FigureInput } from '../../src/ui/ai/FigureCard'

/**
 * C7 pin (item-16 audit, section 11): the Ask surface's explain act
 * had two contracts — automatic when no onExplain was wired, a
 * manual "Explain these figures" button when one was. The cure is
 * one contract: always automatic. The data-view ExplainAction
 * button is a different surface and is untouched by this pin.
 *
 * These tests fail if the removed step returns: a manual button on
 * the Ask surface, or an explanation that waits for a click.
 */

const intent: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo, HI'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

const figure: FigureInput = {
  key: 'median_gross_rent',
  value: 1450,
  marginOfError: 85,
  source: 'ACS 5-year estimates',
  publisher: 'U.S. Census Bureau',
  dataset: 'ACS',
  table: 'B25064',
  vintage: '2023',
  geographies: ['Hilo, HI'],
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
  act(() => root?.unmount())
  container?.remove()
})

describe('C7: ExplainOnAsk is always automatic', () => {
  it('fires the explanation with zero clicks and renders no manual button', async () => {
    const explain = vi.fn(async () => ({ prose: 'The median gross rent is 1,450 ± 85.' }))
    const provider = createStubProvider({ explain })
    act(() => {
      root.render(<ExplainOnAsk intent={intent} figures={[figure]} provider={provider} />)
    })
    // No click of any kind: flush the async explain path only.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(explain).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('The median gross rent is 1,450')
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(buttons).not.toContain('Explain these figures')
  })

  it('renders nothing when there is no provider and no supplied explanation', () => {
    act(() => {
      root.render(<ExplainOnAsk intent={intent} figures={[figure]} />)
    })
    expect(container.textContent).toBe('')
    expect(container.querySelector('button')).toBeNull()
  })
})
