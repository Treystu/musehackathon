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
    <section aria-labelledby="onboarding-heading" className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-4">
      <h2 id="onboarding-heading" className="text-sm font-semibold text-slate-900">
        Getting started
      </h2>
      <p role="status" aria-live="polite" className="mt-1 text-sm text-slate-600">
        Step {state.stepIndex + 1} of {ONBOARDING_STEPS.length}: {step.title}
      </p>
      <h3 className="mt-2 text-sm font-semibold text-slate-900">{step.title}</h3>
      <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-slate-700">{step.body}</p>

      {step.requiresAck ? (
        <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={state.acknowledged[step.id] === true}
            onChange={(e) =>
              setState(acknowledge(state, step.id, e.target.checked))
            }
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          {step.ackLabel}
        </label>
      ) : null}

      {step.id === 'keys' ? (
        <div className="mt-3 space-y-4">
          <CensusKeySettings fetcher={censusFetcher} />
          <ByoSettings fetcher={metaFetcher} />
          <KeySetupStatus censusFetcher={censusFetcher} metaFetcher={metaFetcher} />
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={state.stepIndex === 0 || state.completed}
          onClick={() => setState(previousStep(state))}
          className="btn-secondary"
        >
          Back
        </button>
        {isLast ? (
          <button
            type="button"
            disabled={!canFinish(state) || state.completed}
            onClick={finish}
            className="btn-primary"
          >
            Finish
          </button>
        ) : (
          <button
            type="button"
            disabled={!canAdvance(state) || state.completed}
            onClick={() => setState(nextStep(state))}
            className="btn-primary"
          >
            Next
          </button>
        )}
      </div>

      {state.completed ? (
        <p role="status" className="mt-2 text-sm text-slate-700">
          Setup complete.
        </p>
      ) : null}

      <p role="note" className="mt-3 text-sm text-slate-600">
        Independent-run check: {INDEPENDENT_RUN_STATUS}. These setup steps do
        not claim the independent-run bar has passed.
      </p>
    </section>
  )
}
