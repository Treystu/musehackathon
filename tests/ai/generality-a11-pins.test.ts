import { describe, expect, it } from 'vitest'
import type { ComposedAnswer } from '../../src/core/ai/answer'
import {
  runSummaryText,
  terminalEntryCount,
  type RunProgressSnapshot,
} from '../../src/core/ai/run-progress'

/**
 * Lane A11 generality pins (phase 4). Fixtures are the live
 * re-verification sheet's verbatim specimens (production 44f90ff,
 * 2026-11-03 07:00-07:49 HST): the COMPLETE strip's counts against
 * the cards they summarized, the Oregon/Montana resolution misses,
 * and the fragment tokens the unmatched line printed as names.
 * Assertions grow per cure cluster; each cluster's commit names
 * the assertions it added.
 */

function snapshot(partial: Partial<RunProgressSnapshot>): RunProgressSnapshot {
  return {
    doneUnits: 1,
    totalUnits: 1,
    criteriaTotal: 1,
    criteriaDone: ['Outside-Census criteria'],
    criteriaFailed: [],
    places: [],
    ...partial,
  }
}

function interimPlaces(count: number): RunProgressSnapshot['places'] {
  return Array.from({ length: count }, (_, i) => ({
    name: `Interim ${i + 1}`,
    zcta: `9000${i}`,
    verdicts: [],
  }))
}

/* ------------------------------------------------------------------ */
/* FM-22 — the COMPLETE strip counts the terminal card's entries       */
/* ------------------------------------------------------------------ */

describe('FM-22 run summary terminal count', () => {
  it('Florida weather specimen: snapshot 3, card 4 — the strip reads the card', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(3) }), 4)).toBe(
      'Complete — 1 of 1 checks done · 4 places assessed',
    )
  })

  it('Montana hiking specimen: snapshot 1, card 3 — the strip reads the card', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(1) }), 3)).toBe(
      'Complete — 1 of 1 checks done · 3 places assessed',
    )
  })

  it('Colorado specimen: snapshot 3, card 5 — the strip reads the card', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(3) }), 5)).toBe(
      'Complete — 1 of 1 checks done · 5 places assessed',
    )
  })

  it('Texas specimen: snapshot 1, card 1 — the consistent case is unchanged', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(1) }), 1)).toBe(
      'Complete — 1 of 1 checks done · 1 place assessed',
    )
  })

  it('a note terminal (0 entries) renders no places clause, however many interim candidates waited', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(2) }), 0)).toBe(
      'Complete — 1 of 1 checks done',
    )
  })

  it('the criteria-done guard survives: a total-failure card claims no assessed places', () => {
    expect(
      runSummaryText(
        snapshot({ places: interimPlaces(2), criteriaDone: [], criteriaFailed: ['Outside-Census criteria'] }),
        2,
      ),
    ).toBe('Complete — 1 of 1 checks done · 1 lookup did not return')
  })

  it('without a terminal count the snapshot count remains the fallback', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(2) }))).toBe(
      'Complete — 1 of 1 checks done · 2 places assessed',
    )
  })
})

describe('FM-22 terminal entry count', () => {
  const place = (name: string) => ({ zcta: '00000', name, figures: [], claims: [] })

  it('counts the composed places of a strict answer', () => {
    const answer = {
      status: 'verified',
      places: [place('A'), place('B'), place('C')],
    } as unknown as ComposedAnswer
    expect(terminalEntryCount(answer)).toBe(3)
  })

  it('counts the flexible completion places on a flexible terminal, not the empty strict set', () => {
    const answer = {
      status: 'flexible',
      places: [],
      flexible: {
        prose: 'p',
        figures: [],
        places: [
          { name: 'X', evidenceClass: 'research_named', figures: [] },
          { name: 'Y', evidenceClass: 'model_knowledge', figures: [] },
        ],
      },
    } as unknown as ComposedAnswer
    expect(terminalEntryCount(answer)).toBe(2)
  })

  it('a flexible status without a completion falls back to the composed places', () => {
    const answer = {
      status: 'flexible',
      places: [place('A')],
    } as unknown as ComposedAnswer
    expect(terminalEntryCount(answer)).toBe(1)
  })
})
