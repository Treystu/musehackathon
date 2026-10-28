import { useState } from 'react'
import type { MuseProvider, ValidatedIntent } from '../../core/ai/provider'
import { validateIntent } from '../../core/ai/intent-schema'
import { DISCLOSURE_TEXT, hermeticStubValidator, type Validator } from '../../core/ai/validator'
import type { ProxyError } from '../../../functions/api/muse/shared'
import { ByoOffer } from './ByoOffer'
import { ClarificationPanel, type ClarificationCandidates } from './ClarificationPanel'
import { IntentEditor } from './IntentEditor'
import { ExplainOnAsk, type ExplanationState } from './ExplainOnAsk'

export { IntentChips } from './IntentChips'

export const PROXY_ERROR_COPY: Record<ProxyError, string> = {
  not_allowlisted:
    'That request is not on the approved list, so it cannot be sent. You can still search, filter, and read every figure by hand below.',
  shape_invalid:
    'That request was not in the expected form, so nothing was sent. You can still search, filter, and read every figure by hand below.',
  rate_limited:
    'Too many requests were sent in a short time, so this one has to wait. You can still search, filter, and read every figure by hand below.',
  credits_exhausted:
    'The shared allowance for the helper is used up for now. You can still search, filter, and read every figure by hand below, with the same figures.',
  provider_down:
    'The wording helper is not responding right now. You can still search, filter, and read every figure by hand below, with the same figures.',
  bad_key:
    'The wording helper could not sign in, so it cannot help right now. You can still search, filter, and read every figure by hand below, with the same figures.',
  budget_exhausted:
    'The shared spending limit for the helper has been reached, so it is off for now. You can still search, filter, and read every figure by hand below, with the same figures.',
  breaker_open:
    'The wording helper has been paused after repeated problems. You can still search, filter, and read every figure by hand below, with the same figures.',
}

export function manualFallbackNote(): string {
  return 'Manual search is fully available: you can pick places and measures, set filters, and read every figure with its source — the same figures the helper would use.'
}

/** Copy for a proxy error class, or null when no error is present. */
export function proxyErrorNote(error: ProxyError | null | undefined): string | null {
  if (!error) return null
  return PROXY_ERROR_COPY[error]
}

function isProxyError(value: unknown): value is ProxyError {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PROXY_ERROR_COPY, value)
  )
}

function extractProxyError(e: unknown): ProxyError | null {
  if (typeof e === 'object' && e !== null) {
    const rec = e as Record<string, unknown>
    if (isProxyError(rec.code)) return rec.code
    if (isProxyError(rec.error)) return rec.error
  }
  return null
}

export function Disclosure() {
  return (
    <p role="note" className="house-disclosure">
      {DISCLOSURE_TEXT}
    </p>
  )
}

/**
 * Ask panel (text path). Mic is LAST and intentionally absent here:
 * no dead button is rendered until mic dependencies verify. BYO lives
 * in settings/shutoff only and is intentionally absent here too.
 */
export function AskPanel({
  provider,
  validator = hermeticStubValidator,
  onExecute,
  proxyError,
  clarificationCandidates,
  onOpenSettings,
  explanation,
  onExplain,
}: {
  provider: MuseProvider
  validator?: Validator
  onExecute?: (intent: ValidatedIntent) => void
  proxyError?: ProxyError | null
  clarificationCandidates?: ClarificationCandidates
  onOpenSettings?: () => void
  explanation?: ExplanationState
  onExplain?: (intent: ValidatedIntent) => void
}) {
  const [text, setText] = useState('')
  const [intent, setIntent] = useState<ValidatedIntent | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const errorNote = proxyErrorNote(proxyError) ?? note

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    setNote('')
    try {
      const result = await provider.intent(
        { slots: { geographyHints: [], metricHints: [] }, queryText: text, locale: 'en' },
        new AbortController().signal,
      )
      const check = validateIntent(result.intent)
      if (!check.ok) {
        setNote('That request cannot be run as asked. Try the manual search below.')
        return
      }
      if (result.prose) {
        const verdict = validator.validate(result.prose, [])
        if (!verdict.pass) {
          setNote('Wording was withheld for failing verification. Figures are shown without it.')
        }
      }
      setIntent(check.intent)
      if (check.intent.clarificationNeeded) {
        setNote('More detail is needed before anything runs. Check the understood request below.')
      }
    } catch (err) {
      const known = extractProxyError(err)
      setNote(
        known
          ? PROXY_ERROR_COPY[known]
          : 'Ask is unavailable right now. Manual search still works fully.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="ask-heading">
      <h2 id="ask-heading">Ask CivicScope</h2>
      <form onSubmit={submit}>
        <label htmlFor="ask-input">Ask in plain language</label>
        <input
          id="ask-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
        />
        <button type="submit" disabled={busy}>
          Ask
        </button>
      </form>
      {errorNote && (
        <p role="status" aria-live="polite">
          {errorNote}
        </p>
      )}
      {(proxyError || note) && <p>{manualFallbackNote()}</p>}
      <ByoOffer error={proxyError} onOpenSettings={onOpenSettings} />
      {intent && (
        <>
          <IntentEditor intent={intent} onChange={setIntent} />
          {intent.clarificationNeeded ? (
            <ClarificationPanel
              intent={intent}
              candidates={
                clarificationCandidates ?? { geographies: [], metricKeys: [] }
              }
              onResolve={setIntent}
            />
          ) : (
            <>
              <button type="button" onClick={() => onExecute?.(intent)}>
                Run this request
              </button>
              <ExplainOnAsk
                intent={intent}
                explanation={explanation}
                onExplain={onExplain}
              />
            </>
          )}
        </>
      )}
      <Disclosure />
    </section>
  )
}
