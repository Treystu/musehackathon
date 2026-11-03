import { describe, expect, it } from 'vitest'
import type {
  AnswerFigure,
  AnswerPlace,
  ComposedAnswer,
  CriterionEvidence,
} from '../../src/core/ai/answer'
import type { FlexibleAnswer } from '../../src/core/ai/flexible'
import {
  resultMapRelevant,
  terminalChartKinds,
} from '../../src/core/map/result-scale'
import {
  composeSpokenNote,
  composeSpokenSummary,
  planTerminalSpeech,
} from '../../src/ui/ai/spoken-answer'

/**
 * Lane A8 — the voice-response contract pins.
 *
 * The spoken layer composes off the landed terminal only, under a
 * per-request origin stamp: hook (only when structurally grounded)
 * -> headline -> up to 3 criterion sentences in priority order with
 * figures by reference -> one chart-reference sentence naming
 * exactly the charts the terminal render mounted -> a class status
 * line, at most 6 sentences, every sentence through the numeral
 * guard, the criteria-grounded banned filter, and the full
 * validator behind the shed-in-order ladder. Per class: verified
 * and research-first cards speak fully; the degraded card speaks
 * its measured parts plus the distinct lookup-did-not-return
 * sentence; flexible speaks in evidence-class words; honest notes
 * speak verbatim or not at all; withheld/blocked stay silent.
 */

function place(
  name: string,
  zcta: string,
  figures: AnswerFigure[],
  claims: AnswerPlace['claims'] = [],
): AnswerPlace {
  return { zcta, name, figures, claims }
}

function baseAnswer(partial: Partial<ComposedAnswer> = {}): ComposedAnswer {
  return {
    status: 'verified',
    stage: 'verify',
    criteria: [{ metricKey: 'median_gross_rent', bound: 'atMost', value: 1500, intentOp: 'lt' }],
    droppedCriteria: [],
    unresolvedGeographies: [],
    screenedCount: 4,
    places: [],
    generalClaims: [],
    sources: [],
    summary:
      'The places named here meet all of the stated Census criteria, with the deciding figures shown from Census data.',
    droppedClaims: [],
    failures: [],
    researchCriteria: [],
    criterionEvidence: [],
    candidateCap: 10,
    candidateCapApplied: false,
    unresolvedCandidates: [],
    geographyLevel: 'state',
    unsupportedGeography: null,
    countyMethod: null,
    notMeasurableCounties: [],
    geographyDisclosures: [],
    stateMethod: null,
    ...partial,
  }
}

const RENT_EVIDENCE: CriterionEvidence = {
  criterion: 'median_gross_rent',
  kind: 'census',
  status: 'met',
  detail: 'Measured from Census figures shown for each named place.',
  sourceUrls: [],
}

/* ------------------------------------------------------------------ */
/* Class 1: verified Census card                                       */
/* ------------------------------------------------------------------ */

