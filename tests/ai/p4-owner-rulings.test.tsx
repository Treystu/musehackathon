// @vitest-environment jsdom
/**
 * P4 owner UI rulings (2026-11-02, battery findings register F-B..F-E),
 * pinned. Each describe names the ruling it pins:
 *  - F-D no default areas: surfaces start empty, with an inviting
 *    empty state; no standing Hilo 96720 / East Honolulu 96821
 *    selection exists in the surfaces' source, and clarification
 *    candidates against a truly empty initial selection carry no
 *    stale places.
 *  - F-E agent setup out: the Ask surface renders no setup/key
 *    affordance; the capability's mount is Methodology.
 *  - F-B string hygiene: rendered labels (visible text + accessible
 *    names) on the owned surfaces never match the internal-key
 *    pattern — the 15 registry measure keys, snake_case generally,
 *    or a raw mode string.
 *  - F-C run-with-default: "Use these choices" with a geography and
 *    no measure runs on the domain default measure; every other
 *    incomplete state disables the button with a one-line hint.
 *  - F-B-ANSWER-CARD (P4b, 2026-11-02): the AnswerCard criterion
 *    evidence list — outside the original F-B sweep — rendered the
 *    raw measure key; a full card (screened, dropped, and county
 *    shapes) now renders only plain labels, including the compose
 *    summary's "Not measured here:" line, while the stored criterion
 *    value stays the key for the consumers that match on it.
 *  - F-E residual (P4b): the credits_exhausted Ask state showed
 *    ByoOffer own-key text; it now shows the honest exhausted note
 *    only.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { METRIC_DEFS } from '../../src/core/civicscope-registry'
import { DISPLAYABLE_KEYS } from '../../src/core/ai/intent-schema'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { decodeUrl } from '../../src/core/url-state'
import {
  criterionEvidenceFor,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import type { AreaRow } from '../../src/core/plugins/acs'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import { AskPanel, clarificationCandidatesFor } from '../../src/ui/ai/AskPanel'
import { ClarificationPanel } from '../../src/ui/ai/ClarificationPanel'
import { IntentChips } from '../../src/ui/ai/IntentChips'
import { IntentEditor } from '../../src/ui/ai/IntentEditor'
import { Comparison } from '../../src/ui/Comparison'
import { Methodology } from '../../src/ui/Methodology'
import { SavedSearches } from '../../src/ui/SavedSearches'

const ALL_MEASURE_KEYS = METRIC_DEFS.map((d) => d.key)
const RAW_MODES = ['lookup', 'compare', 'sweep_filter', 'similarity'] as const
const SNAKE_CASE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

async function flush() {
  await act(async () => {})
}

/** Everything a reader or a screen reader can perceive as a label. */
function renderedLabels(): string {
  const aria = [...container.querySelectorAll('[aria-label]')]
    .map((el) => el.getAttribute('aria-label') ?? '')
    .join('\n')
  return `${container.textContent ?? ''}\n${aria}`
}

function expectNoInternalLabels(text: string) {
  for (const key of ALL_MEASURE_KEYS) {
    expect(text, `rendered label must not be the internal key ${key}`).not.toContain(key)
  }
  for (const mode of RAW_MODES) {
    expect(text, `rendered label must not be the raw mode ${mode}`).not.toContain(mode)
  }
  expect(text, 'rendered labels must carry no snake_case token').not.toMatch(SNAKE_CASE_RE)
}

const clarifying: ValidatedIntent = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

describe('F-B string hygiene: no internal keys in rendered labels', () => {
  it('the register count is the 15 shipped measure keys', () => {
    expect(ALL_MEASURE_KEYS).toHaveLength(15)
    expect([...DISPLAYABLE_KEYS].sort()).toEqual([...ALL_MEASURE_KEYS].sort())
  })

  it('IntentChips renders a plain mode label and plain measure labels for every mode', () => {
    for (const mode of RAW_MODES) {
      render(
        <IntentChips
          intent={{
            mode,
            geographies: ['Hilo'],
            metricKeys: [...ALL_MEASURE_KEYS],
            filters: [{ metricKey: 'median_gross_rent', op: 'gt', value: 2000 }],
            clarificationNeeded: false,
          }}
          onChange={() => {}}
        />,
      )
      const text = renderedLabels()
      expectNoInternalLabels(text)
      expect(text).toContain('Median gross rent')
      expect(text).toContain('Median age')
      expect(text).toContain('greater than 2000')
    }
    render(
      <IntentChips
        intent={{ ...clarifying, mode: 'sweep_filter', geographies: ['HI'] }}
        onChange={() => {}}
      />,
    )
    expect(renderedLabels()).toContain('Screen places')
  })

  it('the clarification panel renders every measure candidate under its plain label', () => {
    render(
      <ClarificationPanel
        intent={clarifying}
        candidates={{ geographies: [], metricKeys: [...ALL_MEASURE_KEYS] }}
        onResolve={() => {}}
      />,
    )
    const text = renderedLabels()
    expectNoInternalLabels(text)
    for (const def of METRIC_DEFS) {
      expect(text, `plain label for ${def.key}`).toContain(def.label)
    }
  })

  it('the intent editor renders its measure options under plain labels', () => {
    render(
      <IntentEditor
        intent={{
          mode: 'lookup',
          geographies: ['Hilo'],
          metricKeys: ['median_gross_rent'],
          filters: [],
          clarificationNeeded: false,
        }}
        onChange={() => {}}
      />,
    )
    const text = renderedLabels()
    expectNoInternalLabels(text)
    expect(text).toContain('Median gross rent')
    expect(text).toContain('Households with no internet access')
  })
})

