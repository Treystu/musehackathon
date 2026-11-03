// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { canRun, withRunnability } from '../../src/core/ai/intent-schema'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import { createGoldenProvider, runGolden } from '../../src/core/ai/harness'
import {
  addFilter,
  canResolveClarification,
  removeFilter,
  removeGeography,
  resolveClarification,
} from '../../src/core/ai/intent-edit'
import { ClarificationPanel } from '../../src/ui/ai/ClarificationPanel'

const compareTwo: ValidatedIntent = {
  mode: 'compare',
  geographies: ['Hilo', 'Honolulu'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

const sweepOne: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['HI'],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'gt', value: 1000 }],
  clarificationNeeded: false,
}

describe('canRun mode minimums (single owner)', () => {
  it('compare: 2 places runnable, 1 place not, 0 places not', () => {
    expect(canRun(compareTwo)).toBe(true)
    expect(canRun({ ...compareTwo, geographies: ['Hilo'] })).toBe(false)
    expect(canRun({ ...compareTwo, geographies: [] })).toBe(false)
  })

  it('compare: withRunnability stamps clarification below minimum', () => {
    expect(withRunnability({ ...compareTwo, geographies: ['Hilo'] }).clarificationNeeded).toBe(true)
    expect(withRunnability(compareTwo).clarificationNeeded).toBe(false)
  })

  it('sweep_filter: 1 filter runnable; 0 filters runs as the geography-bounded screen', () => {
    expect(canRun(sweepOne)).toBe(true)
    // Bounded-screen exception (2026-11-02): a placed sweep with no
    // bound is scoped to its named geography and sorted by its
    // measure — the shape a bounded superlative ("cheapest place to
    // live in Texas") runs as.
    expect(canRun({ ...sweepOne, filters: [] })).toBe(true)
    expect(
      withRunnability({ ...sweepOne, filters: [] }).clarificationNeeded,
    ).toBe(false)
  })

  it('other modes: lookup needs 1 place + 1 measure; similarity needs the seed place, measure optional', () => {
    expect(
      canRun({
        mode: 'lookup',
        geographies: ['Hilo'],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(true)
    expect(
      canRun({
        mode: 'lookup',
        geographies: ['Hilo'],
        metricKeys: [],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(false)
    expect(
      canRun({
        mode: 'similarity',
        geographies: ['Hilo'],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(true)
    // Similarity runs on the seed alone (2026-11-01): its execution
    // consumes no measure. A named measure must still be filter-legal.
    expect(
      canRun({
        mode: 'similarity',
        geographies: ['96778'],
        metricKeys: [],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(true)
    expect(
      canRun({
        mode: 'similarity',
        geographies: ['96778'],
        metricKeys: ['median_age'],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(false)
    // Sweep with 2 filters stays runnable; lookup ignores filters.
    expect(canRun({ ...sweepOne, filters: [...sweepOne.filters, ...sweepOne.filters] })).toBe(true)
  })

  it('removal flows land in clarification via the single owner', () => {
    const pared = removeGeography(compareTwo, 'Hilo')
    expect(pared.ok).toBe(true)
    if (pared.ok) {
      expect(pared.intent.geographies).toEqual(['Honolulu'])
      expect(pared.intent.clarificationNeeded).toBe(true)
    }
    const unfiltered = removeFilter(sweepOne, sweepOne.filters[0]!)
    expect(unfiltered.ok).toBe(true)
    if (unfiltered.ok) {
      expect(unfiltered.intent.filters).toHaveLength(0)
      // Dropping the last filter leaves the bounded screen over the
      // named geography, sorted by its measure (2026-11-02) — the
      // intent stays runnable rather than returning to clarification.
      expect(canRun(unfiltered.intent)).toBe(true)
      expect(unfiltered.intent.clarificationNeeded).toBe(false)
    }
  })

  it('sweep clarification resolves with a real filter, and without one as the bounded screen', () => {
    const sweepFilter = { metricKey: 'median_gross_rent', op: 'gt', value: 1000 } as const
    expect(
      canResolveClarification({
        mode: 'sweep_filter',
        geographies: ['HI'],
        metricKeys: ['median_gross_rent'],
        filters: [{ ...sweepFilter }],
      }),
    ).toBe(true)
    // No filter + a named geography + a measure completes as the
    // geography-bounded screen (2026-11-02), not a clarification.
    expect(
      canResolveClarification({
        mode: 'sweep_filter',
        geographies: ['HI'],
        metricKeys: ['median_gross_rent'],
        filters: [],
      }),
    ).toBe(true)
    // resolveClarification threads the intent's own filters: a clarifying
    // sweep that already carries a filter resolves once place+measure land.
    const unclearSweep: ValidatedIntent = {
      mode: 'sweep_filter',
      geographies: [],
      metricKeys: ['median_gross_rent'],
      filters: [{ ...sweepFilter }],
      clarificationNeeded: true,
    }
    const resolved = resolveClarification(unclearSweep, {
      geographies: ['HI'],
      metricKeys: [],
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.intent.clarificationNeeded).toBe(false)
      expect(resolved.intent.filters).toHaveLength(1)
    }
    const unclearNoFilter: ValidatedIntent = { ...unclearSweep, filters: [] }
    // The same picks complete the no-filter sweep too: place +
    // measure land it on the bounded screen over HI.
    const resolvedNoFilter = resolveClarification(unclearNoFilter, {
      geographies: ['HI'],
      metricKeys: [],
    })
    expect(resolvedNoFilter.ok).toBe(true)
    if (resolvedNoFilter.ok) {
      expect(resolvedNoFilter.intent.clarificationNeeded).toBe(false)
      expect(resolvedNoFilter.intent.geographies).toEqual(['HI'])
    }
  })

  it('filter add/remove round-trips through clarification', () => {
    const resolving = { metricKey: 'median_gross_rent', op: 'gt', value: 1000 } as const
    const unclearNoFilter: ValidatedIntent = {
      mode: 'sweep_filter',
      geographies: ['HI'],
      metricKeys: ['median_gross_rent'],
      filters: [],
      clarificationNeeded: true,
    }
    const added = addFilter(unclearNoFilter, { ...resolving })
    expect(added.ok).toBe(true)
    if (added.ok) {
      expect(added.intent.filters).toHaveLength(1)
      expect(canRun(added.intent)).toBe(true)
      expect(added.intent.clarificationNeeded).toBe(false)
      const removed = removeFilter(added.intent, { ...resolving })
      expect(removed.ok).toBe(true)
      if (removed.ok) {
        expect(removed.intent.filters).toHaveLength(0)
        // Removal lands on the bounded screen (2026-11-02), which is
        // runnable on place + measure alone.
        expect(removed.intent.clarificationNeeded).toBe(false)
      }
    }
  })

  it('panel carries no confirm button; the hint alone marks the states that cannot run', () => {
    // REVISED PIN (item-16 cure C2, 2026-11-02): this test used to
    // assert the "Use these choices" button's enabled/disabled state
    // as the runnability signal. C2 removed that button — the toggle
    // that completes the set IS the run — so runnability now shows
    // only in the hint line: the runnable-with-default state carries
    // the F-C disclosure, the blocked state carries what is missing,
    // and no state renders a confirm control. The F-C history below
    // stands: a geography with no measure completes on the domain
    // default measure (median gross rent); a request with neither
    // place nor measure is the blocked case no default can complete.
    const runnableSweep: ValidatedIntent = {
      ...sweepOne,
      geographies: ['HI'],
      clarificationNeeded: true,
    }
    const enabled = renderToStaticMarkup(
      <ClarificationPanel
        intent={runnableSweep}
        candidates={{ geographies: [], metricKeys: [] }}
        onResolve={() => {}}
      />,
    )
    expect(enabled).not.toContain('Use these choices')
    const withDefault = renderToStaticMarkup(
      <ClarificationPanel
        intent={{ ...runnableSweep, metricKeys: [] }}
        candidates={{ geographies: [], metricKeys: [] }}
        onResolve={() => {}}
      />,
    )
    expect(withDefault).not.toContain('Use these choices')
    expect(withDefault).toContain('median gross rent')
    const blocked = renderToStaticMarkup(
      <ClarificationPanel
        intent={{ ...runnableSweep, geographies: [], metricKeys: [], filters: [] }}
        candidates={{ geographies: [], metricKeys: [] }}
        onResolve={() => {}}
      />,
    )
    expect(blocked).not.toContain('Use these choices')
    expect(blocked).toContain('Pick a place and a measure')
  })

  it('panel toggle: the place toggle that completes the set resolves with the filter intact', () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      const unclear: ValidatedIntent = {
        mode: 'sweep_filter',
        geographies: [],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'gt', value: 1000 }],
        clarificationNeeded: true,
      }
      let resolved: ValidatedIntent | null = null
      const render = (node: ReactNode) => {
        act(() => root.render(node))
      }
      render(
        <ClarificationPanel
          intent={unclear}
          candidates={{ geographies: ['HI'], metricKeys: [] }}
          onResolve={(next) => {
            resolved = next
          }}
        />,
      )
      // REVISED PIN (item-16 cure C2, 2026-11-02): the old flow was
      // toggle -> button enables -> click resolve. The confirm click
      // is removed: the place toggle itself resolves, once, with the
      // intent's filter intact. (At mount nothing fires: a candidate
      // place is still on offer, so the reader's pick is pending —
      // the placeless bounded sweep's national-screen run waits for
      // the toggle that chooses its bound.)
      expect(resolved).toBeNull()
      const placeChip = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'HI',
      ) as HTMLButtonElement
      act(() => {
        placeChip.click()
      })
      expect(resolved).not.toBeNull()
      expect(resolved!.geographies).toEqual(['HI'])
      expect(resolved!.filters).toHaveLength(1)
      expect(resolved!.clarificationNeeded).toBe(false)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('golden corpus still exact after minimums', async () => {
    const golden = await runGolden(createGoldenProvider())
    for (const r of golden) expect(r.exact, r.id).toBe(true)
  })
})