describe('class 1: verified Census card', () => {
  const answer = baseAnswer({
    places: [
      place('Corbin, KY', '40771', [{ key: 'median_gross_rent', value: 999 }]),
      place('Hilo, HI', '96720', [{ key: 'median_gross_rent', value: 1450 }]),
    ],
    criterionEvidence: [RENT_EVIDENCE],
  })

  it('speaks headline, criterion with figure by reference, and the chart reference', () => {
    const spoken = composeSpokenSummary(answer)
    expect(spoken).toEqual([
      'The places named here meet all of the stated Census criteria, with the deciding figures shown from Census data.',
      'median gross rent: measured, 999 for Corbin, KY.',
      'The map shows the places by median gross rent.',
    ])
  })

  it('a single-place card renders no map and speaks no chart reference', () => {
    const single = baseAnswer({
      places: [place('Hilo, HI', '96720', [{ key: 'median_gross_rent', value: 1450 }])],
      criterionEvidence: [RENT_EVIDENCE],
    })
    expect(terminalChartKinds(single)).toEqual([])
    expect(composeSpokenSummary(single).join(' ')).not.toContain('map')
  })

  it('criterion sentences speak in priority order regardless of evidence order', () => {
    const scrambled = baseAnswer({
      places: [
        place('Corbin, KY', '40771', [{ key: 'median_gross_rent', value: 999 }]),
        place('Hilo, HI', '96720', [{ key: 'median_gross_rent', value: 1450 }]),
      ],
      criterionEvidence: [
        { criterion: 'Nature', kind: 'research', status: 'not_measurable', detail: 'No cited source available here speaks to this criterion.', sourceUrls: [] },
        { criterion: 'median_home_value', kind: 'census', status: 'met', detail: 'Measured from Census figures shown for each named place.', sourceUrls: [] },
        { criterion: 'School quality', kind: 'research', status: 'partially_measured', detail: 'A cited source speaks to this criterion in qualitative terms only.', sourceUrls: ['https://example.test/s'] },
        RENT_EVIDENCE,
      ],
    })
    const spoken = composeSpokenSummary(scrambled)
    // Tiers: rent (met, figure) -> home value (met) -> partially ->
    // not measurable. The criterion cap (3) cuts the lowest tier:
    // Nature is the sentence the budget spends last, so it is the
    // one that does not speak — the order within what speaks is
    // the priority order.
    expect(spoken[1]).toBe('median gross rent: measured, 999 for Corbin, KY.')
    expect(spoken[2]).toBe('median home value: measured.')
    expect(spoken[3]).toBe('School quality: partially measured.')
    expect(spoken[4]).toBe('The map shows the places by median gross rent.')
    expect(spoken.join(' ')).not.toContain('Nature')
  })
})

/* ------------------------------------------------------------------ */
/* Class 2: research-first card (the Texas shape, as measured)         */
/* ------------------------------------------------------------------ */

const TEXAS_CONCLUSION =
  'Among the places screened, Crystal City, TX has the strongest web support as most liberal.'

function texasAnswer(partial: Partial<ComposedAnswer> = {}): ComposedAnswer {
  return baseAnswer({
    criteria: [],
    summary:
      'The places named here were named by the cited research for the stated criteria, with Census figures shown for context.',
    places: [
      place('Crystal City, TX', '78839', [{ key: 'median_gross_rent', value: 448, marginOfError: 180 }], [
        { text: 'Crystal City, TX is described as strongly liberal and is called the bluest town in red Texas.', sourceUrls: ['https://example.com/crystal-city'] },
        { text: TEXAS_CONCLUSION, sourceUrls: ['https://example.com/crystal-city'] },
      ]),
      place('Marfa, TX', '79843', [{ key: 'median_gross_rent', value: 460, marginOfError: 79 }], [
        { text: 'Marfa, TX is described as moderately liberal and runs about 14 points more Democratic than Texas as a whole.', sourceUrls: ['https://example.com/marfa-politics'] },
      ]),
      place('Asherton, TX', '78827', [{ key: 'median_gross_rent', value: 440, marginOfError: 242 }]),
      place('Sebastian, TX', '78594', [{ key: 'median_gross_rent', value: 369, marginOfError: 304 }]),
    ],
    researchNamedPlaces: ['Crystal City, TX', 'Marfa, TX', 'Asherton, TX', 'Sebastian, TX'],
    criterionEvidence: [
      {
        criterion: 'Outside-Census criteria',
        kind: 'research',
        status: 'met',
        detail: 'Served by the cited sources shown with the places.',
        sourceUrls: ['https://example.com/marfa-politics', 'https://example.com/crystal-city'],
      },
    ],
    ...partial,
  })
}

