export interface FigureInput {
  key: string
  value: number | null
  marginOfError?: number
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
    <figure aria-label={figure.key}>
      <figcaption>{figure.key}</figcaption>
      <p>
        <strong>{formatted.headline}</strong>
      </p>
      <p>{formatted.provenance}</p>
      {figure.derivation ? (
        <details>
          <summary>How this figure was derived</summary>
          <p>{figure.derivation}</p>
        </details>
      ) : null}
    </figure>
  )
}
