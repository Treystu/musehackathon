import type {
  AnswerFigure,
  AnswerPlace,
  AnswerSource,
  ComposedAnswer,
  ResearchedClaim,
} from '../../core/ai/answer'
import { METRIC_DEFS_BY_KEY } from '../../core/civicscope-registry'
import {
  answerPlaceAnchorId,
  qualifyingPlacesMapRelevant,
  resultMapRelevant,
} from '../../core/map/result-scale'
import { formatMetricNumber } from '../metric-format'
import { ResultMap } from '../map/ResultMap'
import { GateStatesMap } from '../map/GateStatesMap'
import { QualifyingPlacesMap } from '../map/QualifyingPlacesMap'
import { ProgressivePlacesMap } from '../map/ProgressivePlacesMap'
import { FlexibleAnswer } from './FlexibleAnswer'
import { HelpTip } from './HelpTip'
import { measureLabel } from './plain-labels'

/**
 * The composed answer, rendered as the primary result of an Ask
 * question (owner directive, 2026-11-02: answer first — the table and
 * map become supporting evidence below this card).
 *
 * The card renders only what the pipeline verified. A 'withheld' or
 * 'blocked' answer shows one quiet line and none of its places or
 * claims: a partly verified answer is not an answer, and leaking the
 * unverified half under a disclaimer would defeat the verify stage.
 * An 'empty' answer says so in one line; the data views below still
 * serve the reader, so no state here is a dead end.
 *
 * Figures are formatted exactly as the screening table formats them
 * (SweepTable's fmt/fmtMargin: sweep precision, no percent suffix,
 * margin rounded and set beside the figure), with labels and units
 * from the metric registry the data views are generated from.
 */

/** Places shown before the card defers to the screening table below. */
export const ANSWER_CARD_PLACE_LIMIT = 10

const count = new Intl.NumberFormat('en-US')

function figureLabel(key: string): string {
  return METRIC_DEFS_BY_KEY.get(key)?.label ?? key
}

/** SweepTable's value format, shared so the card and the table agree. */
function formatFigureValue(figure: AnswerFigure): string {
  const unit = METRIC_DEFS_BY_KEY.get(figure.key)?.unit ?? 'number'
  return formatMetricNumber(figure.value, unit, { percentSuffix: false, sweepPrecision: true })
}

/** SweepTable's margin format: rounded, unit-free, set beside the figure. */
function formatFigureMargin(moe: number): string {
  return formatMetricNumber(Math.round(moe), 'number', { sweepPrecision: true })
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text
}

/**
 * One quiet line for the criteria the screening surface cannot
 * express, worded from the dropped bounds themselves: a 'gt' filter
 * is a lower bound, an 'lt'/'eq_range' filter an upper bound. The
 * screen did not apply them, and the card says so rather than letting
 * the answer read as if it had.
 */
export function droppedCriteriaLine(answer: ComposedAnswer): string | null {
  if (answer.droppedCriteria.length === 0) return null
  const parts = answer.droppedCriteria.map((d) => {
    const label = lowerFirst(figureLabel(d.metricKey))
    return d.intentOp === 'gt' ? `a lower bound on ${label}` : `an upper bound on ${label}`
  })
  if (parts.length === 1) {
    const part = parts[0]!
    return `${part.charAt(0).toUpperCase() + part.slice(1)} can't be applied yet, so it was not used.`
  }
  return `Not applied: ${parts.join('; ')} — those bounds can't be expressed by the screen yet, so they were not used.`
}

/**
 * One quiet line naming each geography that resolved to nothing —
 * by name, as unresolved. A comparison is never silently one-sided
 * (battery C4: the Denver County side of a county comparison was
 * dropped with no disclosure because the old flag fired only when
 * EVERY geography failed).
 */
export function unresolvedGeographiesLine(answer: ComposedAnswer): string | null {
  if (answer.unresolvedGeographies.length === 0) return null
  const list = answer.unresolvedGeographies.join(', ')
  return answer.unresolvedGeographies.length === 1
    ? `${list} could not be resolved, so it is named here as unresolved and the answer above does not cover it.`
    : `${list} could not be resolved, so they are named here as unresolved and the answer above does not cover them.`
}