describe('class 2: research-first card', () => {
  it('the conclusion leads, the criterion follows, the shortlist is named; no map, no hook', () => {
    const spoken = composeSpokenSummary(texasAnswer(), undefined, {
      queryText: 'what city in Texas is the most liberal',
    })
    expect(spoken).toEqual([
      TEXAS_CONCLUSION,
      'Outside-Census criteria: measured.',
      'The places named for the stated criteria are Crystal City, TX, Marfa, TX, Asherton, TX, and Sebastian, TX.',
    ])
  })

  it('falls back to the summary when the lead claim carries an unverified numeral', () => {
    const answer = texasAnswer()
    answer.places[0]!.claims = [
      { text: 'Crystal City, TX leads with 42 endorsements counted in prose.', sourceUrls: ['https://example.com/c'] },
    ]
    const spoken = composeSpokenSummary(answer)
    expect(spoken[0]).toBe(answer.summary)
    expect(spoken.join(' ')).not.toContain('42')
  })
})

/* ------------------------------------------------------------------ */
/* Class 3: degraded screen card — the lookup sentence                 */
/* ------------------------------------------------------------------ */

describe('class 3: degraded card (a research lookup did not return)', () => {
  const degraded = baseAnswer({
    places: [
      place('Walsh, CO', '81090', [{ key: 'median_gross_rent', value: 283, marginOfError: 273 }]),
      place('Granada, CO', '81042', [{ key: 'median_gross_rent', value: 300, marginOfError: 90 }]),
    ],
    criterionEvidence: [
      RENT_EVIDENCE,
      {
        criterion: 'Nature',
        kind: 'research',
        status: 'not_measurable',
        detail: 'The research lookup for this criterion did not return, so no cited source speaks to it here.',
        sourceUrls: [],
      },
    ],
    researchFailures: ['Nature'],
  })

  it('speaks the measured parts plus the distinct lookup sentence — never "not measurable" for it', () => {
    const spoken = composeSpokenSummary(degraded)
    expect(spoken).toContain('median gross rent: measured, 283 for Walsh, CO.')
    expect(spoken).toContain(
      'The research lookup for Nature did not return, so that criterion is not measured here.',
    )
    expect(spoken.join(' ')).not.toContain('Nature: not measurable')
    // Screen-composed: the map renders, so it is referenced.
    expect(spoken).toContain('The map shows the places by median gross rent.')
    // A partial run carries no contrast claim.
    expect(spoken.join(' ')).not.toContain('You might have expected')
  })

  it('the detail signal alone (no researchFailures stamp) still reads as a lookup that did not return', () => {
    const detailOnly = baseAnswer({
      ...degraded,
      researchFailures: undefined,
    })
    const spoken = composeSpokenSummary(detailOnly)
    expect(spoken).toContain(
      'The research lookup for Nature did not return, so that criterion is not measured here.',
    )
  })

  it('a structurally unmeasured criterion keeps the structural wording', () => {
    const structural = baseAnswer({
      places: degraded.places,
      criterionEvidence: [
        RENT_EVIDENCE,
        {
          criterion: 'Nature',
          kind: 'research',
          status: 'not_measurable',
          detail: 'No cited source available here speaks to this criterion.',
          sourceUrls: [],
        },
      ],
    })
    const spoken = composeSpokenSummary(structural)
    expect(spoken).toContain('Nature: not measurable from available sources.')
    expect(spoken.join(' ')).not.toContain('did not return')
  })
})

/* ------------------------------------------------------------------ */
/* Class 4: flexible completion                                        */
/* ------------------------------------------------------------------ */

