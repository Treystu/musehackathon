import { describe, expect, it } from 'vitest'
import { areaRowFromRaw, SCREEN_VARS, VARS } from '../../src/core/plugins/acs'

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
