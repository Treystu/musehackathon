/**
 * Async decision modals: the branch catalog, the specificity rule,
 * and the decision state (plan C7 + C8).
 *
 * A branch may interject only when it is catalogued here — a defined
 * option set and defined interpretation effects (plan C3). Phrasing
 * is GENERATED from the live ask by phraseBranchQuestion, never a
 * template constant: the sentence names the actual subject and the
 * decision it drives; the options carry the mechanics.
 *
 * Decision state lives in the same channels the shipped follow-up
 * machinery uses — session storage plus the URL — as a `decisions`
 * record: branch id -> chosen option (e.g. `transport: no-car`).
 * A decision already in state is never re-asked (asked once, reused —
 * the standing follow-up rule).
 */
import { applicableModes, modeListText, type NearbyMode } from './nearby'

export type BranchId = 'transport' | 'school-level' | 'budget-anchor'

export interface BranchOption {
  id: string
  label: string
}

export interface BranchDefinition {
  id: BranchId
  /** The research criterion ids this branch can split the interpretation of. */
  criterionIds: readonly string[]
  options: readonly BranchOption[]
  /** Quiet dismissal copy — a first-class option, never a decision. */
  dismissLabel: string
}

/**
 * The catalogued branches (plan C7). Transport splits a proximity
 * criterion; school level splits a schools criterion; budget anchor
 * splits an affordability (Census cost) criterion.
 */
export const BRANCH_CATALOG: Readonly<Record<BranchId, BranchDefinition>> = {
  transport: {
    id: 'transport',
    criterionIds: ['coffee', 'groceries', 'restaurants', 'fast_food', 'amenities'],
    options: [
      { id: 'car', label: 'Yes' },
      { id: 'no-car', label: 'No' },
    ],
    dismissLabel: 'Use the comprehensive view',
  },
  'school-level': {
    id: 'school-level',
    criterionIds: ['schools'],
    options: [
      { id: 'elementary', label: 'Elementary' },
      { id: 'middle', label: 'Middle school' },
      { id: 'high', label: 'High school' },
      { id: 'all', label: 'All levels' },
    ],
    dismissLabel: 'Count all levels',
  },
  'budget-anchor': {
    id: 'budget-anchor',
    criterionIds: ['median_gross_rent', 'median_rent_burden_pct', 'median_home_value'],
    options: [
      { id: 'rent-only', label: 'Rent alone' },
      { id: 'total-cost', label: 'Rent plus utilities' },
    ],
    dismissLabel: 'Answer either way',
  },
}

export function branchDefinition(branch: string): BranchDefinition | null {
  return (BRANCH_CATALOG as Record<string, BranchDefinition>)[branch] ?? null
}

/* ------------------------------------------------------------------ */
/* C8 — the specificity rule                                           */
/* ------------------------------------------------------------------ */

/**
 * The researched subject a modal question names, read from the
 * reader's question: the catalogued entity the criterion is about
 * ("these nearby Starbucks" for a coffee criterion), falling back to
 * the criterion's own plain subject. Deterministic and lexical — the
 * phrasing must be a pure function of its inputs so the J-PHRASE
 * fixture can pin it.
 */
export function subjectForCriterion(criterionId: string, question: string): string {
  const lower = question.toLowerCase()
  if (criterionId === 'coffee') {
    if (lower.includes('starbucks')) return 'these nearby Starbucks'
    return 'coffee shops near these places'
  }
  if (criterionId === 'schools') return 'schools in this area'
  if (criterionId === 'groceries') return 'grocery stores near these places'
  if (criterionId === 'restaurants' || criterionId === 'fast_food') {
    return 'restaurants near these places'
  }
  if (criterionId === 'amenities') return 'the places nearby'
  if (
    criterionId === 'median_gross_rent' ||
    criterionId === 'median_rent_burden_pct' ||
    criterionId === 'median_home_value'
  ) {
    return 'the cost of living in these places'
  }
  return 'these places'
}

/**
 * phraseBranchQuestion(branch, question, criterion, subject) -> string
 * (plan annex C8, exact signature). Pure. The frame per branch is
 * fixed in shape; the subject and the decision it drives are the live
 * ask's own. The transport frame is the owner's template verbatim:
 * "Quick question — would you be using a car to get to <subject>?"
 */
export function phraseBranchQuestion(
  branch: BranchId,
  question: string,
  criterion: string,
  subject: string,
): string {
  void question
  void criterion
  switch (branch) {
    case 'transport':
      return `Quick question — would you be using a car to get to ${subject}?`
    case 'school-level':
      return `Quick question — which school level should count for ${subject}?`
    case 'budget-anchor':
      return `Quick question — for ${subject}, should the budget be read as rent alone, or rent plus utilities?`
  }
}

/**
 * The one permitted rephrase (plan C8): the same frame with the
 * criterion named in the sentence, for when the first draft reads too
 * generic to pass J-PHRASE. Still pure, still names the subject.
 */
