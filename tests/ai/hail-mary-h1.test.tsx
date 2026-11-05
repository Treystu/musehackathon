// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAnswerPipeline } from '../../src/core/ai/answer'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider } from '../../src/core/ai/provider'
import {
  AnswerCard,
  ANSWER_MAP_DISCLOSURE_LABEL,
  ASK_DATA_DISCLOSURE_LABEL,
} from '../../src/ui/ai/AnswerCard'

function makeRows(n: number): AreaRow[] {
  const rows: AreaRow[] = []
  for (let i = 0; i < n; i++) {
    rows.push({
      zcta: `967${String(10 + i).padStart(2, '0')}`,
      name: `Town ${i}, HI`,
      metrics: { median_gross_rent: 1200 + i * 10, households: 5000 + i },
      moes: { median_gross_rent: 50, households: 100 },
    })
  }
  return rows
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

describe('H1 answer-only Ask view', () => {
  it('labels name the expansions', () => {
    expect(ANSWER_MAP_DISCLOSURE_LABEL).toBe('Show the map')
    expect(ASK_DATA_DISCLOSURE_LABEL).toBe('Explore the full results')
  })

  it('overflow copy names the expansion, not the table below', async () => {
    const provider = createStubProvider({ async research() { return { prose: '', sources: [] } } })
    const answer = await runAnswerPipeline({
      intent: {
        mode: 'sweep_filter',
        geographies: [],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      },
      rows: makeRows(12),
      researchQuery: '',
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.length).toBeGreaterThan(10)
    render(<AnswerCard answer={answer} />)
    const text = container.textContent ?? ''
    expect(text).toContain("open 'Explore the full results' to see them")
    expect(text).not.toContain('screening table below')
  })

  it('map mounts collapsed with no paths, expansion reveals', async () => {
    const provider = createStubProvider({ async research() { return { prose: '', sources: [] } } })
    const answer = await runAnswerPipeline({
      intent: {
        mode: 'sweep_filter',
        geographies: [],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      },
      rows: makeRows(3),
      researchQuery: '',
      provider,
    })
    expect(answer.status).toBe('verified')
    render(<AnswerCard answer={answer} />)
    const details = container.querySelector('details')
    expect(details).not.toBeNull()
    expect(details?.querySelector('summary')?.textContent).toContain('Show the map')
    expect(details?.open).toBe(false)
    // No map geometry mounted while collapsed.
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelectorAll('path').length).toBe(0)
    // Expand: the disclosure opens and the map surface mounts (loading state,
    // geometry loads async and is not required for the reveal pin).
    await act(async () => {
      details!.open = true
      details!.dispatchEvent(new Event('toggle'))
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(details?.open).toBe(true)
    const after = container.textContent ?? ''
    expect(after).toContain('Show the map')
    // The map block mounted: loading line or failure line or legend text.
    const mounted =
      container.querySelector('svg') !== null ||
      after.includes('Loading the map') ||
      after.includes('could not be loaded') ||
      after.includes('Darker means')
    expect(mounted).toBe(true)
  })
})
