/**
 * The ZIP-to-place index, pinned.
 *
 * The display-name cases here are the whole reason this file exists. Every one of
 * them was found by inspecting the 19,770 distinct names in the committed
 * artefact rather than by writing a rule and assuming it held, and three of them
 * are cases where the obvious implementation is silently wrong:
 *
 *   - `Salt Lake City city` is the Census name. Stripping a trailing `city`
 *     case-insensitively yields `Salt Lake`, which is not a place.
 *   - `Amherst Town city` is the town of Amherst Town, so the capitalised `Town`
 *     must survive while the lower-case `city` goes.
 *   - `Carroll County` is a census-designated place actually named that, so
 *     `County` must never be treated as a legal type.
 *
 * The decode tests are here for a quieter reason. Record *k* describes the k-th
 * ZIP code, so a payload with one record too few would attach every city after
 * the gap to the wrong ZIP and still render plausibly. Every count is asserted so
 * that a malformed file throws instead.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  decodePlaces,
  decodeZips,
  EXPECTED_PLACE_COUNT,
  PlaceIndex,
  searchPlaces,
  shortenPlaceName,
} from './zcta-place-index'

const PAYLOAD = join(__dirname, '..', '..', 'public', 'map', 'zcta-places.json')

describe('display names', () => {
  it('removes the legal type from an incorporated place', () => {
    expect(shortenPlaceName('Austin city', true)).toBe('Austin')
    expect(shortenPlaceName('Las Vegas city', true)).toBe('Las Vegas')
    expect(shortenPlaceName('Anchorage municipality', true)).toBe('Anchorage')
    expect(shortenPlaceName('New Orleans city', true)).toBe('New Orleans')
  })

  it('keeps a capitalised word that is part of the name', () => {
    // The Census Bureau writes a legal type in lower case and a proper noun in
    // upper. These two are the entire reason the match is case-sensitive.
    expect(shortenPlaceName('Salt Lake City city', true)).toBe('Salt Lake City')
    expect(shortenPlaceName('Amherst Town city', true)).toBe('Amherst Town')
    expect(shortenPlaceName('Carson City', true)).toBe('Carson City')
  })

  it('prefers the longer phrase when several could match', () => {
    expect(shortenPlaceName('Milford city (balance)', true)).toBe('Milford')
    expect(shortenPlaceName('Athens-Clarke County unified government (balance)', true)).toBe(
      'Athens-Clarke County',
    )
  })

  it('strips a statistical area type', () => {
    expect(shortenPlaceName('Urban Honolulu CDP', false)).toBe('Urban Honolulu')
    expect(shortenPlaceName('Aiea CDP', false)).toBe('Aiea')
    expect(shortenPlaceName('San Juan zona urbana', false)).toBe('San Juan')
  })

  it('never reduces a name to nothing or to a fragment', () => {
    expect(shortenPlaceName('Princeton', true)).toBe('Princeton')
    expect(shortenPlaceName('CDP', false)).toBe('CDP')
    expect(shortenPlaceName('', true)).toBe('')
  })

  it('leaves a statistical area whose name ends in County alone', () => {
    // Real CDPs: Carroll County (MD), Hampden County (MA), Worcester County (MA).
    // `County` is not a place legal type, so it is in neither suffix list.
    for (const name of ['Carroll County', 'Hampden County', 'Worcester County']) {
      expect(shortenPlaceName(name, false), name).toBe(name)
    }
  })

  it('is idempotent', () => {
    for (const [name, inc] of [
      ['Austin city', true],
      ['Salt Lake City city', true],
      ['Urban Honolulu CDP', false],
      ['Carroll County', false],
    ] as const) {
      const once = shortenPlaceName(name, inc)
      expect(shortenPlaceName(once, inc), name).toBe(once)
    }
  })
})

describe('ZIP delta decoding', () => {
  it('rebuilds an ascending list from deltas', () => {
    // previous starts at -1, so the first delta is the ZIP code itself.
    expect(decodeZips([0, 0, 1])).toEqual(['00000', '00001', '00003'])
  })

  it('pads to five digits', () => {
    expect(decodeZips([601])).toEqual(['00601'])
    expect(decodeZips([601, 99327])).toEqual(['00601', '99929'])
  })

  it('rejects a delta that would leave the five-digit range', () => {
    expect(() => decodeZips([100000])).toThrow(/out of range/)
  })

  it('rejects a negative delta, which would duplicate or reverse a ZIP code', () => {
    expect(() => decodeZips([0, -1])).toThrow(/non-negative/)
  })

  it('rejects a non-integer delta', () => {
    expect(() => decodeZips([1.5])).toThrow(/non-negative integer/)
  })
})

describe('decoding rejects a malformed payload', () => {
  // A record is 9 characters: 5-digit name index, 2-digit state index, kind,
  // legal class. Hand-built below rather than read from the artefact, so that a
  // specific corruption can be injected.
  const oneRecord = '0000000CI'
  const twoRecords = oneRecord + oneRecord

  it('rejects a record count that disagrees with the ZIP count', () => {
    // One record short: every city after the gap would attach to the wrong ZIP.
    expect(() =>
      decodePlaces({ v: 1, zd: [0, 0], names: ['Austin city'], states: ['TX'], rec: oneRecord }),
    ).toThrow(/misaligned/)
  })

  it('rejects a payload that is not the whole country', () => {
    expect(() =>
      decodePlaces({ v: 1, zd: [0, 0], names: ['Austin city'], states: ['TX'], rec: twoRecords }),
    ).toThrow(/the country has/)
  })

  it('rejects a record pointing outside its dictionaries', () => {
    // Built at full length deliberately. The country-size assertion runs before
    // the per-record loop, so a short fixture can never reach the dictionary
    // check — and an unchecked dictionary index is exactly the corruption that
    // would render a plausible wrong city beside a ZIP code.
    const n = EXPECTED_PLACE_COUNT
    const zd = Array.from({ length: n }, () => 0)
    const rec = oneRecord.repeat(n)
    // Name index 99999 against a one-entry dictionary.
    const broken = '9999900CI' + rec.slice(9)
    expect(() => decodePlaces({ v: 1, zd, names: ['Austin city'], states: ['TX'], rec: broken })).toThrow(
      /outside its dictionaries/,
    )
  })

  it('accepts a full-length payload, so the size assertion is not the only guard', () => {
    const n = EXPECTED_PLACE_COUNT
    const zd = Array.from({ length: n }, (_, i) => (i === 0 ? 601 : 0))
    const rec = oneRecord.repeat(n)
    const { byZip } = decodePlaces({ v: 1, zd, names: ['Austin city'], states: ['TX'], rec })
    expect(byZip.size).toBe(n)
  })

  it('rejects a non-object', () => {
    expect(() => decodePlaces(null)).toThrow(/not an object/)
    expect(() => decodePlaces({ v: 1 })).toThrow(/missing/)
  })
})

describe('the committed artefact', () => {
  const raw = JSON.parse(readFileSync(PAYLOAD, 'utf8'))
  const { byZip } = decodePlaces(raw)

  it('covers every ZIP code in the country', () => {
    expect(byZip.size).toBe(EXPECTED_PLACE_COUNT)
    expect(raw.zd.length).toBe(EXPECTED_PLACE_COUNT)
  })

  it('leaves no ZIP code unresolved', () => {
    for (const [zip, record] of byZip) {
      expect(record.displayName, zip).not.toBe('')
      expect(record.state, zip).toMatch(/^[A-Z]{2}$/)
    }
  })

  it('resolves the ZIP codes the roadmap and tests refer to', () => {
    // The same list asserted in tools/completion-gate.mjs, so a mapping that
    // drifted from those expectations fails here first.
    const expected: [string, string, string][] = [
      ['78701', 'Austin', 'TX'],
      ['10001', 'New York', 'NY'],
      ['99501', 'Anchorage', 'AK'],
      ['96813', 'Urban Honolulu', 'HI'],
      ['00901', 'San Juan', 'PR'],
      ['84101', 'Salt Lake City', 'UT'],
      ['59601', 'Helena', 'MT'],
    ]
    for (const [zip, name, state] of expected) {
      expect(byZip.get(zip)?.displayName, zip).toBe(name)
      expect(byZip.get(zip)?.state, zip).toBe(state)
    }
  })

  it('falls back to a county where no incorporated city exists', () => {
    const military = byZip.get('20771')
    expect(military?.isCity).toBe(false)
    expect(military?.displayName).toBe("Prince George's County")
    expect(military?.state).toBe('MD')
  })

  it('does not contain 00600, which is not a ZCTA', () => {
    expect(byZip.has('00600')).toBe(false)
  })

  it('keeps the publisher name verbatim alongside the display name', () => {
    // The artefact must stay auditable against the Census source file.
    expect(byZip.get('78701')?.censusName).toBe('Austin city')
    expect(byZip.get('84101')?.censusName).toBe('Salt Lake City city')
  })

  it('splits the country between cities and counties as measured', () => {
    const cities = [...byZip.values()].filter((p) => p.isCity).length
    expect(cities).toBe(28808)
    expect(EXPECTED_PLACE_COUNT - cities).toBe(4983)
  })
})

describe('search', () => {
  const raw = JSON.parse(readFileSync(PAYLOAD, 'utf8'))
  const decoded = decodePlaces(raw)
  const index = new PlaceIndex(decoded.byZip, decoded.places)

  it('finds a city by prefix', () => {
    const hits = index.search('austin')
    expect(hits.length).toBeGreaterThan(0)
    // "Austin, AR" and "Austin, TX" are both correct answers, and neither is
    // ranked above the other by size — that would be this app ranking places.
    // Asserted as presence, not position, deliberately.
    expect(hits.some((h) => h.displayName === 'Austin' && h.state === 'TX')).toBe(true)
    expect(hits.some((h) => h.displayName === 'Austin' && h.state === 'AR')).toBe(true)
  })

  it('returns every ZIP code in the matched city', () => {
    const austin = index.search('austin').find((h) => h.displayName === 'Austin' && h.state === 'TX')!
    expect(austin.zips.length).toBeGreaterThan(5)
    expect(austin.zips).toContain('78701')
    expect([...austin.zips]).toEqual([...austin.zips].sort())
  })

  it('puts incorporated cities ahead of county fallbacks', () => {
    // A county shares a name with towns all over the country; a person typing a
    // city name wants the city.
    for (const hits of [index.search('austin'), index.search('prince'), index.search('union')]) {
      const firstCounty = hits.findIndex((h) => !h.isCity)
      if (firstCounty > 0) {
        expect(hits.slice(firstCounty).every((h) => !h.isCity)).toBe(true)
      }
    }
  })

  it('ranks an exact name above a prefix match', () => {
    const hits = index.search('austin')
    const exact = hits.findIndex((h) => h.displayName.toLowerCase() === 'austin')
    const partial = hits.findIndex((h) => h.displayName.toLowerCase().startsWith('austin') && h.displayName.toLowerCase() !== 'austin')
    if (exact >= 0 && partial >= 0) expect(exact).toBeLessThan(partial)
  })

  it('is case- and whitespace-insensitive', () => {
    const a = index.search('  AUSTIN  ').map((h) => h.displayName)
    const b = index.search('austin').map((h) => h.displayName)
    expect(a).toEqual(b)
  })

  it('is deterministic, so keyboard navigation does not reorder under the user', () => {
    const first = index.search('spring').map((h) => `${h.displayName}, ${h.state}`)
    for (let i = 0; i < 3; i++) {
      expect(index.search('spring').map((h) => `${h.displayName}, ${h.state}`)).toEqual(first)
    }
  })

  it('returns nothing for an empty or unmatched query', () => {
    expect(index.search('')).toEqual([])
    expect(index.search('   ')).toEqual([])
    expect(index.search('zzzznotaplace')).toEqual([])
  })

  it('respects its limit', () => {
    expect(index.search('s', 3).length).toBeLessThanOrEqual(3)
    expect(searchPlaces(index.places, 'new', 2)).toHaveLength(2)
  })
})

describe('reverse lookup', () => {
  const raw = JSON.parse(readFileSync(PAYLOAD, 'utf8'))
  const decoded = decodePlaces(raw)
  const index = new PlaceIndex(decoded.byZip, decoded.places)

  it('labels a ZIP for the table and the comparison header', () => {
    expect(index.label('78701')).toBe('Austin, TX')
    expect(index.label('20771')).toBe("Prince George's County, MD")
  })

  it('returns null rather than a wrong answer for an unknown ZIP', () => {
    expect(index.label('00600')).toBeNull()
    expect(index.lookup('99999')).toBeNull()
    expect(index.label('')).toBeNull()
  })
})
