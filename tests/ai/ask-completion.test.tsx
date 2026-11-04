import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  addFilter,
  addGeography,
  addMetricKey,
  canResolveClarification,
  removeFilter,
  removeGeography,
  removeMetricKey,
  resolveClarification,
} from '../../src/core/ai/intent-edit'
import { canRun, validateIntent } from '../../src/core/ai/intent-schema'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { AskPanel } from '../../src/ui/ai/AskPanel'
import { ByoOffer } from '../../src/ui/ai/ByoOffer'
import { ByoSettings } from '../../src/ui/ai/ByoSettings'
import { ClarificationPanel } from '../../src/ui/ai/ClarificationPanel'
import { IntentEditor } from '../../src/ui/ai/IntentEditor'

const base: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

describe('intent editing', () => {
  it('adds a place without mutating the input intent', () => {
    const result = addGeography(base, '  Honolulu  ')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.intent.geographies).toEqual(['Hilo', 'Honolulu'])
      expect(base.geographies).toEqual(['Hilo'])
    }
  })

  it('rejects blank places, unknown measures, and proxy filters', () => {
    expect(addGeography(base, '   ').ok).toBe(false)
    expect(addMetricKey(base, 'not_a_real_metric').ok).toBe(false)
    const proxy = addFilter(base, { metricKey: 'median_age', op: 'gt', value: 40 })
    expect(proxy.ok).toBe(false)
    if (!proxy.ok) expect(proxy.error).toBe('proxy_metric_blocked')
  })

  it('adds a filter-legal filter and removes it by value', () => {
    const added = addFilter(base, {
      metricKey: 'median_gross_rent',
      op: 'lt',
      value: 2000,
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.intent.filters).toHaveLength(1)
    const filter = added.intent.filters[0]
    expect(filter).toBeDefined()
    const removed = removeFilter(added.intent, filter as NonNullable<typeof filter>)
    expect(removed.ok).toBe(true)
    if (removed.ok) expect(removed.intent.filters).toHaveLength(0)
  })

  it('removing the last geography returns a clarification-required intent', () => {
    const twoPlaces = { ...base, geographies: ['Hilo', 'Honolulu'] }
    const onePlace = removeGeography(twoPlaces, 'Hilo')
    expect(onePlace.ok).toBe(true)
    if (onePlace.ok) {
      expect(onePlace.intent.geographies).toEqual(['Honolulu'])
      expect(onePlace.intent.clarificationNeeded).toBe(false)
    }

    const noPlaces = removeGeography({ ...base, geographies: ['Hilo'] }, 'Hilo')
    expect(noPlaces.ok).toBe(true)
    if (noPlaces.ok) {
      expect(noPlaces.intent.geographies).toEqual([])
      expect(noPlaces.intent.clarificationNeeded).toBe(true)
    }
  })

  it('resolves clarification with a place, or placeless as the national screen', () => {
    const unclear = { ...base, geographies: [], clarificationNeeded: true }
    expect(canResolveClarification({ mode: 'lookup', geographies: [] })).toBe(false)
    // No measure anywhere: nothing completes, placeless or not.
    expect(
      resolveClarification(
        { ...unclear, metricKeys: [] },
        { geographies: [], metricKeys: [] },
      ).ok,
    ).toBe(false)
    // A screen measure with no place completes as the national screen
    // since 2026-11-01 (core/ai/national-screen.ts) — the pre-screen
    // contract required a place here and resolved nothing.
    const screened = resolveClarification(unclear, { geographies: [], metricKeys: [] })
    expect(screened.ok).toBe(true)
    if (screened.ok) {
      expect(screened.intent.mode).toBe('sweep_filter')
      expect(screened.intent.geographies).toEqual([])
      expect(screened.intent.clarificationNeeded).toBe(false)
    }
    const resolved = resolveClarification(unclear, {
      geographies: ['Hilo'],
      metricKeys: ['median_gross_rent'],
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.intent.clarificationNeeded).toBe(false)
      expect(resolved.intent.geographies).toEqual(['Hilo'])
      expect(resolved.intent.metricKeys).toContain('median_gross_rent')
    }
  })
})

