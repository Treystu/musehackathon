import type { ComposedAnswer } from '../../core/ai/answer'
import type { RunProgressSnapshot } from '../../core/ai/run-progress'
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
 * Persistence: NONE across a page load (refresh-starts-clean cure,
 * 2026-11-02, owner live finding: "somehow my refreshing (hard
 * refresh even) is keeping the query in the tool... ensure that
 * caching isn't too sticky"). Item 17 originally wrote the
 * serializable session to sessionStorage on every change, so a
 * reload restored the thread: the question text, the understood
 * request, the panel notes, finished web research, the last answer
 * request with its landed outcome, the general lane's answer/note,
 * and the modal branch sets. That restore is retired: the store is
 * memory-only, a page load starts a clean session — empty question
 * box, no restored answer presented as the standing state — and
 * the query/thread now follows the same contract the indicator
 * lifecycle cure already established for runs (an in-flight run
 * does not resume across a load). What item 17's ownership change
 * exists for is untouched: within one page life the store lives
 * above the tab surfaces, so Ask → Map → back preserves the
 * in-flight run and the thread exactly as before. State a reader
 * deliberately carries across loads travels by its own channels,
 * unchanged: shared-link decisions in the URL, and the reader's own
 * keys and saved searches in their own stores.
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

/**
 * The input modality an answer request was created from (Lane A8):
 * 'voice' exactly when the request's originating submission was an
 * accepted mic transcript, 'typed' for every other creation path
 * (typed submit, example chips, retries). A property of the
 * REQUEST, stamped at creation — never of the session: the voice
 * layer reads the landed terminal's own stamp to decide speech, so
 * a later submission cannot silence a voice run's answer or make a
 * typed run speak. Continuations (a clarification pick, a decision
 * refinement) mint or refine the stamped request and inherit it.
 */
export type AnswerRequestOrigin = 'voice' | 'typed'

/** One answer request, as App's answer layer consumes it. */
export interface SessionAnswerRequest {
  id: number
  intent: ValidatedIntent
  queryText: string
  /**
   * The ask generation that minted this request (ask-surface reset
   * cure, 2026-11-02): App stamps each request with the askEpoch
   * current when the answer layer adopts the run. Optional only so
   * requests seeded directly in tests read as generation 0 — every
   * live mint sets it.
   */
  epoch?: number
}

/** The answer column's state, formerly App useState, now store-owned. */
export interface AnswerState {
  request: SessionAnswerRequest | null
  answer: ComposedAnswer | null
  note: { id: number; text: string } | null
  generalAnswer: GeneralAnswerData | null
  generalNote: string | null
  modal: ModalState
  /**
   * The ask generation (ask-surface reset cure, 2026-11-02): bumped
   * by App at every new ask's start, before the parse. The Ask
   * surface renders a landed answer or note only when the request
   * that produced it belongs to the current generation, so a
   * previous run's outcome can never stand as — or beside — the new
   * run's. The Map tab's contract is untouched: it reads the last
   * landed answer itself, not this generation gate.
   */
  askEpoch: number
  /**
   * The terminal run summary ("Complete — N of N checks done · K
   * places assessed", Lane A7), stamped by the view at the same
   * terminal moment the answer lands and keyed to its request: it
   * renders above that request's card or note and is dropped when
   * a new ask begins, so a summary can never outlive its own run
   * or drift onto another's card.
   */
  runSummary: { requestId: number; text: string } | null
  /**
   * The landed request's origin stamp (Lane A8), written by App in
   * the same store write that mints the request and keyed to it:
   * the voice layer speaks a terminal only when the terminal's own
   * request carries source 'voice' here. A stamp for a superseded
   * request can never match a later request's id, so it needs no
   * clearing — the same keyed discipline as runSummary.
   */
  requestOrigin: { requestId: number; source: AnswerRequestOrigin } | null
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
  /**
   * When the CURRENT stage began: stamped at the run's start and on
   * every real transition (including a subject change — that stage
   * did begin then). The ~30s situational line (Lane A7) reads the
   * current stage's age from here, distinct from startedAt: the
   * update speaks about the stage the reader is looking at.
   */
  stageSince: number
  /**
   * The run's latest progress snapshot (Lane A7): typed verdict
   * data only — passes done/planned, per-place interim standings —
   * kept beside the stage rather than inside the AnswerState enum
   * for the same reason the stage itself lives here: supersession
   * is judged on the run token, atomically, so a late snapshot from
   * a superseded run is dropped by the same guard as a late stage
   * call. Survives stage transitions (the percent must not reset
   * when research hands off to compose); dropped with the stage at
   * clearStage.
   */
  progress: RunProgressSnapshot | null
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
    askEpoch: 0,
    runSummary: null,
    requestOrigin: null,
  }
}

export function initialSessionSnapshot(): SessionSnapshot {
  return { panel: initialPanelState(), answer: initialAnswerState(), stage: null }
}

export class AskSessionStore {
  private snapshot: SessionSnapshot
  private listeners = new Set<() => void>()
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

  /**
   * Memory-only (refresh-starts-clean cure, see the file header):
   * the constructor takes no storage because there is nothing to
   * restore from — every page life starts from the initial
   * snapshot, and within the page life this one instance carries
   * the session across tab switches.
   */
  constructor(now: () => number = () => Date.now()) {
    this.nowFn = now
    this.snapshot = initialSessionSnapshot()
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
    const now = this.nowFn()
    this.snapshot = {
      ...this.snapshot,
      stage: { runToken, stage: first, subject: null, startedAt: now, stageSince: now, progress: null },
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
    this.snapshot = {
      ...this.snapshot,
      stage: { ...current, stage, subject, stageSince: this.nowFn() },
    }
    this.emit()
  }

  /**
   * Record the run's latest progress snapshot. Token-guarded like
   * setStage: a superseded run's late snapshot is dropped, and the
   * snapshot is kept across stage transitions (setStage spreads the
   * stage record), so the reader's percent never restarts when the
   * run moves on to composing.
   */
  setStageProgress(runToken: number, progress: RunProgressSnapshot): void {
    const current = this.snapshot.stage
    if (!current || current.runToken !== runToken) return
    this.snapshot = { ...this.snapshot, stage: { ...current, progress } }
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
