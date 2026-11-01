import { useState } from 'react'
import { decideAskPath } from '../../core/ai/byo'
import type { CensusKeyFetcher } from '../../core/ai/census-key'
import { hasMetaKey, type MetaKeyFetcher } from '../../core/ai/meta-key'
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
import { diagnostics } from '../../core/ai/diagnostics'
import { canRun, validateIntent, withRunnability } from '../../core/ai/intent-schema'
import { DISCLOSURE_TEXT, hermeticStubValidator, type Validator } from '../../core/ai/validator'
import type { ProxyError } from '../../core/ai/proxy-errors'
import { AgentHandoff } from './AgentHandoff'
import { ByoOffer } from './ByoOffer'
import { ClarificationPanel, type ClarificationCandidates } from './ClarificationPanel'
import { IntentEditor } from './IntentEditor'
import { ExplainOnAsk } from './ExplainOnAsk'
import { MicInput, type MicRecorder } from './MicInput'
import type { ExplanationState } from './ExplainBox'
import type { FigureInput } from './FigureCard'

export const SPOKEN_NUMBER_MISMATCH_NOTE =
  'A number in what was heard does not match the understood request, so nothing was run. The words are in the box above: check the numbers, then choose Ask.'

export const LOW_CONFIDENCE_TRANSCRIPT_NOTE =
  'That speech was not clear enough to trust, especially its numbers. The words are in the box above: check and edit them, then choose Ask. Nothing has run.'

export const EMPTY_TRANSCRIPT_NOTE =
  'No speech was captured. The typed box above still works fully, or try speaking again.'

export const RAW_TEXT_DISCLOSURE =
  'Free-text Ask sends the words you type to the wording helper; this path cannot be answered from structured choices alone. The figures still come from CivicScope.'

/**
 * Starting points offered under the welcome. Each one is a shape the
 * intent path is verified to run — a two-place rent comparison (the
 * first was exercised live against the portal), a single-place lookup,
 * a bounded sweep, and a rent-burden comparison — over the displayable
 * housing figures. No example promises a verdict about a place; each
 * asks for figures the reader then weighs themselves.
 */
export const EXAMPLE_PROMPTS: readonly string[] = [
  'Compare rent in Honolulu and Hilo',
  'What is the median home value in Austin, Texas?',
  'Show me places in Colorado where rent is under $1,500 a month',
  'Compare rent burden in Portland and Seattle',
]

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
    <p role="note" className="house-disclosure mt-4">
      {DISCLOSURE_TEXT}
    </p>
  )
}

