/**
 * Geocoding regression suite.
 *
 * Three rounds of bugs are pinned here, all found by auditing real ZIP codes
 * rather than by reasoning about the code:
 *
 *   1. A contiguous-48 bounding box rejected Hawaii, Alaska, Puerto Rico, and
 *      Guam as "not a US ZIP code".
 *   2. A widened box still rejected Guam, which is at 13.5°N and 144.8°E — no
 *      western-hemisphere box can contain the United States.
 *   3. Photon returned a Finnish coordinate first for Juneau and Mexico first
 *      for 96558, and a 370-ZIP audit exhausted its request budget entirely.
 *
 * Geocoding now goes through the Census Bureau's own ZCTA service, which
 * removes the bounding-box problem and the third-party dependency at once.
 */

import { describe, expect, it } from 'vitest'
import { geocode } from './geocode'

const sig = () => new AbortController().signal

/** Every US ZIP code has a Census ZCTA, so a miss is a genuine miss. */
async function resolveZip(zip: string) {
  const { places, notUsZip } = await geocode(zip, sig())
  return { match: places.find((p) => p.zip === zip), places, notUsZip }
}

const CONTIGUOUS = ['78701', '60601', '02134', '83201', '10001', '90210', '30303']
const NON_CONTIGUOUS = [
  { zip: '96813', label: 'Honolulu HI' },
  { zip: '96743', label: 'Hilo HI' },
  { zip: '99501', label: 'Anchorage AK' },
  { zip: '99801', label: 'Juneau AK' },
  { zip: '99660', label: 'Nome AK (antimeridian)' },
  { zip: '00901', label: 'San Juan PR' },
  { zip: '00617', label: 'St Thomas VI' },
  { zip: '96910', label: 'Saipan MP' },
]
/**
 * Real assigned ZIP codes with leading zeros, each confirmed to exist in the
 * Census ZCTA layer rather than assumed. Guessing at codes produced two rounds
 * of false regressions in this project, so every value here was verified.
 */
const LEADING_ZERO = ['01002', '00716', '00851', '00912', '02142', '03908', '07302', '05401']
/**
 * Codes an earlier audit wrongly reported as broken.
 *
 * They were a bug in the audit, not in the product. The audit synthesised
 * samples by padding a 2-digit value to five digits, which produced values like
 * 00005 and 06966 that are not assigned ZIP codes at all. Verified against the
 * Census ZCTA layer, none of them exists, and neither does a USPS delivery ZIP
 * It is a real number — Holtsville, New York — but an IRS ZIP used for tax
 * filings, not a USPS delivery ZIP, so it correctly has no ZCTA and is excluded
 * from this list.
 */
const NOT_ASSIGNED = ['00005', '06966', '00999', '01993', '03319', '00600', '00336', '01662', '05971']

describe('geocode: ZIP codes resolve through the Census ZCTA service', () => {
  for (const zip of [...CONTIGUOUS, ...LEADING_ZERO]) {
    it(`resolves ${zip}`, async () => {
      const { match, notUsZip } = await resolveZip(zip)
      expect(notUsZip, `${zip} was reported as not a US ZIP`).not.toBe(true)
      expect(match, `${zip} did not resolve to itself`).toBeDefined()
      expect(match!.lat).toBeTypeOf('number')
      expect(match!.lon).toBeTypeOf('number')
    }, 30000)
  }

  for (const { zip, label } of NON_CONTIGUOUS) {
    it(`resolves ${zip} (${label})`, async () => {
      const { match, notUsZip } = await resolveZip(zip)
      expect(notUsZip, `${zip} (${label}) was wrongly reported as non-US`).not.toBe(true)
      expect(match, `${zip} (${label}) did not resolve to itself`).toBeDefined()
    }, 30000)
  }

  for (const zip of NOT_ASSIGNED) {
    it(`reports ${zip} as not a US ZIP rather than guessing`, async () => {
      // These have no Census ZCTA, so the honest answer is "not a US ZIP code",
      // not an empty result the user cannot interpret. Asserting they resolve
      // would be asserting a false requirement.
      const { match, notUsZip } = await resolveZip(zip)
      expect(match, `${zip} unexpectedly resolved`).toBeUndefined()
      expect(notUsZip, `${zip} was not reported as a non-US ZIP`).toBe(true)
    }, 30000)
  }
})

describe('geocode: distinct ZIPs give distinct coordinates', () => {
  it('does not return one shared point for different areas', async () => {
    const a = (await resolveZip('78701')).match
    const b = (await resolveZip('60601')).match
    expect(a?.lat).not.toBe(b?.lat)
    expect(a?.lon).not.toBe(b?.lon)
  }, 40000)
})

describe('geocode: non-US input is reported honestly', () => {
  it('rejects a nonsense 5-digit code as not a US ZIP', async () => {
    // 00000 is not an assigned ZIP, so the honest answer is "not a US ZIP",
    // not a silent empty result.
    const { notUsZip, places } = await geocode('00000', sig())
    expect(places).toHaveLength(0)
    expect(notUsZip).toBe(true)
  }, 30000)

  it('rejects a UK postcode rather than guessing', async () => {
    // Free-text search goes through Photon, a volunteer-run service that rate
    // limits aggressively. When it is unavailable the search should degrade to
    // an error rather than pretend the place does not exist, so this asserts
    // only that nothing US is invented.
    const { places } = await geocode('SW1A 1AA', sig()).catch(() => ({ places: [], notUsZip: false }))
    expect(places).toHaveLength(0)
  }, 30000)
})

describe('geocode: input handling', () => {
  it('returns nothing for empty input', async () => {
    expect((await geocode('', sig())).places).toEqual([])
    expect((await geocode('    ', sig())).places).toEqual([])
  })

  it('tolerates surrounding whitespace', async () => {
    const { match } = await (async () => {
      const { places } = await geocode('  78701  ', sig())
      return { match: places.find((p) => p.zip === '78701') }
    })()
    expect(match).toBeDefined()
  }, 30000)
})
