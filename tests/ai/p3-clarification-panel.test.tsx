// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ClarificationPanel } from '../../src/ui/ai/ClarificationPanel'
import { clarificationCandidatesFor } from '../../src/ui/ai/AskPanel'
import type { ValidatedIntent } from '../../src/core/ai/provider'

/**
 * E6 pin (P3 step 8): the clarification panel reads its own parse —
 * a parse carrying geographies never renders under a "No candidate
 * places" line; the held places show as choices already made.
 */

let container: HTMLDivElement
let root: Root

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

function render(intent: ValidatedIntent) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <ClarificationPanel
        intent={intent}
        candidates={clarificationCandidatesFor(intent, ['median_gross_rent'])}
        onResolve={() => {}}
      />,
    )
  })
  return container.textContent ?? ''
}

describe('ClarificationPanel reads its parse (E6)', () => {
  it('shows the parse-held place as a choice already made, never as no candidates', () => {
    const text = render({
      mode: 'lookup',
      geographies: ['Hilo, HI'],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    })
    expect(text).toContain('Choices already made')
    expect(text).toContain('Hilo, HI')
    expect(text).not.toContain('No candidate places')
  })

  it('keeps the honest no-candidates line only for a placeless parse', () => {
    const text = render({
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    })
    expect(text).toContain('No candidate places for this request')
  })
})