/**
 * The geography readings the resolution layer made, disclosed
 * verbatim: a region read as the Census region of that name, a
 * region not served at region level. These strings come from the
 * same resolution result the card was composed from, so the card
 * cannot describe a geography differently from how it was resolved.
 */
export function geographyDisclosureLines(answer: ComposedAnswer): string[] {
  return [...(answer.geographyDisclosures ?? [])]
}

/** The state rule, stated on the card whenever a state-average place was composed. */
export function stateMethodLine(answer: ComposedAnswer): string | null {
  return answer.stateMethod ?? null
}

/** One quiet line recording claims compose dropped for lacking a citation. */
export function droppedClaimsLine(answer: ComposedAnswer): string | null {
  if (answer.droppedClaims.length === 0) return null
  return answer.droppedClaims.length === 1
    ? 'One researched claim was dropped because it carried no source.'
    : `${count.format(answer.droppedClaims.length)} researched claims were dropped because they carried no source.`
}

/**
 * One quiet line when the candidate cap bound a research pass: the
 * cap is a named constant in the pipeline, and when it binds the
 * answer says so rather than letting the researched subset read as
 * the whole screened set.
 */
export function candidateCapLine(answer: ComposedAnswer): string | null {
  // A breadth answer's cap accounting is its own line
  // (breadthCountsLine): every display place was rostered for
  // assessment, so this line's "further places were not
  // researched" would be false on the card it sits on.
  if (answer.breadth) return null
  if (!answer.candidateCapApplied) return null
  return `Research covered the first ${count.format(answer.candidateCap)} candidate places; any further places were not researched.`
}

/**
 * The breadth counts line (breadth mode): the assessed count over
 * the display total, in the geography's own name, with the
 * unassessed remainder stated plainly — the same assessed/display
 * accounting the terminal map and the COMPLETE strip carry, from
 * the answer's own breadth record, so the three surfaces can
 * never disagree about the run's coverage.
 */
export function breadthCountsLine(answer: ComposedAnswer): string | null {
  if (!answer.breadth) return null
  const { assessedCount, displayTotal, geographyLabel } = answer.breadth
  const head = `${count.format(assessedCount)} of ${count.format(displayTotal)} areas in ${geographyLabel} were assessed from cited sources.`
  const rest = displayTotal - assessedCount
  if (rest <= 0) return head
  return rest === 1
    ? `${head} The other 1 area is shown on the map as not assessed — no cited source characterized it.`
    : `${head} The other ${count.format(rest)} are shown on the map as not assessed — no cited source characterized them.`
}

/**
 * One quiet line when a top-N question grounded fewer places than
 * it asked for. Both numbers render from the answer's structured
 * fields (the asked count the pipeline parsed from the reader's
 * words, and the places that actually composed), so the line is
 * arithmetic on data, not prose a model wrote. A top-N answer that
 * silently lists two places for "top five" would read as if two
 * were the answer; the shortfall is stated instead.
 */
export function requestedCountLine(answer: ComposedAnswer): string | null {
  if (answer.requestedCount === null || answer.requestedCount === undefined) return null
  if (answer.status !== 'verified' && answer.status !== 'empty') return null
  if (answer.places.length >= answer.requestedCount) return null
  return `You asked for ${count.format(answer.requestedCount)} places; the cited research named ${count.format(answer.places.length)} that could be matched to Census data.`
}

/**
 * One quiet line for research-first candidates that resolved to
 * no ZCTA. The recorded names print — they are place-shaped
 * mentions the research made and the data could not match. The
 * fragment tokens the extraction gate counted (Lane A10 FM-14)
 * do NOT print (Lane A10 FM-17): sheet A printed harvested
 * sentence fragments as if they were named places ("Initial,
 * Described, January-April..."). They are accounted by count in
 * a second sentence, in the same plain wording, so the record
 * stays complete without dressing fragments as names.
 */
