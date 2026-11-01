import { useEffect, useState } from 'react'
import { CENSUS_KEY_EVENT, getCensusKey } from '../../core/censusKey'
import { META_KEY_EVENT, hasMetaKey } from '../../core/ai/meta-key'
import { AGENT_ONBOARDING_RUN_STATUS, WORKFLOW_VERSION } from '../../core/ai/agent-workflow'

interface KeyConfirmations {
  census: boolean
  meta: boolean
}

function currentConfirmations(): KeyConfirmations {
  return { census: getCensusKey() !== undefined, meta: hasMetaKey() }
}

/**
 * F5a entry point: "set up with your agent".
 *
 * An AI agent can walk a user through key setup by following the
 * versioned workflow in docs/agent-onboarding/workflow.v1.json. Two
 * properties are enforced here rather than promised:
 *
 * - There is no key field and no "agent says it worked" input on this
 *   surface. Setup success is confirmed only by the app's own key
 *   events — the same events the app dispatches when it validates and
 *   stores a key itself (see core/censusKey.ts and core/ai/meta-key.ts).
 * - If a screen does not match the workflow's expectations, the
 *   workflow halts before any key entry and hands off to the manual
 *   path at the equivalent step; the button below is that path.
 */
export function AgentHandoff({ onOpenManual }: { onOpenManual?: () => void }) {
  const [confirmed, setConfirmed] = useState<KeyConfirmations>(currentConfirmations)

  useEffect(() => {
    const onCensusKey = () =>
      setConfirmed((c) => ({ ...c, census: getCensusKey() !== undefined }))
    const onMetaKey = (e: Event) => {
      const present = (e as CustomEvent<{ present?: boolean }>).detail?.present
      setConfirmed((c) => ({ ...c, meta: present ?? hasMetaKey() }))
    }
    window.addEventListener(CENSUS_KEY_EVENT, onCensusKey)
    window.addEventListener(META_KEY_EVENT, onMetaKey)
    return () => {
      window.removeEventListener(CENSUS_KEY_EVENT, onCensusKey)
      window.removeEventListener(META_KEY_EVENT, onMetaKey)
    }
  }, [])

  return (
    <section aria-labelledby="agent-handoff-heading" className="panel panel-padded">
      <h2 id="agent-handoff-heading" className="text-sm font-semibold text-slate-900">
        Set up with your agent
      </h2>
      <p className="mt-1 text-sm text-slate-700">
        An AI agent can walk you through getting the keys this app can use, following a written,
        versioned workflow (version {WORKFLOW_VERSION}, kept in the project repository). The agent
        never receives your key and cannot confirm setup by reporting one — CivicScope confirms
        success itself, here, when its own key check succeeds. If anything on screen does not
        match what the workflow expects, the agent must stop before any key is entered and hand
        you back to the manual steps at the same point.
      </p>

      <ul className="mt-3 space-y-1 text-sm text-slate-700">
        <li>
          <span className="font-medium text-slate-900">Census API key:</span>{' '}
          {confirmed.census
            ? 'confirmed by CivicScope in this browser.'
            : 'not set up yet. Success event: civicscope:census-key.'}
        </li>
        <li>
          <span className="font-medium text-slate-900">Personal Meta key (optional):</span>{' '}
          {confirmed.meta
            ? 'confirmed by CivicScope in this browser.'
            : 'not set up yet. Success event: civicscope:meta-key-changed.'}
        </li>
      </ul>

      {onOpenManual && (
        <div className="mt-3">
          <button
            type="button"
            onClick={onOpenManual}
            className="rounded-md px-3 py-2 text-sm text-slate-900 underline hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          >
            Continue manually instead
          </button>
        </div>
      )}

      <p role="note" className="mt-3 text-xs text-slate-500">
        Independent verification run of the agent workflow: {AGENT_ONBOARDING_RUN_STATUS}. A
        non-author run on a clean account is recorded in the repository when it has happened;
        until then, this page does not claim it.
      </p>
    </section>
  )
}
