import { useState } from 'react'
import { CENSUS_KEY_EVENT, type CensusKeyFetcher } from '../../core/ai/census-key'
import { META_KEY_EVENT, type MetaKeyFetcher } from '../../core/ai/meta-key'
import {
  INDEPENDENT_RUN_STATUS,
  wizardStepForManualEquivalent,
  type OnboardingStepId,
} from '../../core/ai/onboarding'
import { WORKFLOW_VERSION } from '../../core/ai/agent-workflow'
import { KeySetupStatus } from './KeyConfirmation'
import { OnboardingWizard } from './OnboardingWizard'

/**
 * In-app entry point: "Set up with your agent".
 *
 * An AI agent can walk a user through key setup by following the
 * versioned workflow in docs/agent-onboarding/workflow.v1.json. Two
 * properties are enforced here rather than promised:
 *
 * - There is no key field and no "agent says it worked" input on this
 *   surface. Setup success is confirmed only by the app's own
 *   re-validation loop (KeySetupStatus): the key modules' change events
 *   fire when the app itself stores a key, and the app re-checks the
 *   stored key before anything is shown as confirmed.
 * - If a screen does not match the workflow's expectations, the
 *   workflow halts before any key entry and hands off to the manual
 *   path at the equivalent step; the manual steps below are that path,
 *   and a handoff can name the step it lands on (manualStep /
 *   manualEquivalent props).
 */
export function AgentHandoff({
  censusFetcher,
  metaFetcher,
  manualStep,
  manualEquivalent,
}: {
  censusFetcher?: CensusKeyFetcher
  metaFetcher?: MetaKeyFetcher
  /** Open the manual path at this wizard step (e.g. after an abort). */
  manualStep?: OnboardingStepId
  /** Or name it in workflow terms; resolved to a wizard step here. */
  manualEquivalent?: string
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const startStep =
    manualStep ??
    (manualEquivalent ? wizardStepForManualEquivalent(manualEquivalent) : undefined)

  return (
    <section aria-labelledby="agent-handoff-heading">
      <h2 id="agent-handoff-heading">Set up with your agent</h2>
      <p>
        An AI agent can walk you through getting the keys this app can use,
        following a written, versioned workflow (version {WORKFLOW_VERSION},
        kept in the project repository). The agent never receives your key
        and cannot confirm setup by reporting one — the app confirms success
        itself, here, when its own re-validation event fires for a key (
        {CENSUS_KEY_EVENT} for the Census key, {META_KEY_EVENT} for a
        personal key) and its re-check passes. If anything on screen
        does not match what the workflow expects, the agent must stop before
        any key is entered and hand you back to the manual steps at the same
        point.
      </p>

      <KeySetupStatus censusFetcher={censusFetcher} metaFetcher={metaFetcher} />

      <div>
        <button
          type="button"
          aria-expanded={manualOpen}
          onClick={() => setManualOpen((open) => !open)}
        >
          {manualOpen ? 'Hide the manual setup steps' : 'Continue manually instead'}
        </button>
      </div>
      {manualOpen ? (
        <OnboardingWizard
          initialStepId={startStep}
          censusFetcher={censusFetcher}
          metaFetcher={metaFetcher}
        />
      ) : null}

      <p role="note">
        Independent-run check: {INDEPENDENT_RUN_STATUS}. These setup steps do
        not claim the independent-run bar has passed.
      </p>
    </section>
  )
}