export function unresolvedCandidatesLine(answer: ComposedAnswer): string | null {
  // A flexible completion DID use the named places — as
  // research-labelled content, not Census matches — so this line's
  // "was not used" wording would contradict the card it sits on.
  if (answer.status === 'flexible') return null
  const fragments = answer.unmatchedFragmentCount ?? 0
  if (answer.unresolvedCandidates.length === 0 && fragments === 0) return null
  const parts: string[] = []
  if (answer.unresolvedCandidates.length > 0) {
    const list = answer.unresolvedCandidates.join(', ')
    parts.push(
      answer.unresolvedCandidates.length === 1
        ? `Research named ${list}, which could not be matched to Census data, so it was not used.`
        : `Research named ${list}, which could not be matched to Census data, so they were not used.`,
    )
    if (fragments > 0) {
      parts.push(
        `${count.format(fragments)} further ${fragments === 1 ? 'name' : 'names'} in the findings could not be matched to Census data either.`,
      )
    }
  } else {
    parts.push(
      fragments === 1
        ? '1 name in the findings could not be matched to Census data, so it was not used.'
        : `${count.format(fragments)} names in the findings could not be matched to Census data, so they were not used.`,
    )
  }
  return parts.join(' ')
}

/**
 * One quiet line naming research-first candidates the cited
 * research itself describes as not meeting the stated criteria
 * (Lane A9 FM-4): they were considered — named, resolved, figured —
 * and are not ranked, with the reason stated, rather than either
 * ranked as if they met the criteria or dropped without a trace.
 */
export function consideredNotMeetingLine(answer: ComposedAnswer): string | null {
  const names = answer.consideredNotMeeting ?? []
  if (names.length === 0) return null
  const list = names.join(', ')
  return names.length === 1
    ? `${list} was named in the research but is not ranked here, because the cited sources describe it as not meeting the stated criteria.`
    : `${list} were named in the research but are not ranked here, because the cited sources describe them as not meeting the stated criteria.`
}

/**
 * One quiet line for research-first candidates that resolved to
 * real Census places outside the geography the question asks
 * about (Lane A10 FM-15): they were named, they exist, and they
 * are not answers to this question — the line says so plainly
 * rather than letting the binding's refusal read as if the
 * research never named them. Distinct from the unmatched line
 * above: these names DID match Census data, in the wrong place.
 */
export function outOfBoundCandidatesLine(answer: ComposedAnswer): string | null {
  const names = answer.outOfBoundCandidates ?? []
  if (names.length === 0) return null
  const list = names.join(', ')
  return names.length === 1
    ? `${list} was named in the research but is outside the area this question asks about, so it was not used.`
    : `${list} were named in the research but are outside the area this question asks about, so they were not used.`
}

/**
 * Names that matched no Census data and state a state outside the
 * asked geography in their own suffix (Lane completion K3): the
 * line says the stated state is the disqualifier, so the name does
 * not read as an in-bound candidate that merely failed to match.
 * Distinct from the unmatched line (no state contradiction) and
 * from the out-of-bound line above (those names DID match Census
 * data, in the wrong place).
 */
export function outOfStateCandidatesLine(answer: ComposedAnswer): string | null {
  const names = answer.outOfStateCandidates ?? []
  if (names.length === 0) return null
  const list = names.join(', ')
  return names.length === 1
    ? `${list} was named in the research with a state outside the area this question asks about, so it was not used.`
    : `${list} were named in the research with a state outside the area this question asks about, so they were not used.`
}

/** One quiet line for a requested geography level the shipped data cannot serve. */
export function unsupportedGeographyLine(answer: ComposedAnswer): string | null {
  if (!answer.unsupportedGeography) return null
  return 'County-level figures are not available from the shipped data, so the places shown are at place and ZIP level.'
}

/**
 * The county rule, stated on the card whenever a county answer was
 * composed: the assignment and aggregation rule is part of the
 * answer, not fine print elsewhere (the same statement stands in
 * the answer's criterion evidence and on the Methodology page).
 */