describe('canRun (one predicate for executable intent)', () => {
  it('is false for a lookup with no measure and for one with no place', () => {
    expect(canRun({ ...base, metricKeys: [] })).toBe(false)
    expect(canRun({ ...base, geographies: [] })).toBe(false)
  })

  it('is true for a valid place/measure pair', () => {
    expect(canRun(base)).toBe(true)
  })

  it('needs rank-legal measures in sweep_filter/similarity via the one allowlist', () => {
    expect(
      canRun({
        mode: 'sweep_filter',
        geographies: ['HI'],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'gt', value: 0 }],
        clarificationNeeded: false,
      }),
    ).toBe(true)
    // FM-9 (owner ruling 2026-11-03): median_age is rank-legal, so a
    // bounded age sweep runs where this pin previously read false.
    expect(
      canRun({
        mode: 'sweep_filter',
        geographies: ['HI'],
        metricKeys: ['median_age'],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(true)
    // A display-only demographic figure is not rank-legal: the
    // allowlist still refuses it as a sweep measure.
    expect(
      canRun({
        mode: 'sweep_filter',
        geographies: ['HI'],
        metricKeys: ['below_poverty_count'],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(false)
  })

  it('removing the last measure returns a clarification-required intent', () => {
    const removed = removeMetricKey(base, 'median_gross_rent')
    expect(removed.ok).toBe(true)
    if (removed.ok) {
      expect(removed.intent.metricKeys).toEqual([])
      expect(removed.intent.clarificationNeeded).toBe(true)
    }
  })

  it('removing one of two measures keeps the intent runnable', () => {
    const two = { ...base, metricKeys: ['median_gross_rent', 'median_household_income'] }
    const removed = removeMetricKey(two, 'median_gross_rent')
    expect(removed.ok).toBe(true)
    if (removed.ok) {
      expect(removed.intent.metricKeys).toEqual(['median_household_income'])
      expect(removed.intent.clarificationNeeded).toBe(false)
    }
  })

  it('resolves clarification only with a place AND a measure', () => {
    expect(canResolveClarification({ mode: 'lookup', geographies: ['Hilo'] })).toBe(false)
    expect(
      canResolveClarification({
        mode: 'lookup',
        geographies: ['Hilo'],
        metricKeys: ['median_gross_rent'],
      }),
    ).toBe(true)
    // FM-9 (owner ruling 2026-11-03): a place plus the rank-legal
    // median_age resolves — this case read false before the ruling.
    expect(
      canResolveClarification({
        mode: 'sweep_filter',
        geographies: ['HI'],
        metricKeys: ['median_age'],
      }),
    ).toBe(true)
    // FLIPPED (FM-9 live cure, 2026-11-03): a place plus a
    // display-only figure in a sweep now resolves — but as the
    // research-first HANDOFF, never as a screen: the figure leaves
    // the measure list and no figure ranking runs. (Before the
    // cure this read false and the live panel dead-ended on the
    // same shape.) The non-resolution this pin exists for — no
    // figure-ranked completion on a display-only key — still holds,
    // asserted on the resolved shape below.
    expect(
      canResolveClarification({
        mode: 'sweep_filter',
        geographies: ['HI'],
        metricKeys: ['below_poverty_count'],
      }),
    ).toBe(true)
    const demographicResolved = resolveClarification(
      {
        mode: 'sweep_filter',
        geographies: ['HI'],
        metricKeys: [],
        filters: [],
        clarificationNeeded: true,
      },
      { geographies: [], metricKeys: ['below_poverty_count'] },
    )
    expect(demographicResolved.ok).toBe(true)
    if (demographicResolved.ok) {
      expect(demographicResolved.intent.mode).toBe('sweep_filter')
      expect(demographicResolved.intent.geographies).toEqual(['HI'])
      expect(demographicResolved.intent.metricKeys).toEqual([])
      expect(demographicResolved.intent.clarificationNeeded).toBe(false)
    }
    const unclear = { ...base, geographies: [], metricKeys: [], clarificationNeeded: true }
    expect(
      resolveClarification(unclear, { geographies: ['Hilo'], metricKeys: [] }).ok,
    ).toBe(false)
  })

  it('adding the missing half to a clarifying intent clears the flag', () => {
    const noPlace = { ...base, geographies: [], clarificationNeeded: true }
    const placed = addGeography(noPlace, 'Hilo')
    expect(placed.ok).toBe(true)
    if (placed.ok) {
      expect(placed.intent.geographies).toEqual(['Hilo'])
      expect(placed.intent.clarificationNeeded).toBe(false)
    }
    const noMeasure = { ...base, metricKeys: [], clarificationNeeded: true }
    const measured = addMetricKey(noMeasure, 'median_gross_rent')
    expect(measured.ok).toBe(true)
    if (measured.ok) {
      expect(measured.intent.metricKeys).toEqual(['median_gross_rent'])
      expect(measured.intent.clarificationNeeded).toBe(false)
    }
  })

  it('re-adding an existing chip heals a stale clarification flag', () => {
    const stale = { ...base, clarificationNeeded: true }
    const place = addGeography(stale, 'Hilo')
    expect(place.ok).toBe(true)
    if (place.ok) expect(place.intent.clarificationNeeded).toBe(false)
    const measure = addMetricKey(stale, 'median_gross_rent')
    expect(measure.ok).toBe(true)
    if (measure.ok) expect(measure.intent.clarificationNeeded).toBe(false)
  })

  it('validateIntent rejects a runnable-claimed intent with no measure', () => {
    const empty = validateIntent({
      mode: 'lookup',
      geographies: ['Hilo'],
      metricKeys: [],
      filters: [],
      clarificationNeeded: false,
    })
    expect(empty.ok).toBe(false)
    const clarifying = validateIntent({
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    })
    expect(clarifying.ok).toBe(true)
  })
})

describe('Ask surface completion', () => {
  it('keeps disclosure on the Ask surface; mic renders its no-recorder state, never a dead control', () => {
    const html = renderToStaticMarkup(<AskPanel provider={createStubProvider()} />)
    expect(html).toContain('This is a reading of the shown figures')
    // Item 12 shipped: with no recorder available in this environment
    // the mic surface states that plainly (with its audio disclosure)
    // instead of rendering a control that cannot work.
    expect(html).toContain('Voice input is not available in this browser')
    expect(html).toContain('audio is not stored')
    expect(html).not.toContain('Speak a question')
  })

  it('renders one add row with a place / measure / filter selector', () => {
    // REVISED PIN (item-16 cure C9, 2026-11-02): this test used to
    // pin three separate add-forms ('Add a place', 'Add a measure',
    // 'Add a filter', each with its own submit). C9 collapsed them
    // into one add row — a field-type selector, that type's input,
    // and a single Add — so the pin now asserts the collapsed shape.
    const html = renderToStaticMarkup(<IntentEditor intent={base} onChange={() => {}} />)
    expect(html).toContain('intent-add-kind')
    expect(html).toContain('>place</option>')
    expect(html).toContain('>measure</option>')
    expect(html).toContain('>filter</option>')
    expect(html).not.toContain('Add a place')
    expect(html).not.toContain('Add measure')
    expect(html).not.toContain('Add filter')
  })

  it('renders clarification candidates before execution', () => {
    const html = renderToStaticMarkup(
      <ClarificationPanel
        intent={{ ...base, geographies: [], clarificationNeeded: true }}
        candidates={{ geographies: ['Hilo'], metricKeys: ['median_gross_rent'] }}
        onResolve={() => {}}
      />,
    )
    expect(html).toContain('Hilo')
    // REVISED PIN (item-16 cure C2, 2026-11-02): the panel used to
    // render a "Use these choices" confirm button here — enabled in
    // this state, because the intent already carries a screen
    // measure and the current choices complete as the national
    // screen. The confirm button is removed; the completing pick
    // runs the request, so the static render carries the candidates
    // and no confirm control at all.
    expect(html).not.toContain('Use these choices')
  })

  it('offers BYO only on shutoff/error, not the happy path', () => {
    const offer = renderToStaticMarkup(
      <ByoOffer error="budget_exhausted" onOpenSettings={() => {}} />,
    )
    expect(offer.toLowerCase()).toContain('personal')
    expect(offer).toContain('Open key settings')
    expect(
      renderToStaticMarkup(
        <ByoOffer error="provider_down" onOpenSettings={() => {}} />,
      ),
    ).toBe('')
  })

  it('keeps key entry in settings, off the Ask surface', () => {
    const ask = renderToStaticMarkup(
      <AskPanel provider={createStubProvider()} />,
    )
    expect(ask).not.toContain('type="password"')
    expect(ask).not.toContain('Meta key')
    const settings = renderToStaticMarkup(<ByoSettings />)
    expect(settings).toContain('type="password"')
    expect(settings).toContain('Personal key')
  })
})