export function rephraseBranchQuestion(
  branch: BranchId,
  criterionLabel: string,
  subject: string,
): string {
  switch (branch) {
    case 'transport':
      return `Quick question — when judging ${criterionLabel.toLowerCase()} (${subject}), would you be using a car to get there?`
    case 'school-level':
      return `Quick question — for ${criterionLabel.toLowerCase()} (${subject}), which school level should count?`
    case 'budget-anchor':
      return `Quick question — for ${criterionLabel.toLowerCase()} (${subject}), should the budget be read as rent alone, or rent plus utilities?`
  }
}

/* ------------------------------------------------------------------ */
/* Interpretation effects                                              */
/* ------------------------------------------------------------------ */

/**
 * What a landed decision changes, per branch (plan C7: the re-prompt
 * is targeted at the affected stage only). Transport changes the
 * research stage's proximity evaluation; school level and budget
 * anchor change the research focus for their criterion. The screen
 * does not re-run unless a decision changes a Census criterion —
 * none of the catalogued branches do.
 */
export interface DecisionEffect {
  branch: BranchId
  option: string
  /** The stage the refinement re-runs. */
  stage: 'research'
  /** Focus text the affected stage is re-prompted with. */
  focusText: string
  /** Applicable nearby modes, for the transport branch. */
  modes?: NearbyMode[]
}

export function decisionEffect(branch: BranchId, option: string): DecisionEffect {
  if (branch === 'transport') {
    const modes = applicableModes(option)
    return {
      branch,
      option,
      stage: 'research',
      modes,
      focusText:
        option === 'no-car'
          ? 'The reader has no car: count a place as near only when it is reachable by walking, biking, or a short public transit ride.'
          : 'The reader uses a car: count a place as near when it is reachable by a short drive, walking, biking, or a short public transit ride.',
    }
  }
  if (branch === 'school-level') {
    const levelText =
      option === 'all' ? 'schools of every level' : `${option} schools`
    return {
      branch,
      option,
      stage: 'research',
      focusText: `The reader is asking about ${levelText}: weigh findings about that level and say which level each finding describes.`,
    }
  }
  return {
    branch,
    option,
    stage: 'research',
    focusText:
      option === 'total-cost'
        ? 'The reader reads the budget as rent plus utilities: weigh total housing cost findings, not rent alone.'
        : 'The reader reads the budget as rent alone: weigh rent findings, not total housing cost.',
  }
}

/**
 * The refinement note a refined answer carries (plan C7, one line,
 * in place): "Refined with your answer: no car — walking, biking,
 * and short transit counted as near." Wording is built from the
 * decision's own effect so the note states what actually changed.
 */
export function refinementNote(branch: BranchId, option: string): string {
  if (branch === 'transport') {
    const modes = applicableModes(option)
    return option === 'no-car'
      ? `Refined with your answer: no car — ${modeListText(modes)} counted as near.`
      : `Refined with your answer: car — ${modeListText(modes)} counted as near.`
  }
  if (branch === 'school-level') {
    return `Refined with your answer: ${option === 'all' ? 'all school levels' : `${option} schools`} counted.`
  }
  return `Refined with your answer: budget read as ${option === 'total-cost' ? 'rent plus utilities' : 'rent alone'}.`
}

/* ------------------------------------------------------------------ */
/* Decision state: session + URL (the follow-up state channel)         */
/* ------------------------------------------------------------------ */

export type DecisionsRecord = Partial<Record<BranchId, string>>

export const DECISIONS_URL_PARAM = 'decisions'
export const DECISIONS_SESSION_KEY = 'civicscope.decisions'

/** Serialize the record for the URL: `transport=no-car,school-level=high`. */
export function serializeDecisions(decisions: DecisionsRecord): string {
  return Object.entries(decisions)
    .filter(([, option]) => typeof option === 'string' && option !== '')
    .map(([branch, option]) => `${branch}=${option}`)
    .join(',')
}

/** Parse the URL form back; unknown branches and options are dropped, never trusted. */
export function parseDecisions(text: string | null | undefined): DecisionsRecord {
  if (!text) return {}
  const record: DecisionsRecord = {}
  for (const pair of text.split(',')) {
    const [branch, option] = pair.split('=')
    const definition = branch ? branchDefinition(branch.trim()) : null
    if (!definition || !option) continue
    if (definition.options.some((o) => o.id === option.trim())) {
      record[definition.id] = option.trim()
    }
  }
  return record
}

/** The query string with the decisions parameter set (additive, like the intent param). */
export function withDecisionsParam(search: string, decisions: DecisionsRecord): string {
  const params = new URLSearchParams(search)
  const serialized = serializeDecisions(decisions)
  if (serialized) params.set(DECISIONS_URL_PARAM, serialized)
  else params.delete(DECISIONS_URL_PARAM)
  return params.toString()
}

export function decisionsFromSearch(search: string | URLSearchParams): DecisionsRecord {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  return parseDecisions(params.get(DECISIONS_URL_PARAM))
}

