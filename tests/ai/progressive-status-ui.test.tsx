// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StagedStatus } from '../../src/ui/ai/StagedStatus'
import { AskSessionStore } from '../../src/ui/ai/session-store'
import type { RunProgressSnapshot } from '../../src/core/ai/run-progress'

/**
 * Lane A7 staged-status pins: the progress block under the stage
 * line is visual only — the bar's value is the snapshot's pass
 * fraction, the situational line is the gathered-so-far text plus
 * the ~30s elapsed clause once the current stage is that old, and
 * the aria-live region's text remains the stage label and nothing
 * else at every point (the tick and the progress updates never
 * rewrite it). Shapes with no snapshot show no bar; their
 * situational line is the elapsed clause alone, from ~30s.
 */

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

const progressLine = () => container.querySelector('[data-testid="staged-progress-line"]')
const progressBar = () => container.querySelector('[data-testid="staged-progress-bar"]')
const liveText = () => container.querySelector('[data-testid="staged-status-live"]')?.textContent

const SNAPSHOT: RunProgressSnapshot = {
  doneUnits: 1,
  totalUnits: 2,
  criteriaTotal: 2,
  criteriaDone: ['School quality'],
  criteriaFailed: [],
  places: [
    { name: 'Hilo, HI', zcta: '96720', verdicts: [{ criterion: 'School quality', state: 'served' }] },
    { name: 'Keaau, HI', zcta: '96749', verdicts: [{ criterion: 'School quality', state: 'not-served' }] },
  ],
}

describe('the progress block', () => {
  it('renders the pass fraction and the gathered-so-far line, live region untouched', () => {
    let now = 1_000
    const store = new AskSessionStore(() => now)
    const token = store.beginStageRun()
    store.setStage(token, 'researching', 'School quality')
    store.setStageProgress(token, SNAPSHOT)
    now = 3_000 // past the 1-second rule; the stage is seconds old
    render(<StagedStatus session={store} ack="Let me look into that." />)
    expect(progressBar()?.getAttribute('aria-valuenow')).toBe('50')
    expect(progressLine()?.textContent).toBe('1 of 2 checks done · 2 places named so far')
    expect(liveText()).toBe('Researching School quality')
    // FM-13: the percent is also a visible figure beside the bar —
    // the bar alone carried it only in width and aria.
    expect(container.querySelector('[data-testid="staged-progress-percent"]')?.textContent).toBe('50%')
  })

  it('a no-total snapshot (the flexible shape) shows no bar and no percent, counts intact', () => {
    // The A7 contract: shapes with no honest percent show no bar.
    // After the FM-13 flexible takeover the strict snapshot is
    // re-issued with its total nulled — the counts it carries are
    // true and keep rendering; only the bar and percent go.
    let now = 1_000
    const store = new AskSessionStore(() => now)
    const token = store.beginStageRun()
    store.setStage(token, 'researching', 'School quality')
    store.setStageProgress(token, { ...SNAPSHOT, totalUnits: null })
    now = 3_000
    render(<StagedStatus session={store} ack="Let me look into that." />)
    expect(progressBar()).toBeNull()
    expect(container.querySelector('[data-testid="staged-progress-percent"]')).toBeNull()
    expect(progressLine()?.textContent).toBe('1 of 2 checks done · 2 places named so far')
  })

  it('joins the elapsed clause once the stage is ~30s old, still outside the live region', () => {
    let now = 1_000
    const store = new AskSessionStore(() => now)
    const token = store.beginStageRun()
    store.setStage(token, 'researching', 'School quality')
    store.setStageProgress(token, SNAPSHOT)
    render(<StagedStatus session={store} ack="Let me look into that." />)
    now = 46_000
    // A store emission re-renders, as a pass boundary does in a run.
    act(() => store.setStageProgress(token, { ...SNAPSHOT, doneUnits: 2, criteriaDone: ['School quality', 'Coffee nearby'] }))
    expect(progressBar()?.getAttribute('aria-valuenow')).toBe('100')
    expect(progressLine()?.textContent).toBe(
      '2 of 2 checks done · 2 places named so far · about half a minute in',
    )
    expect(liveText()).toBe('Researching School quality')
  })

  it('without a snapshot there is no bar and no line before ~30s', () => {
    let now = 1_000
    const store = new AskSessionStore(() => now)
    const token = store.beginStageRun()
    store.setStage(token, 'researching', 'School quality')
    now = 20_000
    render(<StagedStatus session={store} ack="Let me look into that." />)
    expect(progressBar()).toBeNull()
    expect(progressLine()).toBeNull()
    expect(liveText()).toBe('Researching School quality')
  })

  it('without a snapshot the line is the elapsed clause alone from ~30s', () => {
    let now = 1_000
    const store = new AskSessionStore(() => now)
    const token = store.beginStageRun()
    store.setStage(token, 'researching', 'School quality')
    now = 66_000
    render(<StagedStatus session={store} ack="Let me look into that." />)
    expect(progressBar()).toBeNull()
    expect(progressLine()?.textContent).toBe('about a minute in')
    expect(liveText()).toBe('Researching School quality')
  })
})