describe('class 4: flexible completion', () => {
  const flexible: FlexibleAnswer = {
    prose:
      'Crystal City is the strongest match for the stated criteria. It sits in Zavala County.',
    places: [
      { name: 'Crystal City', evidenceClass: 'research_named', figures: [] },
      { name: 'Marfa', evidenceClass: 'model_knowledge', figures: [] },
      {
        name: 'Hilo',
        evidenceClass: 'census_measured',
        figures: [
          {
            label: 'Median gross rent',
            value: 1346,
            evidenceClass: 'census_measured',
            censusKey: 'median_gross_rent',
            zcta: '96720',
          },
        ],
      },
    ],
    figures: [],
  }
  const answer = baseAnswer({
    status: 'flexible',
    criteria: [],
    summary:
      'The research named places for the stated criteria, but none matched the loaded Census data, so this answer was completed from research and the model’s own knowledge, with every place and figure labelled by its evidence.',
    criterionEvidence: [],
    flexible,
  })

  it('speaks the framing headline, its own conclusion, and places in evidence-class words', () => {
    const spoken = composeSpokenSummary(answer)
    expect(spoken[0]).toBe(answer.summary)
    expect(spoken[1]).toBe('Crystal City is the strongest match for the stated criteria.')
    expect(spoken).toContain('Crystal City: named in research, not matched to Census data.')
    expect(spoken).toContain("Marfa: from the model's own knowledge, not measured.")
    expect(spoken).toContain('Hilo: measured in Census data.')
    expect(spoken.join(' ')).not.toContain('map')
    expect(spoken.join(' ')).not.toContain('You might have expected')
  })

  it('a conclusion carrying a figure outside the completion’s verified set is dropped whole', () => {
    const poisoned = baseAnswer({
      ...answer,
      flexible: {
        ...flexible,
        prose: 'About 42 places were weighed for this answer. Crystal City is the strongest match.',
      },
    })
    const spoken = composeSpokenSummary(poisoned)
    expect(spoken.join(' ')).not.toContain('42')
    expect(spoken[0]).toBe(answer.summary)
  })
})

/* ------------------------------------------------------------------ */
/* The hook: structurally grounded expectation contrast                */
/* ------------------------------------------------------------------ */

describe('the hook', () => {
  const hookAnswer = baseAnswer({
    places: [
      place('Austin, TX', '78701', [{ key: 'median_gross_rent', value: 1800 }]),
      place('Crystal City, TX', '78839', [{ key: 'median_gross_rent', value: 448 }]),
      place('Marfa, TX', '79843', [{ key: 'median_gross_rent', value: 460 }]),
    ],
    criterionEvidence: [RENT_EVIDENCE],
  })

  it('route (a): the question names an assessed place the ordering puts below others', () => {
    const spoken = composeSpokenSummary(hookAnswer, undefined, {
      queryText: 'Is Austin the cheapest place to rent in Texas?',
    })
    expect(spoken[0]).toBe(
      'You might have expected Austin, TX — the findings put 2 places ahead of it.',
    )
  })

  it('route (a): one place above is spoken as "1 place"', () => {
    const two = baseAnswer({
      places: [
        place('Crystal City, TX', '78839', [{ key: 'median_gross_rent', value: 448 }]),
        place('Austin, TX', '78701', [{ key: 'median_gross_rent', value: 1800 }]),
      ],
      criterionEvidence: [RENT_EVIDENCE],
    })
    const spoken = composeSpokenSummary(two, undefined, {
      queryText: 'Is Austin the cheapest place to rent in Texas?',
    })
    expect(spoken[0]).toBe(
      'You might have expected Austin, TX — the findings put 1 place ahead of it.',
    )
  })

  it('route (a): the question names only the winner — no hook', () => {
    const spoken = composeSpokenSummary(hookAnswer, undefined, {
      queryText: 'Is Crystal City the cheapest place to rent in Texas?',
    })
    expect(spoken.join(' ')).not.toContain('You might have expected')
    expect(spoken[0]).toBe(hookAnswer.summary)
  })

  it('route (a): the question names a place the answer did not assess — no hook, core speaks', () => {
    const spoken = composeSpokenSummary(hookAnswer, undefined, {
      queryText: 'Is Houston the cheapest place to rent in Texas?',
    })
    expect(spoken.join(' ')).not.toContain('You might have expected')
    expect(spoken.length).toBeGreaterThan(0)
  })

  it('route (b): a surviving claim marks the expected place as the commonly associated one', () => {
    const marked = baseAnswer({
      places: [
        place('Austin, TX', '78701', [{ key: 'median_gross_rent', value: 1800 }], [
          { text: 'Austin, TX is commonly associated with low-cost living in Texas.', sourceUrls: ['https://example.com/a'] },
        ]),
        place('Crystal City, TX', '78839', [{ key: 'median_gross_rent', value: 448 }]),
        place('Marfa, TX', '79843', [{ key: 'median_gross_rent', value: 460 }]),
      ],
      criterionEvidence: [RENT_EVIDENCE],
    })
    const spoken = composeSpokenSummary(marked)
    expect(spoken[0]).toBe(
      'You might have expected Austin, TX — the findings put 2 places ahead of it.',
    )
  })

  it('route (b): a general claim carrying the marker and naming the place grounds the hook', () => {
    const marked = baseAnswer({
      places: hookAnswer.places,
      generalClaims: [
        { text: 'Austin, TX is the obvious choice people name first for Texas rentals.', sourceUrls: ['https://example.com/a'] },
      ],
      criterionEvidence: [RENT_EVIDENCE],
    })
    const spoken = composeSpokenSummary(marked)
    expect(spoken[0]).toBe(
      'You might have expected Austin, TX — the findings put 2 places ahead of it.',
    )
  })

  it('route (b): no marker in any surviving claim — no hook', () => {
    const unmarked = baseAnswer({
      places: [
        place('Austin, TX', '78701', [{ key: 'median_gross_rent', value: 1800 }], [
          { text: 'Austin, TX has many rental listings across the city.', sourceUrls: ['https://example.com/a'] },
        ]),
        place('Crystal City, TX', '78839', [{ key: 'median_gross_rent', value: 448 }]),
        place('Marfa, TX', '79843', [{ key: 'median_gross_rent', value: 460 }]),
      ],
      criterionEvidence: [RENT_EVIDENCE],
    })
    const spoken = composeSpokenSummary(unmarked)
    expect(spoken.join(' ')).not.toContain('You might have expected')
  })
})

