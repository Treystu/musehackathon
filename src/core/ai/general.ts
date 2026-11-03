/**
 * The general lane's core contracts (plan C13 + the two-beat
 * refinement, owner design pass 2026-11-02 11:10 HST).
 *
 * THREE-WAY CLASSIFICATION at intent time. Every parsed intent
 * carries a `domain` field (provider.ts ValidatedIntent.domain):
 *   - 'data_with_gaps' — a question about US places, Census data, or
 *     the researched criteria around them. Gaps, if any, go to the
 *     conversational clarification/modal path; a fully servable
 *     question is this class with no gaps.
 *   - 'off_domain' — genuinely off-domain: no plausible reading as a
 *     data question. Beat 1 of the general lane answers it head-on
 *     from the model's own knowledge, labeled as such; beat 2 is the
 *     single inquiry turn.
 *   - 'safety' — a safety-tier ask. The existing refusal shape is
 *     unchanged; nothing in this module creates, widens, or narrows
 *     it, and no guard below ever overrides it.
 *
 * The classification is the intent model's judgment (the intent
 * prompt asks for it; the intent JSON schema carries it) PLUS the
 * deterministic guards in resolveDomainClassification — never a
 * second model call. Ambiguous cases prefer 'data_with_gaps', and a
 * question mentioning a real place never silently dumps into the
 * general lane: an off-domain question that still names a place is a
 * HYBRID — its estimate part is general-labeled and its place part
 * routes to the data path as a first-class intent.
 */
import type { DomainClassification, ValidatedIntent } from './provider'

/** The one quiet label line every general answer renders under. */
export const GENERAL_ANSWER_LABEL =
  "Not a Census-data question — this is the model's own answer, outside the Census data."

/**
 * The open inquiry (beat 2, below the bridge bar): the plan's shape,
 * verbatim in structure — one question, easily waved off, no
 * manufactured tie-in attached.
 */
export const OPEN_INQUIRY_TEXT =
  'That was a fun thought experiment — what brought you here today? ' +
  'Is there a place or a decision I can pull real figures for?'

/**
 * Current-events phrasing is research-servable in principle (the
 * research arm owns it; battery E4). A question carrying it is a data
 * question with a research gap, never an off-domain one — the
 * general lane must not swallow it, whatever the intent model said.
 */
const CURRENT_EVENTS_RE =
  /\b(news|headlines?|current events|this week|latest developments)\b/i

/** Estimate-shaped phrasing: the question asks for a model estimate, not a figure. */
const ESTIMATE_SHAPE_RE =
  /\b(how many|how much|how long would|what would happen)\b/i

export interface DomainResolution {
  domain: DomainClassification
  /**
   * True when the question is off-domain in shape but names a real
   * place: the estimate part is answered by the general lane and the
   * place part routes to the data path (battery E6). A hybrid is
   * never a silent dump into the general lane — both parts render,
   * each under its own label.
   */
  hybrid: boolean
}

/**
 * The deterministic guards over the model's domain classification.
 * Pure and synchronous; the intent route and the Ask surface apply
 * the same function to the same intent, so the classification the
 * reader's request carries is the one the server validated.
 */
export function resolveDomainClassification(
  intent: ValidatedIntent,
  queryText: string | undefined,
): DomainResolution {
  const domain: DomainClassification = intent.domain ?? 'data_with_gaps'
  // Safety is the model's tier and the guards never touch it: the
  // refusal shape is unchanged by this lane (plan C13, class (c)).
  if (domain === 'safety') return { domain, hybrid: false }
  const text = queryText ?? ''
  // E4 guard: current-events phrasing routes to the research arm
  // (data_with_gaps), never the general lane.
  if (CURRENT_EVENTS_RE.test(text)) return { domain: 'data_with_gaps', hybrid: false }
  if (domain === 'off_domain') {
    // A place-mentioning off-domain question is a hybrid when the
    // place is the SETTING of an estimate (E6) — the Census part
    // still routes. When the question carries a servable measure
    // and no estimate shape, the (a)-preference wins outright: it is
    // a data question the model misread, and the general lane stays
    // out of it.
    if (intent.geographies.length > 0) {
      if (intent.metricKeys.length > 0 && !ESTIMATE_SHAPE_RE.test(text)) {
        return { domain: 'data_with_gaps', hybrid: false }
      }
      return { domain: 'off_domain', hybrid: true }
    }
    return { domain: 'off_domain', hybrid: false }
  }
  // 'data_with_gaps' (and the no-field default) stay data: ambiguous
  // cases prefer the data path (plan C13, (a)-preference).
  return { domain: 'data_with_gaps', hybrid: false }
}

/** The intent the data path serves for a hybrid: the same parse, read as data. */
export function dataIntentForHybrid(intent: ValidatedIntent): ValidatedIntent {
  return { ...intent, domain: 'data_with_gaps' }
}

/* ------------------------------------------------------------------ */
/* Beat 2 — candidate bridges                                          */
/* ------------------------------------------------------------------ */

export interface BridgeCandidate {
  id: string
  /** The specific possibility offered when this bridge clears the bar. */
  offerText: string
}

