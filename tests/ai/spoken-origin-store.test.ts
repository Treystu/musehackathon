import { describe, expect, it } from 'vitest'
import { AskSessionStore } from '../../src/ui/ai/session-store'

/**
 * Lane A8 — the origin stamp's store discipline: the stamp is
 * written in the same store write that mints its request, keyed to
 * that request's id, and starts null. The voice layer matches the
 * stamp against the landed terminal's own request (the planner
 * pins in spoken-terminal.test.ts); a stamp for a superseded
 * request simply never matches again, so nothing clears it.
 */

describe('AnswerState.requestOrigin', () => {
  it('starts null — a session with no minted request has no stamp', () => {
    const store = new AskSessionStore()
    expect(store.getSnapshot().answer.requestOrigin).toBeNull()
  })

  it('round-trips with the request it was minted beside', () => {
    const store = new AskSessionStore()
    store.setAnswerState({
      request: {
        id: 7,
        intent: {
          mode: 'sweep_filter',
          geographies: ['Hilo'],
          metricKeys: ['median_gross_rent'],
          filters: [],
          clarificationNeeded: false,
        },
        queryText: 'rent in Hilo',
        epoch: 1,
      },
      requestOrigin: { requestId: 7, source: 'voice' },
    })
    const answer = store.getSnapshot().answer
    expect(answer.request?.id).toBe(7)
    expect(answer.requestOrigin).toEqual({ requestId: 7, source: 'voice' })
  })

  it('a later write that does not mention the stamp leaves it keyed to its own request', () => {
    const store = new AskSessionStore()
    store.setAnswerState({ requestOrigin: { requestId: 3, source: 'typed' } })
    store.setAnswerState({ runSummary: { requestId: 3, text: 'Complete — 1 of 1 checks done' } })
    // The stamp still names request 3 — it can only ever match
    // request 3's terminal, never a later request's.
    expect(store.getSnapshot().answer.requestOrigin).toEqual({
      requestId: 3,
      source: 'typed',
    })
  })

  it('a new ask retiring the run summary does not mint a stamp by itself', () => {
    const store = new AskSessionStore()
    store.setAnswerState({ requestOrigin: { requestId: 3, source: 'voice' } })
    store.setAnswerState({ askEpoch: 2, runSummary: null })
    expect(store.getSnapshot().answer.requestOrigin).toEqual({
      requestId: 3,
      source: 'voice',
    })
  })
})
