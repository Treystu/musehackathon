// @vitest-environment jsdom
/**
 * C9 pin (item-16 audit, cure C9): the IntentEditor used to re-present
 * the already-run intent as THREE separate add-forms (place / measure /
 * filter), each with its own submit button — type+submit per field,
 * for one intent object. The cure collapses them into ONE add row: a
 * field-type selector plus that type's input plus a single Add, and —
 * because a measure value is enumerable — choosing a measure adds it
 * on selection, with no Add click at all.
 *
 * These tests fail if the removed step returns: three forms coming
 * back, or measure addition again requiring a submit after the choice.
 */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import { IntentEditor } from '../../src/ui/ai/IntentEditor'

const base: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

function StatefulEditor() {
  const [intent, setIntent] = useState<ValidatedIntent>(base)
  return <IntentEditor intent={intent} onChange={setIntent} />
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<StatefulEditor />)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** One user act on a select: choose a value. */
function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** One user act on a text/number input: type a value. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submitTheForm() {
  const form = container.querySelector('form')
  expect(form).not.toBeNull()
  return act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('C9: one add row in the IntentEditor', () => {
  it('renders exactly one form, with one field-type selector for place / measure / filter', () => {
    expect(container.querySelectorAll('form')).toHaveLength(1)
    const kind = container.querySelector('#intent-add-kind') as HTMLSelectElement
    expect(kind).not.toBeNull()
    expect([...kind.options].map((o) => o.value)).toEqual(['place', 'measure', 'filter'])
    // One Add button total in the row (the old per-form Add place /
    // Add measure / Add filter buttons are gone).
    const buttons = [...container.querySelectorAll('form button[type="submit"]')]
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Add'])
  })

  it('adding a measure takes at most two acts: pick the type, pick the measure — no submit', () => {
    let acts = 0
    const kind = container.querySelector('#intent-add-kind') as HTMLSelectElement
    acts += 1
    choose(kind, 'measure')

    const metric = container.querySelector('#intent-metric') as HTMLSelectElement
    expect(metric).not.toBeNull()
    acts += 1
    choose(metric, 'median_age')

    expect(acts).toBeLessThanOrEqual(2)
    // The choice alone added it: the removal chip for the new measure
    // is present without any form submit or Add click.
    expect(container.querySelector('button[aria-label="Remove measure Median age"]')).not.toBeNull()
  })

  it('adding a place takes two acts in the same row: type, then Add', async () => {
    const place = container.querySelector('#intent-place') as HTMLInputElement
    expect(place).not.toBeNull()
    typeInto(place, 'Honolulu')
    await submitTheForm()
    expect(container.querySelector('button[aria-label="Remove place Honolulu"]')).not.toBeNull()
  })

  it('adding a filter still works from the same row: pick the type, set the value, Add', async () => {
    const kind = container.querySelector('#intent-add-kind') as HTMLSelectElement
    choose(kind, 'filter')
    const value = container.querySelector('#filter-value') as HTMLInputElement
    expect(value).not.toBeNull()
    typeInto(value, '1500')
    await submitTheForm()
    expect(container.querySelector('button[aria-label^="Remove filter"]')).not.toBeNull()
  })
})
