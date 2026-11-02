import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import type { JevAnswer } from '../../src/core/ai/jev-judgments'
import {
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'
import {
  AskSessionStore,
  deserializeSession,
  serializeSession,
  stageLabel,
  stagedStatusVisible,
  type SessionStorageLike,
  type StageId,
} from '../../src/ui/ai/session-store'

/**
 * Item 17 pins, store level: the session store owns the thread, the
 * in-flight run, and the staged status, above any tab surface.
 *
 * A "tab switch" at this level is exact: every listener unsubscribes
 * (the surface unmounted) while the run keeps going. The cure being
 * pinned is ownership — the run's completion handlers close over the
 * store, so the answer lands in the session with nothing mounted,
 * and navigation neither cancels nor restarts it (the pipeline is
 * invoked exactly once).
 */

const ROWS: AreaRow[] = [
  { zcta: '96720', name: 'Hilo, HI', metrics: { median_gross_rent: 1450 }, moes: { median_gross_rent: 85 } },
  { zcta: '96749', name: 'Keaau, HI', metrics: { median_gross_rent: 1325 }, moes: { median_gross_rent: 120 } },
  { zcta: '96778', name: 'Pahoa, HI', metrics: { median_gross_rent: 1750 }, moes: { median_gross_rent: 150 } },
]

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: ['median_gross_rent'],
    filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
    clarificationNeeded: false,
    ...partial,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function verifiedAnswer(): Promise<ComposedAnswer> {
  const answer = await runAnswerPipeline({ intent: intent({}), rows: ROWS })
  expect(answer.status).toBe('verified')
  return answer
}

class MemoryStorage implements SessionStorageLike {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

describe('session store: thread and in-flight run survive a tab switch', () => {
  it('a run in flight when every listener detaches completes into the store, invoked once', async () => {
    const store = new AskSessionStore(null)
    const answer = await verifiedAnswer()
    // A surface mounts (subscribes) and the reader asks a question.
    const unsubscribe = store.subscribe(() => {})
    store.setPanel({ text: 'where is rent under $1,500', busy: true })
    store.setAnswerState({ request: { id: 1, intent: intent({}), queryText: 'where is rent under $1,500' } })
    const gate = deferred<ComposedAnswer>()
    let invocations = 0
    const run = (async () => {
      invocations += 1
      const composed = await gate.promise
      // The completion handler closes over the store, as App's does.
      store.setAnswerState({ answer: composed })
      store.setPanel({ busy: false })
      return composed
    })()
    store.trackRun('answer:1', run)
    expect(store.inFlightKeys()).toEqual(['answer:1'])

    // The tab switch: the surface unmounts; nothing is subscribed.
    unsubscribe()

    gate.resolve(answer)
    await run

    expect(invocations).toBe(1)
    expect(store.inFlightKeys()).toEqual([])
    const snapshot = store.getSnapshot()
    expect(snapshot.answer.answer?.status).toBe('verified')
    expect(snapshot.answer.answer?.places.map((p) => p.name)).toEqual(['Hilo, HI', 'Keaau, HI'])
    expect(snapshot.panel.busy).toBe(false)
    // The thread is intact for the return: question + understood request.
    expect(snapshot.panel.text).toBe('where is rent under $1,500')
    expect(snapshot.answer.request?.queryText).toBe('where is rent under $1,500')
  })

  it('question, intent, notes, and decisions survive with no listener attached', () => {
    const store = new AskSessionStore(null)
    const unsubscribe = store.subscribe(() => {})
    store.setPanel({
      text: 'cheapest rent in Hawaii',
      intent: intent({ geographies: ['Hawaii'] }),
      note: 'More detail is needed before anything runs.',
      executionNote: 'Showing the screen.',
    })
    store.updateModal((modal) => ({
      ...modal,
      closedBranches: new Set(['transport']) as typeof modal.closedBranches,
    }))
    unsubscribe()
    const snapshot = store.getSnapshot()
    expect(snapshot.panel.text).toBe('cheapest rent in Hawaii')
    expect(snapshot.panel.intent?.geographies).toEqual(['Hawaii'])
    expect(snapshot.panel.note).toContain('More detail is needed')
    expect(snapshot.panel.executionNote).toBe('Showing the screen.')
    expect([...snapshot.answer.modal.closedBranches]).toEqual(['transport'])
  })
})

describe('session store: staged status', () => {
  it('stage transitions are ordered, token-guarded, and same-stage sets do not notify', () => {
    let now = 10_000
    const store = new AskSessionStore(null, () => now)
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    const token = store.beginStageRun('understanding')
    expect(store.getSnapshot().stage?.stage).toBe('understanding')
    const afterBegin = notifications

    // Same stage + subject: no transition, no notification — the
    // aria-live discipline starts at the store.
    store.setStage(token, 'understanding')
    expect(notifications).toBe(afterBegin)

    store.setStage(token, 'screening')
    store.setStage(token, 'researching', 'School quality')
    expect(store.getSnapshot().stage?.stage).toBe('researching')
    expect(store.getSnapshot().stage?.subject).toBe('School quality')

    // A superseded run cannot move or clear the current stage.
    store.setStage(token + 99, 'verifying')
    expect(store.getSnapshot().stage?.stage).toBe('researching')
    store.clearStage(token + 99)
    expect(store.getSnapshot().stage?.stage).toBe('researching')

    // The 1-second rule times the whole run from its start.
    now += 999
    expect(stagedStatusVisible(store.getSnapshot().stage, now)).toBe(false)
    now += 1
    expect(stagedStatusVisible(store.getSnapshot().stage, now)).toBe(true)

    store.clearStage(token)
    expect(store.getSnapshot().stage).toBeNull()
  })

  it('labels are plain words; research names its parsed subject', () => {
    expect(stageLabel('understanding')).toBe('Understanding your question')
    expect(stageLabel('screening')).toBe('Screening the Census data')
    expect(stageLabel('composing')).toBe('Composing your answer')
    expect(stageLabel('verifying')).toBe('Verifying the figures')
    expect(stageLabel('researching', 'School quality')).toBe('Researching School quality')
    expect(stageLabel('researching')).toBe('Researching')
    expect(stageLabel('researching', null)).toBe('Researching')
  })
})

describe('session store: reload persistence', () => {
  it('the serializable session restores into a fresh store; in-flight state does not', async () => {
    const storage = new MemoryStorage()
    const answer = await verifiedAnswer()
    const first = new AskSessionStore(storage)
    first.setPanel({ text: 'where is rent under $1,500', intent: intent({}), busy: true })
    first.setAnswerState({
      request: { id: 1, intent: intent({}), queryText: 'where is rent under $1,500' },
      answer,
    })
    first.updateModal((modal) => ({
      ...modal,
      closedBranches: new Set(['transport']) as typeof modal.closedBranches,
    }))
    first.beginStageRun('researching')

    // A reload: a brand-new store over the same sessionStorage.
    const restored = new AskSessionStore(storage)
    const snapshot = restored.getSnapshot()
    expect(snapshot.panel.text).toBe('where is rent under $1,500')
    expect(snapshot.panel.intent?.mode).toBe('sweep_filter')
    expect(snapshot.answer.request?.queryText).toBe('where is rent under $1,500')
    expect(snapshot.answer.answer?.status).toBe('verified')
    expect(snapshot.answer.answer?.places).toHaveLength(2)
    expect([...snapshot.answer.modal.closedBranches]).toEqual(['transport'])
    // What does not survive, stated in session-store's contract: the
    // in-flight run (busy cleared, no stage) — a page load cannot
    // resume it, and the store does not pretend otherwise.
    expect(snapshot.panel.busy).toBe(false)
    expect(snapshot.stage).toBeNull()
    expect(restored.inFlightKeys()).toEqual([])
  })

  it('serialize/deserialize round-trips and rejects foreign payloads', async () => {
    const store = new AskSessionStore(null)
    store.setPanel({ text: 'q', busy: true })
    const restored = deserializeSession(serializeSession(store.getSnapshot()))
    expect(restored?.panel.text).toBe('q')
    expect(restored?.panel.busy).toBe(false)
    expect(deserializeSession(null)).toBeNull()
    expect(deserializeSession('{"v":99}')).toBeNull()
    expect(deserializeSession('not json')).toBeNull()
  })
})

describe('staged status: the runner emits real stages in true order', () => {
  const starbucksQuery = 'places with a Starbucks nearby where rent is under $1,500'

  function loopAnswers(noul: number, score = 2): Record<string, JevAnswer> {
    return {
      'criterion:median_gross_rent': { type: 'noul', probability: noul },
      'criterion:schools': { type: 'noul', probability: noul },
      'criterion:coffee': { type: 'noul', probability: noul },
      relevance: { type: 'score', expected: score, distribution: { '0': 0, '1': 0, '2': 1 } },
      completeness: { type: 'score', expected: score, distribution: { '0': 0, '1': 0, '2': 1 } },
    }
  }

  it('a slow researched run advances wonder-plan, screening, researching, composing, verifying, jev, wonder-verify', async () => {
    const seen: { stage: StageId; subject?: string | null }[] = []
    const provider = createStubProvider({
      async research() {
        return {
          prose: 'Hilo, HI has a Starbucks nearby.',
          sources: [{ title: 'Store locator', url: 'https://example.org/stores' }],
        }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: intent({}),
      queryText: starbucksQuery,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent({}), null),
      provider,
      research: true,
      stack: {
        decisions: {},
        jevTransport: async ({ set }) => {
          if (set === 'J-LOOP') return { answers: loopAnswers(0.95) }
          return {
            answers: {
              'branch-exists': { type: 'noul', probability: 0.1 },
              'branch-which': {
                type: 'choice',
                selected: 'none-of-these',
                distribution: { transport: 0, 'school-level': 0, 'budget-anchor': 0, 'none-of-these': 1 },
              },
            } as Record<string, JevAnswer>,
          }
        },
        planTransport: async () => ({ verdict: 'sound', objections: [] }),
        verifyTransport: async () => ({ verdict: 'verified', concerns: [] }),
      },
      onStage: (stage, subject) => seen.push({ stage, subject }),
    })
    expect(answer?.status).toBe('verified')
    expect(seen.map((s) => s.stage)).toEqual([
      'wonder-plan',
      'screening',
      'researching',
      'composing',
      'verifying',
      'jev',
      'wonder-verify',
    ])
    // The research stage names its subject from the parse — the
    // decomposed criterion the question itself supplied.
    const research = seen.find((s) => s.stage === 'researching')
    expect(typeof research?.subject).toBe('string')
    expect((research?.subject ?? '').length).toBeGreaterThan(0)
  })

  it('a fast deterministic run names only the stages that ran: no research, no Jev, no Wonder', async () => {
    const seen: StageId[] = []
    const answer = await composeAnswerForRequest({
      intent: intent({}),
      queryText: 'where is rent under $1,500',
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent({}), null),
      provider: createStubProvider(),
      research: false,
      stack: false,
      onStage: (stage) => seen.push(stage),
    })
    expect(answer?.status).toBe('verified')
    expect(seen).toEqual(['screening', 'composing', 'verifying'])
  })
})
