import { describe, expect, it } from 'vitest'
import {
  extractBareCandidateNames,
  extractCandidateNamesFromProse,
  runAnswerPipeline,
} from '../../src/core/ai/answer'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'

/**
 * SCRATCH (R-A investigation, 2026-11-04): reproduce the live Q6
 * dead end ("Where can I find the best schools but also the fewest
 * fast food restaurants?") with live-shaped research prose:
 * publication-heavy findings (a U.S. News citation), places named in
 * a shared-suffix list and in standard form, against a row set whose
 * gazetteer contains Newport News (so "news" is a place-name
 * component word, as in the shipped national index).
 */
const ROWS: AreaRow[] = [
  { zcta: '46032', name: 'Carmel, IN', metrics: { median_gross_rent: 1250 }, moes: { median_gross_rent: 60 } },
  { zcta: '46037', name: 'Fishers, IN', metrics: { median_gross_rent: 1310 }, moes: { median_gross_rent: 55 } },
  { zcta: '46077', name: 'Zionsville, IN', metrics: { median_gross_rent: 1420 }, moes: { median_gross_rent: 70 } },
  { zcta: '23607', name: 'Newport News, VA', metrics: { median_gross_rent: 1100 }, moes: { median_gross_rent: 40 } },
  { zcta: '96720', name: 'Hilo, HI', metrics: { median_gross_rent: 1450 }, moes: { median_gross_rent: 85 } },
] as AreaRow[]

const PROSE =
  'U.S. News & World Report ranks public schools in several Indiana suburbs at the top of its list. ' +
  'Carmel, Fishers and Zionsville (all in Indiana) are cited for highly rated public schools and few fast-food outlets. ' +
  'Carmel, IN is described as having the strongest school ratings of the group.'

const SOURCES = [
  { title: 'U.S. News Best High Schools Rankings', url: 'https://example.org/usnews' },
  { title: 'Indiana school directory', url: 'https://example.org/in-schools' },
]

describe('R-A scratch', () => {
  it('extraction: what the current code pulls from the live-shaped prose', () => {
    const std = extractCandidateNamesFromProse(PROSE)
    const bare = extractBareCandidateNames(PROSE, std, ROWS)
    console.log('STD:', JSON.stringify(std))
    console.log('BARE:', JSON.stringify(bare))
    expect(true).toBe(true)
  })

  it('pipeline: the Q6 terminal on live-shaped prose', async () => {
    const provider = createStubProvider({
      async research() {
        return { prose: PROSE, sources: SOURCES }
      },
    })
    const intent: ValidatedIntent = {
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    }
    const answer = await runAnswerPipeline({
      intent,
      rows: ROWS,
      researchQuery: 'Where can I find the best schools but also the fewest fast food restaurants?',
      provider,
    })
    console.log('STATUS:', answer.status)
    console.log('SUMMARY:', answer.summary)
    console.log('PLACES:', JSON.stringify(answer.places.map((p) => p.name)))
    console.log('UNRESOLVED:', JSON.stringify(answer.unresolvedCandidates))
    console.log('NAMED:', JSON.stringify(answer.researchNamedPlaces))
    console.log(
      'EVIDENCE:',
      JSON.stringify(answer.criterionEvidence.map((e) => `${e.criterion}=${e.status}`)),
    )
    expect(true).toBe(true)
  })
})
