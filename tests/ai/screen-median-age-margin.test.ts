import { describe, expect, it } from 'vitest'
import { areaRowFromRaw, SCREEN_VARS, VARS } from '../../src/core/plugins/acs'
import { SWEEP_VERSION } from '../../src/core/sweep/runSweep'

/**
 * The screen must carry the median-age margin (cure round 3, defect
 * 3). Median age is a rank-legal Ask measure (FM-9 ruling), so a
 * ranked median-age answer is a first-class screen terminal — and a
 * screen row without the figure's margin renders a bare point
 * estimate, which is what the 2026-11-03 live probe read on
 * production: a whole-country median-age screen with no margins and
 * no verified framing. B01002_001M is published in the ACS 2023
 * 5-year variables registry (checked 2026-11-03); the detail fetch
 * has always requested it. These pins hold the screen to the same
 * standard.
 */
describe('the national screen carries the median-age margin', () => {
  it('SCREEN_VARS requests the published median-age margin variable', () => {
    expect(SCREEN_VARS).toContain(VARS.medianAge.replace(/E$/, 'M'))
    expect(VARS.medianAge.replace(/E$/, 'M')).toBe('B01002_001M')
  })

  it('a screen-shaped response lands the margin on the row', () => {
    const header = ['NAME', VARS.medianAge, VARS.medianAge.replace(/E$/, 'M'), 'zip code tabulation area']
    const rows = areaRowFromRaw(header, [
      ['ZCTA5 63880', '2', '1', '63880'],
      ['ZCTA5 96720', '40', '2', '96720'],
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]!.metrics.median_age).toBe(2)
    expect(rows[0]!.moes.median_age).toBe(1)
    expect(rows[1]!.metrics.median_age).toBe(40)
    expect(rows[1]!.moes.median_age).toBe(2)
  })
})

/**
 * The variable set and the sweep cache stamp move together (cure
 * round 5, 2026-11-03). The two pins above hold for a FRESH fetch —
 * but a returning visitor's rows come from the versioned chunk
 * cache, and a cache hit bypasses fetch and parse entirely. Round
 * 3 added B01002_001M to SCREEN_VARS without moving SWEEP_VERSION
 * off 'acs5:2023:screen:v7-honest-labels', so chunks a pre-round-3
 * build had parsed and stored under v7 — rows in which the
 * median-age margin column simply does not exist — kept being
 * served verbatim to every later build. Measured live on
 * production eab3d37 (2026-11-03 20:48–20:53 HST): the ranked
 * state answer showed bare integers on all 52 state cards in a
 * browser holding v7 chunks, while a fresh session on the same
 * build rendered "± approx." margins. The cache layer's own
 * contract (src/core/cache.ts: "Change the vintage or the
 * variable set and the bump invalidates every chunk at once") is
 * what this pin enforces: while the screen requests a variable
 * the v7 fetch did not, the stamp must not be v7's.
 */
describe('the margin variable and the sweep cache stamp move together', () => {
  it('the stamp is not the one margin-less chunks were cached under', () => {
    expect(SCREEN_VARS).toContain(VARS.medianAge.replace(/E$/, 'M'))
    expect(SWEEP_VERSION).not.toBe('acs5:2023:screen:v7-honest-labels')
    expect(SWEEP_VERSION).toMatch(/:v8-/)
  })
})
