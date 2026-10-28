import { describe, expect, it } from 'vitest'
import { PROXY_ERRORS } from '../../src/core/ai/proxy-errors'
import { PROXY_ERROR_COPY, manualFallbackNote, proxyErrorNote } from '../../src/ui/ai/AskPanel'
import { assertProseHasMoe, formatFigure, type FigureInput } from '../../src/ui/ai/FigureCard'
import { explainState } from '../../src/ui/ai/ExplainBox'

const base: FigureInput = {
  key: 'median_gross_rent',
  value: 1450,
  marginOfError: 85,
  source: 'ACS 5-year estimates',
  publisher: 'U.S. Census Bureau',
  dataset: 'ACS',
  table: 'B25064',
  vintage: '2023',
}

describe('PROXY_ERROR_COPY', () => {
  it('covers all 8 proxy error classes exactly', () => {
    expect(PROXY_ERRORS).toHaveLength(8)
    expect(Object.keys(PROXY_ERROR_COPY).sort()).toEqual([...PROXY_ERRORS].sort())
    for (const key of PROXY_ERRORS) {
      expect(PROXY_ERROR_COPY[key].length).toBeGreaterThan(0)
    }
  })

  it('proxyErrorNote maps a class and passes through null', () => {
    expect(proxyErrorNote('provider_down')).toBe(PROXY_ERROR_COPY.provider_down)
    expect(proxyErrorNote(null)).toBeNull()
    expect(proxyErrorNote(undefined)).toBeNull()
  })
})

describe('manualFallbackNote', () => {
  it('promises manual parity with the same figures', () => {
    const note = manualFallbackNote()
    expect(note.length).toBeGreaterThan(0)
    expect(note.toLowerCase()).toContain('manual')
    expect(note.toLowerCase()).toContain('same figures')
  })
})

describe('formatFigure', () => {
  it('puts MOE beside the value', () => {
    const f = formatFigure(base)
    expect(f.headline).toContain('1,450')
    expect(f.headline).toContain(f.moeText)
    expect(f.moeText).toContain('85')
    expect(f.provenance).toContain('ACS')
    expect(f.provenance).toContain('B25064')
    expect(f.provenance).toContain('2023')
    expect(f.provenance).toContain('U.S. Census Bureau')
  })

  it('never invents a figure for null values', () => {
    const f = formatFigure({ ...base, value: null })
    expect(f.headline).toBe('Not published / suppressed')
    expect(f.moeText).toBe('')
  })

  it('states plainly when no MOE is published', () => {
    const f = formatFigure({ ...base, marginOfError: undefined })
    expect(f.headline).toContain('1,450')
    expect(f.moeText).toContain('no margin of error')
  })

  it('includes derivation-agnostic provenance regardless of derivation', () => {
    const f = formatFigure({ ...base, derivation: 'share = a / b' })
    expect(f.provenance).toContain(base.source)
    expect(f.provenance).toContain(base.dataset)
    expect(f.provenance).toContain(base.table)
    expect(f.provenance).toContain(base.vintage)
  })
})

describe('assertProseHasMoe', () => {
  const figs = [{ key: base.key, value: 1450, marginOfError: 85 }]

  it('passes prose with no numerals', () => {
    expect(assertProseHasMoe('Rent is high in this area.', figs)).toBe(true)
  })

  it('passes when a numeral carries its MOE', () => {
    expect(assertProseHasMoe('Median rent is 1,450 ± 85.', figs)).toBe(true)
  })

  it('fails when a figure is restated without its MOE', () => {
    expect(assertProseHasMoe('Median rent is 1450.', figs)).toBe(false)
  })

  it('fails when prose invents a numeral with no figure behind it', () => {
    expect(assertProseHasMoe('About 9999 households live here.', figs)).toBe(false)
  })
})

describe('explainState', () => {
  it('is empty with no prose', () => {
    expect(explainState(undefined)).toBe('empty')
    expect(explainState(null)).toBe('empty')
    expect(explainState('')).toBe('empty')
    expect(explainState('   ')).toBe('empty')
  })

  it('is withheld whenever flagged, even with prose', () => {
    expect(explainState('some wording', true)).toBe('withheld')
    expect(explainState(null, true)).toBe('withheld')
  })

  it('is ready only with prose and no withhold flag', () => {
    expect(explainState('some wording')).toBe('ready')
    expect(explainState('some wording', false)).toBe('ready')
  })
})
