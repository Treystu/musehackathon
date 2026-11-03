import { describe, expect, it } from 'vitest'
import {
  claimMentionsPlace,
  claimServesCriterion,
  type ResearchCriterion,
  type ResearchedClaim,
} from '../../src/core/ai/answer'
import {
  aggregateVerdictClass,
  deriveInterimPlaces,
  elapsedBucketText,
  progressPercent,
  progressStatusText,
  runSummaryText,
  situationalText,
  verdictClassLabel,
  type InterimPlace,
  type RunProgressSnapshot,
} from '../../src/core/ai/run-progress'

/**
 * Lane A7 pure-logic pins (design record: drive-scratch/
 * progressive-loading). The percent is passes completed over
 * passes planned and nothing else; verdicts derive through
 * compose's own attribution (the real helpers are injected here,
 * exactly as the pipeline injects them); the cadence text is a
 * pure function of the 30-second bucket. No fabricated totals:
 * the unknowable-total shape yields no percent at any layer.
 */

const SCHOOLS: ResearchCriterion = {
  id: 'schools',
  label: 'School quality',
  text: 'good schools',
  quantitative: false,
}
const COFFEE: ResearchCriterion = {
  id: 'coffee',
  label: 'Coffee nearby',
  text: 'a Starbucks nearby',
  quantitative: false,
}

const attribution = { servesCriterion: claimServesCriterion, mentionsPlace: claimMentionsPlace }

function snapshot(partial: Partial<RunProgressSnapshot>): RunProgressSnapshot {
  return {
    doneUnits: 0,
    totalUnits: 2,
    criteriaTotal: 2,
    criteriaDone: [],
    criteriaFailed: [],
    places: [],
    ...partial,
  }
}

describe('progressPercent', () => {
  it('is passes completed over passes planned, floored', () => {
    expect(progressPercent(snapshot({ doneUnits: 0, totalUnits: 3 }))).toBe(0)
    expect(progressPercent(snapshot({ doneUnits: 1, totalUnits: 3 }))).toBe(33)
    expect(progressPercent(snapshot({ doneUnits: 2, totalUnits: 3 }))).toBe(66)
    expect(progressPercent(snapshot({ doneUnits: 3, totalUnits: 3 }))).toBe(100)
  })

  it('is null when the total is unknowable or zero — no fabricated percent', () => {
    expect(progressPercent(snapshot({ doneUnits: 1, totalUnits: null }))).toBeNull()
    expect(progressPercent(snapshot({ doneUnits: 0, totalUnits: 0 }))).toBeNull()
  })

  it('clamps an over-complete count instead of exceeding 100', () => {
    expect(progressPercent(snapshot({ doneUnits: 5, totalUnits: 2 }))).toBe(100)
  })
})

describe('deriveInterimPlaces', () => {
  const candidates = [
    { name: 'Hilo, HI', zcta: '96720' },
    { name: 'Keaau, HI', zcta: '96749' },
  ]
  const schoolsClaim: ResearchedClaim = {
    text: 'Hilo, HI schools are rated above the state average in the cited directory.',
    sourceUrls: ['https://example.org/schools'],
  }

  it('marks every verdict pending before any pass has run', () => {
    const places = deriveInterimPlaces(
      { claims: [], criteria: [SCHOOLS, COFFEE], assessedLabels: [], failedLabels: [], candidates },
      attribution,
    )
    expect(places).toHaveLength(2)
    for (const place of places) {
      expect(place.verdicts.map((v) => v.state)).toEqual(['pending', 'pending'])
      expect(aggregateVerdictClass(place)).toBe('awaiting')
    }
  })

  it('served where a serving claim mentions the place, not-served where none does', () => {
    const places = deriveInterimPlaces(
      {
        claims: [schoolsClaim],
        criteria: [SCHOOLS, COFFEE],
        assessedLabels: ['School quality'],
        failedLabels: [],
        candidates,
      },
      attribution,
    )
    const hilo = places.find((p) => p.name === 'Hilo, HI')!
    const keaau = places.find((p) => p.name === 'Keaau, HI')!
    expect(hilo.verdicts).toEqual([
      { criterion: 'School quality', state: 'served' },
      { criterion: 'Coffee nearby', state: 'pending' },
    ])
    expect(keaau.verdicts[0]).toEqual({ criterion: 'School quality', state: 'not-served' })
  })

  it('a claim that mentions the place but does not serve the criterion does not serve it', () => {
    const places = deriveInterimPlaces(
      {
        claims: [{ text: 'Hilo, HI has a well-known farmers market.', sourceUrls: ['https://example.org/m'] }],
        criteria: [SCHOOLS],
        assessedLabels: ['School quality'],
        failedLabels: [],
        candidates,
      },
      attribution,
    )
    expect(places[0]!.verdicts[0]!.state).toBe('not-served')
  })

  it('failed when that criterion\u2019s pass failed, whatever the claims say', () => {
    const places = deriveInterimPlaces(
      {
        claims: [schoolsClaim],
        criteria: [SCHOOLS],
        assessedLabels: ['School quality'],
        failedLabels: ['School quality'],
        candidates,
      },
      attribution,
    )
    expect(places[0]!.verdicts[0]!.state).toBe('failed')
  })
})

