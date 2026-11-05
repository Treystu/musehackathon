// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnswerPlace, ComposedAnswer } from '../../src/core/ai/answer'
import type { BreadthPlace } from '../../src/core/ai/run-progress'
import { encodeCentroids } from '../../src/core/map/centroids'
import { _resetPacing, resetBudget } from '../../src/core/ratelimit'
import { ProgressivePlacesMap, type BreadthMapData } from '../../src/ui/map/ProgressivePlacesMap'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'

/**
 * Breadth map component pins (owner directive 2026-11-03 12:44
 * HST): the terminal breadth surface plots the whole display set
 * by standing with a plain-words legend; assessed marks are
 * buttons whose detail panel carries the standing and the cited
 * claims behind it; unassessed marks carry the pending style and
 * the honest note. The interim surface shares the component and
 * the pending vocabulary. Hermetic: the centroid binary is encoded
 * in-test from the same points the assertions use, the basemap is
 * empty, and no TIGERweb call exists on this surface at all —
 * points, not boundaries.
 */

const CENTROID_POINTS = [
  { zcta: '78701', lon: -97.743, lat: 30.271 },
  { zcta: '77002', lon: -95.364, lat: 29.758 },
  { zcta: '76102', lon: -97.33, lat: 32.756 },
  { zcta: '79843', lon: -104.02, lat: 30.311 },
]

const SOURCE = { title: 'Findings source', url: 'https://example.com/f' }

const TERMINAL_LABELS = {
  positive: 'Liberal-leaning',
  negative: 'Conservative-leaning',
  mixed: 'Mixed',
  unassessed: 'Not assessed',
}
const INTERIM_LABELS = { ...TERMINAL_LABELS, unassessed: 'Not yet assessed' }

const PLACES: BreadthPlace[] = [
  {
    name: 'Austin, TX',
    zcta: '78701',
    standing: 'positive',
    claims: [
      { text: 'Austin, TX is described as the most liberal city in Texas.', sourceUrls: [SOURCE.url] },
    ],
  },
  {
    name: 'Houston, TX',
    zcta: '77002',
    standing: 'mixed',
    claims: [
      { text: 'Houston, TX is described as politically mixed.', sourceUrls: [SOURCE.url] },
    ],
  },
  { name: 'Fort Worth, TX', zcta: '76102', standing: 'negative', claims: [] },
  { name: 'Marfa, TX', zcta: '79843', standing: 'unassessed' },
]

