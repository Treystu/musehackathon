// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import {
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'
import {
  PlaceIndex,
  type PlaceRecord,
  type PlaceSuggestion,
} from '../../src/core/zcta-place-index'

/**
 * P2f pin — battery D1 granularity shortfall (closing cluster D,
 * 2026-11-02: verdict PARTIAL, mode granularity_shortfall_unstated
 * PRESENT at Noul 0.91).
 *
 *   D1  "Where in Seattle has good schools and lots of Starbucks
 *       nearby?" — the intent names the CITY of Seattle, but lookup
 *       resolution serves ONE representative ZIP area for the place
 *       (98101, median gross rent $2,100 in the battery fixture).
 *       The shipped card presented that one ZIP as Seattle's answer
 *       and nothing on the card or page stated the within-city
 *       granularity shortfall: one ZIP area standing in for a whole
 *       city, unstated.
 *
 * The cure rides the resolution layer's existing disclosure seam
 * (the region readings of P2 cure 4): when lookup/compare
 * resolution takes one ZIP from a place that spans several, the
 * resolution result records the shortfall and the card renders it
 * as one of its quiet geography lines. Sweep resolution takes
 * every ZIP of the place, so it records nothing; a place with a
 * single ZIP area has no shortfall to state.
 */

const PLACES: PlaceSuggestion[] = [
  // Seattle spans three ZIP areas in this fixture; lookup serves 98101.
  { displayName: 'Seattle', censusName: 'Seattle city', state: 'WA', isCity: true, zips: ['98101', '98102', '98103'] },
  // A single-ZIP city: no shortfall exists to disclose.
  { displayName: 'Hilo', censusName: 'Hilo CDP', state: 'HI', isCity: true, zips: ['96720'] },
]

const PLACE_INDEX = new PlaceIndex(
  new Map<string, PlaceRecord>(
    PLACES.flatMap((place) =>
      place.zips.map(
        (zip) =>
          [
            zip,
            {
              zip,
              censusName: place.censusName,
              displayName: place.displayName,
              state: place.state,
              isCity: place.isCity,
              incorporated: true,
            },
          ] as const,
      ),
    ),
  ),
  PLACES,
)

const ROWS: AreaRow[] = [
  // The D1 battery figure: Seattle 98101 at $2,100 exactly.
  { zcta: '98101', name: 'ZCTA5 98101', metrics: { median_gross_rent: 2100, population: 20000 }, moes: { median_gross_rent: 60 } },
  { zcta: '98102', name: 'ZCTA5 98102', metrics: { median_gross_rent: 2200, population: 18000 }, moes: { median_gross_rent: 65 } },
  { zcta: '98103', name: 'ZCTA5 98103', metrics: { median_gross_rent: 1900, population: 22000 }, moes: { median_gross_rent: 55 } },
  { zcta: '96720', name: 'ZCTA5 96720', metrics: { median_gross_rent: 1450, population: 45000 }, moes: { median_gross_rent: 52 } },
]

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'lookup',
    geographies: [],
    metricKeys: [],
    filters: [],
    clarificationNeeded: false,
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
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

describe('D1: a city served by one ZIP states the granularity shortfall', () => {
  it('resolution serves one Seattle ZIP and records the shortfall', () => {
    const resolved = resolveAnswerGeographies(
      intent({ geographies: ['Seattle, WA'] }),
      PLACE_INDEX,
    )
    expect([...resolved.zctas]).toEqual(['98101'])
    expect(resolved.geographyDisclosures).toHaveLength(1)
    expect(resolved.geographyDisclosures[0]).toContain('Seattle, WA spans 3 ZIP areas')
    expect(resolved.geographyDisclosures[0]).toContain('98101')
    expect(resolved.geographyDisclosures[0]).toContain('not the whole city')
  })

  it('the D1-shaped card (research-first, both criteria cited) carries the line', async () => {
    const geoIntent = intent({ geographies: ['Seattle, WA'] })
    const answer = await composeAnswerForRequest({
      intent: geoIntent,
      queryText: 'Where in Seattle has good schools and lots of Starbucks nearby?',
      rows: ROWS,
      resolved: resolveAnswerGeographies(geoIntent, PLACE_INDEX),
      provider: createStubProvider({
        async research() {
          return {
            prose:
              'Seattle, WA schools are rated above the state average in the cited school directory. ' +
              'Seattle, WA has many Starbucks coffee shops in its downtown core, according to the cited store locator.',
            sources: [
              { title: 'State school directory', url: 'https://example.org/schools' },
              { title: 'Starbucks store locator', url: 'https://example.org/starbucks' },
            ],
          }
        },
      }),
      research: true,
      placeIndex: PLACE_INDEX,
      stack: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.zcta)).toEqual(['98101'])
    expect(answer?.places[0]?.name).toBe('Seattle, WA')
    expect(answer?.geographyDisclosures.some((line) => line.includes('not the whole city'))).toBe(true)
    render(<AnswerCard answer={answer!} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Seattle, WA spans 3 ZIP areas')
    expect(text).toContain('98101')
    expect(text).toContain('not the whole city')
    expect(text).not.toContain('98102')
  })

  it('a sweep over the same city takes every ZIP and records no shortfall', () => {
    const resolved = resolveAnswerGeographies(
      intent({ mode: 'sweep_filter', geographies: ['Seattle, WA'], metricKeys: ['median_gross_rent'] }),
      PLACE_INDEX,
    )
    expect([...resolved.zctas].sort()).toEqual(['98101', '98102', '98103'])
    expect(resolved.geographyDisclosures).toEqual([])
  })

  it('a single-ZIP city in lookup records no shortfall', () => {
    const resolved = resolveAnswerGeographies(
      intent({ geographies: ['Hilo, HI'] }),
      PLACE_INDEX,
    )
    expect([...resolved.zctas]).toEqual(['96720'])
    expect(resolved.geographyDisclosures).toEqual([])
  })

  it('a bare city name (no state suffix) records the same shortfall', () => {
    const resolved = resolveAnswerGeographies(
      intent({ geographies: ['Seattle'] }),
      PLACE_INDEX,
    )
    expect([...resolved.zctas]).toEqual(['98101'])
    expect(resolved.geographyDisclosures).toHaveLength(1)
    expect(resolved.geographyDisclosures[0]).toContain('Seattle spans 3 ZIP areas')
    expect(resolved.geographyDisclosures[0]).toContain('not the whole city')
  })
})
