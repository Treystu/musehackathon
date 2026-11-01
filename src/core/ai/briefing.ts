/**
 * F6 briefing pack generation (plan sections L1.3, 6.2.7, 6.5.6).
 *
 * A pack is generated for a view/selection the user built, never for
 * pre-chosen areas. The load-bearing rule is re-verification: every
 * included figure is checked against its SourceRef at generation time,
 * through a resolver the caller supplies (in the app, a re-read of the
 * data layer; in tests, a fixture). A figure that does not come back
 * exactly as included — changed value, changed margin of error, or a
 * source that no longer resolves — fails the whole generation loudly.
 * There is no partial pack: a pack with one wrong figure is a wrong
 * pack, so the failure is the deliverable instead.
 *
 * The narrative is the only model prose in the pack, and it goes
 * through the same F4 validator as every other surface (validator.ts),
 * against the verified figures. A failed verdict withholds the wording
 * and ships the figures, exactly as Explain does. Everything else in
 * the pack — cover line, figure tables, methodology appendix — is
 * generated in code from the verified figures and the registry, so it
 * cannot drift from either.
 */
import { METRIC_DEFS_BY_KEY } from '../civicscope-registry'
import type { SourceRef } from '../types'
import { isKnownFigureKey } from './intent-schema'
import {
  MAX_BRIEFING_VALUES,
  type BriefingRequest,
  type MuseProvider,
} from './provider'
import {
  createValidator,
  isSuppressedFigure,
  type FigureForValidation,
  type Validator,
  type ValidatorFailure,
} from './validator'

/** A figure as included in a pack: the value plus where it came from. */
export interface BriefingFigure {
  key: string
  /** Place label or ZIP this figure belongs to, as shown in the view. */
  geography: string
  value: number | null
  marginOfError?: number
  suppressed?: boolean
  source: SourceRef
}

/** What the source says now, when the pack is generated. */
export interface ResolvedFigure {
  value: number | null
  marginOfError?: number
}

/**
 * Re-reads one figure from its source. Returns null when the source
 * cannot resolve the figure at all. Implementations must fetch or
 * re-derive the figure; returning the included figure unchanged would
 * make re-verification a rubber stamp, and the tampered-figure fixture
 * exists to catch exactly that.
 */
export type FigureResolver = (
  figure: BriefingFigure,
) => Promise<ResolvedFigure | null>

export type FigureMismatchReason =
  | 'source_unresolvable'
  | 'value_mismatch'
  | 'moe_mismatch'

export interface FigureMismatch {
  key: string
  geography: string
  reason: FigureMismatchReason
  /** The value the pack tried to include. */
  included: number | null
  /** The value the source returned at generation time. */
  resolved: number | null
}

/** Generation failed because at least one figure did not re-verify. */
export class BriefingVerificationError extends Error {
  readonly mismatches: readonly FigureMismatch[]
  constructor(mismatches: readonly FigureMismatch[]) {
    const list = mismatches
      .map((m) => `${m.key} (${m.geography}): ${m.reason}`)
      .join('; ')
    super(
      `briefing pack refused: ${mismatches.length} figure(s) failed re-verification: ${list}`,
    )
    this.name = 'BriefingVerificationError'
    this.mismatches = mismatches
  }
}

function sameNumber(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a === b
}

/**
 * Re-verify every figure against its source. Returns the mismatches;
 * an empty list means 100% of the figures re-verified. All figures are
 * checked even after a failure, so the error names every bad figure,
 * not just the first.
 */