describe('F-E agent setup out of the judged flow', () => {
  it('the Ask surface renders no setup or key affordance', async () => {
    render(<AskPanel provider={createStubProvider()} />)
    await flush()
    const text = renderedLabels()
    expect(text).not.toContain('Set up with your agent')
    expect(text).not.toContain('only if you want your own keys')
    expect(text).not.toContain('Continue manually instead')
    expect(text).not.toContain('Key setup status')
  })

  it('the setup capability stays reachable from Methodology', async () => {
    render(<Methodology />)
    await flush()
    expect(renderedLabels()).toContain('Set up with your agent')
  })

  it('the credits_exhausted Ask state shows the honest exhausted note and no own-key content (F-E residual)', async () => {
    render(<AskPanel provider={createStubProvider()} proxyError="credits_exhausted" />)
    await flush()
    const text = renderedLabels()
    expect(text).toContain('The shared allowance for the helper is used up for now')
    expect(text).not.toContain('your own Meta key')
    expect(text).not.toContain('add it in settings')
    expect(text).not.toContain('Open key settings')
    expect(container.querySelector('aside[aria-label="Optional personal key"]')).toBeNull()
  })
})

describe('F-D no default areas', () => {
  it('the comparison renders an inviting empty state, not a standing selection', () => {
    render(<Comparison drilldowns={{}} onDeselect={() => {}} />)
    const text = renderedLabels()
    expect(text).toContain('No areas selected yet')
    expect(text).not.toContain('Hilo')
    expect(text).not.toContain('East Honolulu')
    expect(text).not.toContain('96720')
    expect(text).not.toContain('96821')
  })

  it('saved comparisons render their empty state and restore nothing on their own', () => {
    const onRestore = vi.fn()
    render(<SavedSearches selectedZctas={[]} onRestore={onRestore} />)
    expect(renderedLabels()).toContain('Nothing saved yet')
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('no standing Hilo / East Honolulu selection exists in the audited surfaces', () => {
    // The audit set for the standing-selection class (step 1): the
    // comparison, saved-view restore, URL restore, map state, and
    // the selection state itself. Each was read for a hard-coded
    // area; the two ZIP codes of the owner's live finding appear in
    // none of them.
    const audited = [
      'src/ui/App.tsx',
      'src/ui/Comparison.tsx',
      'src/ui/SavedSearches.tsx',
      'src/ui/MapView.tsx',
      'src/core/useHousingQuery.ts',
      'src/core/url-state.ts',
      'src/core/saved-searches.ts',
    ]
    for (const file of audited) {
      const source = readFileSync(join(__dirname, '..', '..', file), 'utf8')
      expect(source, `${file} must carry no standing 96720 selection`).not.toContain('96720')
      expect(source, `${file} must carry no standing 96821 selection`).not.toContain('96821')
    }
    // URL restore is clean of the class: a bare URL names no areas,
    // so arrival selects nothing; only a link that itself names ZIP
    // codes restores those codes.
    expect(decodeUrl('https://civicscope.example/')).toEqual([])
    expect(decodeUrl('https://civicscope.example/?z=96720')).toEqual(['96720'])
  })

  it('clarification candidates against a truly empty selection carry no stale places', () => {
    const candidates = clarificationCandidatesFor(clarifying, [...DISPLAYABLE_KEYS])
    expect(candidates.geographies).toEqual([])
    render(
      <ClarificationPanel intent={clarifying} candidates={candidates} onResolve={() => {}} />,
    )
    const text = renderedLabels()
    expect(text).toContain('No candidate places for this request')
    expect(text).not.toContain('Hilo')
    expect(text).not.toContain('East Honolulu')
  })
})

describe('F-C run-with-default', () => {
  function useTheseChoicesButton(): HTMLButtonElement {
    const btn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Use these choices',
    )
    if (!btn) throw new Error('Use these choices button not found')
    return btn as HTMLButtonElement
  }

  it('a geography with no measure runs on the domain default measure', async () => {
    const onResolve = vi.fn()
    render(
      <ClarificationPanel
        intent={{ ...clarifying, geographies: ['Anchorage, AK'] }}
        candidates={{ geographies: [], metricKeys: [...DISPLAYABLE_KEYS] }}
        onResolve={onResolve}
      />,
    )
    await flush()
    const text = renderedLabels()
    // The default is disclosed before anything runs, in plain words.
    expect(text).toContain('median gross rent')
    const btn = useTheseChoicesButton()
    expect(btn.disabled).toBe(false)
    act(() => btn.click())
    expect(onResolve).toHaveBeenCalledTimes(1)
    const resolved = onResolve.mock.calls[0]![0] as ValidatedIntent
    expect(resolved.geographies).toEqual(['Anchorage, AK'])
    expect(resolved.metricKeys).toEqual(['median_gross_rent'])
    expect(resolved.clarificationNeeded).toBe(false)
  })

  it('a placed sweep with no measure also runs on the default', async () => {
    const onResolve = vi.fn()
    render(
      <ClarificationPanel
        intent={{ ...clarifying, mode: 'sweep_filter', geographies: ['AK'] }}
        candidates={{ geographies: [], metricKeys: [...DISPLAYABLE_KEYS] }}
        onResolve={onResolve}
      />,
    )
    await flush()
    const btn = useTheseChoicesButton()
    expect(btn.disabled).toBe(false)
    act(() => btn.click())
    expect(onResolve).toHaveBeenCalledTimes(1)
    const resolved = onResolve.mock.calls[0]![0] as ValidatedIntent
    expect(resolved.metricKeys).toEqual(['median_gross_rent'])
  })

  it('no place and no measure disables the button with a one-line hint', async () => {
    render(
      <ClarificationPanel
        intent={clarifying}
        candidates={{ geographies: [], metricKeys: [...DISPLAYABLE_KEYS] }}
        onResolve={() => {}}
      />,
    )
    await flush()
    expect(useTheseChoicesButton().disabled).toBe(true)
    expect(renderedLabels()).toContain(
      'Pick a place and a measure, or a measure on its own to screen the whole country.',
    )
  })

  it('a one-place comparison stays disabled with its hint, default notwithstanding', async () => {
    render(
      <ClarificationPanel
        intent={{ ...clarifying, mode: 'compare', geographies: ['Anchorage, AK'] }}
        candidates={{ geographies: [], metricKeys: [...DISPLAYABLE_KEYS] }}
        onResolve={() => {}}
      />,
    )
    await flush()
    expect(useTheseChoicesButton().disabled).toBe(true)
    expect(renderedLabels()).toContain('Comparing needs two places')
  })
})

describe('F-B-ANSWER-CARD: the AnswerCard criterion evidence renders plain labels only', () => {
  const HI_ROWS: AreaRow[] = [
    {
      zcta: '96720',
      name: 'Hilo, HI',
      metrics: { median_gross_rent: 1450, median_home_value: 440000, households: 14000 },
      moes: { median_gross_rent: 85, median_home_value: 25000, households: 420 },
    },
    {
      zcta: '96749',
      name: 'Keaau, HI',
      metrics: { median_gross_rent: 1325, median_home_value: 385000, households: 5200 },
      moes: { median_gross_rent: 120, median_home_value: 31000, households: 260 },
    },
    {
      zcta: '96778',
      name: 'Pahoa, HI',
      metrics: { median_gross_rent: 1750, median_home_value: 340000, households: 6100 },
      moes: { median_gross_rent: 150, median_home_value: 28000, households: 300 },
    },
  ]

  const sweepIntent = (partial: Partial<ValidatedIntent>): ValidatedIntent => ({
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: ['median_gross_rent'],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  })

  it('screened shape: census evidence renders the plain label, a research label renders unchanged', async () => {
    const provider = createStubProvider({
      async research() {
        return {
          prose: 'Hilo, HI has two elementary schools within the district.',
          sources: [{ title: 'Hawaii DOE', url: 'https://example.org/doe' }],
        }
      },
    })
    const answer = await runAnswerPipeline({
      intent: sweepIntent({
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
      }),
      rows: HI_ROWS,
      researchQuery: 'places under the rent bound with elementary schools nearby',
      provider,
    })
    expect(answer.status).toBe('verified')
    // Seam pin: the STORED census criterion stays the metric key —
    // spoken-answer.ts matches it against verified figure keys, so
    // the cure is at render, not at construction.
    expect(
      answer.criterionEvidence.find((e) => e.kind === 'census')?.criterion,
    ).toBe('median_gross_rent')
    render(<AnswerCard answer={answer} />)
    const text = renderedLabels()
    expectNoInternalLabels(text)
    expect(text).toContain('Median gross rent')
    expect(text).toContain('measured.')
    // Research-worded criteria (the reader's own catalog label)
    // render exactly as stored.
    expect(text).toContain('School quality')
  })

  it('dropped shape: the dropped entry and the summary "Not measured here:" line are plain', async () => {
    const answer = await runAnswerPipeline({
      intent: sweepIntent({
        filters: [
          { metricKey: 'median_gross_rent', op: 'gt', value: 500 },
          { metricKey: 'median_gross_rent', op: 'lt', value: 1500 },
        ],
      }),
      rows: HI_ROWS,
      provider: createStubProvider(),
    })
    expect(answer.status).toBe('verified')
    expect(answer.droppedCriteria).toHaveLength(1)
    // The summary is prose composed in answer.ts and rendered
    // verbatim everywhere, so its label is plain at composition.
    expect(answer.summary).toContain('Not measured here: Median gross rent.')
    expect(answer.summary).not.toContain('median_gross_rent')
    render(<AnswerCard answer={answer} />)
    const text = renderedLabels()
    expectNoInternalLabels(text)
    expect(text).toContain('Not measured here: Median gross rent.')
    expect(text).toContain('not measurable from available sources.')
  })

  it('county shape: the county entries render plain, including a not-measurable county figure entry', async () => {
    const rows: AreaRow[] = [
      {
        zcta: '80301',
        name: 'ZCTA5 80301',
        metrics: { median_gross_rent: 1800, population: 30000, households: 12000 },
        moes: { median_gross_rent: 100, households: 300 },
      },
      {
        zcta: '80302',
        name: 'ZCTA5 80302',
        metrics: { median_gross_rent: 1600, population: 10000, households: 4000 },
        moes: { median_gross_rent: 80, households: 200 },
      },
      {
        zcta: '80202',
        name: 'ZCTA5 80202',
        metrics: { median_gross_rent: 1500, population: 20000, households: 9000 },
        moes: { median_gross_rent: 60, households: 250 },
      },
      {
        zcta: '80203',
        name: 'ZCTA5 80203',
        metrics: { median_gross_rent: 1700, population: 20000, households: 9500 },
        moes: { median_gross_rent: 60, households: 250 },
      },
    ]
    const answer = await runAnswerPipeline({
      intent: sweepIntent({ geographies: ['CO'] }),
      rows,
      geographyZctas: new Set(rows.map((r) => r.zcta)),
      queryText: 'Which county in Colorado has the lowest median rent?',
      countyAssignments: new Map([
        ['80301', { name: 'Boulder County', state: 'CO' }],
        ['80302', { name: 'Boulder County', state: 'CO' }],
        ['80202', { name: 'Denver County', state: 'CO' }],
        ['80203', { name: 'Denver County', state: 'CO' }],
      ]),
    })
    expect(answer.status).toBe('verified')
    expect(answer.countyMethod).not.toBeNull()
    // The county-figure entry's stored value is the raw rank key,
    // passed through verbatim at its construction seam
    // (criterionEvidenceFor's countyFigureNotMeasurable input, fed
    // from the pipeline's rank key) — build that entry through the
    // seam and render it on the real county answer.
    const countyFigureEntry = criterionEvidenceFor({
      criteria: [],
      droppedCriteria: [],
      researchCriteria: [],
      places: answer.places,
      claims: [],
      unsupportedGeography: null,
      countySupported: true,
      countyFigureNotMeasurable: 'median_age',
    }).find((e) => e.criterion === 'median_age')
    expect(countyFigureEntry?.status).toBe('not_measurable')
    const withCountyFigure: ComposedAnswer = {
      ...answer,
      criterionEvidence: [...answer.criterionEvidence, countyFigureEntry!],
    }
    render(<AnswerCard answer={withCountyFigure} />)
    const text = renderedLabels()
    // The internal-key pattern here is the snake_case form: every
    // multi-word measure key must be absent, and no snake_case token
    // may appear. The full substring helper cannot run on this shape
    // because the county method statement legitimately uses the
    // English word "population-weighted" — "population" is a
    // single-word key and an ordinary word, not an identifier leak.
    for (const key of ALL_MEASURE_KEYS.filter((k) => k.includes('_'))) {
      expect(text, `rendered label must not be the internal key ${key}`).not.toContain(key)
    }
    expect(text, 'rendered labels must carry no snake_case token').not.toMatch(SNAKE_CASE_RE)
    expect(text).toContain('County-level geography')
    expect(text).toContain('Median age')
    expect(text).toContain('not measurable from available sources.')
  })
})
