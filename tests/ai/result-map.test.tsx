// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnswerPlace, ComposedAnswer } from '../../src/core/ai/answer'
import { encodeCentroids } from '../../src/core/map/centroids'
import {
  _resetPacing,
  budgetState,
  configureRateLimit,
  resetBudget,
} from '../../src/core/ratelimit'
import { ResultMap } from '../../src/ui/map/ResultMap'
import { ProgressivePlacesMap } from '../../src/ui/map/ProgressivePlacesMap'
import { SessionMapView } from '../../src/ui/map/SessionMapView'
import { QualifyingPlacesMap } from '../../src/ui/map/QualifyingPlacesMap'
import { answerPlaceAnchorId } from '../../src/core/map/result-scale'

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
let tigerwebHang = false

/**
 * A small square polygon at a deterministic centre per ZCTA. The
 * committed fixture holds Seattle geometry only; the mixed-map pins
 * (P2e) need Hawaii shapes, and a square is enough geometry for the
 * projection fit and the element counts those pins assert.
 */
function syntheticSquare(zcta: string) {
  const seed = Number(zcta.slice(3)) % 90
  const lon = -155.05 - seed * 0.01
  const lat = 19.55 + seed * 0.004
  const h = 0.02
  return {
    type: 'Feature',
    properties: { ZCTA5: zcta },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon - h, lat - h],
          [lon + h, lat - h],
          [lon + h, lat + h],
          [lon - h, lat + h],
          [lon - h, lat - h],
        ],
      ],
    },
  }
}

function installFetchStub() {
  tigerwebCalls = 0
  tigerwebStatus = 200
  tigerwebHang = false
  vi.stubGlobal('fetch', async (input: unknown, init?: { signal?: AbortSignal }) => {
    const url = String(input)
    if (url.includes('tigerweb.geo.census.gov')) {
      tigerwebCalls += 1
      if (tigerwebHang) {
        // A hung upstream: the promise settles only when the
        // caller aborts, exactly as a real fetch behaves.
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
            return
          }
          signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        })
      }
      if (tigerwebStatus !== 200) return new Response('upstream failure', { status: tigerwebStatus })
      const where = new URL(url).searchParams.get('where') ?? ''
      const asked = where.match(/\d{5}/g) ?? []
      const features: unknown[] = FIXTURE_FEATURES.filter((f) => asked.includes(f.properties.ZCTA5))
      for (const zcta of asked) {
        if (/^96[78]\d{2}$/.test(zcta)) features.push(syntheticSquare(zcta))
      }
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
  vi.useRealTimers()
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

/**
 * C4 pin (item-16 audit, section 6): jsdom has no IntersectionObserver,
 * and that no-observer path must start the geometry load on mount —
 * there is no gate button to click and no click is needed. This
 * helper sits at the seam where these tests used to click the gate
 * button ("Show the map for this answer"); it fails if that button
 * returns, and every test below then reaches the map with zero
 * clicks. Replaces the old click-to-start helper — the change is
 * recorded here per the audit's pin discipline.
 */
function expectNoGateButton() {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Show the map for this answer'),
  )
  expect(
    button,
    'the gate button must not render when IntersectionObserver is absent (item-16 cure C4)',
  ).toBeUndefined()
}

