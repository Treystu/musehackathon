// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnswerPlace, ComposedAnswer } from '../../src/core/ai/answer'
import { encodeCentroids } from '../../src/core/map/centroids'
import { _resetPacing, resetBudget } from '../../src/core/ratelimit'
import { ResultMap } from '../../src/ui/map/ResultMap'

/**
 * ResultMap component pins (drive item 13 / plan P6), hermetic: the
 * network boundary is a fetch stub — TIGERweb answers with the
 * committed Seattle fixture (real probe geometry for 98101-98103 plus
 * a MultiPolygon stand-in), the centroid binary is encoded in-test
 * from the same points the assertions use, and the states basemap is
 * empty. Fetch counting pins the metric-switch rule: switching
 * re-colors only and must never refetch geometry.
 */

const FIXTURE = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'result-geometry-seattle.json'), 'utf8')
const FIXTURE_FEATURES = (JSON.parse(FIXTURE) as { features: { properties: { ZCTA5: string } }[] }).features

const CENTROID_POINTS = [
  { zcta: '98101', lon: -122.332, lat: 47.609 },
  { zcta: '98102', lon: -122.32, lat: 47.637 },
  { zcta: '98103', lon: -122.343, lat: 47.672 },
  { zcta: '98115', lon: -122.296, lat: 47.685 },
  { zcta: '98199', lon: -122.36, lat: 47.64 },
  { zcta: '10001', lon: -73.99, lat: 40.75 },
]

let tigerwebCalls = 0
let tigerwebStatus = 200

