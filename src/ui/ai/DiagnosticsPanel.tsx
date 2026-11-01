import { useState } from 'react'
import {
  collectDiagnostics,
  diagnostics,
  ERROR_STATES,
  INTENT_FAILURE_CLASSES,
  WITHHOLD_CLASSES,
  type DiagnosticsRecorder,
  type DiagnosticsSnapshot,
} from '../../core/ai/diagnostics'

type Status = 'idle' | 'working' | 'ready' | 'failed'

function label(key: string): string {
  return key
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function CounterList({
  title,
  entries,
}: {
  title: string
  entries: ReadonlyArray<readonly [string, number]>
}) {
  const recorded = entries.filter(([, count]) => count > 0)
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {recorded.length === 0 ? (
        <p className="mt-1 text-sm text-slate-600">None recorded in this browser.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {recorded.map(([key, count]) => (
            <li key={key} className="flex items-baseline justify-between gap-3">
              <span className="text-slate-700">{label(key)}</span>
              <span className="font-mono text-slate-900">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function entries<K extends string>(
  counts: Record<K, number>,
  keys: readonly K[],
): Array<readonly [string, number]> {
  return keys.map((key) => [key, counts[key]] as const)
}

/**
 * F7 user-facing diagnostics. View is counts only; the export adds the
 * deployment's own observed facts (route statuses, key presence, meter totals,
 * build identity) so a failure can be described without anyone handing over a
 * question, a key, or a model reply.
 */
export function DiagnosticsPanel({
  recorder = diagnostics,
  collect = collectDiagnostics,
}: {
  recorder?: DiagnosticsRecorder
  collect?: typeof collectDiagnostics
} = {}) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>(() => recorder.snapshot())
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')

  async function download() {
    setStatus('working')
    setMessage('')
    try {
      const artifact = await collect({ recorder })
      setSnapshot(artifact.local)
      const text = JSON.stringify(artifact, null, 2)
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `civicscope-diagnostics-${artifact.generatedAt.replace(/[:.]/g, '-')}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      setStatus('ready')
      setMessage(
        artifact.unknowns.length === 0
          ? 'Diagnostics downloaded.'
          : `Diagnostics downloaded. ${artifact.unknowns.length} value(s) could not be observed; the file lists them instead of guessing.`,
      )
    } catch {
      setStatus('failed')
      setMessage('The export could not be produced. Nothing was downloaded.')
    }
  }

  return (
    <section aria-labelledby="diagnostics-heading">
      <h2 id="diagnostics-heading" className="section-title">
        Diagnostics
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-700">
        These counts stay in this browser. They record failure classes only: never your questions,
        the figures you viewed, a key, or any model output.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <CounterList
          title="Wording withheld"
          entries={entries(snapshot.withholds, WITHHOLD_CLASSES)}
        />
        <CounterList
          title="Ask failures"
          entries={entries(snapshot.intentFailures, INTENT_FAILURE_CLASSES)}
        />
        <CounterList
          title="Helper errors"
          entries={entries(snapshot.errorStates, ERROR_STATES)}
        />
      </div>
      <div className="mt-5">
        <button
          type="button"
          onClick={() => void download()}
          disabled={status === 'working'}
          className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
        >
          {status === 'working' ? 'Collecting…' : 'Download diagnostics'}
        </button>
        <p role="status" className="mt-2 text-sm text-slate-700">
          {message}
        </p>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-600">
        The download adds route status codes, whether this deployment has a shared key configured,
        aggregate meter counts, and the build commit when the server reports it. Values that cannot
        be observed are named in the file rather than guessed.
      </p>
    </section>
  )
}
