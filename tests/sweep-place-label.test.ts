/**
 * Minor 11 pins: the sweep filter and the Explain figure context name
 * a place by its place-index display label ("Corbin, KY"), not by the
 * ACS NAME label ("ZCTA5 40771") production rows carry as row.name.
 *
 * The pure helpers are asserted directly. The filter input's wiring is
 * pinned at the source level, following the map-and-data-surfaces
 * pattern, because this repo has no DOM test environment; the one
 * rendering assertion that can be made statically (the filter label
 * and the rendered place label) uses renderToStaticMarkup.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import type { AreaRow } from '../src/core/plugins/acs'
import { SweepTable, sweepRowMatchesFilter } from '../src/ui/SweepTable'
import {
  figureInputsFromAreaRow,
  figureInputsFromAreaRows,
} from '../src/ui/ai/figure-input'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

/**
 * A row as production actually builds it: the ACS builder names every
 * sweep row with the Census NAME label, literally "ZCTA5 40771" — the
 * same fixture shape the place-name join (db73515) pinned against.
 */
const ACS_ROW: AreaRow = {
  zcta: '40771',
  name: 'ZCTA5 40771',
  metrics: { median_gross_rent: 900 },
  moes: { median_gross_rent: 85 },
}

const HILO_ROW: AreaRow = {
  zcta: '96720',
  name: 'ZCTA5 96720',
  metrics: { median_gross_rent: 1450 },
  moes: { median_gross_rent: 85 },
}

const LABELS: Record<string, string> = { '40771': 'Corbin, KY', '96720': 'Hilo, HI' }
const placeLabel = (zip: string): string | null => LABELS[zip] ?? null
const noLabel = (): string | null => null

describe('sweep filter matches the display label, not the ACS label form', () => {
  it('matches place text against the place-index label the table renders', () => {
    expect(sweepRowMatchesFilter(ACS_ROW, 'corbin', placeLabel)).toBe(true)
    expect(sweepRowMatchesFilter(ACS_ROW, 'Corbin, KY', placeLabel)).toBe(true)
    expect(sweepRowMatchesFilter(ACS_ROW, 'hilo', placeLabel)).toBe(false)
    expect(sweepRowMatchesFilter(HILO_ROW, 'hilo', placeLabel)).toBe(true)
  })

  it('does not match the ACS label form when a display label exists', () => {
    expect(sweepRowMatchesFilter(ACS_ROW, 'zcta5', placeLabel)).toBe(false)
    expect(sweepRowMatchesFilter(ACS_ROW, 'ZCTA5 40771', placeLabel)).toBe(false)
  })

  it('keeps an all-digit filter as a ZIP prefix', () => {
    expect(sweepRowMatchesFilter(ACS_ROW, '407', placeLabel)).toBe(true)
    expect(sweepRowMatchesFilter(ACS_ROW, '40771', placeLabel)).toBe(true)
    expect(sweepRowMatchesFilter(ACS_ROW, '967', placeLabel)).toBe(false)
  })

  it('falls back to the row name when the index has no entry — never a blank', () => {
    expect(sweepRowMatchesFilter(ACS_ROW, 'corbin', noLabel)).toBe(false)
    expect(sweepRowMatchesFilter(ACS_ROW, 'zcta5', noLabel)).toBe(true)
    expect(sweepRowMatchesFilter(ACS_ROW, 'corbin')).toBe(false)
  })

  it('an empty filter matches every row', () => {
    expect(sweepRowMatchesFilter(ACS_ROW, '', placeLabel)).toBe(true)
    expect(sweepRowMatchesFilter(ACS_ROW, '   ', placeLabel)).toBe(true)
  })

  it('the table renders the place filter and the display label', () => {
    const html = renderToStaticMarkup(
      createElement(SweepTable, {
        rows: [ACS_ROW],
        onAdd: () => {},
        onSortChange: () => {},
        selectedZctas: [],
        sortKey: null,
        ascending: true,
        placeLabel,
      }),
    )
    expect(html).toMatch(/Filter by ZIP code or place/)
    expect(html).toMatch(/Corbin, KY/)
  })

  it('the filter input accepts place text and the visible set uses the label join', () => {
    const src = read('src/ui/SweepTable.tsx')
    // The old input stripped every non-digit, so place text could
    // never be typed at all.
    expect(src).not.toMatch(/replace\(\/\\D\/g/)
    expect(src).toMatch(/sweepRowMatchesFilter\(r, filter, placeLabel\)/)
  })
})

describe('figure-input provider context carries the display label', () => {
  it('labels figures with the display label and matches on it, not the ACS form', () => {
    const figures = figureInputsFromAreaRow(ACS_ROW, ['median_gross_rent'], placeLabel)
    expect(figures).toHaveLength(1)
    expect(figures[0]?.label).toBe('Corbin, KY')
    expect(figures[0]?.geographies).toEqual(['40771', 'Corbin, KY'])
  })

  it('falls back to the row name when the index has no entry', () => {
    const figures = figureInputsFromAreaRow(ACS_ROW, ['median_gross_rent'], noLabel)
    expect(figures[0]?.label).toBeUndefined()
    expect(figures[0]?.geographies).toEqual(['40771', 'ZCTA5 40771'])
  })

  it('without a resolver the previous context is preserved', () => {
    const figures = figureInputsFromAreaRow(ACS_ROW, ['median_gross_rent'])
    expect(figures[0]?.label).toBeUndefined()
    expect(figures[0]?.geographies).toEqual(['40771', 'ZCTA5 40771'])
  })

  it('the rows variant joins each selected row and leaves the rows unmutated', () => {
    const figures = figureInputsFromAreaRows(
      [ACS_ROW, HILO_ROW],
      ['96720'],
      ['median_gross_rent'],
      placeLabel,
    )
    expect(figures).toHaveLength(1)
    expect(figures[0]?.label).toBe('Hilo, HI')
    expect(figures[0]?.geographies).toEqual(['96720', 'Hilo, HI'])
    expect(ACS_ROW.name).toBe('ZCTA5 40771')
    expect(HILO_ROW.name).toBe('ZCTA5 96720')
  })
})
