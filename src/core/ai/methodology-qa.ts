/**
 * F6 methodology Q&A (plan sections L1.3, 6.2.7, 6.5.6).
 *
 * Answers questions ABOUT the data — where a figure comes from, how
 * current it is, why it is missing, what is covered — and nothing else.
 * Grounding sources, in the plan's priority order: registry metadata
 * (src/core/civicscope-registry.ts), coverage records (what the build
 * carries and what it does not), and docs/data-sources-research.md
 * section 1 ("Data already in the build"). The corpus below is built
 * from those three and only those three; an answer is assembled from
 * corpus text, never generated freely, so an answer cannot state a
 * fact the corpus does not hold.
 *
 * Every composed answer is run through the same F4 validator as every
 * other surface before it is returned, against the figures the corpus
 * entry declares it may state. If validation ever failed, the module
 * fails closed and refuses rather than showing unvalidated prose.
 * A question the corpus cannot answer is refused with the boundary
 * stated — including data questions, which belong to search, where
 * figures are retrieved and shown with their sources, never recalled.
 */
import { METRIC_DEFS, METRIC_DEFS_BY_KEY, type MetricDef } from '../civicscope-registry'
import {
  createValidator,
  type FigureForValidation,
  type Validator,
} from './validator'

export type CorpusSource = 'registry' | 'coverage' | 'docs'

export interface CorpusEntry {
  id: string
  source: CorpusSource
  /** Topic phrases (normalized words) that mark this entry as relevant. */
  topics: string[]
  /** Registry metrics this entry is about, when it is about one. */
  metricKeys?: string[]
  /** The grounded answer text. Corpus text only; see the header. */
  answer: string
  /** Numerals the answer is allowed to state, as validator figures. */
  figures: FigureForValidation[]
  /** Refusal entries answer a recognisable out-of-corpus class by refusing. */
  refusal?: 'not_covered'
}

/**
 * The ACS pooling window, stated by the currency and source answers.
 * Declared as an average (years per release) rather than a count key:
 * the validator's small-count suppression exists for counts of people
 * and households, and a survey window is neither — the same distinction
 * src/core/types.ts draws for the 'institutions' unit.
 */
const ACS_WINDOW_FIGURE: FigureForValidation = {
  key: 'average_years_per_release',
  value: 5,
}

/** The confidence level of the published margins of error. */
const MOE_CONFIDENCE_FIGURE: FigureForValidation = {
  key: 'moe_confidence_pct',
  value: 90,
}

const ACS_SOURCE =
  'the U.S. Census Bureau, in the American Community Survey (ACS) 5-year estimates'

/**
 * A registry note joins a generated answer only when it carries no
 * digit: several notes record dated, place-specific corrections (the
 * households note names a ZIP and its old count), and quoting those
 * numerals out of context would state figures this answer was not
 * given. The answer stays complete without the note; the note itself
 * is shown with the figure in the app.
 */
function numeralFree(note: string): boolean {
  return !/\d/.test(note)
}

function metricSourceEntry(def: MetricDef): CorpusEntry {
  const note = numeralFree(def.note) ? ` ${def.note}` : ''
  return {
    id: `source-${def.key}`,
    source: 'registry',
    metricKeys: [def.key],
    topics: ['where does', 'come from', 'source', 'published by', 'who publishes', 'data for'],
    answer:
      `${def.label} comes from ${ACS_SOURCE}. ` +
      'The exact table and vintage are printed with the figure wherever it appears.' +
      note,
    figures: [ACS_WINDOW_FIGURE],
  }
}

