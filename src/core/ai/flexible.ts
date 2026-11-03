/**
 * THE FLEXIBLE COMPLETION LANE (owner directive, 2026-11-02 14:59
 * HST — "we don't need exact cards, we need immediate flexibility to
 * accommodate all prompts"; Jev gate on the revised plan:
 * PROCEED-with-note, the note being the structural safeguards in
 * this module).
 *
 * The strict lane stays the default for Census-servable prompts:
 * screen -> research -> compose -> verify, fail-closed. Its one
 * no-card terminal this lane exists for is research mismatch: the
 * research stage succeeded and named places for the reader's stated
 * criteria, but none of those names resolved to a Census place in
 * the loaded data, so the strict answer is the honest note and
 * nothing else (measured live twice, 2026-11-02 14:44 + 14:54 HST:
 * the owner's schools + fast-food question ended on that note in
 * two consecutive windows). The flexible lane completes THAT
 * terminal — and only that terminal. Provider failures still throw
 * to their own note; safety refusals still refuse; a genuine
 * Census screen that finds no matching place still says so.
 *
 * The completion is a Muse-model answer on the hourglass seams the
 * runner already owns (Spark drafts, the item-9 Jev loop evaluates
 * and patches, the Wonder verify bookend labels), and its honesty
 * is STRUCTURAL, not promissory:
 *
 *   - The answer renders through the typed shape below, and every
 *     place and every figure carries an evidence class:
 *     census_measured (a screened row backs it, exactly),
 *     research_named (the cited research named it), or
 *     model_knowledge (the model's own knowledge, labelled as such).
 *   - verifyFlexibleAnswer — the deterministic validator's
 *     extension for this lane — rejects any figure whose class is
 *     missing or unknown, any census_measured figure without a
 *     screened row behind it at exact equality (the strict rule,
 *     unchanged), and any research_named place the research did
 *     not in fact name. A completion that fails validation does
 *     not render: the strict lane's honest note stands instead
 *     (fail-closed, exactly as a withheld strict answer behaves).
 *   - The render component takes only this typed shape and prints
 *     the class label in plain words beside the content, so an
 *     unlabeled figure has no path to the screen.
 *
 * This module is the shared surface: types + labels + the draft
 * reply's closed-schema parser + the server packet builder + the
 * validator extension + the client transport. The orchestration
 * (draft -> loop -> bookend) lives in ui/ai/flexible-runner.ts; the
 * route (functions/api/muse/flexible.ts) builds its prompt from
 * the packet builder here, the same split the bookends use.
 */
import type { AreaRow } from '../plugins/acs'
import { findBannedConstruction } from './validator'

/* ------------------------------------------------------------------ */
/* Evidence classes                                                    */
/* ------------------------------------------------------------------ */

export type EvidenceClass = 'census_measured' | 'research_named' | 'model_knowledge'

export const EVIDENCE_CLASSES: readonly EvidenceClass[] = [
  'census_measured',
  'research_named',
  'model_knowledge',
]

/**
 * The plain-words label rendered beside every flexible place and
 * figure. The wording is the claim: a reader can tell at the point
 * of reading what kind of evidence stands behind each item, and
 * nothing on the flexible card borrows the Census label without
 * the census_measured class — which the validator backs with a row.
 */
export const EVIDENCE_CLASS_LABELS: Readonly<Record<EvidenceClass, string>> = {
  census_measured: 'Measured in Census data',
  research_named: 'Named in research — not matched to Census data',
  model_knowledge: "From the model's own knowledge — not measured",
}

/* ------------------------------------------------------------------ */
/* The typed render shape                                              */
/* ------------------------------------------------------------------ */