export async function verifyBriefingFigures(
  figures: readonly BriefingFigure[],
  resolveFigure: FigureResolver,
): Promise<FigureMismatch[]> {
  const mismatches: FigureMismatch[] = []
  for (const figure of figures) {
    const resolved = await resolveFigure(figure)
    if (resolved === null) {
      mismatches.push({
        key: figure.key,
        geography: figure.geography,
        reason: 'source_unresolvable',
        included: figure.value,
        resolved: null,
      })
      continue
    }
    if (resolved.value !== figure.value) {
      mismatches.push({
        key: figure.key,
        geography: figure.geography,
        reason: 'value_mismatch',
        included: figure.value,
        resolved: resolved.value,
      })
      continue
    }
    if (!sameNumber(resolved.marginOfError, figure.marginOfError)) {
      mismatches.push({
        key: figure.key,
        geography: figure.geography,
        reason: 'moe_mismatch',
        included: figure.marginOfError ?? null,
        resolved: resolved.marginOfError ?? null,
      })
    }
  }
  return mismatches
}

export interface BriefingPackRequest {
  /** Stable surface name only; must not contain the reader's search text. */
  figureSetId: string
  title: string
  /** The view class the selection came from, e.g. "comparison". */
  viewKind: string
  places: string[]
  figures: BriefingFigure[]
  /** URL that reproduces the underlying view, when the view has one. */
  packUrl?: string
  /** Injectable for deterministic tests; defaults to now. */
  generatedAt?: Date
}

export interface BriefingFigureRow {
  geography: string
  key: string
  label: string
  headline: string
  provenance: string
}

export interface BriefingPack {
  coverLine: string
  /** Validator-passed narrative. Absent when the wording was withheld. */
  narrative?: string
  narrativeWithheld: boolean
  withholdClass?: ValidatorFailure
  rows: BriefingFigureRow[]
  /** Methodology/citation appendix, generated from registry + SourceRefs. */
  appendix: string[]
  fairHousingNote: string
  packUrl?: string
  /** Figures included, all of which re-verified (generation throws otherwise). */
  verifiedCount: number
  /** The whole pack as plain text: what the UI shows and a share/download carries. */
  text: string
}

const FAIR_HOUSING_NOTE =
  'CivicScope figures describe places, not people, and no figure in this pack ' +
  'ranks or recommends a place. The pack was generated from the view you built; ' +
  'it contains no personal data, and no search text or key leaves your browser.'

function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

/** Figure tables exactly as rendered in-app: value, MOE, source. */
function rowFor(figure: BriefingFigure): BriefingFigureRow {
  const def = METRIC_DEFS_BY_KEY.get(figure.key)
  const label = def?.label ?? figure.key
  const s = figure.source
  const provenance =
    `Source: ${s.citation ?? s.dataset} · Publisher: ${s.publisher} · Dataset: ${s.dataset} · ` +
    `Table: ${s.tableId} · Vintage: ${s.vintage}`
  let headline: string
  if (figure.value === null || figure.suppressed) {
    headline = 'Not published / suppressed'
  } else if (typeof figure.marginOfError === 'number') {
    headline = `${formatNumber(figure.value)} ± ${formatNumber(figure.marginOfError)}`
  } else {
    headline = `${formatNumber(figure.value)} (no margin of error published)`
  }
  return { geography: figure.geography, key: figure.key, label, headline, provenance }
}

function appendixFor(figures: readonly BriefingFigure[]): string[] {
  const lines: string[] = []
  const seenKeys = new Set<string>()
  for (const figure of figures) {
    if (seenKeys.has(figure.key)) continue
    seenKeys.add(figure.key)
    const def = METRIC_DEFS_BY_KEY.get(figure.key)
    if (def) {
      lines.push(`${def.label} (${def.key}) — ${def.category}, unit: ${def.unit}. ${def.note}`)
    } else {
      lines.push(`${figure.key} — not a registry metric; included as supplied by its source.`)
    }
  }
  const seenSources = new Set<string>()
  for (const figure of figures) {
    const s = figure.source
    const id = `${s.publisher}|${s.dataset}|${s.tableId}|${s.vintage}`
    if (seenSources.has(id)) continue
    seenSources.add(id)
    lines.push(
      `Citation: ${s.publisher}, ${s.dataset}, table ${s.tableId}, vintage ${s.vintage}. ${s.url}`,
    )
  }
  return lines
}

