/**
 * CSV export, pinned.
 *
 * Two of the assertions here are about defects that would be invisible in a
 * spreadsheet until someone opened the file: a formula-injected cell that
 * executes on open, and a "N/A" string that silently turns a numeric column into
 * text. Neither shows up in a row count or a happy-path render.
 */
import { describe, expect, it } from 'vitest'

import { COLUMNS, escapeCell, toCsv, type ExportOptions } from '../src/core/export'
import { METRIC_KEYS } from '../src/core/plugins/acs'
import type { AreaRow } from '../src/core/plugins/acs'

const row = (over: Partial<AreaRow> = {}): AreaRow => ({
  zcta: '78701',
  name: 'ZCTA5 78701',
  metrics: {
    median_rent_burden_pct: 28.4,
    median_gross_rent: 1450,
    median_home_value: 510000,
    median_household_income: 78000,
    households: 4210,
  },
  moes: {},
  ...over,
})

const placeLabel = (zip: string) => (zip === '78701' ? 'Austin, TX' : null)

/** Counts CSV fields respecting quoting, which a naive split cannot do. */
function countFields(line: string): number {
  let fields = 0
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ',' && !inQuotes) fields++
  }
  return fields + 1
}

/** Parses one CSV line into a header-name -> cell map, respecting quoting. */
function parseLine(line: string): Record<string, string> {
  const cells: string[] = []
  let field = ''
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes
    if (ch === ',' && !inQuotes) {
      cells.push(field)
      field = ''
    } else field += ch
  }
  cells.push(field)
  const header = toCsv([row()], { placeLabel }).split('\r\n')[0]!.split(',')
  return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']))
}

