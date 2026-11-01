import { useId, useState } from 'react'
import type { Composite } from '../core/scoring'
import { SCORE_RULES, SCORE_VERSION } from '../core/scoring'

const pct = (n: number) => `${Math.round(n * 100)}%`

function formatRaw(value: number | null, unit: string): string {
  if (value === null) return 'not available'
  if (unit === 'percent') return `${value}%`
  if (unit === 'ratio') return `${value}`
  if (unit === 'usd_monthly') return `$${value.toLocaleString('en-US')}/mo`
  if (unit === 'usd') return `$${value.toLocaleString('en-US')}`
  return value.toLocaleString('en-US')
}

/**
 * A composite index, always shown with its components.
 *
 * The score is a convenience. The components are the substance, and the
 * published weights are the operator's choice — so both are exposed rather than
 * buried. A user who disagrees with the weighting can see exactly which input
 * moved the result and judge it themselves.
 *
 * The `basis` string states which components were actually available, because
 * an index computed from a subset is a different measurement from one computed
 * in full and must not be presented as if they were the same.
 */
export function CompositeCard({ composite }: { composite: Composite }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  // The education composite is gone (see scoring.ts); affordability is the only
  // composite. The lookup stays a lookup rather than becoming SCORE_RULES
  // itself, so a future composite — added on a real finance source, say —
  // plugs back in here rather than getting its own card.
  const rules = composite.id === 'affordability' ? SCORE_RULES.affordability : SCORE_RULES.affordability

  return (
    <section
      className="rounded-lg border border-slate-300 bg-slate-50 p-4"
      aria-labelledby={`${composite.id}-heading`}
    >
      <h3 id={`${composite.id}-heading`} className="text-sm font-medium text-slate-700">
        {composite.label} index
      </h3>

      {composite.score === null ? (
        <p className="mt-2 text-lg text-slate-600">
          Not enough data to calculate this index for this area.
        </p>
      ) : (
        <>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">
            {composite.score}
            <span className="ml-1 text-base font-normal text-slate-500">/ 100</span>
          </p>
          <p className="mt-1 text-xs text-slate-600">{composite.basis}</p>
        </>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="mt-3 text-xs font-medium text-slate-700 underline hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-700"
      >
        {open ? 'Hide the components' : 'See the components and weights'}
      </button>

      {open && (
        <div id={panelId} className="mt-3">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">
              Components of the {composite.label} index, with our published weight for each and the raw value
            </caption>
            <thead>
              <tr className="border-b border-slate-300">
                <th scope="col" className="py-1 pr-2 font-semibold text-slate-700">Component</th>
                <th scope="col" className="py-1 pr-2 font-semibold text-slate-700">Value</th>
                <th scope="col" className="py-1 pr-2 font-semibold text-slate-700">Score</th>
                <th scope="col" className="py-1 font-semibold text-slate-700">Weight</th>
              </tr>
            </thead>
            <tbody>
              {composite.components.map((c) => {
                const rule = rules.find((r) => r.key === c.key)
                return (
                  <tr key={c.key} className="border-b border-slate-200 align-top">
                    <th scope="row" className="py-2 pr-2 font-normal text-slate-800">
                      {c.label}
                      {rule && <span className="mt-0.5 block text-slate-500">{rule.note}</span>}
                    </th>
                    <td className="py-2 pr-2 tabular-nums text-slate-700">{formatRaw(c.raw, c.unit)}</td>
                    <td className="py-2 pr-2 tabular-nums text-slate-700">
                      {c.excluded ? <span className="text-slate-400">—</span> : Math.round(c.score)}
                    </td>
                    <td className="py-2 tabular-nums text-slate-700">{pct(c.weight)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {composite.components.some((c) => c.excluded) && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-slate-600">
              {composite.components
                .filter((c) => c.excluded)
                .map((c) => (
                  <li key={c.key}>
                    <span className="font-medium">{c.label}:</span> {c.excluded}
                  </li>
                ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Index version {SCORE_VERSION}. Weights are our editorial choice, published so they can be examined
            and challenged. Individual figures are always shown above, unmodified, whatever this index says.
          </p>
        </div>
      )}
    </section>
  )
}
