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
    <section aria-labelledby="agent-handoff-heading" className="mt-6">
      {/* Collapsed by default (owner direction, 2026-11-01): the setup
          machinery is reference material, and expanded it pushed the
          data below the fold and read as the product's main content.
          The text is unchanged and stays in the DOM - a screen reader
          or a find-in-page reaches it exactly as before, and a handoff
          that names a manual step opens it expanded, because that
          reader has already asked for the manual path. Presentation
          quieted further (owner rule, 2026-11-02): this is a
          post-contest, own-keys path, not part of the judged flow, so
          on the Ask surface it reads as one subtle text line — no
          border, no panel heading weight. The mounting is pinned by
          the agent-handoff tests, so the surface stays here in full;
          only its visual weight changed. */}
      <details open={startStep !== undefined}>
        <summary className="disclosure-summary disclosure-summary--quiet">
          <h2 id="agent-handoff-heading" className="text-xs font-medium text-slate-600">
            Set up with your agent
          </h2>
          <span className="text-xs font-normal text-slate-500">
            Optional — only if you want your own keys
          </span>
        </summary>
        <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-slate-700">
          An AI agent can set this up with you, following the versioned
          workflow in the project repository (version {WORKFLOW_VERSION}). The
          agent never receives your key: the app confirms success itself, here,
          when its re-validation event fires (
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.8125rem] text-slate-800">
            {CENSUS_KEY_EVENT}
          </code>{' '}
          for the Census key,{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.8125rem] text-slate-800">
            {META_KEY_EVENT}
          </code>{' '}
          for a personal key) and its re-check passes. If a screen does not
          match the workflow, the agent stops before any key entry and hands
          you back to the manual steps below.
        </p>

        <KeySetupStatus censusFetcher={censusFetcher} metaFetcher={metaFetcher} />

        <div className="mt-3">
          <button
            type="button"
            aria-expanded={manualOpen}
            onClick={() => setManualOpen((open) => !open)}
            className="btn-secondary"
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

        <p role="note" className="mt-3 text-xs text-slate-600">
          Independent-run check: {INDEPENDENT_RUN_STATUS}. These setup steps do
          not claim the independent-run bar has passed.
        </p>
      </details>
    </section>
  )
}
