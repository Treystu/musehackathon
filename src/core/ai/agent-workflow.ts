/**
 * F5a agent-onboarding workflow — the executable semantics of
 * docs/agent-onboarding/workflow.v1.json (plan §6.2.5, §6.5.4).
 *
 * Two properties are structural, not promised:
 *
 * 1. There is no function here that accepts a key. A run advances past a
 *    key-entry step only when the app's own re-validation event for that
 *    key is observed (CENSUS_KEY_EVENT / META_KEY_EVENT — the same events
 *    the key modules dispatch when the app itself validates and stores a
 *    key). An agent saying "the key is X" or "the key works" moves nothing.
 *
 * 2. An unexpected screen aborts the run before any key entry and hands
 *    off to the manual path (F5b) at the equivalent step, with key state
 *    reported by presence only. Key material cannot appear in a run state,
 *    because a run state never holds any.
 *
 * The graph itself lives in the versioned JSON artefact; this module is
 * its validator and interpreter, and the tests pin the two together.
 */
import { CENSUS_KEY_EVENT } from '../censusKey'
import { META_KEY_EVENT } from './meta-key'

export type WorkflowPathId = 'census' | 'meta'

export type FailureGoto = 'abort-to-manual' | 'report-and-stop' | 'wait'

export interface WorkflowFailureBranch {
  when: string
  goto: FailureGoto | string
  note: string
}

export interface WorkflowApproval {
  /** Named approval point, e.g. "before-credential-handled". */
  point: string
  label: string
}

export interface WorkflowStep {
  id: string
  action: string
  checkpoint: { expect: string }
  humanApproval: WorkflowApproval | null
  /** True for the step where credential material is handled. */
  keyEntry: boolean
  /**
   * "checkpoint": the step completes when its checkpoint is observed.
   * "app-event": the step completes only when the app's own re-validation
   * event (successEvent) is observed — never on an agent's report.
   */
  completion: 'checkpoint' | 'app-event'
  successEvent?: string
  /** The F5b manual-wizard step an abort at this step hands off to. */
  manualEquivalent: string
  onFailure: WorkflowFailureBranch[]
  next: string | null
}

export interface WorkflowKeyInfo {
  label: string
  providerPage: string
  storage: string
  successEvent: string
  manualPath: string
}

export interface WorkflowGraph {
  workflow: string
  version: string
  purpose: string
  keys: Record<WorkflowPathId, WorkflowKeyInfo>
  abortPolicy: {
    unexpectedScreen: string
    keyMaterial: string
    emailSearch: string
  }
  paths: Record<WorkflowPathId, WorkflowStep[]>
}

export const WORKFLOW_VERSION = '1.0.0'

/** The success event each path's key-entry step must be confirmed by. */
export const PATH_SUCCESS_EVENT: Record<WorkflowPathId, string> = {
  census: CENSUS_KEY_EVENT,
  meta: META_KEY_EVENT,
}

/**
 * Status of the independent clean-account run (§6.2.5). No recorded run
 * means not done; this constant is the only place the UI reads it from,
 * and it stays PENDING until a non-author's run is recorded in
 * docs/agent-onboarding/run-record.md.
 */
export const AGENT_ONBOARDING_RUN_STATUS = 'PENDING' as const

const BUILTIN_GOTOS: ReadonlySet<string> = new Set(['abort-to-manual', 'report-and-stop', 'wait'])

/**
 * Structural validation of a parsed workflow graph. Returns a list of
 * problems; an empty list means the graph satisfies the §6.5.4 semantics:
 * both key paths present, every step checkpointed, approval points named,
 * every step reachable, an abort branch at every step where a screen can
 * surprise, and key-entry steps gated on the app's own event.
 */
