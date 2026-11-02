/**
 * The ZIP-to-county index, pinned.
 *
 * The decode tests mirror zcta-place-index.test.ts for the same
 * reason: record *k* describes the k-th ZIP code, so a payload one
 * record short would attach every county after the gap to the wrong
 * ZIP and still render. The artefact tests pin the measured shape of
 * the shipped crosswalk: every ZCTA assigned, 3,211 distinct
 * (name, state) counties — fewer than the country's county
 * equivalents in some counts because the relationship file's county
 * set is what it is; the number asserted is the one the generator
 * measured from the Census file, not a civics figure.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CountyIndex,
  decodeCounties,
  EXPECTED_COUNTY_COUNT,
} from './zcta-county-index'

const PAYLOAD = join(__dirname, '..', '..', 'public', 'map', 'zcta-counties.json')

describe('decoding rejects a malformed payload', () => {
  // A record is 7 characters: 5-digit name index, 2-digit state index.
  const oneRecord = '0000000'
  const twoRecords = oneRecord + oneRecord

  it('rejects a record count that disagrees with the ZIP count', () => {
    expect(() =>
      decodeCounties({ v: 1, zd: [0, 0], names: ['Boulder County'], states: ['CO'], rec: oneRecord }),
    ).toThrow(/misaligned/)
  })

  it('rejects a payload that is not the whole country', () => {
    expect(() =>
      decodeCounties({ v: 1, zd: [0, 0], names: ['Boulder County'], states: ['CO'], rec: twoRecords }),
    ).toThrow(/the country has/)
  })

  it('rejects a record pointing outside its dictionaries', () => {
    const n = EXPECTED_COUNTY_COUNT
    const zd = Array.from({ length: n }, () => 0)
    const rec = oneRecord.repeat(n)
    const broken = '9999900' + rec.slice(7)
    expect(() =>
      decodeCounties({ v: 1, zd, names: ['Boulder County'], states: ['CO'], rec: broken }),
    ).toThrow(/outside its dictionaries/)
  })

  it('accepts a full-length payload, so the size assertion is not the only guard', () => {
    const n = EXPECTED_COUNTY_COUNT
    const zd = Array.from({ length: n }, (_, i) => (i === 0 ? 601 : 0))
    const rec = oneRecord.repeat(n)
    const { byZip } = decodeCounties({ v: 1, zd, names: ['Boulder County'], states: ['CO'], rec })
    expect(byZip.size).toBe(n)
  })

  it('rejects a non-object', () => {
    expect(() => decodeCounties(null)).toThrow(/not an object/)
    expect(() => decodeCounties({ v: 1 })).toThrow(/missing/)
  })
})

describe('the committed artefact', () => {
  const raw = JSON.parse(readFileSync(PAYLOAD, 'utf8'))
  const { byZip, counties } = decodeCounties(raw)
  const index = new CountyIndex(byZip, counties)

  it('assigns a county to every ZIP code in the country', () => {
    expect(byZip.size).toBe(EXPECTED_COUNTY_COUNT)
    expect(raw.zd.length).toBe(EXPECTED_COUNTY_COUNT)
    for (const [zip, record] of byZip) {
      expect(record.censusName, zip).not.toBe('')
      expect(record.state, zip).toMatch(/^[A-Z]{2}$/)
    }
  })

  it('resolves the ZIP codes the county tests and roadmap refer to', () => {
    // Read off the Census relationship file by the generator; each
    // is the largest-land-overlap county for its ZCTA.
    const expected: [string, string, string][] = [
      ['80202', 'Denver County', 'CO'],
      ['80301', 'Boulder County', 'CO'],
      ['80011', 'Adams County', 'CO'],
      ['96778', 'Hawaii County', 'HI'],
      ['96720', 'Hawaii County', 'HI'],
      ['78701', 'Travis County', 'TX'],
      ['10001', 'New York County', 'NY'],
      ['60601', 'Cook County', 'IL'],
      ['90012', 'Los Angeles County', 'CA'],
    ]
    for (const [zip, name, state] of expected) {
      expect(byZip.get(zip)?.censusName, zip).toBe(name)
      expect(byZip.get(zip)?.state, zip).toBe(state)
      expect(index.label(zip), zip).toBe(`${name}, ${state}`)
    }
  })

  it('keeps the county legal suffix as part of the name', () => {
    // Unlike place names, a county name is never shortened: the
    // suffix is the name. Anchorage is a municipality, Fairbanks a
    // borough, Baton Rouge a parish; all must survive verbatim.
    expect(byZip.get('99501')?.censusName).toBe('Anchorage Municipality')
    expect(byZip.get('99709')?.censusName).toBe('Fairbanks North Star Borough')
    expect(byZip.get('70801')?.censusName).toBe('East Baton Rouge Parish')
    // 99701 sits in Fairbanks but its largest land overlap is the
    // Yukon-Koyukuk Census Area — the assignment rule, not the
    // postal city, decides, and this pins that it does.
    expect(byZip.get('99701')?.censusName).toBe('Yukon-Koyukuk Census Area')
  })

  it('groups ZCTAs into the measured number of distinct counties', () => {
    expect(counties.length).toBe(3211)
    const grouped = counties.reduce((sum, c) => sum + c.zips.length, 0)
    expect(grouped).toBe(EXPECTED_COUNTY_COUNT)
    for (const county of counties) {
      expect([...county.zips]).toEqual([...county.zips].sort())
    }
  })

  it('separates same-named counties in different states', () => {
    const washingtons = counties.filter((c) => c.censusName === 'Washington County')
    expect(washingtons.length).toBeGreaterThan(10)
    expect(new Set(washingtons.map((c) => c.state)).size).toBe(washingtons.length)
  })

  it('returns null rather than a wrong answer for an unknown ZIP', () => {
    expect(index.lookup('00600')).toBeNull()
    expect(index.label('99999')).toBeNull()
    expect(index.assignment('00600')).toBeNull()
  })

  it('exposes the aggregation seam as name + state per ZCTA', () => {
    expect(index.assignment('80301')).toEqual({ name: 'Boulder County', state: 'CO' })
    const many = index.assignmentsFor(['80301', '80202', '00600'])
    expect(many.size).toBe(2)
    expect(many.get('80202')).toEqual({ name: 'Denver County', state: 'CO' })
  })
})
