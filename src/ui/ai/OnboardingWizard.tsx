import { useState } from 'react'
import {
  INDEPENDENT_RUN_STATUS,
  ONBOARDING_STEPS,
  acknowledge,
  canAdvance,
  canFinish,
  currentStep,
  finishOnboarding,
  initialOnboardingStateAt,
  nextStep,
  previousStep,
  type OnboardingStepId,
} from '../../core/ai/onboarding'
import type { CensusKeyFetcher } from '../../core/ai/census-key'
import type { MetaKeyFetcher } from '../../core/ai/meta-key'
import { ByoSettings } from './ByoSettings'
import { CensusKeySettings } from './CensusKeySettings'
import { KeySetupStatus } from './KeyConfirmation'

/**
 * Canned setup wizard — also the manual path the agent workflow hands
 * off to, so it can open at a named step. No model prose and no
 * independent-run pass claim. The keys step renders the app's own key
 * settings; confirmation there comes from the re-validation loop, not
 * from the settings forms.
 */
export function OnboardingWizard({
  onFinish,
  initialStepId,
  censusFetcher,
  metaFetcher,
}: {
  onFinish?: () => void
  initialStepId?: OnboardingStepId
  censusFetcher?: CensusKeyFetcher
  metaFetcher?: MetaKeyFetcher
}) {
  const [state, setState] = useState(() => initialOnboardingStateAt(initialStepId ?? 'what'))
  const step = currentStep(state)
  if (!step) return null

  const isLast = state.stepIndex === ONBOARDING_STEPS.length - 1

  function finish() {
    const next = finishOnboarding(state)
    setState(next)
    if (next.completed) onFinish?.()
  }

  return (
    <section aria-labelledby="onboarding-heading">
      <h2 id="onboarding-heading">Getting started</h2>
      <p role="status" aria-live="polite">
        Step {state.stepIndex + 1} of {ONBOARDING_STEPS.length}: {step.title}
      </p>
      <h3>{step.title}</h3>
      <p>{step.body}</p>

      {step.requiresAck ? (
        <label>
          <input
            type="checkbox"
            checked={state.acknowledged[step.id] === true}
            onChange={(e) =>
              setState(acknowledge(state, step.id, e.target.checked))
            }
          />
          {step.ackLabel}
        </label>
      ) : null}

      {step.id === 'keys' ? (
        <>
          <CensusKeySettings fetcher={censusFetcher} />
          <ByoSettings fetcher={metaFetcher} />
          <KeySetupStatus censusFetcher={censusFetcher} metaFetcher={metaFetcher} />
        </>
      ) : null}

      <div>
        <button
          type="button"
          disabled={state.stepIndex === 0 || state.completed}
          onClick={() => setState(previousStep(state))}
        >
          Back
        </button>
        {isLast ? (
          <button
            type="button"
            disabled={!canFinish(state) || state.completed}
            onClick={finish}
          >
            Finish
          </button>
        ) : (
          <button
            type="button"
            disabled={!canAdvance(state) || state.completed}
            onClick={() => setState(nextStep(state))}
          >
            Next
          </button>
        )}
      </div>

      {state.completed ? <p role="status">Setup complete.</p> : null}

      <p role="note">
        Independent-run check: {INDEPENDENT_RUN_STATUS}. These setup steps do
        not claim the independent-run bar has passed.
      </p>
    </section>
  )
}