export interface FlexibleFigure {
  /** Reader-facing label, e.g. "Median gross rent". */
  label: string
  value: number
  /** Display unit the value is stated in ('/mo', '%', 'households'), when one applies. */
  unit?: string
  evidenceClass: EvidenceClass
  /** Required when evidenceClass is census_measured: the Census metric key. */
  censusKey?: string
  /** Required when evidenceClass is census_measured: the ZCTA whose screened row backs the value. */
  zcta?: string
  /** The margin the screened row carries, when the draft states it; verified like the value. */
  marginOfError?: number
  /** The derivation, shown verbatim, for any figure the model derived rather than read. */
  working?: string
}

export interface FlexiblePlace {
  name: string
  evidenceClass: EvidenceClass
  /** Why this place answers the criteria, in the draft's words. */
  note?: string
  figures: FlexibleFigure[]
}

export interface FlexibleAnswer {
  /** The completing prose: the direct answer to the question, figures carried in the typed lists. */
  prose: string
  places: FlexiblePlace[]
  /** Figures that belong to the answer as a whole rather than to one place. */
  figures: FlexibleFigure[]
}

/* ------------------------------------------------------------------ */
/* The draft request (client -> route) and the packet text (route)     */
/* ------------------------------------------------------------------ */

export interface FlexibleDraftRequest {
  question: string
  /** The stated criteria's reader-facing labels, in question order. */
  criteria: readonly string[]
  /** The places the cited research named (none matched Census data). */
  researchPlaces: readonly string[]
  /** The cited research findings, verbatim claim texts with their source URLs. */
  claims: readonly { text: string; sourceUrls: readonly string[] }[]
  /** The sources the surviving claims cite. */
  sources: readonly { title: string; url: string }[]
  /** A patch round: the previous draft serialized + the loop's named gaps verbatim. */
  revision?: { draftText: string; gaps: readonly string[] }
}

/**
 * The flexible route's packet limits — ONE contract, read by both
 * sides: the route (functions/api/muse/flexible.ts) validates
 * against these constants, and the client construction
 * (conformFlexibleDraftRequest below) conforms to the same values
 * before sending. They lived as separate literals on each side and
 * the construction never conformed: a zero-match run gathers its
 * evidence across several research passes, and the merged packet
 * legitimately exceeds the caps (measured 2026-11-03: 16 sources
 * and 14 claims bisect to the route's 400; the same packet sliced
 * to these limits returns the draft). The caps are prompt-economy
 * limits — the packet builder below already worked to them — so
 * conforming at construction loses nothing the draft would have
 * seen; it only stops the route from refusing the packet whole.
 */
export const FLEXIBLE_MAX_QUESTION_CHARS = 500
export const FLEXIBLE_MAX_CRITERIA = 8
export const FLEXIBLE_MAX_PLACES = 10
export const FLEXIBLE_MAX_CLAIMS = 12
export const FLEXIBLE_MAX_CLAIM_CHARS = 600
export const FLEXIBLE_MAX_SOURCES = 12
export const FLEXIBLE_MAX_SOURCE_URLS_PER_CLAIM = 12
export const FLEXIBLE_MAX_SOURCE_URL_CHARS = 500
export const FLEXIBLE_MAX_DRAFT_TEXT_CHARS = 6000
export const FLEXIBLE_MAX_GAPS = 8
export const FLEXIBLE_MAX_GAP_CHARS = 300

const PACKET_CLAIM_LIMIT = FLEXIBLE_MAX_CLAIMS
const PACKET_PLACE_LIMIT = FLEXIBLE_MAX_PLACES

/** Trim a text to a character budget at a word boundary. */
function trimAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()
}

/**
 * Split an over-cap claim text into consecutive claims at sentence
 * boundaries (a single run-on sentence is split at word
 * boundaries). The finding's words are all carried, in order —
 * the cap governs how much text rides in ONE claim, not whether
 * the finding reaches the packet.
 */