/* ------------------------------------------------------------------ */
/* Chart-reference exactness across the shape matrix                   */
/* ------------------------------------------------------------------ */

describe('chart-reference exactness (rendered set == referenced set)', () => {
  const shapes: Array<[string, ComposedAnswer, boolean]> = [
    [
      'verified screen, 2+ places, driving metric',
      baseAnswer({
        places: [
          place('Corbin, KY', '40771', [{ key: 'median_gross_rent', value: 999 }]),
          place('Hilo, HI', '96720', [{ key: 'median_gross_rent', value: 1450 }]),
        ],
        criterionEvidence: [RENT_EVIDENCE],
      }),
      true,
    ],
    [
      'research-named set (map suppressed by the A6 outcome)',
      texasAnswer(),
      false,
    ],
    [
      'single place',
      baseAnswer({
        places: [place('Hilo, HI', '96720', [{ key: 'median_gross_rent', value: 1450 }])],
        criterionEvidence: [RENT_EVIDENCE],
      }),
      false,
    ],
    [
      'no driving metric (no criteria, no figures)',
      baseAnswer({
        criteria: [],
        places: [place('A, ST', '00001', []), place('B, ST', '00002', [])],
      }),
      false,
    ],
    [
      'flexible (never mapped as Census places)',
      baseAnswer({ status: 'flexible', criteria: [], flexible: { prose: 'A conclusion.', places: [], figures: [] } }),
      false,
    ],
    [
      'withheld',
      baseAnswer({ status: 'withheld' }),
      false,
    ],
  ]
  for (const [name, shape, renders] of shapes) {
    it(name, () => {
      expect(resultMapRelevant(shape)).toBe(renders)
      expect(terminalChartKinds(shape).length).toBe(renders ? 1 : 0)
      const spoken = composeSpokenSummary(shape)
      expect(spoken.some((s) => s.includes('The map shows'))).toBe(renders)
    })
  }
})

/* ------------------------------------------------------------------ */
/* Budget + ladder                                                     */
/* ------------------------------------------------------------------ */

