import { useState } from 'react'
import {
  INDEPENDENT_RUN_STATUS,
  ONBOARDING_STEPS,
  acknowledge,
  canAdvance,
  canFinish,
  currentStep,
  finishOnboarding,
  initialOnboardingState,
  nextStep,
  previousStep,
} from '../../core/ai/onboarding'

/** Canned setup wizard. No model prose and no independent-run pass claim. */
export function OnboardingWizard({ onFinish }: { onFinish?: () => void }) {
  const [state, setState] = useState(initialOnboardingState())
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
