/**
 * POST /api/muse/plan — top bookend: Wonder plan validation (C2,
 * 2026-11-02). Runs after parse + screen, before research: the
 * caller sends the structured plan state, this route builds the
 * condensed P1 packet (budget 1,500 tokens, hard-trimmed by
 * src/core/ai/hourglass-packets) and asks the stage model for the
 * closed-schema verdict. Wonder advises; deterministic stages own
 * execution, so every failure shape here is a labelled degradation
 * in a 200 reply, never a block and never a fabricated verdict.
 * Settles at the flat per-stage constant (C11). Counts only (Q1).
 */
import { MUSE_WONDER_MODEL } from '../../../src/core/ai/meta-client'
import {
  buildPlanPacket,
  parsePlanVerdict,
  type PlanPacketInput,
} from '../../../src/core/ai/hourglass-packets'
import { recordTopBookend } from '../../../src/core/ai/bookend-counters'
import {
  preCallGate,
  accountCall,
  accountTopBookend,
  accountError,
  err,
  type ProxyDeps,
  type ProxyReply,
} from '../../../src/server/muse-proxy'
import { museRoute } from '../../../src/server/muse-adapter'

const ALLOWED_PATHS = new Set(['/api/muse/plan'])
/** Flat settle for this stage (plan annex C11, exact). */
export const PLAN_SETTLE_MICRO_USD = 2000
/** Hard client timeout for the top bookend call (plan C5 pattern). */
export const PLAN_TIMEOUT_MS = 20_000
const FLAT_TOKENS_IN = 384
const FLAT_TOKENS_OUT = 128

const SYSTEM_PROMPT =
  'You validate a data-tool query plan. You see only the condensed packet. ' +
  'Reply with one JSON object: {"verdict":"sound","objections":[]} when the plan ' +
  'faithfully serves the question, or {"verdict":"unsound","objections":[{"code":' +
  '"wrong_narrowing"|"missing_criterion"|"geography_mismatch"|"criteria_misread",' +
  '"detail":"..."}]} naming each problem. Return only the JSON object.'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseInput(body: Record<string, unknown>): PlanPacketInput | null {
  if (typeof body.question !== 'string' || body.question.length === 0 || body.question.length > 500) return null
  if (!isRecord(body.intent)) return null
  const intent = body.intent
  if (
    typeof intent.mode !== 'string' ||
    !Array.isArray(intent.geographies) ||
    intent.geographies.some((g) => typeof g !== 'string') ||
    !Array.isArray(intent.measures) ||
    intent.measures.some((m) => typeof m !== 'string')
  ) {
    return null
  }
  if (!Array.isArray(body.criteria) || body.criteria.length > 12) return null
  const criteria: PlanPacketInput['criteria'] = []
  for (const c of body.criteria) {
    if (!isRecord(c) || (c.kind !== 'census' && c.kind !== 'research') || typeof c.text !== 'string') return null
    criteria.push({ kind: c.kind, text: c.text })
  }
  if (!isRecord(body.subset) || typeof body.subset.count !== 'number') return null
  const ranges: PlanPacketInput['subset']['ranges'] = []
  if (body.subset.ranges !== undefined) {
    if (!Array.isArray(body.subset.ranges)) return null
    for (const r of body.subset.ranges) {
      if (!isRecord(r) || typeof r.label !== 'string' || typeof r.min !== 'string' || typeof r.max !== 'string') return null
      ranges.push({ label: r.label, min: r.min, max: r.max })
    }
  }
  let decisions: Record<string, string> | undefined
  if (body.decisions !== undefined) {
    if (!isRecord(body.decisions)) return null
    decisions = {}
    for (const [k, v] of Object.entries(body.decisions)) {
      if (typeof v !== 'string') return null
      decisions[k] = v
    }
  }
  return {
    question: body.question,
    intent: {
      mode: intent.mode,
      geographies: intent.geographies as string[],
      measures: intent.measures as string[],
    },
    criteria,
    subset: { count: body.subset.count, ranges },
    ...(decisions ? { decisions } : {}),
  }
}

/** Race a stage call against its hard timeout; a timeout aborts the call. */
export async function withStageTimeout<T>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('stage_timeout'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([call(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function handlePlan(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = await preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate
  const body = req.body as Record<string, unknown>
  const input = parseInput(body)
  if (!input) return err(400, 'shape_invalid', 'plan needs question, intent, criteria, and subset')
  const packet = buildPlanPacket(input)
  const model = typeof body.model === 'string' ? body.model : MUSE_WONDER_MODEL
  const started = Date.now()
  if (!deps.stageProvider) {
    recordTopBookend('degraded')
    accountTopBookend(deps, 'degraded')
    return {
      status: 200,
      body: { outcome: 'degraded', model, packetTokens: packet.tokens, trimmed: packet.trimmed },
    }
  }
  try {
    const result = await withStageTimeout(PLAN_TIMEOUT_MS, (signal) =>
      deps.stageProvider!.stageChat({ model, system: SYSTEM_PROMPT, user: packet.text }, signal),
    )
    // P7: bucket by the model the provider reports for the call (the
    // durable version of the packetTokens this reply already
    // carries), falling back to the requested stage model.
    accountCall(deps, req.clientId, PLAN_SETTLE_MICRO_USD, FLAT_TOKENS_IN, FLAT_TOKENS_OUT, {
      model: result.model ?? model,
      route: 'plan',
    })
    const verdict = parsePlanVerdict(result.text)
    const latencyMs = Date.now() - started
    if (verdict.kind === 'sound') {
      recordTopBookend('sound')
      accountTopBookend(deps, 'sound')
      return { status: 200, body: { outcome: 'sound', objections: [], model: result.model, latencyMs, packetTokens: packet.tokens, trimmed: packet.trimmed } }
    }
    if (verdict.kind === 'unsound') {
      recordTopBookend('unsound')
      accountTopBookend(deps, 'unsound')
      return { status: 200, body: { outcome: 'unsound', objections: verdict.objections, model: result.model, latencyMs, packetTokens: packet.tokens, trimmed: packet.trimmed } }
    }
    recordTopBookend('degraded')
    accountTopBookend(deps, 'degraded')
    accountError(deps, 'shape_invalid')
    return { status: 200, body: { outcome: 'degraded', model: result.model, latencyMs, packetTokens: packet.tokens, trimmed: packet.trimmed } }
  } catch {
    // Timeout, provider failure, or an unreachable Wonder id: the
    // bookend did not run, and the reply says exactly that.
    recordTopBookend('degraded')
    accountTopBookend(deps, 'degraded')
    accountError(deps, 'provider_down')
    return {
      status: 200,
      body: { outcome: 'degraded', model, latencyMs: Date.now() - started, packetTokens: packet.tokens, trimmed: packet.trimmed },
    }
  }
}

/** Pages Function entry point. The handler above stays framework-free. */
export const onRequestPost = museRoute(handlePlan)
