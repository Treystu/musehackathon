import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PATH_SUCCESS_EVENT,
  WORKFLOW_VERSION,
  grantApproval,
  observeAppKeyEvent,
  observeCheckpoint,
  observeFailure,
  observeUnexpectedScreen,
  resumeFromWait,
  startRun,
  validateWorkflowGraph,
  type WorkflowGraph,
  type WorkflowRun,
} from '../../src/core/ai/agent-workflow'
import { CENSUS_KEY_EVENT } from '../../src/core/ai/census-key'
import { META_KEY_EVENT } from '../../src/core/ai/meta-key'

const graph = JSON.parse(
  readFileSync(join(process.cwd(), 'docs/agent-onboarding/workflow.v1.json'), 'utf8'),
) as WorkflowGraph

const noKeys = { censusPresent: false, metaPresent: false }

function cloneGraph(): WorkflowGraph {
  return JSON.parse(JSON.stringify(graph)) as WorkflowGraph
}

/** Drive the census path to its key-entry step, granting approvals. */
function censusRunAtKeyEntry(): WorkflowRun {
  let run = startRun(graph, 'census')
  run = observeCheckpoint(graph, run) // open-handoff -> open-signup (approval)
  run = grantApproval(graph, run)
  run = observeCheckpoint(graph, run) // -> submit-signup
  run = observeCheckpoint(graph, run) // -> read-delivery-email (approval)
  run = grantApproval(graph, run)
  run = observeCheckpoint(graph, run) // -> place-key (approval)
  run = grantApproval(graph, run)
  return run
}

describe('workflow graph artefact (docs/agent-onboarding/workflow.v1.json)', () => {
  it('validates clean against the interpreter semantics', () => {
    expect(validateWorkflowGraph(graph)).toEqual([])
  })

  it('pins its success events to the app key modules', () => {
    expect(PATH_SUCCESS_EVENT).toEqual({ census: CENSUS_KEY_EVENT, meta: META_KEY_EVENT })
    expect(CENSUS_KEY_EVENT).toBe('civicscope:census-key')
    expect(META_KEY_EVENT).toBe('civicscope:meta-key-changed')
    expect(graph.version).toBe(WORKFLOW_VERSION)
  })

  it('rejects a graph whose key-entry step completes on an agent report', () => {
    const broken = cloneGraph()
    const step = broken.paths.census.find((s) => s.keyEntry)
    if (!step) throw new Error('census path lost its key-entry step')
    step.completion = 'checkpoint'
    const problems = validateWorkflowGraph(broken)
    expect(problems.some((p) => p.includes('must complete via the app event'))).toBe(true)
  })

  it('rejects a graph with a step that has no abort route', () => {
    const broken = cloneGraph()
    const step = broken.paths.meta[0]
    if (!step) throw new Error('meta path is empty')
    step.onFailure = []
    const problems = validateWorkflowGraph(broken)
    expect(problems.some((p) => p.includes('no abort-to-manual failure branch'))).toBe(true)
  })

  it('rejects a graph whose success event is not the app event', () => {
    const broken = cloneGraph()
    broken.keys.census.successEvent = 'agent-says-so'
    const problems = validateWorkflowGraph(broken)
    expect(problems.some((p) => p.includes('does not match the app'))).toBe(true)
  })
})

describe('run interpreter — checkpoints and approvals', () => {
  it('gates checkpoint steps behind their named human approvals', () => {
    let run = startRun(graph, 'census')
    expect(run.stepId).toBe('census-open-handoff')
    expect(run.status).toBe('in-progress')

    run = observeCheckpoint(graph, run)
    expect(run.stepId).toBe('census-open-signup')
    expect(run.status).toBe('awaiting-approval')

    // An agent observation cannot move a run that awaits the human.
    expect(observeCheckpoint(graph, run)).toBe(run)

    run = grantApproval(graph, run)
    expect(run.status).toBe('in-progress')
    expect(run.approvalGrantedFor).toBe('census-open-signup')

    run = observeCheckpoint(graph, run)
    expect(run.stepId).toBe('census-submit-signup')
  })

  it('waits on a not-arrived delivery email and resumes', () => {
    let run = startRun(graph, 'census')
    run = observeCheckpoint(graph, run)
    run = grantApproval(graph, run)
    run = observeCheckpoint(graph, run)
    run = observeCheckpoint(graph, run) // at read-delivery-email, awaiting approval
    run = grantApproval(graph, run)
    run = observeFailure(graph, run, 'not-arrived', noKeys)
    expect(run.status).toBe('waiting')
    run = resumeFromWait(run)
    expect(run.status).toBe('in-progress')
    expect(run.stepId).toBe('census-read-delivery-email')
  })

  it('stops with the observed text on a report-and-stop branch', () => {
    let run = startRun(graph, 'census')
    run = observeCheckpoint(graph, run)
    run = grantApproval(graph, run)
    run = observeCheckpoint(graph, run) // at submit-signup
    run = observeFailure(graph, run, 'rejection-shown', noKeys, 'Organisation is required.')
    expect(run.status).toBe('stopped')
    expect(run.stopReport).toContain('Organisation is required.')
  })
})

