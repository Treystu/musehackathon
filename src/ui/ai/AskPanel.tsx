import { useRef, useState } from 'react'
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
  ResearchResult,
  ResearchSource,
  TranscribeResult,
  ValidatedIntent,
} from '../../core/ai/provider'
import { diagnostics } from '../../core/ai/diagnostics'
import { canRun, validateIntent, withRunnability } from '../../core/ai/intent-schema'
import {
  NATIONAL_SCREEN_LABELS,
  rescueNationalScreen,
} from '../../core/ai/national-screen'
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
  'Free-text Ask sends the words you type to the wording helper. The figures still come from CivicScope.'

/**
 * Coverage honesty for criteria this dataset does not contain
 * (owner example, 2026-11-01: a move-to-Nevada question asking for
 * somewhere "not Republican"). The figures are Census Bureau data;
 * voter registration, party affiliation, and election results are
 * not in them, so a politics screen cannot be run or implied. When
 * the reader's words ask for one, say so plainly and let everything
 * else in the question proceed.
 */
export const POLITICS_COVERAGE_NOTE =
  'One part of that question sits outside this data: these figures are Census Bureau data, with no voter registration, party affiliation, or election results, so places cannot be screened by politics here. Everything else in the question is handled below.'

const POLITICS_QUESTION_RE =
  /\b(republican|democrat|democratic|liberal|conservative|political|politics|party affiliation|voter registration|red state|blue state)\b/i

export function politicsCoverageNote(queryText: string | undefined): string {
  return queryText && POLITICS_QUESTION_RE.test(queryText) ? POLITICS_COVERAGE_NOTE : ''
}

/**
 * Questions carrying criteria the Census data cannot serve — schools,
 * amenities, safety, political character, lifestyle, services — get a
 * grounded web answer alongside the figures (owner directive,
 * 2026-11-01: any question answerable). This lexical screen decides
 * only whether the research path fires; the research model does the
 * answering, with sources, and the politics coverage note above
 * remains the fallback when research itself cannot be reached.
 */
const OUTSIDE_KNOWLEDGE_RE =
  /\b(school|schools|starbucks|coffee shop|grocery|groceries|gym|gyms|nightlife|walkable|walkability|restaurant|restaurants|playground|hospital|clinic|doctor|airport|transit|commute|safety|crime|dangerous|families|kids|children|liberal|conservative|republican|democrat|democratic|political|politics|voter|voting|red state|blue state)\b/i

export function needsResearch(queryText: string | undefined): boolean {
  return !!queryText && OUTSIDE_KNOWLEDGE_RE.test(queryText)
}

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

/**
 * Failures worth waiting out (2026-11-01, owner-reported): the shared
 * helper's upstream flaps in minute-scale windows and its circuit
 * breaker pauses for ~30 s, so a single attempt fails a reader whose
 * question would have parsed seconds later. The delays below span a
 * full breaker cooldown; anything else (a bad key, an exhausted
 * budget, a shape refusal) will not heal by waiting and fails at once.
 */
const PARSE_RETRYABLE: ReadonlySet<ProxyError> = new Set([
  'breaker_open',
  'provider_down',
  'rate_limited',
])
const PARSE_RETRY_DELAYS_MS: readonly number[] = [5000, 12000, 25000]

export function Disclosure() {
  return (
    <p role="note" className="house-disclosure mt-4">
      {DISCLOSURE_TEXT}
    </p>
  )
}