describe('aggregateVerdictClass', () => {
  const place = (states: InterimPlace['verdicts'][number]['state'][]): InterimPlace => ({
    name: 'X',
    zcta: '00000',
    verdicts: states.map((state, i) => ({ criterion: `c${i}`, state })),
  })

  it('all assessed served is meets', () => {
    expect(aggregateVerdictClass(place(['served', 'served']))).toBe('meets')
    expect(aggregateVerdictClass(place(['served', 'pending']))).toBe('meets')
  })

  it('served beside not-served is mixed', () => {
    expect(aggregateVerdictClass(place(['served', 'not-served']))).toBe('mixed')
  })

  it('not-served alone is does-not-meet', () => {
    expect(aggregateVerdictClass(place(['not-served']))).toBe('does-not-meet')
    expect(aggregateVerdictClass(place(['not-served', 'pending']))).toBe('does-not-meet')
  })

  it('a failed check in an otherwise served set is mixed, never meets', () => {
    expect(aggregateVerdictClass(place(['served', 'failed']))).toBe('mixed')
    expect(aggregateVerdictClass(place(['failed']))).toBe('mixed')
  })

  it('nothing assessed is awaiting', () => {
    expect(aggregateVerdictClass(place(['pending', 'pending']))).toBe('awaiting')
    expect(aggregateVerdictClass(place([]))).toBe('awaiting')
  })

  it('labels carry the so-far qualification in words', () => {
    expect(verdictClassLabel('meets')).toBe('meets the checks so far')
    expect(verdictClassLabel('does-not-meet')).toBe('does not meet the checks so far')
    expect(verdictClassLabel('mixed')).toBe('mixed so far')
    expect(verdictClassLabel('awaiting')).toBe('awaiting assessment')
  })
})

describe('elapsedBucketText', () => {
  it('is null before the first ~30s bucket', () => {
    expect(elapsedBucketText(0)).toBeNull()
    expect(elapsedBucketText(29_999)).toBeNull()
  })

  it('names the buckets in plain words', () => {
    expect(elapsedBucketText(30_000)).toBe('about half a minute in')
    expect(elapsedBucketText(59_999)).toBe('about half a minute in')
    expect(elapsedBucketText(60_000)).toBe('about a minute in')
    expect(elapsedBucketText(90_000)).toBe('about a minute and a half in')
    expect(elapsedBucketText(120_000)).toBe('about 2 minutes in')
    expect(elapsedBucketText(150_000)).toBe('about 2 and a half minutes in')
    expect(elapsedBucketText(300_000)).toBe('about 5 minutes in')
  })
})

describe('progress text', () => {
  const twoPlaces: InterimPlace[] = [
    { name: 'Hilo, HI', zcta: '96720', verdicts: [] },
    { name: 'Keaau, HI', zcta: '96749', verdicts: [] },
  ]

  it('status line counts completed passes, names places, and names failures', () => {
    expect(
      progressStatusText(
        snapshot({ doneUnits: 1, criteriaDone: ['School quality'], places: twoPlaces }),
      ),
    ).toBe('1 of 2 checks done · 2 places named so far')
    expect(
      progressStatusText(
        snapshot({
          doneUnits: 2,
          criteriaDone: ['School quality'],
          criteriaFailed: ['Coffee nearby'],
          places: twoPlaces,
        }),
      ),
    ).toBe('2 of 2 checks done · 2 places named so far · 1 lookup did not return')
  })

  it('situational line joins the elapsed bucket only from ~30s of stage age', () => {
    const snap = snapshot({ doneUnits: 1, criteriaDone: ['School quality'], places: twoPlaces })
    expect(situationalText(snap, 10_000)).toBe('1 of 2 checks done · 2 places named so far')
    expect(situationalText(snap, 45_000)).toBe(
      '1 of 2 checks done · 2 places named so far · about half a minute in',
    )
  })

  it('without a snapshot the line is the elapsed bucket alone, and null before it', () => {
    expect(situationalText(null, 10_000)).toBeNull()
    expect(situationalText(null, 75_000)).toBe('about a minute in')
  })

  it('run summary is the COMPLETE strip: checks, named failures, places assessed', () => {
    expect(
      runSummaryText(
        snapshot({ doneUnits: 2, criteriaDone: ['School quality', 'Coffee nearby'], places: twoPlaces }),
      ),
    ).toBe('Complete — 2 of 2 checks done · 2 places assessed')
    expect(
      runSummaryText(
        snapshot({
          doneUnits: 2,
          criteriaDone: ['School quality'],
          criteriaFailed: ['Coffee nearby'],
          places: twoPlaces,
        }),
      ),
    ).toBe('Complete — 2 of 2 checks done · 1 lookup did not return · 2 places assessed')
  })

  it('run summary names a total failure without claiming places were assessed', () => {
    expect(
      runSummaryText(
        snapshot({
          doneUnits: 2,
          criteriaDone: [],
          criteriaFailed: ['School quality', 'Coffee nearby'],
          places: twoPlaces,
        }),
      ),
    ).toBe('Complete — 2 of 2 checks done · 2 lookups did not return')
  })

  it('run summary singularizes one place', () => {
    expect(
      runSummaryText(
        snapshot({ doneUnits: 1, totalUnits: 1, criteriaTotal: 1, criteriaDone: ['School quality'], places: [twoPlaces[0]!] }),
      ),
    ).toBe('Complete — 1 of 1 checks done · 1 place assessed')
  })
})
