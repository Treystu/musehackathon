/**
 * Phase-3 overhaul pins: map input, empty states, and prose placement.
 *
 * The pure helpers are asserted directly. Component behaviour that needs a
 * DOM (wheel handling, keyboard focus) is pinned at the source level here,
 * following the test_gates pattern, because this repo has no DOM test
 * environment — rendering assertions that CAN be made statically (the
 * zero-row table, the collapsed disclosures) use renderToStaticMarkup, as
 * tests/ai/explain-views.test.tsx does.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import type { HexBin } from '../src/core/map/binning'
import {
  binNearestToPoint,
  nearestBinInDirection,
  wheelZoomFactor,
} from '../src/ui/map-interactions'
import { SweepTable } from '../src/ui/SweepTable'
import { FairHousingNotice } from '../src/ui/FairHousingNotice'
import { FundingSection } from '../src/ui/Funding'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

const bin = (cx: number, cy: number, zcta: string): HexBin => ({
  cx,
  cy,
  value: 1,
  count: 1,
  withValue: 1,
  zctas: [zcta],
})

describe('wheel zoom factor', () => {
  it('zooms in on a negative delta and out on a positive one', () => {
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100, 0)).toBeLessThan(1)
  })

  it('normalises line-mode deltas so a mouse notch is not a no-op', () => {
    // deltaMode 1 is lines: 3 lines must move the zoom about as much as a
    // typical 48-pixel notch, not 3/100ths of it.
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0), 5)
  })

  it('clamps a single event and ignores a zero delta', () => {
    expect(wheelZoomFactor(-100000, 0)).toBeLessThanOrEqual(2)
    expect(wheelZoomFactor(100000, 0)).toBeGreaterThanOrEqual(0.5)
    expect(wheelZoomFactor(0, 0)).toBe(1)
  })
})

describe('keyboard bin movement', () => {
  const centre = bin(100, 100, '00000')
  const east = bin(130, 102, '00001')
  const farEast = bin(200, 100, '00002')
  const northEast = bin(128, 60, '00003')
  const west = bin(70, 100, '00004')
  const all = [centre, east, farEast, northEast, west]

  it('steps to the on-axis neighbour, not the diagonal one', () => {
    expect(nearestBinInDirection(all, centre, 1, 0)?.zctas).toEqual(['00001'])
  })

  it('returns null at the edge instead of wrapping', () => {
    expect(nearestBinInDirection(all, farEast, 1, 0)).toBeNull()
    expect(nearestBinInDirection(all, west, -1, 0)).toBeNull()
  })

  it('finds the centre-most bin to focus first', () => {
    expect(binNearestToPoint(all, 104, 96)?.zctas).toEqual(['00000'])
    expect(binNearestToPoint([], 0, 0)).toBeNull()
  })
})

describe('map source pins', () => {
  const interactions = read('src/ui/map-interactions.ts')
  const view = read('src/ui/MapView.tsx')

  it('attaches the wheel listener as non-passive, so preventDefault works', () => {
    expect(interactions).toMatch(/addEventListener\('wheel'/)
    expect(interactions).toMatch(/passive: false/)
    expect(interactions).toMatch(/zoomAround\(current, factor/)
  })

  it('selects the focused bin from the keyboard', () => {
    expect(interactions).toMatch(/case 'Enter':/)
    expect(interactions).toMatch(/onSelect\(focused\.zctas\)/)
    expect(interactions).toMatch(/nearestBinInDirection/)
  })

  it('the on-canvas copy promises only implemented gestures (no pinch)', () => {
    expect(view).toMatch(/scroll to zoom/)
    // The rendered hint must not promise pinch; the word may appear in
    // comments explaining why it is absent, so pin the gesture phrase.
    expect(view).not.toMatch(/pinch to zoom/)
    expect(view).not.toMatch(/scroll or pinch/)
  })
})

describe('empty states', () => {
  it('the sweep table names the zero-row state instead of an empty box', () => {
    const html = renderToStaticMarkup(
      <SweepTable
        rows={[]}
        onAdd={() => {}}
        onSortChange={() => {}}
        selectedZctas={[]}
        sortKey={null}
        ascending={true}
      />,
    )
    expect(html).toMatch(/No ZIP codes loaded yet\./)
    expect(html).not.toMatch(/<table/)
  })

  it('the autocomplete distinguishes no-results from loading in source', () => {
    const src = read('src/ui/SearchAutocomplete.tsx')
    expect(src).toMatch(/No matching city\./)
    expect(src).toMatch(/showNoResults/)
    // The no-results state must be gated on loading having finished.
    expect(src).toMatch(/!loading && !isZip/)
  })
})

describe('prose behind HelpTip, wording intact', () => {
  it('the Fair Housing notice keeps its full text and complaint routes', () => {
    const html = renderToStaticMarkup(<FairHousingNotice />)
    expect(html).toMatch(/Equal Housing Opportunity/)
    expect(html).toMatch(/federal Fair Housing Act prohibits/)
    expect(html).toMatch(/https:\/\/www\.hud\.gov\/helping-americans\/complaint-form/)
    expect(html).toMatch(/https:\/\/www\.justice\.gov\/crt\/housing-and-civil-enforcement-section/)
    expect(html).toMatch(/aria-label="How to read this data and fair housing contacts"/)
  })

  it('the Funding section keeps its disclaimers and all three routes', () => {
    const html = renderToStaticMarkup(<FundingSection />)
    expect(html).toMatch(/Contributions are voluntary gifts to an individual/)
    expect(html).toMatch(/No contribution can change any figure/)
    expect(html).toMatch(/https:\/\/www\.paypal\.me\/LBallek/)
    expect(html).toMatch(/https:\/\/venmo\.com\/u\/lucas-ballek/)
    expect(html).toMatch(/https:\/\/cash\.app\/\$luball/)
  })
})