function installFetchStub() {
  tigerwebCalls = 0
  tigerwebStatus = 200
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input)
    if (url.includes('tigerweb.geo.census.gov')) {
      tigerwebCalls += 1
      if (tigerwebStatus !== 200) return new Response('upstream failure', { status: tigerwebStatus })
      const where = new URL(url).searchParams.get('where') ?? ''
      const asked = where.match(/\d{5}/g) ?? []
      const features = FIXTURE_FEATURES.filter((f) => asked.includes(f.properties.ZCTA5))
      return new Response(JSON.stringify({ type: 'FeatureCollection', features }), {
        status: 200,
        headers: { 'Content-Type': 'application/geo+json' },
      })
    }
    if (url.includes('/map/zcta-centroids.bin')) {
      return new Response(encodeCentroids(CENTROID_POINTS), { status: 200 })
    }
    if (url.includes('/map/us-states.json')) {
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

function place(zcta: string, name: string, figures: [string, number][], memberZctas?: string[]): AnswerPlace {
  return {
    zcta,
    name,
    figures: figures.map(([key, value]) => ({ key, value })),
    claims: [],
    ...(memberZctas ? { memberZctas } : {}),
  }
}

function answer(partial: Partial<ComposedAnswer>): ComposedAnswer {
  return {
    status: 'verified',
    stage: 'verify',
    criteria: [{ metricKey: 'median_gross_rent', bound: 'atMost', value: 2500, intentOp: 'lt' }],
    droppedCriteria: [],
    unresolvedGeographies: [],
    screenedCount: 3,
    places: [],
    generalClaims: [],
    sources: [],
    summary: '',
    droppedClaims: [],
    failures: [],
    researchCriteria: [],
    criterionEvidence: [],
    candidateCap: 10,
    candidateCapApplied: false,
    unresolvedCandidates: [],
    geographyLevel: 'place',
    unsupportedGeography: null,
    requestedCount: null,
    countyMethod: null,
    notMeasurableCounties: [],
    ...partial,
  }
}

const SEATTLE_PLACES = [
  place('98101', 'Seattle, WA', [['median_gross_rent', 2340], ['median_home_value', 820000]]),
  place('98103', 'Seattle, WA', [['median_gross_rent', 1895], ['median_home_value', 765000]]),
  place('98115', 'Seattle, WA', [['median_gross_rent', 890], ['median_home_value', 640000]]),
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  installFetchStub()
  _resetPacing()
  resetBudget()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

async function flushUntil(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    if (check()) return
  }
  throw new Error('condition not met before timeout')
}

/** jsdom has no IntersectionObserver, so the map offers its button — the click is the start. */
async function startMap() {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Show the map for this answer'),
  )
  expect(button, 'the show-map button should render when IntersectionObserver is absent').toBeTruthy()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('ResultMap — choropleth mode', () => {
  it('paints the answer places, carries the figures on the legend ends, and re-colors without refetching on a metric switch', async () => {
    render(<ResultMap answer={answer({ places: SEATTLE_PLACES })} />)
    await startMap()
    await flushUntil(() => container.querySelectorAll('svg [data-result-place]').length === 3)

    const paths = [...container.querySelectorAll('svg [data-result-place]')]
    expect(paths.map((p) => p.getAttribute('data-result-place')).sort()).toEqual(['98101', '98103', '98115'])
    const fills = new Set(paths.map((p) => p.getAttribute('fill')))
    expect(fills.size, 'places with different figures must not share one flat fill').toBeGreaterThan(1)

    const text = container.textContent ?? ''
    expect(text).toContain('Highest median gross rent — $2,340/mo')
    expect(text).toContain('Lowest median gross rent — $890/mo')
    expect(text).toContain('Darker means a higher figure')
    expect(tigerwebCalls).toBe(1)

    // Metric switch: re-color only. The fetch count is the pin.
    const select = container.querySelector('select')!
    await act(async () => {
      select.value = 'median_home_value'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('Highest median home value — $820,000')
    expect(container.textContent).toContain('Lowest median home value — $640,000')
    expect(tigerwebCalls, 'switching the metric must not refetch geometry').toBe(1)
  }, 30000)

  it('shows the hovered place its card figures in the place panel', async () => {
    render(<ResultMap answer={answer({ places: SEATTLE_PLACES })} />)
    await startMap()
    await flushUntil(() => container.querySelectorAll('svg [data-result-place]').length === 3)
    const target = container.querySelector('svg [data-result-place="98103"]')!
    await act(async () => {
      target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      target.dispatchEvent(new Event('focus', { bubbles: true }))
    })
    // React attaches mouseenter via mouseover delegation; fire both shapes.
    await act(async () => {
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const panel = container.querySelector('[data-testid="result-map-place-panel"]')
    expect(panel?.textContent).toContain('Seattle, WA')
    expect(panel?.textContent).toContain('$1,895/mo')
    expect(panel?.textContent).toContain('$765,000')
  }, 30000)

  it('a place with no returned boundary is shown as a dot and disclosed in words', async () => {
    const places = [
      ...SEATTLE_PLACES,
      place('98199', 'Seattle, WA', [['median_gross_rent', 1500], ['median_home_value', 700000]]),
    ]
    render(<ResultMap answer={answer({ places, screenedCount: 4 })} />)
    await startMap()
    await flushUntil(() => (container.textContent ?? '').includes('shown as dots'))
    expect(container.textContent).toContain('the Census Bureau publishes no area boundary for them')
    // The missing place still gets a dot element (a circle), not a polygon path.
    const dot = container.querySelector('svg circle')
    expect(dot).not.toBeNull()
  }, 30000)
})

describe('ResultMap — failure', () => {
  it('renders one quiet line and no SVG when geometry fails', async () => {
    render(<ResultMap answer={answer({ places: SEATTLE_PLACES })} />)
    tigerwebStatus = 500
    await startMap()
    await flushUntil(() => (container.textContent ?? '').includes('could not be loaded'))
    expect(container.textContent).toContain(
      'The map for this answer could not be loaded. Every figure is in the answer above and the screening table below.',
    )
    expect(container.querySelector('svg')).toBeNull()
  }, 30000)
})

describe('ResultMap — county mode', () => {
  it('draws exactly one merged outline for the county and never a member ZCTA element', async () => {
    const county = place(
      'county:53033',
      'King County, WA',
      [['median_gross_rent', 2100], ['median_home_value', 790000]],
      ['98101', '98102', '98103'],
    )
    render(
      <ResultMap
        answer={answer({
          geographyLevel: 'county',
          places: [county],
          screenedCount: 3,
          countyMethod: 'Each ZIP area is assigned to the county it overlaps most by land area.',
        })}
      />,
    )
    await startMap()
    await flushUntil(() => container.querySelectorAll('svg [data-result-place]').length === 1)
    const elements = [...container.querySelectorAll('svg [data-result-place]')]
    expect(elements).toHaveLength(1)
    expect(elements[0]!.getAttribute('data-result-place')).toBe('county:53033')
    for (const member of ['98101', '98102', '98103']) {
      expect(container.querySelector(`svg [data-result-place="${member}"]`)).toBeNull()
    }
    expect(container.textContent).toContain('the county it overlaps most')
  }, 30000)
})

describe('ResultMap — national mode', () => {
  it('renders centroid circles by value and never fetches ZCTA geometry', async () => {
    const places = [
      place('98101', 'Seattle, WA', [['median_gross_rent', 2340], ['median_home_value', 820000]]),
      place('10001', 'New York, NY', [['median_gross_rent', 2100], ['median_home_value', 900000]]),
    ]
    render(<ResultMap answer={answer({ geographyLevel: 'national', places, screenedCount: 2 })} />)
    await startMap()
    await flushUntil(() => container.querySelectorAll('svg circle[data-result-place]').length === 2)
    expect(container.textContent).toContain('across the country')
    expect(tigerwebCalls, 'national mode uses shipped centroids, not TIGERweb geometry').toBe(0)
    const circles = [...container.querySelectorAll('svg circle[data-result-place]')]
    const r = circles.map((c) => Number(c.getAttribute('r')))
    expect(Math.max(...r)).toBeGreaterThan(Math.min(...r))
  }, 30000)
})
