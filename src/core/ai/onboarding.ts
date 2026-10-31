/**
 * Canned onboarding state machine. The setup copy is fixed; no model
 * output is used. The independent-run bar is never marked passed here.
 */
import { PRIVACY_SUMMARY } from './privacy'
import { DISCLOSURE_TEXT } from './validator'

export type OnboardingStepId = 'what' | 'privacy' | 'keys' | 'ready'

export interface OnboardingStep {
  id: OnboardingStepId
  title: string
  body: string
  requiresAck: boolean
  ackLabel?: string
}

export const INDEPENDENT_RUN_STATUS = 'AWAITING' as const

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'what',
    title: 'What this surface does',
    body:
      `${DISCLOSURE_TEXT} Manual search and the figure tables remain available ` +
      'without the helper.',
    requiresAck: true,
    ackLabel: 'I understand the wording is a reading of the shown figures.',
  },
  {
    id: 'privacy',
    title: 'What is counted and sent',
    body: PRIVACY_SUMMARY,
    requiresAck: true,
    ackLabel:
      'I understand the aggregate counter and the browser-only personal key.',
  },
  {
    id: 'keys',
    title: 'Your keys',
    body:
      'Two optional keys live only in this browser. A free Census API key ' +
      'lets the app call the Census Bureau directly; a personal Meta key ' +
      'lets the helper run on your own allowance. Neither is required — ' +
      'manual search and the shared helper path work without them. This ' +
      'step is also the manual path an agent hands you back to when a ' +
      'screen stops matching its workflow. The app checks each key itself ' +
      'and confirms it here; a key is never confirmed by anyone saying so.',
    requiresAck: false,
  },
  {
    id: 'ready',
    title: 'You are ready',
    body:
      'You can ask in plain language, correct the understood request, or use ' +
      'manual search. If the helper is unavailable, the figures and manual ' +
      'path still work. The independent-run check is still awaiting ' +
      'verification, so this setup does not claim it has passed.',
    requiresAck: false,
  },
]

export interface OnboardingState {
  stepIndex: number
  acknowledged: Record<string, boolean>
  completed: boolean
}

export function initialOnboardingState(): OnboardingState {
  return { stepIndex: 0, acknowledged: {}, completed: false }
}

/** Start the manual path at a named step (used by agent handoffs). */
export function initialOnboardingStateAt(id: OnboardingStepId): OnboardingState {
  const index = ONBOARDING_STEPS.findIndex((step) => step.id === id)
  return { stepIndex: index >= 0 ? index : 0, acknowledged: {}, completed: false }
}

/**
 * Map an agent-workflow abort's manualEquivalent (see
 * docs/agent-onboarding/workflow.v1.json) to the wizard step the user
 * continues at. Key handling of every kind lands on the keys step;
 * anything unrecognised lands on the first step rather than stranding
 * the user mid-flow.
 */
export function wizardStepForManualEquivalent(manualEquivalent: string): OnboardingStepId {
  switch (manualEquivalent) {
    case 'manual:done':
      return 'ready'
    case 'manual:census-signup':
    case 'manual:census-retrieve-key':
    case 'manual:census-paste-key':
    case 'manual:meta-sign-in':
    case 'manual:meta-create-key':
    case 'manual:meta-paste-key':
      return 'keys'
    case 'manual:intro':
    default:
      return 'what'
  }
}

export function currentStep(state: OnboardingState): OnboardingStep | undefined {
  return ONBOARDING_STEPS[state.stepIndex]
}

export function acknowledge(
  state: OnboardingState,
  id: OnboardingStepId,
  value: boolean,
): OnboardingState {
  return {
    ...state,
    acknowledged: { ...state.acknowledged, [id]: value },
  }
}

export function canAdvance(state: OnboardingState): boolean {
  const step = currentStep(state)
  if (!step) return false
  return !step.requiresAck || state.acknowledged[step.id] === true
}

export function nextStep(state: OnboardingState): OnboardingState {
  if (!canAdvance(state)) return state
  return {
    ...state,
    stepIndex: Math.min(state.stepIndex + 1, ONBOARDING_STEPS.length - 1),
  }
}

export function previousStep(state: OnboardingState): OnboardingState {
  return { ...state, stepIndex: Math.max(0, state.stepIndex - 1) }
}

export function canFinish(state: OnboardingState): boolean {
  return (
    state.stepIndex === ONBOARDING_STEPS.length - 1 &&
    ONBOARDING_STEPS.every(
      (step) => !step.requiresAck || state.acknowledged[step.id] === true,
    )
  )
}

export function finishOnboarding(state: OnboardingState): OnboardingState {
  return canFinish(state) ? { ...state, completed: true } : state
}