function validationFigures(figures: readonly BriefingFigure[]): FigureForValidation[] {
  return figures.map((f) => ({
    key: f.key,
    value: f.value,
    marginOfError: f.marginOfError,
    vintage: f.source.vintage,
    suppressed: f.suppressed,
  }))
}

/**
 * Generate a briefing pack. Throws BriefingVerificationError when any
 * figure fails re-verification, and a plain Error for an empty or
 * oversize figure set — both loudly, before any model call is made.
 */
export async function generateBriefingPack(
  req: BriefingPackRequest,
  deps: { provider: MuseProvider; resolveFigure: FigureResolver; validator?: Validator },
): Promise<BriefingPack> {
  if (req.figures.length === 0) {
    throw new Error('briefing pack refused: a pack needs at least one figure')
  }
  if (req.figures.length > MAX_BRIEFING_VALUES) {
    throw new Error(
      `briefing pack refused: ${req.figures.length} figures exceeds the ${MAX_BRIEFING_VALUES}-figure ceiling`,
    )
  }

  const mismatches = await verifyBriefingFigures(req.figures, deps.resolveFigure)
  if (mismatches.length > 0) throw new BriefingVerificationError(mismatches)

  const validator = deps.validator ?? createValidator()
  const values = req.figures.map((f) => ({
    key: f.key,
    value: f.suppressed ? null : f.value,
    marginOfError: f.suppressed ? undefined : f.marginOfError,
  }))

  let narrative: string | undefined
  let narrativeWithheld = false
  let withholdClass: ValidatorFailure | undefined
  const result = await deps.provider.briefing(
    { figureSetId: req.figureSetId, values },
    new AbortController().signal,
  )
  if (result?.withheld) {
    narrativeWithheld = true
    withholdClass = result.withholdClass
  } else if (typeof result?.prose === 'string' && result.prose.trim() !== '') {
    const verdict = validator.validate(result.prose, validationFigures(req.figures))
    if (verdict.pass) {
      narrative = result.prose
    } else {
      narrativeWithheld = true
      withholdClass = verdict.failure
    }
  } else {
    // No wording came back. The pack still ships its figures; the
    // narrative is absent rather than invented locally to fill the gap.
    narrativeWithheld = true
  }

  const generatedAt = req.generatedAt ?? new Date()
  const vintages = [...new Set(req.figures.map((f) => f.source.vintage))]
  const coverLine =
    `Briefing pack — ${req.title} (${req.viewKind}) — ${req.places.join(', ')} — ` +
    `generated ${generatedAt.toISOString().slice(0, 10)} — figure vintages: ${vintages.join(', ')}`

  const rows = req.figures.map(rowFor)
  const appendix = appendixFor(req.figures)

  const textLines: string[] = [coverLine, '']
  if (narrative) textLines.push(narrative, '')
  else if (narrativeWithheld) {
    textLines.push('Narrative withheld. The figures are shown without wording.', '')
  }
  textLines.push('Figures:')
  for (const row of rows) {
    textLines.push(`- ${row.geography} — ${row.label}: ${row.headline}`)
    textLines.push(`  ${row.provenance}`)
  }
  textLines.push('', 'Methodology and citations:')
  for (const line of appendix) textLines.push(`- ${line}`)
  textLines.push('', FAIR_HOUSING_NOTE)
  if (req.packUrl) textLines.push('', `This pack\u2019s view: ${req.packUrl}`)

  return {
    coverLine,
    narrative,
    narrativeWithheld,
    withholdClass,
    rows,
    appendix,
    fairHousingNote: FAIR_HOUSING_NOTE,
    packUrl: req.packUrl,
    verifiedCount: req.figures.length,
    text: textLines.join('\n'),
  }
}

/**
 * Union hand-merge (Panel B1): the Entire tree's request-side figure-set
 * verification, kept alongside the pack generation above. The pack path
 * re-verifies figures against their sources through a resolver; this
 * path verifies a figure set carried in a briefing REQUEST against the
 * registry before any provider call (bounds, suppression, duplicate and
 * unknown keys fail loudly). Its figure type is named
 * BriefingRequestFigure here because BriefingFigure above is the pack's
 * figure (with geography and SourceRef); in the Entire tree the request
 * figure held that name.
 */