/**
 * Candidate underlying-intent bridges for THIS question, built
 * deterministically from the question's own words. The catalog is
 * deliberately small — each candidate names a real CivicScope
 * capability (pulling figures for a place or a decision) — and the
 * J-INQUIRY gate, not this builder, decides whether any of them is
 * offered: below the bar the reader gets the open question only, so
 * a candidate existing here never forces a tie-in (battery E8).
 */
export function candidateBridgesFor(queryText: string): BridgeCandidate[] {
  const text = queryText.toLowerCase()
  const candidates: BridgeCandidate[] = []
  if (/\b(moving|move|relocat|house|home|apartment|rent)\b/.test(text)) {
    candidates.push({
      id: 'relocation',
      offerText:
        'If a move is ever part of the picture, I can pull real rent and home-value figures for places you name.',
    })
  }
  if (/\b(school|learn|study|student|class)\b/.test(text)) {
    candidates.push({
      id: 'schools',
      offerText:
        'If schools ever matter in a place decision, that is researchable — I can look into schools alongside the Census figures for a place.',
    })
  }
  if (/\b(fill|fit|volume|space|room|big|size)\b/.test(text)) {
    candidates.push({
      id: 'place-space',
      offerText:
        'If the space a place gives you ever matters, I can pull household-size and home figures for a real place to compare against.',
    })
  }
  if (/\b(cost|price|money|afford|budget|cheap|expensive)\b/.test(text)) {
    candidates.push({
      id: 'cost-of-place',
      offerText:
        'If cost is the thread, I can pull real rent, home-value, and income figures for places you name.',
    })
  }
  // The standing candidate: the open-ended place/decision pull the
  // open question itself names. It, too, must clear the bar to be
  // offered as a SPECIFIC bridge; otherwise the open question stands
  // alone.
  candidates.push({
    id: 'place-decision',
    offerText:
      'If there is a place or a decision behind the question, I can pull real figures for it.',
  })
  return candidates
}

/* ------------------------------------------------------------------ */
/* Beat 2 — session state (asked once, wave-off closes)                */
/* ------------------------------------------------------------------ */

export interface InquirySession {
  /** An inquiry has been shown in this session thread. */
  asked: boolean
  /** The reader waved it off; it never returns this session. */
  wavedOff: boolean
}

const INQUIRY_SESSION_KEY = 'civicscope.inquiry.v1'

export interface InquiryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Memory-only in production (refresh-starts-clean cure, 2026-11-02):
 * the inquiry flags are part of the ask session's conversation, so
 * they follow the session store's contract — they live for the
 * page life and a page load restarts them. An earlier build also
 * mirrored them to sessionStorage, which let a refresh resurrect
 * the conversation's state (the inquiry already spent, the
 * wave-off already given) into a session the reader experiences as
 * new. The storage parameter remains as an injection seam for
 * tests; production callers pass nothing and get memory.
 */
let memoryInquiry: InquirySession = { asked: false, wavedOff: false }

export function readInquirySession(
  storage: InquiryStorage | null = null,
): InquirySession {
  if (!storage) return { ...memoryInquiry }
  try {
    const raw = storage.getItem(INQUIRY_SESSION_KEY)
    if (!raw) return { ...memoryInquiry }
    const parsed = JSON.parse(raw) as Partial<InquirySession>
    return {
      asked: memoryInquiry.asked || parsed.asked === true,
      wavedOff: memoryInquiry.wavedOff || parsed.wavedOff === true,
    }
  } catch {
    return { ...memoryInquiry }
  }
}

function writeInquirySession(
  next: InquirySession,
  storage: InquiryStorage | null = null,
): InquirySession {
  memoryInquiry = next
  if (storage) {
    try {
      storage.setItem(INQUIRY_SESSION_KEY, JSON.stringify(next))
    } catch {
      // The memory copy above still carries the state for this session.
    }
  }
  return next
}

/** Record that the session's one inquiry turn has been shown. */
export function markInquiryAsked(
  storage: InquiryStorage | null = null,
): InquirySession {
  const current = readInquirySession(storage)
  if (current.asked) return current
  return writeInquirySession({ ...current, asked: true }, storage)
}

/** Record a wave-off: the inquiry closes for the session thread (battery E9). */
export function markInquiryWavedOff(
  storage: InquiryStorage | null = null,
): InquirySession {
  return writeInquirySession({ asked: true, wavedOff: true }, storage)
}

/** Test seam: reset the in-memory fallback. */
export function resetInquirySessionForTests(): void {
  memoryInquiry = { asked: false, wavedOff: false }
}

/**
 * A wave-off reply to the inquiry: a short refusal of the invitation
 * ("nope, just curious"), not a new request. Deliberately narrow — a
 * reply carrying any place, measure, or question content is a
 * first-class request and routes through the normal pipeline
 * (battery E7), never through this gate.
 */
const WAVE_OFF_RE =
  /^\s*(no+pe?|no thanks|no thank you|nah|not really|just curious|only curious|no,? just curious|nope,? just curious|i'?m good|all good|nothing|never ?mind)\W*$/i

export function isInquiryWaveOff(text: string): boolean {
  return WAVE_OFF_RE.test(text.trim())
}

/** The graceful close a wave-off renders; no second inquiry follows it. */
export const INQUIRY_WAVE_OFF_CLOSE =
  'Of course — curiosity needs no reason. The data is here whenever a place question comes up.'
