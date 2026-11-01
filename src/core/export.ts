/**
 * CSV export of the loaded screen.
 *
 * Why this exists at all, in an application whose whole position is that the
 * browser fetches everything from the publisher: a reader who has just paid 43
 * Census requests for the country cannot keep it. Closing the tab drops it, and
 * re-loading tomorrow means paying again once the cache expires. An export is the
 * difference between reading the data and being able to use it, and it costs no
 * server, no account and no new request — the rows are already in memory.
 *
 * The columns are generated from the metric registry (`METRIC_KEYS`), not
 * hand-written. Until 2026-10-09 the export carried five figures because it
 * had its own hand-maintained list, which is exactly how an export drifts from
 * the app: ten figures the sweep was already fetching and displaying in the
 * drilldown were missing from the file. Every registered figure now exports,
 * each with its margin in a neighbouring `_moe` column when the row carries
 * one, so the file preserves the pairing the interface insists on — a survey
 * estimate without its precision is the thing this app exists to avoid.
 *
 * Two decisions, both of which deviate from the original plan on purpose:
 *
 * **Raw numbers, not formatted strings.** Headers carry the unit
 * (`median_gross_rent_usd_monthly`); every cell is the number the publisher
 * published. A spreadsheet's job is formatting; shipping pre-formatted strings
 * means shipping "$1,450" that no tool can sort.
 *
 * **Missing values are empty cells, not "N/A".** Empty is what every
 * spreadsheet and dataframe reader parses as missing; an "N/A" string forces
 * the column to text and silently breaks arithmetic on the values that are
 * present. The app itself still distinguishes the reasons for an absence in
 * its own UI, where there is room to.
 *
 * **Formula injection is treated as an attack.** Cell values here come from the
 * Census Bureau, so an attacker-controlled string is unlikely — but the city
 * names arrive via a baked file a future contributor could regenerate from
 * another source, and an export must not become the one place a spreadsheet
 * executes something. Any value beginning with `=`, `+`, `-`, `@`, a tab or a
 * carriage return gets a leading apostrophe, which every major spreadsheet
 * reads as literal text. This is the OWASP guidance for CSV, and it costs
 * nothing when nothing matches.
 *
 * The export preserves the order the reader last sorted by, deliberately: the
 * alternative would mean this module owning a definition of "the right order",
 * which is the ranking decision this application does not make.
 */
import { METRIC_KEYS, METRIC_DEFS_BY_KEY, type AreaRow } from './plugins/acs'

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r'])

/**
 * Escapes one CSV cell.
 *
 * Quotes only when needed — a quote, comma, newline or carriage return in the
 * value — because a file where every cell is quoted is 20% larger and no easier to
 * read. A leading apostrophe is added to formula-looking values *after* the
 * quoting decision, so the apostrophe is inside the quotes where it belongs.
 */
export function escapeCell(value: string): string {
  const needsQuotes = /[",\n\r]/.test(value)
  const guarded = FORMULA_PREFIXES.has(value[0] ?? '') ? `'${value}` : value
  return needsQuotes ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/** Unit suffixes for the header, so the file states what each number is. */
const UNIT_SUFFIX: Record<string, string> = {
  median_gross_rent: 'usd_monthly',
  median_home_value: 'usd',
  median_household_income: 'usd',
  median_rent_burden_pct: 'percent',
  average_household_size: 'persons',
}

/** zcta, city and state first, then every registered figure and its margin. */
export const COLUMNS = [
  { key: 'zcta', header: 'zcta' },
  { key: 'city', header: 'city' },
  { key: 'state', header: 'state' },
  ...METRIC_KEYS.flatMap((key) => {
    const def = METRIC_DEFS_BY_KEY.get(key)
    const unit = UNIT_SUFFIX[key] ?? def?.unit ?? ''
    const header = unit ? `${key}_${unit}` : key
    const moeHeader = unit ? `${key}_moe` : `${key}_moe`
    return [
      { key, header, isMetric: true as const },
      { key, header: moeHeader, isMetric: false as const },
    ]
  }),
] as const

export interface ExportOptions {
  /** `"Austin, TX"` for a ZIP code, or null when the mapping is unavailable. */
  placeLabel?: (zip: string) => string | null
}

/**
 * Builds the CSV for the loaded rows.
 *
 * A metric cell is the row's value or empty; a margin cell is the row's margin
 * or empty. Neither is ever zero: null means the publisher published nothing,
 * and writing anything else would invent a figure.
 */
export function toCsv(rows: readonly AreaRow[], options: ExportOptions = {}): string {
  const header = COLUMNS.map((c) => escapeCell(c.header)).join(',')
  const body = rows.map((row) => {
    const label = options.placeLabel?.(row.zcta) ?? null
    // The place label is "Name, ST", so the comma is split into two columns
    // rather than escaping a comma into one cell — a city and its state are
    // separate fields to anyone loading this into a tool.
    const city = label ? label.split(', ')[0] ?? '' : ''
    const state = label ? label.split(', ')[1] ?? '' : ''

    const cells = COLUMNS.map((col) => {
      if (col.key === 'zcta') return escapeCell(row.zcta)
      if (col.key === 'city') return escapeCell(city)
      if (col.key === 'state') return escapeCell(state)
      if ('isMetric' in col && col.isMetric) {
        const value = row.metrics[col.key] ?? null
        return value === null ? '' : String(value)
      }
      const moe = row.moes?.[col.key] ?? null
      return moe === null ? '' : String(moe)
    })
    return cells.join(',')
  })
  return [header, ...body].join('\r\n') + '\r\n'
}

/** A filename that names what it holds, without a timestamp nobody asked for. */
export const EXPORT_FILENAME = 'civicscope-zip-codes.csv'

/**
 * Triggers a download in the browser.
 *
 * A Blob URL rather than a data: URL, because a data URL of the country-wide
 * export is several megabytes of base64 built as one string, while a Blob streams.
 * The URL is revoked immediately after the click; the browser keeps its own
 * reference, and leaving it would leak on every export.
 */
export function downloadCsv(csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = EXPORT_FILENAME
  a.click()
  URL.revokeObjectURL(url)
}