describe('budget and ladder', () => {
  it('a 6-criterion answer speaks at most 6 sentences, criteria in priority order', () => {
    const answer = baseAnswer({
      places: [
        place('Corbin, KY', '40771', [
          { key: 'median_gross_rent', value: 999 },
          { key: 'median_home_value', value: 151100 },
        ]),
        place('Hilo, HI', '96720', [
          { key: 'median_gross_rent', value: 1450 },
          { key: 'median_home_value', value: 650000 },
        ]),
      ],
      criterionEvidence: [
        RENT_EVIDENCE,
        { criterion: 'median_home_value', kind: 'census', status: 'met', detail: 'Measured.', sourceUrls: [] },
        { criterion: 'School quality', kind: 'research', status: 'met', detail: 'Served.', sourceUrls: ['https://example.test/1'] },
        { criterion: 'Nature', kind: 'research', status: 'met', detail: 'Served.', sourceUrls: ['https://example.test/2'] },
        { criterion: 'Nightlife', kind: 'research', status: 'met', detail: 'Served.', sourceUrls: ['https://example.test/3'] },
        { criterion: 'Transit', kind: 'research', status: 'met', detail: 'Served.', sourceUrls: ['https://example.test/4'] },
      ],
    })
    const spoken = composeSpokenSummary(answer)
    expect(spoken.length).toBeLessThanOrEqual(6)
    // headline + 3 criteria (budget) + chart; the tail criteria are cut.
    expect(spoken[1]).toBe('median gross rent: measured, 999 for Corbin, KY.')
    expect(spoken[2]).toBe('median home value: measured, 151,100 for Corbin, KY.')
    expect(spoken[3]).toBe('School quality: measured.')
    expect(spoken.join(' ')).not.toContain('Nightlife')
  })

  it('a headline the full validator refuses sheds every rung to silence', () => {
    // "top" is a strict-only construction: the criteria-grounded
    // sentence filter keeps it, the full validator withholds it —
    // and the headline rides every rung, so the ladder ends silent.
    const answer = baseAnswer({
      summary: 'The top places are shown with their Census figures.',
      places: [
        place('Corbin, KY', '40771', [{ key: 'median_gross_rent', value: 999 }]),
        place('Hilo, HI', '96720', [{ key: 'median_gross_rent', value: 1450 }]),
      ],
      criterionEvidence: [RENT_EVIDENCE],
    })
    expect(composeSpokenSummary(answer)).toEqual([])
  })

  it('the core rung sheds a status line the validator refuses, keeping headline + criteria', () => {
    // "Top City" passes the guard (no numeral) and the
    // criteria-grounded filter (strict-only pattern), but the full
    // validator withholds "top" — rungs with the status line fail;
    // the core set (no status) speaks.
    const answer = texasAnswer({
      places: [
        place('Crystal City, TX', '78839', [{ key: 'median_gross_rent', value: 448 }], [
          { text: TEXAS_CONCLUSION, sourceUrls: ['https://example.com/c'] },
        ]),
        place('Top City, TX', '70000', [{ key: 'median_gross_rent', value: 500 }]),
      ],
      researchNamedPlaces: ['Crystal City, TX', 'Top City, TX'],
    })
    const spoken = composeSpokenSummary(answer)
    expect(spoken).toContain(TEXAS_CONCLUSION)
    expect(spoken).toContain('Outside-Census criteria: measured.')
    expect(spoken.join(' ')).not.toContain('Top City')
  })
})

/* ------------------------------------------------------------------ */
/* Class 6/7: honest notes and silence                                 */
/* ------------------------------------------------------------------ */