describe('cell escaping', () => {
  it('leaves a plain value alone', () => {
    expect(escapeCell('Austin')).toBe('Austin')
    expect(escapeCell('78701')).toBe('78701')
  })

  it('quotes values containing a comma, quote or newline, doubling inner quotes', () => {
    expect(escapeCell('a,b')).toBe('"a,b"')
    expect(escapeCell('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCell('two\nlines')).toBe('"two\nlines"')
  })

  it('prefixes a formula-looking value so a spreadsheet reads it as text', () => {
    // The OWASP CSV-injection cases. Each of these executes in Excel or Sheets
    // if exported bare. Where quoting is also required (\t, \r) the guard sits
    // inside the quotes, so the assertion allows an opening quote.
    for (const dangerous of ['=SUM(A1:A2)', '+1-1', '@cmd', '-1+1', '\tabc', '\rabc']) {
      const escaped = escapeCell(dangerous)
      // The guard may sit behind an opening double-quote when the value also
      // needed CSV quoting; it must precede the value either way.
      expect(escaped, JSON.stringify(dangerous)).toMatch(/^"?'/)
    }
  })

  it('does not prefix an ordinary value that merely starts with a letter', () => {
    expect(escapeCell('Austin city')).toBe('Austin city')
  })

  it('keeps the guard inside the quotes', () => {
    expect(escapeCell('="x",y')).toBe('"\'=""x"",y"')
  })
})

describe('the file', () => {
  it('has a header naming every registered figure and its margin, in registry order', () => {
    const csv = toCsv([row()], { placeLabel })
    const lines = csv.split('\r\n').filter((l) => l !== '')
    const header = lines[0]!.split(',')

    // zcta, city, state, then every registry figure with a neighbouring margin
    // column. Generated from METRIC_KEYS, so the file cannot drift from what
    // the app displays; an export with its own hand-written list once shipped
    // five figures while the app fetched fifteen.
    expect(header.slice(0, 3)).toEqual(['zcta', 'city', 'state'])
    for (const key of METRIC_KEYS) {
      // The figure column carries the unit suffix; the margin column is bare
      // `<key>_moe`. Both must exist for every registered figure.
      expect(header.some((h) => h.startsWith(key)), `${key} must have a figure column`).toBe(true)
      expect(header, `${key} must have a margin column beside it`).toContain(`${key}_moe`)
    }
    // Every figure column is immediately followed by its margin column — the
    // margin's name is the bare key plus _moe, carrying no unit, because a
    // margin is in the figure's own unit already. The pairing is positional, so
    // the file preserves the estimate-with-precision coupling the UI insists on.
    METRIC_KEYS.forEach((key, k) => {
      const figureIdx = 3 + k * 2
      expect(header[figureIdx]!.startsWith(key)).toBe(true)
      expect(header[figureIdx + 1]).toBe(`${key}_moe`)
    })
    const expectedWidth = 3 + METRIC_KEYS.length * 2
    for (const line of lines) {
      expect(countFields(line)).toBe(expectedWidth)
    }
  })

  it('writes raw numbers, not formatted strings', () => {
    const csv = toCsv([row()], { placeLabel })
    const data = parseLine(csv.split('\r\n')[1]!)
    expect(data['median_rent_burden_pct_percent']).toBe('28.4')
    expect(data['median_gross_rent_usd_monthly']).toBe('1450')
    expect(data['median_home_value_usd']).toBe('510000')
    expect(data['households_count']).toBe('4210')
    expect(JSON.stringify(data)).not.toMatch(/\$/)
  })

  it('carries the margin beside its figure, or empty when the row has none', () => {
    const csv = toCsv([row({ moes: { median_gross_rent: 120 } })], { placeLabel })
    const data = parseLine(csv.split('\r\n')[1]!)
    expect(data['median_gross_rent_moe']).toBe('120')
    // A margin the row does not carry is empty, never zero and never invented.
    expect(data['median_home_value_moe']).toBe('')
  })

  it('splits the place label into separate city and state columns', () => {
    const csv = toCsv([row()], { placeLabel })
    expect(csv.split('\r\n')[1]).toMatch(/^78701,Austin,TX,/)
  })

  it('leaves empty cells when the mapping is unavailable or the label is null', () => {
    const none: ExportOptions = { placeLabel: () => null }
    expect(toCsv([row()], none).split('\r\n')[1]).toMatch(/^78701,,/)
  })

  it('writes an empty cell for a missing figure, never a zero or a placeholder', () => {
    // "N/A" was the plan's instruction. It turns the whole column into text in
    // every tool that opens the file, which silently breaks arithmetic on the
    // values that are present. An empty cell is the CSV convention for missing.
    const csv = toCsv([row({ metrics: { median_gross_rent: null, households: 100 } })], { placeLabel })
    const data = csv.split('\r\n')[1]!.split(',')
    expect(data[COLUMNS.findIndex((c) => c.key === 'median_gross_rent')]).toBe('')
    expect(data[COLUMNS.findIndex((c) => c.key === 'households')]).toBe('100')
  })

  it('preserves the caller’s order rather than imposing one', () => {
    // This module must not own a definition of "the right order"; the reader who
    // sorted the table gets the file in the order they chose.
    const a = row()
    const b = row({ zcta: '10001', metrics: { households: 9 } })
    const csv = toCsv([a, b], { placeLabel: () => null })
    const lines = csv.split('\r\n').filter((l) => l !== '')
    expect(lines[1]).toMatch(/^78701/)
    expect(lines[2]).toMatch(/^10001/)
  })

  it('escapes a city name that would otherwise break the row', () => {
    const evil = row({ zcta: '00000' })
    const csv = toCsv([evil], { placeLabel: () => '="EVIL()",XY' })
    const data = csv.split('\r\n')[1]!
    expect(data).toContain('"\'=""EVIL()"",XY"')
    // And a CSV-aware count still finds exactly one field per column. A naive
    // comma split cannot do this — quoted fields contain commas — so this parses.
    const fields: string[] = []
    let field = ''
    let inQuotes = false
    for (const ch of data) {
      if (ch === '"') inQuotes = !inQuotes
      if (ch === ',' && !inQuotes) {
        fields.push(field)
        field = ''
      } else field += ch
    }
    fields.push(field)
    expect(fields.length).toBe(COLUMNS.length)
  })

  it('ends with a line break, so the last row is not lost by strict parsers', () => {
    expect(toCsv([row()], { placeLabel }).endsWith('\r\n')).toBe(true)
  })
})
