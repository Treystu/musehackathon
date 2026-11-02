/**
 * The state scope, pinned against the real place index.
 *
 * Every case here exists because the scope failed silently in production:
 * the label table was keyed by state FIPS codes while the groups are ZIP
 * prefixes (so 08, New Jersey, read "Colorado" and Colorado's own 80/81
 * were filtered out of the options), the partition loader had no caller,
 * and the Ask derivation intersected its prefixes with that empty option
 * list. A Colorado sweep question therefore applied its bound to the
 * whole country. These tests pin the labels, the partitions, and the
 * exact seam the Ask run path uses.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { decodePlaces } from '../zcta-place-index'
import { stateName } from './chunk'
import {
  buildStatePartitions,
  describeScope,
  scopePrefixesForStates,
  stateOptions,
  toggleStateOption,
  type StatePartition,
} from './states'

const PAYLOAD = join(__dirname, '..', '..', '..', 'public', 'map', 'zcta-places.json')
const { byZip, places } = decodePlaces(JSON.parse(readFileSync(PAYLOAD, 'utf8')))
const stateByZip = new Map<string, string>()
for (const [zip, record] of byZip) stateByZip.set(zip, record.state)
const partitions: StatePartition[] = buildStatePartitions([...byZip.keys()], stateByZip)
const byCode = new Map(partitions.map((p) => [p.code, p]))

describe('prefix labels name the state the ZIP codes are in', () => {
  it('labels Colorado, and stops calling New Jersey Colorado', () => {
    expect(stateName('80')).toBe('Colorado')
    expect(stateName('81')).toBe('Colorado')
    expect(stateName('08')).toBe('New Jersey')
    expect(stateName('07')).toBe('New Jersey')
  })

  it('labels the other FIPS-collision prefixes by their real states', () => {
    expect(stateName('06')).toBe('Connecticut') // FIPS 06 is California; ZIP 06 is Connecticut
    expect(stateName('15')).toBe('Pennsylvania') // FIPS 15 is Hawaii; ZIP 15 is Pennsylvania
    expect(stateName('35')).toBe('Alabama') // FIPS 35 is New Mexico; ZIP 35 is Alabama
    expect(stateName('56')).toBe('Minnesota') // FIPS 56 is Wyoming; ZIP 56 is Minnesota
  })
})

describe('state partitions from the real place index', () => {
  it('gives Colorado its own prefixes and every one of its ZCTAs', () => {
    const co = byCode.get('CO')!
    expect(co.label).toBe('Colorado')
    expect(co.prefixes).toEqual(['80', '81'])
    expect(co.zctas).toHaveLength(527)
    expect(co.zctas.every((z) => stateByZip.get(z) === 'CO')).toBe(true)
  })

  it('covers the whole enumeration exactly once', () => {
    const total = partitions.reduce((n, p) => n + p.zctas.length, 0)
    expect(total).toBe(byZip.size)
  })

  it('keeps island states reachable despite shared prefixes', () => {
    // Hawaii shares prefix 96 with Northern California; the partition is
    // built from each ZCTA's own state, so Hawaii still gets its option.
    expect(byCode.get('HI')!.prefixes).toEqual(['96'])
    expect(byCode.get('HI')!.zctas).toHaveLength(97)
    expect(byCode.get('NJ')!.prefixes).toEqual(['07', '08'])
  })

  it('offers one option per state, none of them a raw prefix', () => {
    const options = stateOptions(partitions)
    expect(options.filter((o) => o.label === 'Colorado')).toHaveLength(1)
    expect(options.every((o) => !o.label.startsWith('ZIP prefix'))).toBe(true)
    const co = options.find((o) => o.code === 'CO')!
    expect(co.count).toBe(527)
    expect(co.prefixes).toEqual(['80', '81'])
  })
})

describe('the Ask sweep derivation seam', () => {
  it('resolves a named state to the prefixes the sweep loader needs', () => {
    expect(scopePrefixesForStates(places, ['CO'])).toEqual(['80', '81'])
    expect(scopePrefixesForStates(places, ['HI'])).toEqual(['96'])
    // 73 is Oklahoma's home prefix, but one Texas ZCTA sits in its range;
    // the prefixes are the data's, splits included, not a tidied list.
    expect(scopePrefixesForStates(places, ['TX'])).toEqual(['73', '75', '76', '77', '78', '79'])
  })

  it('resolves several states together and unknown states to nothing', () => {
    // Wyoming spans 82 and 83 (Jackson is 83001); 83 is shared with Idaho.
    expect(scopePrefixesForStates(places, ['CO', 'WY'])).toEqual(['80', '81', '82', '83'])
    expect(scopePrefixesForStates(places, ['XX'])).toEqual([])
  })
})

describe('toggling and naming a selection', () => {
  const co = stateOptions(partitions).find((o) => o.code === 'CO')!
  const wy = stateOptions(partitions).find((o) => o.code === 'WY')!

  it('adds and removes a state as all of its prefixes together', () => {
    expect(toggleStateOption([], co)).toEqual(['80', '81'])
    expect(toggleStateOption(['80', '81'], co)).toEqual([])
    expect(toggleStateOption(['80'], co)).toEqual(['80', '81'])
    expect(toggleStateOption(['80', '81'], wy)).toEqual(['80', '81', '82', '83'])
  })

  it('names a whole-state selection as that state', () => {
    expect(describeScope([], partitions)).toBe('the United States')
    expect(describeScope(['80', '81'], partitions)).toBe('Colorado')
    expect(describeScope(['07', '08', '80', '81'], partitions)).toBe('2 states')
  })
})
