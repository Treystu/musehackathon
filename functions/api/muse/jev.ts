/**
 * POST /api/muse/jev — Jev evaluation service (C3, 2026-11-02).
 *
 * Jev calls run server-side so the TypeSafe key never reaches the
 * browser. The body names a judgment set (src/core/ai/jev-judgments)
 * plus the state object to judge; the reply carries the typed
 * answers mapped back by question id, the model, and the latency.
 *
 * Independent failure domain: this handler takes no ProxyDeps, reads
 * no Muse breaker or meter, and records no Muse settle (C11: Jev
 * spend is TypeSafe-side, and the accounting stays truthful by not
 * conflating them). An absent TYPESAFE_API_KEY answers a typed
 * unavailable (503 jev_unavailable) so consumers degrade; it is
 * never a 500 and never carries an upstream body.
 */
import {
  JEV_SET_IDS,
  type JevQuestion,
  type JevSetId,
  type JevState,
} from '../../../src/core/ai/jev-judgments'
import { createJevTransport, JevUnavailableError, type JevTransport } from '../../../src/server/jev-client'
import type { MuseEnv, PagesContext } from '../../../src/server/muse-adapter'

const MAX_CRITERIA = 12
const MAX_CRITERION_CHARS = 300
const MAX_STATE_CHARS = 20_000
const MAX_QUESTIONS = 16
const MAX_QUESTION_ID_CHARS = 64
const MAX_INSTRUCTIONS_CHARS = 1_000

export interface JevDeps {
  /** Null when the deployment carries no TypeSafe key. */
  transport: JevTransport | null
}

export type JevReply = { status: number; body: Record<string, unknown> }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export async function handleJev(
  req: { method: string; path: string; body: unknown },
  deps: JevDeps,
): Promise<JevReply> {
  if (req.method !== 'POST' || req.path !== '/api/muse/jev') {
    return { status: 400, body: { error: 'not_allowlisted' } }
  }
  if (!isRecord(req.body)) return { status: 400, body: { error: 'shape_invalid' } }
  const set = req.body.set
  if (typeof set !== 'string' || !(JEV_SET_IDS as readonly string[]).includes(set)) {
    return { status: 400, body: { error: 'shape_invalid', detail: 'unknown judgment set' } }
  }
  const state = req.body.state
  if (typeof state !== 'string' && !isRecord(state)) {
    return { status: 400, body: { error: 'shape_invalid', detail: 'state must be an object or string' } }
  }
  if (JSON.stringify(state).length > MAX_STATE_CHARS) {
    return { status: 400, body: { error: 'shape_invalid', detail: 'state exceeds ceiling' } }
  }
  let criteria: string[] = []
  if (req.body.criteria !== undefined) {
    if (
      !Array.isArray(req.body.criteria) ||
      req.body.criteria.length > MAX_CRITERIA ||
      req.body.criteria.some((c) => typeof c !== 'string' || c.length > MAX_CRITERION_CHARS)
    ) {
      return { status: 400, body: { error: 'shape_invalid', detail: 'criteria must be short strings' } }
    }
    criteria = req.body.criteria as string[]
  }
  // Caller-supplied questions (the live path): the client authors the
  // questions with semantic ids so failing Nouls name their criteria.
  // They are validated and forwarded verbatim; absent them, the
  // transport's fallback builders run on the label criteria above.
  let questions: JevQuestion[] | undefined
  if (req.body.questions !== undefined) {
    const raw = req.body.questions
    const valid =
      Array.isArray(raw) &&
      raw.length >= 1 &&
      raw.length <= MAX_QUESTIONS &&
      raw.every(
        (q) =>
          isRecord(q) &&
          typeof q.id === 'string' &&
          q.id.length >= 1 &&
          q.id.length <= MAX_QUESTION_ID_CHARS &&
          (q.type === 'noul' || q.type === 'score' || q.type === 'choice') &&
          typeof q.instructions === 'string' &&
          q.instructions.length >= 1 &&
          q.instructions.length <= MAX_INSTRUCTIONS_CHARS &&
          (q.criteria === undefined ||
            (Array.isArray(q.criteria) &&
              q.criteria.length <= 8 &&
              q.criteria.every((c) => typeof c === 'string' && c.length <= MAX_CRITERION_CHARS)) ||
            (isRecord(q.criteria) &&
              Object.keys(q.criteria).length <= 8 &&
              Object.values(q.criteria).every(
                (v) => typeof v === 'string' && v.length <= MAX_CRITERION_CHARS,
              ))),
      )
    if (!valid) {
      return { status: 400, body: { error: 'shape_invalid', detail: 'questions malformed' } }
    }
    questions = raw as JevQuestion[]
  }
  if (!deps.transport) return { status: 503, body: { error: 'jev_unavailable' } }
  try {
    const evaluation = await deps.transport.evaluate(set as JevSetId, state as JevState, criteria, questions)
    return {
      status: 200,
      body: {
        set,
        answers: evaluation.answers,
        model: evaluation.model,
        latencyMs: evaluation.latencyMs,
      },
    }
  } catch (e) {
    if (e instanceof JevUnavailableError) return { status: 502, body: { error: 'jev_unavailable' } }
    return { status: 502, body: { error: 'jev_unavailable' } }
  }
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function readBody(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) return null
  return request.json().catch(() => null)
}

/**
 * Pages entry point. Unlike museRoute it does not require the Muse
 * key: the Jev route's only secret is its own, and a deployment
 * without one still answers the typed unavailable.
 */
export async function onRequestPost(context: PagesContext<MuseEnv>): Promise<Response> {
  const url = new URL(context.request.url)
  const origin = context.request.headers.get('origin')
  if (origin && origin !== url.origin) return json({ error: 'not_allowlisted' }, 403)
  const key = context.env.TYPESAFE_API_KEY
  const reply = await handleJev(
    { method: context.request.method, path: url.pathname, body: await readBody(context.request) },
    { transport: key ? createJevTransport({ apiKey: key }) : null },
  )
  return json(reply.body, reply.status)
}
