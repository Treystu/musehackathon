// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import { ClarificationPanel } from '../../src/ui/ai/ClarificationPanel'
import { IntentEditor } from '../../src/ui/ai/IntentEditor'

/**
 * C2 + C3 pins (item-16 audit, section 3).
 *
 * C2: the clarification panel used to end every flow with a
 * "Use these choices" click that re-confirmed picks already made.
 * The cure: the toggle that makes the merged set runnable runs it
 * (including the F-C default-measure path), and picks already
 * complete at mount run with no click at all when nothing is left
 * on offer — a measure still on offer is a pending pick, and the
 * mount never pre-empts it with the default. The button is gone;
 * the hint line remains as the not-runnable state's carrier, with
 * its copy unchanged.
 *
 * C3: while the panel is mounted there is exactly one editing
 * surface — the IntentEditor's add-forms are suppressed (its
 * removal chips stay), and parse-held places are removable from
 * inside the panel itself.
 *
 * These tests fail if either removed step returns: a confirm
 * button in the panel, a runnable toggle that does not run, an
 * editor add-form beside the panel, or a held place that cannot be
 * removed without leaving the panel.
 */

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

function renderPanel(
  intent: ValidatedIntent,
  onResolve = vi.fn(),
  onRemovePlace?: (p: string) => void,
  candidates = { geographies: ['Hilo, HI', 'Fairbanks, AK'], metricKeys: ['median_gross_rent'] },
) {
  act(() => {
    root.render(
      <ClarificationPanel
        intent={intent}
        candidates={candidates}
        onResolve={onResolve}
        onRemovePlace={onRemovePlace}
      />,
    )
  })
  return onResolve
}

function clickButton(text: string) {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  if (!button) throw new Error(`no button containing "${text}"`)
  act(() => button.click())
}

function confirmButton() {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === 'Use these choices')
}

describe('C2: the final pick runs', () => {
  it('renders no confirm button in any state', () => {
    renderPanel({
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    })
    expect(confirmButton()).toBeUndefined()
  })

  it('the toggle that completes the set fires onResolve exactly once (F-C default-measure path)', () => {
    const onResolve = renderPanel({
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    })
    // One place, no measure anywhere: the F-C default completes it.
    clickButton('Hilo, HI')
    expect(onResolve).toHaveBeenCalledTimes(1)
    const resolved = onResolve.mock.calls[0]![0] as ValidatedIntent
    expect(resolved.geographies).toEqual(['Hilo, HI'])
    expect(resolved.metricKeys).toEqual(['median_gross_rent'])
    expect(resolved.clarificationNeeded).toBe(false)
    // A further toggle cannot fire a second run from this panel.
    clickButton('Median gross rent')
    expect(onResolve).toHaveBeenCalledTimes(1)
  })

  it('picks already complete at mount run with no click at all — when nothing is left on offer', () => {
    // The held place is the only candidate and no measures are on
    // offer, so there is no pending pick a mount-run could pre-empt:
    // the F-C default completes the set by itself.
    const onResolve = renderPanel(
      {
        mode: 'lookup',
        geographies: ['Anchorage, AK'],
        metricKeys: [],
        filters: [],
        clarificationNeeded: true,
      },
      vi.fn(),
      undefined,
      { geographies: ['Anchorage, AK'], metricKeys: [] },
    )
    expect(onResolve).toHaveBeenCalledTimes(1)
    const resolved = onResolve.mock.calls[0]![0] as ValidatedIntent
    expect(resolved.metricKeys).toEqual(['median_gross_rent'])
  })

  it('mount does NOT pre-empt a pending pick: held places with a measure still on offer wait for the toggle', () => {
    const onResolve = renderPanel({
      mode: 'lookup',
      geographies: ['Springfield, IL', 'Springfield, MO'],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    })
    expect(onResolve).not.toHaveBeenCalled()
    clickButton('Median gross rent')
    expect(onResolve).toHaveBeenCalledTimes(1)
    const resolved = onResolve.mock.calls[0]![0] as ValidatedIntent
    expect(resolved.geographies).toEqual(['Springfield, IL', 'Springfield, MO'])
    expect(resolved.metricKeys).toEqual(['median_gross_rent'])
  })

  it('compare mode still waits for the second place', () => {
    const onResolve = renderPanel({
      mode: 'compare',
      geographies: ['Anchorage, AK'],
      metricKeys: ['median_gross_rent'],
      filters: [],
      clarificationNeeded: true,
    })
    expect(onResolve).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Comparing needs two places')
    clickButton('Fairbanks, AK')
    expect(onResolve).toHaveBeenCalledTimes(1)
    const resolved = onResolve.mock.calls[0]![0] as ValidatedIntent
    expect(resolved.geographies).toEqual(['Anchorage, AK', 'Fairbanks, AK'])
  })

  it('the not-runnable hint copy is unchanged', () => {
    renderPanel({
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    })
    expect(container.textContent).toContain(
      'Pick a place and a measure, or a measure on its own to screen the whole country.',
    )
  })
})

describe('C3: one editing surface during clarification', () => {
  it('a parse-held place is removable from inside the panel', () => {
    const onRemovePlace = vi.fn()
    renderPanel(
      {
        mode: 'lookup',
        geographies: ['Hilo, HI'],
        metricKeys: [],
        filters: [],
        clarificationNeeded: true,
      },
      vi.fn(),
      onRemovePlace,
    )
    const remove = container.querySelector('button[aria-label="Remove place Hilo, HI"]')
    expect(remove).not.toBeNull()
    act(() => (remove as HTMLButtonElement).click())
    expect(onRemovePlace).toHaveBeenCalledTimes(1)
    expect(onRemovePlace).toHaveBeenCalledWith('Hilo, HI')
  })

  it('the IntentEditor renders no add-form while suppressed, and keeps its removal chips', () => {
    const intent: ValidatedIntent = {
      mode: 'lookup',
      geographies: ['Hilo'],
      metricKeys: ['median_gross_rent'],
      filters: [],
      clarificationNeeded: true,
    }
    act(() => {
      root.render(<IntentEditor intent={intent} onChange={() => {}} suppressAddForms />)
    })
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('#intent-add-kind')).toBeNull()
    expect(container.querySelector('button[aria-label="Remove place Hilo"]')).not.toBeNull()
  })
})