describe('run interpreter — key entry completes only on the app event', () => {
  it('refuses checkpoint completion at the census key-entry step', () => {
    const run = censusRunAtKeyEntry()
    expect(run.stepId).toBe('census-place-key')
    expect(run.status).toBe('in-progress')
    // An agent report — even a confident one — moves nothing here.
    expect(observeCheckpoint(graph, run)).toBe(run)
  })

  it('ignores the other key event and completes on the census event', () => {
    const atEntry = censusRunAtKeyEntry()
    expect(observeAppKeyEvent(graph, atEntry, META_KEY_EVENT)).toBe(atEntry)
    const placed = observeAppKeyEvent(graph, atEntry, CENSUS_KEY_EVENT)
    expect(placed.stepId).toBe('census-complete')
    const done = observeCheckpoint(graph, placed)
    expect(done.status).toBe('complete')
    expect(done.completedSteps).toEqual([
      'census-open-handoff',
      'census-open-signup',
      'census-submit-signup',
      'census-read-delivery-email',
      'census-place-key',
      'census-complete',
    ])
  })

  it('completes the meta path only on the meta event', () => {
    let run = startRun(graph, 'meta')
    run = observeCheckpoint(graph, run) // -> open-console (approval)
    run = grantApproval(graph, run)
    run = observeCheckpoint(graph, run) // -> create-key (approval)
    run = grantApproval(graph, run)
    run = observeCheckpoint(graph, run) // -> place-key (approval)
    run = grantApproval(graph, run)
    expect(run.stepId).toBe('meta-place-key')
    expect(observeAppKeyEvent(graph, run, CENSUS_KEY_EVENT)).toBe(run)
    run = observeAppKeyEvent(graph, run, META_KEY_EVENT)
    expect(run.stepId).toBe('meta-complete')
    run = observeCheckpoint(graph, run)
    expect(run.status).toBe('complete')
  })
})

describe('run interpreter — abort path', () => {
  it('halts before any key entry on an unexpected screen and hands off at the equivalent manual step', () => {
    let run = startRun(graph, 'census')
    run = observeCheckpoint(graph, run) // at census-open-signup; no key handled yet
    const aborted = observeUnexpectedScreen(graph, run, noKeys)
    expect(aborted.status).toBe('aborted')
    expect(aborted.completedSteps).not.toContain('census-place-key')
    expect(aborted.handoff?.manualEquivalent).toBe('manual:census-signup')
    expect(aborted.handoff?.keyPresence).toEqual({ censusPresent: false, metaPresent: false })
    expect(aborted.handoff?.reason).toContain('Unexpected screen at step census-open-signup')
    // A run state can never carry key material: presence booleans only.
    expect(Object.keys(aborted.handoff?.keyPresence ?? {}).sort()).toEqual([
      'censusPresent',
      'metaPresent',
    ])
  })

  it('hands off at the paste step when the surprise lands on key entry', () => {
    const atEntry = censusRunAtKeyEntry()
    const aborted = observeUnexpectedScreen(graph, atEntry, { censusPresent: false, metaPresent: true })
    expect(aborted.status).toBe('aborted')
    expect(aborted.handoff?.manualEquivalent).toBe('manual:census-paste-key')
    expect(aborted.handoff?.keyPresence.metaPresent).toBe(true)
  })

  it('routes a validation rejection at key entry to the manual path with the reason', () => {
    const atEntry = censusRunAtKeyEntry()
    const aborted = observeFailure(graph, atEntry, 'validation-rejected', noKeys)
    expect(aborted.status).toBe('aborted')
    expect(aborted.handoff?.manualEquivalent).toBe('manual:census-paste-key')
    expect(aborted.handoff?.reason).toContain('validation-rejected')
  })

  it('leaves a completed run untouched by a late surprise', () => {
    const atEntry = censusRunAtKeyEntry()
    const placed = observeAppKeyEvent(graph, atEntry, CENSUS_KEY_EVENT)
    const done = observeCheckpoint(graph, placed)
    expect(done.status).toBe('complete')
    expect(observeUnexpectedScreen(graph, done, noKeys)).toBe(done)
  })
})
