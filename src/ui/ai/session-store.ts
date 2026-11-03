import type { ComposedAnswer } from '../../core/ai/answer'
import {
  initialModalState,
  type ModalState,
} from '../../core/ai/decision-branches'
import type { ResearchSource, ValidatedIntent } from '../../core/ai/provider'
import type { ProxyError } from '../../core/ai/proxy-errors'
import type { GeneralAnswerData } from './general-runner'

/**
 * The Ask session store (drive item 17, owner-live defects,
 * 2026-11-02): the session's state ownership, lifted above the tab
 * surfaces.
 *
 * The defect this cures, measured from the shipped tree: every piece
 * of conversational state — the question text, the understood
 * request, the ack, the notes, the standalone research, the busy
 * flag, and the run counters that guard superseded work — lived in
 * useState/useRef inside AskPanel (src/ui/ai/AskPanel.tsx), and
 * AskPanel was mounted only inside the Explore branch's ask mode in
 * App.tsx. Switching to the Map or Methodology tab unmounted it, so
 * returning found a fresh panel: question gone, thread gone, and an
 * in-flight parse or research run writing into a component that no
 * longer existed (its setState calls land nowhere; its run counters
 * reset, so even the supersession discipline was lost).
 *
 * The cure is ownership, not keep-alive mounting: this store is
 * created once by App (above every tab surface) and handed to
 * AskPanel as a prop. Panel and answer state are read through
 * useSyncExternalStore; the async runs close over the store itself,
 * never over a component, so a run started before a tab switch
 * completes into the store while nothing is mounted and its answer
 * is waiting on return. Unmounting a surface now unsubscribes a
 * listener and nothing else.
 *
 * Persistence: the serializable session is written to sessionStorage
 * on every change (the same storage class the decision modals
 * already use for their decisions record — see
 * core/ai/decision-branches.ts, DECISIONS_SESSION_KEY — and the
 * intent-url channel for shareable state), so an accidental reload
 * restores the thread. Precisely what survives a reload: the
 * question text, the understood request (intent), the panel notes,
 * finished web research (prose + sources), the last answer request
 * together with its landed outcome (the last composed answer or
 * its terminal note), the general lane's answer/note, and the
 * decision modal's closed/refined branch sets (the decisions
 * themselves live in their own session record, unchanged). What
 * does NOT survive a reload: any in-flight run (busy and the stage
 * state restore cleared — a run cannot resume across a page load,
 * and claiming it was still running would be inventing state), an
 * answer request whose run was still in flight (the projection
 * below drops it: it has no landed outcome to restore), the
 * ack line, and a transient proxy error.
 */

/** The panel's standalone-research state (AskPanel's original union). */
export type PanelResearchState =
  | { status: 'idle' | 'loading' | 'unavailable' }
  | { status: 'done'; prose: string; sources: ResearchSource[] }

/** Everything AskPanel used to hold in useState, now store-owned. */
export interface PanelState {
  text: string
  ack: string
  intent: ValidatedIntent | null
  note: string
  busy: boolean
  caughtError: ProxyError | null
  executionNote: string
  coverageNote: string
  research: PanelResearchState
}

/** One answer request, as App's answer layer consumes it. */
export interface SessionAnswerRequest {
  id: number
  intent: ValidatedIntent
  queryText: string
}

/** The answer column's state, formerly App useState, now store-owned. */
export interface AnswerState {
  request: SessionAnswerRequest | null
  answer: ComposedAnswer | null
  note: { id: number; text: string } | null
  generalAnswer: GeneralAnswerData | null
  generalNote: string | null
  modal: ModalState
}

/**
 * The staged-status stages (item 17 part b), in the order a run can
 * reach them. Each is emitted only at the moment the real stage
 * begins: 'understanding' at the parse (AskPanel), 'screening' when
 * the answer layer takes the request and again at the pipeline's
 * deterministic screen, 'researching' only at an actual research
 * call site inside the pipeline, 'composing' and 'verifying' at the
 * pipeline's own compose/verify stages, 'jev' only when the Jev loop
 * is actually invoked, and the two Wonder bookend stages only when
 * their transports are actually called. A stage that did not run is
 * never named.
 */
