export interface FigureInput {
  key: string
  value: number | null
  marginOfError?: number
  suppressed?: boolean
  /** Local matching hints; these are not included in an ExplainRequest. */
  geographies?: readonly string[]
  /**
   * Display name of the place this figure belongs to, when the view
   * knows it. Carried into the ExplainRequest so explanation prose can
   * attribute the figure to its place by name (never by ZIP — a ZIP in
   * the prompt is a numeral the figure validator cannot tell apart
   * from an invented figure; same rule as the briefing path).
   */
  label?: string
  source: string
  publisher: string
  dataset: string
  table: string
  vintage: string
  derivation?: string
}

export interface FormattedFigure {
  headline: string
  moeText: string
  provenance: string
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

export function formatFigure(f: FigureInput): FormattedFigure {
  const provenance =
    `Source: ${f.source} · Publisher: ${f.publisher} · Dataset: ${f.dataset} · ` +
    `Table: ${f.table} · Vintage: ${f.vintage}`
  if (f.value === null) {
    return { headline: 'Not published / suppressed', moeText: '', provenance }
  }
  if (typeof f.marginOfError === 'number') {
    const moeText = `± ${formatNumber(f.marginOfError)}`
    return { headline: `${formatNumber(f.value)} ${moeText}`, moeText, provenance }
  }
  const moeText = 'no margin of error published'
  return { headline: `${formatNumber(f.value)} (${moeText})`, moeText, provenance }
}

const MOE_AFTER = /±|\+-|\+\/-|margin of error|moe/i
const NUMERAL = /\d[\d,]*(?:\.\d+)?/g

export function assertProseHasMoe(
  prose: string,
  figures: { key: string; value: number | null; marginOfError?: number }[],
): boolean {
  const matches = [...prose.matchAll(NUMERAL)]
  if (matches.length === 0) return true
  const moeStrings = new Set(
    figures
      .filter((g) => typeof g.marginOfError === 'number')
      .map((g) => formatNumber(g.marginOfError as number)),
  )
  for (const m of matches) {
    const start = m.index ?? 0
    const before = prose.slice(Math.max(0, start - 3), start)
    if (/±\s*$/.test(before)) continue
    const window = prose.slice(start + m[0].length, start + m[0].length + 60)
    if (MOE_AFTER.test(window)) continue
    let ok = false
    for (const s of moeStrings) {
      if (window.includes(s)) {
        ok = true
        break
      }
    }
    if (!ok) return false
  }
  return true
}

export function FigureCard({ figure }: { figure: FigureInput }) {
  const formatted = formatFigure(figure)
  return (
    <figure aria-label={figure.key} className="mt-2">
      <figcaption className="figure-label">{figure.key}</figcaption>
      <p className="mt-0.5">
        <strong className="figure-value">{formatted.headline}</strong>
      </p>
      <p className="text-sm text-slate-600">{formatted.provenance}</p>
      {figure.derivation ? (
        <details className="mt-1">
          <summary className="disclosure-summary">How this figure was derived</summary>
          <p className="text-base text-slate-700">{figure.derivation}</p>
        </details>
      ) : null}
    </figure>
  )
}