export function countyMethodLine(answer: ComposedAnswer): string | null {
  return answer.countyMethod ?? null
}

/** One quiet line naming counties dropped because their deciding figure was not measurable. */
export function notMeasurableCountiesLine(answer: ComposedAnswer): string | null {
  const dropped = answer.notMeasurableCounties ?? []
  if (dropped.length === 0) return null
  const list = dropped.join(', ')
  return dropped.length === 1
    ? `${list} is not shown because its figures could not be aggregated to county level from the available ZIP-area figures.`
    : `${list} are not shown because their figures could not be aggregated to county level from the available ZIP-area figures.`
}

const EVIDENCE_STATUS_LABELS: Readonly<Record<string, string>> = {
  met: 'measured',
  partially_measured: 'partially measured',
  not_measurable: 'not measurable from available sources',
  // Phase 5 preliminary staging: the criterion's research has not
  // landed yet. The label says exactly that — pending is shown as
  // pending, never dressed as a measurement.
  pending: 'research pending',
}

/** The per-criterion evidence list: each stated criterion with its status beside it. */
function CriterionEvidenceList({ answer }: { answer: ComposedAnswer }) {
  if (answer.criterionEvidence.length === 0) return null
  return (
    <div className="mt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Criteria</h3>
      <ul className="mt-1 space-y-1">
        {answer.criterionEvidence.map((evidence, i) => (
          <li key={i} className="text-base text-slate-700">
            {/*
              The stored criterion for a Census entry is its metric
              key, kept as a key because spoken-answer.ts matches it
              against verified figure keys — so the plain label is
              mapped here, at render (defect F-B-ANSWER-CARD,
              2026-11-02: this list rendered "median_gross_rent"
              verbatim). measureLabel passes a value with no registry
              entry through unchanged, so researched criteria (the
              reader's own catalog labels) render as stored.
            */}
            <span className="font-medium text-slate-900">{measureLabel(evidence.criterion)}</span>
            {' — '}
            {EVIDENCE_STATUS_LABELS[evidence.status] ?? evidence.status}. {evidence.detail}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ClaimSources({
  claim,
  answer,
  visibleUrls,
}: {
  claim: ResearchedClaim
  answer: ComposedAnswer
  visibleUrls?: readonly string[]
}) {
  const links = claim.sourceUrls
    .filter((url) => visibleUrls === undefined || visibleUrls.includes(url))
    .map((url) => answer.sources.find((s) => s.url === url))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
  if (links.length === 0) return null
  return (
    <>
      {' '}
      {links.map((source, i) => (
        <span key={source.url}>
          {i > 0 ? ' ' : ''}
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="whitespace-nowrap text-sm text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
          >
            {source.title}
          </a>
        </span>
      ))}
    </>
  )
}

function ClaimText({
  claim,
  answer,
  visibleUrls,
}: {
  claim: ResearchedClaim
  answer: ComposedAnswer
  visibleUrls?: readonly string[]
}) {
  // A claim whose text is a source title renders nothing: titles
  // are confined to the source list (FM-7, isSourceTitleClaim).
  if (isSourceTitleClaim(claim, answer.sources)) return null
  return (
    <p className="mt-2 text-base leading-relaxed text-slate-700">
      {claim.text}
      <ClaimSources claim={claim} answer={answer} visibleUrls={visibleUrls} />
    </p>
  )
}

function PlaceBlock({
  place,
  answer,
  sourceVisibility,
}: {
  place: AnswerPlace
  answer: ComposedAnswer
  sourceVisibility?: Map<ResearchedClaim, string[]>
}) {
  return (
    <article
      id={answerPlaceAnchorId(place.zcta)}
      tabIndex={-1}
      className="mt-4 border-t border-slate-100 pt-4"
    >
      <h3 className="text-lg font-semibold leading-snug text-slate-900">
        {place.name}{' '}
        <span className="text-sm font-normal tabular-nums text-slate-500">
          {place.memberZctas
            ? `${count.format(place.memberZctas.length)} ZIP ${place.memberZctas.length === 1 ? 'area' : 'areas'}`
            : place.zcta}
        </span>
      </h3>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-3">
        {place.figures.map((figure) => (
          <div key={figure.key}>
            <dt className="figure-label">{figureLabel(figure.key)}</dt>
            <dd className="mt-0.5 text-lg font-medium tabular-nums text-slate-900">
              {formatFigureValue(figure)}
              {figure.marginOfError !== undefined && (
                <span
                  className="ml-1 text-xs font-normal tabular-nums text-slate-500"
                  title={
                    figure.marginApproximate
                      ? `Approximate margin of error plus or minus ${formatFigureMargin(figure.marginOfError)} (population-weighted approximation for a county aggregate, not an official Census county margin)`
                      : `Margin of error plus or minus ${formatFigureMargin(figure.marginOfError)}`
                  }
                >
                  ±{formatFigureMargin(figure.marginOfError)}
                  {figure.marginApproximate ? ' approx.' : ''}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {place.claims.map((claim, i) => (
        <ClaimText
          key={i}
          claim={claim}
          answer={answer}
          visibleUrls={sourceVisibility?.get(claim)}
        />
      ))}
    </article>
  )
}

/**
 * Citation render-once (owner live failure, 2026-11-03: the Texas
 * specimen repeated one research result's full source-title list
 * after EVERY claim — the same wall of titles eight times down the
 * card). The provider's citation gate is result-granularity, so
 * every claim legitimately carries the result's whole source list;
 * the repetition is a render artifact, and the cure is at render:
 * walking the claims in the card's own render order (the shown
 * places in display order, then the general claims), each source
 * URL is visible at the FIRST claim that cites it and at no later
 * one. A claim whose sources all rendered earlier shows its text
 * with no link list; the sources themselves stay on the answer.
 */
/** A source title normalized for comparison: case, punctuation,
 * and spacing are presentation, not identity. */
export function normalizeSourceTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Whether a claim's text IS one of the answer's source titles
 * (Lane A9 FM-7 — the live Texas specimen rendered source-title
 * strings as an entry's evidence lines: the title is the source's
 * name, not a finding, and it renders once, in the source list).
 * Compose drops prose segments CONTAINING a long title; a claim
 * that is nothing but the title (up to a short suffix — a site
 * name, a separator) can still arrive through channels that never
 * pass that filter, so the render seam refuses it here. The match
 * is equality-grade (the whole claim, normalized, is the title
 * plus at most a short tail), never a substring test — a finding
 * that merely mentions a titled work in prose is a finding.
 */
export function isSourceTitleClaim(
  claim: ResearchedClaim,
  sources: readonly AnswerSource[],
): boolean {
  const claimNorm = normalizeSourceTitle(claim.text)
  if (claimNorm.length === 0) return false
  return sources.some((source) => {
    const titleNorm = normalizeSourceTitle(source.title)
    if (titleNorm.length < 12) return false
    if (claimNorm === titleNorm) return true
    return claimNorm.startsWith(titleNorm) && claimNorm.length - titleNorm.length <= 12
  })
}

export function claimSourceVisibility(
  answer: ComposedAnswer,
): Map<ResearchedClaim, string[]> {
  const seen = new Set<string>()
  const seenTitles = new Set<string>()
  const titleByUrl = new Map<string, string>()
  for (const source of answer.sources) {
    titleByUrl.set(source.url, normalizeSourceTitle(source.title))
  }
  const visibility = new Map<ResearchedClaim, string[]>()
  const claimsInRenderOrder = [
    ...orderedPlaces(answer)
      .slice(0, ANSWER_CARD_PLACE_LIMIT)
      .flatMap((place) => place.claims),
    ...answer.generalClaims,
  ]
  for (const claim of claimsInRenderOrder) {
    // A title-shaped claim renders nothing (isSourceTitleClaim),
    // so it also consumes no citation visibility: the first REAL
    // claim citing a source keeps its chip.
    if (isSourceTitleClaim(claim, answer.sources)) continue
    // Render-once is per SOURCE, not per URL (FM-7): the same
    // article reachable at two URLs — a syndicated copy, a
    // tracking-parameter variant — is one source, and its title
    // renders once. The walk is sequential within the claim too:
    // a claim carrying both URLs of one source shows it once. A
    // URL hidden by its title still marks both seen, so no later
    // claim resurrects the duplicate.
    const visible: string[] = []
    for (const url of claim.sourceUrls) {
      const title = titleByUrl.get(url)
      const titleSeen = title !== undefined && seenTitles.has(title)
      if (!seen.has(url) && !titleSeen) visible.push(url)
      seen.add(url)
      if (title !== undefined) seenTitles.add(title)
    }
    visibility.set(claim, visible)
  }
  return visibility
}

/**
 * Display order: with criteria, by the first criterion's deciding
 * figure — ascending for a maximum, descending for a minimum — the
 * same order executeIntent's preset sort gives the screening table
 * below, so the card and the table never disagree about which place
 * leads. Without criteria (a lookup), the pipeline's order stands.
 */
function orderedPlaces(answer: ComposedAnswer): AnswerPlace[] {
  const criterion = answer.criteria[0]
  if (!criterion) return answer.places
  const direction = criterion.bound === 'atMost' ? 1 : -1
  return [...answer.places].sort((a, b) => {
    const av = a.figures.find((f) => f.key === criterion.metricKey)?.value
    const bv = b.figures.find((f) => f.key === criterion.metricKey)?.value
    if (av === undefined && bv === undefined) return 0
    if (av === undefined) return 1
    if (bv === undefined) return -1
    return (av - bv) * direction
  })
}

export function AnswerCard({ answer }: { answer: ComposedAnswer }) {
  const droppedLine = droppedCriteriaLine(answer)
  const unresolvedLine = unresolvedGeographiesLine(answer)
  const droppedClaims = droppedClaimsLine(answer)
  const capLine = candidateCapLine(answer)
  const breadthLine = breadthCountsLine(answer)
  const shortfallLine = requestedCountLine(answer)
  const unresolvedCandidates = unresolvedCandidatesLine(answer)
  const outOfBoundLine = outOfBoundCandidatesLine(answer)
  const outOfStateLine = outOfStateCandidatesLine(answer)
  const notMeetingLine = consideredNotMeetingLine(answer)
  const unsupportedLine = unsupportedGeographyLine(answer)
  const countyLine = countyMethodLine(answer)
  const notMeasurableLine = notMeasurableCountiesLine(answer)
  const disclosureLines = geographyDisclosureLines(answer)
  const stateLine = stateMethodLine(answer)
  const sourceVisibility = claimSourceVisibility(answer)

  return (
    <section
      aria-label="Answer"
      className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-[0_1px_6px_rgba(32,33,36,0.14)]"
    >
      <div className="flex items-center gap-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Answer</h2>
        <HelpTip label="How this answer is composed">
          Figures are screened from Census Bureau American Community Survey data against the
          criteria in the question. Claims from web research appear only with their sources, and
          every figure and claim on this card was checked against the screened data before it
          was shown.
        </HelpTip>
      </div>

      {answer.refinementNote && (
        <p role="note" className="mt-2 text-base text-slate-600">
          {answer.refinementNote}
        </p>
      )}
      {answer.runNote && (
        <p role="note" className="mt-2 text-base text-slate-600">
          {answer.runNote}
        </p>
      )}
      {answer.preliminary && (
        <p role="note" className="mt-2 text-base text-slate-600">
          Preliminary answer — the screened figures below are final; research is still running,
          and criteria marked research pending will be updated when it lands.
        </p>
      )}
      {answer.verification?.wonder === 'concerns' &&
        (answer.verification.wonderConcerns ?? []).map((concern) => (
          <p key={concern} role="note" className="mt-2 text-base text-slate-600">
            {concern}
          </p>
        ))}
      {answer.status === 'withheld' && (
        <p role="note" className="mt-2 text-base text-slate-600">
          A composed answer was withheld because it did not pass verification. The figures below
          come straight from the data.
        </p>
      )}
      {answer.status === 'blocked' && (
        <p role="note" className="mt-2 text-base text-slate-600">
          That question could not be screened as asked, so no answer was composed. The data views
          below still work.
        </p>
      )}
      {answer.status === 'empty' && (
        <>
          <p role="note" className="mt-2 text-base text-slate-600">
            {answer.summary}
          </p>
          {/*
            The note shell carries the per-criterion accounting too
            (Lane A9 FM-8 / finding F3): a note is where the
            accounting matters most — it is the reader's only record
            of which stated criteria were looked up, which returned,
            and which did not. The list renders nothing when the
            answer carries no evidence entries, so notes without
            criteria are unchanged.
          */}
          <CriterionEvidenceList answer={answer} />
        </>
      )}
      {answer.status === 'flexible' && answer.flexible && (
        <>
          {/*
            The flexible completion (2026-11-02): the deterministic
            framing line (the summary — it states the match outcome
            and the labelling rule), the per-criterion evidence, then
            the completion itself, whose every place and figure
            carries its evidence class in plain words.
          */}
          <p className="mt-2 text-base leading-relaxed text-slate-800">{answer.summary}</p>
          <CriterionEvidenceList answer={answer} />
          <FlexibleAnswer flexible={answer.flexible} sources={answer.sources} />
        </>
      )}

      {answer.status === 'verified' && (
        <>
          {/*
            The composed summary names the outcome when criteria were
            applied. With no criteria (a plain lookup) the place and
            its figure are the statement, so the sentence is skipped
            rather than claiming criteria that were never stated. A
            ranked conclusion renders on its own signal (cure round
            4): a state ranking's winner sentence claims no criteria —
            it IS the outcome — and the sort metric that produced it
            is a metric key, not a criterion, so the criteria gate
            hid it on exactly the answers that needed it.
          */}
          {(answer.criteria.length > 0 ||
            answer.researchCriteria.length > 0 ||
            answer.rankedConclusion) && (
            <p className="mt-2 text-base leading-relaxed text-slate-800">{answer.summary}</p>
          )}
          <CriterionEvidenceList answer={answer} />
          {orderedPlaces(answer)
            .slice(0, ANSWER_CARD_PLACE_LIMIT)
            .map((place) => (
              <PlaceBlock
                key={place.zcta}
                place={place}
                answer={answer}
                sourceVisibility={sourceVisibility}
              />
            ))}
          {answer.places.length > ANSWER_CARD_PLACE_LIMIT &&
            (answer.placesMeetingAllCriteria !== undefined &&
            answer.placesMeetingAllCriteria < answer.places.length ? (
              <p className="mt-3 text-base text-slate-600">
                {count.format(answer.placesMeetingAllCriteria)} of the{' '}
                {count.format(answer.places.length)} places in the screening table meet all of
                the stated criteria; the rest are shown with the measures and findings assessed
                for each of them.
              </p>
            ) : (
              <p className="mt-3 text-base text-slate-600">
                {count.format(answer.places.length - ANSWER_CARD_PLACE_LIMIT)} more places meet
                the stated criteria — all of them are in the screening table below.
              </p>
            ))}
          {answer.generalClaims.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-2">
              {answer.generalClaims.map((claim, i) => (
                <ClaimText
                  key={i}
                  claim={claim}
                  answer={answer}
                  visibleUrls={sourceVisibility.get(claim)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {capLine && (
        <p role="note" className="mt-3 text-sm text-slate-500">
          {capLine}
        </p>
      )}
      {breadthLine && (
        <p role="note" className="mt-3 text-sm text-slate-500">
          {breadthLine}
        </p>
      )}
      {shortfallLine && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {shortfallLine}
        </p>
      )}
      {unresolvedCandidates && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {unresolvedCandidates}
        </p>
      )}
      {outOfBoundLine && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {outOfBoundLine}
        </p>
      )}
      {outOfStateLine && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {outOfStateLine}
        </p>
      )}
      {notMeetingLine && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {notMeetingLine}
        </p>
      )}
      {unsupportedLine && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {unsupportedLine}
        </p>
      )}
      {countyLine && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {countyLine}
        </p>
      )}
      {stateLine && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {stateLine}
        </p>
      )}
      {disclosureLines.map((line) => (
        <p key={line} role="note" className="mt-1 text-sm text-slate-500">
          {line}
        </p>
      ))}
      {notMeasurableLine && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {notMeasurableLine}
        </p>
      )}
      {droppedLine && (
        <p role="note" className="mt-3 text-sm text-slate-500">
          {droppedLine}
        </p>
      )}
      {unresolvedLine && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {unresolvedLine}
        </p>
      )}
      {answer.status === 'verified' && droppedClaims && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {droppedClaims}
        </p>
      )}
      {/*
        P6 RESULT MAP MOUNT SEAM (drive item 13): the result map for a
        verified answer, rendered under the card's places inside this
        same section. ResultMap owns its loading, geometry, legend
        and failure line, and renders nothing for a non-verified or
        placeless answer. No onSelect is passed: the Ask surface's
        comparison selection is App-owned and AnswerCard has no seam
        for it today, so a tap on the map shows that place's card
        figures in the map's own panel (the P6 requirement) rather
        than selecting for comparison.
        CHART RELEVANCE (owner standing rules, 2026-11-03): the
        choropleth mount is gated by resultMapRelevant — it renders
        only when the answer's geography is itself the information
        (a screen over an area) and a metric drives its colors.
        QUALIFYING-PLACES MAP (Lane completion K7, owner directive
        2026-11-03 02:46 HST): a research-first candidate answer is
        excluded from that choropleth (no screened set, no metric),
        and instead mounts the points map of its own named places
        under qualifyingPlacesMapRelevant — the two predicates are
        mutually exclusive, so a card mounts at most one map. The
        points map receives the card's shown places in card order;
        its marks jump to the PlaceBlock anchors above.
      */}
      {/*
        BREADTH MAP (owner directive 2026-11-03 12:44 HST): a
        breadth terminal mounts the breadth surface — the whole
        display set by standing — in place of both maps below: its
        geography IS the answer in a stronger form than the
        qualifying points (which would plot only the card's ten),
        and the three predicates stay mutually exclusive, so a
        card still mounts at most one map. The surface is the
        progressive map component in its terminal mode: the same
        surface the run filled, settled.
      */}
      {/*
        GATE MAP (drug-law specimen cure, 2026-11-04): a
        geography-gated answer mounts the qualifying-states map —
        the frame the question asks for (states shaded by their
        cheapest screened figure, winner identifiable) — in place
        of the result choropleth, which resultMapRelevant excludes
        for gate answers. Mutually exclusive with both maps below
        by the same construction as the breadth mount.
      */}
      {answer.status === 'verified' && answer.geographyGate && (
        <GateStatesMap answer={answer} />
      )}
      {answer.status === 'verified' && answer.breadth && (
        <ProgressivePlacesMap
          places={[]}
          breadth={{
            places: answer.breadth.standings,
            labels: answer.breadth.labels,
            criterionLabel: answer.breadth.criterionLabel,
            geographyLabel: answer.breadth.geographyLabel,
            assessedCount: answer.breadth.assessedCount,
            displayTotal: answer.breadth.displayTotal,
            terminal: true,
            sources: answer.sources,
          }}
        />
      )}
      {answer.status === 'verified' && resultMapRelevant(answer) && <ResultMap answer={answer} />}
      {answer.status === 'verified' && !answer.breadth && !answer.geographyGate && qualifyingPlacesMapRelevant(answer) && (
        <QualifyingPlacesMap
          places={orderedPlaces(answer).slice(0, ANSWER_CARD_PLACE_LIMIT)}
        />
      )}
    </section>
  )
}
