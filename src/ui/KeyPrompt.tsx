import { useEffect, useRef, useState } from 'react'
import {
  CENSUS_SIGNUP_URL,
  clearCensusKey,
  getCensusKey,
  getCensusKeySource,
  getSharedCensusKey,
  rememberReturnPath,
  setCensusKey,
  validateCensusKey,
} from '../core/censusKey'

type Phase = 'idle' | 'checking' | 'paste' | 'invalid' | 'done'

/**
 * Census key capture.
 *
 * Signup cannot be automated: POST /data/KeySignup rejects GET with a 405 and
 * sends no CORS headers, so no browser can submit that form cross-origin, and
 * the key is delivered by email. The design goal is therefore to make the
 * unavoidable part as short as possible — one click to open the form, one paste
 * to finish — and to make the key genuinely optional rather than a wall.
 *
 * The prompt is only ever shown inline. Nothing is blocked until the user
 * chooses to add a key.
 */
export function KeyPrompt({
  onDismiss,
  compact = false,
  autoFocus = true,
}: {
  onDismiss?: () => void
  compact?: boolean
  /**
   * False when the prompt was opened on the reader's behalf rather than by them.
   * Arriving at the page and having focus pulled into a paste field is
   * disorienting, so the wall never does it; a reader who pressed "Load every ZIP
   * code" has asked, and gets the cursor in the field.
   */
  autoFocus?: boolean
}) {
  const [phase, setPhase] = useState<Phase>(() => (getCensusKey() ? 'done' : 'idle'))
  const [value, setValue] = useState('')
  const [message, setMessage] = useState('')
  const [attempts, setAttempts] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // A returning visitor lands here from the Census tab. Their key is in the
  // clipboard's reach, so focus the paste field immediately — unless the wall
  // opened this itself, in which case focus stays where the reader left it.
  useEffect(() => {
    if (phase === 'idle') {
      setPhase('paste')
      if (autoFocus) inputRef.current?.focus()
    }
  }, [phase, autoFocus])

  async function openSignup() {
    rememberReturnPath(window.location.pathname + window.location.search)
    window.open(CENSUS_SIGNUP_URL, '_blank', 'noopener,noreferrer')
    setPhase('paste')
    setMessage('A new tab opened. Fill in the form, then come back and paste your key here.')
  }

  async function submit() {
    const pasted = value.trim()
    if (!pasted) return
    setPhase('checking')
    setMessage('Checking your key…')
    const ctrl = new AbortController()
    const result = await validateCensusKey(pasted, ctrl.signal)
    if (result.ok) {
      setCensusKey(pasted)
      setPhase('done')
      setMessage('Key saved in this browser. Full data is unlocked.')
    } else {
      // Surface the real reason. The previous version reported a single generic
      // "not accepted" message for every failure, which made a network problem
      // look like a bad key and sent people hunting for a fault that was not
      // in their key.
      setPhase('invalid')
      setMessage(result.detail)
      if (result.reason === 'rejected') {
        setAttempts((n) => n + 1)
      }
    }
  }

  function remove() {
    clearCensusKey()
    setValue('')
    setPhase('idle')
    // The fallback after removal depends on the deployment: with a shared
    // application key the full dataset stays available on it; without one
    // the visitor is back to the reduced dataset. Say which one happened.
    setMessage(
      getSharedCensusKey()
        ? 'Your key was removed. The shared application key is carrying the full dataset again.'
        : 'Key removed. You are back to the reduced dataset.',
    )
  }

  if (phase === 'done') {
    return (
      <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm" role="status">
        <p className="font-medium text-green-900">Census key active.</p>
        <p className="mt-1 text-green-800">
          Stored in this browser only. It is never sent to us and we have no record of it.
        </p>
        <button type="button" onClick={remove} className="mt-2 text-sm underline text-green-900 hover:text-green-700">
          Remove key
        </button>
      </div>
    )
  }

  return (
    <section className="panel panel-padded text-sm" aria-labelledby="key-prompt-heading">
      <h2 id="key-prompt-heading" className="font-semibold text-slate-900">
        Unlock the full housing and demographic dataset
      </h2>
      <p className="mt-1 text-slate-700">
        The Census Bureau requires every app to hold a free API key so they can track usage. It takes about a
        minute, and <strong>your key is stored only in this browser</strong> — it is never sent to us, and we
        keep no log of what you search for.
      </p>

      {getCensusKeySource() === 'shared' && (
        <p className="mt-2 text-slate-700" role="status">
          This site is currently running on the project&rsquo;s shared application key, so the full dataset is
          already available. Adding your own key is optional: it replaces the shared key for your visits and is
          stored only in this browser.
        </p>
      )}

      <ol className="mt-3 list-decimal space-y-1 pl-5 text-slate-700">
        <li>Open the free Census key form in a new tab.</li>
        <li>Fill in three fields. You can leave the organisation as &ldquo;Individual&rdquo;.</li>
        <li>The key arrives by email. Paste it below.</li>
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={openSignup} className="btn-primary">
          Get my free key
        </button>
        {onDismiss && !compact && (
          <button type="button" onClick={onDismiss} className="btn-quiet px-2 py-2">
            Not now
          </button>
        )}
      </div>

      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {/*
          The id is census-key-prompt, not census-key: CensusKeySettings
          already owns census-key, and both surfaces can be in the DOM
          at once (the wizard's keys step and this prompt), where a
          duplicate id silently retargets the other surface's label.
        */}
        <label htmlFor="census-key-prompt" className="block font-medium text-slate-900">
          Already have a key? Paste it here
        </label>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            id="census-key-prompt"
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="key-status"
            className="field"
            placeholder="e.g. 0123456789abcdef0123456789abcdef01234567"
          />
          <button
            type="submit"
            disabled={phase === 'checking' || value.trim() === ''}
            className="btn-primary shrink-0"
          >
            {phase === 'checking' ? 'Checking…' : 'Save key'}
          </button>
        </div>
        <p id="key-status" role="status" aria-live="polite" className="mt-2 min-h-5 text-slate-700">
          {message}
          {phase === 'invalid' && attempts > 1 && (
            <span className="mt-1 block text-sm">
              Tried {attempts} times. If the key is definitely correct, the most likely explanation is that
              Census has not activated it yet. New keys can take several minutes. There is nothing wrong with
              your copy of the key.
            </span>
          )}
        </p>
      </form>
    </section>
  )
}
