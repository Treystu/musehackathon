import { useState } from 'react'
import type { MuseProvider, ValidatedIntent } from '../../core/ai/provider'
import { validateIntent } from '../../core/ai/intent-schema'
import { DISCLOSURE_TEXT, hermeticStubValidator, type Validator } from '../../core/ai/validator'

export function Disclosure() {
  return (
    <p role="note" className="house-disclosure">
      {DISCLOSURE_TEXT}
    </p>
  )
}

export function IntentChips({
  intent,
  onChange,
}: {
  intent: ValidatedIntent
  onChange: (next: ValidatedIntent) => void
}) {
  return (
    <div aria-label="What was understood">
      <span>{intent.mode}</span>
      {intent.geographies.map((g) => (
        <button
          key={g}
          type="button"
          onClick={() =>
            onChange({ ...intent, geographies: intent.geographies.filter((x) => x !== g) })
          }
        >
          {g} ×
        </button>
      ))}
      {intent.metricKeys.map((k) => (
        <span key={k}>{k}</span>
      ))}
    </div>
  )
}

/**
 * Ask panel (text path). Mic is LAST and intentionally absent here:
 * no dead button is rendered until mic dependencies verify.
 */
export function AskPanel({
  provider,
  validator = hermeticStubValidator,
  onExecute,
}: {
  provider: MuseProvider
  validator?: Validator
  onExecute?: (intent: ValidatedIntent) => void
}) {
  const [text, setText] = useState('')
  const [intent, setIntent] = useState<ValidatedIntent | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

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
    } catch {
      setNote('Ask is unavailable right now. Manual search still works fully.')
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
      {note && (
        <p role="status" aria-live="polite">
          {note}
        </p>
      )}
      {intent && (
        <>
          <IntentChips intent={intent} onChange={setIntent} />
          {!intent.clarificationNeeded && (
            <button type="button" onClick={() => onExecute?.(intent)}>
              Run this request
            </button>
          )}
        </>
      )}
      <Disclosure />
    </section>
  )
}