describe('ResultMap — choropleth mode', () => {
  it('paints the answer places, carries the figures on the legend ends, and re-colors without refetching on a metric switch', async () => {
    render(<ResultMap answer={answer({ places: SEATTLE_PLACES })} />)
    expectNoGateButton()
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

  it('drawn result paths track the feature geometry, never the frame (R23 winding cure)', async () => {
    // The R23 captures' defect: every result path carried the
    // projection's sphere outline (its TIGERweb ring wound against
    // d3's spherical convention, so each polygon rendered as its own
    // complement) and all 25 paths shared one frame-sized rendered
    // bbox. jsdom has no getBBox, so the pin reads the path data
    // itself: a true ZCTA path sits inside the 960x500 frame and
    // nowhere near fills it; a complement path's coordinates span
    // thousands of units and every feature's bbox is identical.
    render(<ResultMap answer={answer({ places: SEATTLE_PLACES })} />)
    expectNoGateButton()
    await flushUntil(() => container.querySelectorAll('svg [data-result-place]').length === 3)
    const paths = [...container.querySelectorAll('svg path[data-result-place]')]
    expect(paths.length).toBeGreaterThanOrEqual(2)
    const bboxes = paths.map((p) => {
      const nums = (p.getAttribute('d') ?? '').match(/-?\d+\.?\d*(?:e-?\d+)?/gi)?.map(Number) ?? []
      const xs = nums.filter((_, i) => i % 2 === 0)
      const ys = nums.filter((_, i) => i % 2 === 1)
      return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      }
    })
    for (const b of bboxes) {
      expect(b.minX).toBeGreaterThanOrEqual(0)
      expect(b.maxX).toBeLessThanOrEqual(960)
      expect(b.minY).toBeGreaterThanOrEqual(0)
      expect(b.maxY).toBeLessThanOrEqual(500)
      // Fixture-measured: the largest Seattle path covers ~30% of
      // the frame's area; a complement path covers ~71% of it (the
      // captures' 701x484 of 960x500).
      expect((b.maxX - b.minX) * (b.maxY - b.minY)).toBeLessThan(0.5 * 960 * 500)
    }
    // Real neighboring ZCTAs differ in size — at least one drawn
    // path is small. A complement set has no small path: every
    // feature carries the same sphere-sized bbox.
    expect(Math.min(...bboxes.map((b) => b.maxX - b.minX))).toBeLessThan(240)
    const distinct = new Set(
      bboxes.map((b) => [b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v)).join(',')),
    )
    expect(distinct.size, 'each feature draws its own shape, not one shared outline').toBe(
      bboxes.length,
    )
  }, 30000)

  it('shows the hovered place its card figures in the place panel', async () => {
    render(<ResultMap answer={answer({ places: SEATTLE_PLACES })} />)
    expectNoGateButton()
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
    expectNoGateButton()
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
    expectNoGateButton()
    await flushUntil(() => (container.textContent ?? '').includes('could not be loaded'))
    expect(container.textContent).toContain(
      'The map for this answer could not be loaded. Every figure is in the answer above and the screening table below.',
    )
    expect(container.querySelector('svg')).toBeNull()
  }, 30000)

  it('a hung geometry load settles to the failure line at the load deadline instead of loading forever (cure round 4)', async () => {
    // The load chain carried no timeout anywhere (cure round 4,
    // 2026-11-03): a TIGERweb response that never settles left the
    // card on "Loading the map for this answer..." indefinitely —
    // the live probe's Arizona answer was still on that line at its
    // final check. The stub hangs the geometry request (settling
    // only on abort, as a real fetch does); fake timers carry the
    // load past its 90-second deadline.
    vi.useFakeTimers()
    tigerwebHang = true
    render(<ResultMap answer={answer({ places: SEATTLE_PLACES })} />)
    expectNoGateButton()
    // Let the same-origin assets land and the geometry load begin.
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Loading the map for this answer...')
    await act(async () => {
      vi.advanceTimersByTime(90_000)
    })
    for (let i = 0; i < 20 && !(container.textContent ?? '').includes('could not be loaded'); i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
      })
    }
    expect(container.textContent).toContain(
      'The map for this answer could not be loaded. Every figure is in the answer above and the screening table below.',
    )
    expect(container.textContent).not.toContain('Loading the map for this answer...')
    expect(container.querySelector('svg')).toBeNull()
  }, 30000)
})