export function validateWorkflowGraph(graph: WorkflowGraph): string[] {
  const problems: string[] = []
  if (!graph || typeof graph !== 'object') return ['graph is not an object']
  if (graph.workflow !== 'civicscope-agent-onboarding') {
    problems.push(`unexpected workflow name: ${String(graph.workflow)}`)
  }
  if (!graph.version) problems.push('missing version')

  const pathIds: WorkflowPathId[] = ['census', 'meta']
  for (const pathId of pathIds) {
    const info = graph.keys?.[pathId]
    if (!info) {
      problems.push(`missing key info for path ${pathId}`)
      continue
    }
    if (info.successEvent !== PATH_SUCCESS_EVENT[pathId]) {
      problems.push(
        `${pathId}: successEvent "${info.successEvent}" does not match the app's event "${PATH_SUCCESS_EVENT[pathId]}"`,
      )
    }
    const steps = graph.paths?.[pathId]
    if (!steps || steps.length === 0) {
      problems.push(`path ${pathId} has no steps`)
      continue
    }
    const byId = new Map(steps.map((s) => [s.id, s]))
    if (byId.size !== steps.length) problems.push(`path ${pathId} has duplicate step ids`)

    let approvals = 0
    let keyEntrySteps = 0
    for (const step of steps) {
      if (!step.action) problems.push(`${step.id}: missing action`)
      if (!step.checkpoint?.expect) problems.push(`${step.id}: missing checkpoint expectation`)
      if (!step.manualEquivalent) problems.push(`${step.id}: missing manualEquivalent (abort handoff target)`)
      if (step.next !== null && !byId.has(step.next)) {
        problems.push(`${step.id}: next "${step.next}" is not a step in path ${pathId}`)
      }
      if (step.humanApproval) {
        approvals += 1
        if (!step.humanApproval.point || !step.humanApproval.label) {
          problems.push(`${step.id}: approval point must be named (point + label)`)
        }
      }
      if (step.keyEntry) {
        keyEntrySteps += 1
        if (step.completion !== 'app-event') {
          problems.push(`${step.id}: key-entry step must complete via the app event, not a checkpoint`)
        }
        if (step.successEvent !== PATH_SUCCESS_EVENT[pathId]) {
          problems.push(`${step.id}: key-entry successEvent must be "${PATH_SUCCESS_EVENT[pathId]}"`)
        }
        if (!step.humanApproval || step.humanApproval.point !== 'before-credential-handled') {
          problems.push(`${step.id}: key-entry step requires the before-credential-handled approval point`)
        }
      }
      for (const branch of step.onFailure ?? []) {
        if (!BUILTIN_GOTOS.has(branch.goto) && !byId.has(branch.goto)) {
          problems.push(`${step.id}: failure branch "${branch.when}" goes to unknown target "${branch.goto}"`)
        }
      }
      // A screen can surprise at any step that faces the user; every such
      // step except a terminal report step needs an abort route.
      if (step.next !== null) {
        const hasAbort = (step.onFailure ?? []).some((b) => b.goto === 'abort-to-manual')
        if (!hasAbort) problems.push(`${step.id}: no abort-to-manual failure branch`)
      }
    }
    if (approvals === 0) problems.push(`path ${pathId} has no human-approval points`)
    if (keyEntrySteps !== 1) {
      problems.push(`path ${pathId} must have exactly one key-entry step, found ${keyEntrySteps}`)
    }

    // Reachability: walk next-links and failure gotos from the first step.
    const reachable = new Set<string>()
    const queue = [(steps[0] as WorkflowStep).id]
    while (queue.length > 0) {
      const id = queue.pop() as string
      if (reachable.has(id)) continue
      reachable.add(id)
      const step = byId.get(id)
      if (!step) continue
      if (step.next) queue.push(step.next)
      for (const branch of step.onFailure ?? []) {
        if (byId.has(branch.goto)) queue.push(branch.goto)
      }
    }
    for (const step of steps) {
      if (!reachable.has(step.id)) problems.push(`${step.id}: not reachable from the path start`)
    }
    const terminals = steps.filter((s) => s.next === null)
    if (terminals.length !== 1) {
      problems.push(`path ${pathId} must have exactly one terminal step, found ${terminals.length}`)
    }
  }
  return problems
}

/** Presence-only key state, supplied by the host app. Never key material. */
export interface KeyPresenceProbe {
  censusPresent: boolean
  metaPresent: boolean
}

export type RunStatus =
  | 'in-progress'
  | 'awaiting-approval'
  | 'waiting'
  | 'complete'
  | 'aborted'
  | 'stopped'

export interface ManualHandoff {
  /** The F5b step the user continues at — the equivalent of the abort step. */
  manualEquivalent: string
  /** Key presence at the moment of handoff. Presence only, by construction. */
  keyPresence: KeyPresenceProbe
  reason: string
}

export interface WorkflowRun {
  pathId: WorkflowPathId
  stepId: string
  status: RunStatus
  completedSteps: string[]
  approvalGrantedFor: string | null
  handoff?: ManualHandoff
  stopReport?: string
}

function stepOf(graph: WorkflowGraph, run: WorkflowRun): WorkflowStep {
  const step = graph.paths[run.pathId].find((s) => s.id === run.stepId)
  if (!step) throw new Error(`run references unknown step ${run.stepId}`)
  return step
}

export function startRun(graph: WorkflowGraph, pathId: WorkflowPathId): WorkflowRun {
  const first = graph.paths[pathId][0]
  if (!first) throw new Error(`workflow path ${pathId} has no steps`)
  return {
    pathId,
    stepId: first.id,
    status: first.humanApproval ? 'awaiting-approval' : 'in-progress',
    completedSteps: [],
    approvalGrantedFor: null,
  }
}