export const METHODOLOGY_CORPUS: CorpusEntry[] = [
  {
    id: 'acs-currency',
    source: 'docs',
    topics: ['how current', 'how old', 'how recent', 'up to date', 'when was', 'vintage'],
    answer:
      'Most CivicScope figures come from the American Community Survey (ACS) 5-year estimates. ' +
      'Each release pools five years of survey responses, so a figure describes the whole ' +
      'period rather than a single year. The release year — the vintage — is printed with ' +
      'every figure, and the survey is updated annually: the newest release supersedes ' +
      'the last, and earlier figures remain citable under their own vintage.',
    figures: [ACS_WINDOW_FIGURE],
  },
  {
    id: 'moe-meaning',
    source: 'registry',
    topics: ['margin of error', 'moe', 'how accurate', 'confidence', 'plus or minus', 'uncertain'],
    answer:
      'Every survey figure here is an estimate, and the margin of error printed beside it ' +
      'is the range around that estimate at the 90 percent confidence level. A wide margin ' +
      'means the true figure could sit well above or below the printed figure. When margins ' +
      'of error overlap between places, the difference between them may not be real, and ' +
      'CivicScope wording says so instead of treating the printed order as exact.',
    figures: [MOE_CONFIDENCE_FIGURE],
  },
  {
    id: 'missing-figure',
    source: 'coverage',
    topics: ['why is there no', 'why is', 'missing', 'no figure', 'not published', 'no data', 'absent'],
    answer:
      'A figure can be absent for distinct reasons, and the app labels which applies: ' +
      'the publisher marks it not applicable for that place, the value was suppressed under ' +
      'a small-count rule, or CivicScope has not loaded it. A missing figure is shown as a ' +
      'labelled absence, never filled in with an invented value, because the reason for the ' +
      'absence is itself information a reader can act on.',
    figures: [],
  },
  {
    id: 'suppression',
    source: 'registry',
    topics: ['suppress', 'suppressed', 'small count', 'withheld', 'too few'],
    answer:
      'Small counts are suppressed so a reader cannot over-read a figure about a handful ' +
      'of households. A count under 20 is treated as not published: it is excluded from ' +
      'explanations and packs, and the view shows the absence rather than the number. ' +
      'The rule is applied centrally by the engine, so no individual source can forget it.',
    figures: [{ key: 'households', value: 20 }],
  },
  {
    id: 'graduation-coverage',
    source: 'coverage',
    topics: ['graduation', 'graduation rate', 'no graduation rate', 'grad rate', 'school outcomes', 'test scores', 'school quality'],
    answer:
      'There is no nationwide graduation rate per ZIP code in CivicScope. School data here ' +
      'comes from NCES EDGE district staffing and enrollment and from named-school detail ' +
      'for New York City, at district level rather than ZIP level, and published graduation ' +
      'figures are ranges rather than exact rates. A place with no district figure shows a ' +
      'labelled absence instead of an estimate, and staffing counts are not a quality rating.',
    figures: [],
  },
  {
    id: 'sources-overview',
    source: 'docs',
    topics: ['where does the data come from', 'data sources', 'what sources', 'sources do you use', 'which sources'],
    answer:
      'The build\u2019s data is the ACS 5-year base through the Census plugin, a geography ' +
      'plugin for place resolution, NCES EDGE district staffing and enrollment, NYC DOE ' +
      'named-school detail, and CDC PLACES health measures referenced in attribution. ' +
      'Every figure carries its publisher, dataset, table, and vintage, and the ' +
      'methodology page is generated from the same registry the data layer uses, so it ' +
      'cannot drift from what is actually loaded.',
    figures: [ACS_WINDOW_FIGURE],
  },
  {
    id: 'geography-coverage',
    source: 'coverage',
    topics: ['zip code', 'zcta', 'geography', 'what areas', 'which places', 'tract'],
    answer:
      'CivicScope resolves places to Census ZIP Code Tabulation Areas (ZCTAs) and can ' +
      'contextualise them with county, tract, and school-district geography. Figures are ' +
      'published for the geography they describe: a block-group or district measure is ' +
      'labelled as such and is never presented as a ZIP-wide average.',
    figures: [],
  },
  {
    id: 'composite-method',
    source: 'registry',
    topics: ['affordability', 'composite', 'score', 'scoring', 'weights', 'similarity'],
    answer:
      'The affordability composite and the similarity results are computed in code from ' +
      'the figures on screen, never by the model. Their components and weights are ' +
      'disclosed with the result, and measures that proxy a protected characteristic are ' +
      'never folded into a composite or offered as a sort or filter control.',
    figures: [],
  },
  {
    id: 'privacy-method',
    source: 'docs',
    topics: ['privacy', 'personal data', 'track', 'store my', 'my key', 'localstorage'],
    answer:
      'CivicScope has no account system and no server side for user keys. Searches and ' +
      'keys stay in your own browser\u2019s local storage; a key you supply is sent only ' +
      'to its own provider as an authorization header. What the operator can see is ' +
      'aggregate counters only — requests, tokens, budget consumed, error classes — ' +
      'never a search, a figure set, or a key.',
    figures: [],
  },
  {
    id: 'not-covered',
    source: 'coverage',
    topics: ['crime', 'crime data', 'crime statistics', 'weather', 'the weather', 'forecast', 'predict', 'future rent', 'listings', 'asking rent', 'for sale', 'stock', 'traffic'],
    answer:
      'CivicScope does not carry that. Its data is published survey and administrative ' +
      'data about places — housing costs, households, schools, health and environment ' +
      'measures from the registered sources. It holds no listings or asking rents, no ' +
      'crime statistics, no forecasts, and nothing about individuals.',
    figures: [],
    refusal: 'not_covered',
  },
  ...METRIC_DEFS.map(metricSourceEntry),
]

export const QA_BOUNDARY =
  'Methodology Q&A answers only questions about how CivicScope\u2019s data is sourced, ' +
  'covered, and limited — drawn from the metric registry, the coverage records, and ' +
  'the data-sources research notes. It does not answer questions about the figures ' +
  'themselves, or anything outside that corpus.'

export type QaResult =
  | { answered: true; entryId: string; text: string; source: CorpusSource }
  | {
      answered: false
      reason: 'out_of_corpus' | 'not_covered' | 'data_question'
      text: string
    }

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const DATA_QUESTION_RE =
  /^(what is|whats|what are|how many|how much|give me|show me|tell me) /
const METHODOLOGY_MARKERS = [
  'source', 'current', 'vintage', 'cover', 'why', 'margin', 'suppress',
  'method', 'missing', 'absent', 'come from', 'published',
]

