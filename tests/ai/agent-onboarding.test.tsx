import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CENSUS_KEY_EVENT } from '../../src/core/censusKey'
import { META_KEY_EVENT } from '../../src/core/ai/meta-key'
import {
  AGENT_ONBOARDING_RUN_STATUS,
  WORKFLOW_VERSION,
  grantApproval,
  observeAppKeyEvent,
  observeCheckpoint,
  observeFailure,
  observeUnexpectedScreen,
  resumeFromWait,
  startRun,
  validateWorkflowGraph,
  type KeyPresenceProbe,
  type WorkflowGraph,
  type WorkflowRun,
} from '../../src/core/ai/agent-workflow'
import { AgentHandoff } from '../../src/ui/ai/agent-handoff'

const GRAPH_PATH = new URL('../../docs/agent-onboarding/workflow.v1.json', import.meta.url)
const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as WorkflowGraph

const NO_KEYS: KeyPresenceProbe = { censusPresent: false, metaPresent: false }

/** Drive a census run to the key-entry step, approvals granted on the way. */
function censusRunAtPlaceKey(): WorkflowRun {
  let run = startRun(graph, 'census')
  run = observeCheckpoint(graph, run) // open-handoff observed
  run = grantApproval(graph, run) // before-form-submission
  run = observeCheckpoint(graph, run) // signup form observed
  run = observeCheckpoint(graph, run) // submission confirmed
  run = grantApproval(graph, run) // before-opening-email
  run = observeCheckpoint(graph, run) // delivery email matches, token present
  run = grantApproval(graph, run) // before-credential-handled
  return run
}

describe('workflow.v1.json — the F5a graph self-check', () => {
  it('is structurally valid under the section 6.5.4 semantics', () => {
    expect(validateWorkflowGraph(graph)).toEqual([])
  })

  it('is the version the code and the handoff page advertise', () => {
    expect(graph.version).toBe(WORKFLOW_VERSION)
    expect(graph.workflow).toBe('civicscope-agent-onboarding')
  })

  it('names the app real re-validation events as the only success proof', () => {
    expect(graph.keys.census.successEvent).toBe(CENSUS_KEY_EVENT)
    expect(graph.keys.meta.successEvent).toBe(META_KEY_EVENT)
  })

  it('covers both keys, each with approval points and exactly one key-entry step', () => {
    for (const pathId of ['census', 'meta'] as const) {
      const steps = graph.paths[pathId]
      expect(steps.length).toBeGreaterThan(0)
      expect(steps.some((s) => s.humanApproval !== null)).toBe(true)
      expect(steps.filter((s) => s.keyEntry)).toHaveLength(1)
      // Every non-terminal step can abort to the manual path.
      for (const step of steps) {
        expect(step.manualEquivalent).toBeTruthy()
        if (step.next !== null) {
          expect(step.onFailure.some((b) => b.goto === 'abort-to-manual')).toBe(true)
        }
      }
    }
  })
})