/** Record the human's approval at the current step's named approval point. */
export function grantApproval(graph: WorkflowGraph, run: WorkflowRun): WorkflowRun {
  const step = stepOf(graph, run)
  if (run.status !== 'awaiting-approval' || !step.humanApproval) return run
  return { ...run, status: 'in-progress', approvalGrantedFor: step.id }
}

function advance(graph: WorkflowGraph, run: WorkflowRun): WorkflowRun {
  const step = stepOf(graph, run)
  const completedSteps = [...run.completedSteps, step.id]
  if (step.next === null) {
    return { ...run, completedSteps, status: 'complete', approvalGrantedFor: null }
  }
  const next = graph.paths[run.pathId].find((s) => s.id === step.next) as WorkflowStep
  return {
    ...run,
    stepId: next.id,
    completedSteps,
    approvalGrantedFor: null,
    status: next.humanApproval ? 'awaiting-approval' : 'in-progress',
  }
}

/**
 * The agent observed the current step's checkpoint expectation.
 * Refused while an approval is outstanding, and refused at a key-entry
 * step: a checkpoint observation is an agent report, and a key is never
 * confirmed by an agent report.
 */
export function observeCheckpoint(graph: WorkflowGraph, run: WorkflowRun): WorkflowRun {
  if (run.status !== 'in-progress') return run
  const step = stepOf(graph, run)
  if (step.completion === 'app-event') return run
  return advance(graph, run)
}

/**
 * The app's own re-validation event was observed. This is the only way a
 * key-entry step completes. An event for the other key, or an event at
 * any other step, changes nothing.
 */
export function observeAppKeyEvent(
  graph: WorkflowGraph,
  run: WorkflowRun,
  eventName: string,
): WorkflowRun {
  if (run.status !== 'in-progress') return run
  const step = stepOf(graph, run)
  if (step.completion !== 'app-event') return run
  if (eventName !== PATH_SUCCESS_EVENT[run.pathId] || eventName !== step.successEvent) return run
  return advance(graph, run)
}

function abort(run: WorkflowRun, step: WorkflowStep, probe: KeyPresenceProbe, reason: string): WorkflowRun {
  return {
    ...run,
    status: 'aborted',
    handoff: {
      manualEquivalent: step.manualEquivalent,
      keyPresence: { ...probe },
      reason,
    },
  }
}

/**
 * The screen in front of the agent is not the screen the current step
 * expects. Halt before any key entry — a run that has not completed its
 * key-entry step has handled no key, and this function is the only
 * response the workflow permits — and hand off to the manual path at the
 * equivalent step, with key state reported by presence only.
 */
export function observeUnexpectedScreen(
  graph: WorkflowGraph,
  run: WorkflowRun,
  probe: KeyPresenceProbe,
): WorkflowRun {
  if (run.status === 'complete' || run.status === 'aborted' || run.status === 'stopped') return run
  const step = stepOf(graph, run)
  const branch = step.onFailure.find((b) => b.goto === 'abort-to-manual')
  const reason = branch
    ? `Unexpected screen at step ${step.id}: ${branch.note}`
    : `Unexpected screen at step ${step.id}.`
  return abort(run, step, probe, reason)
}

/** Follow a named failure branch of the current step (e.g. not-arrived). */
export function observeFailure(
  graph: WorkflowGraph,
  run: WorkflowRun,
  when: string,
  probe: KeyPresenceProbe,
  observedText?: string,
): WorkflowRun {
  if (run.status !== 'in-progress' && run.status !== 'waiting') return run
  const step = stepOf(graph, run)
  const branch = step.onFailure.find((b) => b.when === when)
  if (!branch) return run
  if (branch.goto === 'wait') return { ...run, status: 'waiting' }
  if (branch.goto === 'report-and-stop') {
    return {
      ...run,
      status: 'stopped',
      stopReport: observedText ? `${branch.note} Observed: ${observedText}` : branch.note,
    }
  }
  if (branch.goto === 'abort-to-manual') {
    return abort(run, step, probe, `Failure "${when}" at step ${step.id}: ${branch.note}`)
  }
  // A branch back to a named step (not used by v1, kept for graph evolution).
  return { ...run, stepId: branch.goto, status: 'in-progress', approvalGrantedFor: null }
}

/** The wait condition cleared (e.g. the delivery email arrived). */
export function resumeFromWait(run: WorkflowRun): WorkflowRun {
  return run.status === 'waiting' ? { ...run, status: 'in-progress' } : run
}
