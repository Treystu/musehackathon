// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  detectAreaMention,
  regionInterpretationFor,
} from '../../src/core/ai/area-mention'
import { resolveClarification } from '../../src/core/ai/intent-edit'
import { rescueNationalScreen } from '../../src/core/ai/national-screen'
import {
  createStubProvider,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import type { AreaRow } from '../../src/core/plugins/acs'
import { CountyIndex, type CountyRecord } from '../../src/core/zcta-county-index'
import {
  PlaceIndex,
  type PlaceRecord,
  type PlaceSuggestion,
} from '../../src/core/zcta-place-index'
import {
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'
import { AskPanel } from '../../src/ui/ai/AskPanel'

/**
 * Named-area cure pins (owner live failure, 2026-11-04, frozen build
 * 4b0b3a6): "Where is the cheapest place to live to commute and work
 * in the Bay area?" returned a national cheapest-rent screen headed
 * "No place was named", Corbin, KY leading 33,791 places. The cure:
 * the mention survives (the national rescue refuses its placeless
 * completion), the clarification panel syncs the interpretation for
 * confirmation before anything runs, and the confirmed intent
 * screens inside the region's county set. These pins fail if any
 * link of that chain regresses: the rescue widening again, the sync
 * not mounting, a measure-only pick bypassing it into the national
 * screen, or the region resolving wider than its membership.
 */

const OWNER_QUESTION =
  'Where is the cheapest place to live to commute and work in the Bay area?'

/** The live parse shape: the reply clarified with no geography and no measure. */
const clarifyingPlaceless: ValidatedIntent = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

describe('detectAreaMention', () => {
  it('finds the area the owner named, as written', () => {
    expect(detectAreaMention(OWNER_QUESTION)).toBe('Bay area')
    expect(detectAreaMention('what is the cheapest rent in the San Francisco Bay Area?')).toBe(
      'San Francisco Bay Area',
    )
    expect(detectAreaMention('cheapest place to live in the Greater Boston area')).toBe(
      'Greater Boston area',
    )
    // Gazetteer phrases are mentions however they are cased.
    expect(detectAreaMention('where in the pacific northwest is rent cheapest?')).toBe(
      'pacific northwest',
    )
  })

  it('stays silent for genuinely placeless and otherwise-served questions', () => {
    expect(detectAreaMention("What's the cheapest place to live")).toBeNull()
    expect(detectAreaMention('where is the cheapest rent in America?')).toBeNull()
    expect(detectAreaMention('What is the median rent in the area?')).toBeNull()
    expect(detectAreaMention('cheapest place to live in Texas')).toBeNull()
    // The demo question (Q6 family): researched criteria, no area named.
    expect(
      detectAreaMention(
        'Where can I find the best schools but also the fewest fast food restaurants?',
      ),
    ).toBeNull()
    expect(detectAreaMention('where near Philadelphia has good schools?')).toBeNull()
  })
})

describe('rescueNationalScreen under a named area', () => {
  it('refuses the placeless completion for the owner question', () => {
    expect(rescueNationalScreen(clarifyingPlaceless, OWNER_QUESTION)).toBeNull()
  })

  it('still completes the genuinely placeless superlative nationally', () => {
    const rescued = rescueNationalScreen(clarifyingPlaceless, "What's the cheapest place to live")
    expect(rescued?.geographies).toEqual([])
    expect(rescued?.metricKeys).toEqual(['median_gross_rent'])
  })
})

describe('resolveClarification region rule', () => {
  it('completes a confirmed region as a sweep over it', () => {
    const result = resolveClarification(clarifyingPlaceless, {
      geographies: ['San Francisco Bay Area'],
      metricKeys: ['median_gross_rent'],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.intent.mode).toBe('sweep_filter')
      expect(result.intent.geographies).toEqual(['San Francisco Bay Area'])
      expect(result.intent.clarificationNeeded).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Panel flow (jsdom): the sync mounts, nothing runs unconfirmed, the
// measure-only trap is refused, and the confirmation runs the region
// screen intent.
// ---------------------------------------------------------------------------

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

async function ask(text: string) {
  const input = container.querySelector('#ask-input') as HTMLInputElement
  const form = container.querySelector('form') as HTMLFormElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

function clickButtonWithText(text: string) {
  const button = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  )
  if (!button) throw new Error(`no button containing: ${text}`)
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function renderAskPanel(executed: ValidatedIntent[], requests: ValidatedIntent[]) {
  const provider = createStubProvider({
    async intent() {
      return { intent: clarifyingPlaceless }
    },
  })
  render(
    <AskPanel
      provider={provider}
      onExecute={(next) => {
        executed.push(next)
        return ''
      }}
      onAnswerRequest={(intent) => requests.push(intent)}
      clarificationCandidates={{ metricKeys: ['median_gross_rent', 'median_home_value'] }}
      parseRetryDelaysMs={[]}
    />,
  )
}

describe('AskPanel area sync (owner question)', () => {
  it('mounts the sync, runs nothing, and never renders the no-place premise', async () => {
    const executed: ValidatedIntent[] = []
    const requests: ValidatedIntent[] = []
    renderAskPanel(executed, requests)
    await ask(OWNER_QUESTION)
    const text = container.textContent ?? ''
    expect(text).toContain('You named Bay area.')
    expect(text).toContain('Yes — the San Francisco Bay Area, California')
    expect(text).not.toContain('No place was named')
    expect(text).not.toContain('screens the whole country')
    expect(executed).toHaveLength(0)
    expect(requests).toHaveLength(0)
  })

  it('refuses the measure-only pick instead of screening the whole country', async () => {
    const executed: ValidatedIntent[] = []
    const requests: ValidatedIntent[] = []
    renderAskPanel(executed, requests)
    await ask(OWNER_QUESTION)
    clickButtonWithText('Median gross rent')
    const text = container.textContent ?? ''
    expect(text).toContain('a measure on its own would screen the whole country')
    expect(executed).toHaveLength(0)
    expect(requests).toHaveLength(0)
  })

  it('runs the region screen on confirmation', async () => {
    const executed: ValidatedIntent[] = []
    const requests: ValidatedIntent[] = []
    renderAskPanel(executed, requests)
    await ask(OWNER_QUESTION)
    clickButtonWithText('Yes — the San Francisco Bay Area, California')
    const ran = [...executed, ...requests]
    expect(ran.length).toBeGreaterThan(0)
    const screen = ran.find((i) => i.mode === 'sweep_filter')
    expect(screen?.geographies).toEqual(['San Francisco Bay Area'])
    expect(screen?.metricKeys).toEqual(['median_gross_rent'])
    // The national screen never ran for this question, on any path.
    expect(ran.every((i) => !(i.mode === 'sweep_filter' && i.geographies.length === 0))).toBe(true)
  })

  it('names an unknown area honestly and still runs nothing nationally', async () => {
    const executed: ValidatedIntent[] = []
    const requests: ValidatedIntent[] = []
    renderAskPanel(executed, requests)
    await ask('What is the cheapest place to live in the Greater Boston area?')
    const text = container.textContent ?? ''
    expect(text).toContain('You named Greater Boston area.')
    expect(text).toContain('cannot place that area yet')
    expect(text).not.toContain('No place was named')
    expect(executed).toHaveLength(0)
    expect(requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Confirmed-region screen: the runner resolves the region to its
// county set (App path: resolution without the county index, the
// crosswalk completion inside compose), and the answer screens
// inside it alone.
// ---------------------------------------------------------------------------

const PLACES: PlaceSuggestion[] = [
  { displayName: 'San Francisco', censusName: 'San Francisco city', state: 'CA', isCity: true, zips: ['94110'] },
  { displayName: 'Oakland', censusName: 'Oakland city', state: 'CA', isCity: true, zips: ['94601'] },
  { displayName: 'Fairfield', censusName: 'Fairfield city', state: 'CA', isCity: true, zips: ['94533'] },
  { displayName: 'Santa Clara', censusName: 'Santa Clara city', state: 'CA', isCity: true, zips: ['95050'] },
  { displayName: 'Bridgeport', censusName: 'Bridgeport CDP', state: 'CA', isCity: true, zips: ['93517'] },
  { displayName: 'Corbin', censusName: 'Corbin city', state: 'KY', isCity: true, zips: ['40771'] },
  { displayName: 'Little Eagle', censusName: 'Little Eagle CDP', state: 'SD', isCity: true, zips: ['57639'] },
  { displayName: 'Seattle', censusName: 'Seattle city', state: 'WA', isCity: true, zips: ['98101'] },
  { displayName: 'Portland', censusName: 'Portland city', state: 'OR', isCity: true, zips: ['97205'] },
  { displayName: 'Austin', censusName: 'Austin city', state: 'TX', isCity: true, zips: ['73301'] },
]

const BY_ZIP = new Map<string, PlaceRecord>(
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
)
const PLACE_INDEX = new PlaceIndex(BY_ZIP, PLACES)

const COUNTY_GROUPS: { censusName: string; state: string; zips: string[] }[] = [
  { censusName: 'San Francisco County', state: 'CA', zips: ['94110'] },
  { censusName: 'Alameda County', state: 'CA', zips: ['94601'] },
  { censusName: 'Solano County', state: 'CA', zips: ['94533'] },
  { censusName: 'Santa Clara County', state: 'CA', zips: ['95050'] },
  { censusName: 'Contra Costa County', state: 'CA', zips: ['94549'] },
  { censusName: 'Marin County', state: 'CA', zips: ['94901'] },
  { censusName: 'Napa County', state: 'CA', zips: ['94558'] },
  { censusName: 'San Mateo County', state: 'CA', zips: ['94401'] },
  { censusName: 'Sonoma County', state: 'CA', zips: ['95401'] },
  { censusName: 'Mono County', state: 'CA', zips: ['93517'] },
]
const COUNTY_BY_ZIP = new Map<string, CountyRecord>(
  COUNTY_GROUPS.flatMap((group) =>
    group.zips.map(
      (zip) => [zip, { zip, censusName: group.censusName, state: group.state }] as const,
    ),
  ),
)
const COUNTY_INDEX = new CountyIndex(COUNTY_BY_ZIP, COUNTY_GROUPS)

const ROWS: AreaRow[] = [
  { zcta: '94110', name: 'ZCTA5 94110', metrics: { median_gross_rent: 2400 }, moes: { median_gross_rent: 120 } },
  { zcta: '94601', name: 'ZCTA5 94601', metrics: { median_gross_rent: 1650 }, moes: { median_gross_rent: 90 } },
  { zcta: '94533', name: 'ZCTA5 94533', metrics: { median_gross_rent: 1495 }, moes: { median_gross_rent: 80 } },
  { zcta: '95050', name: 'ZCTA5 95050', metrics: { median_gross_rent: 2300 }, moes: { median_gross_rent: 110 } },
  // In California but NOT in the region's counties: screens only if
  // the region widened to its state.
  { zcta: '93517', name: 'ZCTA5 93517', metrics: { median_gross_rent: 225 }, moes: { median_gross_rent: 92 } },
  // The national head of the defective answer: screens only if the
  // region widened to the whole country.
  { zcta: '40771', name: 'ZCTA5 40771', metrics: { median_gross_rent: 99 }, moes: { median_gross_rent: 18 } },
  { zcta: '57639', name: 'ZCTA5 57639', metrics: { median_gross_rent: 244 }, moes: { median_gross_rent: 122 } },
]

describe('confirmed-region screen (Bay Area traversal)', () => {
  const intent: ValidatedIntent = {
    mode: 'sweep_filter',
    geographies: ['San Francisco Bay Area'],
    metricKeys: ['median_gross_rent'],
    filters: [],
    clarificationNeeded: false,
  }

  it('resolves the region to exactly its counties’ ZIPs on the App path', async () => {
    // App path: the caller resolves with the place index alone; the
    // county crosswalk completes the region inside compose.
    const resolved = resolveAnswerGeographies(intent, PLACE_INDEX)
    expect(resolved.unresolvedGeographies).toEqual(['San Francisco Bay Area'])
    const answer = await composeAnswerForRequest({
      intent,
      queryText: OWNER_QUESTION,
      rows: ROWS,
      resolved,
      provider: createStubProvider(),
      research: false,
      placeIndex: PLACE_INDEX,
      countyIndex: COUNTY_INDEX,
    })
    expect(answer).not.toBeNull()
    const zctas = answer!.places.map((p) => p.zcta)
    expect(zctas.sort()).toEqual(['94110', '94533', '94601', '95050'].sort())
    expect(answer!.places[0]?.zcta).toBe('94533')
    expect(JSON.stringify(answer)).not.toContain('Corbin')
    expect(JSON.stringify(answer)).toContain('San Francisco Bay Area')
  })

  it('resolves the region at resolution time when the county index is in hand', () => {
    const resolved = resolveAnswerGeographies(intent, PLACE_INDEX, COUNTY_INDEX)
    expect(resolved.unresolvable).toBe(false)
    expect([...resolved.zctas].sort()).toEqual(
      ['94110', '94533', '94549', '94601', '94901', '94401', '94558', '95050', '95401'].sort(),
    )
    expect(
      resolved.geographyDisclosures.some((d) => d.includes('was read as the San Francisco Bay Area')),
    ).toBe(true)
  })

  it('leaves a county-precise region unresolved without the county index — never widened to its state', () => {
    const resolved = resolveAnswerGeographies(intent, PLACE_INDEX, null)
    expect(resolved.zctas.size).toBe(0)
    expect(resolved.unresolvedGeographies).toEqual(['San Francisco Bay Area'])
  })
})

describe('second region through the same path (Pacific Northwest)', () => {
  it('detects, interprets, and resolves as a state set', () => {
    expect(regionInterpretationFor('Pacific Northwest')?.states).toEqual(['WA', 'OR'])
    const intent: ValidatedIntent = {
      mode: 'sweep_filter',
      geographies: ['Pacific Northwest'],
      metricKeys: ['median_gross_rent'],
      filters: [],
      clarificationNeeded: false,
    }
    const resolved = resolveAnswerGeographies(intent, PLACE_INDEX)
    expect([...resolved.zctas].sort()).toEqual(['97205', '98101'])
    expect(
      resolved.geographyDisclosures.some((d) => d.includes('was read as the Pacific Northwest')),
    ).toBe(true)
  })
})