export interface DecisionsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserSessionStorage(): DecisionsStorage | null {
  try {
    const candidate = (globalThis as { sessionStorage?: unknown }).sessionStorage
    if (
      candidate &&
      typeof (candidate as DecisionsStorage).getItem === 'function' &&
      typeof (candidate as DecisionsStorage).setItem === 'function'
    ) {
      return candidate as DecisionsStorage
    }
  } catch {
    // Storage can throw in locked-down contexts; decisions then live in memory only.
  }
  return null
}

let memoryDecisions: DecisionsRecord = {}

/** Read the session's landed decisions (session storage, memory fallback). */
export function readSessionDecisions(
  storage: DecisionsStorage | null = browserSessionStorage(),
): DecisionsRecord {
  if (!storage) return { ...memoryDecisions }
  try {
    const raw = storage.getItem(DECISIONS_SESSION_KEY)
    if (!raw) return { ...memoryDecisions }
    return { ...memoryDecisions, ...parseDecisions(raw) }
  } catch {
    return { ...memoryDecisions }
  }
}

/** Write one landed decision into session state (and memory, as the fallback copy). */
export function writeSessionDecision(
  branch: BranchId,
  option: string,
  storage: DecisionsStorage | null = browserSessionStorage(),
): DecisionsRecord {
  const next = { ...readSessionDecisions(storage), [branch]: option }
  memoryDecisions = next
  if (storage) {
    try {
      storage.setItem(DECISIONS_SESSION_KEY, serializeDecisions(next))
    } catch {
      // The memory copy above still carries the decision for this session.
    }
  }
  return next
}

/** Test seam: reset the in-memory fallback. */
export function resetSessionDecisionsForTests(): void {
  memoryDecisions = {}
}

/* ------------------------------------------------------------------ */
/* C7 — the modal state machine                                        */
/* ------------------------------------------------------------------ */

/**
 * Modal lifecycle (plan C7 + annex expiry). A modal expires when
 * (a) it is answered, (b) it is dismissed, (c) a new question is
 * submitted, or (d) the answer it floated over is refined once by
 * another decision. An expired unanswered modal leaves the
 * comprehensive default in force and is not re-shown for that branch
 * in that session. One modal at a time; a decision in state is never
 * re-asked.
 */
export interface ModalState {
  /** The live modal, or null. */
  live: {
    branch: BranchId
    questionText: string
    /** The answer/question run this modal floats over. */
    runId: number
  } | null
  /** Branches closed for this session (answered, dismissed, or expired unanswered). */
  closedBranches: ReadonlySet<BranchId>
  /** Branches whose answer has been refined once — the refine-once cap. */
  refinedBranches: ReadonlySet<BranchId>
}

export function initialModalState(): ModalState {
  return { live: null, closedBranches: new Set(), refinedBranches: new Set() }
}

/**
 * Whether a branch may be proposed at all: no live modal, the branch
 * not already closed, and no landed decision for it (never re-ask).
 */
export function canPropose(
  state: ModalState,
  branch: BranchId,
  decisions: DecisionsRecord,
): boolean {
  if (state.live) return false
  if (state.closedBranches.has(branch)) return false
  if (decisions[branch] !== undefined) return false
  return true
}

export function proposeModal(
  state: ModalState,
  proposal: { branch: BranchId; questionText: string; runId: number },
  decisions: DecisionsRecord,
): ModalState {
  if (!canPropose(state, proposal.branch, decisions)) return state
  return { ...state, live: { ...proposal } }
}

/** Land a decision: the modal closes and the branch is decided (never re-asked). */
export function landModal(state: ModalState): ModalState {
  if (!state.live) return state
  const closed = new Set(state.closedBranches)
  closed.add(state.live.branch)
  return { ...state, live: null, closedBranches: closed }
}

/** Dismiss: not a decision — the provisional stands, the branch closes for the session. */
export function dismissModal(state: ModalState): ModalState {
  if (!state.live) return state
  const closed = new Set(state.closedBranches)
  closed.add(state.live.branch)
  return { ...state, live: null, closedBranches: closed }
}

/** A new question expires any live modal unanswered (annex expiry (c)). */
export function expireModalForNewQuestion(state: ModalState): ModalState {
  if (!state.live) return state
  const closed = new Set(state.closedBranches)
  closed.add(state.live.branch)
  return { ...state, live: null, closedBranches: closed }
}

/**
 * Mark a branch's answer refined (refine-once): any other live modal
 * expires (annex expiry (d)), and the refined branch cannot refine
 * again for this question.
 */
export function markRefined(state: ModalState, branch: BranchId): ModalState {
  const refined = new Set(state.refinedBranches)
  refined.add(branch)
  if (!state.live) return { ...state, refinedBranches: refined }
  const closed = new Set(state.closedBranches)
  closed.add(state.live.branch)
  return { ...state, live: null, closedBranches: closed, refinedBranches: refined }
}

export function canRefine(state: ModalState, branch: BranchId): boolean {
  return !state.refinedBranches.has(branch)
}
