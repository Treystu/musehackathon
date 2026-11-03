// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSaved } from '../../src/core/saved-searches'
import { defaultSavedName, SavedSearches } from '../../src/ui/SavedSearches'

/**
 * C8 pin (item-16 audit, section 9): saving a comparison used to
 * require typing a name — a blank name was refused — although the
 * system holds the exact ZIP list being saved. The cure pre-fills
 * the name from that list (first ZIP + count); Save works with the
 * field untouched and the field stays editable.
 *
 * These tests fail if the removed step returns: an untouched field
 * that is blank, or a save that refuses without typed input.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  localStorage.clear()
})

function render(zips: readonly string[]) {
  act(() => {
    root.render(<SavedSearches selectedZctas={zips} onRestore={() => {}} />)
  })
}

describe('C8: saved views get a default name from the ZIP list', () => {
  it('defaultSavedName names the first ZIP plus the count of the rest', () => {
    expect(defaultSavedName(['96778'])).toBe('96778')
    expect(defaultSavedName(['96778', '96720', '96749', '96761'])).toBe('96778 + 3 more')
  })

  it('the name field is pre-filled, and Save with the field untouched succeeds under the default name', () => {
    render(['96778', '96720', '96749', '96761'])
    const input = container.querySelector('#saved-name') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.value).toBe('96778 + 3 more')

    const form = container.querySelector('form')!
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    const saved = readSaved()
    expect(saved).toHaveLength(1)
    expect(saved[0]!.name).toBe('96778 + 3 more')
    // The store validates ZIPs through the url-state codec, which
    // keeps them sorted — the saved set is the same four codes.
    expect([...saved[0]!.zips].sort()).toEqual(['96720', '96749', '96761', '96778'])
    expect(container.textContent).toContain('96778 + 3 more')
  })

  it('a typed name still wins over the default', () => {
    render(['96778', '96720'])
    const input = container.querySelector('#saved-name') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('input value setter unavailable')
    act(() => {
      setter.call(input, 'Hilo side')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const form = container.querySelector('form')!
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(readSaved()[0]!.name).toBe('Hilo side')
  })
})