export type StageId =
  | 'understanding'
  | 'screening'
  | 'researching'
  | 'composing'
  | 'verifying'
  | 'jev'
  | 'wonder-plan'
  | 'wonder-verify'

export interface StageState {
  /** The run this stage belongs to; superseded runs cannot move it. */
  runToken: number
  stage: StageId
  /** Reader's-own-words subject for a long stage, when the data supports one. */
  subject: string | null
  /** When the RUN began (not the stage): the 1-second rule times the whole wait. */
  startedAt: number
}

export interface SessionSnapshot {
  panel: PanelState
  answer: AnswerState
  stage: StageState | null
}

const STAGE_LABELS: Record<StageId, string> = {
  understanding: 'Understanding your question',
  screening: 'Screening the Census data',
  researching: 'Researching',
  composing: 'Composing your answer',
  verifying: 'Verifying the figures',
  jev: 'Checking the answer with Jev',
  'wonder-plan': 'Checking the plan with Wonder',
  'wonder-verify': 'Running the final Wonder check',
}

/**
 * The plain-words line for a stage. Research names its subject when
 * the parse supplied one (a decomposed criterion's label or the
 * named geography — the pipeline's own words for what it is
 * researching); every other stage is a fixed plain line. No
 * percentages, no invented granularity.
 */
export function stageLabel(stage: StageId, subject?: string | null): string {
  if (stage === 'researching' && subject) return `Researching ${subject}`
  return STAGE_LABELS[stage]
}

/**
 * The 1-second rule (owner's words, 2026-11-02: status "if it's going
 * to take more than one second"): under this threshold the ack frame
 * alone is the working state; past it the visual indicator (the
 * thinking dots and the staged line) joins it — and only while a
 * run's stage is active, so the predicate is false for a mount with
 * no run behind it.
 */
export const STAGED_STATUS_THRESHOLD_MS = 1000

export function stagedStatusVisible(stage: StageState | null, now: number): boolean {
  return stage !== null && now - stage.startedAt >= STAGED_STATUS_THRESHOLD_MS
}

export const ASK_SESSION_STORAGE_KEY = 'civicscope.ask-session.v1'

/** The minimal storage shape (sessionStorage in the browser, a stub in tests). */
export interface SessionStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** sessionStorage when it exists and works, else null (private modes throw). */
export function defaultSessionStorage(): SessionStorageLike | null {
  try {
    const candidate = (globalThis as { sessionStorage?: unknown }).sessionStorage
    if (
      candidate &&
      typeof (candidate as SessionStorageLike).getItem === 'function' &&
      typeof (candidate as SessionStorageLike).setItem === 'function'
    ) {
      return candidate as SessionStorageLike
    }
  } catch {
    return null
  }
  return null
}

export function initialPanelState(): PanelState {
  return {
    text: '',
    ack: '',
    intent: null,
    note: '',
    busy: false,
    caughtError: null,
    executionNote: '',
    coverageNote: '',
    research: { status: 'idle' },
  }
}

export function initialAnswerState(): AnswerState {
  return {
    request: null,
    answer: null,
    note: null,
    generalAnswer: null,
    generalNote: null,
    modal: initialModalState(),
  }
}

export function initialSessionSnapshot(): SessionSnapshot {
  return { panel: initialPanelState(), answer: initialAnswerState(), stage: null }
}

