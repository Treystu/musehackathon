import { useState } from 'react'
import { decideAskPath } from '../../core/ai/byo'
import { hasMetaKey } from '../../core/ai/meta-key'
import {
  assessTranscript,
  checkSpokenNumbers,
  type MicStorage,
} from '../../core/ai/mic'
import type {
  IntentResult,
  MuseProvider,
  TranscribeResult,
  ValidatedIntent,
} from '../../core/ai/provider'
import { canRun, validateIntent, withRunnability } from '../../core/ai/intent-schema'
import { DISCLOSURE_TEXT, hermeticStubValidator, type Validator } from '../../core/ai/validator'
import type { ProxyError } from '../../core/ai/proxy-errors'
import { ByoOffer } from './ByoOffer'
import { ClarificationPanel, type ClarificationCandidates } from './ClarificationPanel'
import { IntentEditor } from './IntentEditor'
import { ExplainOnAsk, type ExplanationState } from './ExplainOnAsk'
import { MicInput, type MicRecorder } from './MicInput'
import type { FigureInput } from './FigureCard'

export const SPOKEN_NUMBER_MISMATCH_NOTE =
  'A number in what was heard does not match the understood request. Check the numbers in the request below before running anything.'

export const LOW_CONFIDENCE_TRANSCRIPT_NOTE =
  'That speech was not clear enough to trust, especially its numbers. The words are in the box above: check and edit them, then choose Ask. Nothing has run.'

export const EMPTY_TRANSCRIPT_NOTE =
  'No speech was captured. The typed box above still works fully, or try speaking again.'

export const RAW_TEXT_DISCLOSURE =
  'Free-text Ask sends the words you type to the wording helper; this path cannot be answered from structured choices alone. The figures still come from CivicScope.'

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
 * Ask panel. Text is the primary path; mic (Item 12) is an equal main
 * input beside it (Q2) — consent-gated in MicInput, and a transcript
 * only ever lands in the editable query text / understood-request
 * chips before anything can run. BYO recovery is wired here via
 * ByoOffer (settings/shutoff entry) + byoProvider retry.
 */