export interface BriefingRequestFigure {
  key: string
  value: number | null
  marginOfError?: number
  vintage?: string
}

export type FigureSetVerification =
  | { ok: true; figures: FigureForValidation[] }
  | { ok: false; key: string; detail: string }

function fail(key: string, detail: string): FigureSetVerification {
  return { ok: false, key, detail }
}

/**
 * Value bounds a figure's source unit permits. Percent figures are
 * bounded 0-100; every other registry unit (dollars, counts, ratios,
 * indexes) is non-negative. Code-supplied derived figures have no
 * registry row: they get the percent bound when their name says
 * percent (`derived:renter_pct`) and the non-negative bound otherwise.
 */
function valueOutOfBounds(key: string, value: number): string | null {
  const def = METRIC_DEFS_BY_KEY.get(key)
  const isPercent = def ? def.unit === 'percent' : /(pct|percent)/i.test(key)
  if (isPercent && (value < 0 || value > 100)) {
    return `percent figure out of bounds: ${value}`
  }
  if (!isPercent && value < 0) {
    return `negative figure for a non-negative unit: ${value}`
  }
  return null
}

/**
 * Re-verify a whole figure set against source data. The set passes
 * only if every figure passes; the first failure names its figure.
 */
export function verifyFigureSet(
  values: readonly BriefingRequestFigure[],
): FigureSetVerification {
  const seen = new Set<string>()
  const figures: FigureForValidation[] = []
  for (const figure of values) {
    const { key } = figure
    if (!isKnownFigureKey(key)) {
      return fail(key, 'figure key not in the source registry')
    }
    if (seen.has(key)) {
      return fail(key, 'duplicate figure key in set; a pack cannot tell which value is the source value')
    }
    seen.add(key)
    if (figure.value === null || !Number.isFinite(figure.value)) {
      return fail(key, 'figure carries no value (not published or suppressed at source)')
    }
    const bounds = valueOutOfBounds(key, figure.value)
    if (bounds) return fail(key, bounds)
    if (
      figure.marginOfError !== undefined &&
      (!Number.isFinite(figure.marginOfError) || figure.marginOfError < 0)
    ) {
      return fail(key, `margin of error cannot be negative: ${figure.marginOfError}`)
    }
    if (figure.vintage !== undefined) {
      if (!/^\d{4}$/.test(figure.vintage)) {
        return fail(key, `vintage is not a 4-digit year: ${figure.vintage}`)
      }
      const year = Number(figure.vintage)
      if (year < 1900 || year > 2100) {
        return fail(key, `vintage year out of range: ${figure.vintage}`)
      }
    }
    const candidate: FigureForValidation = {
      key,
      value: figure.value,
      marginOfError: figure.marginOfError,
      vintage: figure.vintage,
    }
    if (isSuppressedFigure(candidate)) {
      return fail(key, 'figure is suppressed at source and cannot be briefed')
    }
    figures.push(candidate)
  }
  return { ok: true, figures }
}

/**
 * Compose the provider request from a verified figure set. Returns
 * the verification failure unchanged when the set does not verify.
 * (Union adaptation: the provider's BriefingRequest values carry no
 * vintage field in this tree, so the composed request omits it;
 * verification above still checks a supplied vintage.)
 */
export function composeBriefingRequest(
  figureSetId: string,
  values: readonly BriefingRequestFigure[],
): { ok: true; request: BriefingRequest; figures: FigureForValidation[] } | { ok: false; key: string; detail: string } {
  const verification = verifyFigureSet(values)
  if (!verification.ok) return verification
  return {
    ok: true,
    figures: verification.figures,
    request: {
      figureSetId,
      values: verification.figures.map((f) => ({
        key: f.key,
        value: f.value as number,
        marginOfError: f.marginOfError,
      })),
    },
  }
}