/**
 * The persistence projection for the answer slice (indicator
 * lifecycle cure, 2026-11-02): a request whose run was still in
 * flight — no composed answer and no terminal note landed — does
 * not survive a reload. Busy and the stage state were already
 * projected out on exactly this reasoning (an in-flight run cannot
 * resume across a page load), but the request itself survived, and
 * the answer area keys its working-state mount off the request
 * alone: a restored in-flight request rendered the ack + thinking
 * dots forever, with no run behind them — its re-driven compose's
 * result is discarded by the per-page-life supersession guard in
 * App, so no terminal ever arrived (audit evidence C4a/C4b). A
 * request that DID land — an answer or a note — survives whole.
 * Applied on both sides of the storage boundary: serialize never
 * writes the phantom, and deserialize drops one written by an
 * earlier build.
 */
function projectAnswerForPersistence(answer: AnswerState): AnswerState {
  if (answer.request !== null && answer.answer === null && answer.note === null) {
    return { ...answer, request: null }
  }
  return answer
}

/**
 * The reload-persistence projection (see the file header for the
 * exact survives / does-not-survive contract): busy, a loading
 * research state, the ack, a transient error, a live modal, the
 * stage state, and an unlanded answer request are all reset rather
 * than serialized, because none of them can truthfully resume
 * after a page load.
 */
export function serializeSession(snapshot: SessionSnapshot): string {
  const { panel, answer } = snapshot
  const projectedAnswer = projectAnswerForPersistence(answer)
  return JSON.stringify({
    v: 1,
    panel: {
      ...panel,
      busy: false,
      ack: '',
      caughtError: null,
      research:
        panel.research.status === 'loading' ? { status: 'idle' } : panel.research,
    },
    answer: {
      request: projectedAnswer.request,
      answer: projectedAnswer.answer,
      note: projectedAnswer.note,
      generalAnswer: projectedAnswer.generalAnswer,
      generalNote: projectedAnswer.generalNote,
      modal: {
        live: null,
        closedBranches: [...answer.modal.closedBranches],
        refinedBranches: [...answer.modal.refinedBranches],
      },
    },
  })
}

/** Parse a persisted session back; any doubt returns null (a fresh session). */
export function deserializeSession(raw: string | null): SessionSnapshot | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown
      panel?: Partial<PanelState>
      answer?: Partial<AnswerState> & {
        modal?: { closedBranches?: unknown; refinedBranches?: unknown }
      }
    }
    if (parsed.v !== 1 || !parsed.panel || !parsed.answer) return null
    const panel: PanelState = { ...initialPanelState(), ...parsed.panel, busy: false }
    const closed = Array.isArray(parsed.answer.modal?.closedBranches)
      ? (parsed.answer.modal.closedBranches as ModalState['closedBranches'])
      : []
    const refined = Array.isArray(parsed.answer.modal?.refinedBranches)
      ? (parsed.answer.modal.refinedBranches as ModalState['refinedBranches'])
      : []
    const answer: AnswerState = projectAnswerForPersistence({
      ...initialAnswerState(),
      ...parsed.answer,
      modal: {
        live: null,
        closedBranches: new Set(closed) as ModalState['closedBranches'],
        refinedBranches: new Set(refined) as ModalState['refinedBranches'],
      },
    })
    return { panel, answer, stage: null }
  } catch {
    return null
  }
}

export class AskSessionStore {
  private snapshot: SessionSnapshot
  private listeners = new Set<() => void>()
  private readonly storage: SessionStorageLike | null
  private readonly nowFn: () => number
  private stageTokenSeq = 0
  private readonly inFlight = new Map<string, Promise<unknown>>()

  /**
   * The run counters AskPanel used to keep in refs (research and
   * execution supersession, the ack rotation, the last question
   * text). Plain mutable fields on the store: they must survive
   * unmount exactly like the state does, or a remounted panel would
   * accept a superseded run's late result.
   */
  readonly counters = {
    researchRun: 0,
    executionRun: 0,
    lastAckOpener: null as string | null,
    lastQueryText: '',
    /**
     * The answer request that was current when the panel's latest
     * run began (indicator lifecycle cure): the panel's working
     * frame stands down once a DIFFERENT request object — minted by
     * the answer layer's adoption of this run — is current, so the
     * parse→compose hand-off has exactly one frame owner. Object
     * identity, not question text: re-asking the same question
     * keeps the parse frame until its own hand-off lands.
     */
    requestAtRunStart: null as SessionAnswerRequest | null,
  }

