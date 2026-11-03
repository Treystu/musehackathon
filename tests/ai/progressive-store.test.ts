import { describe, expect, it } from 'vitest'
import { AskSessionStore } from '../../src/ui/ai/session-store'
import type { RunProgressSnapshot } from '../../src/core/ai/run-progress'

/**
 * Lane A7 store pins: the progress snapshot rides the stage record
 * under the same token guard as the stage itself — a superseded
 * run's late snapshot is dropped; the snapshot survives stage
 * transitions (the percent must not reset when research hands off
 * to compose) and is dropped with the stage at clearStage. The
 * stage-age clock (stageSince) stamps at the run's start and on
 * every real transition, and only then. The run summary starts
 * null and round-trips through setAnswerState.
 */

const SNAPSHOT: RunProgressSnapshot = {
  doneUnits: 1,
  totalUnits: 2,
  criteriaTotal: 2,
  criteriaDone: ['School quality'],
  criteriaFailed: [],
  places: [{ name: 'Hilo, HI', zcta: '96720', verdicts: [] }],
}

describe('stage progress in the session store', () => {
  it('begins a run with no progress and the stage clock at the run start', () => {
    let now = 1_000
    const store = new AskSessionStore(() => now)
    const token = store.beginStageRun()
    const stage = store.getSnapshot().stage!
    expect(stage.progress).toBeNull()
    expect(stage.startedAt).toBe(1_000)
    expect(stage.stageSince).toBe(1_000)
    expect(token).toBe(stage.runToken)
    now = 2_000
    expect(store.getSnapshot().stage!.stageSince).toBe(1_000)
  })

  it('advances stageSince on a real transition, never on a same-stage re-set', () => {
    let now = 1_000
    const store = new AskSessionStore(() => now)
    const token = store.beginStageRun()
    now = 5_000
    store.setStage(token, 'screening')
    expect(store.getSnapshot().stage!.stageSince).toBe(5_000)
    now = 9_000
    store.setStage(token, 'screening')
    expect(store.getSnapshot().stage!.stageSince).toBe(5_000)
    // A subject change is a real transition: the stage the reader
    // is looking at began then.
    now = 12_000
    store.setStage(token, 'researching', 'School quality')
    expect(store.getSnapshot().stage!.stageSince).toBe(12_000)
  })

  it('records progress under the token guard and keeps it across transitions', () => {
    let now = 1_000
    const store = new AskSessionStore(() => now)
    const token = store.beginStageRun()
    store.setStageProgress(token + 99, SNAPSHOT)
    expect(store.getSnapshot().stage!.progress).toBeNull()
    store.setStageProgress(token, SNAPSHOT)
    expect(store.getSnapshot().stage!.progress).toEqual(SNAPSHOT)
    now = 40_000
    store.setStage(token, 'composing')
    expect(store.getSnapshot().stage!.progress).toEqual(SNAPSHOT)
  })

  it('drops progress with the stage at clearStage, and a stale token cannot clear it', () => {
    const store = new AskSessionStore(() => 1_000)
    const token = store.beginStageRun()
    store.setStageProgress(token, SNAPSHOT)
    store.clearStage(token + 99)
    expect(store.getSnapshot().stage).not.toBeNull()
    store.clearStage(token)
    expect(store.getSnapshot().stage).toBeNull()
  })

  it('a new run starts with no progress from the previous one', () => {
    const store = new AskSessionStore(() => 1_000)
    const first = store.beginStageRun()
    store.setStageProgress(first, SNAPSHOT)
    store.beginStageRun()
    expect(store.getSnapshot().stage!.progress).toBeNull()
  })
})

describe('the run summary in the answer state', () => {
  it('starts null and round-trips through setAnswerState', () => {
    const store = new AskSessionStore(() => 1_000)
    expect(store.getSnapshot().answer.runSummary).toBeNull()
    store.setAnswerState({
      runSummary: { requestId: 7, text: 'Complete — 2 of 2 checks done · 3 places assessed' },
    })
    expect(store.getSnapshot().answer.runSummary).toEqual({
      requestId: 7,
      text: 'Complete — 2 of 2 checks done · 3 places assessed',
    })
    store.setAnswerState({ runSummary: null })
    expect(store.getSnapshot().answer.runSummary).toBeNull()
  })
})
