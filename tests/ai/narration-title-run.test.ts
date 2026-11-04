import { describe, expect, it } from 'vitest'
import { filterWorkingNarration } from '../../src/core/ai/answer'

/**
 * Title-run signature pin (drug-law specimen, 2026-11-04).
 *
 * The specimen's Corbin annotation carried a run of
 * listing/directory titles the research model browsed without
 * registering them as sources, so BOTH of the narration filter's
 * title tests — which match only registered source titles — were
 * blind to it (reproduced first-hand: the claim passed the shipped
 * filter unchanged). The cure is a source-independent signature:
 * a segment carrying two or more pipe separators is a listing
 * title run. These pins hold the fixture shape (clean composed
 * sentences + an interleaved title run) and the controls (a single
 * pipe and plain findings prose survive).
 */
const CLEAN =
  'Corbin Independent School District with Corbin Primary and Middle noted, Baptist Health Corbin and Levi Jackson Wilderness Road Park for hiking / picnicking, Rotary Park playground / ballfields / dog park and Corbin Arena concerts.'
const TITLE_RUN =
  'Raising a child in Corbin, KY: Safety, Education, and Community Support Corbin, KY Two Bedroom Home Downtown Corbin, KY - 19 Gilliam St Corbin KY 40701 | Apartment Finder Best 30 Educational Services in Corbin, KY | superpages.com Search For Schools and Colleges Public Schools Near Corbin, Kentucky - Public Schools in Corbin, KY by Yellow Pages Directory Inc. Corbin, KY City Guide | About Living in Corbin - Homes.com 905 W 7th St | Corbin, KY Rental Homes and Apartments for Rent'
const CLAIM = `Corbin, KY / Bell County, KY: ${CLEAN} ${TITLE_RUN}`

// The sources the research result actually registered: the pages it
// formally cited. The listing titles are NOT among them — that is
// the specimen's seam.
const CITED_SOURCES = [
  { title: 'States Where Recreational Marijuana Is Legal in 2025', url: 'https://example.org/cannabis' },
  { title: 'Corbin Independent Schools - District Report Card', url: 'https://example.org/corbin-schools' },
]

describe('narration filter: source-independent title-run signature', () => {
  it('drops the interleaved title run and keeps the composed sentences', () => {
    const { prose, dropped } = filterWorkingNarration(CLAIM, CITED_SOURCES)
    expect(prose).toContain('Corbin Independent School District')
    expect(prose).toContain('Corbin Arena concerts')
    expect(prose).not.toContain('Apartment Finder')
    expect(prose).not.toContain('superpages')
    expect(prose).not.toContain('Yellow Pages')
    expect(prose).not.toContain('Homes.com')
    expect(prose).not.toContain('Rental Homes and Apartments for Rent')
    expect(dropped.length).toBeGreaterThanOrEqual(2)
  })

  it('drops the run even with an empty source list', () => {
    const { prose } = filterWorkingNarration(CLAIM, [])
    expect(prose).not.toContain('Apartment Finder')
    expect(prose).toContain('Corbin Independent School District')
  })

  it('keeps a segment with a single pipe separator', () => {
    const text = 'The district page lists Corbin Primary | Corbin Middle as its two campuses.'
    const { prose, dropped } = filterWorkingNarration(text, CITED_SOURCES)
    expect(dropped).toEqual([])
    expect(prose).toContain('Corbin Primary')
  })

  it('keeps plain findings prose unchanged', () => {
    const text =
      'Recreational marijuana is legal for adults in the state, and the city operates three public parks with playgrounds.'
    const { prose, dropped } = filterWorkingNarration(text, CITED_SOURCES)
    expect(dropped).toEqual([])
    expect(prose).toBe(text)
  })
})