/**
 * Ask panel. Text is the primary path; mic (Item 12) is an equal main
 * input beside it — consent-gated in MicInput. An accepted transcript
 * takes the same path as typed text and runs the same way (auto-run,
 * 2026-11-01); the guards are the confidence threshold, the
 * spoken-number check in accept(), and the editable text the words
 * land in. BYO recovery is wired here via ByoOffer
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
  parseRetryDelaysMs = PARSE_RETRY_DELAYS_MS,
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
  /** Wait-out schedule for retryable parse failures; tests inject ~0. */
  parseRetryDelaysMs?: readonly number[]
}) {
  const [text, setText] = useState('')
  const [intent, setIntent] = useState<ValidatedIntent | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [caughtError, setCaughtError] = useState<ProxyError | null>(null)
  const [executionNote, setExecutionNote] = useState('')
  const [coverageNote, setCoverageNote] = useState('')
  const [research, setResearch] = useState<
    | { status: 'idle' | 'loading' | 'unavailable' }
    | { status: 'done'; prose: string; sources: ResearchSource[] }
  >({ status: 'idle' })
  const researchRun = useRef(0)

  /**
   * Grounded web findings for the parts of a question the Census data
   * cannot serve (see needsResearch). Fired in parallel with the parse;
   * lands when it lands. A failure — or a reply with no sources — ends
   * in the unavailable state, and for a politics question the coverage
   * note takes over as the honest fallback.
   */
  function startResearch(queryText: string) {
    const run = ++researchRun.current
    setResearch({ status: 'loading' })
    const signal = new AbortController().signal
    const attempt = async (): Promise<ResearchResult> => {
      try {
        return await provider.research({ queryText }, signal)
      } catch (e) {
        if (byoProvider && hasMetaKey()) {
          return byoProvider.research({ queryText }, signal)
        }
        throw e
      }
    }
    void attempt().then(
      (result) => {
        if (researchRun.current !== run) return
        if (result.prose && result.sources.length > 0) {
          setResearch({ status: 'done', prose: result.prose, sources: result.sources })
          setCoverageNote('')
        } else {
          setResearch({ status: 'unavailable' })
          setCoverageNote(politicsCoverageNote(queryText))
        }
      },
      () => {
        if (researchRun.current !== run) return
        setResearch({ status: 'unavailable' })
        setCoverageNote(politicsCoverageNote(queryText))
      },
    )
  }

  const errorNote = proxyErrorNote(proxyError) ?? note

  /**
   * Auto-run (owner directive, 2026-11-01): a request that can run,
   * runs — on submit, on a chip, on an accepted transcript, on a
   * clarification pick, and on a committed editor change. The reader
   * never has to press a Run button; the understood request stays on
   * screen so what ran is always visible and adjustable.
   */
  function executeNow(next: ValidatedIntent) {
    if (!onExecute) return
    const said = onExecute(next)
    setExecutionNote(typeof said === 'string' ? said : '')
  }

  function accept(result: IntentResult, spokenTranscript?: string, queryText?: string) {
    const check = validateIntent(result.intent)
    // National-screen rescue: a placeless superlative ("cheapest rent in
    // America") clarifies with neither a place nor a measure, and the
    // clarification's only forward path was adding a place — which
    // defeats the question. When the reader's own words carry the
    // reading deterministically, present the country-wide screen as the
    // understood request instead; the note below discloses the reading
    // before anything runs. See core/ai/national-screen.ts. The rescue
    // reads only the reader's words, so it also covers a reply whose
    // shape failed validation — a malformed reply cannot widen it.
    let parsed: ValidatedIntent
    let rescued: ValidatedIntent | null = null
    if (!check.ok) {
      // Count the class only. The model's output and the reader's words are
      // deliberately not recorded anywhere.
      diagnostics.recordIntentFailure('schema_invalid')
      rescued = rescueNationalScreen(
        {
          mode: 'lookup',
          geographies: [],
          metricKeys: [],
          filters: [],
          clarificationNeeded: true,
        },
        queryText,
      )
      if (!rescued) {
        setNote('That request cannot be run as asked. Try the manual search below.')
        return
      }
      parsed = rescued
    } else {
      // One answer: the flag is stamped by its single owner, so the gate
      // below and ExplainOnAsk read the same runnability.
      parsed = withRunnability(check.intent)
      rescued = rescueNationalScreen(parsed, queryText)
      if (rescued) parsed = rescued
    }
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
    if (rescued) {
      const label = NATIONAL_SCREEN_LABELS[rescued.metricKeys[0]!] ?? 'that measure'
      setNote(
        `No place was named, so this screens the whole country by ${label}, lowest first. The understood request is below.`,
      )
    } else if (parsed.clarificationNeeded) {
      setNote('More detail is needed before anything runs. Check the understood request below.')
    }
    if (canRun(parsed)) executeNow(parsed)
  }

  /** Editor and clarification changes are committed picks; a runnable result runs. */
  function handleIntentChange(next: ValidatedIntent) {
    setIntent(next)
    if (canRun(next)) executeNow(next)
  }

  async function runQuery(queryText: string, spokenTranscript?: string) {
    setBusy(true)
    setNote('')
    setCoverageNote('')
    setCaughtError(null)
    // Research runs in parallel with the parse: it answers a different
    // part of the question (what the Census data cannot cover), so
    // neither waits on the other.
    if (needsResearch(queryText)) {
      startResearch(queryText)
    } else {
      researchRun.current += 1
      setResearch({ status: 'idle' })
    }
    const request = {
      slots: { geographyHints: [], metricHints: [] },
      queryText,
      locale: 'en' as const,
    }
    try {
      // Patient retry: retryable failures wait out the flap window
      // (PARSE_RETRYABLE / PARSE_RETRY_DELAYS_MS above) instead of
      // failing the reader's question on the first bad second.
      let accepted = false
      let lastErr: unknown
      for (let attempt = 0; attempt <= parseRetryDelaysMs.length && !accepted; attempt++) {
        try {
          accept(
            await provider.intent(request, new AbortController().signal),
            spokenTranscript,
            queryText,
          )
          accepted = true
        } catch (err) {
          lastErr = err
          const known = extractProxyError(err)
          // A proxy failure is counted per attempt, even when a retry
          // or the BYO path below recovers: the shared path did fail,
          // and hiding that would understate its error rate.
          diagnostics.recordIntentFailure(known ?? 'unexpected')
          if (
            !known ||
            !PARSE_RETRYABLE.has(known) ||
            attempt === parseRetryDelaysMs.length
          ) {
            break
          }
          setNote('The wording helper is briefly busy. Retrying your question…')
          await new Promise((resolve) => setTimeout(resolve, parseRetryDelaysMs[attempt]))
        }
      }
      if (accepted) return
      const known = extractProxyError(lastErr)
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
            queryText,
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
   * left in the editable text box. An accepted transcript runs the
   * exact same auto-run intent path as typed text, plus spoken-number
   * validation in accept() — speech gets no execution path of its own.
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
      {/*
        Hero composition (competition layer, 2026-11-01): the heading is
        display-size and centered, the welcome and examples center under
        it, and the question box below is the visual anchor. The heading
        text stays exactly "Ask CivicScope" — the accent span is
        presentation only.
      */}
      <h2
        id="ask-heading"
        className="text-center text-4xl font-light tracking-tight text-slate-900 sm:text-5xl"
      >
        Ask <span className="font-medium text-[rgb(var(--accent))]">CivicScope</span>
      </h2>
      {/* The welcome leads, per the owner's direction (2026-11-01): the
          AI greets and offers starting points instead of presenting a
          blank form. The wording invites the factors a person actually
          weighs; the examples stay inside the intent envelope the app
          can run (compare / lookup / filtered sweep over the housing
          figures), so a tapped example succeeds rather than stranding
          the reader in a clarification. */}
      <p className="mx-auto mt-3 max-w-xl text-center text-base text-slate-600">
        Tell me what area you are in, or what area you want to check out, and
        what matters to you — schools, cost of living, rent, home prices — and
        I can research the areas in the federal data and show you the figures
        for your options.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2" aria-label="Example questions">
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
      <form onSubmit={submit} className="mx-auto mt-6 max-w-2xl">
        <label htmlFor="ask-input" className="sr-only">
          Ask in plain language
        </label>
        {/*
          The question box is the page's hero (redesign, 2026-11-01): one
          rounded field with a soft shadow, the way a search box sits on a
          search page — the input is borderless inside it and the Ask
          button is a pill at its right edge. The visible label became
          screen-reader-only; the box itself, the welcome above it and the
          examples carry the invitation. The raw-text disclosure stays
          directly under the box it describes.
        */}
        <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1.5 pl-5 pr-1.5 shadow-[0_1px_6px_rgba(32,33,36,0.14)] transition-shadow focus-within:shadow-[0_2px_12px_rgba(32,33,36,0.22)] hover:shadow-[0_2px_10px_rgba(32,33,36,0.18)]">
          <input
            id="ask-input"
            aria-describedby="ask-raw-text-note"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            placeholder="Ask in plain language"
            className="min-w-0 flex-1 bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-500"
          />
          <button type="submit" disabled={busy} className="btn-primary shrink-0">
            Ask
          </button>
        </div>
        <p id="ask-raw-text-note" role="note" className="house-raw-text-disclosure mt-2 pl-5">
          {RAW_TEXT_DISCLOSURE}
        </p>
      </form>
      <div className="mt-3 flex justify-center">
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
      {coverageNote && (
        <p role="note" className="mt-2 text-sm text-slate-600">
          {coverageNote}
        </p>
      )}
      {research.status === 'loading' && (
        <p role="status" className="mt-2 text-sm text-slate-600">
          Looking up what the Census data does not cover…
        </p>
      )}
      {research.status === 'done' && (
        <section aria-label="From the web" className="mt-4 border-t border-slate-200 pt-3">
          <h3 className="text-sm font-semibold text-slate-800">From the web</h3>
          <p className="mt-1 text-xs text-slate-500">
            Web findings via Muse search, with sources. These are not Census figures; the
            Census figures for this question are computed separately and shown with their
            own sources.
          </p>
          {research.prose.split(/\n\n+/).map((para, i) => (
            <p key={i} className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-700">
              {para}
            </p>
          ))}
          <ul className="mt-2 list-disc pl-5 text-sm">
            {research.sources.map((s) => (
              <li key={s.url}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[#1a73e8] underline"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {research.status === 'unavailable' && (
        <p role="note" className="mt-2 text-sm text-slate-600">
          Web findings are unavailable right now. The Census figures for this question still
          work.
        </p>
      )}
      {proxyError && <p className="mt-2 text-sm text-slate-600">{manualFallbackNote()}</p>}
      <ByoOffer error={proxyError ?? caughtError} onOpenSettings={onOpenSettings} />
      <AgentHandoff censusFetcher={censusFetcher} metaFetcher={metaFetcher} />
      {intent && (
        <>
          <IntentEditor intent={intent} onChange={handleIntentChange} />
          {!canRun(intent) ? (
            <ClarificationPanel
              intent={intent}
              candidates={
                clarificationCandidates ?? { geographies: [], metricKeys: [] }
              }
              onResolve={handleIntentChange}
            />
          ) : (
            <>
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