describe('workflow run semantics', () => {
  it('walks the census path to completion, with the key confirmed only by the app event', () => {
    let run = censusRunAtPlaceKey()
    expect(run.stepId).toBe('census-place-key')

    // An agent-side observation is not proof at a key-entry step.
    expect(observeCheckpoint(graph, run)).toBe(run)
    // The other key's event is not proof either.
    expect(observeAppKeyEvent(graph, run, META_KEY_EVENT)).toBe(run)

    run = observeAppKeyEvent(graph, run, CENSUS_KEY_EVENT)
    expect(run.stepId).toBe('census-complete')
    run = observeCheckpoint(graph, run)
    expect(run.status).toBe('complete')
    expect(run.completedSteps).toContain('census-place-key')
  })

  it('walks the meta path to completion on its own event', () => {
    let run = startRun(graph, 'meta')
    run = observeCheckpoint(graph, run)
    run = grantApproval(graph, run) // before-acting-in-signed-in-console
    run = observeCheckpoint(graph, run)
    run = grantApproval(graph, run) // before-credential-handled (creation)
    run = observeCheckpoint(graph, run)
    expect(run.stepId).toBe('meta-place-key')
    run = grantApproval(graph, run) // before-credential-handled (placement)
    run = observeAppKeyEvent(graph, run, META_KEY_EVENT)
    run = observeCheckpoint(graph, run)
    expect(run.status).toBe('complete')
  })

  it('cannot pass a human-approval point without the approval', () => {
    let run = startRun(graph, 'census')
    run = observeCheckpoint(graph, run)
    expect(run.stepId).toBe('census-open-signup')
    expect(run.status).toBe('awaiting-approval')
    expect(observeCheckpoint(graph, run)).toBe(run)
    run = grantApproval(graph, run)
    expect(run.status).toBe('in-progress')
    expect(run.approvalGrantedFor).toBe('census-open-signup')
  })

  it('waits, without widening the search, when the delivery email has not arrived', () => {
    let run = startRun(graph, 'census')
    run = observeCheckpoint(graph, run)
    run = grantApproval(graph, run)
    run = observeCheckpoint(graph, run)
    run = observeCheckpoint(graph, run)
    run = grantApproval(graph, run)
    expect(run.stepId).toBe('census-read-delivery-email')
    run = observeFailure(graph, run, 'not-arrived', NO_KEYS)
    expect(run.status).toBe('waiting')
    expect(run.stepId).toBe('census-read-delivery-email')
    run = resumeFromWait(run)
    expect(run.status).toBe('in-progress')
  })

  it('reports a signup rejection verbatim and stops', () => {
    let run = startRun(graph, 'census')
    run = observeCheckpoint(graph, run)
    run = grantApproval(graph, run)
    run = observeCheckpoint(graph, run)
    expect(run.stepId).toBe('census-submit-signup')
    run = observeFailure(graph, run, 'rejection-shown', NO_KEYS, 'Email address is invalid.')
    expect(run.status).toBe('stopped')
    expect(run.stopReport).toContain('Email address is invalid.')
  })
})

describe('abort test — unexpected screen before any key entry', () => {
  it('halts at the key-entry step, having entered nothing, and hands off at the equivalent manual step', () => {
    const run = censusRunAtPlaceKey()
    expect(run.stepId).toBe('census-place-key')

    const aborted = observeUnexpectedScreen(graph, run, NO_KEYS)
    expect(aborted.status).toBe('aborted')
    // The key-entry step never completed: no key was entered or confirmed.
    expect(aborted.completedSteps).not.toContain('census-place-key')
    // Key state is reported accurately and by presence only.
    expect(aborted.handoff?.keyPresence).toEqual({ censusPresent: false, metaPresent: false })
    // The handoff target is the manual equivalent of the abort step.
    expect(aborted.handoff?.manualEquivalent).toBe('manual:census-paste-key')
    // No key material exists anywhere in the run state to leak.
    expect(JSON.stringify(aborted)).not.toMatch(/[0-9a-f]{40}/)
  })

  it('halts at the signup step with the signup manual equivalent', () => {
    let run = startRun(graph, 'census')
    run = observeCheckpoint(graph, run)
    const aborted = observeUnexpectedScreen(graph, run, NO_KEYS)
    expect(aborted.status).toBe('aborted')
    expect(aborted.handoff?.manualEquivalent).toBe('manual:census-signup')
  })

  it('a validation rejection at the key step hands off with the app reason route, not a retry', () => {
    const run = censusRunAtPlaceKey()
    const aborted = observeFailure(graph, run, 'validation-rejected', NO_KEYS)
    expect(aborted.status).toBe('aborted')
    expect(aborted.handoff?.manualEquivalent).toBe('manual:census-paste-key')
    expect(aborted.handoff?.reason).toContain('validation-rejected')
  })
})

describe('AgentHandoff entry point', () => {
  it('renders the entry point, both success event names, and a non-passing run status', () => {
    const html = renderToStaticMarkup(<AgentHandoff onOpenManual={() => undefined} />)
    expect(html).toContain('Set up with your agent')
    expect(html).toContain('civicscope:census-key')
    expect(html).toContain('civicscope:meta-key-changed')
    expect(html).toContain('Continue manually instead')
    expect(html).toContain(`Independent verification run of the agent workflow: ${AGENT_ONBOARDING_RUN_STATUS}`)
    expect(AGENT_ONBOARDING_RUN_STATUS).toBe('PENDING')
    expect(html).not.toContain('PASSED')
  })

  it('offers no field an agent could report a key into', () => {
    const html = renderToStaticMarkup(<AgentHandoff />)
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<textarea')
  })
})
