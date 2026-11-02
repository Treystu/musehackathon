import type {
  AnswerFigure,
  AnswerPlace,
  ComposedAnswer,
  ResearchedClaim,
} from '../../core/ai/answer'
import { METRIC_DEFS_BY_KEY } from '../../core/civicscope-registry'
import { formatMetricNumber } from '../metric-format'
import { HelpTip } from './HelpTip'

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

/** One quiet line for geographies the screen could not pin down. */
export function unresolvedGeographiesLine(answer: ComposedAnswer): string | null {
  if (answer.unresolvedGeographies.length === 0) return null
  const list = answer.unresolvedGeographies.join(', ')
  return answer.unresolvedGeographies.length === 1
    ? `The screen could not pin down ${list}, so it was not narrowed to it.`
    : `The screen could not pin down ${list}, so it was not narrowed to them.`
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
  if (!answer.candidateCapApplied) return null
  return `Research covered the first ${count.format(answer.candidateCap)} candidate places; any further places were not researched.`
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

/** One quiet line for research-first candidates that resolved to no ZCTA. */
export function unresolvedCandidatesLine(answer: ComposedAnswer): string | null {
  if (answer.unresolvedCandidates.length === 0) return null
  const list = answer.unresolvedCandidates.join(', ')
  return answer.unresolvedCandidates.length === 1
    ? `Research named ${list}, which could not be matched to Census data, so it was not used.`
    : `Research named ${list}, which could not be matched to Census data, so they were not used.`
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
}

/** The per-criterion evidence list: each stated criterion with its status beside it. */
function CriterionEvidenceList({ answer }: { answer: ComposedAnswer }) {
  if (answer.criterionEvidence.length === 0) return null
  return (
    <div className="mt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Criteria</h3>
      <ul className="mt-1 space-y-1">
        {answer.criterionEvidence.map((evidence, i) => (
          <li key={i} className="text-sm text-slate-700">
            <span className="font-medium text-slate-900">{evidence.criterion}</span>
            {' — '}
            {EVIDENCE_STATUS_LABELS[evidence.status] ?? evidence.status}. {evidence.detail}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ClaimSources({ claim, answer }: { claim: ResearchedClaim; answer: ComposedAnswer }) {
  const links = claim.sourceUrls
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
            className="whitespace-nowrap text-xs text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
          >
            {source.title}
          </a>
        </span>
      ))}
    </>
  )
}

function ClaimText({ claim, answer }: { claim: ResearchedClaim; answer: ComposedAnswer }) {
  return (
    <p className="mt-2 text-sm leading-relaxed text-slate-700">
      {claim.text}
      <ClaimSources claim={claim} answer={answer} />
    </p>
  )
}

function PlaceBlock({ place, answer }: { place: AnswerPlace; answer: ComposedAnswer }) {
  return (
    <article className="mt-4 border-t border-slate-100 pt-4">
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
        <ClaimText key={i} claim={claim} answer={answer} />
      ))}
    </article>
  )
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
  const shortfallLine = requestedCountLine(answer)
  const unresolvedCandidates = unresolvedCandidatesLine(answer)
  const unsupportedLine = unsupportedGeographyLine(answer)
  const countyLine = countyMethodLine(answer)
  const notMeasurableLine = notMeasurableCountiesLine(answer)

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
        <p role="note" className="mt-2 text-sm text-slate-600">
          {answer.refinementNote}
        </p>
      )}
      {answer.verification?.wonder === 'concerns' &&
        (answer.verification.wonderConcerns ?? []).map((concern) => (
          <p key={concern} role="note" className="mt-2 text-sm text-slate-600">
            {concern}
          </p>
        ))}
      {answer.status === 'withheld' && (
        <p role="note" className="mt-2 text-sm text-slate-600">
          A composed answer was withheld because it did not pass verification. The figures below
          come straight from the data.
        </p>
      )}
      {answer.status === 'blocked' && (
        <p role="note" className="mt-2 text-sm text-slate-600">
          That question could not be screened as asked, so no answer was composed. The data views
          below still work.
        </p>
      )}
      {answer.status === 'empty' && (
        <p role="note" className="mt-2 text-sm text-slate-600">
          {answer.summary}
        </p>
      )}

      {answer.status === 'verified' && (
        <>
          {/*
            The composed summary names the outcome when criteria were
            applied. With no criteria (a plain lookup) the place and
            its figure are the statement, so the sentence is skipped
            rather than claiming criteria that were never stated.
          */}
          {(answer.criteria.length > 0 || answer.researchCriteria.length > 0) && (
            <p className="mt-2 text-base leading-relaxed text-slate-800">{answer.summary}</p>
          )}
          <CriterionEvidenceList answer={answer} />
          {orderedPlaces(answer)
            .slice(0, ANSWER_CARD_PLACE_LIMIT)
            .map((place) => (
              <PlaceBlock key={place.zcta} place={place} answer={answer} />
            ))}
          {answer.places.length > ANSWER_CARD_PLACE_LIMIT && (
            <p className="mt-3 text-sm text-slate-600">
              {count.format(answer.places.length - ANSWER_CARD_PLACE_LIMIT)} more places meet
              the stated criteria — all of them are in the screening table below.
            </p>
          )}
          {answer.generalClaims.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-2">
              {answer.generalClaims.map((claim, i) => (
                <ClaimText key={i} claim={claim} answer={answer} />
              ))}
            </div>
          )}
        </>
      )}

      {capLine && (
        <p role="note" className="mt-3 text-xs text-slate-500">
          {capLine}
        </p>
      )}
      {shortfallLine && (
        <p role="note" className="mt-1 text-xs text-slate-500">
          {shortfallLine}
        </p>
      )}
      {unresolvedCandidates && (
        <p role="note" className="mt-1 text-xs text-slate-500">
          {unresolvedCandidates}
        </p>
      )}
      {unsupportedLine && (
        <p role="note" className="mt-1 text-xs text-slate-500">
          {unsupportedLine}
        </p>
      )}
      {countyLine && (
        <p role="note" className="mt-1 text-xs text-slate-500">
          {countyLine}
        </p>
      )}
      {notMeasurableLine && (
        <p role="note" className="mt-1 text-xs text-slate-500">
          {notMeasurableLine}
        </p>
      )}
      {droppedLine && (
        <p role="note" className="mt-3 text-xs text-slate-500">
          {droppedLine}
        </p>
      )}
      {unresolvedLine && (
        <p role="note" className="mt-1 text-xs text-slate-500">
          {unresolvedLine}
        </p>
      )}
      {answer.status === 'verified' && droppedClaims && (
        <p role="note" className="mt-1 text-xs text-slate-500">
          {droppedClaims}
        </p>
      )}
    </section>
  )
}