describe('honest notes (composeSpokenNote)', () => {
  const NOTES = [
    'The country-wide data could not be loaded, so this question’s answer could not be composed. The manual search and the data views still work.',
    'The answer to this question could not be composed just now. The data views below still work.',
    'That question could not be screened as asked, so no answer was composed. The data views below still work.',
    'The place named in this question could not be resolved, so no answer was composed. The data views below still work.',
    'Research for the stated criteria did not produce a place that could be shown here.',
    'Research for the stated criteria did not name a place, so no city is claimed here.',
  ]
  for (const note of NOTES) {
    it(`speaks verbatim: ${note.slice(0, 40)}…`, () => {
      expect(composeSpokenNote(note).join(' ')).toBe(note)
      expect(composeSpokenNote(note).join(' ')).not.toMatch(/map|chart/i)
    })
  }

  it('a note carrying an unverifiable numeral is silent, never paraphrased', () => {
    expect(composeSpokenNote('The data for 42 counties could not be loaded.')).toEqual([])
  })

  it('a note the validator refuses is silent, never paraphrased', () => {
    expect(composeSpokenNote('This is the best answer available.')).toEqual([])
  })

  it('withheld and blocked answers stay silent', () => {
    expect(composeSpokenSummary(baseAnswer({ status: 'withheld' }))).toEqual([])
    expect(composeSpokenSummary(baseAnswer({ status: 'blocked' }))).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* The modality planner                                                */
/* ------------------------------------------------------------------ */

describe('planTerminalSpeech (the origin-stamp gate)', () => {
  const cardAnswer = baseAnswer({
    places: [
      place('Corbin, KY', '40771', [{ key: 'median_gross_rent', value: 999 }]),
      place('Hilo, HI', '96720', [{ key: 'median_gross_rent', value: 1450 }]),
    ],
    criterionEvidence: [RENT_EVIDENCE],
  })
  const request = { id: 7, epoch: 3, queryText: 'cheapest rent' }
  const voice = { requestId: 7, source: 'voice' as const }

  it('a voice-stamped request’s landed card plans speech, keyed on the answer object', () => {
    const plan = planTerminalSpeech({
      answer: cardAnswer, note: null, request, askEpoch: 3, origin: voice,
    })
    expect(plan?.target).toBe(cardAnswer)
    expect(plan?.sentences.length).toBeGreaterThan(0)
  })

  it('a typed stamp never speaks, even in a voice session', () => {
    expect(
      planTerminalSpeech({
        answer: cardAnswer, note: null, request, askEpoch: 3,
        origin: { requestId: 7, source: 'typed' },
      }),
    ).toBeNull()
  })

  it('a stamp minted for a different request does not fire', () => {
    expect(
      planTerminalSpeech({
        answer: cardAnswer, note: null, request, askEpoch: 3,
        origin: { requestId: 6, source: 'voice' },
      }),
    ).toBeNull()
  })

  it('a superseded generation (epoch moved on) does not fire', () => {
    expect(
      planTerminalSpeech({
        answer: cardAnswer, note: null, request, askEpoch: 4, origin: voice,
      }),
    ).toBeNull()
  })

  it('a voice-stamped note terminal plans the note verbatim, keyed on the note object', () => {
    const note = { id: 7, text: 'The answer to this question could not be composed just now. The data views below still work.' }
    const plan = planTerminalSpeech({
      answer: null, note, request, askEpoch: 3, origin: voice,
    })
    expect(plan?.target).toBe(note)
    expect(plan?.sentences.join(' ')).toBe(note.text)
  })

  it('a note belonging to another request does not fire', () => {
    expect(
      planTerminalSpeech({
        answer: null, note: { id: 6, text: 'Earlier note.' }, request, askEpoch: 3, origin: voice,
      }),
    ).toBeNull()
  })

  it('a silent class still plans (target marked, sentences empty): withheld', () => {
    const withheld = baseAnswer({ status: 'withheld' })
    const plan = planTerminalSpeech({
      answer: withheld, note: null, request, askEpoch: 3, origin: voice,
    })
    expect(plan?.target).toBe(withheld)
    expect(plan?.sentences).toEqual([])
  })

  it('mid-run state (no landed terminal) plans nothing — interim silence', () => {
    expect(
      planTerminalSpeech({
        answer: null, note: null, request, askEpoch: 3, origin: voice,
      }),
    ).toBeNull()
  })

  it('no request or no stamp plans nothing', () => {
    expect(
      planTerminalSpeech({ answer: cardAnswer, note: null, request: null, askEpoch: 3, origin: voice }),
    ).toBeNull()
    expect(
      planTerminalSpeech({ answer: cardAnswer, note: null, request, askEpoch: 3, origin: null }),
    ).toBeNull()
  })
})