function splitClaimText(text: string): string[] {
  if (text.length <= FLEXIBLE_MAX_CLAIM_CHARS) return [text]
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    if (current) chunks.push(current)
    current = ''
  }
  for (const sentence of sentences.length > 0 ? sentences : [text]) {
    if (sentence.length > FLEXIBLE_MAX_CLAIM_CHARS) {
      flush()
      let rest = sentence
      while (rest.length > FLEXIBLE_MAX_CLAIM_CHARS) {
        const cut = trimAtWordBoundary(rest, FLEXIBLE_MAX_CLAIM_CHARS)
        chunks.push(cut)
        rest = rest.slice(cut.length).trimStart()
      }
      if (rest) current = rest
      continue
    }
    const joined = current ? `${current} ${sentence}` : sentence
    if (joined.length > FLEXIBLE_MAX_CLAIM_CHARS) {
      flush()
      current = sentence
    } else {
      current = joined
    }
  }
  flush()
  return chunks
}

/**
 * Conform a draft request to the route's packet limits (the
 * FLEXIBLE_MAX_* constants above) at the construction site.
 * Prioritization is the pipeline's own order throughout: the
 * leading criteria, places, claims, and sources the strict
 * pipeline gathered are the ones the packet carries — the same
 * leading material buildFlexiblePacketText would have used. A
 * claim's source list slices to the cap and drops any URL too
 * long to be a packet citation; an over-cap claim text is split,
 * never dropped (splitClaimText). A revision's gaps and draft
 * text trim at word boundaries: a patch instruction that exceeds
 * the cap cannot ride whole, and a trimmed instruction still
 * names its gap's subject, where a refused call would lose the
 * patch round entirely. Criterion labels and place names are
 * never truncated — a shortened name would mislabel the
 * accounting — and both are catalog/extraction strings far under
 * their caps in practice.
 */
export function conformFlexibleDraftRequest(
  request: FlexibleDraftRequest,
): FlexibleDraftRequest {
  const claims: { text: string; sourceUrls: string[] }[] = []
  for (const claim of request.claims) {
    if (!claim.text.trim()) continue
    const sourceUrls = claim.sourceUrls
      .filter((u) => u.length > 0 && u.length <= FLEXIBLE_MAX_SOURCE_URL_CHARS)
      .slice(0, FLEXIBLE_MAX_SOURCE_URLS_PER_CLAIM)
    for (const text of splitClaimText(claim.text)) {
      claims.push({ text, sourceUrls })
      if (claims.length >= FLEXIBLE_MAX_CLAIMS) break
    }
    if (claims.length >= FLEXIBLE_MAX_CLAIMS) break
  }
  return {
    question: request.question,
    criteria: request.criteria.slice(0, FLEXIBLE_MAX_CRITERIA),
    researchPlaces: request.researchPlaces.slice(0, FLEXIBLE_MAX_PLACES),
    claims,
    sources: request.sources.slice(0, FLEXIBLE_MAX_SOURCES),
    ...(request.revision
      ? {
          revision: {
            draftText: trimAtWordBoundary(
              request.revision.draftText,
              FLEXIBLE_MAX_DRAFT_TEXT_CHARS,
            ),
            gaps: request.revision.gaps
              .slice(0, FLEXIBLE_MAX_GAPS)
              .map((gap) => trimAtWordBoundary(gap, FLEXIBLE_MAX_GAP_CHARS)),
          },
        }
      : {}),
  }
}

/**
 * The route's user-packet text: the question, the evidence the
 * strict pipeline actually gathered, and the output contract. The
 * contract is stated to the model, but nothing here trusts the
 * statement — parseFlexibleDraft and verifyFlexibleAnswer enforce
 * it deterministically on the way back.
 */
