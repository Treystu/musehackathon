/**
 * TypeSafe System One transport for the Jev route (C3, 2026-11-02).
 *
 * Endpoint, auth, and shapes were confirmed from
 * https://docs.typesafe.ai/api/system-one.md at build time:
 * POST https://api.typesafe.ai/v1/systemone, Authorization: Bearer
 * <TYPESAFE_API_KEY>, body { model, state, questions } with questions
 * keyed by name; the reply keys its answers by the same names and
 * reports the model used plus token usage.
 *
 * This transport is an independent failure domain on purpose: it
 * shares no breaker, meter, or provider with the Muse routes, so a
 * TypeSafe outage degrades only the Jev consumers.
 */
import {
  buildSystemOneRequest,
  buildSystemOneRequestFromQuestions,
  mapSystemOneResponse,
  questionsForSet,
  type JevEvaluation,
  type JevQuestion,
  type JevSetId,
  type JevState,
} from '../core/ai/jev-judgments'

export const TYPESAFE_API_BASE = 'https://api.typesafe.ai/v1'

export class JevUnavailableError extends Error {
  constructor() {
    super('jev_unavailable')
    this.name = 'JevUnavailableError'
  }
}

export interface JevTransport {
  /**
   * Evaluate a judgment set. When the caller supplies its own
   * questions (the live client path — semantic question ids), they
   * are forwarded verbatim and the reply is mapped against them;
   * otherwise the set's fallback builders run on the label criteria.
   */
  evaluate(
    set: JevSetId,
    state: JevState,
    criteria?: readonly string[],
    questions?: readonly JevQuestion[],
  ): Promise<JevEvaluation>
}

export interface JevTransportOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Clock seam for hermetic latency assertions. */
  now?: () => number
}

export function createJevTransport(options: JevTransportOptions): JevTransport {
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args))
  const base = (options.baseUrl ?? TYPESAFE_API_BASE).replace(/\/$/, '')
  const now = options.now ?? (() => Date.now())
  return {
    async evaluate(set, state, criteria = [], suppliedQuestions) {
      const questions =
        suppliedQuestions && suppliedQuestions.length > 0
          ? suppliedQuestions
          : questionsForSet(set, criteria)
      const request =
        suppliedQuestions && suppliedQuestions.length > 0
          ? buildSystemOneRequestFromQuestions(state, questions)
          : buildSystemOneRequest(set, state, criteria)
      const started = now()
      let res: Response
      try {
        res = await doFetch(`${base}/systemone`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(request),
        })
      } catch {
        // The upstream's failure detail never crosses this boundary:
        // consumers degrade on the typed error alone.
        throw new JevUnavailableError()
      }
      if (!res.ok) throw new JevUnavailableError()
      const body: unknown = await res.json().catch(() => null)
      const mapped = mapSystemOneResponse(body, questions, Math.max(0, now() - started))
      if (!mapped) throw new JevUnavailableError()
      return mapped
    },
  }
}
