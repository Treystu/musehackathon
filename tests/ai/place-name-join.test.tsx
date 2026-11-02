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
 * Place-name join, card level (coordinator fixture render,
 * 2026-11-02): production sweep rows are named with the ACS label
 * ("ZCTA5 40771"), and the AnswerCard headlined that label verbatim.
 * The runner joins the place index's display name onto each row
 * before the pipeline runs; this test drives that whole path —
 * ACS-shaped rows in, rendered card out — because the runner-level
 * pins in answer-runner.test.ts cannot see the headline itself.
 */
const PLACES: PlaceSuggestion[] = [
  { displayName: 'Corbin', censusName: 'Corbin city', state: 'KY', isCity: true, zips: ['40771'] },
  { displayName: 'Hilo', censusName: 'Hilo CDP', state: 'HI', isCity: true, zips: ['96720'] },
]

const INDEX = new PlaceIndex(
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
              isCity: true,
              incorporated: true,
            },
          ] as const,
      ),
    ),
  ),
  PLACES,
)

const ACS_ROWS: AreaRow[] = [
  {
    zcta: '40771',
    name: 'ZCTA5 40771',
    metrics: { median_gross_rent: 900 },
    moes: { median_gross_rent: 85 },
  },
  {
    zcta: '96720',
    name: 'ZCTA5 96720',
    metrics: { median_gross_rent: 1450 },
    moes: { median_gross_rent: 85 },
  },
]

const INTENT: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: [],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
  clarificationNeeded: false,
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

describe('place-name join: the card headlines display names, not ACS labels', () => {
  it('renders "Corbin, KY" and "Hilo, HI" for rows named "ZCTA5 40771" / "ZCTA5 96720"', async () => {
    const answer = await composeAnswerForRequest({
      intent: INTENT,
      queryText: 'places where rent is under $1,500',
      rows: ACS_ROWS,
      resolved: resolveAnswerGeographies(INTENT, INDEX),
      provider: createStubProvider(),
      research: false,
      placeIndex: INDEX,
    })
    expect(answer?.status).toBe('verified')
    render(<AnswerCard answer={answer!} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Corbin, KY')
    expect(text).toContain('Hilo, HI')
    expect(text).not.toContain('ZCTA5')
  })
})