export function buildFlexiblePacketText(request: FlexibleDraftRequest): string {
  const lines: string[] = []
  lines.push(`QUESTION: ${request.question}`)
  if (request.criteria.length > 0) {
    lines.push(`STATED CRITERIA: ${request.criteria.join('; ')}`)
  }
  lines.push(
    'SCREEN OUTCOME: the cited research named places for the stated criteria, but none of ' +
      'those places could be matched to Census data in the loaded dataset, so no Census ' +
      'figures are available for them from the screen.',
  )
  if (request.researchPlaces.length > 0) {
    lines.push(
      `PLACES THE RESEARCH NAMED: ${request.researchPlaces.slice(0, PACKET_PLACE_LIMIT).join('; ')}`,
    )
  }
  const claims = request.claims.slice(0, PACKET_CLAIM_LIMIT)
  if (claims.length > 0) {
    lines.push('RESEARCH FINDINGS (cited):')
    for (const claim of claims) lines.push(`- ${claim.text}`)
  }
  if (request.sources.length > 0) {
    lines.push('SOURCES:')
    for (const source of request.sources.slice(0, PACKET_CLAIM_LIMIT)) {
      lines.push(`- ${source.title} — ${source.url}`)
    }
  }
  if (request.revision) {
    lines.push('PREVIOUS DRAFT:')
    lines.push(request.revision.draftText)
    lines.push('ADDRESS THESE GAPS (revise the draft, do not restart it):')
    for (const gap of request.revision.gaps) lines.push(`- ${gap}`)
  }
  lines.push(
    'Reply with ONE JSON object and nothing else, of exactly this shape:\n' +
      '{"prose": string, "places": [{"name": string, "basis": "research"|"model", ' +
      '"note": string, "figures": [figure]}], "figures": [figure]}\n' +
      'figure = {"label": string, "value": number, "unit": string (optional), ' +
      '"basis": "census"|"research"|"model", "censusKey": string (census only), ' +
      '"zcta": string (census only), "working": string (required when the value is derived)}.\n' +
      'Rules: answer the question completely. Places from PLACES THE RESEARCH NAMED carry ' +
      'basis "research"; any other place carries basis "model". Every number in the answer ' +
      'appears in a figure with its basis: "research" for a figure the findings state, ' +
      '"model" for a figure from your own knowledge or a derivation (show the derivation in ' +
      '"working"), "census" ONLY for a figure the packet itself shows as a Census value for ' +
      'that ZCTA — when in doubt use "model". Do not recommend a place to live, rank places ' +
      'as best or worst beyond the stated criteria, or characterise a place by who lives there.',
  )
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* The draft reply's closed-schema parser                              */
/* ------------------------------------------------------------------ */

const BASIS_TO_CLASS: Readonly<Record<string, EvidenceClass>> = {
  census: 'census_measured',
  research: 'research_named',
  model: 'model_knowledge',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFigure(raw: unknown): FlexibleFigure | null {
  if (!isRecord(raw)) return null
  if (typeof raw.label !== 'string' || raw.label.length === 0) return null
  if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) return null
  if (typeof raw.basis !== 'string' || !(raw.basis in BASIS_TO_CLASS)) return null
  const figure: FlexibleFigure = {
    label: raw.label,
    value: raw.value,
    evidenceClass: BASIS_TO_CLASS[raw.basis]!,
  }
  if (typeof raw.unit === 'string' && raw.unit.length > 0) figure.unit = raw.unit
  if (typeof raw.censusKey === 'string' && raw.censusKey.length > 0) figure.censusKey = raw.censusKey
  if (typeof raw.zcta === 'string' && raw.zcta.length > 0) figure.zcta = raw.zcta
  if (typeof raw.marginOfError === 'number' && Number.isFinite(raw.marginOfError)) {
    figure.marginOfError = raw.marginOfError
  }
  if (typeof raw.working === 'string' && raw.working.length > 0) figure.working = raw.working
  return figure
}

function parseFigureList(raw: unknown): FlexibleFigure[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const figures: FlexibleFigure[] = []
  for (const entry of raw) {
    const figure = parseFigure(entry)
    if (!figure) return null
    figures.push(figure)
  }
  return figures
}

/**
 * Parse the route's draft object into the typed shape. Closed
 * schema, in the bookend parsers' discipline: anything off-schema
 * is null (a degradation — the strict terminal stands), never a
 * partially trusted draft. Note what the parser does NOT do: it
 * does not judge provenance. A figure can parse with the
 * census_measured class and still be a fabrication; the validator
 * below is the judge, and the runner never renders a draft the
 * validator has not passed.
 */
export function parseFlexibleDraft(body: unknown): FlexibleAnswer | null {
  if (!isRecord(body)) return null
  if (typeof body.prose !== 'string' || body.prose.trim().length === 0) return null
  const figures = parseFigureList(body.figures)
  if (!figures) return null
  const places: FlexiblePlace[] = []
  if (body.places !== undefined) {
    if (!Array.isArray(body.places)) return null
    for (const raw of body.places) {
      if (!isRecord(raw)) return null
      if (typeof raw.name !== 'string' || raw.name.length === 0) return null
      // A flexible PLACE is never census_measured — a place backed
      // by a screened row is a strict-lane place by definition — so
      // the place basis admits research/model only.
      if (raw.basis !== 'research' && raw.basis !== 'model') return null
      const placeFigures = parseFigureList(raw.figures)
      if (!placeFigures) return null
      places.push({
        name: raw.name,
        evidenceClass: BASIS_TO_CLASS[raw.basis]!,
        ...(typeof raw.note === 'string' && raw.note.length > 0 ? { note: raw.note } : {}),
        figures: placeFigures,
      })
    }
  }
  return { prose: body.prose.trim(), places, figures }
}

/** Serialize a flexible answer for the Jev loop's evaluation + patch requests. */
export function flexibleAnswerText(answer: FlexibleAnswer): string {
  const parts: string[] = [answer.prose]
  for (const place of answer.places) {
    parts.push(
      `${place.name} [${EVIDENCE_CLASS_LABELS[place.evidenceClass]}]` +
        (place.note ? `: ${place.note}` : ''),
    )
    for (const figure of place.figures) {
      parts.push(`  ${figure.label}: ${figure.value}${figure.unit ?? ''} [${EVIDENCE_CLASS_LABELS[figure.evidenceClass]}]`)
    }
  }
  for (const figure of answer.figures) {
    parts.push(`${figure.label}: ${figure.value}${figure.unit ?? ''} [${EVIDENCE_CLASS_LABELS[figure.evidenceClass]}]`)
  }
  return parts.join('\n')
}

/* ------------------------------------------------------------------ */
/* The validator extension                                             */
/* ------------------------------------------------------------------ */

function normalisePlaceName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The deterministic gate for a flexible completion — verifyAnswer's
 * sibling for this lane, applying the strict lane's provenance rule
 * to the flexible shape:
 *
 *   1. Every figure (answer-level and per-place) must carry a known
 *      evidence class. A missing or invented class is a rejection:
 *      an unlabeled figure never renders.
 *   2. A census_measured figure must name its metric key and ZCTA,
 *      the ZCTA must be one of the screened rows, and the value
 *      (and the margin, when stated) must equal the row's exactly —
 *      the same === rule verifyAnswer applies to strict figures.
 *      Claiming Census provenance without that row fails here.
 *   3. A research_named place must be a place the research in fact
 *      named (the pipeline's extraction record — every name the
 *      research stage pulled from the findings, compared
 *      name-normalised). Claiming research provenance for a place
 *      the model supplied itself fails here; the model's own places
 *      are welcome under model_knowledge, labelled as such.
 *   4. The prose surfaces (prose, place notes, figure workings)
 *      pass the banned-construction scan in criteria-grounded
 *      context — the posture the strict lane applies to researched
 *      claims: naming places against the reader's own stated
 *      criteria passes; steering, personal recommendation,
 *      superlatives the criteria do not ground, and characterising
 *      a place by who lives there do not.
 */
export function verifyFlexibleAnswer(
  answer: FlexibleAnswer,
  context: { rows: readonly AreaRow[]; researchNamedPlaces: readonly string[] },
): { ok: boolean; failures: string[] } {
  const failures: string[] = []
  if (!answer.prose || answer.prose.trim().length === 0) {
    failures.push('flexible answer carries no prose')
  }
  const rowByZcta = new Map(context.rows.map((row) => [row.zcta, row]))
  const researchNames = new Set(context.researchNamedPlaces.map(normalisePlaceName))

  const checkFigure = (figure: FlexibleFigure, where: string) => {
    if (!EVIDENCE_CLASSES.includes(figure.evidenceClass)) {
      failures.push(`figure without a valid evidence class (${where}): ${figure.label}`)
      return
    }
    if (figure.evidenceClass !== 'census_measured') return
    if (!figure.censusKey || !figure.zcta) {
      failures.push(
        `census figure without its metric key or ZCTA (${where}): ${figure.label}`,
      )
      return
    }
    const row = rowByZcta.get(figure.zcta)
    if (!row) {
      failures.push(
        `census figure claims a ZCTA with no screened row behind it (${where}): ${figure.label} for ${figure.zcta}`,
      )
      return
    }
    const expected = row.metrics[figure.censusKey]
    if (expected === null || expected === undefined || figure.value !== expected) {
      failures.push(
        `census figure mismatch (${where}): ${figure.label} for ${figure.zcta} states ${figure.value}, screened row ${String(expected)}`,
      )
    }
    if (figure.marginOfError !== undefined && figure.marginOfError !== (row.moes[figure.censusKey] ?? null)) {
      failures.push(
        `census margin mismatch (${where}): ${figure.label} for ${figure.zcta} states ${figure.marginOfError}, screened row ${String(row.moes[figure.censusKey] ?? null)}`,
      )
    }
  }

  for (const figure of answer.figures) checkFigure(figure, 'answer')
  for (const place of answer.places) {
    if (!EVIDENCE_CLASSES.includes(place.evidenceClass)) {
      failures.push(`place without a valid evidence class: ${place.name}`)
    } else if (
      place.evidenceClass === 'research_named' &&
      !researchNames.has(normalisePlaceName(place.name))
    ) {
      failures.push(`place claims research provenance the research did not name: ${place.name}`)
    }
    for (const figure of place.figures) checkFigure(figure, place.name)
  }

  const proseSurfaces = [
    answer.prose,
    ...answer.places.map((p) => p.note ?? ''),
    ...[...answer.figures, ...answer.places.flatMap((p) => p.figures)].map((f) => f.working ?? ''),
  ]
  for (const surface of proseSurfaces) {
    if (!surface) continue
    const banned = findBannedConstruction(surface, { criteriaGrounded: true })
    if (banned) failures.push(`banned construction in flexible answer (${banned}): ${surface}`)
  }

  return { ok: failures.length === 0, failures }
}

/* ------------------------------------------------------------------ */
/* Client transport                                                    */
/* ------------------------------------------------------------------ */

/**
 * The draft transport: one request to the flexible route, returning
 * the route's draft object (unparsed — parseFlexibleDraft owns the
 * schema) or null on any failure shape. Like the bookend
 * transports, every failure is a degradation to null, never a throw
 * the caller must handle: the strict terminal stands.
 */
export type FlexibleTransport = (request: FlexibleDraftRequest) => Promise<unknown>

export const FLEXIBLE_DRAFT_TIMEOUT_MS = 45_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('flexible draft timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function createHttpFlexibleTransport(
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
): FlexibleTransport {
  return async (request) => {
    try {
      const response = await withTimeout(
        fetcher('/api/muse/flexible', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        }),
        FLEXIBLE_DRAFT_TIMEOUT_MS,
      )
      if (!response.ok) return null
      const body = (await response.json()) as { outcome?: unknown; draft?: unknown }
      if (body.outcome !== 'draft') return null
      return body.draft ?? null
    } catch {
      return null
    }
  }
}
