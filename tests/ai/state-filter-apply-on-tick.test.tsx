// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toggleStateOption, type StateOption } from '../../src/core/sweep/states'
import { StateFilter } from '../../src/ui/StateFilter'

/**
 * C5 pin (item-16 audit, section 10): the state filter used to split
 * one decision into two acts — tick states, then click Apply ("Load
 * selected states") — while the figure bounds beside it applied
 * live. The cure applies on tick, coalesced: applyScope restarts
 * the country sweep load, so a burst of ticks must land as ONE
 * applyScope call carrying the change-set's final selection.
 *
 * These tests fail if the removed step returns: an Apply/Load
 * button in the panel, a tick that fires applyScope per tick, or a
 * tick that fires nothing at all.
 */

const OPTIONS: StateOption[] = [
  { code: 'HI', label: 'Hawaii', count: 98, prefixes: ['96'] },
  { code: 'CA', label: 'California', count: 2600, prefixes: ['90', '91'] },
  { code: 'WA', label: 'Washington', count: 750, prefixes: ['98', '99'] },
]

const onApplyScope = vi.fn()

function Harness() {
  const [selected, setSelected] = useState<string[]>([])
  return (
    <StateFilter
      options={OPTIONS}
      selected={selected}
      onToggle={(option) => setSelected((cur) => toggleStateOption(cur, option))}
      onClear={() => setSelected([])}
      onApplyScope={onApplyScope}
      totalChunks={34}
      scopeChunks={3}
      busy={false}
    />
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  onApplyScope.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<Harness />))
  const open = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Choose states',
  )!
  act(() => open.click())
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

function tick(label: string) {
  const input = [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.includes(label))
    ?.querySelector('input[type="checkbox"]') as HTMLInputElement
  if (!input) throw new Error(`no checkbox for ${label}`)
  act(() => input.click())
}

async function waitForApply(ms = 600) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

describe('C5: the state filter applies on tick', () => {
  it('renders no Apply or Load button — Clear is the only action left', () => {
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(buttons).not.toContain('Load selected states')
    expect(buttons).not.toContain('Load all 50 states + DC')
    expect(buttons).not.toContain('Apply')
    expect(buttons).toContain('Clear')
  })

  it('one tick fires applyScope once, with that state in scope', async () => {
    tick('Hawaii')
    await waitForApply()
    expect(onApplyScope).toHaveBeenCalledTimes(1)
    expect(onApplyScope).toHaveBeenCalledWith(['96'])
  })

  it('a rapid burst of ticks coalesces into one applyScope call with the final selection', async () => {
    tick('California')
    tick('Washington')
    await waitForApply()
    expect(onApplyScope).toHaveBeenCalledTimes(1)
    expect(onApplyScope).toHaveBeenCalledWith(['90', '91', '98', '99'])
  })

  it('Clear applies the empty scope at once, without waiting out a tick window', async () => {
    tick('Hawaii')
    await waitForApply()
    expect(onApplyScope).toHaveBeenCalledTimes(1)
    const clear = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Clear',
    )!
    act(() => clear.click())
    expect(onApplyScope).toHaveBeenCalledTimes(2)
    expect(onApplyScope).toHaveBeenLastCalledWith([])
  })
})
