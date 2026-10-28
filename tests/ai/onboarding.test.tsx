import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
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
} from '../../src/core/ai/onboarding'
import { OnboardingWizard } from '../../src/ui/ai/OnboardingWizard'

describe('onboarding state machine', () => {
  it('starts on the first required step and cannot advance before acknowledgement', () => {
    const start = initialOnboardingState()
    expect(currentStep(start)?.id).toBe('what')
    expect(canAdvance(start)).toBe(false)
    expect(nextStep(start)).toBe(start)
  })

  it('acknowledges, advances, and preserves acknowledgement when going back', () => {
    const acked = acknowledge(initialOnboardingState(), 'what', true)
    expect(canAdvance(acked)).toBe(true)
    const second = nextStep(acked)
    expect(currentStep(second)?.id).toBe('privacy')
    expect(canAdvance(second)).toBe(false)
    const back = previousStep(second)
    expect(currentStep(back)?.id).toBe('what')
    expect(back.acknowledged.what).toBe(true)
  })

  it('finishes only after every required acknowledgement', () => {
    const start = initialOnboardingState()
    const last = {
      ...start,
      stepIndex: ONBOARDING_STEPS.length - 1,
      acknowledged: { what: true, privacy: true },
    }
    expect(canFinish(last)).toBe(true)
    const done = finishOnboarding(last)
    expect(done.completed).toBe(true)

    const missing = { ...last, acknowledged: { what: true } }
    expect(canFinish(missing)).toBe(false)
    expect(finishOnboarding(missing).completed).toBe(false)
  })

  it('never marks the independent-run bar as passed', () => {
    expect(INDEPENDENT_RUN_STATUS).toBe('AWAITING')
    expect(ONBOARDING_STEPS.some((step) => step.body.includes('PASSED'))).toBe(false)
  })
})

describe('OnboardingWizard', () => {
  it('renders canned steps, a non-passing status, and keyboard controls', () => {
    const html = renderToStaticMarkup(<OnboardingWizard />)
    expect(html).toContain('Getting started')
    expect(html).toContain('What this surface does')
    expect(html).toContain('CivicScope')
    expect(html).toContain('Independent-run check: AWAITING')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('Next')
    expect(html).not.toContain('PASSED')
  })
})