/**
 * Ask panel. Text is the primary path; mic (Item 12) is an equal main
 * input beside it — consent-gated in MicInput, and a transcript only
 * ever lands in the editable query text / understood-request chips
 * before anything can run. BYO recovery is wired here via ByoOffer
 * (settings/shutoff entry) + byoProvider retry.
 *
 * Union hand-merge (Panel B1): the CivicScope panel (diagnostics
 * counters, execution note, ExplainAction wiring) carries the Entire
 * tree's mic path, spoken-number gate, and AgentHandoff setup surface.
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
  censusFetcher,
  metaFetcher,
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
  /**
   * Runs the intent. May return a sentence for the reader: a mode can be
   * validated and still land on a surface that cannot express one of its
   * bounds, and saying so is better than changing nothing in silence.
   */
  onExecute?: (intent: ValidatedIntent) => string | void
  proxyError?: ProxyError | null
  clarificationCandidates?: ClarificationCandidates
  onOpenSettings?: () => void
  figures?: readonly FigureInput[]
  explanation?: ExplanationState
  onExplain?: (intent: ValidatedIntent) => void
  /** Probes for the setup surfaces' key validation; absent = shape-only. */
  censusFetcher?: CensusKeyFetcher
  metaFetcher?: MetaKeyFetcher
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
  const [executionNote, setExecutionNote] = useState('')

  const errorNote = proxyErrorNote(proxyError) ?? note

  function accept(result: IntentResult, spokenTranscript?: string) {
    const check = validateIntent(result.intent)
    if (!check.ok) {
      // Count the class only. The model's output and the reader's words are
      // deliberately not recorded anywhere.
      diagnostics.recordIntentFailure('schema_invalid')
      setNote('That request cannot be run as asked. Try the manual search below.')
      return
    }
    // One answer: the flag is stamped by its single owner, so the gate
    // below and ExplainOnAsk read the same runnability.
    const parsed = withRunnability(check.intent)
    // Spoken-number validation (mic path): every numeral heard must
    // match a number in the understood request. A mismatch fails
    // closed, the same way failed prose is withheld: the understood
    // request is not offered for execution, the words stay in the
    // editable text box, and nothing runs on a substituted number.
    if (spokenTranscript !== undefined) {
      const verdict = checkSpokenNumbers(spokenTranscript, parsed, validator)
      if (!verdict.pass) {
        setNote(SPOKEN_NUMBER_MISMATCH_NOTE)
        return
      }
    }
    if (result.prose) {
      const verdict = validator.validate(result.prose, [])
      if (!verdict.pass) {
        diagnostics.recordWithhold(verdict.failure)
        setNote('Wording was withheld for failing verification. Figures are shown without it.')
      }
    }
    setIntent(parsed)
    if (parsed.clarificationNeeded) {
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
      // A proxy failure is counted even when the BYO retry below recovers: the
      // shared path did fail, and hiding that would understate its error rate.
      diagnostics.recordIntentFailure(known ?? 'unexpected')
      diagnostics.recordErrorState(known ?? 'unexpected')
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
      <h2 id="ask-heading" className="section-title">
        Ask CivicScope
      </h2>
      {/* The welcome leads, per the owner's direction (2026-11-01): the
          AI greets and offers starting points instead of presenting a
          blank form. The wording invites the factors a person actually
          weighs; the examples stay inside the intent envelope the app
          can run (compare / lookup / filtered sweep over the housing
          figures), so a tapped example succeeds rather than stranding
          the reader in a clarification. */}
      <p className="mt-1 text-sm text-slate-700">
        Tell me what area you are in, or what area you want to check out, and
        what matters to you — schools, cost of living, rent, home prices — and
        I can research the areas in the federal data and show you the figures
        for your options.
      </p>
      <div className="mt-2 flex flex-wrap gap-2" aria-label="Example questions">
        {EXAMPLE_PROMPTS.map((example) => (
          <button
            key={example}
            type="button"
            disabled={busy}
            onClick={() => {
              setText(example)
              void runQuery(example)
            }}
            className="min-h-[44px] rounded-full border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          >
            {example}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="mt-4">
        <label htmlFor="ask-input" className="text-sm font-medium text-slate-900">
          Ask in plain language
        </label>
        <p id="ask-raw-text-note" role="note" className="house-raw-text-disclosure mt-1">
          {RAW_TEXT_DISCLOSURE}
        </p>
        <div className="mt-2 flex gap-2">
          <input
            id="ask-input"
            aria-describedby="ask-raw-text-note"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            className="field"
          />
          <button type="submit" disabled={busy} className="btn-primary shrink-0">
            Ask
          </button>
        </div>
      </form>
      <div className="mt-3">
        <MicInput
          transcribe={(audio, mimeType) =>
            provider.transcribe({ audio, mimeType }, new AbortController().signal)
          }
          onTranscript={handleTranscript}
          recorder={micRecorder}
          storage={micStorage}
        />
      </div>
      {errorNote && (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-700">
          {errorNote}
        </p>
      )}
      {(proxyError || note) && <p className="mt-2 text-sm text-slate-600">{manualFallbackNote()}</p>}
      <ByoOffer error={proxyError ?? caughtError} onOpenSettings={onOpenSettings} />
      <AgentHandoff censusFetcher={censusFetcher} metaFetcher={metaFetcher} />
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
              <button
                type="button"
                disabled={!onExecute}
                onClick={() => {
                  const said = onExecute?.(intent)
                  setExecutionNote(typeof said === 'string' ? said : 'Running this request.')
                }}
                className="btn-primary mt-3"
              >
                Run this request
              </button>
              {executionNote && (
                <p role="status" className="mt-2 text-sm text-slate-700">
                  {executionNote}
                </p>
              )}
              <ExplainOnAsk
                intent={intent}
                figures={figures}
                explanation={explanation}
                onExplain={onExplain}
                provider={provider}
              />
            </>
          )}
        </>
      )}
      <Disclosure />
    </section>
  )
}