describe('ResultMap — no-observer path starts on mount (item-16 cure C4)', () => {
  it('an answer with places shows its loading line and then the map with zero clicks, and never a gate button', async () => {
    // jsdom has no IntersectionObserver, so this IS the no-observer
    // path. Before C4 it rendered a gate button and nothing loaded
    // until that button was clicked; the pin fails on either half of
    // that returning — a button in the tree, or no load under way
    // after mount with zero clicks.
    render(<ResultMap answer={answer({ places: SEATTLE_PLACES })} />)
    expectNoGateButton()
    const text = container.textContent ?? ''
    expect(
      text.includes('Loading the map for this answer') || container.querySelector('svg') !== null,
      'the no-observer path must start the geometry load on mount, with no click',
    ).toBe(true)
    await flushUntil(() => container.querySelectorAll('svg [data-result-place]').length === 3)
    expectNoGateButton()
    expect(tigerwebCalls).toBe(1)
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
    expectNoGateButton()
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

describe('ResultMap — mixed aggregate + plain place (P2e)', () => {
  // The C6 shape from the closing battery (cluster C, on be13e7e): a
  // state-average aggregate over 6 Hawaii ZIP areas beside Hilo
  // itself as a plain place. Before P2e the county-mode renderer drew
  // only the merged outline — Hilo had no element — while the status
  // line claimed the map showed 2 places.
  const HAWAII_MEMBERS = ['96720', '96740', '96749', '96760', '96761', '96778']
  const stateAverage = () =>
    place('county:HI:Hawaii', 'Hawaii state average', [['median_rent_burden_pct', 32.31]], HAWAII_MEMBERS)
  const burdenCriteria = [{ metricKey: 'median_rent_burden_pct', bound: 'atMost' as const, value: 35, intentOp: 'lt' as const }]

  it('C6 shape: the aggregate outline and Hilo each render as their own element with their own figure', async () => {
    const hilo = place('96720', 'Hilo, HI', [['median_rent_burden_pct', 32]])
    render(
      <ResultMap
        answer={answer({
          criteria: burdenCriteria,
          geographyLevel: 'state',
          places: [stateAverage(), hilo],
          screenedCount: 2,
        })}
      />,
    )
    expectNoGateButton()
    await flushUntil(() => container.querySelectorAll('svg [data-result-place]').length === 2)

    const elements = [...container.querySelectorAll('svg [data-result-place]')]
    expect(elements).toHaveLength(2)
    // Draw order: the aggregate's merged outline first, the
    // individual place on top of it.
    expect(elements[0]!.getAttribute('data-result-place')).toBe('county:HI:Hawaii')
    expect(elements[1]!.getAttribute('data-result-place')).toBe('96720')
    // Each element is labelled with its OWN figure — Hilo's 32, not
    // the state average's 32.31 — and colored by it.
    expect(elements[0]!.getAttribute('aria-label')).toBe('Hawaii state average: 32.31')
    expect(elements[1]!.getAttribute('aria-label')).toBe('Hilo, HI, 96720: 32')
    expect(elements[0]!.getAttribute('fill')).not.toBe(elements[1]!.getAttribute('fill'))
    // The status count equals the number of rendered elements.
    expect(container.textContent).toContain('The map shows 2 places from this answer')
    // Hilo is a member of the aggregate, so its polygon came with
    // the outline load — no second geometry fetch.
    expect(tigerwebCalls).toBe(1)
  }, 30000)

  it('mixed county + outside place: a plain place outside the aggregate renders too, with its geometry fetched', async () => {
    const honolulu = place('96813', 'Honolulu, HI', [['median_rent_burden_pct', 36]])
    render(
      <ResultMap
        answer={answer({
          criteria: burdenCriteria,
          geographyLevel: 'state',
          places: [stateAverage(), honolulu],
          screenedCount: 2,
        })}
      />,
    )
    expectNoGateButton()
    await flushUntil(() => container.querySelectorAll('svg [data-result-place]').length === 2)

    const elements = [...container.querySelectorAll('svg [data-result-place]')]
    expect(elements.map((e) => e.getAttribute('data-result-place'))).toEqual(['county:HI:Hawaii', '96813'])
    expect(elements[1]!.getAttribute('aria-label')).toBe('Honolulu, HI, 96813: 36')
    expect(container.textContent).toContain('The map shows 2 places from this answer')
    // Honolulu is not an aggregate member: one fetch for the outline
    // members, one scoped fetch for the plain place's own ZCTA.
    expect(tigerwebCalls).toBe(2)
  }, 30000)
})

describe('ResultMap — national mode', () => {
  it('renders centroid circles by value and never fetches ZCTA geometry', async () => {
    const places = [
      place('98101', 'Seattle, WA', [['median_gross_rent', 2340], ['median_home_value', 820000]]),
      place('10001', 'New York, NY', [['median_gross_rent', 2100], ['median_home_value', 900000]]),
    ]
    render(<ResultMap answer={answer({ geographyLevel: 'national', places, screenedCount: 2 })} />)
    expectNoGateButton()
    await flushUntil(() => container.querySelectorAll('svg circle[data-result-place]').length === 2)
    expect(container.textContent).toContain('across the country')
    expect(tigerwebCalls, 'national mode uses shipped centroids, not TIGERweb geometry').toBe(0)
    const circles = [...container.querySelectorAll('svg circle[data-result-place]')]
    const r = circles.map((c) => Number(c.getAttribute('r')))
    expect(Math.max(...r)).toBeGreaterThan(Math.min(...r))
  }, 30000)
})

/* ------------------------------------------------------------------ */
/* K2 — the answer map under an exhausted Census budget, and the      */
/* one-place progressive render (Lane completion program, 2026-11-03) */
/* ------------------------------------------------------------------ */

describe('K2 — answer map with the Census budget exhausted', () => {
  it('the map renders from the answer\u2019s own places and spends no key budget on geometry', async () => {
    // The specimen state: the browser's counted Census budget is
    // gone (450 of 450 spent by earlier runs). The answer's figures
    // are in hand; only its boundary geometry is fetched, from
    // keyless TIGERweb. Before the cure, paced() walled that fetch
    // with QuotaExhaustedError and the card showed the failure line.
    configureRateLimit({ minIntervalMs: 0, dailyBudget: 0 })
    try {
      render(<ResultMap answer={answer({ places: SEATTLE_PLACES })} />)
      expectNoGateButton()
      await flushUntil(() => container.querySelectorAll('svg [data-result-place]').length === 3)
      expect(container.textContent).not.toContain('could not be loaded')
      expect(tigerwebCalls).toBe(1)
      // Geometry is keyless: the key budget was not charged for it.
      expect(budgetState().used).toBe(0)
    } finally {
      configureRateLimit({ minIntervalMs: 400, dailyBudget: 450 })
    }
  }, 30000)
})

describe('K2 — progressive map at one interim place', () => {
  it('a snapshot carrying exactly one interim place renders the map with that place', async () => {
    render(
      <ProgressivePlacesMap
        places={[
          {
            name: 'Seattle, WA',
            zcta: '98101',
            verdicts: [{ criterion: 'School quality', state: 'served' }],
          },
        ]}
      />,
    )
    await flushUntil(() => container.querySelector('[data-testid="progressive-places-map"]') !== null)
    const panel = container.querySelector('[data-testid="progressive-places-map"]')!
    expect(panel.textContent).toContain('places so far')
    expect(panel.textContent).toContain('Seattle, WA')
  }, 30000)
})

describe('QualifyingPlacesMap — research-first terminal map (Lane completion K7)', () => {
  it('marks the card\u2019s places as buttons, and a mark jumps to the place\u2019s card entry', async () => {
    render(<QualifyingPlacesMap places={SEATTLE_PLACES} />)
    // A stand-in card entry carrying the anchor the PlaceBlock
    // renders — appended after the root's first render, which
    // clears the container, and outside it, as the real card
    // entry sits outside the map's own subtree.
    const target = document.createElement('article')
    target.id = answerPlaceAnchorId('98101')
    target.tabIndex = -1
    document.body.appendChild(target)
    const scrolled = vi.fn()
    const focused = vi.fn()
    target.scrollIntoView = scrolled
    target.focus = focused
    await flushUntil(
      () =>
        container.querySelectorAll('[data-testid="qualifying-places-map"] [role="button"]')
          .length === 3,
    )
    const panel = container.querySelector('[data-testid="qualifying-places-map"]')!
    expect(panel.textContent).toContain('The places this answer names')
    expect(panel.textContent).toContain('A place this answer names')
    const marks = [...panel.querySelectorAll('[role="button"]')]
    expect(marks[0]!.getAttribute('aria-label')).toContain(
      'See the details and sources for Seattle, WA',
    )
    act(() => {
      marks[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(scrolled).toHaveBeenCalled()
    expect(focused).toHaveBeenCalled()
    target.remove()
  }, 30000)

  it('county aggregates are not points and never enter the map set', async () => {
    const counties = [
      place('county:TX:Travis', 'Travis County, TX', [['median_gross_rent', 1500]], ['78701']),
      place('98101', 'Seattle, WA', [['median_gross_rent', 2340]]),
      place('98103', 'Seattle, WA', [['median_gross_rent', 1895]]),
    ]
    render(<QualifyingPlacesMap places={counties} />)
    await flushUntil(
      () =>
        container.querySelectorAll('[data-testid="qualifying-places-map"] [role="button"]')
          .length === 2,
    )
    const labels = [...container.querySelectorAll('[role="button"]')].map((b) =>
      b.getAttribute('aria-label'),
    )
    expect(labels.join(' ')).not.toContain('Travis')
  }, 30000)
})

describe('SessionMapView — empty state (Lane completion K9)', () => {
  it('the "See the whole country" button carries the padding that lifts it to the tap-target floor', () => {
    // DOM census on production 6027031 measured this button at
    // 20px tall at every audited width — under the 24px floor,
    // and a standalone button takes no inline-link exception.
    // jsdom does no layout, so the pin holds the class contract
    // (py-1 = 8px of vertical padding on the measured 20px box);
    // the rendered height is re-measured on the deployed build.
    render(
      <SessionMapView answer={null} questionText={null} overview={<div>overview</div>} />,
    )
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('See the whole country'),
    )
    expect(button).toBeDefined()
    expect(button!.className).toContain('py-1')
  })
})