export function AskPanel({
  provider,
  byoProvider,
  validator = hermeticStubValidator,
  onExecute,
  proxyError,
  clarificationCandidates,
  onOpenSettings,
  figures,
  explanation,
  onExplain,
  micRecorder,
  micStorage,
}: {
  provider: MuseProvider
  /**
   * Meta-direct provider for the BYO retry after shared shutoff. Never the
   * metered proxy — a BYO-direct call bypasses the shared allowance
   * entirely, so the proxy meter is untouched. Absent by default.
   */
  byoProvider?: MuseProvider
  validator?: Validator
  onExecute?: (intent: ValidatedIntent) => void
  proxyError?: ProxyError | null
  clarificationCandidates?: ClarificationCandidates
  onOpenSettings?: () => void
  figures?: readonly FigureInput[]
  explanation?: ExplanationState
  onExplain?: (intent: ValidatedIntent) => void
  /** Test/port injection for the mic recorder; defaults to the browser recorder. */
  micRecorder?: MicRecorder | null
  /** Test/port injection for mic consent storage; defaults to browser storage. */
  micStorage?: MicStorage
}) {
  const [text, setText] = useState('')
  const [intent, setIntent] = useState<ValidatedIntent | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [caughtError, setCaughtError] = useState<ProxyError | null>(null)

  const errorNote = proxyErrorNote(proxyError) ?? note

  function accept(result: IntentResult, spokenTranscript?: string) {
    const check = validateIntent(result.intent)
    if (!check.ok) {
      setNote('That request cannot be run as asked. Try the manual search below.')
      return
    }
    // One answer: the flag is stamped by its single owner, so the gate
    // below and ExplainOnAsk read the same runnability.
    let parsed = withRunnability(check.intent)
    // Spoken-number validation (mic path): every numeral heard must
    // match a number in the understood request. A mismatch fails
    // closed into clarification — nothing runs on a substituted number.
    let spokenMismatch = false
    if (spokenTranscript !== undefined) {
      const verdict = checkSpokenNumbers(spokenTranscript, parsed, validator)
      if (!verdict.pass) {
        spokenMismatch = true
        parsed = { ...parsed, clarificationNeeded: true }
      }
    }
    if (result.prose) {
      const verdict = validator.validate(result.prose, [])
      if (!verdict.pass) {
        setNote('Wording was withheld for failing verification. Figures are shown without it.')
      }
    }
    setIntent(parsed)
    if (spokenMismatch) {
      setNote(SPOKEN_NUMBER_MISMATCH_NOTE)
    } else if (parsed.clarificationNeeded) {
      setNote('More detail is needed before anything runs. Check the understood request below.')
    }
  }

  async function runQuery(queryText: string, spokenTranscript?: string) {
    setBusy(true)
    setNote('')
    setCaughtError(null)
    const request = {
      slots: { geographyHints: [], metricHints: [] },
      queryText,
      locale: 'en' as const,
    }
    try {
      accept(await provider.intent(request, new AbortController().signal), spokenTranscript)
    } catch (err) {
      const known = extractProxyError(err)
      if (
        known &&
        byoProvider &&
        decideAskPath({
          budgetExhausted: known === 'credits_exhausted' || known === 'budget_exhausted',
          breakerOpen: false,
          hasByoKey: hasMetaKey(),
        }) === 'byo'
      ) {
        try {
          accept(
            await byoProvider.intent(request, new AbortController().signal),
            spokenTranscript,
          )
          return
        } catch {
          // BYO-direct also failed; fall through to the shared copy below.
        }
      }
      if (known) setCaughtError(known)
      setNote(
        known
          ? PROXY_ERROR_COPY[known]
          : 'Ask is unavailable right now. Manual search still works fully.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim() || busy) return
    await runQuery(text)
  }

  /**
   * Mic path. The transcript is assessed before it can become a query:
   * low-confidence or empty speech goes to clarification with the words
   * left in the editable text box, and an accepted transcript runs the
   * exact same intent path as typed text, plus spoken-number
   * validation in accept(). Nothing executes from speech directly.
   */
  function handleTranscript(result: TranscribeResult) {
    const assessment = assessTranscript(result)
    setText(assessment.transcript)
    if (assessment.kind === 'clarify') {
      setCaughtError(null)
      setNote(
        assessment.reason === 'empty'
          ? EMPTY_TRANSCRIPT_NOTE
          : LOW_CONFIDENCE_TRANSCRIPT_NOTE,
      )
      return
    }
    void runQuery(assessment.transcript, assessment.transcript)
  }

  return (
    <section aria-labelledby="ask-heading">
      <h2 id="ask-heading">Ask CivicScope</h2>
      <form onSubmit={submit}>
        <label htmlFor="ask-input">Ask in plain language</label>
        <p id="ask-raw-text-note" role="note" className="house-raw-text-disclosure">
          {RAW_TEXT_DISCLOSURE}
        </p>
        <input
          id="ask-input"
          aria-describedby="ask-raw-text-note"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
        />
        <button type="submit" disabled={busy}>
          Ask
        </button>
      </form>
      <MicInput
        transcribe={(audio, mimeType) =>
          provider.transcribe({ audio, mimeType }, new AbortController().signal)
        }
        onTranscript={handleTranscript}
        recorder={micRecorder}
        storage={micStorage}
      />
      {errorNote && (
        <p role="status" aria-live="polite">
          {errorNote}
        </p>
      )}
      {(proxyError || note) && <p>{manualFallbackNote()}</p>}
      <ByoOffer error={proxyError ?? caughtError} onOpenSettings={onOpenSettings} />
      {intent && (
        <>
          <IntentEditor intent={intent} onChange={setIntent} />
          {!canRun(intent) ? (
            <ClarificationPanel
              intent={intent}
              candidates={
                clarificationCandidates ?? { geographies: [], metricKeys: [] }
              }
              onResolve={setIntent}
            />
          ) : (
            <>
              <button type="button" disabled={!onExecute} onClick={() => onExecute?.(intent)}>
                Run this request
              </button>
              <ExplainOnAsk
                intent={intent}
                figures={figures}
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