function isDataQuestion(normalized: string): boolean {
  if (!DATA_QUESTION_RE.test(normalized)) return false
  return !METHODOLOGY_MARKERS.some((m) => normalized.includes(m))
}

/**
 * Registry metrics a question names, by key or by full label. When
 * labels nest ("Households" inside "Households with no internet
 * access"), only the longest match counts: the specific metric is the
 * one the question is about.
 */
function mentionedMetrics(normalized: string): MetricDef[] {
  const matches = METRIC_DEFS.filter(
    (def) =>
      normalized.includes(def.key.replace(/_/g, ' ')) ||
      normalized.includes(normalize(def.label)),
  )
  if (matches.length <= 1) return matches
  const longest = Math.max(...matches.map((m) => normalize(m.label).length))
  return matches.filter((m) => normalize(m.label).length === longest)
}

interface EntryScore {
  score: number
  /** Distinct topic phrases matched — the specificity tie-break. */
  phrases: number
}

function scoreEntry(entry: CorpusEntry, normalized: string, mentioned: MetricDef[]): EntryScore {
  let score = 0
  let phrases = 0
  for (const topic of entry.topics) {
    const phrase = normalize(topic)
    if (phrase && normalized.includes(phrase)) {
      score += phrase.split(' ').length
      phrases += 1
    }
  }
  if (entry.metricKeys && mentioned.some((m) => entry.metricKeys?.includes(m.key))) {
    score += 3
  }
  return { score, phrases }
}

/**
 * Answer a methodology question from the corpus, or refuse with the
 * boundary stated. Deterministic: retrieval and composition only, no
 * free generation, and the composed answer must pass the F4 validator
 * against the entry's declared figures before it is returned.
 */
export function answerMethodologyQuestion(
  question: string,
  corpus: readonly CorpusEntry[] = METHODOLOGY_CORPUS,
  validator: Validator = createValidator(),
): QaResult {
  const normalized = normalize(question ?? '')
  if (!normalized) {
    return { answered: false, reason: 'out_of_corpus', text: QA_BOUNDARY }
  }

  const mentioned = mentionedMetrics(normalized)
  let best: CorpusEntry | undefined
  let bestScore = 0
  let bestPhrases = 0
  for (const entry of corpus) {
    // Score first; on a tie, the entry matching more distinct topic
    // phrases is the more specific one ("no graduation rate" beats the
    // generic missing-figure entry for a graduation question).
    const { score, phrases } = scoreEntry(entry, normalized, mentioned)
    if (score > bestScore || (score === bestScore && phrases > bestPhrases)) {
      best = entry
      bestScore = score
      bestPhrases = phrases
    }
  }

  // A recognisable not-covered class refuses as itself, even when the
  // question is phrased like a data question ("show me crime data").
  if (best?.refusal && bestScore >= 2) {
    const text = `${best.answer} ${QA_BOUNDARY}`
    if (!validator.validate(text, best.figures).pass) {
      return { answered: false, reason: 'out_of_corpus', text: QA_BOUNDARY }
    }
    return { answered: false, reason: best.refusal, text }
  }

  if (isDataQuestion(normalized)) {
    return {
      answered: false,
      reason: 'data_question',
      text:
        `${QA_BOUNDARY} For a figure itself, use search: figures are retrieved and ` +
        'shown with their sources there, never recalled here.',
    }
  }

  if (!best || bestScore < 2) {
    return { answered: false, reason: 'out_of_corpus', text: QA_BOUNDARY }
  }

  const verdict = validator.validate(best.answer, best.figures)
  if (!verdict.pass) {
    // Fail closed: a corpus answer that cannot pass the one validator
    // is a corpus bug, and the honest surface for it is the boundary,
    // never the unvalidated prose.
    return { answered: false, reason: 'out_of_corpus', text: QA_BOUNDARY }
  }
  return { answered: true, entryId: best.id, text: best.answer, source: best.source }
}

/** Every corpus entry's answer, validated — the corpus self-check. */
export function validateCorpus(
  corpus: readonly CorpusEntry[] = METHODOLOGY_CORPUS,
  validator: Validator = createValidator(),
): { id: string; pass: boolean; detail?: string }[] {
  return corpus.map((entry) => {
    const verdict = validator.validate(entry.answer, entry.figures)
    return verdict.pass
      ? { id: entry.id, pass: true }
      : { id: entry.id, pass: false, detail: verdict.detail }
  })
}

/** Per-metric Q&A coverage: every registered metric has a source entry. */
export function qaMetricCoverage(
  corpus: readonly CorpusEntry[] = METHODOLOGY_CORPUS,
): { covered: string[]; missing: string[] } {
  const covered = new Set(
    corpus.flatMap((entry) => entry.metricKeys ?? []),
  )
  const all = METRIC_DEFS.map((d) => d.key)
  return {
    covered: all.filter((k) => covered.has(k)),
    missing: all.filter((k) => !covered.has(k)),
  }
}

export function metricDefFor(key: string): MetricDef | undefined {
  return METRIC_DEFS_BY_KEY.get(key)
}