  constructor(storage: SessionStorageLike | null = defaultSessionStorage(), now: () => number = () => Date.now()) {
    this.storage = storage
    this.nowFn = now
    let restored: SessionSnapshot | null = null
    if (storage) {
      try {
        restored = deserializeSession(storage.getItem(ASK_SESSION_STORAGE_KEY))
      } catch {
        restored = null
      }
    }
    this.snapshot = restored ?? initialSessionSnapshot()
  }

  /** useSyncExternalStore contract: stable references, bound once. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): SessionSnapshot => this.snapshot

  now(): number {
    return this.nowFn()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
    if (this.storage) {
      try {
        this.storage.setItem(ASK_SESSION_STORAGE_KEY, serializeSession(this.snapshot))
      } catch {
        // A full or blocked sessionStorage must never break the session.
      }
    }
  }

  setPanel(patch: Partial<PanelState>): void {
    this.snapshot = { ...this.snapshot, panel: { ...this.snapshot.panel, ...patch } }
    this.emit()
  }

  setAnswerState(patch: Partial<AnswerState>): void {
    this.snapshot = { ...this.snapshot, answer: { ...this.snapshot.answer, ...patch } }
    this.emit()
  }

  updateModal(fn: (modal: ModalState) => ModalState): void {
    this.setAnswerState({ modal: fn(this.snapshot.answer.modal) })
  }

  /* ---------------- staged status ---------------- */

  /** Begin a run's stage clock at 'understanding'; returns its token. */
  beginStageRun(first: StageId = 'understanding'): number {
    const runToken = ++this.stageTokenSeq
    this.snapshot = {
      ...this.snapshot,
      stage: { runToken, stage: first, subject: null, startedAt: this.nowFn() },
    }
    this.emit()
    return runToken
  }

  /** The active run's token, beginning a screening run when none is active. */
  ensureStageRun(): number {
    return this.snapshot.stage?.runToken ?? this.beginStageRun('screening')
  }

  stageToken(): number | null {
    return this.snapshot.stage?.runToken ?? null
  }

  /**
   * Advance the stage. A superseded run's token cannot move the
   * current run's stage, and re-setting the same stage + subject is
   * a no-op — the aria-live discipline starts here: subscribers (and
   * the live region) only ever see real transitions.
   */
  setStage(runToken: number, stage: StageId, subject: string | null = null): void {
    const current = this.snapshot.stage
    if (!current || current.runToken !== runToken) return
    if (current.stage === stage && current.subject === subject) return
    this.snapshot = { ...this.snapshot, stage: { ...current, stage, subject } }
    this.emit()
  }

  /** End a run's stage display; a stale token cannot clear a newer run's. */
  clearStage(runToken?: number): void {
    const current = this.snapshot.stage
    if (!current) return
    if (runToken !== undefined && current.runToken !== runToken) return
    this.snapshot = { ...this.snapshot, stage: null }
    this.emit()
  }

  /* ---------------- in-flight runs ---------------- */

  /**
   * Register a run's promise as session-owned in-flight work. The
   * registry is the store's handle on the run: it survives every
   * unmount, and the run's own completion handlers (which close over
   * this store) write their results here whether or not any surface
   * is mounted to see them land.
   */
  trackRun<T>(key: string, run: Promise<T>): Promise<T> {
    this.inFlight.set(key, run as Promise<unknown>)
    const settle = () => {
      if (this.inFlight.get(key) === (run as Promise<unknown>)) this.inFlight.delete(key)
    }
    run.then(settle, settle)
    return run
  }

  inFlightKeys(): string[] {
    return [...this.inFlight.keys()]
  }
}