function breadthData(partial: Partial<BreadthMapData>): BreadthMapData {
  return {
    places: PLACES,
    labels: TERMINAL_LABELS,
    criterionLabel: 'Political leaning',
    geographyLabel: 'Texas',
    assessedCount: 3,
    displayTotal: 4,
    terminal: true,
    sources: [SOURCE],
    ...partial,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input)
    if (url.includes('/map/zcta-centroids.bin')) {
      return new Response(encodeCentroids(CENTROID_POINTS), { status: 200 })
    }
    if (url.includes('/map/us-states.json')) {
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
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

function circles(panel: Element): SVGCircleElement[] {
  return [...panel.querySelectorAll('circle')] as unknown as SVGCircleElement[]
}

describe('BreadthPlacesMap — terminal surface', () => {
  it('plots the whole display set by standing, with the legend naming every class', async () => {
    render(<ProgressivePlacesMap places={[]} breadth={breadthData({})} />)
    await flushUntil(() => container.querySelectorAll('[data-testid="breadth-places-map"] circle').length === 4)
    const panel = container.querySelector('[data-testid="breadth-places-map"]')!
    expect(panel.textContent).toContain('The areas of Texas by political leaning')
    expect(panel.textContent).toContain('3 of 4 areas assessed. Select an area to see the sources behind its standing.')
    // Legend: every class present, in plain words.
    for (const label of ['Liberal-leaning', 'Mixed', 'Conservative-leaning', 'Not assessed']) {
      expect(panel.textContent).toContain(label)
    }
    const byLabel = new Map(circles(panel).map((c) => [c.getAttribute('aria-label'), c]))
    expect(byLabel.get('Austin, TX: Liberal-leaning. See the sources behind this standing.')!.getAttribute('fill')).toBe('#1a73e8')
    expect(byLabel.get('Houston, TX: Mixed. See the sources behind this standing.')!.getAttribute('fill')).toBe('#9334e6')
    expect(byLabel.get('Fort Worth, TX: Conservative-leaning. See the sources behind this standing.')!.getAttribute('fill')).toBe('#e8710a')
    // Unassessed: the pending fill, visibly not a verdict.
    expect(byLabel.get('Marfa, TX: Not assessed. See the sources behind this standing.')!.getAttribute('fill')).toBe('#eef1f4')
    // The text alternative states every assessed standing, and the
    // unassessed remainder is accounted in words.
    expect(panel.textContent).toContain('Austin, TX — Liberal-leaning')
    expect(panel.textContent).toContain('1 area was not assessed — no cited source characterized it.')
  }, 30000)

  it('a mark opens the detail panel with the standing and the cited claims behind it', async () => {
    render(<ProgressivePlacesMap places={[]} breadth={breadthData({})} />)
    await flushUntil(() => container.querySelectorAll('[data-testid="breadth-places-map"] circle').length === 4)
    const austin = [...container.querySelectorAll('circle')].find((c) =>
      c.getAttribute('aria-label')?.startsWith('Austin, TX'),
    )!
    act(() => {
      austin.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const detail = container.querySelector('[data-testid="breadth-place-detail"]')!
    expect(detail).not.toBeNull()
    expect(detail.textContent).toContain('Austin, TX — Liberal-leaning')
    expect(detail.textContent).toContain('Austin, TX is described as the most liberal city in Texas.')
    const link = detail.querySelector('a')!
    expect(link.getAttribute('href')).toBe(SOURCE.url)
    expect(link.textContent).toBe('Findings source')
    // Selecting the unassessed mark states the absence plainly.
    const marfa = [...container.querySelectorAll('circle')].find((c) =>
      c.getAttribute('aria-label')?.startsWith('Marfa, TX'),
    )!
    act(() => {
      marfa.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const detail2 = container.querySelector('[data-testid="breadth-place-detail"]')!
    expect(detail2.textContent).toContain('Marfa, TX — Not assessed')
    expect(detail2.textContent).toContain('No cited source characterized this area in this run')
  }, 30000)
})

describe('BreadthPlacesMap — interim surface', () => {
  it('fills from the snapshot vocabulary: pending label, no buttons, interim honesty line', async () => {
    render(
      <ProgressivePlacesMap
        places={[]}
        breadth={breadthData({ terminal: false, labels: INTERIM_LABELS })}
      />,
    )
    await flushUntil(() => container.querySelectorAll('[data-testid="breadth-places-map"] circle').length === 4)
    const panel = container.querySelector('[data-testid="breadth-places-map"]')!
    expect(panel.textContent).toContain('Research in progress — the areas of Texas')
    expect(panel.textContent).toContain('Not yet assessed')
    expect(panel.textContent).toContain('1 area not yet assessed.')
    expect(panel.textContent).toContain('Standings are interim')
    expect(panel.querySelectorAll('[role="button"]')).toHaveLength(0)
  }, 30000)
})

describe('AnswerCard — breadth terminal wiring', () => {
  function place(zcta: string, name: string): AnswerPlace {
    return { zcta, name, figures: [{ key: 'median_gross_rent', value: 1500 }], claims: [] }
  }

  function breadthAnswer(): ComposedAnswer {
    return {
      status: 'verified',
      stage: 'verify',
      criteria: [{ metricKey: 'median_gross_rent', bound: 'atMost', value: 2500, intentOp: 'lt' }],
      droppedCriteria: [],
      unresolvedGeographies: [],
      screenedCount: 4,
      places: [place('78701', 'Austin, TX'), place('77002', 'Houston, TX')],
      generalClaims: [],
      sources: [SOURCE],
      summary: '',
      droppedClaims: [],
      failures: [],
      researchCriteria: [],
      criterionEvidence: [],
      candidateCap: 10,
      candidateCapApplied: true,
      unresolvedCandidates: [],
      geographyLevel: 'place',
      unsupportedGeography: null,
      requestedCount: null,
      countyMethod: null,
      notMeasurableCounties: [],
      researchNamedPlaces: ['Austin, TX', 'Houston, TX'],
      consideredNotMeeting: ['Fort Worth, TX'],
      breadth: {
        geographyLabel: 'Texas',
        criterionLabel: 'Political leaning',
        labels: TERMINAL_LABELS,
        displayTotal: 4,
        assessedCount: 3,
        elapsedMs: 42000,
        standings: PLACES,
      },
    }
  }

  it('mounts the breadth map, suppresses the qualifying map and the cap line, and prints the counts line', async () => {
    render(<AnswerCard answer={breadthAnswer()} />)
    // H1 answer-only: the in-answer map sits behind the collapsed
    // 'Show the map' disclosure; expand it before asserting the mount.
    const details = container.querySelector('details')
    expect(details?.querySelector('summary')?.textContent).toContain('Show the map')
    await act(async () => {
      ;(details as HTMLDetailsElement).open = true
      details!.dispatchEvent(new Event('toggle'))
      await new Promise((r) => setTimeout(r, 20))
    })
    await flushUntil(() => container.querySelector('[data-testid="breadth-places-map"]') !== null)
    expect(container.querySelector('[data-testid="qualifying-places-map"]')).toBeNull()
    const text = container.textContent ?? ''
    expect(text).toContain(
      '3 of 4 areas in Texas were assessed from cited sources. The other 1 area is shown on the map as not assessed — no cited source characterized it.',
    )
    // The candidate-cap line's "further places were not researched"
    // is false on a breadth card and must not render.
    expect(text).not.toContain('candidate places; any further places were not researched')
  }, 30000)
})
